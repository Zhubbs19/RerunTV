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
const { runFfmpeg, runFfmpegWithProgress, runFfmpegCollectStdout } = require('./ffmpeg-runner');
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
  const audioLine = (stderr.match(/Audio:[^\n]*/) || [''])[0];
  const rateMatch = audioLine.match(/(\d+)\s*Hz/);
  const layoutMatch = audioLine.match(/Hz,\s*([^,]+),/);
  return {
    duration,
    fps: fpsMatch ? parseFloat(fpsMatch[1]) : null,
    videoCodec: videoMatch ? videoMatch[1] : null,
    width: videoMatch ? parseInt(videoMatch[2], 10) : null,
    height: videoMatch ? parseInt(videoMatch[3], 10) : null,
    audioCodec: audioMatch ? audioMatch[1] : null,
    audioRate: rateMatch ? parseInt(rateMatch[1], 10) : null,
    audioLayout: layoutMatch ? layoutMatch[1].trim() : null,
    hasAudio: !!audioMatch,
  };
}

// What differs between the clips, by name, or [] when stream-copy is safe.
function mismatches(probes) {
  const first = probes[0];
  return ['videoCodec', 'width', 'height', 'fps', 'hasAudio', 'audioCodec', 'audioRate', 'audioLayout'].filter((key) => probes.some((p) => p[key] !== first[key]));
}

// ---------- Encoders ----------

let encoderNames = null;
async function hasEncoder(name) {
  if (!encoderNames) {
    try {
      const out = (await runFfmpegCollectStdout(['-hide_banner', '-encoders'])).toString();
      encoderNames = new Set(out.split('\n').map((line) => (line.match(/^\s[VAS][.\w]{5}\s+(\S+)/) || [])[1]).filter(Boolean));
    } catch (e) {
      encoderNames = new Set();
    }
  }
  return encoderNames.has(name);
}

// An encoder that is listed can still fail (no NVIDIA card), so try it once.
const workingEncoders = new Map();
async function canEncode(name) {
  if (!workingEncoders.has(name)) {
    let ok = false;
    if (await hasEncoder(name)) {
      const { code } = await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', name, '-f', 'null', '-']);
      ok = code === 0;
    }
    workingEncoders.set(name, ok);
  }
  return workingEncoders.get(name);
}

// Video encode arguments for a codec name as ffmpeg reports it, or null when
// this ffmpeg can't write that codec.
async function videoEncoderFor(codec) {
  if (codec === 'h264') {
    if (await canEncode('h264_nvenc')) return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0'];
    if (await hasEncoder('libx264')) return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
  } else if (codec === 'hevc') {
    if (await canEncode('hevc_nvenc')) return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '24', '-b:v', '0'];
    if (await hasEncoder('libx265')) return ['-c:v', 'libx265', '-preset', 'veryfast', '-crf', '22'];
  } else if (codec === 'vp9') {
    if (await hasEncoder('libvpx-vp9')) return ['-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1'];
  } else if (codec === 'av1') {
    if (await hasEncoder('libsvtav1')) return ['-c:v', 'libsvtav1', '-crf', '30', '-preset', '8'];
    if (await canEncode('av1_nvenc')) return ['-c:v', 'av1_nvenc', '-preset', 'p5', '-cq', '32', '-b:v', '0'];
  }
  return null;
}

async function audioEncoderFor(codec) {
  const names = { aac: 'aac', opus: 'libopus', mp3: 'libmp3lame', vorbis: 'libvorbis', ac3: 'ac3' };
  return names[codec] && await hasEncoder(names[codec]) ? ['-c:a', names[codec], ...(codec === 'opus' ? ['-b:a', '128k'] : [])] : null;
}

const AUDIO_CHANNELS = { mono: 1, stereo: 2 };

// ---------- Matching odd clips to the rest ----------

const signature = (p) => [p.videoCodec, p.width, p.height, p.fps === null ? '' : p.fps.toFixed(2), p.hasAudio, p.audioCodec, p.audioRate, p.audioLayout].join('|');

// Rough encode cost per second of footage, so the cheaper plan wins: VP9 on
// the CPU runs about as slow as the footage plays, an NVIDIA encoder many
// times faster.
const ENCODER_COST = { h264_nvenc: 0.1, hevc_nvenc: 0.1, av1_nvenc: 0.1, libx264: 0.3, libsvtav1: 0.5, libx265: 0.8, 'libvpx-vp9': 1.2 };

// Plans a join that converts as little as possible. Two candidates: convert the
// clips that differ to the most common format (so the rest are copied), or
// convert every clip that isn't already H.264 in that shape. Whichever costs
// less encoding time wins. Returns null when neither can be done safely (audio
// in only some clips, or no encoder this ffmpeg has).
async function planConversion(probes) {
  if (probes.some((p) => !p.videoCodec || p.hasAudio !== probes[0].hasAudio)) return null;
  const counts = new Map();
  probes.forEach((p) => counts.set(signature(p), (counts.get(signature(p)) || 0) + 1));
  let bestKey = null;
  counts.forEach((n, key) => { if (bestKey === null || n > counts.get(bestKey)) bestKey = key; });
  const common = probes.find((p) => signature(p) === bestKey);
  const hasAudio = common.hasAudio;

  const targets = [common];
  if (common.videoCodec !== 'h264') {
    targets.push({ ...common, videoCodec: 'h264', ...(hasAudio ? { audioCodec: 'aac', audioRate: 48000, audioLayout: 'stereo' } : {}) });
  }

  const plans = [];
  for (const target of targets) {
    const video = await videoEncoderFor(target.videoCodec);
    if (!video) continue;
    let audio = [];
    if (hasAudio) {
      audio = await audioEncoderFor(target.audioCodec);
      if (!audio || !AUDIO_CHANNELS[target.audioLayout] || !target.audioRate) continue;
    }
    const odd = probes.map((p, i) => (signature(p) === signature(target) ? -1 : i)).filter((i) => i >= 0);
    const cost = odd.reduce((sum, i) => sum + (probes[i].duration || 1), 0) * (ENCODER_COST[video[1]] || 1);
    plans.push({ target, odd, video, audio, cost });
  }
  plans.sort((a, b) => a.cost - b.cost);
  return plans[0] || null;
}

