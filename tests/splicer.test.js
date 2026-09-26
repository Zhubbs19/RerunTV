// The Video Splicer (main/splicer/): the cut math splice.js runs on, the
// command lines the job runner builds from a page request, and the runner's
// event stream — with a fake process in place of Electron's utility process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const cuts = require('../main/splicer/cuts.js');
const { createSplicerService, jobArgs, validatePlan, progressOf } = require('../main/splicer/service.js');

const ats = (list) => list.map((c) => c.at);

test('a boundary two detectors both saw becomes one cut, strongest signal first', () => {
  // Black 9.5–10.5; silence at the same boundary and at 30–31; a scene cut at 50.
  const merged = cuts.mergeBoundaries({ black: [{ from: 9.5, to: 10.5 }], silence: [{ from: 30, to: 31 }, { from: 10, to: 11 }], scene: [50] }, 100, 2);
  assert.deepEqual(ats(merged), [10, 30.5, 50]);
  assert.deepEqual(merged.map((c) => c.kind), ['black', 'silence', 'scene']);
  assert.deepEqual([merged[0].from, merged[0].to], [9.5, 10.5]);
  // A logo cut claims its spot before a scene cut 1s away can.
  assert.deepEqual(cuts.mergeBoundaries({ scene: [41], logo: [40] }, 100, 2).map((c) => [c.at, c.kind]), [[40, 'logo']]);
});

test('cuts too close to each other or to either end are dropped', () => {
  assert.deepEqual(ats(cuts.mergeBoundaries({ scene: [1, 20, 21, 99] }, 100, 2)), [20]);
});

test('clips leave the black or silent gap out, and sort by length', () => {
  const list = [{ at: 15.5, from: 15, to: 16 }, { at: 75.5, from: 75, to: 76 }];
  const clips = cuts.clipsFromCuts(list, 1500);
  assert.deepEqual(clips.map((c) => [c.start, c.end]), [[0, 15], [16, 75], [76, 1500]]);
  const opts = { bumperMax: 20, commercialMax: 120 };
  assert.deepEqual(clips.map((c) => cuts.classify(c.duration, opts)), ['bumpers', 'commercials', 'episodes']);
  // --keep-gaps: clips meet in the middle of the gap, as before.
  assert.deepEqual(cuts.clipsFromCuts(list, 1500, { trimGaps: false }).map((c) => [c.start, c.end]), [[0, 15.5], [15.5, 75.5], [75.5, 1500]]);
  // Bare times (old candidates.json) are zero-length gaps.
  assert.deepEqual(cuts.clipsFromCuts([15], 30).map((c) => [c.start, c.end]), [[0, 15], [15, 30]]);
});

test('black at the very start or end of a recording is trimmed off', () => {
  const edges = cuts.edgeTrim([{ from: 0, to: 1.2 }, { from: 50, to: 51 }, { from: 98.5, to: 100 }], 100);
  assert.deepEqual(edges, { start: 1.2, end: 98.5 });
  assert.deepEqual(cuts.clipsFromCuts([{ at: 50.5, from: 50, to: 51 }], 100, { edges }).map((c) => [c.start, c.end]), [[1.2, 50], [51, 98.5]]);
  assert.deepEqual(cuts.edgeTrim([{ from: 0, to: 100 }], 100), { start: 0, end: 100 }, 'an all-black file is left alone');
});

test('logo runs shorter than the minimum are ignored', () => {
  assert.deepEqual(cuts.matchRuns([false, true, true, false, true, false, true, true, true], 2), [
    { startFrame: 1, endFrame: 2 }, { startFrame: 6, endFrame: 8 },
  ]);
});

test('a reviewed split keeps every candidate that was not dropped, in time order', () => {
  const candidates = [{ index: 1, time: 50 }, { index: 2, time: 10 }, { index: 3, time: 30 }];
  assert.deepEqual(ats(cuts.keptCandidateCuts(candidates, [3])), [10, 50]);
});

