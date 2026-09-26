#!/usr/bin/env node
'use strict';

/**
 * Logo/template-match detector — a diagnostic for splice.js's --logo-thresh.
 *
 * Instead of measuring frame-to-frame difference (which is what both the
 * ffmpeg scdet and PySceneDetect AdaptiveDetector approaches do, and both
 * hit the same wall on fast-motion CG bumper content), this compares every
 * sampled frame directly against a reference image of a known recurring
 * asset (e.g. a channel's logo bumper card) and reports where it appears.
 * Runs of "logo present" frames mark segment boundaries, since internal
 * motion within unrelated content can't accidentally look like a fixed
 * template the way it can look like "a cut happened".
 *
 * Usage:
 *   node main/splicer/logo-detect.js <input-video> --logo-time <sec>[,<sec>...] [options]
 *   node main/splicer/logo-detect.js <input-video> --logo-image <ref.jpg>[,<ref2.jpg>...] [options]
 *
 * Multiple references (comma-separated) are supported for channels/packages
 * that use several logo card variants (different colors/backgrounds) — each
 * frame is scored against every reference and the closest match wins.
 *
 * Options:
 *   --logo-time <sec[,sec...]>    Timestamp(s) in the input to grab as reference frames
 *   --logo-image <path[,path...]> Path(s) to existing reference image(s) instead
 *   --fps <n>            Sample rate for scanning the video (default: 5)
 *   --thumb <n>           Grayscale thumbnail size, NxN (default: 32)
 *   --thresh <0-255>     Max mean-abs-diff to count as a logo match (default: 18)
 *   --min-run <sec>      Minimum contiguous match duration to count as a real hit (default: 0.3)
 */

const path = require('path');
const { runFfmpegCollectStdout } = require('./ffmpeg-runner');
const { parseArgs, fmtTime, meanAbsDiff, matchRuns } = require('./cuts');

async function getOneReferenceVector({ input, logoTime, logoImage }, thumb) {
  const args = logoImage
    ? ['-i', logoImage, '-frames:v', '1', '-vf', `scale=${thumb}:${thumb}:force_original_aspect_ratio=disable,format=gray`, '-f', 'rawvideo', '-']
    : ['-ss', String(logoTime), '-i', input, '-frames:v', '1', '-vf', `scale=${thumb}:${thumb}:force_original_aspect_ratio=disable,format=gray`, '-f', 'rawvideo', '-'];
  const buf = await runFfmpegCollectStdout(args);
  if (buf.length < thumb * thumb) throw new Error(`Failed to extract reference frame from ${logoImage || logoTime}.`);
  return Uint8Array.from(buf.subarray(0, thumb * thumb));
}

async function getReferenceVectors(opts, thumb) {
  const refs = [];
  if (opts.logoImages.length) {
    for (const img of opts.logoImages) refs.push(await getOneReferenceVector({ logoImage: img }, thumb));
  }
  if (opts.logoTimes.length) {
    for (const t of opts.logoTimes) refs.push(await getOneReferenceVector({ input: opts.input, logoTime: t }, thumb));
  }
  return refs;
}

async function getFrameStream(input, fps, thumb) {
  const args = ['-i', input, '-vf', `fps=${fps},scale=${thumb}:${thumb}:force_original_aspect_ratio=disable,format=gray`, '-f', 'rawvideo', '-'];
  const buf = await runFfmpegCollectStdout(args);
  const frameSize = thumb * thumb;
  const count = Math.floor(buf.length / frameSize);
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push(Uint8Array.from(buf.subarray(i * frameSize, (i + 1) * frameSize)));
  }
  return frames;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const input = argv._[0];
  if (!input || (!argv['logo-time'] && !argv['logo-image'])) {
    console.log('Usage: node main/splicer/logo-detect.js <input> --logo-time <sec> | --logo-image <path> [options]');
    process.exit(1);
  }

  const opts = {
    input: path.resolve(input),
    logoTimes: argv['logo-time'] ? String(argv['logo-time']).split(',').map(parseFloat) : [],
    logoImages: argv['logo-image'] ? String(argv['logo-image']).split(',').map((p) => path.resolve(p)) : [],
    fps: parseFloat(argv.fps ?? 5),
    thumb: parseInt(argv.thumb ?? 32, 10),
    thresh: parseFloat(argv.thresh ?? 18),
    minRun: parseFloat(argv['min-run'] ?? 0.3),
  };

  console.log('Extracting reference logo frame(s)...');
  const refs = await getReferenceVectors(opts, opts.thumb);
  console.log(`Using ${refs.length} reference template(s).`);

  console.log(`Scanning video at ${opts.fps}fps (this reads through the whole file)...`);
  const frames = await getFrameStream(opts.input, opts.fps, opts.thumb);
  console.log(`Sampled ${frames.length} frames.`);

  const scores = frames.map((f) => Math.min(...refs.map((ref) => meanAbsDiff(f, ref))));

  // Print score distribution summary so a threshold can be sanity-checked.
  const sorted = [...scores].sort((a, b) => a - b);
  console.log(
    `Score range: min=${sorted[0].toFixed(1)} p10=${sorted[Math.floor(sorted.length * 0.1)].toFixed(1)} ` +
    `median=${sorted[Math.floor(sorted.length * 0.5)].toFixed(1)} p90=${sorted[Math.floor(sorted.length * 0.9)].toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`
  );

  const isMatch = scores.map((s) => s <= opts.thresh);
  const minRunFrames = Math.max(1, Math.round(opts.minRun * opts.fps));

  const runs = matchRuns(isMatch, minRunFrames).map((run) => ({
    ...run, start: run.startFrame / opts.fps, end: (run.endFrame + 1) / opts.fps,
  }));

  console.log(`\n${runs.length} logo occurrence(s) detected (thresh=${opts.thresh}, min-run=${opts.minRun}s):\n`);
  runs.forEach((r, i) => {
    console.log(`  [${String(i + 1).padStart(2, '0')}] ${fmtTime(r.start)} -> ${fmtTime(r.end)}  (${(r.end - r.start).toFixed(1)}s)`);
  });
}

// Exit explicitly: inside RerunTV the cancel listener (ffmpeg-runner.js)
// keeps the process alive after the work is done.
main().then(() => process.exit(process.exitCode || 0), (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
