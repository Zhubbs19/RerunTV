// Frame-accurate clips at nearly stream-copy speed ("smart cut").
//
// A plain stream copy can only start a clip on a keyframe, so a clip starts
// up to a keyframe interval late (or, cut from 0 on some files, with no
// picture at all). Re-encoding the whole clip is exact but slow. This
// re-encodes only the head — from the cut to the first keyframe after it —
// and copies everything from that keyframe on:
//
//   video  = [start .. keyframe) re-encoded  +  [keyframe .. end) copied
//   audio  = [start .. end) copied (audio has no keyframe problem)
//
// The two video pieces are joined as MPEG-TS, where each piece carries its
// own stream parameters, then muxed with the audio into the clip's own
// container. The result is checked (it has a picture, decodes cleanly across
// the join, and is the right length); anything that fails the check is
// thrown away and the caller falls back to a whole-clip re-encode.
//
// H.264 sources only: that is what libx264 can splice into. Anything else
// gets a whole-clip re-encode when an exact start is wanted.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runFfmpeg } = require('./ffmpeg-runner');

// What a file is, from `ffmpeg -i`'s banner.
async function probe(file) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const video = /Stream #\d+:\d+[^\n]*Video:\s*(\w+)[^\n]*/.exec(stderr);
  const fps = video && /([\d.]+) fps/.exec(video[0]);
  const pixFmt = video && /Video:\s*\w+[^,]*,\s*(\w+)/.exec(video[0]);
  const audio = /Stream #\d+:\d+[^\n]*Audio:\s*(\w+)/.exec(stderr);
  return {
    duration: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : null,
    videoCodec: video ? video[1] : null,
    pixFmt: pixFmt ? pixFmt[1] : null,
    fps: fps ? parseFloat(fps[1]) : null,
    audioCodec: audio ? audio[1] : null,
    stderr,
  };
}

const keyframeCache = new Map();
// Keyframe times, seconds from the start of the file. Decodes keyframes only.
function keyframes(input) {
  if (!keyframeCache.has(input)) {
    keyframeCache.set(input, runFfmpeg(['-hide_banner', '-skip_frame', 'nokey', '-i', input, '-map', '0:v:0', '-an', '-sn', '-vf', 'showinfo', '-f', 'null', '-'])
      .then(({ stderr }) => [...stderr.matchAll(/pts_time:(-?[\d.]+)/g)].map((m) => parseFloat(m[1])).filter(Number.isFinite).sort((a, b) => a - b)));
  }
  return keyframeCache.get(input);
}

async function ok(args, what) {
  const { code, stderr } = await runFfmpeg(['-hide_banner', '-y', ...args]);
  if (code !== 0) throw new Error(`${what} failed (exit ${code}): ${stderr.slice(-300)}`);
}

// Decodes a few seconds around the join; any decoder error means the join
// isn't clean.
async function decodesCleanly(file, from, seconds) {
  const { code, stderr } = await runFfmpeg(['-hide_banner', '-v', 'error', '-ss', Math.max(0, from).toFixed(3), '-i', file, '-t', String(seconds), '-map', '0:v:0', '-f', 'null', '-']);
  return code === 0 && !stderr.trim();
}

// Writes [start, end) of input to outFile. Returns 'smart' | 'copy', or
// throws when only a re-encode will do (the caller's fallback).
async function smartCut(input, start, end, outFile, { source } = {}) {
  const info = source || await probe(input);
  if (info.videoCodec !== 'h264') throw new Error('not an H.264 source');
  const kfs = await keyframes(input);
  const k = kfs.find((t) => t >= start - 0.002);
  if (k === undefined || k >= end - 0.05) throw new Error('no keyframe inside this clip');

  const tmp = path.join(os.tmpdir(), `reruntv-smartcut-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  const head = path.join(tmp, 'head.ts');
  const tail = path.join(tmp, 'tail.ts');
  const list = path.join(tmp, 'list.txt');
  const video = path.join(tmp, 'video.ts');
  const audio = path.join(tmp, 'audio.mka');
  try {
    const headLength = k - start;
    const hasHead = headLength > 0.02;
    if (hasHead) {
      await ok(['-ss', start.toFixed(3), '-i', input, '-t', headLength.toFixed(3), '-map', '0:v:0', '-an', '-sn', '-dn',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', info.pixFmt || 'yuv420p',
        ...(info.fps ? ['-r', String(info.fps)] : []), '-f', 'mpegts', head], 'Re-encoding the start');
    }
    // A hair past the keyframe: an input seek on a copy snaps back to the
    // keyframe at or before the position, which is exactly this one.
    await ok(['-ss', (k + 0.0005).toFixed(4), '-i', input, '-t', (end - k).toFixed(3), '-map', '0:v:0', '-an', '-sn', '-dn',
      '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts', tail], 'Copying the rest');
    fs.writeFileSync(list, [hasHead ? head : null, tail].filter(Boolean).map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    await ok(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'mpegts', video], 'Joining the picture');

    const withAudio = !!info.audioCodec;
    if (withAudio) {
      // Output-side seek: audio packets are all sync points, so this lands
      // within one audio frame of the cut.
      await ok(['-i', input, '-ss', start.toFixed(3), '-to', end.toFixed(3), '-map', '0:a:0', '-vn', '-sn', '-dn', '-c', 'copy', audio], 'Copying the sound');
    }
    await ok(['-i', video, ...(withAudio ? ['-i', audio] : []), '-map', '0:v:0', ...(withAudio ? ['-map', '1:a:0'] : []),
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(/\.(mp4|m4v|mov)$/i.test(outFile) ? ['-movflags', '+faststart'] : []), outFile], 'Writing the clip');

    const out = await probe(outFile);
    const wanted = end - start;
    if (!out.videoCodec) throw new Error('the joined clip has no picture');
    if (out.duration === null || Math.abs(out.duration - wanted) > Math.max(0.5, wanted * 0.02)) {
      throw new Error(`the joined clip is ${out.duration}s, not ${wanted.toFixed(2)}s`);
    }
    if (hasHead && !await decodesCleanly(outFile, headLength - 1, 3)) throw new Error('the join does not decode cleanly');
    return hasHead ? 'smart' : 'copy';
  } catch (e) {
    fs.rmSync(outFile, { force: true });
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { probe, keyframes, smartCut };
