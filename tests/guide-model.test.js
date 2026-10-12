// guide-model.js — the guide's row order, number-based selection and
// selected-row scrolling (docs/design/11 §2.1–2.2).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'guide/model.js')).href);

const channels = [2, 5, 7.1, 12, 40].map((number) => ({ number, name: `Chan ${number}` }));
const specials = [
  { number: 910, name: 'Digital Music', nowText: '12 stations' },
  { number: 0, name: 'Search & Play', nowText: '' },
  { number: 6, name: 'Party', nowText: '' },
];

test('specials sit in numeric order among channels by default', async () => {
  const { guideRows } = await load();
  const rows = guideRows(channels, specials);
  assert.deepEqual(rows.map((r) => r.number), [0, 2, 5, 6, 7.1, 12, 40, 910]);
  assert.equal(rows[0].kind, 'special');
  assert.equal(rows[1].kind, 'channel');
  assert.equal(rows[1].ch, channels[0]);
});

test('specials at the top keeps them first, still as rows', async () => {
  const { guideRows } = await load();
  const rows = guideRows(channels, specials, { specialsAtTop: true });
  assert.deepEqual(rows.map((r) => r.number), [0, 6, 910, 2, 5, 7.1, 12, 40]);
});

test('the filter query applies to specials by name or number', async () => {
  const { guideRows } = await load();
  assert.deepEqual(guideRows([], specials, { query: 'music' }).map((r) => r.number), [910]);
  assert.deepEqual(guideRows([], specials, { query: '6' }).map((r) => r.number), [6]);
  assert.deepEqual(guideRows([], specials, { query: 'zzz' }), []);
});

test('selection is by number and falls back to the first row', async () => {
  const { guideRows, selectedIndex, moveSelection } = await load();
  const rows = guideRows(channels, specials);
  assert.equal(selectedIndex(rows, 12), 5);
  assert.equal(selectedIndex(rows, 99), 0);
  assert.equal(selectedIndex([], 12), -1);
  assert.equal(moveSelection(rows, 5, 1), 6); // onto a special
  assert.equal(moveSelection(rows, 910, 1), 0); // wraps
  assert.equal(moveSelection(rows, 0, -1), 910);
  assert.equal(moveSelection(rows, 2, -4, { wrap: false }), 0); // a page stops at the end
  assert.equal(moveSelection(rows, 12, 10, { wrap: false }), 910);
  assert.equal(moveSelection([], 12, 1), null);
});

function fixedRows(n, height = 52, gap = 3) {
  return Array.from({ length: n }, (_, i) => ({ top: i * (height + gap), height }));
}

function fullyVisible(row, top, viewportH) {
  return row.top >= top && row.top + row.height <= top + viewportH;
}

test('docked scrolling keeps the selected row whole with a row of margin', async () => {
  const { rowScrollTop } = await load();
  const rows = fixedRows(30);
  const viewportH = 5 * 55;
  let top = 0;
  for (let sel = 0; sel < rows.length; sel++) {
    top = rowScrollTop({ rows, selIdx: sel, viewportH, scrollTop: top });
    assert.ok(fullyVisible(rows[sel], top, viewportH), `row ${sel} visible going down`);
    if (sel + 1 < rows.length) assert.ok(fullyVisible(rows[sel + 1], top, viewportH), `margin below ${sel}`);
    assert.ok(!rows.some((r) => r.top < top && r.top + r.height > top), 'no row cut at the top edge');
  }
  for (let sel = rows.length - 1; sel >= 0; sel--) {
    top = rowScrollTop({ rows, selIdx: sel, viewportH, scrollTop: top });
    assert.ok(fullyVisible(rows[sel], top, viewportH), `row ${sel} visible going up`);
    if (sel > 0) assert.ok(fullyVisible(rows[sel - 1], top, viewportH), `margin above ${sel}`);
  }
});

test('docked scrolling does not move when the row and margins already fit', async () => {
  const { rowScrollTop } = await load();
  const rows = fixedRows(30);
  assert.equal(rowScrollTop({ rows, selIdx: 3, viewportH: 275, scrollTop: 55 }), 55);
});

