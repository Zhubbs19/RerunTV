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
const { findBreakMarks, parseBlackLines, parseSilenceLines, parseDuration } = require('../main/media/breakdetect.js');

const MIN = 60000;

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
    commercials,
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
