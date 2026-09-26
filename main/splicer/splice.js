#!/usr/bin/env node
'use strict';

/**
 * Video Splicer — part of RerunTV (setup › LIBRARY › SPLICER runs this through
 * service.js), and still a plain command-line tool:
 *
 * Splits a compilation tape (episodes + commercials + bumpers back-to-back)
 * into individual clips by detecting black frames, silence, hard visual
 * scene changes and a recurring logo card at segment boundaries, then sorts
 * the clips into folders by duration so you can quickly review and drop them
 * into your channel media folders.
 *
 * Usage (from the repo root, `node main/splicer/splice.js ...`):
 *   node splice.js <input-video> [options]
 *   node splice.js <input-video-1> <input-video-2> ... [options]
 *   node splice.js --dir <folder> [options]     (processes every video file in the folder)
 *
 * Bulk mode notes:
 *   - Multiple inputs (listed explicitly or via --dir) share one --out tree;
 *     all clips land in the same episodes/commercials/bumpers folders, with
 *     each clip name prefixed by its source file's name to avoid collisions.
 *   - One manifest.json covering all inputs is written to --out, plus a
 *     per-source "sourceFile" field on each entry.
 *   - A failure on one input is reported and skipped; the rest still run.
 *
 * Options:
 *   --dir <folder>         Process every video file in this folder (bulk mode)
 *   --ext <list>           Comma-separated extensions to match in --dir mode (default: mp4,mkv,mov,avi,ts,m4v,wmv)
 *   --out <dir>            Output directory (default: ./output next to input, or next to --dir)
 *   --dry-run              Only print detected cut points, don't split
 *   --min-gap <sec>        Minimum silence/black duration to count as a cut (default: 0.4)
 *   --min-clip <sec>       Discard/merge clips shorter than this (default: 2)
 *   --black-thresh <0-1>   blackdetect pix_th sensitivity (default: 0.10)
 *   --silence-db <dB>      silencedetect noise floor (default: -30)
 *   --scene-thresh <0-100> scdet sensitivity for hard cuts with no black/silence gap
 *                          (default: 16; lower = more sensitive/more false positives)
 *   --logo-time <sec[,sec...]>    Timestamp(s) of a recurring logo/bumper card to also
 *                                 detect as a cut signal (see logo-detect.js for background)
 *   --logo-image <path[,path...]> Reference image(s) of the logo instead of a timestamp
 *   --logo-thresh <0-255>  Max mean-abs-diff to count as a logo match (default: 18)
 *   --bumper-max <sec>     Clips <= this go in bumpers/ (default: 20)
 *   --commercial-max <sec> Clips <= this (and > bumper-max) go in commercials/ (default: 120)
 *   --keep-gaps            Cut in the middle of a black/silent gap instead of leaving
 *                          the gap out of both clips (the default drops it)
 *   --reencode             Re-encode whole clips (slowest; always .mp4/.mkv/.mov)
 *   --fast-cut             Plain stream copy: fastest, but a clip starts on the first
 *                          keyframe after its cut. The default re-encodes just the
 *                          head up to that keyframe ("smart cut", H.264 sources) so
 *                          clips start on the exact frame.
 *   --no-black             Disable black-frame detection
 *   --no-silence           Disable silence detection
 *   --no-scene             Disable visual scene-change detection
 *
 * Anything longer than --commercial-max is treated as an episode/segment.
 *
 * Review workflow (for content where blind auto-split isn't reliable — see
 * README's "Which signals to use" section):
 *   node splice.js <input> --review                 Detect candidate cuts, write a
 *                                                    before/after thumbnail sheet per
 *                                                    cut plus review/candidates.json —
 *                                                    writes no video clips.
 *   node splice.js --split-candidates <path-to-candidates.json> [--exclude 3,7,12]
 *                                                    Split using the reviewed candidate
 *                                                    list, dropping any indices in
 *                                                    --exclude after you've looked at
 *                                                    the thumbnails.
 *
 * Exact plans (what the SPLICER page's editor sends):
 *   node splice.js --plan <plan.json> --out <dir>    Split exactly these clips:
 *     { "files": [{ "sourcePath": "...", "clips": [{ "start": 0, "end": 8.5,
 *       "category": "bumpers" | "commercials" | "episodes" | "skip", "name": "..." }] }] }
 *   node splice.js --find-repeats <plan.json>        Report clips that are the same
 *                                                    thing aired twice (no files written).
 */

