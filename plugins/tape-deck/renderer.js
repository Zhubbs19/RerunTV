// Tape Deck — the renderer half. Three separate jobs live here:
//
//   1. The PLANNER (planSegments below). Works out exactly what a channel
//      broadcasts across a time range — the shows plus the bumpers and
//      commercials between them — as a flat list of cuts. Core's schedule
//      engine is the only source of truth for that; this walks it, it does
//      not reimplement it. Because resolution is a pure function of
//      (channel, timestamp), the whole range is knowable before a single
//      frame has played, which is why a tape finishes faster than the
//      broadcast it records.
//   2. The RECORDER trigger — the R hotkey on live TV, and a timer for
//      scheduled recordings — plus the on-screen REC readout.
//   3. The DECK — CH 101, where finished tapes are a shelf you load into a
//      VCR or a DVD player and watch.
//
// Everything that reads "now" for a schedule decision goes through
// ctx.viewNow(), so pressing record while the time machine is scrubbed back
// tapes the moment you are actually looking at. The handful of Date.now()
// calls are all real-clock concerns and each says why.
const CHANNEL_NUMBER = 101;
const PLUGIN_ID = 'tape-deck';

// A break that resolves to no playable file is a card core draws over a
// paused picture (trivia, a local-avail slide, the default sign-off
// pattern). The tape holds that time as black so everything after it stays
// at the right place. The one exception is a text-only station-ID bar,
// which core deliberately overlays WITHOUT pausing the show — see
// startBreak's isTextOnlyChannelId. That one is not a segment at all.
function isTextOnlyStationId(brk) {
  return brk.type === 'channelId' && !(brk.entry && brk.entry.file);
}

// Which file a break segment plays, if any. A dynamic bumper loops a
// background clip under generated text; the tape keeps the clip. The text
// itself is drawn by core at playback time and does not survive to a file.
function breakFile(entry) {
  if (!entry) return null;
  if (entry.dynamic) return entry.bgFile || null;
  return entry.file || null;
}

function breakLabel(brk) {
  const named = {
    commercial: 'COMMERCIAL BREAK',
    adBreakIn: 'COMMERCIAL BREAK',
    adBreakOut: 'COMMERCIAL BREAK',
    promo: 'PROMO',
    sweepsPromo: 'PROMO',
    upNext: 'UP NEXT',
    trivia: 'TRIVIA',
    channelId: 'STATION ID',
    localAvail: 'LOCAL AVAIL',
    signOff: 'SIGN-OFF',
    signOn: 'SIGN-ON',
    premiereJingle: 'PREMIERE',
    preemption: 'SPECIAL REPORT',
  };
  return named[brk.type] || 'BREAK';
}

// The walk. At every instant the box is either in a break or showing
// content, and core answers both questions analytically, so this steps
// boundary to boundary rather than sampling.
//
// One deliberate fidelity note: core credits back time lost to a break
// during a LIVE session (S.contentLostMs) so a show resumes where it was
// paused. That credit is session-local and is not part of the schedule —
// the guide and the time machine both show the uncredited schedule, and so
// does a tape. A tape therefore matches what the guide said was on, which
// is the contract the rest of the app keeps.
function planSegments(ctx, channel, startMs, endMs) {
  const segments = [];
  const { resolveBreakAt, nextBreakBoundary, getChannelSchedule } = ctx.channels;
  let t = startMs;
  let safety = 0;
  // Bounded so a misconfigured channel (a zero-length source, a break that
  // never ends) cannot spin here forever.
  const WALK_CAP = 20000;

  while (t < endMs && safety < WALK_CAP) {
    safety++;
    const brk = resolveBreakAt(channel, t);

    if (brk && !isTextOnlyStationId(brk)) {
      const windowEnd = Math.min(brk.windowEnd, endMs);
      if (!(windowEnd > t)) { t += 1; continue; }
      const file = breakFile(brk.entry);
      const label = breakLabel(brk);
      const elapsedIn = (t - brk.windowStart) / 1000;
      const windowSeconds = (windowEnd - t) / 1000;
      if (file && file.path) {
        // A break window includes the entry's own WAIT AFTER padding, so it
        // can outlast the clip. Cut what the clip actually has and hold the
        // remainder black, rather than asking ffmpeg for frames past the
        // end of the file.
        const available = Math.max(0, (file.duration || windowSeconds) - elapsedIn);
        const cut = Math.min(windowSeconds, available);
        if (cut > 0) {
          segments.push({
            kind: 'break', path: file.path, source: file.source || 'local',
            inSeconds: elapsedIn, outSeconds: elapsedIn + cut, label,
          });
        }
        const held = windowSeconds - cut;
        if (held > 0) segments.push({ kind: 'slate', inSeconds: 0, outSeconds: held, label });
      } else {
        segments.push({ kind: 'slate', inSeconds: 0, outSeconds: windowSeconds, label });
      }
      t = windowEnd;
      continue;
    }

    // Not in a break (or in one that does not interrupt the picture) —
    // record content up to whenever the break state next changes.
    const boundary = Math.min(nextBreakBoundary(channel, t), endMs);
    const contentEnd = isFinite(boundary) && boundary > t ? boundary : endMs;
    const rows = getChannelSchedule(channel, t, contentEnd);
    if (!rows.length) {
      // Nothing scheduled here at all (an empty channel, or outside its
      // broadcast hours with no sign-off bumper configured). Black holds
      // the time so the tape's clock still matches the guide.
      segments.push({ kind: 'slate', inSeconds: 0, outSeconds: (contentEnd - t) / 1000, label: 'OFF AIR' });
      t = contentEnd;
      continue;
    }
    rows.forEach((row) => {
      if (!row.file || !row.file.path) return;
      // A schedule row can begin before the window does — the first file is
      // usually already part-played when the range opens.
      const segStart = Math.max(row.start, t);
      const segEnd = Math.min(row.end, contentEnd);
      if (!(segEnd > segStart)) return;
      const inSeconds = (segStart - row.start) / 1000;
      segments.push({
        kind: 'content', path: row.file.path, source: row.file.source || 'local',
        inSeconds, outSeconds: inSeconds + (segEnd - segStart) / 1000,
        label: ctx.channels.getDisplayTitle(row.file) || 'PROGRAM',
      });
    });
    t = contentEnd;
  }
  return segments;
}

// A channel's file path can be a mediasource:<provider>:<ref> string routed
// to a plugin rather than a real file, and ffmpeg can only read a real file.
// resolvePlayablePath hands back a genuine local path once a provider has
// cached one; anything still a live plugin stream cannot be taped, and the
// honest answer is to refuse the whole tape by name rather than quietly
// produce one with holes in it.
async function resolveSegmentPaths(segments) {
  const cache = new Map();
  const unresolvable = new Set();
  for (const segment of segments) {
    if (segment.kind === 'slate') continue;
    const key = `${segment.source}::${segment.path}`;
    if (!cache.has(key)) {
      let resolved;
      try {
        resolved = await window.api.resolvePlayablePath(segment.source, segment.path);
      } catch (e) {
        resolved = null;
      }
      const isLive = segment.source !== 'local' && !(resolved && resolved.transcodable);
      cache.set(key, isLive ? null : (resolved && resolved.path) || segment.path);
    }
    const local = cache.get(key);
    if (local == null) unresolvable.add(segment.label || segment.path);
    else segment.path = local;
  }
  return Array.from(unresolvable);
}

// ---------- recording ----------

let recOsdEl = null;
let lastStatus = { active: null, queued: [] };
let osdHideTimer = null;

