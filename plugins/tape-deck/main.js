// The recorder half of the tape deck. The renderer works out WHAT airs in a
// time range (that is core's schedule engine's job, and it is a pure
// function of channel and timestamp, so a whole range is knowable in
// advance); this file only turns the resulting flat list of
// {path, inSeconds, outSeconds} cuts into one playable file.
//
// Why cut-and-concat rather than capturing the screen: channel media is
// served from app://media while the page is app://bundle, so canvas capture
// taints and captureStream() is unavailable, and screen capture would just
// duplicate what the OS already does. Reading the real source files is both
// the only route left and by far the best one — because the segment list is
// computable up front, a two-hour range tapes in a few minutes instead of
// two hours.
//
// Two passes, and the reason for each:
//   1. Every segment is re-encoded to its own MPEG-TS piece at IDENTICAL
//      dimensions, frame rate, pixel format, sample rate and channel count.
//      Re-encoding is what makes a cut land on the exact millisecond the
//      schedule says — a stream copy snaps to the nearest keyframe, which
//      drifts segment boundaries by up to a GOP and glitches the joins.
//      Uniform parameters are what make step 2 legal at all.
//   2. The pieces are concatenated with the concat demuxer and -c copy.
//      No second generation of quality loss, and it takes seconds.
//
// MPEG-TS is the intermediate container because it concatenates cleanly by
// design (self-contained packets, no global header to reconcile); MP4 does
// not.
const path = require('path');
const nodeFs = require('fs');

// Per-segment ceiling, not a whole-job one: a long tape is legitimately
// slow, but a single cut that has run this long is stuck on an unreadable
// file rather than working.
const SEGMENT_TIMEOUT_MS = 30 * 60 * 1000;
const CONCAT_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;
const OUTPUT_TAIL_LIMIT = 512 * 1024;
const PROBE_CACHE_MAX = 256;
// A queue this deep is already a runaway (a stuck scheduled recording
// re-firing, say) rather than a user who genuinely lined up nine tapes.
const QUEUE_MAX = 8;
const MAX_SEGMENTS_PER_TAPE = 4000;
const MIN_SEGMENT_SECONDS = 0.2;
const PROGRESS_THROTTLE_MS = 700;

// Quality tiers for an UNLIMITED recording, which is the only mode that
// leaves the choice to the user — every named format below fixes its own.
const SIZES = {
  480: { w: 854, h: 480, crf: 21 },
  720: { w: 1280, h: 720, crf: 21 },
  1080: { w: 1920, h: 1080, crf: 20 },
};

// The real formats, and what each actually did to a picture. A VCR traded
// resolution and bitrate for running time as you moved down its speeds, and
// that is exactly what these do — an LP recording is genuinely softer than an
// SP one, not just labelled differently. The renderer owns the matching
// running-time limits (it has to refuse an over-long range before any
// encoding starts); this table owns the encode side.
const RECORD_MODES = {
  'vhs-sp': { w: 640, h: 480, crf: 23, media: 'vhs' },
  'vhs-lp': { w: 480, h: 360, crf: 27, media: 'vhs' },
  'vhs-ep': { w: 352, h: 240, crf: 31, media: 'vhs' },
  'dvd-sd': { w: 720, h: 480, crf: 21, media: 'disc' },
  bluray: { w: 1920, h: 1080, crf: 20, media: 'disc' },
};

// Generation loss, baked in at encode time. Recording over a cassette really
// did cost picture every pass — the tape had already been magnetised, the
// shell had already been through the transport — so a tape's wear belongs in
// the file, not in a CSS filter over the top of a pristine one. Each pass
// blurs a little (a negative unsharp amount IS a blur), adds grain, and
// bleeds colour and contrast, and it compounds because each new recording is
// made from the previous generation's own output.
//
// A disc is the opposite case and gets nothing: burning a disc again writes
// clean data, so a re-recorded disc looks exactly like a fresh one. That
// asymmetry is the point, not an oversight.
const DEGRADE_STRENGTH = { off: 0, subtle: 0.5, true: 1 };
const MAX_DEGRADE_GENERATIONS = 12;

