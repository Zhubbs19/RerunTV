#!/usr/bin/env node
// Builds a small, fully synthetic demo library so RerunTV can be tried (or
// screenshotted) without anyone's real media: five channels of generated test
// video, each a few clips with a distinct picture and tone. Nothing here is
// copyrighted: every frame and sound comes from ffmpeg's built-in generators.
//
//   node scripts/make-demo-library.js <outDir> [--config <userDataDir>] [--ffmpeg <path>] [--seconds <n>]
//
// <outDir>             where the clips are written (created if missing)
// --config <userData>  also write a ready-made channels.json there, pointing at the
//                      clips, anchored to "now" so every channel is mid-show. Refuses
//                      to overwrite an existing channels.json.
// --ffmpeg <path>      ffmpeg binary (default: `ffmpeg` on PATH)
// --seconds <n>        length of each clip (default 480; shorter clips are quicker to make)
//
// Needs ffmpeg with the lavfi generators (any normal build).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE_SECONDS = 30;
let CLIP_SECONDS = 480; // long enough that the guide shows real titles, not "shorts & bumpers" runs

// Each channel: a generator, and clip titles. Tone frequency varies per clip.
const LINEUP = [
  { number: 3, name: 'Cartoon Corner', gen: 'testsrc2=size=480x270:rate=12',
    clips: ['S01E01 - The Big Idea', 'S01E02 - Rainy Day Rescue', 'S01E03 - Robot Birthday'] },
  { number: 5, name: 'Retro Movies', gen: 'mandelbrot=size=480x270:rate=12',
    clips: ['The Long Zoom (1987)', 'Fractal Heights (1992)', 'Midnight Mandelbrot (1979)'] },
  { number: 7, name: 'Nature Loop', gen: 'gradients=size=480x270:rate=12:speed=0.03',
    clips: ['Aurora Study', 'Slow Sunset', 'Tide Colors'] },
  { number: 9, name: 'Sci-Fi Theater', gen: 'life=size=480x270:rate=12:mold=12:ratio=0.08:life_color=#59f2a0:death_color=#103020',
    clips: ['Colony Collapse', 'Signal From Nowhere', 'The Automaton Garden'] },
  { number: 11, name: 'Music Hour', gen: 'cellauto=size=480x270:rate=12:random_fill_ratio=0.4:scroll=1',
    clips: ['Synth Sunrise', 'Neon Highway', 'Cassette Dreams'] },
];

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--ffmpeg') out.ffmpeg = argv[++i];
    else if (argv[i] === '--seconds') out.seconds = Number(argv[++i]);
    else out.positional.push(argv[i]);
  }
  return out;
}

function run(ffmpeg, args, label) {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`could not run ${ffmpeg}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${label}: ${(r.stderr || '').trim().split(/\r?\n/).pop()}`);
}

// Encodes a short base clip, then repeats it with a stream copy up to the full length: fast,
// and small because the generated pictures compress very well.
function makeClip(ffmpeg, gen, hz, file) {
  const baseSeconds = Math.min(CLIP_SECONDS, BASE_SECONDS);
  const base = CLIP_SECONDS > baseSeconds ? `${file}.base.mp4` : file;
  run(ffmpeg, [
    '-f', 'lavfi', '-i', gen,
    '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100`,
    '-t', String(baseSeconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '48k', '-shortest', base,
  ], path.basename(file));
  if (base !== file) {
    run(ffmpeg, ['-stream_loop', '-1', '-i', base, '-t', String(CLIP_SECONDS), '-c', 'copy', file], path.basename(file));
    fs.unlinkSync(base);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.positional[0];
  if (!outDir) {
    console.error('usage: node scripts/make-demo-library.js <outDir> [--config <userDataDir>] [--ffmpeg <path>] [--seconds <n>]');
    process.exit(2);
  }
  const ffmpeg = args.ffmpeg || 'ffmpeg';
  if (Number.isFinite(args.seconds) && args.seconds >= 5) CLIP_SECONDS = args.seconds;
  const root = path.resolve(outDir);
  const channels = [];
  const now = Date.now();

  LINEUP.forEach((lineup) => {
    const dir = path.join(root, lineup.name);
    fs.mkdirSync(dir, { recursive: true });
    const files = lineup.clips.map((title, i) => {
      const file = path.join(dir, `${lineup.name} - ${title}.mp4`);
      if (!fs.existsSync(file)) {
        process.stdout.write(`  ${path.relative(root, file)}\n`);
        makeClip(ffmpeg, lineup.gen, 220 + (lineup.number * 37) + i * 55, file);
      }
      return { path: file, duration: CLIP_SECONDS, folder: dir, source: 'local' };
    });
    channels.push({
      number: lineup.number, name: lineup.name, files,
      folders: [{ id: `src_demo_${lineup.number}`, source: 'local', ref: dir, label: null }],
      // Anchored in the past so each channel starts mid-way through its loop.
      anchor: now - (lineup.number * 97 * 1000),
      shuffle: false, icon: null, adsEnabled: false, contentTags: [], favorite: lineup.number === 3,
      rating: null, vhsQuality: false, logoBugProfiles: null, volume: null, quickAccess: false,
      dynamicOverlays: null, tickerLayout: null, tickerContent: null,
      broadcastHours: { enabled: false, startHour: 6, endHour: 0 },
    });
  });

  if (args.config) {
    const userData = path.resolve(args.config);
    const target = path.join(userData, 'channels.json');
    if (fs.existsSync(target)) {
      console.error(`\n${target} already exists; not overwriting it. Point --config at an empty folder.`);
      process.exit(1);
    }
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ channels, lastChannel: 3, timeMachine: { enabled: true } }, null, 2));
    console.log(`\nWrote ${target}`);
  }
  console.log(`\nDemo library ready in ${root}`);
  if (!args.config) console.log('In RerunTV: Channel Setup → + ADD CHANNEL, then add each folder above to a channel.');
}

main();
