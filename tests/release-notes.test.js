const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCE, parseChangelog, newEntries, releaseNotesMarkdown, changelogMarkdown } = require('../scripts/release-notes.js');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test("What's New parses into dated entries, newest first", () => {
  const entries = parseChangelog(read(SOURCE));
  assert.ok(entries.length > 0);
  const dates = entries.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'entries are listed newest first');
  for (const entry of entries) assert.ok(entry.items.length, `${entry.date} has at least one item`);
});

test("CHANGELOG.md matches What's New (regenerate with node scripts/release-notes.js --changelog)", () => {
  const expected = changelogMarkdown(parseChangelog(read(SOURCE)));
  assert.equal(read('CHANGELOG.md').replace(/\r\n/g, '\n'), expected);
});

test('a release lists only the items added since the previous release', () => {
  const previous = [{ date: '2026-01-01', items: ['Old thing.'] }];
  const current = [
    { date: '2026-01-05', items: ['New thing.', 'Another new thing.'] },
    { date: '2026-01-01', items: ['Old thing.', 'Added to an older date.'] },
  ];
  assert.deepEqual(newEntries(current, previous), [
    { date: '2026-01-05', items: ['New thing.', 'Another new thing.'] },
    { date: '2026-01-01', items: ['Added to an older date.'] },
  ]);
  const notes = releaseNotesMarkdown(newEntries(current, previous));
  assert.match(notes, /^## What's new\n\n### 2026-01-05\n\n- New thing\.\n- Another new thing\.\n/);
  assert.doesNotMatch(notes, /Old thing/);
});

test('a release with no new items still says what it is', () => {
  const notes = releaseNotesMarkdown([]);
  assert.match(notes, /dependency updates and maintenance only/);
});

test('a CHANGELOG list that is not plain dated data is refused', () => {
  assert.throws(() => parseChangelog('const CHANGELOG = [\n  { date: "soon", items: ["x"] },\n];'), /YYYY-MM-DD/);
  assert.throws(() => parseChangelog('const OTHER = [];'), /No CHANGELOG list/);
});
