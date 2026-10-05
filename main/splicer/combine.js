#!/usr/bin/env node
'use strict';

/**
 * Video Combiner — companion to splice.js (setup › LIBRARY › SPLICER's
 * COMBINE CLIPS runs this through service.js).
 *
 * Joins multiple video files (or clips split out by splice.js) back into
 * one file, in order. Uses ffmpeg's concat demuxer for a fast stream-copy
 * join when the inputs share compatible codecs/params, and falls back to
 * the concat filter (re-encoding) automatically when they don't.
 *
 * Usage (from the repo root, `node main/splicer/combine.js ...`):
 *   node combine.js <file1> <file2> <file3> ... --out <output.mp4>
 *   node combine.js --dir <folder> --out <output.mp4>      (all videos in the folder, sorted by name)
 *   node combine.js --list <order.txt> --out <output.mp4>  (explicit order, one path per line, # comments ok)
 *
 * Options:
 *   --out <file>       Output file (required)
 *   --dir <folder>     Combine every video file in this folder, sorted by filename
 *   --list <path>      Text file listing input paths in the desired order (one per line)
 *   --ext <list>       Comma-separated extensions to match in --dir mode (default: mp4,mkv,mov,avi,ts,m4v,wmv)
 *   --reencode         Force re-encode via the concat filter instead of stream-copy
 *   --dry-run          Print the resolved input order and exit without combining
 *   --json-out <path>  Also write a structured JSON result to this path (for scripting/UI use)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { runFfmpeg } = require('./ffmpeg-runner');
const { DEFAULT_VIDEO_EXTS, parseArgs } = require('./cuts');

function collectInputs(argv) {
  if (argv.list) {
    const listPath = path.resolve(argv.list);
    if (!fs.existsSync(listPath)) throw new Error(`--list file not found: ${listPath}`);
    const lines = fs.readFileSync(listPath, 'utf8').split(/\r?\n/);
    const baseDir = path.dirname(listPath);
    return lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => (path.isAbsolute(l) ? l : path.resolve(baseDir, l)));
  }
  if (argv.dir) {
    const dir = path.resolve(argv.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`--dir is not a valid directory: ${dir}`);
    }
    const exts = new Set(
      (argv.ext ? String(argv.ext).split(',') : DEFAULT_VIDEO_EXTS).map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    );
    return fs.readdirSync(dir)
      .filter((f) => exts.has(path.extname(f).slice(1).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map((f) => path.join(dir, f));
  }
  if (argv._.length) {
    return argv._.map((f) => path.resolve(f));
  }
  return [];
}

async function probeStream(input) {
  const { stderr } = await runFfmpeg(['-i', input]);
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durMatch ? (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + (+durMatch[3]) : null;
  const videoMatch = stderr.match(/Video:\s*(\w+).*?(\d{2,5})x(\d{2,5})/);
  const audioMatch = stderr.match(/Audio:\s*(\w+)/);
  const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps/);
  return {
    duration,
    fps: fpsMatch ? parseFloat(fpsMatch[1]) : null,
    videoCodec: videoMatch ? videoMatch[1] : null,
    width: videoMatch ? parseInt(videoMatch[2], 10) : null,
    height: videoMatch ? parseInt(videoMatch[3], 10) : null,
    audioCodec: audioMatch ? audioMatch[1] : null,
    hasAudio: !!audioMatch,
  };
}

function checkCompatible(probes) {
  const first = probes[0];
  return probes.every((p) =>
    p.videoCodec === first.videoCodec &&
    p.width === first.width &&
    p.height === first.height &&
    p.hasAudio === first.hasAudio &&
    p.audioCodec === first.audioCodec
  );
}

async function combineStreamCopy(inputs, outFile) {
  const listPath = path.join(os.tmpdir(), `combine_${Date.now()}.txt`);
  const listContent = inputs
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, listContent);
  try {
    const { code, stderr } = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outFile]);
    if (code !== 0) throw new Error(`stream-copy concat failed:\n${stderr.slice(-800)}`);
  } finally {
    fs.unlinkSync(listPath);
  }
}

// The concat filter needs every input to match, so each clip is first scaled
// (letterboxed, never stretched) to the first clip's size and frame rate, and
// its audio brought to one sample rate and layout.
async function combineReencode(inputs, outFile, hasAudio, target = {}) {
  const width = (target.width || 1280) & ~1;
  const height = (target.height || 720) & ~1;
  const fps = target.fps && target.fps > 1 && target.fps < 121 ? target.fps : 30;
  const args = [];
  inputs.forEach((f) => { args.push('-i', f); });
  const prep = inputs.map((_, i) => {
    const video = `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`;
    const audio = hasAudio ? `;[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]` : '';
    return video + audio;
  });
  const streamPairs = inputs.map((_, i) => hasAudio ? `[v${i}][a${i}]` : `[v${i}]`).join('');
  const filter = `${prep.join(';')};${streamPairs}concat=n=${inputs.length}:v=1:a=${hasAudio ? 1 : 0}[outv]${hasAudio ? '[outa]' : ''}`;
  args.push('-filter_complex', filter, '-map', '[outv]');
  if (hasAudio) args.push('-map', '[outa]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'aac');
  args.push('-y', outFile);
  const { code, stderr } = await runFfmpeg(args);
  if (code !== 0) throw new Error(`concat filter re-encode failed:
${stderr.slice(-800)}`);
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help || argv.h) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    process.exit(0);
  }

  const inputs = collectInputs(argv);
  if (!inputs.length) {
    console.error('No input files given. Pass file paths, --dir <folder>, or --list <order.txt>. Use --help for usage.');
    process.exit(1);
  }
  if (!argv.out) {
    console.error('--out <file> is required.');
    process.exit(1);
  }
  const missing = inputs.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`Input file(s) not found:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  if (inputs.length < 2) {
    console.error('Need at least 2 input files to combine.');
    process.exit(1);
  }

  const outFile = path.resolve(argv.out);

  console.log(`Combining ${inputs.length} file(s) in this order:`);
  inputs.forEach((f, i) => console.log(`  [${i + 1}] ${path.basename(f)}`));

  if (argv['dry-run']) {
    console.log('\nDry run — nothing combined. Drop --dry-run to actually combine.');
    return;
  }

  console.log('\nProbing inputs for codec/format compatibility...');
  const probes = await Promise.all(inputs.map(probeStream));
  const compatible = checkCompatible(probes);
  const forceReencode = !!argv.reencode;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  if (!forceReencode && compatible) {
    console.log('Inputs are compatible — using fast stream-copy concat...');
    try {
      await combineStreamCopy(inputs, outFile);
    } catch (err) {
      console.log(`Stream-copy concat failed (${err.message.split('\n')[0]}), falling back to re-encode...`);
      await combineReencode(inputs, outFile, probes.every((p) => p.hasAudio), probes[0]);
    }
  } else {
    if (!forceReencode) {
      console.log(
        'Inputs have mismatched codec/resolution/audio — stream-copy concat would likely produce a broken ' +
        'file, so re-encoding instead (slower, but safe). Pass --reencode next time to skip this check.'
      );
    } else {
      console.log('Re-encoding (--reencode) via the concat filter...');
    }
    await combineReencode(inputs, outFile, probes.every((p) => p.hasAudio), probes[0]);
  }

  const outDuration = await probeStream(outFile);
  console.log(`\nWrote ${outFile}${outDuration.duration ? ` (${outDuration.duration.toFixed(1)}s)` : ''}`);

  if (argv['json-out']) {
    fs.writeFileSync(path.resolve(argv['json-out']), JSON.stringify({
      out: outFile, duration: outDuration.duration, inputs, method: (!forceReencode && compatible) ? 'copy' : 'reencode',
    }, null, 2));
  }
}

// Exit explicitly: inside RerunTV the cancel listener (ffmpeg-runner.js)
// keeps the process alive after the work is done.
main().then(() => process.exit(process.exitCode || 0), (err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