function recOsd() {
  if (recOsdEl) return recOsdEl;
  recOsdEl = document.createElement('div');
  recOsdEl.className = 'tape-rec-osd hidden';
  // Top left on purpose: core keeps the top-right and bottom-left corners
  // for the logo bug and the station-ID bar, and a plugin overlay that sits
  // in either fights with them.
  document.body.appendChild(recOsdEl);
  return recOsdEl;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const STAGE_TEXT = {
  starting: 'STARTING',
  cutting: 'RECORDING',
  slate: 'RECORDING',
  assembling: 'ASSEMBLING',
};

function paintRecOsd() {
  const el = recOsd();
  const job = lastStatus.active;
  if (!job) { el.classList.add('hidden'); return; }
  const percent = Math.round((job.progress || 0) * 100);
  const queued = lastStatus.queued.length ? ` · ${lastStatus.queued.length} WAITING` : '';
  el.innerHTML = `
    <span class="tape-rec-dot" aria-hidden="true"></span>
    <span class="tape-rec-text">${STAGE_TEXT[job.stage] || 'RECORDING'} CH ${job.channelNumber} · ${percent}%${queued}</span>
  `;
  el.classList.remove('hidden');
}

// Marks the channel being recorded in the programme guide.
//
// Two halves, because the guide does not rebuild its rows on every tick: a
// core hook decorates a row as it is built (for a guide opened mid-record),
// and a sweep re-applies whenever progress changes (for a record started
// while the guide is already open). Both find the row the same way, by the
// channel number core stamps on the cell.
function paintGuideMarkers() {
  const recording = lastStatus.active ? String(lastStatus.active.channelNumber) : null;
  document.querySelectorAll('.guide-row-chan[data-channel-number]').forEach((cell) => {
    const wanted = cell.dataset.channelNumber === recording;
    const existing = cell.querySelector('.tape-guide-rec');
    if (wanted && !existing) {
      const dot = document.createElement('span');
      dot.className = 'tape-guide-rec';
      dot.title = 'Recording';
      dot.textContent = 'REC';
      cell.appendChild(dot);
    } else if (!wanted && existing) {
      existing.remove();
    }
  });
}

window.RCBPlugins.registerCoreHook('guide-channel-cell', ({ channel, cell }) => {
  if (!lastStatus.active || !cell) return;
  if (String(channel.number) !== String(lastStatus.active.channelNumber)) return;
  const dot = document.createElement('span');
  dot.className = 'tape-guide-rec';
  dot.title = 'Recording';
  dot.textContent = 'REC';
  cell.appendChild(dot);
});

// RECORD in the guide's program actions (hold OK on a program). A program
// that has started (or finished) at the viewed time is taped now from the
// schedule, like a record press while the time machine is scrubbed back; one
// that hasn't started yet becomes a timer, set against the wall clock the way
// the TIMERS panel's are.
window.RCBPlugins.registerCoreHook('guide-program-actions', ({ channel, entry, actions }) => {
  if (!channel || !entry || !Array.isArray(actions)) return;
  const ctx = window.RCBPlugins.ctx;
  if (!recorderAvailable()) return;
  const label = (entry.file && ctx.channels.getDisplayTitle(entry.file)) || channel.name || `CHANNEL ${channel.number}`;
  if (entry.start > ctx.viewNow()) {
    actions.push({
      label: 'RECORD (SET TIMER)',
      run() {
        const cfg = settingsFor(ctx);
        const timer = {
          // Wall-clock stamp plus a random tail: only an id.
          id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          channelNumber: channel.number,
          label,
          startMs: entry.start,
          endMs: entry.end,
          overwriteId: null,
          done: false,
        };
        ctx.settings.updatePluginSettings(PLUGIN_ID, { scheduled: cfg.scheduled.concat([timer]) });
        flashToast(`TIMER SET · CH ${channel.number} · ${label}`);
      },
    });
    return;
  }
  actions.push({
    label: 'RECORD',
    run() {
      if (lastStatus.active) {
        flashToast(`ALREADY TAPING CH ${lastStatus.active.channelNumber}`);
        return;
      }
      startRecording(ctx, { channel, startMs: entry.start, endMs: entry.end, title: label });
    },
  });
});

function flashToast(message, tone) {
  const el = recOsd();
  clearTimeout(osdHideTimer);
  el.innerHTML = `<span class="tape-rec-text${tone === 'bad' ? ' tape-rec-bad' : ''}">${message}</span>`;
  el.classList.remove('hidden');
  // A toast is a wall-clock nicety, not a schedule decision.
  osdHideTimer = setTimeout(() => {
    if (lastStatus.active) paintRecOsd();
    else el.classList.add('hidden');
  }, 4200);
}

// What each recording format is called and how long it holds. The running
// time is the real thing: a T-120 cassette ran two hours at SP, four at LP,
// six at EP, and a single-layer DVD held about two. Refusing an over-long
// range up front is what running out of tape felt like, and it beats
// discovering the problem after twenty minutes of encoding.
//
// The matching encode settings (resolution, bitrate) live in this plugin's
// main.js — it is the only side that needs them, and a mode id is the whole
// contract between the two halves.
const RECORD_MODES = {
  'vhs-sp': { label: 'VHS · SP', maxMinutes: 120, media: 'vhs' },
  'vhs-lp': { label: 'VHS · LP', maxMinutes: 240, media: 'vhs' },
  'vhs-ep': { label: 'VHS · EP', maxMinutes: 360, media: 'vhs' },
  'dvd-sd': { label: 'DVD · SD', maxMinutes: 120, media: 'disc' },
  bluray: { label: 'BLU-RAY · HD', maxMinutes: 240, media: 'disc' },
  // No cap and no fixed picture: record anything for as long as you like,
  // at whatever the quality setting says.
  unlimited: { label: 'UNLIMITED', maxMinutes: Infinity, media: null },
};

function modeInfo(id) {
  return RECORD_MODES[id] || RECORD_MODES.unlimited;
}

function settingsFor(ctx) {
  const cfg = ctx.settings.getPluginSettings(PLUGIN_ID) || {};
  const clamp = (value, min, max, fallback) => (
    Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback
  );
  return {
    format: cfg.format === 'dvd' ? 'dvd' : 'vhs',
    quality: ['480', '720', '1080'].includes(String(cfg.quality)) ? String(cfg.quality) : '720',
    recordMode: RECORD_MODES[cfg.recordMode] ? cfg.recordMode : 'vhs-sp',
    degrade: ['off', 'subtle', 'true'].includes(cfg.degrade) ? cfg.degrade : 'true',
    recordOnto: cfg.recordOnto === 'oldest' ? 'oldest' : 'new',
    defaultMinutes: clamp(cfg.defaultMinutes, 1, 480, 30),
    scheduled: Array.isArray(cfg.scheduled) ? cfg.scheduled : [],
  };
}

function recorderAvailable() {
  return typeof window.api.tapesRecord === 'function';
}

// The one place a recording actually starts. Everything else — the hotkey,
// the TV menu button, a scheduled entry firing — comes through here.
async function startRecording(ctx, opts) {
  if (!recorderAvailable()) {
    flashToast('RECORDING IS NOT AVAILABLE ON THIS DEVICE', 'bad');
    return { error: 'unavailable' };
  }
  const channel = opts.channel;
  if (!channel) { flashToast('NOTHING TO RECORD ON THIS CHANNEL', 'bad'); return { error: 'no channel' }; }

  const cfg = settingsFor(ctx);
  const mode = opts.mode || cfg.recordMode;
  const info = modeInfo(mode);

  // A cassette cannot become a disc by being recorded on. Caught here rather
  // than letting the sidecar quietly change what kind of object a tape is.
  if (opts.overwriteId) {
    const target = tapes.find((tape) => tape.id === opts.overwriteId);
    const targetMedia = target ? mediaOf(target, ctx) : null;
    if (target && info.media && targetMedia !== info.media) {
      const message = `${info.label} CAN'T BE RECORDED ONTO A ${targetMedia === 'disc' ? 'DISC' : 'CASSETTE'}`;
      flashToast(message, 'bad');
      return { error: `${info.label} records to ${info.media === 'disc' ? 'a disc' : 'a cassette'}, and that is a ${targetMedia === 'disc' ? 'disc' : 'cassette'}. Pick a matching format, or record onto a new blank.` };
    }
  }

  const requestedMinutes = (opts.endMs - opts.startMs) / 60000;
  if (requestedMinutes > info.maxMinutes) {
    // Running out of tape, said up front instead of after twenty minutes of
    // encoding. UNLIMITED is the way out, and the message says so.
    flashToast(`${info.label} HOLDS ${info.maxMinutes} MIN — THAT RANGE IS ${Math.ceil(requestedMinutes)}`, 'bad');
    return { error: `${info.label} holds ${info.maxMinutes} minutes; that range is ${Math.ceil(requestedMinutes)}. Record a shorter range, pick a longer format, or switch to UNLIMITED.` };
  }

  flashToast(`READING SCHEDULE · CH ${channel.number}`);
  let segments;
  try {
    segments = planSegments(ctx, channel, opts.startMs, opts.endMs);
  } catch (e) {
    flashToast('COULD NOT READ THAT CHANNEL’S SCHEDULE', 'bad');
    return { error: e.message };
  }
  if (!segments.length) {
    flashToast('NOTHING IS SCHEDULED FOR THAT TIME', 'bad');
    return { error: 'empty' };
  }

  const unresolvable = await resolveSegmentPaths(segments);
  if (unresolvable.length) {
    flashToast(`CAN’T TAPE ${unresolvable.length} ITEM${unresolvable.length === 1 ? '' : 'S'} SERVED BY A PLUGIN SOURCE`, 'bad');
    return { error: `unresolvable: ${unresolvable.slice(0, 3).join(', ')}` };
  }

  const firstProgram = segments.find((s) => s.kind === 'content');
  const result = await window.api.tapesRecord({
    title: opts.title || (firstProgram && firstProgram.label) || channel.name || `CHANNEL ${channel.number}`,
    channelNumber: channel.number,
    channelName: channel.name || `CHANNEL ${channel.number}`,
    startMs: opts.startMs,
    endMs: opts.endMs,
    mode,
    // Null means a brand-new blank; an id means this goes onto that tape,
    // over what was there, and the tape wears for it.
    overwriteId: opts.overwriteId || null,
    degrade: cfg.degrade,
    // Only consulted for UNLIMITED, where there is no format dictating the
    // picture — every named mode brings its own.
    quality: cfg.quality,
    media: info.media || (cfg.format === 'dvd' ? 'disc' : 'vhs'),
    fps: 30,
    segments: segments.map((s) => ({
      kind: s.kind, path: s.path, inSeconds: s.inSeconds, outSeconds: s.outSeconds, label: s.label,
    })),
  });
  if (result && result.error) { flashToast(result.error.toUpperCase(), 'bad'); return result; }
  const over = result && result.generation ? ` · OVER GEN ${result.generation}` : '';
  flashToast(`TAPING ${formatDuration((opts.endMs - opts.startMs) / 1000)} FROM CH ${channel.number} · ${info.label}${over}`);
  return result;
}

// ---------- scheduled recordings ----------

let scheduleTimer = null;

function scheduleTick(ctx) {
  const cfg = settingsFor(ctx);
  if (!cfg.scheduled.length) return;
  // A timer firing is a real-clock event: a scheduled recording is set
  // against the wall clock and must not move when the time machine does.
  // What gets TAPED is still resolved from the timestamps below, which is
  // pure schedule math either way.
  const now = Date.now();
  const due = cfg.scheduled.filter((entry) => (
    entry && !entry.done && Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs)
    && entry.endMs > entry.startMs && entry.startMs <= now
  ));
  if (!due.length) return;
  const remaining = cfg.scheduled.map((entry) => (
    due.includes(entry) ? { ...entry, done: true } : entry
  ));
  ctx.settings.updatePluginSettings(PLUGIN_ID, { scheduled: remaining });
  due.forEach((entry) => {
    const channel = ctx.channels.getChannel(entry.channelNumber);
    if (!channel) { flashToast(`CH ${entry.channelNumber} IS GONE — TIMER SKIPPED`, 'bad'); return; }
    startRecording(ctx, {
      channel,
      startMs: entry.startMs,
      endMs: entry.endMs,
      title: entry.label,
      overwriteId: entry.overwriteId || null,
    });
  });
}