test('page requests become splice.js command lines', () => {
  assert.deepEqual(jobArgs({ kind: 'detect', input: 'C:\\tapes\\a.mp4', opts: { minClip: '60', noScene: true, reencode: false } }), {
    script: 'splice', args: ['C:\\tapes\\a.mp4', '--dry-run', '--min-clip', '60', '--no-scene'],
  });
  assert.deepEqual(jobArgs({ kind: 'review', folder: '/tapes', out: '/clips', opts: { logoTime: '9, 40.5' } }).args,
    ['--dir', '/tapes', '--review', '--logo-time', '9,40.5', '--out', '/clips']);
  assert.deepEqual(jobArgs({ kind: 'split', input: '/a.mkv' }).args, ['/a.mkv']);
  const plan = { files: [{ sourcePath: '/t/tape.mp4', clips: [{ start: 0, end: 8, category: 'bumpers', name: 'ID' }] }] };
  assert.deepEqual(jobArgs({ kind: 'splitPlan', plan, opts: { reencode: true, keepGaps: true, noScene: true, bumperMax: 15 } }, { planFile: '/tmp/p.json' }).args,
    ['--plan', '/tmp/p.json', '--out', path.join('/t', 'output'), '--reencode', '--keep-gaps', '--bumper-max', '15']);
  assert.deepEqual(jobArgs({ kind: 'findRepeats', plan }, { planFile: '/tmp/p.json' }).args, ['--find-repeats', '/tmp/p.json']);
  assert.deepEqual(jobArgs({ kind: 'split', input: '/a.mp4', opts: { fastCut: true } }).args, ['/a.mp4', '--fast-cut']);
  assert.deepEqual(jobArgs({ kind: 'combine', files: ['/1.mp4', '/2.mp4'], out: '/all.mp4', reencode: true }), {
    script: 'combine', args: ['/1.mp4', '/2.mp4', '--out', '/all.mp4', '--reencode'],
  });
});