function degradeFilters(profile, generation, degradeMode) {
  const strength = DEGRADE_STRENGTH[degradeMode] != null ? DEGRADE_STRENGTH[degradeMode] : 1;
  if (profile.media === 'disc' || !strength || !(generation > 0)) return [];
  const wear = Math.min(generation, MAX_DEGRADE_GENERATIONS) * strength;
  const round = (n) => Number(n.toFixed(3));
  return [
    `unsharp=5:5:${round(-0.22 * wear)}:5:5:0`,
    `noise=alls=${Math.min(28, Math.round(3 * wear))}:allf=t+u`,
    `eq=saturation=${round(Math.max(0.45, 1 - 0.055 * wear))}`
      + `:contrast=${round(Math.max(0.7, 1 - 0.025 * wear))}`
      + `:brightness=${round(Math.min(0.09, 0.008 * wear))}`,
  ];
}

// One place decides the geometry so the sidecar and the encoder can never
// disagree about what a tape actually is.
function modeProfile(plan) {
  const named = RECORD_MODES[plan.mode];
  if (named) return { ...named, mode: plan.mode };
  return {
    ...(SIZES[plan.quality] || SIZES[720]),
    media: plan.media === 'disc' ? 'disc' : 'vhs',
    mode: 'unlimited',
  };
}

// A tape id is used verbatim as a filename and as a work-directory name, so
// it has to survive that. Built here rather than trusted from the renderer.
function makeTapeId(plan) {
  const stamp = new Date(plan.startMs || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const channel = String(plan.channelNumber == null ? 'x' : plan.channelNumber).replace(/[^0-9a-z]/gi, '');
  const slug = String(plan.title || 'tape').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'tape';
  return `${stamp}-ch${channel}-${slug}`;
}

// Runs ffmpeg to completion. `onProgress` receives seconds-of-output-written
// as ffmpeg reports them through -progress, which is what drives the
// on-screen percentage. Resolves rather than rejects on failure so a caller
// can decide whether one bad segment should sink the whole tape.
function runFfmpeg(ffmpegPath, args, spawnFn, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, output: e.message });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already gone */ }
      finish(false);
    }, opts.timeoutMs || SEGMENT_TIMEOUT_MS);

    // ffmpeg's own diagnostics go to stderr even on a clean run; keeping a
    // bounded tail of them is what makes a failure reportable instead of
    // just "it did not work".
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > OUTPUT_TAIL_LIMIT) output = output.slice(-OUTPUT_TAIL_LIMIT);
      });
    }
    // -progress writes key=value lines to stdout; out_time_us is how far
    // into the OUTPUT it has written, which is the only honest progress
    // number for a re-encode.
    if (child.stdout && opts.onProgress) {
      child.stdout.on('data', (chunk) => {
        const matches = chunk.toString().match(/out_time_us=(\d+)/g);
        if (!matches || !matches.length) return;
        const last = Number(matches[matches.length - 1].split('=')[1]);
        if (Number.isFinite(last)) opts.onProgress(last / 1e6);
      });
    }
    child.on('error', (e) => { output += `\n${e.message}`; finish(false); });
    child.on('close', (code) => finish(code === 0));
    if (opts.registerChild) opts.registerChild(child);
  });
}

// No ffprobe binary ships with this app (only ffmpeg), so stream discovery
// reads ffmpeg's own banner — the same well-worn technique the closed-captions
// plugin uses for subtitle streams. Asked to open a file with no output,
// ffmpeg prints one "Stream #0:N: Audio: ..." line per audio stream and then
// exits non-zero, which is expected here and not a failure.
const audioProbeCache = new Map();
async function hasAudioStream(ffmpegPath, filePath, spawnFn) {
  if (audioProbeCache.has(filePath)) return audioProbeCache.get(filePath);
  const result = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-i', filePath], spawnFn, { timeoutMs: PROBE_TIMEOUT_MS });
  const found = /Stream #\d+:\d+[^:]*:\s*Audio:/i.test(result.output);
  if (audioProbeCache.size >= PROBE_CACHE_MAX) audioProbeCache.delete(audioProbeCache.keys().next().value);
  audioProbeCache.set(filePath, found);
  return found;
}

// Every segment lands at exactly this geometry and timebase. Letterboxing
// rather than cropping, because a 4:3 show inside a 16:9 tape is what a real
// recording of that broadcast looked like anyway.
function videoFilter(size, fps, extraFilters = []) {
  // Wear is applied after the scale/pad so its grain is at the tape's own
  // resolution rather than the source's, which is where it actually lived.
  return [
    `scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease`,
    `pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${fps}`,
    ...extraFilters,
    'format=yuv420p',
  ].join(',');
}