const path = require('path');
const fs = require('fs');
const { runFfmpeg, runFfmpegWithProgress, runFfmpegCollectStdout, runFfmpegFrames } = require('./ffmpeg-runner');
const { probe, smartCut } = require('./smart-cut');
const {
  DEFAULT_VIDEO_EXTS, parseArgs, fmtTime, mergeBoundaries, edgeTrim, clipsFromCuts, classify, meanAbsDiff, matchRuns,
  keptCandidateCuts, findRepeats, safeFileName, reencodeExt,
} = require('./cuts');

const CATEGORIES = ['episodes', 'commercials', 'bumpers'];

async function getSource(input) {
  const info = await probe(input);
  if (!info.duration) throw new Error('Could not determine input duration. Is this a valid video file?\n' + info.stderr.slice(-800));
  return info;
}

async function detectBoundaries(input, opts, duration) {
  const filters = [];
  if (!opts.noBlack) filters.push(`blackdetect=d=${opts.minGap}:pix_th=${opts.blackThresh}`);
  if (!opts.noScene) filters.push(`scdet=threshold=${opts.sceneThresh}`);
  const args = ['-i', input];
  if (filters.length) args.push('-vf', filters.join(','));
  else args.push('-vn');
  if (!opts.noSilence) args.push('-af', `silencedetect=n=${opts.silenceDb}dB:d=${opts.minGap}`);
  else args.push('-an');
  args.push('-f', 'null', '-');

  const signals = { black: [], silence: [], scene: [] };
  if (opts.noBlack && opts.noScene && opts.noSilence) return signals;

  console.log('Scanning for cut points (this reads through the whole file once)...');
  // Emits "[N/100]" lines as the scan progresses so the UI's job-progress bar
  // (which watches stdout for that pattern) shows real movement instead of
  // sitting frozen for however long a full-file read-through takes.
  const { stderr } = await runFfmpegWithProgress(args, duration, (pct) => {
    console.log(`  [${pct}/100] scanning...`);
  });

  let m;
  const blackRe = /black_start:(\d+(?:\.\d+)?)\s+black_end:(\d+(?:\.\d+)?)/g;
  while ((m = blackRe.exec(stderr))) signals.black.push({ from: parseFloat(m[1]), to: parseFloat(m[2]) });

  const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((x) => Math.max(0, parseFloat(x[1])));
  const ends = [...stderr.matchAll(/silence_end:\s*(\d+(?:\.\d+)?)/g)].map((x) => parseFloat(x[1]));
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) signals.silence.push({ from: starts[i], to: ends[i] });

  const sceneRe = /lavfi\.scd\.time:\s*(\d+(?:\.\d+)?)/g;
  while ((m = sceneRe.exec(stderr))) signals.scene.push(parseFloat(m[1]));
  return signals;
}

const LOGO_FPS = 5;
const LOGO_THUMB = 32;
const LOGO_MIN_RUN = 0.3;

async function grayFrame(args, size) {
  const buf = await runFfmpegCollectStdout([...args, '-frames:v', '1', '-vf', `scale=${size}:${size}:force_original_aspect_ratio=disable,format=gray`, '-f', 'rawvideo', '-']);
  if (buf.length < size * size) throw new Error('Could not read a frame.');
  return Uint8Array.from(buf.subarray(0, size * size));
}

async function getLogoReferenceVectors(input, opts) {
  const refs = [];
  for (const img of opts.logoImages) {
    try { refs.push(await grayFrame(['-i', img], LOGO_THUMB)); } catch (e) { throw new Error(`Failed to extract reference frame from ${img}.`); }
  }
  for (const t of opts.logoTimes) {
    try { refs.push(await grayFrame(['-ss', String(t), '-i', input], LOGO_THUMB)); } catch (e) { throw new Error(`Failed to extract reference frame at t=${t} from ${input}.`); }
  }
  return refs;
}