test('uneven row heights and a viewport too short for margins still show the row', async () => {
  const { rowScrollTop } = await load();
  const rows = [];
  let y = 0;
  [52, 80, 52, 120, 52, 52, 90, 52].forEach((h) => { rows.push({ top: y, height: h }); y += h + 3; });
  for (const viewportH of [130, 200, 400]) {
    let top = 0;
    for (let sel = 0; sel < rows.length; sel++) {
      top = rowScrollTop({ rows, selIdx: sel, viewportH, scrollTop: top });
      assert.ok(fullyVisible(rows[sel], top, viewportH), `row ${sel} at viewport ${viewportH}`);
    }
    for (let sel = rows.length - 1; sel >= 0; sel--) {
      top = rowScrollTop({ rows, selIdx: sel, viewportH, scrollTop: top });
      assert.ok(fullyVisible(rows[sel], top, viewportH), `row ${sel} up at viewport ${viewportH}`);
    }
  }
});

test('full page centres the selected row, clamped at the ends', async () => {
  const { rowScrollTop } = await load();
  const rows = fixedRows(30);
  const viewportH = 550;
  const contentH = 30 * 55;
  assert.equal(rowScrollTop({ rows, selIdx: 0, viewportH, contentH, mode: 'full' }), 0);
  const mid = rowScrollTop({ rows, selIdx: 15, viewportH, contentH, mode: 'full' });
  assert.equal(mid, Math.round(rows[15].top + 26 - 275));
  assert.equal(rowScrollTop({ rows, selIdx: 29, viewportH, contentH, mode: 'full' }), contentH - viewportH);
});

const MIN = 60000;
function lineup(durationsMin, start = 0) {
  let t = start;
  return durationsMin.map((d, i) => { const e = { file: { path: `f${i}` }, start: t, end: t + d * MIN }; t += d * MIN; return e; });
}

test('runs of short entries merge into one cell; long shows stay', async () => {
  const { mergeMicroPrograms } = await load();
  const cells = mergeMicroPrograms(lineup([30, 2, 3, 1, 2, 22, 4, 30]), 5 * MIN);
  assert.deepEqual(cells.map((c) => c.kind), ['program', 'run', 'program', 'program', 'program']);
  assert.equal(cells[1].items.length, 4);
  assert.equal(cells[1].start, 30 * MIN);
  assert.equal(cells[1].end, 38 * MIN);
  assert.equal(cells[3].entry.end - cells[3].entry.start, 4 * MIN, 'a lone short stays a program');
});

test('merged cells cover the schedule exactly, in order', async () => {
  const { mergeMicroPrograms } = await load();
  const entries = lineup([1, 1, 1, 45, 2, 2, 60, 3, 3, 3, 3]);
  const cells = mergeMicroPrograms(entries, 5 * MIN);
  const flat = cells.flatMap((c) => (c.kind === 'run' ? c.items : [c.entry]));
  assert.deepEqual(flat, entries);
  for (let i = 1; i < cells.length; i++) assert.equal(cells[i].start, cells[i - 1].end);
});

test('a gap between shorts splits the run, and minMs 0 merges nothing', async () => {
  const { mergeMicroPrograms, cellIndexAt } = await load();
  const entries = lineup([2, 2]);
  const later = lineup([2, 2], 10 * MIN);
  const cells = mergeMicroPrograms([...entries, ...later], 5 * MIN);
  assert.deepEqual(cells.map((c) => c.kind), ['run', 'run']);
  assert.equal(mergeMicroPrograms(entries, 0).length, 2);
  assert.deepEqual(mergeMicroPrograms([], 5 * MIN), []);
  assert.equal(cellIndexAt(cells, 11 * MIN), 1);
  assert.equal(cellIndexAt(cells, 5 * MIN), -1);
});

test('call letters abbreviate channel names like a period guide', async () => {
  const { abbreviateChannelName: ab, channelCallLetters } = await load();
  assert.equal(ab('The Movie Channel'), 'TMC');
  assert.equal(ab('Space Opera Channel'), 'SOC');
  assert.equal(ab('WV Sports Channel'), 'WVSC');
  assert.equal(ab('The Wizard School Network'), 'WSN');
  assert.equal(ab('Gadget Network'), 'GN');
  assert.equal(ab('Giggle'), 'GIGGLE');
  assert.equal(ab('Retrovision'), 'RTRVSN');
  assert.equal(ab('Rewind'), 'REWIND');
  assert.equal(ab('The Workplace Channel'), 'TWC');
  assert.equal(ab(''), '');
  assert.ok(ab('Christmas Movies Channel').length <= 6);
  assert.equal(channelCallLetters({ name: 'Retrovision', callLetters: ' kidz ' }), 'KIDZ');
  assert.equal(channelCallLetters({ name: 'Retrovision', callLetters: '' }), 'RTRVSN');
  assert.equal(channelCallLetters({ name: 'x', callLetters: 'TOOLONGNAME' }), 'TOOLON');
});