test('a value can never turn into a flag of its own', () => {
  assert.throws(() => jobArgs({ kind: 'split', input: '--dry-run' }), /can't start with a dash/);
  assert.throws(() => jobArgs({ kind: 'split', input: '/a.mp4', opts: { minClip: '--review' } }), /must be a number/);
  assert.throws(() => jobArgs({ kind: 'split', input: '/a.mp4', opts: { logoTime: '9,--x' } }), /Logo times/);
  assert.throws(() => jobArgs({ kind: 'combine', files: ['/1.mp4', '-y'], out: '/o.mp4' }), /can't start with a dash/);
});

test('incomplete requests say what is missing', () => {
  assert.throws(() => jobArgs({ kind: 'split' }), /Choose a recording first/);
  assert.throws(() => jobArgs({ kind: 'combine', files: ['/1.mp4'], out: '/o.mp4' }), /at least two clips/);
  assert.throws(() => jobArgs({ kind: 'combine', files: ['/1.mp4', '/2.mp4'] }), /where to save/);
  assert.throws(() => jobArgs({ kind: 'split', input: '/a.mp4', opts: { noBlack: true, noSilence: true, noScene: true } }), /Every way of finding a cut/);
  assert.throws(() => jobArgs({ kind: 'erase' }), /Unknown splicer job/);
});

test('a plan keeps only checked values', () => {
  const checked = validatePlan({ files: [{ sourcePath: '/a.mp4', extra: 1, clips: [
    { start: '1', end: 9, category: 'bumpers', name: '  Station ID  ', junk: true },
    { start: 9, end: 60, category: 'nonsense' },
  ] }] });
  assert.deepEqual(checked, { files: [{ sourcePath: '/a.mp4', clips: [
    { start: 1, end: 9, category: 'bumpers', name: 'Station ID' }, { start: 9, end: 60, category: 'episodes' },
  ] }] });
  assert.throws(() => validatePlan({ files: [{ sourcePath: '/a.mp4', clips: [{ start: 5, end: 5 }] }] }), /isn’t a time/);
  assert.throws(() => validatePlan({ files: [] }), /no clips/);
  assert.throws(() => validatePlan({ files: [{ sourcePath: '--x', clips: [] }] }), /can't start with a dash/);
});

test('repeats are clips about as long and alike all the way through', () => {
  const frame = (v) => new Uint8Array(4).fill(v);
  const clips = [{ duration: 30 }, { duration: 30.4 }, { duration: 30 }, { duration: 60 }];
  const sigs = [[frame(10), frame(20)], [frame(12), frame(21)], [frame(200), frame(20)], [frame(10), frame(20)]];
  assert.deepEqual(cuts.findRepeats(clips, sigs), { 1: 0 });
});

test('clip names are what Windows accepts, and re-encodes land in a container that holds them', () => {
  assert.equal(cuts.safeFileName('Show: Pilot? <1>. '), 'Show Pilot 1');
  assert.equal(cuts.reencodeExt('.avi'), '.mp4');
  assert.equal(cuts.reencodeExt('.mkv'), '.mkv');
});

test('progress lines are the ones with [current/total]', () => {
  assert.deepEqual(progressOf('  [3/12] bumpers/a_clip_003_8s.mp4 ... done'), { current: 3, total: 12 });
  assert.equal(progressOf('Duration: 00:22:00.000'), null);
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.messages = [];
  child.postMessage = (m) => child.messages.push(m);
  child.kill = () => { child.killed = true; };
  return child;
}

// Ends the fake's output and exits it, then waits for the runner's done event.
async function exitWith(child, code, events) {
  if (!child.stdout.writableEnded) child.stdout.end();
  if (!child.stderr.writableEnded) child.stderr.end();
  child.emit('exit', code);
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'done'); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return events.find((e) => e.type === 'done');
}

function makeService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splicer-test-'));
  const events = [];
  const forks = [];
  const service = createSplicerService({
    dataDir: path.join(dir, 'video-splicer'),
    tmpDir: dir,
    getFfmpegPath: () => '/usr/bin/ffmpeg',
    fork: (modulePath, args, options) => { const child = fakeProcess(); forks.push({ modulePath, args, options, child }); return child; },
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { service, events, forks, dir };
}

test('a run streams its output and finishes with the script\'s JSON result', async () => {
  const { service, events, forks } = makeService();
  const { jobId } = await service.call('startJob', { kind: 'split', input: '/tape.mp4' });
  const { modulePath, args, options, child } = forks[0];
  assert.equal(path.basename(modulePath), 'splice.js');
  assert.equal(options.env.RERUNTV_FFMPEG_PATH, '/usr/bin/ffmpeg');
  const jsonOut = args[args.indexOf('--json-out') + 1];

  child.stdout.write('=== tape.mp4 ===\n  [1/2] bumpers/tape_clip_001_8s.mp4 ... done\n');
  child.stdout.end('  [2/2] episodes/tape_clip_002_600s.mp4 ... done');
  fs.writeFileSync(jsonOut, JSON.stringify({ mode: 'split', out: '/out', manifest: [{ category: 'bumpers' }, { category: 'episodes' }] }));
  const done = await exitWith(child, 0, events);

  assert.deepEqual(events.filter((e) => e.type === 'progress').map((e) => [e.current, e.total]), [[1, 2], [2, 2]]);
  assert.equal(done.jobId, jobId);
  assert.equal(done.error, null);
  assert.equal(done.result.manifest.length, 2);
});

test('runs queue and start one at a time; a waiting run can be cancelled', async () => {
  const { service, events, forks } = makeService();
  const first = await service.call('startJob', { kind: 'detect', input: '/a.mp4', label: 'Preview a.mp4' });
  const second = await service.call('startJob', { kind: 'split', input: '/b.mp4' });
  const third = await service.call('startJob', { kind: 'split', input: '/c.mp4' });
  assert.deepEqual([first.ahead, second.ahead, third.ahead], [0, 1, 2]);
  assert.equal(forks.length, 1, 'only the first has started');
  assert.deepEqual((await service.call('listJobs')).map((j) => j.state), ['running', 'waiting', 'waiting']);
  assert.equal((await service.call('listJobs'))[0].label, 'Preview a.mp4');

  await service.call('cancelJob', { jobId: second.jobId });
  assert.equal(events.find((e) => e.jobId === second.jobId && e.type === 'done').cancelled, true);
  forks[0].child.stdout.end();
  forks[0].child.stderr.end();
  forks[0].child.emit('exit', 0);
  for (let i = 0; i < 100 && forks.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); // eslint-disable-line no-await-in-loop
  assert.equal(forks.length, 2, 'the next waiting run starts when one ends');
  assert.equal(forks[1].args[0], '/c.mp4');
  assert.ok(events.some((e) => e.jobId === third.jobId && e.type === 'start'));
});

test('a run without ffmpeg says how to get it', async () => {
  const { service: bare } = makeService({ getFfmpegPath: () => null });
  await assert.rejects(bare.call('startJob', { kind: 'detect', input: '/a.mp4' }), /needs FFmpeg/);
});

test('a plan run writes the checked plan for the script, and removes it after', async () => {
  const { service, events, forks } = makeService();
  const plan = { files: [{ sourcePath: '/t/tape.mp4', clips: [{ start: 0, end: 8, category: 'bumpers', name: 'ID', extra: 1 }] }] };
  await service.call('startJob', { kind: 'splitPlan', plan, out: '/clips' });
  const planFile = forks[0].args[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(planFile, 'utf8')), { files: [{ sourcePath: '/t/tape.mp4', clips: [{ start: 0, end: 8, category: 'bumpers', name: 'ID' }] }] });
  await exitWith(forks[0].child, 0, events);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(planFile), false);
});

test('a typed path is checked on the host', async () => {
  const { service, dir } = makeService();
  fs.writeFileSync(path.join(dir, 'tape.mp4'), '');
  assert.deepEqual(await service.call('pathKind', { path: dir }), { kind: 'folder' });
  assert.deepEqual(await service.call('pathKind', { path: path.join(dir, 'tape.mp4') }), { kind: 'file' });
  assert.deepEqual(await service.call('pathKind', { path: path.join(dir, 'nope') }), { kind: 'missing' });
});

test('cancel asks the script to stop its ffmpeg, and the run ends as cancelled', async () => {
  const { service, events, forks } = makeService();
  const { jobId } = await service.call('startJob', { kind: 'review', input: '/a.mp4' });
  assert.deepEqual(await service.call('cancelJob', { jobId }), { cancelled: true });
  assert.deepEqual(forks[0].child.messages, ['cancel']);
  const done = await exitWith(forks[0].child, 130, events);
  assert.equal(done.cancelled, true);
  assert.equal(done.error, 'Cancelled.');
});

test('a failed run reports the script\'s own error line', async () => {
  const { service, events, forks } = makeService();
  await service.call('startJob', { kind: 'split', input: '/missing.mp4' });
  forks[0].child.stderr.end('Input file(s) not found:\n  /missing.mp4\n');
  const done = await exitWith(forks[0].child, 1, events);
  assert.match(done.error, /not found/);
});

test('settings keep only the splicer\'s own keys, in its own folder', async () => {
  const { service, dir } = makeService();
  await service.call('saveSettings', { defaultOutDir: '/clips', preset: 'dvd', somethingElse: 1 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'video-splicer', 'settings.json'), 'utf8'));
  assert.deepEqual(saved, { defaultOutDir: '/clips', preset: 'dvd' });
  assert.deepEqual(await service.call('getSettings'), saved);
});

test('adding a folder to combine lists its videos in natural filename order', async () => {
  const { service, dir } = makeService();
  const clips = path.join(dir, 'clips');
  fs.mkdirSync(clips);
  ['clip_10.mp4', 'clip_2.mp4', 'notes.txt', 'clip_1.MKV'].forEach((name) => fs.writeFileSync(path.join(clips, name), ''));
  const listed = await service.call('listVideos', { dir: clips });
  assert.deepEqual(listed.map((p) => path.basename(p)), ['clip_1.MKV', 'clip_2.mp4', 'clip_10.mp4']);
});

test('only the listed methods can be called', async () => {
  const { service } = makeService();
  await assert.rejects(service.call('constructor', {}), /Unknown splicer method/);
});

// ---------- The SPLICER page's editor model (renderer/js/library/splice-plan.js) ----------

// Values made inside the vm context have that context's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadPlanModule() {
  const vm = require('node:vm');
  const file = path.join(__dirname, '..', 'renderer', 'js', 'library', 'splice-plan.js');
  const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file, context: vm.createContext({}) });
  await mod.link(() => { throw new Error('splice-plan.js must not import anything'); });
  await mod.evaluate();
  return mod.namespace;
}