async function detectLogoCuts(input, opts, duration) {
  if (!opts.logoTimes.length && !opts.logoImages.length) return [];
  const refs = await getLogoReferenceVectors(input, opts);

  console.log('Looking for the logo (this reads through the whole file once more)...');
  const isMatch = [];
  const totalFrames = Math.max(1, Math.round(duration * LOGO_FPS));
  let lastPct = -1;
  await runFfmpegFrames(['-i', input, '-map', '0:v:0', '-vf', `fps=${LOGO_FPS},scale=${LOGO_THUMB}:${LOGO_THUMB}:force_original_aspect_ratio=disable,format=gray`, '-f', 'rawvideo', '-'],
    LOGO_THUMB * LOGO_THUMB, (frame, index) => {
      isMatch[index] = Math.min(...refs.map((ref) => meanAbsDiff(frame, ref))) <= opts.logoThresh;
      const pct = Math.min(100, Math.round((index / totalFrames) * 100));
      if (pct !== lastPct) { lastPct = pct; console.log(`  [${pct}/100] scanning for the logo...`); }
    });

  const minRunFrames = Math.max(1, Math.round(LOGO_MIN_RUN * LOGO_FPS));
  return matchRuns(isMatch, minRunFrames).map((run) => (run.startFrame + run.endFrame) / 2 / LOGO_FPS);
}

// ---------- Writing clips ----------

