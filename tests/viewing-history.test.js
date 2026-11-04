// The box-wide viewing log in rerun.db (main/diagnostics/history.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { closeAll } = require('../main/util/db');
const { createViewingHistory, HISTORY_FILE } = require('../main/diagnostics/history');
const { createPersonalService } = require('../main/personal/service');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-history-'));
  t.after(() => {
    closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const row = (n, extra = {}) => ({ at: 1000 + n, viewAt: 900 + n, channelNumber: n % 3, channelName: `CH ${n % 3}`, title: `Show ${n}`, path: `C:/media/${n}.mkv`, durationS: 1800, ...extra });

test('appends are listed newest first and survive a reopen', (t) => {
  const dir = tempDir(t);
  const history = createViewingHistory({ dir });
  for (let n = 1; n <= 5; n += 1) assert.deepEqual(history.append(row(n)), { ok: true, deduped: false });
  assert.deepEqual(history.list(2).map((e) => e.title), ['Show 5', 'Show 4']);
  closeAll();
  const reopened = createViewingHistory({ dir });
  assert.equal(reopened.count(), 5);
  assert.deepEqual(reopened.list(1)[0], row(5));
  assert.deepEqual(reopened.all().map((e) => e.title), ['Show 1', 'Show 2', 'Show 3', 'Show 4', 'Show 5']);
});

test('a re-report of the same channel and file is collapsed, including across a reopen', (t) => {
  const dir = tempDir(t);
  const history = createViewingHistory({ dir });
  history.append(row(1));
  assert.equal(history.append(row(1, { at: 5000 })).deduped, true);
  closeAll();
  assert.equal(createViewingHistory({ dir }).append(row(1, { at: 6000 })).deduped, true);
});

test('entries are sanitized', (t) => {
  const history = createViewingHistory({ dir: tempDir(t) });
  history.append({ at: 'yesterday', channelNumber: '7', title: 'x'.repeat(500), path: 42, durationS: -5 });
  const [entry] = history.list();
  assert.equal(entry.channelNumber, null);
  assert.equal(entry.title.length, 200);
  assert.equal(entry.path, '');
  assert.equal(entry.durationS, 0);
  assert.ok(Number.isFinite(entry.at));
});

test('the log is capped oldest first, and the default listing stays at 2000', (t) => {
  const dir = tempDir(t);
  // Appends enforce the cap on a short debounce; an import enforces it at once.
  fs.writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify({ entries: Array.from({ length: 3000 }, (_, i) => row(i + 1)) }));
  const history = createViewingHistory({ dir, maxEntries: 2500 });
  assert.equal(history.count(), 2500);
  assert.equal(history.all()[0].title, 'Show 501', 'the oldest 500 went');
  assert.equal(history.list().length, 2000, 'callers that pass no limit get the old 2000');
  assert.equal(history.list(10000).length, 2500);
  history.clear();
  assert.equal(history.count(), 0);
});

test('viewing-history.json is imported once, then removed', (t) => {
  const dir = tempDir(t);
  const entries = [row(1), row(2), row(3)];
  fs.writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify({ entries }));
  const history = createViewingHistory({ dir });
  assert.equal(history.count(), 3);
  assert.deepEqual(history.list(1)[0], row(3));
  assert.ok(!fs.existsSync(path.join(dir, HISTORY_FILE)));

  // A file that reappears (an older build ran in between) only adds newer rows.
  fs.writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify({ entries: [row(2), row(3), row(4)] }));
  closeAll();
  const again = createViewingHistory({ dir });
  assert.deepEqual(again.all().map((e) => e.title), ['Show 1', 'Show 2', 'Show 3', 'Show 4']);
});

test('the first household profile is seeded from the log', async (t) => {
  const dir = tempDir(t);
  const history = createViewingHistory({ dir });
  history.append(row(1));
  history.append(row(2));
  const personal = createPersonalService({ dir: path.join(dir, 'profiles'), getLegacyHistory: () => history.all() });
  const profile = await personal.call('getProfile', {});
  assert.deepEqual(profile.state.history.map((e) => e.title), ['Show 1', 'Show 2']);
});
