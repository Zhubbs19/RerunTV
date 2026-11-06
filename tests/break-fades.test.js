// Mid-show breaks lined up with the fades to black a file was found to have
// (interstitials.js midSlots, file.breakMarks from main/media/breakdetect.js).
// The resolver, the next-break search and the guide's break list must agree
// on the moved positions, the same way break-enumeration.test.js checks them
// for raw cadences.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);
const { createBreakDetectService, creditsTailStart, findBreakMarks, findCreditsStart, parseBlackLines, parseSilenceLines, parseDuration } = require('../main/media/breakdetect.js');

async function modules() {
  return { state: await load('core/state.js'), interstitials: await load('core/interstitials.js') };
}

// A 1316-second cartoon with strong fades at 6:23, 10:45 and 15:53, a
// weaker one at 13:04, and the title card at 1:02.
const MARKS = [
  { at: 61.8, strength: 0.93 }, { at: 383.1, strength: 1 }, { at: 644.6, strength: 1 },
  { at: 784.1, strength: 0.6 }, { at: 953.3, strength: 1 },
];

function setup(state, commercials, marks = MARKS) {
  state.S.config = {
    // Fade snapping (midSlots) is shared by both break models; these check it on
    // the raw program-position cadence the overlay model shows directly.
    commercials: { pauseForBreaks: false, ...commercials },
    interstitials: { pool: [{ id: 'ad', type: 'commercial', channelAffinity: 'any', file: { path: 'ad.mp4', duration: 30 } }], presets: [], flows: [] },
  };
  state.bumpConfigGeneration();
  const anchor = new Date(2026, 9, 5, 9, 0, 0, 0).getTime();
  return {
    anchor,
    ch: { number: 9, name: 'FADES', anchor, adsEnabled: true, blocks: [], files: [{ path: 'show.mp4', duration: 1316, breakMarks: marks }] },
  };
}

function starts(interstitials, ch, from, to) {
  return interstitials.breakEntriesInWindow(ch, from, to).map((e) => Math.round((e.start - from) / 100) / 10);
}

test('fades: the nearest strong fade wins, order is kept, a crowded slot is dropped', async () => {
  const { interstitials } = await modules();
  const marks = [{ atMs: 100000, strength: 0.2 }, { atMs: 130000, strength: 1 }, { atMs: 400000, strength: 1 }];
  assert.deepEqual(interstitials.snapOffsetsToFades([120000, 390000, 600000], marks, 60000), [130000, 400000, 600000]);
  assert.deepEqual(interstitials.snapOffsetsToFades([100000, 140000], [{ atMs: 130000, strength: 1 }], 60000), [130000, null], 'two slots never share a fade');
  assert.deepEqual(interstitials.snapOffsetsToFades([300000], marks, 60000), [300000], 'nothing in reach leaves the slot alone');
});

test('% breakpoints move to the fades, and every reader agrees', async () => {
  const { state, interstitials } = await modules();
  const { anchor, ch } = setup(state, { timing: 'breakpoints', breakpoints: [25, 50, 75], podMin: 1, podMax: 1, snapToFades: true, snapWindowMinutes: 3 });
  assert.deepEqual(starts(interstitials, ch, anchor, anchor + 1316000), [383.1, 644.6, 953.3]);
  // Every second a break is on screen lies in a listed entry, and the
  // next-break search lands on the same instants.
  const listed = interstitials.breakEntriesInWindow(ch, anchor, anchor + 1316000);
  for (let t = anchor; t < anchor + 1316000; t += 1000) {
    const brk = interstitials.resolveBreakAt(ch, t);
    if (brk) assert.ok(listed.some((e) => t >= e.start && t < e.end), `break at +${(t - anchor) / 1000}s is listed`);
  }
  assert.equal(interstitials.nextBreakStart(ch, anchor + 1000) - anchor, 383100);
  assert.equal(interstitials.nextBreakStart(ch, anchor + 383100 + 31000) - anchor, 644600);
});