async function encodeClip(input, start, end, outFile, reencode) {
  // No -ss at all for a clip that starts the recording: a copy starting at
  // 0 drops every video packet before the next keyframe on sources whose
  // first frame is stamped a hair after zero, which is most H.264 files.
  const args = ['-y', '-i', input, ...(start > 0.001 ? ['-ss', start.toFixed(3)] : []), '-to', end.toFixed(3)];
  if (reencode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac');
  else args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  args.push(outFile);
  const { code, stderr } = await runFfmpeg(args);
  if (code !== 0) throw new Error(`ffmpeg failed on ${outFile} (exit ${code}):\n${stderr.slice(-500)}`);
}

// Writes one clip, choosing how: returns { file, method }.
async function writeClip(input, clip, outBase, ext, opts, source) {
  if (opts.reencode) {
    const file = `${outBase}${reencodeExt(ext)}`;
    await encodeClip(input, clip.start, clip.end, file, true);
    return { file, method: 're-encoded' };
  }
  if (!opts.fastCut && source.videoCodec) {
    try {
      const file = `${outBase}${ext}`;
      const method = await smartCut(input, clip.start, clip.end, file, { source });
      return { file, method: method === 'smart' ? 'exact start' : 'copied' };
    } catch (e) {
      // Not H.264, no keyframe inside the clip, or a join that didn't check
      // out: re-encode this one clip so it still starts on the right frame.
      const file = `${outBase}${reencodeExt(ext)}`;
      await encodeClip(input, clip.start, clip.end, file, true);
      return { file, method: 're-encoded' };
    }
  }
  const file = `${outBase}${ext}`;
  await encodeClip(input, clip.start, clip.end, file, false);
  // A stream copy can only start on a keyframe, so a clip shorter than the
  // gap between two of them comes out with sound and no picture.
  if (source.videoCodec && !(await probe(file)).videoCodec) {
    fs.rmSync(file, { force: true });
    const redo = `${outBase}${reencodeExt(ext)}`;
    await encodeClip(input, clip.start, clip.end, redo, true);
    return { file: redo, method: 're-encoded (no keyframe inside)' };
  }
  return { file, method: 'copied' };
}

// A name not already taken in this run or on disk, in any extension a clip
// might end up with.
function freeBase(dir, stem, seenNames) {
  const taken = (candidate) => seenNames.has(path.join(dir, candidate).toLowerCase())
    || ['.mp4', '.mkv', '.mov', '.m4v', '.avi', '.ts', '.wmv', '.mpg'].some((e) => fs.existsSync(path.join(dir, candidate + e)));
  let name = stem;
  for (let n = 2; taken(name); n += 1) name = `${stem}_${n}`;
  seenNames.add(path.join(dir, name).toLowerCase());
  return name;
}

// clips: [{ start, end, category, name? }]; category 'skip' writes nothing.
async function writeClips(input, clips, opts, manifest, seenNames) {
  const ext = path.extname(input) || '.mp4';
  const base = path.basename(input, ext).replace(/[^a-z0-9_-]+/gi, '_');
  const source = await getSource(input);
  const toWrite = clips.map((clip, i) => ({ ...clip, index: i + 1 })).filter((clip) => clip.category !== 'skip');

  console.log(`Splitting into ${opts.out} ...`);
  for (let i = 0; i < toWrite.length; i++) {
    const clip = toWrite[i];
    const duration = clip.end - clip.start;
    const cat = CATEGORIES.includes(clip.category) ? clip.category : classify(duration, opts);
    const dir = path.join(opts.out, cat);
    const stem = safeFileName(clip.name) || `${base}_clip_${String(clip.index).padStart(3, '0')}_${duration.toFixed(0)}s`;
    const name = freeBase(dir, stem, seenNames);
    // Only create the category folder that's actually about to be used.
    fs.mkdirSync(dir, { recursive: true });
    process.stdout.write(`  [${i + 1}/${toWrite.length}] ${cat}/${name} ... `);
    const written = await writeClip(input, clip, path.join(dir, name), ext, opts, source);
    console.log(`done (${written.method})`);
    manifest.push({
      sourceFile: path.basename(input),
      index: clip.index,
      file: `${cat}/${path.basename(written.file)}`,
      path: written.file,
      name: clip.name || null,
      start: clip.start,
      end: clip.end,
      duration,
      category: cat,
    });
  }
}

// ---------- Detect / review ----------

async function generateReviewSheet(input, cuts, duration, opts) {
  const base = path.basename(input, path.extname(input)).replace(/[^a-z0-9_-]+/gi, '_');
  const reviewDir = path.join(opts.reviewOut, base);
  fs.mkdirSync(reviewDir, { recursive: true });

  console.log(`Writing ${cuts.length} candidate thumbnail(s) to ${reviewDir} ...`);
  const candidates = [];
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    // The last frame of the clip before and the first of the clip after —
    // outside the gap, so a long black break doesn't give two black pictures.
    const before = Math.max(0, cut.from - 0.2);
    const after = Math.min(duration - 0.05, cut.to + 0.15);
    const beforeJpg = path.join(reviewDir, `_tmp_before_${i}.jpg`);
    const afterJpg = path.join(reviewDir, `_tmp_after_${i}.jpg`);
    const thumbName = `cut_${String(i + 1).padStart(3, '0')}.jpg`;
    const thumbPath = path.join(reviewDir, thumbName);

    await runFfmpeg(['-y', '-ss', before.toFixed(3), '-i', input, '-frames:v', '1', beforeJpg]);
    await runFfmpeg(['-y', '-ss', after.toFixed(3), '-i', input, '-frames:v', '1', afterJpg]);
    await runFfmpeg([
      '-y', '-i', beforeJpg, '-i', afterJpg,
      '-filter_complex', '[0:v]scale=240:180[a];[1:v]scale=240:180[b];[a][b]hstack',
      thumbPath,
    ]);
    // force: a grab past the last frame writes nothing, and one missing
    // thumbnail shouldn't fail the whole review.
    fs.rmSync(beforeJpg, { force: true });
    fs.rmSync(afterJpg, { force: true });

    candidates.push({ index: i + 1, time: cut.at, at: cut.at, from: cut.from, to: cut.to, kind: cut.kind, thumb: thumbName });
    console.log(`  [${i + 1}/${cuts.length}] ${thumbName}`);
  }

  const candidatesFile = path.join(reviewDir, 'candidates.json');
  fs.writeFileSync(candidatesFile, JSON.stringify({ sourceFile: path.resolve(input), duration, candidates }, null, 2));

  console.log(`\nWrote ${candidates.length} candidate cut(s) to ${reviewDir}`);
  console.log('Each cut_NNN.jpg shows the frame just before (left) and just after (right) that cut.');
  console.log('Skim them, note which indices are false positives, then split with:');
  console.log(`  node main/splicer/splice.js --split-candidates "${candidatesFile}" --exclude <comma-separated indices to drop> --out "${opts.out}"`);

  return { reviewDir, candidatesFile, candidates };
}