test('the editor cuts clips exactly as splice.js does', async () => {
  const plan = await loadPlanModule();
  const cases = [
    [[{ at: 15.5, from: 15, to: 16 }, { at: 75.5, from: 75, to: 76 }], 1500, {}],
    [[{ at: 15.5, from: 15, to: 16 }], 100, { trimGaps: false }],
    [[{ at: 50.5, from: 50, to: 51 }], 100, { edges: { start: 1.2, end: 98.5 } }],
    [[{ at: 20 }, { at: 40 }], 60, {}],
  ];
  const strip = (clips) => plain(clips).map((c) => [c.start, c.end]);
  for (const [list, duration, opts] of cases) {
    assert.deepEqual(strip(plan.clipsFromCuts(list, duration, opts)), strip(cuts.clipsFromCuts(list, duration, opts)));
  }
});

test('editing cuts: nudge within bounds, add, remove, merge, and names that survive a nudge', async () => {
  const plan = await loadPlanModule();
  const model = plan.createModel({
    sourcePath: '/t/tape.mp4', sourceFile: 'tape.mp4', duration: 100, fps: 25,
    cuts: [{ index: 1, at: 20.5, from: 20, to: 21, kind: 'black' }, { index: 2, at: 60.5, from: 60, to: 61, kind: 'black' }],
    candidates: [{ index: 1, thumbPath: '/r/cut_001.jpg' }],
  });
  let clips = plain(plan.clipsOf(model));
  assert.deepEqual(clips.map((c) => [c.start, c.end, c.category]), [[0, 20, 'bumpers'], [21, 60, 'commercials'], [61, 100, 'commercials']]);
  assert.equal(model.cuts[0].thumbPath, '/r/cut_001.jpg');

  plan.setClipMeta(model, clips[1].key, { name: 'Soda ad' });
  plan.moveCut(model, model.cuts[0].id, 2);
  clips = plain(plan.clipsOf(model));
  assert.deepEqual([clips[1].start, clips[1].name], [23, 'Soda ad'], 'a nudged cut keeps its clip’s name');
  assert.ok(Math.abs(plan.moveCut(model, model.cuts[0].id, 1000) - 59.3) < 1e-9, 'a cut stops short of the next one');

  assert.equal(plan.addCut(model, 59.5), null, 'no second cut inside another');
  const added = plan.addCut(model, 80);
  assert.equal(plan.clipsOf(model).length, 4);
  plan.setKept(model, added.id, false);
  assert.equal(model.cuts.some((c) => c.id === added.id), false, 'a hand-added cut that is removed is gone');

  plan.mergeWithNext(model, plan.clipsOf(model)[1]);
  assert.equal(plan.clipsOf(model).length, 2);
  plan.setKept(model, model.cuts[1].id, true);
  assert.equal(plan.clipsOf(model).length, 3, 'a detected cut can be restored');
});

test('episodes are numbered in order, and the plan is what splice.js --plan takes', async () => {
  const plan = await loadPlanModule();
  const model = plan.createModel({ sourcePath: '/t/tape.mp4', duration: 1000, cuts: [{ at: 300 }, { at: 330 }, { at: 700 }] });
  plan.setClipMeta(model, plan.clipsOf(model)[1].key, { category: 'skip' });
  const clips = plan.clipsOf(model);
  const names = plain(plan.episodeNames(clips, 'Doug', { season: 2, episode: 5 }));
  Object.entries(names).forEach(([key, name]) => plan.setClipMeta(model, key, { name }));
  const built = plain(plan.planFor([model]));
  assert.deepEqual(built.files[0].clips.map((c) => [c.start, c.end, c.category, c.name || null]), [
    [0, 300, 'episodes', 'Doug - S02E05'],
    [300, 330, 'skip', null],
    [330, 700, 'episodes', 'Doug - S02E06'],
    [700, 1000, 'episodes', 'Doug - S02E07'],
  ]);
  assert.deepEqual(validatePlan(built), built, 'the service accepts the plan unchanged');
});