test('with the switch off, or no marks, breaks stay on the raw cadence', async () => {
  const { state, interstitials } = await modules();
  let { anchor, ch } = setup(state, { timing: 'breakpoints', breakpoints: [25, 50, 75], podMin: 1, podMax: 1 });
  assert.deepEqual(starts(interstitials, ch, anchor, anchor + 1316000), [329, 658, 987]);
  ({ anchor, ch } = setup(state, { timing: 'breakpoints', breakpoints: [25, 50, 75], podMin: 1, podMax: 1, snapToFades: true }, []));
  assert.deepEqual(starts(interstitials, ch, anchor, anchor + 1316000), [329, 658, 987]);
});

test('every-N-minutes slots move too; one with no fade in reach stays put', async () => {
  const { state, interstitials } = await modules();
  const { anchor, ch } = setup(state, { timing: 'everyNMinutes', intervalMinutes: 7, podMin: 1, podMax: 1, snapToFades: true, snapWindowMinutes: 3 });
  // Raw 7:00, 14:00, 21:00 -> 6:23, 13:04 (10:45 is out of reach of 14:00), 21:00.
  assert.deepEqual(starts(interstitials, ch, anchor, anchor + 1316000), [383.1, 784.1, 1260]);
  assert.equal(interstitials.nextBreakStart(ch, anchor + 400000) - anchor, 784100);
});

test('a stretched slot maps marks proportionally (fit to time slots)', async () => {
  const { interstitials, state } = await modules();
  setup(state, { snapToFades: true, snapWindowMinutes: 3 });
  const bs = { fileStartMs: 0, fileEndMs: 1316000 * 1.1 };
  const slots = interstitials.midSlots(bs, { duration: 1316, breakMarks: MARKS }, { percents: [50] });
  assert.equal(Math.round(slots[0].startMs), Math.round(644600 * 1.1));
});

test('a film’s last 8% is credits, not act breaks', () => {
  const black = [{ start: 4000, end: 4002 }, { start: 5200, end: 5202 }];
  const marks = findBreakMarks({ black, silence: [], duration: 5512 });
  assert.deepEqual(marks.map((m) => m.at), [4001], 'a fade 5 minutes from the end of a 92-minute film is in the credits');
});

test('detector output becomes scored marks, edges and blips dropped', () => {
  const stderr = [
    '[Parsed_blackdetect_1 @ 0] black_start:0.04 black_end:2.79 black_duration:2.75',
    '[Parsed_blackdetect_1 @ 0] black_start:382.13 black_end:384.17 black_duration:2.04',
    '[silencedetect @ 0] silence_start: 382.05',
    '[silencedetect @ 0] silence_end: 383.57 | silence_duration: 1.52',
    '[Parsed_blackdetect_1 @ 0] black_start:388.0 black_end:388.3 black_duration:0.3',
    '[Parsed_blackdetect_1 @ 0] black_start:699.86 black_end:700.03 black_duration:0.17',
    '[Parsed_blackdetect_1 @ 0] black_start:900.0 black_end:900.02 black_duration:0.02',
    '[Parsed_blackdetect_1 @ 0] black_start:1290.0 black_end:1292.0 black_duration:2',
  ].join('\n');
  assert.equal(parseDuration('  Duration: 00:21:55.86, start: 0.000000'), 1315.86);
  const marks = findBreakMarks({ black: parseBlackLines(stderr), silence: parseSilenceLines(stderr), duration: 1315.86 });
  assert.deepEqual(marks, [{ at: 383.1, strength: 1 }, { at: 699.9, strength: 0.07 }],
    'the opening and the credits are edges, a fade 4 s later is the same transition, a 20 ms blip is a cut');
});

// Two frames a second over a 92-minute film's last 15 minutes. `credits(t)`
// says which seconds look like credits on black; everything else is picture.
function tail(duration, credits) {
  const tailStart = creditsTailStart(duration);
  const frames = [];
  for (let t = tailStart; t < duration; t += 0.5) frames.push(credits(t) ? { t, ylow: 16, yavg: 30 } : { t, ylow: 40, yavg: 110 });
  return { frames, duration, tailStart };
}