async function processFile(input, opts, manifest, seenNames) {
  console.log(`\n=== ${path.basename(input)} ===`);
  const source = await getSource(input);
  const { duration } = source;
  console.log(`Duration: ${fmtTime(duration)}`);

  const signals = await detectBoundaries(input, opts, duration);
  signals.logo = await detectLogoCuts(input, opts, duration);
  console.log(
    `Found ${signals.black.length} black-frame cut(s), ${signals.silence.length} silence cut(s), ` +
    `${signals.scene.length} scene-change cut(s)${signals.logo.length || opts.logoTimes.length || opts.logoImages.length ? `, ${signals.logo.length} logo-match cut(s)` : ''}.`
  );
  if (!opts.noScene && signals.black.length > 0 && signals.scene.length > signals.black.length * 15) {
    console.log(
      '  NOTE: scene-change cuts vastly outnumber black-frame cuts. This usually means the source has ' +
      'normal in-content shot cuts (e.g. an ordinary TV episode) that black-frame detection alone already ' +
      'finds cleanly — scene detection is likely just adding noise here. Consider re-running with --no-scene ' +
      '(and --no-silence if silence cuts are similarly disproportionate) and compare.'
    );
  }

  const cuts = mergeBoundaries(signals, duration, opts.minClip);
  const edges = edgeTrim(signals.black, duration);
  const segments = clipsFromCuts(cuts, duration, { trimGaps: !opts.keepGaps, edges })
    .map((seg, i) => ({ ...seg, index: i + 1, category: classify(seg.duration, opts) }));

  console.log(`${segments.length} segment(s) detected:\n`);
  segments.forEach((seg, i) => {
    console.log(`  [${String(i + 1).padStart(3, '0')}] ${fmtTime(seg.start)} -> ${fmtTime(seg.end)}  (${seg.duration.toFixed(1)}s)  -> ${seg.category}`);
  });

  const described = {
    sourceFile: path.basename(input), sourcePath: path.resolve(input), duration, fps: source.fps || null,
    edges, cuts: cuts.map((c, i) => ({ index: i + 1, ...c })), segments,
  };
  if (opts.review) {
    const result = await generateReviewSheet(input, cuts, duration, opts);
    return { mode: 'review', ...described, ...result };
  }
  if (opts.dryRun) return { mode: 'detect', ...described };

  await writeClips(input, segments, opts, manifest, seenNames);
  return { mode: 'split' };
}

// ---------- Plans ----------

function readPlan(file) {
  const plan = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const files = plan.files || [plan];
  files.forEach((f) => {
    if (!f.sourcePath || !fs.existsSync(f.sourcePath)) throw new Error(`Recording not found: ${f.sourcePath}`);
  });
  return files;
}

async function runPlan(argv, opts) {
  const files = readPlan(argv.plan);
  const manifest = [];
  const seenNames = new Set();
  const failures = [];
  for (const f of files) {
    console.log(`\n=== ${path.basename(f.sourcePath)} ===`);
    try {
      await writeClips(f.sourcePath, f.clips || [], opts, manifest, seenNames);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failures.push({ input: f.sourcePath, error: err.message });
    }
  }
  return finishSplit(manifest, failures, opts, files.length);
}