function encodeArgs(size, fps) {
  return [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(size.crf),
    // A keyframe every second bounds how far a chapter jump on the finished
    // tape can land from where it was asked to.
    '-g', String(fps), '-keyint_min', String(fps), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', String(fps * 1000),
  ];
}

function cutArgs(segment, outPath, size, fps, hasAudio, wearFilters = []) {
  const duration = segment.outSeconds - segment.inSeconds;
  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
  // -ss ahead of -i seeks by index first and only then decodes forward to
  // the exact frame, so it is both fast and (because the output is
  // re-encoded) frame-accurate. Behind -i it would decode the whole file up
  // to the in-point.
  args.push('-ss', segment.inSeconds.toFixed(3), '-i', segment.path);
  if (!hasAudio) {
    // Silent stereo stands in for a file with no audio track. Without it the
    // piece would have no audio stream at all and the concat would fail on
    // a stream-count mismatch with its neighbours.
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  args.push('-t', duration.toFixed(3));
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  args.push('-vf', videoFilter(size, fps, wearFilters));
  // Absorbs a source whose audio and video start at different timestamps,
  // which would otherwise show up as growing lip-sync drift down the tape.
  args.push('-af', 'aresample=async=1:first_pts=0');
  args.push(...encodeArgs(size, fps));
  args.push('-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', outPath);
  return args;
}

// Black and silent, generated rather than cut from anything — for the breaks
// core renders as an on-screen card with nothing playing underneath (a
// trivia card, a local-avail slide, the default sign-off pattern). The tape
// has to hold that time or everything after it would sit at the wrong place
// on the tape.
function slateArgs(durationSeconds, outPath, size, fps) {
  return [
    '-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    '-f', 'lavfi', '-i', `color=c=black:s=${size.w}x${size.h}:r=${fps}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', durationSeconds.toFixed(3),
    '-map', '0:v:0', '-map', '1:a:0',
    ...encodeArgs(size, fps),
    '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', outPath,
  ];
}

// The concat demuxer's list format takes a single-quoted path, and escapes
// an embedded quote by closing, escaping, and reopening.
function concatListLine(absPath) {
  const escaped = absPath.split("'").join("'\\''");
  return `file '${escaped}'`;
}

function activate(ctx) {
  const { ipcMain, fs, spawn } = ctx;

  const queue = [];
  let active = null;        // the job currently being cut, or null
  let activeChild = null;   // the ffmpeg process inside it, so cancel can kill it
  const cancelledIds = new Set();
  let lastProgressSentAt = 0;

  const abs = (rel) => path.join(fs.dataDir, rel);

  // Resolved fresh each time rather than cached at activate(): the
  // ffmpeg-transcode plugin publishes its path during ITS activation, and a
  // user can repoint it later from its own settings panel.
  function ffmpegBinary() {
    const resolved = ctx.services.ffmpegPath;
    return resolved && fs.existsSync(resolved) ? resolved : null;
  }

  function snapshot() {
    return {
      // Answered here rather than guessed in the renderer — only this
      // process can see whether the binary actually resolved. The settings
      // panel and the test driver both ask this instead of inferring it
      // from a failed recording.
      ffmpegReady: !!ffmpegBinary(),
      active: active && {
        id: active.id,
        title: active.plan.title,
        channelNumber: active.plan.channelNumber,
        channelName: active.plan.channelName,
        stage: active.stage,
        generation: active.generation,
        progress: active.progress,
        segmentIndex: active.segmentIndex,
        segmentCount: active.plan.segments.length,
        startMs: active.plan.startMs,
        endMs: active.plan.endMs,
      },
      queued: queue.map((job) => ({
        id: job.id, title: job.plan.title, channelNumber: job.plan.channelNumber,
      })),
    };
  }

  function pushProgress(force) {
    const now = Date.now(); // real-time throttle on an IPC push, not a schedule read
    if (!force && now - lastProgressSentAt < PROGRESS_THROTTLE_MS) return;
    lastProgressSentAt = now;
    ctx.sendToMainWindow('tapes:progress', snapshot());
  }

  function rmWorkDir(id) {
    try {
      const dir = abs(path.join('work', id));
      if (!fs.existsSync(dir)) return;
      // Flat by construction — the only things in a work dir are the .ts
      // pieces and the concat list this file wrote.
      for (const name of fs.readdirSync(dir)) {
        try { nodeFs.unlinkSync(path.join(dir, name)); } catch (e) { /* best effort */ }
      }
      nodeFs.rmdirSync(dir);
    } catch (e) { /* best effort — a leftover work dir costs disk, not correctness */ }
  }

  // Merges the flat segment list into something a viewer would recognise as
  // chapters: a run of consecutive pieces from the same source file is one
  // chapter, and a whole commercial pod collapses into a single stop rather
  // than one chapter per spot.
  function buildChapters(segments) {
    const chapters = [];
    let cursor = 0;
    for (const segment of segments) {
      const duration = segment.outSeconds - segment.inSeconds;
      const last = chapters[chapters.length - 1];
      const isBreakish = segment.kind !== 'content';
      const continues = last
        && (isBreakish ? last.kind !== 'content' : (last.kind === 'content' && last.label === segment.label));
      if (continues) {
        last.endS = cursor + duration;
      } else {
        chapters.push({
          kind: isBreakish ? 'break' : 'content',
          label: isBreakish ? (segment.label || 'COMMERCIAL BREAK') : segment.label,
          startS: cursor,
          endS: cursor + duration,
        });
      }
      cursor += duration;
    }
    return chapters;
  }

  async function runJob(job) {
    const { plan } = job;
    const profile = modeProfile(plan);
    const size = profile;
    const wearFilters = degradeFilters(profile, job.generation, plan.degrade);
    const fps = Number.isFinite(plan.fps) && plan.fps >= 15 && plan.fps <= 60 ? Math.round(plan.fps) : 30;
    const ffmpegPath = ffmpegBinary();
    if (!ffmpegPath) {
      return { error: 'ffmpeg is unavailable — enable the FFmpeg Transcode plugin, or point it at an ffmpeg binary in its settings.' };
    }

    const workRel = path.join('work', job.id);
    fs.mkdirSync(workRel, { recursive: true });
    const workAbs = abs(workRel);

    const usable = plan.segments.filter((s) => (s.outSeconds - s.inSeconds) >= MIN_SEGMENT_SECONDS);
    const totalSeconds = usable.reduce((sum, s) => sum + (s.outSeconds - s.inSeconds), 0);
    let doneSeconds = 0;
    const pieces = [];

    for (let i = 0; i < usable.length; i++) {
      if (cancelledIds.has(job.id)) return { cancelled: true };
      const segment = usable[i];
      const duration = segment.outSeconds - segment.inSeconds;

      active.segmentIndex = i;
      active.stage = segment.kind === 'slate' ? 'slate' : 'cutting';
      pushProgress(true);

      const piecePath = path.join(workAbs, `seg-${String(i).padStart(5, '0')}.ts`);
      const onProgress = (outSeconds) => {
        active.progress = Math.min(0.98, (doneSeconds + Math.min(outSeconds, duration)) / Math.max(1, totalSeconds));
        pushProgress(false);
      };

      let result;
      if (segment.kind === 'slate') {
        result = await runFfmpeg(ffmpegPath, slateArgs(duration, piecePath, size, fps), spawn, {
          onProgress, registerChild: (c) => { activeChild = c; },
        });
      } else {
        const withAudio = await hasAudioStream(ffmpegPath, segment.path, spawn);
        result = await runFfmpeg(ffmpegPath, cutArgs(segment, piecePath, size, fps, withAudio, wearFilters), spawn, {
          onProgress, registerChild: (c) => { activeChild = c; },
        });
      }
      activeChild = null;
      if (cancelledIds.has(job.id)) return { cancelled: true };

      // One unreadable source file should cost that segment, not the tape —
      // the rest of the broadcast is still worth having. A slate of the same
      // length keeps everything after it at the right place on the tape.
      if (!result.ok || !fs.existsSync(piecePath)) {
        const fallback = await runFfmpeg(ffmpegPath, slateArgs(duration, piecePath, size, fps), spawn, {
          registerChild: (c) => { activeChild = c; },
        });
        activeChild = null;
        if (!fallback.ok || !fs.existsSync(piecePath)) {
          rmWorkDir(job.id);
          const tail = String(result.output || '').split('\n').slice(-3).join(' ').trim().slice(0, 300);
          return { error: `ffmpeg could not record "${segment.label || 'a segment'}": ${tail}` };
        }
      }
      pieces.push(piecePath);
      doneSeconds += duration;
    }

    if (!pieces.length) {
      rmWorkDir(job.id);
      return { error: 'Nothing was scheduled on that channel for that time range — there is nothing to record.' };
    }

    active.stage = 'assembling';
    active.progress = 0.99;
    pushProgress(true);

    const listRel = path.join(workRel, 'concat.txt');
    fs.writeFileSync(listRel, `${pieces.map(concatListLine).join('\n')}\n`, 'utf8');

    const tapeAbs = abs(`${job.id}.mp4`);
    // Every piece already shares one encode, so this pass only re-wraps —
    // seconds of work, and no second generation of quality loss.
    const concat = await runFfmpeg(ffmpegPath, [
      '-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', abs(listRel),
      '-c', 'copy', '-movflags', '+faststart', tapeAbs,
    ], spawn, { timeoutMs: CONCAT_TIMEOUT_MS, registerChild: (c) => { activeChild = c; } });
    activeChild = null;

    if (cancelledIds.has(job.id)) { rmWorkDir(job.id); return { cancelled: true }; }
    if (!concat.ok || !fs.existsSync(tapeAbs)) {
      rmWorkDir(job.id);
      const tail = String(concat.output || '').split('\n').slice(-3).join(' ').trim().slice(0, 300);
      return { error: `ffmpeg could not assemble the tape: ${tail}` };
    }

    const sidecar = {
      // Recording over a cassette keeps the physical object: its case art,
      // its shell colour, and the wear it has accumulated. Only what is on
      // it changes.
      ...(job.carriedOver || {}),
      id: job.id,
      title: plan.title,
      channelNumber: plan.channelNumber,
      channelName: plan.channelName,
      startMs: plan.startMs,
      endMs: plan.endMs,
      recordedMs: Date.now(), // when the file was written — a real-clock fact about the file, not a schedule read
      durationS: Math.round(totalSeconds),
      quality: String(plan.quality || 720),
      // Recorded onto the tape itself, not read from settings at playback
      // time: a shelf can hold cassettes and discs side by side, and each
      // one has to load in its own deck however the settings have since
      // changed.
      mode: profile.mode,
      media: profile.media,
      // How many times this physical tape has been recorded on. Zero is
      // factory-fresh; every re-record adds one and the picture pays for it.
      generation: job.generation,
      chapters: buildChapters(usable),
    };
    fs.writeFileSync(`${job.id}.json`, JSON.stringify(sidecar, null, 2), 'utf8');
    rmWorkDir(job.id);
    return { tape: { ...sidecar, path: tapeAbs } };
  }

  async function pump() {
    if (active || !queue.length) return;
    const job = queue.shift();
    active = {
      id: job.id, plan: job.plan, generation: job.generation, progress: 0, stage: 'starting', segmentIndex: 0,
    };
    pushProgress(true);
    let outcome;
    try {
      outcome = await runJob(job);
    } catch (e) {
      outcome = { error: e.message };
    }
    cancelledIds.delete(job.id);
    active = null;
    ctx.sendToMainWindow('tapes:done', { id: job.id, ...outcome });
    pushProgress(true);
    pump();
  }

  ipcMain.handle('tapes:record', async (event, plan) => {
    if (!plan || !Array.isArray(plan.segments) || !plan.segments.length) {
      return { error: 'That range has nothing scheduled on it.' };
    }
    if (plan.segments.length > MAX_SEGMENTS_PER_TAPE) {
      return { error: `That range breaks down into ${plan.segments.length} pieces, past this recorder's limit of ${MAX_SEGMENTS_PER_TAPE}. Record a shorter range.` };
    }
    if (queue.length >= QUEUE_MAX) {
      return { error: `${QUEUE_MAX} recordings are already waiting. Let some finish first.` };
    }
    if (!ffmpegBinary()) {
      return { error: 'ffmpeg is unavailable — enable the FFmpeg Transcode plugin, or point it at an ffmpeg binary in its settings.' };
    }
    // Recording over an existing tape reuses its id, which is also its
    // filename — the same physical object, with something new on it.
    let id = makeTapeId(plan);
    let generation = 0;
    let carriedOver = null;
    if (plan.overwriteId) {
      const sidecarAbs = abs(`${plan.overwriteId}.json`);
      if (!fs.existsSync(sidecarAbs)) return { error: 'That tape is no longer on the shelf.' };
      try {
        const previous = JSON.parse(fs.readFileSync(sidecarAbs, 'utf8'));
        id = plan.overwriteId;
        generation = (Number.isInteger(previous.generation) ? previous.generation : 0) + 1;
        carriedOver = {};
        if (previous.art) carriedOver.art = previous.art;
        if (previous.shellColor) carriedOver.shellColor = previous.shellColor;
      } catch (e) {
        return { error: 'That tape cannot be recorded over — its sidecar could not be read.' };
      }
    }
    if (queue.some((job) => job.id === id) || (active && active.id === id)) {
      return { error: 'That tape is already being recorded onto.' };
    }
    queue.push({ id, plan, generation, carriedOver });
    pump();
    return { id, generation, queued: queue.length };
  });

  ipcMain.handle('tapes:status', async () => snapshot());

  ipcMain.handle('tapes:cancel', async (event, id) => {
    const queuedAt = queue.findIndex((job) => job.id === id);
    if (queuedAt >= 0) { queue.splice(queuedAt, 1); return { cancelled: true }; }
    if (!active || active.id !== id) return { cancelled: false };
    cancelledIds.add(id);
    // Killing the child is what actually stops the work; runJob's own
    // cancelled check then unwinds and cleans the work directory.
    if (activeChild) { try { activeChild.kill(); } catch (e) { /* already exited */ } }
    return { cancelled: true };
  });

  ipcMain.handle('tapes:list', async () => {
    let names;
    try { names = fs.readdirSync(fs.dataDir); } catch (e) { return { tapes: [], folder: fs.dataDir }; }
    const tapes = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const videoAbs = abs(`${id}.mp4`);
      if (!fs.existsSync(videoAbs)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(abs(name), 'utf8'));
        tapes.push({ ...meta, id, path: videoAbs });
      } catch (e) { /* a sidecar we cannot read means a tape we cannot label — skip it rather than fail the whole shelf */ }
    }
    // Newest first: a shelf reads best with the tape you just made on the left.
    tapes.sort((a, b) => (b.recordedMs || 0) - (a.recordedMs || 0));
    return { tapes, folder: fs.dataDir };
  });

  // Cover art and shell colour live in the tape's own sidecar rather than in
  // plugin settings, so a tape keeps its artwork when settings are reset,
  // and loses it only when the tape itself is erased. Values are absolute
  // local image paths the renderer resolved through a file picker; null on a
  // key clears it.
  ipcMain.handle('tapes:setArt', async (event, opts) => {
    const { id, art } = opts || {};
    if (typeof id !== 'string' || !id || /[/\\]/.test(id) || id.includes('..')) {
      return { error: 'bad tape id' };
    }
    const sidecarAbs = abs(`${id}.json`);
    if (!fs.existsSync(sidecarAbs)) return { error: 'no such tape' };
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(sidecarAbs, 'utf8'));
    } catch (e) {
      return { error: 'that tape\'s sidecar could not be read' };
    }
    const next = { ...(meta.art || {}) };
    ['front', 'back', 'label'].forEach((slot) => {
      if (!art || !Object.prototype.hasOwnProperty.call(art, slot)) return;
      const value = art[slot];
      // Only a real file on this disk: a path that no longer resolves would
      // render as a broken image with no way to tell why.
      if (typeof value === 'string' && value && fs.existsSync(value)) next[slot] = value;
      else delete next[slot];
    });
    meta.art = next;
    if (art && Object.prototype.hasOwnProperty.call(art, 'shellColor')) {
      const colour = art.shellColor;
      if (typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour)) meta.shellColor = colour;
      else delete meta.shellColor;
    }
    fs.writeFileSync(`${id}.json`, JSON.stringify(meta, null, 2), 'utf8');
    return { art: meta.art, shellColor: meta.shellColor || null };
  });

  ipcMain.handle('tapes:delete', async (event, id) => {
    if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id.includes('..')) {
      return { error: 'bad tape id' };
    }
    if (!fs.existsSync(abs(`${id}.json`))) return { error: 'no such tape' };
    await new Promise((resolve) => fs.unlink(`${id}.mp4`, resolve));
    await new Promise((resolve) => fs.unlink(`${id}.json`, resolve));
    return { deleted: true };
  });
}

module.exports = { activate };