test('credits: the last dense run on black that reaches the end', () => {
  const film = 5541;
  assert.equal(creditsTailStart(film), film - 900);
  assert.equal(creditsTailStart(1320), 1320 - 240, 'an episode reads its last four minutes');
  // Credits from 85:34 to 91:49, a closing logo, then black.
  const found = findCreditsStart(tail(film, (t) => (t >= 5134.5 && t < 5509) || t >= 5539));
  assert.deepEqual(found, { at: 5134.5, leadS: 407, density: 1 });
  // A card on picture for ten seconds mid-credits doesn't split them.
  assert.equal(findCreditsStart(tail(film, (t) => t >= 5134.5 && !(t >= 5300 && t < 5310))).at, 5134.5);
});

test('credits: nothing believable gives null', () => {
  const film = 5541;
  assert.equal(findCreditsStart(tail(film, () => false)), null, 'no black at all');
  assert.equal(findCreditsStart(tail(film, (t) => t >= film - 12)), null, 'twelve seconds of black is a fade out, not credits');
  assert.equal(findCreditsStart(tail(film, (t) => t >= 5000 && t < 5200)), null, 'a dark scene ending minutes before the end');
  assert.equal(findCreditsStart(tail(film, () => true)), null, 'black from the start of the read: the credits could be longer than it');
  assert.equal(findCreditsStart(tail(film, (t) => t >= 5134.5 && Math.floor(t) % 2 === 0)), null, 'every other second is too patchy to be credits');
});

test('credits: a file whose fades are cached only gets the credits pass', async () => {
  const calls = [];
  const stat = { size: 10, mtimeMs: 5, isFile: () => true };
  const svc = createBreakDetectService({
    dir: null,
    getFfmpegPath: () => 'ffmpeg',
    fsImpl: { readFileSync: () => { throw new Error('none'); }, promises: { stat: async () => stat } },
    run: async () => { calls.push('fades'); return { duration: 5541, black: [], silence: [] }; },
    runCredits: async (ff, p, startS) => { calls.push(`credits@${startS}`); return tail(5541, (t) => t >= 5134.5).frames; },
  });
  const first = await svc.detect('C:/films/a.mp4');
  assert.equal(first.credits.at, 5134.5);
  assert.deepEqual(calls, ['fades', 'credits@4641']);
  await svc.detect('C:/films/a.mp4');
  assert.equal(calls.length, 2, 'both results are cached');
});

test('the credits speedup uses a found credits start unless the switch is off', async () => {
  const { foundCreditsLead } = await load('core/util.js');
  const film = { path: 'a', duration: 5541, creditsFound: { at: 5134.5, leadS: 407, density: 1 } };
  assert.equal(foundCreditsLead(film, { commercials: {} }), 407, 'on by default');
  assert.equal(foundCreditsLead(film, { commercials: { useFoundCredits: false } }), null);
  assert.equal(foundCreditsLead({ path: 'b', creditsFound: null }, {}), null, 'looked, found none');
  assert.equal(foundCreditsLead({ path: 'c' }, {}), null);
});

test('FIND FADES picks files missing fades or credits, on breaking or credits-speedup channels', async () => {
  const marks = await load('library/break-marks.js');
  const files = [
    { path: 'C:/a.mp4' },
    { path: 'C:/b.mp4', breakMarks: [] },
    { path: 'C:/c.mp4', breakMarks: [], creditsFound: null },
    { path: 'mediasource:x:1' },
  ];
  assert.deepEqual(marks.filesNeedingMarks([{ files }]).map((f) => f.path), ['C:/a.mp4', 'C:/b.mp4'], 'b was read before credits were looked for');
  assert.equal(marks.speedsUpCredits({ creditsSpeedup: { enabled: true } }), true);
  assert.equal(marks.speedsUpCredits({ creditsSpeedup: { enabled: false } }), false);
  assert.equal(marks.speedsUpCredits({}), false);
});