// Three small frames through each clip; clips alike at every one of them and
// about as long are the same thing aired twice.
async function runFindRepeats(argv) {
  const files = readPlan(argv['find-repeats']);
  const clips = [];
  files.forEach((f, fileIndex) => (f.clips || []).forEach((clip, clipIndex) => {
    if (clip.category !== 'skip') clips.push({ ...clip, duration: clip.end - clip.start, key: `${fileIndex}:${clipIndex}`, sourcePath: f.sourcePath });
  }));
  const signatures = [];
  console.log(`Comparing ${clips.length} clip(s)...`);
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    // Episodes don't repeat on one tape, and reading them costs the most.
    if (clip.category === 'episodes') { signatures.push(null); continue; }
    const frames = [];
    for (const at of [0.2, 0.5, 0.8]) {
      // eslint-disable-next-line no-await-in-loop
      try { frames.push(await grayFrame(['-ss', (clip.start + clip.duration * at).toFixed(3), '-i', clip.sourcePath], 16)); } catch (e) { /* unreadable */ }
    }
    signatures.push(frames.length === 3 ? frames : null);
    console.log(`  [${i + 1}/${clips.length}] ${path.basename(clip.sourcePath)} ${fmtTime(clip.start)}`);
  }
  const sameAs = findRepeats(clips, signatures);
  const repeats = {};
  Object.entries(sameAs).forEach(([i, j]) => { repeats[clips[i].key] = clips[j].key; });
  console.log(`\n${Object.keys(repeats).length} repeat(s) found.`);
  if (argv['json-out']) fs.writeFileSync(path.resolve(argv['json-out']), JSON.stringify({ mode: 'repeats', repeats }, null, 2));
}

async function runSplitCandidates(argv, opts) {
  const candidatesPath = path.resolve(argv['split-candidates']);
  if (!fs.existsSync(candidatesPath)) throw new Error(`candidates file not found: ${candidatesPath}`);
  const data = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
  const input = data.sourceFile;
  if (!fs.existsSync(input)) throw new Error(`Source file referenced by candidates.json not found: ${input}`);

  const exclude = argv.exclude ? String(argv.exclude).split(',').map((s) => parseInt(s.trim(), 10)) : [];
  const cuts = keptCandidateCuts(data.candidates, exclude);
  console.log(`Using ${cuts.length}/${data.candidates.length} candidate cut(s) (${data.candidates.length - cuts.length} excluded).`);
  const clips = clipsFromCuts(cuts, data.duration, { trimGaps: !opts.keepGaps });

  const manifest = [];
  const failures = [];
  try {
    await writeClips(input, clips, { ...opts, out: argv.out ? opts.out : path.join(path.dirname(input), 'output') }, manifest, new Set());
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    failures.push({ input, error: err.message });
  }
  return finishSplit(manifest, failures, opts, 1);
}

function finishSplit(manifest, failures, opts, fileCount) {
  if (manifest.length) {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`\nWrote ${manifest.length} clip(s) across ${fileCount - failures.length} file(s) and manifest.json to ${opts.out}`);
  }
  if (opts.jsonOut && (manifest.length || failures.length)) {
    fs.writeFileSync(opts.jsonOut, JSON.stringify({ mode: 'split', out: opts.out, manifest, failures }, null, 2));
  }
  if (failures.length) {
    console.log(`\n${failures.length} file(s) failed:`);
    failures.forEach((f) => console.log(`  ${f.input}: ${f.error}`));
    process.exitCode = 1;
  }
}

// ---------- Collecting inputs ----------

