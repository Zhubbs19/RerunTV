// Scratch driver: setup › LIBRARY end to end against the real lineup
// (docs/design/07) — build the library with the 60-day check, scan the
// smallest root only, review and accept a tag group, build and rebuild a smart
// channel, and move a root to a synthetic path and back.
//
// Nothing on disk is moved. The only root scanned is J:\Media Center\YT Archive
// (two files). The root move rewrites path text in the throwaway userData copy.
//
// Run it through the wrapper, never directly:
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource "<installed-app-dir>\userData" -Script verify-library-ui.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const repo = path.resolve(here, '..', '..');
const outDir = path.join(here, 'library-out');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) { console.log('FAIL could not find the renderer page'); process.exit(1); }
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[error] ${m.text()}`); });
const notFound = [];
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const js = (fn, arg) => page.evaluate(fn, arg);
async function step(name, fn) { try { await fn(); } catch (e) { record(name, false, e.message.split('\n')[0]); } }
const shot = async (name) => {
  try {
    await wait(200);
    const capture = cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const { data } = await Promise.race([capture, new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 15000))]);
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  } catch (e) { console.log(`(screenshot ${name} skipped: ${e.message})`); }
};
const lib = (method, payload = {}) => js(async ([m, p]) => window.api.libraryCall(m, p), [method, payload]);
const textOf = (sel) => js((s) => (document.querySelector(s) || {}).textContent || '', sel);
async function until(label, fn, timeoutMs = 60000, every = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const value = await fn();
    if (value) return value;
    // eslint-disable-next-line no-await-in-loop
    await wait(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const dialogMessage = () => until('a dialog', () => js(() => {
  const box = [...document.querySelectorAll('.confirm-dialog .confirm-dialog-box')].pop();
  return box ? { title: (box.querySelector('.confirm-dialog-title') || {}).textContent || '', message: (box.querySelector('.confirm-dialog-message') || {}).textContent || '' } : null;
}), 30000, 200);
const dialogPress = (label) => page.locator('.confirm-dialog .confirm-dialog-actions button', { hasText: label }).last().click();
async function promptAnswer(value) {
  await dialogMessage();
  const input = page.locator('.confirm-dialog input').last();
  if (value != null) await input.fill(value);
  await dialogPress('OK');
  await wait(300);
}
const lineup = () => js(() => window.S.config.channels.map((ch) => ({
  n: ch.number, anchor: ch.anchor, folders: (ch.folders || []).map((f) => f.ref), files: (ch.files || []).map((f) => [f.path, f.duration]),
})));
const undoLabel = () => js(async () => (await import('app://bundle/renderer/js/core/state.js')).undoLabel());
const airingPath = (n) => js(async (number) => {
  const { querySchedule } = await import('app://bundle/renderer/js/core/schedule-query.js');
  const { viewNow } = await import('app://bundle/renderer/js/core/state.js');
  const ch = window.S.config.channels.find((c) => c.number === number);
  const t = viewNow();
  const entry = querySchedule(ch, t, t + 1, { breaks: false, offAir: false }).programs[0];
  return entry ? `${entry.file.path}@${Math.round((t - entry.start) / 1000)}` : null;
}, n);

// ---------- boot ----------
await wait(4000);
await until('config', () => js(() => !!(window.S && window.S.config && window.S.config.channels)), 30000);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
// The real config syncs its folders at startup. Let that settle first, so the
// "before" lineup is the one the library is built from.
// It may already be done by now, so wait on its status-bar task going quiet
// (twice in a row, a few seconds after load) rather than on a timestamp change.
if (await js(() => !!(window.S.config.librarySync || {}).enabled)) {
  let quiet = 0;
  try {
    await until('startup library sync', async () => {
      const syncing = await js(() => /SYNC/i.test((document.getElementById('setup-task-status') || {}).textContent || '')
        || /CHECKING/.test((document.getElementById('library-sync-status') || {}).textContent || ''));
      quiet = syncing ? 0 : quiet + 1;
      return quiet >= 3;
    }, 240000, 1500);
    console.log('startup library sync settled');
  } catch (e) { console.log('startup library sync still running after 4 minutes; continuing'); }
}

const YT = 'J:\\Media Center\\YT Archive';
const MOVED = 'Z:\\RerunTV Move Test\\YT Archive';
const libraryDir = path.join(repo, 'userData', 'library');
record('the throwaway profile starts with no library', !fs.existsSync(path.join(libraryDir, 'index.json')));

await js(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);
await js(() => document.querySelector('.setup-tab-btn[data-tab="library"]').click());
await wait(300);
await js(() => document.querySelector('[data-subtab="librarycatalogue"]').click());

const before = await lineup();

// ---------- CATALOGUE: check and build ----------
await step('not built: explanation and CHECK MY CHANNELS', async () => {
  await until('the check button', async () => (await textOf('#library-catalogue-root')).includes('CHECK MY CHANNELS'), 20000);
  record('not built: explanation and CHECK MY CHANNELS', (await textOf('#library-catalogue-root')).includes('60 days'));
  await shot('01-catalogue-not-built');
});

let checkRows = [];
await step('the 60-day check runs with visible progress and finds every channel identical', async () => {
  await page.locator('#library-catalogue-root button', { hasText: 'CHECK MY CHANNELS' }).click();
  const started = Date.now();
  const progress = new Set();
  let midShot = false;
  await until('check results', async () => {
    const p = await textOf('#library-check-progress');
    if (p) progress.add(p);
    if (p && progress.size > 3 && !midShot) { midShot = true; await shot('02-check-progress'); }
    return (await textOf('#library-catalogue-root')).includes('CHECK AGAIN');
  }, 8 * 60000, 400);
  const seconds = Math.round((Date.now() - started) / 1000);
  checkRows = await js(() => [...document.querySelectorAll('#library-catalogue-root tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent)));
  const identical = checkRows.filter((row) => row[3] === 'Airs identically').length;
  await shot('03-check-results');
  record('the 60-day check runs with visible progress and finds every channel identical',
    checkRows.length === before.length && identical === before.length && progress.size > 5,
    `${identical}/${checkRows.length} identical in ${seconds}s, ${progress.size} progress updates`);
});

await step('building writes the library and only item ids to config', async () => {
  await page.locator('#library-catalogue-root button', { hasText: 'BUILD LIBRARY' }).click();
  await until('built view', async () => (await textOf('#library-catalogue-root')).includes('Built from'), 120000);
  const after = await lineup();
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  const ids = await js(() => {
    let files = 0; let withItem = 0;
    window.S.config.channels.forEach((ch) => (ch.files || []).forEach((f) => { files += 1; if (/^itm_/.test(f.item || '')) withItem += 1; }));
    return { files, withItem };
  });
  const status = await lib('status');
  const label = await undoLabel();
  await shot('04-catalogue-built');
  record('building writes the library and only item ids to config',
    unchanged && ids.files === ids.withItem && status.ok && status.result.built && label === 'Build media library' && fs.existsSync(path.join(libraryDir, 'index.json')),
    `paths/durations/anchors unchanged=${unchanged}, ids ${ids.withItem}/${ids.files}, items ${status.result && status.result.stats.items}, roots ${status.result && status.result.stats.roots}, undo "${label}"`);
});

// ---------- CATALOGUE: scan the smallest root only ----------
await step('scanning YT Archive adopts its files and scans nothing else', async () => {
  await page.getByRole('button', { name: `Scan ${YT}`, exact: true }).click();
  await until('scan notice', async () => (await textOf('#library-catalogue-root')).includes('YT Archive:'), 120000);
  const scans = await lib('lastScan');
  const keys = Object.keys(scans.result || {});
  const report = scans.result[keys[0]] || {};
  await shot('05-scan-yt-archive');
  record('scanning YT Archive adopts its files and scans nothing else',
    keys.length === 1 && report.ref === YT && report.review.ambiguous.length === 0 && report.review.replaced.length === 0 && report.applied.added === 0 && report.missing.length === 0,
    `roots scanned ${keys.length}, "${report.text}"`);
});

// ---------- REVIEW ----------
let appliedGroup = null;
await step('REVIEW shows grouped tag suggestions and nothing waiting from the scan', async () => {
  await js(() => document.querySelector('[data-subtab="libraryreview"]').click());
  await until('tag cards', () => js(() => document.querySelectorAll('#library-review-tags-root .library-card').length > 0), 60000);
  const cards = await js(() => [...document.querySelectorAll('#library-review-tags-root .library-card .library-card-title')].map((t) => t.textContent));
  const scanEmpty = (await textOf('#library-review-scan-root')).includes('Nothing is waiting');
  await shot('06-review');
  record('REVIEW shows grouped tag suggestions and nothing waiting from the scan', cards.length > 3 && scanEmpty,
    `${cards.length} groups; first: ${cards.slice(0, 5).join(' | ')}`);
});

await step('accepting a group with one exception tags the catalogue only', async () => {
  // The smallest group with at least two items.
  const index = await js(() => {
    const cards = [...document.querySelectorAll('#library-review-tags-root .library-card')];
    const sizes = cards.map((card) => Number((card.querySelector('.ui-badge') || {}).textContent.replace(/[^\d]/g, '')));
    let best = -1;
    sizes.forEach((n, i) => { if (n >= 2 && (best === -1 || n < sizes[best])) best = i; });
    return best;
  });
  const card = page.locator('#library-review-tags-root .library-card').nth(index);
  appliedGroup = (await card.locator('.library-card-title').textContent()).trim();
  await card.locator('button', { hasText: 'CHOOSE ITEMS' }).click();
  await wait(300);
  const reopened = page.locator('#library-review-tags-root .library-card').nth(index);
  const excludedLabel = await reopened.locator('.library-item-list input[type=checkbox]').first().getAttribute('aria-label');
  await reopened.locator('.library-item-list input[type=checkbox]').first().uncheck();
  await wait(300);
  const applyText = await page.locator('#library-review-tags-root .library-card').nth(index).locator('button', { hasText: 'APPLY TO' }).textContent();
  await shot('07-review-exception');
  const configBefore = JSON.stringify(await lineup());
  await page.locator('#library-review-tags-root .library-card').nth(index).locator('button', { hasText: 'APPLY TO' }).click();
  await until('tagged notice', async () => (await textOf('#library-review-scan-root')).includes('Tagged'), 30000);
  const idx = (await lib('getIndex')).result;
  const accepted = Object.values(idx.items).filter((item) => Object.values(item.provenance || {}).includes('user-accepted'));
  const excludedTitle = excludedLabel.replace(/^Include /, '');
  const excludedTagged = accepted.some((item) => (item.title || '') === excludedTitle || item.ref.endsWith(excludedTitle));
  const configAfter = JSON.stringify(await lineup());
  record('accepting a group with one exception tags the catalogue only',
    accepted.length > 0 && !excludedTagged && configBefore === configAfter,
    `group "${appliedGroup}", button "${applyText}", ${accepted.length} items accepted, excluded "${excludedTitle}" untouched=${!excludedTagged}, config unchanged=${configBefore === configAfter}`);
});

// ---------- SMART CHANNELS ----------
let smartNumber = null;
await step('a saved query shows a live count and builds a channel', async () => {
  await js(() => document.querySelector('[data-subtab="librarysmart"]').click());
  await page.locator('#library-smart-root button', { hasText: 'NEW SAVED QUERY' }).click();
  await page.locator('#library-query-name').fill('Live test: Abridged');
  await page.locator('#library-query-text').fill('Abridged');
  await wait(300);
  const count = await textOf('#library-smart-root .library-form p.panel-status');
  await shot('08-query-form');
  await page.locator('#library-smart-root button', { hasText: 'SAVE' }).click();
  await until('saved row', async () => (await textOf('#library-smart-root')).includes('Saved “Live test: Abridged”'), 20000);
  await page.getByRole('button', { name: 'Build a channel from Live test: Abridged', exact: true }).click();
  const dialog = await dialogMessage();
  await shot('09-add-smart-channel');
  await dialogPress('ADD CHANNEL');
  await until('added notice', async () => (await textOf('#library-smart-root')).includes('Added CH'), 20000);
  const ch = await js(() => window.S.config.channels.find((c) => (c.sources || []).some((s) => s.type === 'query')));
  smartNumber = ch && ch.number;
  const label = await undoLabel();
  record('a saved query shows a live count and builds a channel',
    /Matches 1 item/.test(count) && ch && ch.files.length === 1 && Number.isFinite(ch.anchor) && ch.materializedAt && /^Add smart channel/.test(label),
    `count "${count}", dialog "${dialog.message}", CH ${smartNumber}, undo "${label}"`);
});

await step('rebuilding an unchanged smart channel does nothing', async () => {
  await page.getByRole('button', { name: `Rebuild CH ${smartNumber}`, exact: true }).click();
  await until('up to date', async () => (await textOf('#library-smart-root')).includes('already up to date'), 20000);
  record('rebuilding an unchanged smart channel does nothing', true);
});

await step('a broader query previews "stays on", rebuilds as one undo step, and undo restores it exactly', async () => {
  await page.getByRole('button', { name: 'Edit Live test: Abridged', exact: true }).click();
  await page.locator('#library-query-text').fill('YT Archive');
  await wait(300);
  await page.locator('#library-smart-root button', { hasText: 'SAVE' }).click();
  await until('saved again', async () => (await textOf('#library-smart-root')).includes('Saved'), 20000);
  const channelBefore = await js((n) => JSON.stringify(window.S.config.channels.find((c) => c.number === n)), smartNumber);
  const airingBefore = await airingPath(smartNumber);
  await page.getByRole('button', { name: `Rebuild CH ${smartNumber}`, exact: true }).click();
  const dialog = await dialogMessage();
  await shot('10-rebuild-preview');
  await dialogPress('REBUILD');
  await until('rebuilt notice', async () => (await textOf('#library-smart-root')).includes('Rebuilt CH'), 20000);
  const rebuilt = await js((n) => window.S.config.channels.find((c) => c.number === n), smartNumber);
  const airingAfter = await airingPath(smartNumber);
  const label = await undoLabel();
  await js(async () => (await import('app://bundle/renderer/js/core/state.js')).performUndo());
  await wait(300);
  const channelUndone = await js((n) => JSON.stringify(window.S.config.channels.find((c) => c.number === n)), smartNumber);
  const airingSame = airingBefore && airingAfter && airingBefore.split('@')[0] === airingAfter.split('@')[0]
    && Math.abs(Number(airingBefore.split('@')[1]) - Number(airingAfter.split('@')[1])) <= 5;
  record('a broader query previews "stays on", rebuilds as one undo step, and undo restores it exactly',
    /stays on/.test(dialog.message) && rebuilt.files.length === 2 && airingSame && label === `Rebuild CH ${smartNumber} from the library` && channelUndone === channelBefore,
    `dialog "${dialog.message}", airing ${airingBefore} -> ${airingAfter}, undo "${label}", restored=${channelUndone === channelBefore}`);
});

await step('with the setting on, a scan rebuilds a smart channel that keeps what is on', async () => {
  await page.locator('#library-smart-rebuild').check();
  await wait(300);
  const setting = await js(() => window.S.config.librarySync.rebuildSmartChannels);
  await js(() => document.querySelector('[data-subtab="librarycatalogue"]').click());
  await page.getByRole('button', { name: `Scan ${YT}`, exact: true }).click();
  await until('scan notice', async () => /YT Archive:.*(Rebuilt CH|would change)/.test(await textOf('#library-catalogue-root')), 120000);
  const notice = await textOf('#library-catalogue-root .library-note');
  const files = await js((n) => window.S.config.channels.find((c) => c.number === n).files.length, smartNumber);
  record('with the setting on, a scan rebuilds a smart channel that keeps what is on',
    setting === true && notice.includes(`Rebuilt CH ${smartNumber}`) && files === 2, `notice "${notice}"`);
});

// ---------- UPDATE LOCATION ----------
await step('moving YT Archive to a synthetic path rewrites config and library text only', async () => {
  const other = (await lineup()).filter((ch) => !ch.folders.some((f) => f.startsWith(YT)) && !ch.files.some((f) => f[0].startsWith(YT)));
  await page.getByRole('button', { name: `Update location of ${YT}`, exact: true }).click();
  await promptAnswer(null);
  await promptAnswer(MOVED);
  const dialog = await dialogMessage();
  await shot('11-update-location');
  await dialogPress('UPDATE LOCATION');
  await until('moved notice', async () => (await textOf('#library-catalogue-root')).includes(`Moved ${YT}`), 60000);
  const after = await lineup();
  const movedChannels = after.filter((ch) => ch.files.some((f) => f[0].startsWith(MOVED)));
  const stillOld = after.some((ch) => ch.files.some((f) => f[0].startsWith(`${YT}\\`)) || ch.folders.includes(YT));
  const othersSame = JSON.stringify(after.filter((ch) => other.some((o) => o.n === ch.n))) === JSON.stringify(other);
  const idx = (await lib('getIndex')).result;
  const libRoot = idx.roots.some((r) => r.ref === MOVED);
  const libItems = Object.values(idx.items).filter((i) => i.ref.startsWith(MOVED)).length;
  const onDisk = fs.existsSync(path.join(YT, 'Tokyo_Ghoul_Abridged_Episode_1_Pilot.mp4'));
  record('moving YT Archive to a synthetic path rewrites config and library text only',
    /can’t be reached/.test(dialog.message) && movedChannels.length >= 2 && !stillOld && othersSame && libRoot && libItems === 2 && onDisk,
    `dialog "${dialog.message}", channels moved ${movedChannels.map((c) => c.n).join(',')}, others unchanged=${othersSame}, library root=${libRoot} items=${libItems}, files still on J:=${onDisk}`);
});

await step('moving it back restores every path', async () => {
  await page.getByRole('button', { name: `Update location of ${MOVED}`, exact: true }).click();
  await promptAnswer(null);
  await promptAnswer(YT);
  const dialog = await dialogMessage();
  await dialogPress('UPDATE LOCATION');
  await until('moved back', async () => (await textOf('#library-catalogue-root')).includes(`Moved ${MOVED}`), 60000);
  const after = await lineup();
  const original = after.filter((ch) => before.some((b) => b.n === ch.n));
  const idx = (await lib('getIndex')).result;
  const sameAsStart = JSON.stringify(original.map(({ n, folders, files }) => ({ n, folders, files })))
    === JSON.stringify(before.map(({ n, folders, files }) => ({ n, folders, files })));
  record('moving it back restores every path',
    !/can’t be reached/.test(dialog.message) && sameAsStart && idx.roots.some((r) => r.ref === YT),
    `paths as at start=${sameAsStart}`);
  await shot('12-catalogue-final');
});

// ---------- the screen in TV mode ----------
await step('the LIBRARY screens render in TV mode without errors', async () => {
  await js(async () => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('tv'));
  await wait(800);
  await js(() => document.querySelector('[data-subtab="libraryreview"]').click());
  await wait(1500);
  await shot('13-review-tv-mode');
  const overflow = await js(() => {
    const root = document.getElementById('library-review-tags-root');
    return root ? root.scrollWidth - root.clientWidth : 0;
  });
  await js(async () => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('desktop'));
  record('the LIBRARY screens render in TV mode without errors', overflow <= 1, `horizontal overflow ${overflow}px`);
});

record('no page errors', errors.length === 0, errors.slice(0, 5).join(' || '));
record('no 404s', notFound.length === 0, notFound.slice(0, 5).join(' '));
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, checkRows, errors, notFound }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close().catch(() => {});
process.exit(failed.length ? 1 : 0);