function startScheduleWatch(ctx) {
  if (scheduleTimer) return;
  // Half a minute is fine granularity for a VCR timer and costs nothing.
  scheduleTimer = setInterval(() => scheduleTick(ctx), 30000);
  scheduleTick(ctx);
}

// ---------- discs ----------
//
// A DVD, physical or mounted, is just a VIDEO_TS folder at a drive letter, so
// finding one is finding that folder. Detection goes through core's own
// path check rather than the plugin's: this process is sandboxed to its own
// folders and cannot see a drive letter at all, while core's check is
// unrestricted and already exists. No new permission, no mounting code, and
// an image the viewer has mounted themselves shows up exactly like a disc.
//
// Windows drive letters only. A disc on another platform is reachable by
// pointing at its folder, which is the same code path from here on.
const DRIVE_LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

async function detectDiscDrives() {
  if (typeof window.api.checkPathsExist !== 'function') return [];
  const candidates = DRIVE_LETTERS.map((letter) => `${letter}:\\VIDEO_TS\\VIDEO_TS.IFO`);
  let found;
  try {
    found = await window.api.checkPathsExist(candidates);
  } catch (e) {
    return [];
  }
  return DRIVE_LETTERS
    .map((letter, i) => (found[i] ? { letter, videoTsPath: `${letter}:\\VIDEO_TS` } : null))
    .filter(Boolean);
}

// Everything the deck could load right now: any disc in a drive, a folder
// the viewer pointed at, and then the tapes on the shelf.
function discSources(ctx) {
  const folder = (ctx.settings.getPluginSettings(PLUGIN_ID) || {}).discFolder;
  const sources = discDrives.map((drive) => ({
    kind: 'disc',
    id: `drive:${drive.letter}`,
    label: `DISC IN ${drive.letter}:`,
    videoTsPath: drive.videoTsPath,
  }));
  if (typeof folder === 'string' && folder.trim()) {
    sources.push({
      kind: 'disc',
      id: 'folder',
      label: folder.split(/[\\/]/).filter(Boolean).pop() || 'DISC FOLDER',
      videoTsPath: folder.trim(),
    });
  }
  return sources;
}

// The shelf is discs first, then tapes — a disc is the thing you just put in,
// and it should not be hiding at the end of a long library.
function shelfItems(ctx) {
  return [...discSources(ctx), ...tapes.map((tape) => ({ kind: 'tape', id: tape.id, tape }))];
}

async function refreshDiscs(ctx, opts) {
  discDrives = await detectDiscDrives();
  if (opts && opts.repaint && deckState === 'shelf' && container) renderShelf(ctx);
}

// ---------- the deck (CH 101) ----------

let container = null;
let deckState = 'shelf';
let tapes = [];
let discDrives = [];      // optical drives (or mounted images) with a disc in them
let discTitles = null;    // the table of contents of the disc currently loaded
let loadedDisc = null;    // which source those titles came from
let discTimer = null;
let shelfIndex = 0;
let flipped = false;      // is the selected case turned over to its back cover
let menuIndex = 0;
let loaded = null;          // the tape currently in the deck
let clockTimer = null;
let counterTimer = null;
let stageTimer = null;
let endedHandler = null;
let errorHandler = null;
let shuttleDirection = 0;

function clearDeckTimers() {
  clearInterval(clockTimer); clockTimer = null;
  clearInterval(counterTimer); counterTimer = null;
  clearTimeout(stageTimer); stageTimer = null;
  clearInterval(discTimer); discTimer = null;
}

function detachPlayer(ctx) {
  if (endedHandler) { ctx.player.removeEventListener('ended', endedHandler); endedHandler = null; }
  if (errorHandler) { ctx.player.removeEventListener('error', errorHandler); errorHandler = null; }
}

// Which machine a given tape belongs in. Recorded onto the tape at record
// time, so a shelf holding both cassettes and discs loads each one in its
// own deck — the setting is only the fallback, for an UNLIMITED recording
// (which is not any particular format) and for a tape made before this
// existed.
function mediaOf(tape, ctx) {
  if (tape && (tape.media === 'disc' || tape.media === 'vhs')) return tape.media;
  return settingsFor(ctx).format === 'dvd' ? 'disc' : 'vhs';
}

// Whatever the shelf cursor is on: a disc in a drive, or a tape.
function selectedItem(ctx) {
  const items = shelfItems(ctx);
  return items[Math.min(shelfIndex, items.length - 1)] || null;
}

// The deck currently on screen: the loaded tape's own, or the one the
// selected case would need while still browsing the shelf. A real disc is
// always a disc, whatever the settings say.
function isDvd(ctx) {
  if (loadedDisc) return true;
  if (loaded) return mediaOf(loaded, ctx) === 'disc';
  const item = selectedItem(ctx);
  if (item && item.kind === 'disc') return true;
  return mediaOf(item && item.tape, ctx) === 'disc';
}