async function convertClip(input, outFile, plan, duration, onPercent) {
  const { target } = plan;
  const width = target.width & ~1;
  const height = target.height & ~1;
  const fps = target.fps && target.fps > 1 && target.fps < 121 ? target.fps : 30;
  const args = ['-y', '-i', input, '-map', '0:v:0'];
  if (target.hasAudio) args.push('-map', '0:a:0');
  args.push('-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`);
  args.push(...plan.video);
  if (target.hasAudio) args.push('-af', `aresample=${target.audioRate}`, '-ac', String(AUDIO_CHANNELS[target.audioLayout]), ...plan.audio);
  args.push('-strict', '-2', outFile);
  const { code, stderr } = await runFfmpegWithProgress(args, duration, onPercent);
  if (code !== 0) throw new Error(`converting ${path.basename(input)} failed:\n${stderr.slice(-800)}`);
}

// Converts the odd clips into a temp folder, then joins everything by copy.
async function combineConverted(inputs, outFile, probes, plan) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-combine-'));
  try {
    const total = plan.odd.reduce((sum, i) => sum + (probes[i].duration || 1), 0);
    let done = 0;
    const joined = inputs.slice();
    for (const [n, i] of plan.odd.entries()) {
      console.log(`Converting ${path.basename(inputs[i])} to match the rest (${n + 1} of ${plan.odd.length})...`);
      const converted = path.join(tmpDir, `clip${i}.mp4`);
      const span = probes[i].duration || 1;
      await convertClip(inputs[i], converted, plan, probes[i].duration, (pct) => console.log(`Converting [${Math.min(100, Math.round(((done + span * pct / 100) / total) * 100))}/100]`));
      done += span;
      joined[i] = converted;
    }
    console.log('Joining...');
    await combineStreamCopy(joined, outFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
async function combineReencode(inputs, outFile, hasAudio, target = {}, totalDuration = null) {
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
  args.push(...(await videoEncoderFor('h264')), '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'aac');
  args.push('-y', outFile);
  // The page reads "[n/100]" as progress; a long encode otherwise looks hung.
  console.log('Re-encoding — this takes a while for long clips.');
  const { code, stderr } = await runFfmpegWithProgress(args, totalDuration, (pct) => console.log(`Re-encoding [${pct}/100]`));
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
  const differences = mismatches(probes);
  const compatible = differences.length === 0;
  const totalDuration = probes.every((p) => p.duration) ? probes.reduce((sum, p) => sum + p.duration, 0) : null;
  const forceReencode = !!argv.reencode;
  let converted = 0;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const hasAudio = probes.every((p) => p.hasAudio);
  const reencodeAll = async () => {
    await combineReencode(inputs, outFile, hasAudio, probes[0], totalDuration);
    return 'reencode';
  };
  let method;

  if (forceReencode) {
    console.log('Re-encoding every clip (--reencode)...');
    method = await reencodeAll();
  } else if (compatible) {
    console.log('Inputs are compatible — using fast stream-copy concat...');
    try {
      await combineStreamCopy(inputs, outFile);
      method = 'copy';
    } catch (err) {
      console.log(`Stream-copy concat failed (${err.message.split('\n')[0]}), falling back to re-encode...`);
      method = await reencodeAll();
    }
  } else {
    console.log(`Inputs differ in ${differences.join(', ')} — stream-copy alone would produce a broken file.`);
    const plan = await planConversion(probes);
    if (plan) {
      console.log(`Converting ${plan.odd.length} of ${inputs.length} clips to ${plan.target.videoCodec}${plan.target.width ? ` ${plan.target.width}x${plan.target.height}` : ''}; the other ${inputs.length - plan.odd.length} are copied as they are.`);
      try {
        await combineConverted(inputs, outFile, probes, plan);
        method = 'convert';
        converted = plan.odd.length;
      } catch (err) {
        console.log(`Matching the odd clips failed (${err.message.split('\n')[0]}), re-encoding everything instead...`);
      }
    } else {
      console.log('These clips can\'t be matched one by one (mixed audio, or no encoder for their format), so re-encoding everything.');
    }
    if (!method) method = await reencodeAll();
  }

  const outDuration = await probeStream(outFile);
  console.log(`\nWrote ${outFile}${outDuration.duration ? ` (${outDuration.duration.toFixed(1)}s)` : ''}`);

  if (argv['json-out']) {
    fs.writeFileSync(path.resolve(argv['json-out']), JSON.stringify({
      out: outFile, duration: outDuration.duration, inputs, method, converted,
    }, null, 2));
  }
}

// Exit explicitly: inside RerunTV the cancel listener (ffmpeg-runner.js)
// keeps the process alive after the work is done.
main().then(() => process.exit(process.exitCode || 0), (err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
