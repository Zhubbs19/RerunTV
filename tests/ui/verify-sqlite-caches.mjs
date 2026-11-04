// Live check for the caches' move into rerun.db (main/util/db.js): boots on a
// copy of a real userData that still has the old api-cache.json,
// loudness-cache.json and crop-cache.json, then confirms each was imported
// into rerun.db and removed, and that the services read the imported rows.
//
// Run through the wrapper only (it backs up and restores the real userData):
//   $env:RERUN_SOURCE_USERDATA = "C:\Users\<you>\Apps\RerunTV\userData"
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource $env:RERUN_SOURCE_USERDATA -Script verify-sqlite-caches.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { connectToApp, sleep } from './lib/cdp.mjs';

const port = Number(process.argv[2] || 9222);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = path.join(repoRoot, 'userData');
const sourceDir = process.env.RERUN_SOURCE_USERDATA || '';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// What the source had, so the imported counts can be compared.
const source = {
  api: readJson(path.join(sourceDir, 'api-cache.json')),
  loudness: readJson(path.join(sourceDir, 'loudness-cache.json')),
  crop: readJson(path.join(sourceDir, 'crop-cache.json')),
};
const expected = {
  api: source.api ? Math.min(500, Object.keys(source.api).length) : 0,
  loudness: source.loudness && source.loudness.entries ? Object.keys(source.loudness.entries).length : 0,
  crop: source.crop && source.crop.entries ? Object.keys(source.crop.entries).length : 0,
};
console.log('source counts', expected);

const session = await connectToApp(port);
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  ready = await session.evaluate('!!(window.api && window.api.getLoudnessStatus)').catch(() => false);
  if (!ready) await sleep(500);
}
check('app booted with window.api', ready);

const loudness = await session.evaluate('window.api.getLoudnessStatus()', { awaitPromise: true });
const crop = await session.evaluate('window.api.getCropStatus()', { awaitPromise: true });
check('loudness status counts the imported measurements', loudness && loudness.measured === expected.loudness, loudness);
check('crop status counts the imported measurements', crop && crop.checked === expected.crop, crop);
if (source.crop && source.crop.entries) {
  const withBars = Object.values(source.crop.entries).filter((e) => e && e.crop).length;
  check('crop status counts files with bars', crop && crop.withBars === withBars, { withBars });
}

// The API cache opens on its first fetch; the HELP tab's release notes are one.
const notes = await session.evaluate('window.api.getReleaseNotes().then((r) => Array.isArray(r) ? r.length : -1)', { awaitPromise: true });
check('release notes still load through fetchJsonCached', notes >= 0, { notes });

check('rerun.db exists', fs.existsSync(path.join(workDir, 'rerun.db')));
for (const name of ['api-cache.json', 'loudness-cache.json', 'crop-cache.json']) {
  check(`${name} was removed after import`, !fs.existsSync(path.join(workDir, name)));
}

// Read the database directly (another reader is fine while the app has it open in WAL mode).
const db = new DatabaseSync(path.join(workDir, 'rerun.db'), { readOnly: true });
const counts = Object.fromEntries(db.prepare('SELECT ns, count(*) AS n FROM cache GROUP BY ns').all().map((r) => [r.ns, Number(r.n)]));
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
db.close();
check('database integrity', integrity === 'ok', integrity);
check('loudness rows match the source', counts.loudness === expected.loudness || (!expected.loudness && !counts.loudness), counts);
check('crop rows match the source', counts.crop === expected.crop || (!expected.crop && !counts.crop), counts);
// A fresh fetch may have added the release-notes entry on top of the import.
check('api rows cover the source', (counts.api || 0) >= expected.api && (counts.api || 0) <= expected.api + 1, counts);

session.close();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-sqlite-caches-report.json'), JSON.stringify({ expected, results }, null, 2));
console.log(failed.length ? `${failed.length} FAILED` : 'ALL PASSED');
process.exit(failed.length ? 1 : 0);