// ---------- the deck's sounds ----------
//
// Every noise the machine makes goes through one slot table. Each slot has a
// built-in default, synthesized from the app's own SFX primitives so the deck
// sounds like something without shipping a single audio file; point a slot at
// a real recording in settings and that plays instead. A file that will not
// load falls back to its default rather than going silent, so a moved or
// deleted sound never leaves the deck mute.
//
// Custom sounds play through core's own sfxGain node rather than a new
// <audio> element: that keeps them under the app's mute and volume, and keeps
// the one-media-element rule intact.
const SOUND_SLOTS = {
  browse: {
    label: 'BROWSING THE SHELF',
    play(ctx, opts) { ctx.audio.playTone({ freq: opts.up ? 520 : 440, duration: 40, gain: 0.06 }); },
  },
  insert: {
    label: 'PUTTING ONE IN',
    play(ctx, opts) {
      ctx.audio.playNoiseBurst({ duration: 90, filterFreq: 220, gain: 0.22 });
      ctx.audio.playTone({ freq: 120, endFreq: 60, duration: 180, type: 'square', gain: 0.14 });
      ctx.audio.playTone({
        freq: opts.disc ? 180 : 620, endFreq: opts.disc ? 620 : 180, duration: 900, type: 'sawtooth', gain: 0.05,
      });
    },
  },
  engage: {
    label: 'THE MECHANISM TAKING IT',
    play(ctx) {
      ctx.audio.playNoiseBurst({ duration: 90, filterFreq: 220, gain: 0.22 });
      ctx.audio.playTone({ freq: 120, endFreq: 60, duration: 180, type: 'square', gain: 0.14 });
    },
  },
  play: {
    label: 'PICTURE LOCKING ON',
    play(ctx) { ctx.audio.playNoiseBurst({ duration: 420, filterFreq: 1800, gain: 0.1 }); },
  },
  shuttle: {
    label: 'REWIND / FAST-FORWARD',
    play(ctx, opts) {
      if (opts.disc) { ctx.audio.playTone({ freq: opts.forward ? 740 : 560, duration: 70, gain: 0.07 }); return; }
      ctx.audio.playNoiseBurst({ duration: 180, filterFreq: opts.forward ? 2600 : 1400, gain: 0.1 });
    },
  },
  rewind: {
    label: 'REWINDING AT THE END',
    play(ctx) { ctx.audio.playTone({ freq: 620, endFreq: 180, duration: 900, type: 'sawtooth', gain: 0.05 }); },
  },
  eject: {
    label: 'EJECTING',
    play(ctx) {
      ctx.audio.playNoiseBurst({ duration: 90, filterFreq: 220, gain: 0.22 });
      ctx.audio.playTone({ freq: 120, endFreq: 60, duration: 180, type: 'square', gain: 0.14 });
    },
  },
};

// Decoded once per file for the session. A path that failed to decode is
// remembered as null so a broken sound costs one attempt, not one per press.
const sfxBufferCache = new Map();

async function sfxBuffer(ctx, filePath) {
  if (sfxBufferCache.has(filePath)) return sfxBufferCache.get(filePath);
  let buffer = null;
  try {
    const url = await window.api.toFileUrl(filePath);
    const response = await fetch(url);
    buffer = await ctx.audio.getAudioCtx().decodeAudioData(await response.arrayBuffer());
  } catch (e) {
    buffer = null;
  }
  sfxBufferCache.set(filePath, buffer);
  return buffer;
}

