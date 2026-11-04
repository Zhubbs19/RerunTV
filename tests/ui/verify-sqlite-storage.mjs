// Live check for rerun.db (main/util/db.js): boots on a copy of a real
// userData that still has the pre-SQLite files (api-cache.json,
// loudness-cache.json, crop-cache.json, viewing-history.json,
// library/index.json), then confirms each was imported and the app reads and
// writes through the database.
//
// Run through the wrapper only (it backs up and restores the real userData):
//   $env:RERUN_SOURCE_USERDATA = "C:\Users\<you>\Apps\RerunTV\userData"
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource $env:RERUN_SOURCE_USERDATA -Script verify-sqlite-storage.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { connectToApp, sleep } from './lib/cdp.mjs';

const port = Number(process.argv[2] || 9222);
const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = path.resolve(here, '..', '..', 'userData');
const sourceDir = process.env.RERUN_SOURCE_USERDATA || '';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
const keys = (o) => Object.keys(o || {});

// What the source had, so the imported data can be compared.
const source = {
  api: readJson(path.join(sourceDir, 'api-cache.json')),
  loudness: readJson(path.join(sourceDir, 'loudness-cache.json')),
  crop: readJson(path.join(sourceDir, 'crop-cache.json')),
  history: readJson(path.join(sourceDir, 'viewing-history.json')),
  library: readJson(path.join(sourceDir, 'library', 'index.json')),
};
const expected = {
  api: Math.min(500, keys(source.api).length),
  loudness: keys(source.loudness && source.loudness.entries).length,
  crop: keys(source.crop && source.crop.entries).length,
  history: source.history && Array.isArray(source.history.entries) ? source.history.entries.length : 0,
  roots: source.library ? (source.library.roots || []).length : 0,
  items: keys(source.library && source.library.items).length,
  presets: keys(source.library && source.library.presets).length,
  queries: keys(source.library && source.library.queries).length,
};
console.log('source counts', expected);

function dbQuery(sql, ...params) {
  const db = new DatabaseSync(path.join(workDir, 'rerun.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

const session = await connectToApp(port);
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  ready = await session.evaluate('!!(window.api && window.api.getLoudnessStatus && window.api.libraryCall)').catch(() => false);
  if (!ready) await sleep(500);
}
check('app booted with window.api', ready);
const call = (expr) => session.evaluate(expr, { awaitPromise: true });

// ---------- caches ----------
// The app is live: tuning in at boot can measure a new file or log a
// programme, so these counts are "at least what the source had".
const loudness = await call('window.api.getLoudnessStatus()');
const crop = await call('window.api.getCropStatus()');
check('loudness status counts the imported measurements', loudness && loudness.measured >= expected.loudness, loudness);
check('crop status counts the imported measurements', crop && crop.checked >= expected.crop, crop);
// The API cache opens on its first fetch; the HELP tab's release notes are one.
const notes = await call('window.api.getReleaseNotes().then((r) => Array.isArray(r) ? r.length : -1)');
check('release notes still load through fetchJsonCached', notes >= 0, { notes });

// ---------- viewing history ----------
const historyBefore = await call('window.api.historyList(100000)');
const oldestSource = expected.history ? source.history.entries[0] : null;
const oldestLive = historyBefore[historyBefore.length - 1];
check('the whole viewing log was imported, oldest row included',
  historyBefore.length >= expected.history && (!oldestSource || (oldestLive && oldestLive.at === oldestSource.at && oldestLive.path === oldestSource.path)),
  { source: expected.history, live: historyBefore.length });
const marker = `sqlite-check-${Date.now()}`;
const appended = await call(`window.api.historyAppend({ at: Date.now(), viewAt: Date.now(), channelNumber: 999, channelName: 'Check', title: '${marker}', path: '${marker}.mkv', durationS: 60 })`);
const newest = await call('window.api.historyList(1)');
check('a new viewing row is appended and listed first', appended && appended.ok && newest[0] && newest[0].title === marker, newest[0]);
check('the row is in rerun.db straight away', dbQuery('SELECT count(*) AS n FROM history WHERE title = ?', marker)[0].n === 1);

// ---------- library ----------
const status = await call("window.api.libraryCall('status', {})");
const stats = status && status.ok && status.result.stats;
check('the library is stored in sqlite', status && status.ok && status.result.storage === 'sqlite', status && status.result && status.result.storage);
check('library roots and items match the old index.json', stats && stats.roots === expected.roots && stats.items === expected.items, stats);
check('presets and saved queries came across', stats && stats.presets === expected.presets && stats.queries === expected.queries, stats);
check('no library load error', status && status.ok && !status.result.loadError, status && status.result && status.result.loadError);
const index = await call("window.api.libraryCall('getIndex', {})");
const sourceIds = keys(source.library && source.library.items).sort();
const liveIds = index && index.ok ? keys(index.result.items).sort() : [];
check('every item id survived', JSON.stringify(sourceIds) === JSON.stringify(liveIds), { source: sourceIds.length, live: liveIds.length });

const saved = await call(`window.api.libraryCall('saveQuery', { name: '${marker}', where: { tags: 'comedy' } })`);
const queryId = saved && saved.ok && saved.result.id;
check('saving a query writes one library row', !!queryId && dbQuery("SELECT count(*) AS n FROM library WHERE kind = 'queries' AND id = ?", queryId)[0].n === 1, { queryId });
const removed = await call(`window.api.libraryCall('removeQuery', { id: '${queryId}' })`);
check('removing it deletes the row', removed && removed.ok && dbQuery("SELECT count(*) AS n FROM library WHERE kind = 'queries' AND id = ?", queryId)[0].n === 0);

// ---------- files on disk ----------
check('rerun.db exists', fs.existsSync(path.join(workDir, 'rerun.db')));
for (const name of ['api-cache.json', 'loudness-cache.json', 'crop-cache.json', 'viewing-history.json', path.join('library', 'index.json')]) {
  check(`${name} was imported and removed`, !fs.existsSync(path.join(workDir, name)));
}
check('library/index.json.pre-sqlite is kept as a safety copy', !source.library || fs.existsSync(path.join(workDir, 'library', 'index.json.pre-sqlite')));

const counts = Object.fromEntries(dbQuery('SELECT ns, count(*) AS n FROM cache GROUP BY ns').map((r) => [r.ns, Number(r.n)]));
check('loudness and crop rows cover the source and match the services', (counts.loudness || 0) >= expected.loudness && (counts.crop || 0) >= expected.crop
  && (counts.loudness || 0) === (await call('window.api.getLoudnessStatus()')).measured, counts);
// A fresh fetch may have added the release-notes entry on top of the import.
check('api rows cover the source', (counts.api || 0) >= expected.api && (counts.api || 0) <= expected.api + 1, counts);
check('database integrity', dbQuery('PRAGMA integrity_check')[0].integrity_check === 'ok');

session.close();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(here, 'verify-sqlite-storage-report.json'), JSON.stringify({ expected, results }, null, 2));
console.log(failed.length ? `${failed.length} FAILED` : 'ALL PASSED');
process.exit(failed.length ? 1 : 0);