function collectInputs(argv) {
  if (argv.dir) {
    const dir = path.resolve(argv.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`--dir is not a valid directory: ${dir}`);
    }
    const exts = new Set(
      (argv.ext ? String(argv.ext).split(',') : DEFAULT_VIDEO_EXTS).map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    );
    const files = fs.readdirSync(dir)
      .filter((f) => exts.has(path.extname(f).slice(1).toLowerCase()))
      .map((f) => path.join(dir, f))
      .sort();
    return { files, defaultOutBase: dir };
  }
  if (argv._.length) {
    const files = argv._.map((f) => path.resolve(f));
    return { files, defaultOutBase: path.dirname(files[0]) };
  }
  return { files: [], defaultOutBase: null };
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help || argv.h) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    process.exit(0);
  }

  const splitOpts = (outBase) => ({
    out: argv.out ? path.resolve(argv.out) : path.join(outBase, 'output'),
    reencode: !!argv.reencode,
    fastCut: !!argv['fast-cut'],
    keepGaps: !!argv['keep-gaps'],
    bumperMax: parseFloat(argv['bumper-max'] ?? 20),
    commercialMax: parseFloat(argv['commercial-max'] ?? 120),
    jsonOut: argv['json-out'] ? path.resolve(argv['json-out']) : null,
  });

  if (argv['find-repeats']) return runFindRepeats(argv);
  if (argv.plan) return runPlan(argv, splitOpts(path.dirname(path.resolve(argv.plan))));
  if (argv['split-candidates']) return runSplitCandidates(argv, splitOpts(path.dirname(path.resolve(argv['split-candidates']))));

  const { files: inputs, defaultOutBase } = collectInputs(argv);
  if (!inputs.length) {
    console.error('No input files given. Pass one or more video files, or --dir <folder>. Use --help for usage.');
    process.exit(1);
  }
  const missing = inputs.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`Input file(s) not found:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }

  const base = splitOpts(defaultOutBase);
  const opts = {
    ...base,
    dryRun: !!argv['dry-run'],
    review: !!argv.review,
    reviewOut: argv['review-out'] ? path.resolve(argv['review-out']) : path.join(base.out, 'review'),
    minGap: parseFloat(argv['min-gap'] ?? 0.4),
    minClip: parseFloat(argv['min-clip'] ?? 2),
    blackThresh: parseFloat(argv['black-thresh'] ?? 0.10),
    silenceDb: parseFloat(argv['silence-db'] ?? -30),
    sceneThresh: parseFloat(argv['scene-thresh'] ?? 16),
    logoTimes: argv['logo-time'] ? String(argv['logo-time']).split(',').map(parseFloat) : [],
    logoImages: argv['logo-image'] ? String(argv['logo-image']).split(',').map((p) => path.resolve(p)) : [],
    logoThresh: parseFloat(argv['logo-thresh'] ?? 18),
    noBlack: !!argv['no-black'],
    noSilence: !!argv['no-silence'],
    noScene: !!argv['no-scene'],
  };

  console.log(`Processing ${inputs.length} file(s)${opts.dryRun ? ' (dry run)' : opts.review ? ' (review mode)' : ''}...`);

  const manifest = [];
  const seenNames = new Set();
  const failures = [];
  const perFileResults = [];
  for (const input of inputs) {
    try {
      const r = await processFile(input, opts, manifest, seenNames);
      if (r) perFileResults.push(r);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failures.push({ input, error: err.message });
    }
  }

  if (opts.review || opts.dryRun) {
    // Written once, after the whole batch, so every file's result reaches the
    // caller — not just the last one's.
    if (opts.jsonOut) {
      const mode = opts.review ? 'review' : 'detect';
      // The flat single-file shape only when nothing failed, so a sibling's
      // failure can't vanish.
      const json = perFileResults.length === 1 && failures.length === 0 ? perFileResults[0] : { mode, files: perFileResults, failures };
      fs.writeFileSync(opts.jsonOut, JSON.stringify(json, null, 2));
    }
    if (opts.dryRun) console.log('\nDry run — no files written. Drop --dry-run to actually split.');
    if (failures.length) {
      console.log(`\n${failures.length} file(s) failed:`);
      failures.forEach((f) => console.log(`  ${f.input}: ${f.error}`));
      process.exitCode = 1;
    }
    return;
  }
  finishSplit(manifest, failures, opts, inputs.length);
  if (manifest.length) console.log('Category assignment is a duration guess — skim and re-sort/rename before moving into your channel folders.');
}

// Exit explicitly: inside RerunTV the cancel listener (ffmpeg-runner.js)
// keeps the process alive after the work is done.
main().then(() => process.exit(process.exitCode || 0), (err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