function customSounds(ctx) {
  const stored = (ctx.settings.getPluginSettings(PLUGIN_ID) || {}).sounds;
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function playDeckSfx(ctx, slot, opts = {}) {
  const definition = SOUND_SLOTS[slot];
  if (!definition) return;
  const custom = customSounds(ctx)[slot];
  if (!custom) { definition.play(ctx, opts); return; }
  sfxBuffer(ctx, custom).then((buffer) => {
    if (!buffer) { definition.play(ctx, opts); return; }
    const audio = ctx.audio.getAudioCtx();
    const source = audio.createBufferSource();
    source.buffer = buffer;
    // sfxGain is core's own node — getAudioCtx() has just re-read mute and
    // volume into it, so a custom sound obeys both exactly like a built-in.
    source.connect(ctx.S.sfxGain);
    source.start();
  });
}

// Warms the decode cache so the first press is not the one that waits on a
// disk read.
function preloadDeckSfx(ctx) {
  const custom = customSounds(ctx);
  Object.keys(SOUND_SLOTS).forEach((slot) => {
    if (custom[slot]) sfxBuffer(ctx, custom[slot]);
  });
}

// ---------- the deck's animations ----------
//
// The three moments the machine does something visible on its own, each with
// a built-in CSS animation and each replaceable by the viewer's own picture.
// An IMAGE rather than a video on purpose: an animated GIF, APNG or WebP
// plays in an <img> with no media element at all, which keeps the app's
// one-<video> rule intact at exactly the moment the real player is about to
// be handed a file. `ms` is how long the phase lasts, so a supplied
// animation sets its own pace instead of being cut off by the built-in
// timing.
const ANIMATION_SLOTS = {
  loading: { label: 'LOADING IT IN', defaultMs: 1650 },
  tracking: { label: 'PICTURE LOCKING ON', defaultMs: 620 },
  eject: { label: 'REWINDING AND EJECTING', defaultMs: 2200 },
};

function animationFor(ctx, slot) {
  const stored = (ctx.settings.getPluginSettings(PLUGIN_ID) || {}).animations;
  const entry = stored && typeof stored === 'object' ? stored[slot] : null;
  const definition = ANIMATION_SLOTS[slot];
  const ms = entry && Number.isFinite(entry.ms) && entry.ms >= 100 && entry.ms <= 20000
    ? Math.round(entry.ms)
    : definition.defaultMs;
  return { path: (entry && entry.path) || null, ms };
}

// Lays a supplied animation over the deck for the length of that phase. The
// built-in chassis animation keeps running underneath rather than being
// branched around, so there is one state machine, not two.
function showPhaseAnimation(ctx, slot) {
  const { path, ms } = animationFor(ctx, slot);
  if (!path || !container) return ms;
  artUrl(path).then((url) => {
    if (!url || !container) return;
    const existing = container.querySelector('.tape-phase-anim');
    if (existing) existing.remove();
    const img = document.createElement('img');
    img.className = 'tape-phase-anim';
    img.alt = '';
    img.src = url;
    container.appendChild(img);
    // Wall-clock: how long a picture stays on screen, not a schedule read.
    setTimeout(() => img.remove(), ms);
  });
  return ms;
}

// Cover art lives on disk as an ordinary image file; the page can only load
// it through app://media, so each path is resolved once and remembered. A
// path that no longer resolves is remembered as null rather than retried on
// every repaint.
const artUrlCache = new Map();

async function artUrl(filePath) {
  if (!filePath) return null;
  if (artUrlCache.has(filePath)) return artUrlCache.get(filePath);
  let url = null;
  try {
    url = await window.api.toFileUrl(filePath);
  } catch (e) {
    url = null;
  }
  artUrlCache.set(filePath, url);
  return url;
}

// Paints whichever art slots a tape has into elements tagged with
// data-art="<slot>", after the markup is already on screen. Drawing the
// layout first and letting art arrive afterwards keeps the shelf instant on
// a slow disk instead of blocking every repaint on an image resolve.
async function applyArt(root, tape, slots) {
  if (!root || !tape || !tape.art) return;
  for (const slot of slots) {
    // Every matching element, not just the first: the deck's carrier carries
    // both a cassette sticker and a disc face under the same slot, and only
    // one of the two is ever visible.
    const targets = root.querySelectorAll(`[data-art="${slot}"]`);
    if (!targets.length) continue;
    const url = await artUrl(tape.art[slot]);
    if (!url) continue;
    targets.forEach((target) => {
      if (!target.isConnected) return;
      target.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
      target.classList.add('has-art');
    });
  }
}

// The cassette shell's colour, or the disc's rim. A tape carries its own
// override once a user picks one; otherwise it gets a stable colour derived
// from its id, so a shelf of untouched tapes is still recognisable at a
// glance without anything extra having to persist.
// How many times this physical tape has been recorded over. A disc never
// wears — burning it again writes clean data — so it always reads zero
// however many times it has been used.
function wearOf(tape) {
  if (!tape || tape.media === 'disc') return 0;
  return Number.isInteger(tape.generation) ? tape.generation : 0;
}

function tapeSpineColor(tape) {
  if (typeof tape.shellColor === 'string' && /^#[0-9a-f]{6}$/i.test(tape.shellColor)) return tape.shellColor;
  let hash = 0;
  for (let i = 0; i < tape.id.length; i++) hash = (hash * 31 + tape.id.charCodeAt(i)) & 0xffff;
  return `hsl(${hash % 360} 42% 32%)`;
}

function tapeDateLabel(ctx, tape) {
  const d = new Date(tape.startMs || tape.recordedMs || 0);
  return `${ctx.util.MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()} ${String(d.getFullYear()).slice(2)}`;
}

function renderShelf(ctx) {
  const format = isDvd(ctx) ? 'dvd' : 'vhs';
  const empty = !shelfItems(ctx).length;
  container.innerHTML = `
    <div class="tape-deck tape-deck--${format}" role="region" aria-label="Channel 101 tape deck">
      <div class="tape-shelf-head">
        <span class="tape-eyebrow">CHANNEL 101 · ${format === 'dvd' ? 'DISC LIBRARY' : 'TAPE LIBRARY'}</span>
        <span class="tape-clock" data-el="clock">--:--</span>
      </div>
      <div class="tape-shelf" data-el="shelf" aria-live="polite"></div>
      <div class="tape-machine" data-el="machine">
        <div class="tape-machine-face">
          <span class="tape-machine-brand">${format === 'dvd' ? 'DISC PLAYER' : 'VIDEO CASSETTE RECORDER'}</span>
          <span class="tape-vfd" data-el="vfd">${empty ? '- - : - -' : 'STOP'}</span>
        </div>
        <div class="tape-slot" data-el="slot">
          <div class="tape-slot-mouth"></div>
          <div class="tape-carrier" data-el="carrier">
            <span class="tape-platter" data-art="label" aria-hidden="true"></span>
            <span class="tape-carrier-sticker" data-art="label" aria-hidden="true"></span>
            <span class="tape-carrier-label" data-el="carrier-label"></span>
          </div>
        </div>
      </div>
      <footer class="tape-hint">${empty
    ? 'NOTHING ON THE SHELF · PRESS R WHILE WATCHING A CHANNEL TO START TAPING, OR PUT A DVD IN'
    : `&larr;&rarr; CHOOSE · D FLIP CASE · OK ${format === 'dvd' ? 'LOAD DISC' : 'INSERT TAPE'}`}</footer>
    </div>
  `;
  paintShelf(ctx);
  updateDeckClock(ctx);
  clearInterval(clockTimer);
  clockTimer = setInterval(() => updateDeckClock(ctx), 1000);
}

// A disc in a drive, drawn as the plain unprinted case a disc you just put in
// actually comes in — no cover art, no chapter listing, because nothing has
// been read off it yet.
function discCaseHtml(item, i) {
  const known = loadedDisc && loadedDisc.id === item.id && discTitles;
  return `
    <div class="tape-case tape-case--disc tape-case--live${i === shelfIndex ? ' is-selected' : ''}"
         style="--spine:#8a8a94;--wear:0" data-case="${i}">
      <div class="tape-case-inner">
        <div class="tape-case-face tape-case-front">
          <div class="tape-case-spine">
            <span class="tape-case-title">${escapeHtml(item.label)}</span>
            <span class="tape-case-sub">${known ? `${known.length} TITLE${known.length === 1 ? '' : 'S'}` : 'DVD-VIDEO'}</span>
          </div>
          <div class="tape-case-foot">
            <span>IN THE DRIVE</span>
            <span>${known ? 'READ' : 'NOT READ YET'}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function paintShelf(ctx) {
  const shelf = container && container.querySelector('[data-el="shelf"]');
  if (!shelf) return;
  const items = shelfItems(ctx);
  if (!items.length) {
    shelf.innerHTML = '<div class="tape-shelf-empty">THE SHELF IS EMPTY</div>';
    return;
  }
  if (shelfIndex >= items.length) shelfIndex = items.length - 1;
  // Each case is two faces on one card. The back is only ever shown for the
  // selected case, so flipping reads as turning one box over rather than the
  // whole shelf rotating at once.
  shelf.innerHTML = items.map((item, i) => {
    if (item.kind === 'disc') return discCaseHtml(item, i);
    const tape = item.tape;
    return `
    <div class="tape-case tape-case--${mediaOf(tape, ctx)}${i === shelfIndex ? ' is-selected' : ''}${i === shelfIndex && flipped ? ' is-flipped' : ''}"
         style="--spine:${tapeSpineColor(tape)};--wear:${wearOf(tape)}" data-case="${i}">
      <div class="tape-case-inner">
        <div class="tape-case-face tape-case-front" data-art="front">
          <div class="tape-case-spine">
            <span class="tape-case-title">${escapeHtml(tape.title || 'UNTITLED')}</span>
            <span class="tape-case-sub">CH ${tape.channelNumber} · ${escapeHtml(tape.channelName || '')}</span>
          </div>
          <div class="tape-case-foot">
            <span>${tapeDateLabel(ctx, tape)}</span>
            <span>${modeInfo(tape.mode).label.split(' · ').pop()}${wearOf(tape) ? ` · GEN ${wearOf(tape)}` : ''}</span>
            <span>${formatDuration(tape.durationS || 0)}</span>
          </div>
        </div>
        <div class="tape-case-face tape-case-back" data-art="back">
          <div class="tape-case-blurb">
            <span class="tape-case-sub">RECORDED FROM</span>
            <span class="tape-case-title">CH ${tape.channelNumber} ${escapeHtml(tape.channelName || '')}</span>
            <span class="tape-case-sub">${tapeDateLabel(ctx, tape)} · ${formatDuration(tape.durationS || 0)}</span>
          </div>
          <ol class="tape-case-contents">
            ${(tape.chapters || []).slice(0, 7).map((c) => `<li>${escapeHtml(c.label || 'SEGMENT')}</li>`).join('')}
          </ol>
          <!-- The cassette or disc itself, sitting in the open case, wearing
               its own label art rather than the case's cover. -->
          <div class="tape-case-media tape-case-media--${mediaOf(tape, ctx)}" data-art="label" aria-hidden="true">
            <span class="tape-case-media-hub"></span>
            <span class="tape-case-media-hub"></span>
          </div>
        </div>
      </div>
    </div>
  `;
  }).join('');
  const selected = shelf.children[shelfIndex];
  if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest', inline: 'center' });
  // Art is painted after the layout so a slow disk never delays the shelf.
  items.forEach((item, i) => {
    if (item.kind === 'tape') applyArt(shelf.children[i], item.tape, ['front', 'back', 'label']);
  });
  syncMachineToSelection(ctx);
}

// Moving along a mixed shelf swaps the machine underneath it, so the deck
// you are about to put something into is always the right one.
function syncMachineToSelection(ctx) {
  const deck = container && container.querySelector('.tape-deck');
  if (!deck) return;
  const disc = isDvd(ctx);
  deck.classList.toggle('tape-deck--dvd', disc);
  deck.classList.toggle('tape-deck--vhs', !disc);
  const brand = container.querySelector('.tape-machine-brand');
  if (brand) brand.textContent = disc ? 'DISC PLAYER' : 'VIDEO CASSETTE RECORDER';
  const item = selectedItem(ctx);
  const hint = container.querySelector('.tape-hint');
  if (hint && item) {
    hint.innerHTML = item.kind === 'disc'
      ? '&larr;&rarr; CHOOSE · OK READ THIS DISC'
      : `&larr;&rarr; CHOOSE · D FLIP CASE · OK ${disc ? 'LOAD DISC' : 'INSERT TAPE'}`;
  }
  const eyebrow = container.querySelector('.tape-eyebrow');
  if (eyebrow) {
    const suffix = item && item.kind === 'tape' ? ` · ${modeInfo(item.tape.mode).label}` : '';
    eyebrow.textContent = `CHANNEL 101 · ${disc ? 'DISC LIBRARY' : 'TAPE LIBRARY'}${suffix}`;
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setVfd(text) {
  const vfd = container && container.querySelector('[data-el="vfd"]');
  if (vfd) vfd.textContent = text;
}

function updateDeckClock(ctx) {
  const clock = container && container.querySelector('[data-el="clock"]');
  if (clock) clock.textContent = ctx.util.formatClock(new Date(ctx.viewNow()));
}

// Loading is the whole point of the channel: a tape does not simply start,
// it goes in, the mechanism takes it, and the deck thinks about it for a
// moment before anything appears.
function loadTape(ctx, tape) {
  if (!tape) return;
  loaded = tape;
  deckState = 'loading';
  const dvd = isDvd(ctx);
  const machine = container.querySelector('[data-el="machine"]');
  const deck = container.querySelector('.tape-deck');
  if (deck) deck.classList.add('is-loading');
  if (machine) machine.classList.add(dvd ? 'is-tray-out' : 'is-inserting');
  const carrier = container.querySelector('[data-el="carrier"]');
  if (carrier) {
    carrier.style.setProperty('--spine', tapeSpineColor(tape));
    // The label slot is the art printed on the physical media itself — the
    // sticker across a cassette's shell, or the face of a disc — as opposed
    // to the cover art on its case.
    applyArt(carrier, tape, ['label']);
  }
  const carrierLabel = container.querySelector('[data-el="carrier-label"]');
  if (carrierLabel) carrierLabel.textContent = tape.title || 'UNTITLED';
  setVfd(dvd ? 'READING' : 'LOADING');
  playDeckSfx(ctx, 'insert', { disc: dvd });
  // A supplied animation sets the length of the whole load; the built-in
  // mechanism keeps its own two-beat timing underneath.
  const loadMs = showPhaseAnimation(ctx, 'loading');
  const seatMs = Math.round(loadMs * (dvd ? 0.55 : 0.58));

  clearTimeout(stageTimer);
  stageTimer = setTimeout(() => {
    if (machine) machine.classList.remove('is-tray-out', 'is-inserting');
    if (machine) machine.classList.add('is-seated');
    playDeckSfx(ctx, 'engage', { disc: dvd });
    stageTimer = setTimeout(() => {
      if (dvd) showDiscMenu(ctx);
      else beginPlayback(ctx, 0);
    }, loadMs - seatMs);
  }, seatMs);
}

function showDiscMenu(ctx) {
  deckState = 'menu';
  menuIndex = 0;
  clearDeckTimers();
  const chapters = (loaded.chapters || []);
  container.innerHTML = `
    <div class="tape-deck tape-deck--dvd tape-disc-menu" role="region" aria-label="Disc menu">
      <div class="tape-disc-poster" data-art="front" aria-hidden="true"></div>
      <div class="tape-disc-art">
        <div class="tape-disc-title">${escapeHtml(loaded.title || 'UNTITLED')}</div>
        <div class="tape-disc-sub">CH ${loaded.channelNumber} · ${escapeHtml(loaded.channelName || '')} · ${tapeDateLabel(ctx, loaded)}</div>
        <div class="tape-disc-run">${formatDuration(loaded.durationS || 0)} · ${chapters.length} CHAPTER${chapters.length === 1 ? '' : 'S'}</div>
      </div>
      <ol class="tape-disc-chapters" data-el="chapters">
        ${['PLAY FROM START'].concat(chapters.map((c) => c.label || 'CHAPTER')).map((label, i) => `
          <li class="tape-chapter${i === 0 ? ' is-play' : ''}" data-index="${i}">
            <span class="tape-chapter-n">${i === 0 ? '▶' : String(i).padStart(2, '0')}</span>
            <span class="tape-chapter-label">${escapeHtml(label)}</span>
            <span class="tape-chapter-time">${i === 0 ? '' : formatDuration(chapters[i - 1].startS)}</span>
          </li>
        `).join('')}
      </ol>
      <footer class="tape-hint">&larr;&rarr; CHOOSE CHAPTER · OK PLAY · E EJECT</footer>
    </div>
  `;
  paintMenu();
  applyArt(container, loaded, ['front']);
}

function paintMenu() {
  const list = container && container.querySelector('[data-el="chapters"]');
  if (!list) return;
  Array.from(list.children).forEach((li, i) => li.classList.toggle('is-selected', i === menuIndex));
  const selected = list.children[menuIndex];
  if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' });
}

// ---------- loading a disc ----------

// Reads a disc's table of contents and shows what is on it. The mechanism
// animation runs for real while the IFOs are being fetched, so the wait is
// the deck thinking rather than a frozen screen.
async function loadDisc(ctx, item) {
  loadedDisc = item;
  discTitles = null;
  deckState = 'reading';
  const machine = container.querySelector('[data-el="machine"]');
  if (machine) machine.classList.add('is-tray-out');
  setVfd('READING');
  playDeckSfx(ctx, 'insert', { disc: true });
  showPhaseAnimation(ctx, 'loading');

  let result;
  try {
    result = await window.api.tapesReadDisc(item.videoTsPath);
  } catch (e) {
    result = { error: e.message };
  }
  if (deckState !== 'reading' || !container) return; // ejected while reading

  if (machine) { machine.classList.remove('is-tray-out'); machine.classList.add('is-seated'); }
  playDeckSfx(ctx, 'engage', { disc: true });

  if (!result || result.error) {
    loadedDisc = null;
    deckState = 'shelf';
    // A scrambled disc is a specific, recognisable case rather than a
    // generic failure, and it reads its titles fine — so say which one it is
    // instead of "could not be read".
    setVfd(result && result.encrypted ? 'PROTECTED' : 'NO DISC');
    flashToast(
      result && result.encrypted
        ? 'THIS DISC IS COPY-PROTECTED · RERUNTV DOES NOT DESCRAMBLE DISCS'
        : String((result && result.error) || 'THAT DISC COULD NOT BE READ').toUpperCase(),
      'bad',
    );
    renderShelf(ctx);
    return;
  }
  discTitles = result.titles || [];
  showDiscTitleMenu(ctx);
}

function titleLine(title) {
  const parts = [`${formatDuration(title.durationS || 0)}`];
  if (title.chapterCount) parts.push(`${title.chapterCount} CH`);
  const languages = (title.audio || []).map((a) => (a.language || '').toUpperCase()).filter(Boolean);
  if (languages.length) parts.push(Array.from(new Set(languages)).join('/'));
  return parts.join(' · ');
}

// The disc's titles, in the deck's own menu. Not the disc's pressed menu —
// that needs a subpicture decoder and the disc's own bytecode interpreter,
// which this deliberately does not carry. This is built from the structure
// the disc really has, which is the part that matters for choosing something
// to keep.
function showDiscTitleMenu(ctx) {
  deckState = 'discmenu';
  menuIndex = 0;
  clearDeckTimers();
  const titles = discTitles || [];
  container.innerHTML = `
    <div class="tape-deck tape-deck--dvd tape-disc-menu" role="region" aria-label="Disc titles">
      <div class="tape-disc-art">
        <div class="tape-disc-title">${escapeHtml(loadedDisc ? loadedDisc.label : 'DISC')}</div>
        <div class="tape-disc-sub">${titles.length} TITLE${titles.length === 1 ? '' : 'S'} ON THIS DISC</div>
        <div class="tape-disc-run">KEEPING A TITLE COPIES IT TO THE SHELF AS A TAPE</div>
      </div>
      <ol class="tape-disc-chapters" data-el="chapters">
        ${titles.map((title, i) => `
          <li class="tape-chapter" data-index="${i}">
            <span class="tape-chapter-n">${String(title.title).padStart(2, '0')}</span>
            <span class="tape-chapter-label">TITLE ${title.title}</span>
            <span class="tape-chapter-time">${titleLine(title)}</span>
          </li>
        `).join('')}
      </ol>
      <footer class="tape-hint">&larr;&rarr; CHOOSE TITLE · OK KEEP IT · E EJECT</footer>
    </div>
  `;
  if (!titles.length) {
    const list = container.querySelector('[data-el="chapters"]');
    if (list) list.innerHTML = '<li class="tape-chapter"><span class="tape-chapter-label">NOTHING PLAYABLE ON THIS DISC</span></li>';
  }
  paintMenu();
}

// Which VOBs actually hold a title. A DVD splits one across numbered files at
// a 1GB boundary, and only the disc knows how many there are — so ask which
// exist rather than assuming. VTS_nn_0.VOB is the title set's own menu and is
// deliberately not included.
async function titleVobFiles(videoTsPath, vts) {
  const set = String(vts).padStart(2, '0');
  const candidates = [];
  for (let i = 1; i <= 9; i++) candidates.push(`${videoTsPath}\\VTS_${set}_${i}.VOB`);
  let found;
  try {
    found = await window.api.checkPathsExist(candidates);
  } catch (e) {
    return [];
  }
  return candidates.filter((_, i) => found[i]);
}

// Copies one title off the disc onto the shelf. It goes through the ordinary
// recording queue — same progress readout, same shelf, same case artwork —
// with the disc as its one segment.
async function keepDiscTitle(ctx, title) {
  if (!recorderAvailable()) { flashToast('RECORDING IS NOT AVAILABLE ON THIS DEVICE', 'bad'); return; }
  if (!loadedDisc) return;
  flashToast(`READING TITLE ${title.title}`);
  const files = await titleVobFiles(loadedDisc.videoTsPath, title.vts);
  if (!files.length) {
    flashToast('THAT TITLE\'S VIDEO FILES ARE NOT READABLE', 'bad');
    return;
  }
  const result = await window.api.tapesRecord({
    title: `${loadedDisc.label} · TITLE ${title.title}`,
    channelNumber: 0,
    channelName: loadedDisc.label,
    startMs: Date.now(), // when the copy was made — a real-clock fact, not a schedule read
    endMs: Date.now() + Math.round((title.durationS || 0) * 1000),
    // A DVD is standard definition; copying it at anything else would be
    // inventing detail the disc never had. Its own length is its own
    // business, so no format cap applies.
    mode: 'dvd-sd',
    media: 'disc',
    degrade: 'off',
    disc: { durationS: title.durationS, title: title.title },
    chapters: (title.chapters || []).map((chapter, i) => ({
      startS: chapter.startS,
      label: `CHAPTER ${i + 1}`,
    })),
    segments: [{
      kind: 'disc',
      files,
      inSeconds: 0,
      outSeconds: Math.max(1, title.durationS || 0),
      label: `TITLE ${title.title}`,
    }],
  });
  if (result && result.error) { flashToast(String(result.error).toUpperCase(), 'bad'); return; }
  flashToast(`COPYING TITLE ${title.title} · ${formatDuration(title.durationS || 0)}`);
}

async function beginPlayback(ctx, startSeconds) {
  deckState = 'playing';
  clearDeckTimers();
  const dvd = isDvd(ctx);
  const wear = wearOf(loaded);
  container.innerHTML = `
    <div class="tape-deck tape-deck--${dvd ? 'dvd' : 'vhs'} tape-playing${wear ? ' is-worn' : ''}"
         style="--wear:${wear}" data-el="stage">
      <div class="tape-bluescreen" data-el="blue"></div>
      <div class="tape-tracking" data-el="tracking" aria-hidden="true"></div>
      <div class="tape-osd" data-el="osd">
        <span class="tape-osd-mode" data-el="mode">${dvd ? '▶' : '▶ PLAY'}</span>
        <span class="tape-osd-counter" data-el="counter">0:00</span>
        ${wear ? `<span class="tape-osd-wear">GEN ${wear}</span>` : ''}
      </div>
      <div class="tape-stamp" data-el="stamp">${escapeHtml(loaded.title || '')} · ${tapeDateLabel(ctx, loaded)}</div>
      <div class="tape-shuttle hidden" data-el="shuttle"></div>
      <footer class="tape-hint tape-hint--play">OK PAUSE · &larr;&rarr; ${dvd ? 'CHAPTER' : 'REW / FF'} · E EJECT</footer>
    </div>
  `;

  let url;
  try {
    url = await window.api.toFileUrl(loaded.path);
  } catch (e) {
    setStageMessage('THIS TAPE COULD NOT BE READ');
    return;
  }
  if (deckState !== 'playing') return; // ejected while we were resolving

  detachPlayer(ctx);
  ctx.player.loop = false;
  ctx.player.src = url;
  const onMeta = () => {
    ctx.player.removeEventListener('loadedmetadata', onMeta);
    if (deckState !== 'playing') return;
    if (startSeconds > 0) ctx.player.currentTime = startSeconds;
    ctx.player.play().catch(() => {});
  };
  ctx.player.addEventListener('loadedmetadata', onMeta);

  endedHandler = () => {
    if (isDvd(ctx)) {
      // A disc returns to its menu. A tape does what a tape does.
      showDiscMenu(ctx);
    } else {
      rewindAndEject(ctx);
    }
  };
  errorHandler = () => setStageMessage('TRACKING ERROR — THIS TAPE IS UNREADABLE');
  ctx.player.addEventListener('ended', endedHandler);
  ctx.player.addEventListener('error', errorHandler);

  // The blue screen and the tracking bars are the give-away that a real deck
  // just engaged: a beat of blue, then the picture arrives through noise
  // that settles over a second or so.
  playDeckSfx(ctx, 'play', { disc: dvd });
  const blueMs = showPhaseAnimation(ctx, 'tracking');
  const stage = container.querySelector('[data-el="stage"]');
  stageTimer = setTimeout(() => {
    const blue = container && container.querySelector('[data-el="blue"]');
    if (blue) blue.classList.add('is-gone');
    if (stage) stage.classList.add('is-settling');
    stageTimer = setTimeout(() => {
      if (stage) stage.classList.remove('is-settling');
      if (stage) stage.classList.add('is-locked');
    }, dvd ? 200 : 1500);
  }, dvd ? Math.min(260, blueMs) : blueMs);

  counterTimer = setInterval(() => updateCounter(ctx), 250);
}

function setStageMessage(message) {
  const osd = container && container.querySelector('[data-el="osd"]');
  if (osd) osd.innerHTML = `<span class="tape-osd-mode tape-osd-bad">${escapeHtml(message)}</span>`;
}

function updateCounter(ctx) {
  const counter = container && container.querySelector('[data-el="counter"]');
  if (!counter) return;
  counter.textContent = formatDuration(ctx.player.currentTime || 0);
}

function setMode(text) {
  const mode = container && container.querySelector('[data-el="mode"]');
  if (mode) mode.textContent = text;
}

function showShuttle(text) {
  const shuttle = container && container.querySelector('[data-el="shuttle"]');
  if (!shuttle) return;
  shuttle.textContent = text;
  shuttle.classList.remove('hidden');
  clearTimeout(showShuttle.timer);
  // Purely a display flourish on a wall-clock timer.
  showShuttle.timer = setTimeout(() => shuttle.classList.add('hidden'), 900);
}

function rewindAndEject(ctx) {
  deckState = 'rewinding';
  clearDeckTimers();
  detachPlayer(ctx);
  ctx.player.pause();
  ctx.player.removeAttribute('src');
  container.innerHTML = `
    <div class="tape-deck tape-deck--vhs tape-rewinding">
      <div class="tape-rewind-reel" aria-hidden="true"><span></span><span></span></div>
      <div class="tape-rewind-label">REWINDING</div>
    </div>
  `;
  playDeckSfx(ctx, 'rewind');
  const ejectMs = showPhaseAnimation(ctx, 'eject');
  stageTimer = setTimeout(() => {
    playDeckSfx(ctx, 'eject');
    ejectToShelf(ctx);
  }, ejectMs);
}

function ejectToShelf(ctx) {
  clearDeckTimers();
  detachPlayer(ctx);
  ctx.player.pause();
  ctx.player.removeAttribute('src');
  loaded = null;
  deckState = 'shelf';
  flipped = false;
  renderShelf(ctx);
}

// Putting a disc back on the shelf. Nothing to rewind and nothing playing,
// so this is just the deck letting go of what it read.
function ejectDisc(ctx) {
  clearDeckTimers();
  playDeckSfx(ctx, 'eject', { disc: true });
  loadedDisc = null;
  discTitles = null;
  deckState = 'shelf';
  flipped = false;
  renderShelf(ctx);
}

async function refreshTapes(ctx, opts) {
  if (typeof window.api.tapesList !== 'function') { tapes = []; return; }
  try {
    const result = await window.api.tapesList();
    tapes = (result && result.tapes) || [];
  } catch (e) {
    tapes = [];
  }
  // Clamped against the whole shelf, not the tape count: discs sit ahead of
  // the tapes, so measuring against tapes alone drags the cursor backwards
  // every time the list refreshes.
  const count = shelfItems(ctx).length;
  if (shelfIndex >= count) shelfIndex = Math.max(0, count - 1);
  if (opts && opts.repaint && deckState === 'shelf' && container) renderShelf(ctx);
}

// ---------- registration ----------

window.RCBPlugins.registerInterrupt(PLUGIN_ID, {
  label: 'RECORD',
  hintKey: 'tape-record',
  hotkey: 'r',
  run() {
    const ctx = window.RCBPlugins.ctx;
    if (lastStatus.active) {
      // Already taping. A second press reports rather than starting a
      // second job on top of the first.
      paintRecOsd();
      flashToast(`ALREADY TAPING CH ${lastStatus.active.channelNumber} · ${Math.round((lastStatus.active.progress || 0) * 100)}%`);
      return;
    }
    const channel = ctx.channels.getChannel(ctx.S.currentNumber);
    if (!channel) { flashToast('NOTHING TO RECORD ON THIS CHANNEL', 'bad'); return; }
    const cfg = settingsFor(ctx);
    // Reaching for the oldest tape on the shelf and taping over it is what a
    // household with a finite pile of cassettes actually did; a brand-new
    // blank every time is the other, tidier option.
    const oldest = cfg.recordOnto === 'oldest' && tapes.length
      ? tapes.reduce((a, b) => ((a.recordedMs || 0) <= (b.recordedMs || 0) ? a : b))
      : null;
    // viewNow(), not Date.now(): pressing record while the time machine is
    // scrubbed back tapes the broadcast you are actually looking at.
    const startMs = ctx.viewNow();
    startRecording(ctx, {
      channel,
      startMs,
      endMs: startMs + cfg.defaultMinutes * 60000,
      overwriteId: oldest ? oldest.id : null,
    });
  },
  cancel() {
    // Core calls this on power-off and on every channel change. A recording
    // is a background job, not an overlay — it deliberately keeps running.
    // Only the transient toast is cleared here.
    if (!lastStatus.active && recOsdEl) recOsdEl.classList.add('hidden');
  },
  isActive() {
    return !!lastStatus.active;
  },
});

window.RCBPlugins.registerChannelType(PLUGIN_ID, {
  number: CHANNEL_NUMBER,
  label: 'TAPES',
  nowText: 'Home Recordings',
  badge: { bg: '#3f3f46', label: 'TAPES' },
  // What is on this channel is whatever is in the deck, which is a choice
  // the viewer made and not a function of the clock. Scrubbing time cannot
  // re-derive it, so the time machine stays off here.
  supportsTimeMachine: false,
  onKey(key, ctx) {
    if (deckState === 'shelf') {
      const count = shelfItems(ctx).length;
      if (key === 'ArrowLeft' && count) {
        shelfIndex = (shelfIndex - 1 + count) % count;
        // Moving along the shelf puts the previous box back face-out, the
        // way setting one down and picking up the next would.
        flipped = false;
        paintShelf(ctx);
        playDeckSfx(ctx, 'browse', { up: false });
        return true;
      }
      if (key === 'ArrowRight' && count) {
        shelfIndex = (shelfIndex + 1) % count;
        flipped = false;
        paintShelf(ctx);
        playDeckSfx(ctx, 'browse', { up: true });
        return true;
      }
      // A disc in a drive has no case to turn over — nothing has been
      // printed, and nothing has been read off it yet.
      if ((key === 'd' || key === 'D') && count) {
        const item = selectedItem(ctx);
        if (!item || item.kind !== 'tape') return false;
        flipped = !flipped;
        paintShelf(ctx);
        playDeckSfx(ctx, 'browse', { up: true });
        return true;
      }
      return false;
    }
    if (deckState === 'reading') return false; // nothing to do until the disc answers
    if (deckState === 'discmenu') {
      const count = (discTitles || []).length;
      if (!count) {
        if (key === 'e' || key === 'E') { ejectDisc(ctx); return true; }
        return false;
      }
      if (key === 'ArrowLeft') { menuIndex = (menuIndex - 1 + count) % count; paintMenu(); return true; }
      if (key === 'ArrowRight') { menuIndex = (menuIndex + 1) % count; paintMenu(); return true; }
      if (key === 'e' || key === 'E') { ejectDisc(ctx); return true; }
      return false;
    }
    if (deckState === 'menu') {
      const count = (loaded.chapters || []).length + 1;
      if (key === 'ArrowLeft') { menuIndex = (menuIndex - 1 + count) % count; paintMenu(); return true; }
      if (key === 'ArrowRight') { menuIndex = (menuIndex + 1) % count; paintMenu(); return true; }
      if (key === 'e' || key === 'E') { playDeckSfx(ctx, 'eject', { disc: true }); ejectToShelf(ctx); return true; }
      return false;
    }
    if (deckState === 'playing') {
      if (key === 'e' || key === 'E') {
        if (isDvd(ctx)) { playDeckSfx(ctx, 'eject', { disc: true }); ejectToShelf(ctx); } else rewindAndEject(ctx);
        return true;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const forward = key === 'ArrowRight';
        if (isDvd(ctx)) {
          // A disc skips by chapter, which is exactly the break structure
          // the recording already knows about.
          const chapters = loaded.chapters || [];
          const at = ctx.player.currentTime || 0;
          const target = forward
            ? chapters.find((c) => c.startS > at + 0.5)
            : [...chapters].reverse().find((c) => c.startS < at - 2);
          ctx.player.currentTime = target ? target.startS : (forward ? ctx.player.duration || at : 0);
          showShuttle(forward ? 'NEXT ▶▶' : '◀◀ PREV');
          playDeckSfx(ctx, 'shuttle', { disc: true, forward });
        } else {
          // A tape shuttles. Fifteen seconds a press, with the streak and
          // the noise that went with it.
          shuttleDirection = forward ? 1 : -1;
          const next = Math.max(0, (ctx.player.currentTime || 0) + shuttleDirection * 15);
          ctx.player.currentTime = Math.min(next, Math.max(0, (ctx.player.duration || next) - 0.2));
          showShuttle(forward ? 'FF ▶▶' : '◀◀ REW');
          playDeckSfx(ctx, 'shuttle', { disc: false, forward });
        }
        updateCounter(ctx);
        return true;
      }
      return false;
    }
    return false;
  },
  onOk(ctx) {
    if (deckState === 'shelf') {
      const item = selectedItem(ctx);
      if (!item) return;
      if (item.kind === 'disc') { loadDisc(ctx, item); return; }
      loadTape(ctx, item.tape);
      return;
    }
    if (deckState === 'discmenu') {
      const title = (discTitles || [])[menuIndex];
      if (title) keepDiscTitle(ctx, title);
      return;
    }
    if (deckState === 'menu') {
      const chapters = loaded.chapters || [];
      const startSeconds = menuIndex === 0 ? 0 : (chapters[menuIndex - 1].startS || 0);
      beginPlayback(ctx, startSeconds);
      return;
    }
    if (deckState === 'playing') {
      if (ctx.player.paused) {
        ctx.player.play().catch(() => {});
        setMode(isDvd(ctx) ? '▶' : '▶ PLAY');
      } else {
        ctx.player.pause();
        setMode(isDvd(ctx) ? '❚❚' : '❚❚ PAUSE');
        if (!isDvd(ctx)) playDeckSfx(ctx, 'engage', { disc: false });
      }
    }
  },
  render(el, ctx) {
    container = el;
    deckState = 'shelf';
    loaded = null;
    shelfIndex = 0;
    flipped = false;
    clearDeckTimers();
    loadedDisc = null;
    discTitles = null;
    startScheduleWatch(ctx);
    preloadDeckSfx(ctx);
    renderShelf(ctx);
    // A disc put in while the channel is already tuned should appear on its
    // own. Polling rather than watching because there is no event for it —
    // wall-clock, and slow enough to be free.
    refreshDiscs(ctx, { repaint: true });
    discTimer = setInterval(() => {
      if (deckState === 'shelf') refreshDiscs(ctx, { repaint: true });
    }, 4000);
    // The shelf is drawn immediately from whatever was already known, then
    // refreshed — tuning in should never wait on a directory read.
    refreshTapes(ctx, { repaint: true });
  },
  stop(ctx) {
    clearDeckTimers();
    const player = (ctx && ctx.player) || window.RCBPlugins.ctx.player;
    detachPlayer({ player });
    player.pause();
    player.removeAttribute('src');
    container = null;
    loaded = null;
    loadedDisc = null;
    discTitles = null;
    deckState = 'shelf';
  },
});

window.RCBPlugins.registerRendererService(PLUGIN_ID, {
  // The settings panel needs the slot list and a way to hear one; it should
  // not be re-declaring either.
  soundSlots: () => Object.entries(SOUND_SLOTS).map(([id, def]) => ({ id, label: def.label })),
  animationSlots: () => Object.entries(ANIMATION_SLOTS).map(([id, def]) => ({ id, label: def.label, defaultMs: def.defaultMs })),
  previewSound: (slot) => {
    sfxBufferCache.clear();
    playDeckSfx(window.RCBPlugins.ctx, slot, { disc: false, forward: true, up: true });
  },
  // Exposed so the settings panel can drive a recording without duplicating
  // the planner, and so another plugin could trigger a tape if it ever
  // wanted one.
  record: (opts) => startRecording(window.RCBPlugins.ctx, opts),
  plan: (channel, startMs, endMs) => planSegments(window.RCBPlugins.ctx, channel, startMs, endMs),
  list: () => (typeof window.api.tapesList === 'function' ? window.api.tapesList() : Promise.resolve({ tapes: [] })),
  status: () => lastStatus,
});

if (typeof window.api.onTapesProgress === 'function') {
  window.api.onTapesProgress((status) => {
    lastStatus = status || { active: null, queued: [] };
    paintRecOsd();
    paintGuideMarkers();
  });
}
if (typeof window.api.onTapesDone === 'function') {
  window.api.onTapesDone((result) => {
    if (result && result.error) flashToast(String(result.error).toUpperCase(), 'bad');
    else if (result && result.cancelled) flashToast('RECORDING CANCELLED');
    else if (result && result.tape) flashToast(`TAPE READY · ${String(result.tape.title || '').toUpperCase()}`);
    // The job is over, so clear its guide marker without waiting for the
    // next progress push — there will not be one.
    lastStatus = { active: null, queued: lastStatus.queued || [] };
    paintGuideMarkers();
    refreshTapes(window.RCBPlugins.ctx, { repaint: true });
  });
}
startScheduleWatch(window.RCBPlugins.ctx);
// The R key can reach for the oldest tape on the shelf without CH 101 ever
// having been tuned, so the shelf is read once at load rather than only on
// the channel's first render.
refreshTapes(window.RCBPlugins.ctx);
