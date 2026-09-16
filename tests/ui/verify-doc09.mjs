// Scratch: docs/design/09 (households, DVR, watching together) against the
// real lineup. Exercises the personal-profile service through window.api
// (same path the renderer uses), the HOUSEHOLD setup panel, guide record
// actions, restricted-profile guide filtering and the TV menu profile item.
// Run through run-ui-tests.ps1 -Script verify-doc09.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'doc09-out');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const js = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await wait(150);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
};

await wait(4000);
for (let i = 0; i < 40; i += 1) {
  if (await js(() => !!(window.S && window.S.config && window.S.config.channels))) break;
  await wait(500);
}
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

// ---------------- migration + status ----------------
const status = await js(async () => (await window.api.personalCall('status', {})).result);
record('migration created a personal store with an active profile', status.ok !== false && status.count >= 1, JSON.stringify(status));

const everyone = await js(async () => (await window.api.personalCall('listProfiles', {})).result.find((p) => p.id === 'everyone'));
record('"Everyone" default profile exists', !!everyone, JSON.stringify(everyone));

// ---------------- profile create/switch/favorites ----------------
const beforeProfiles = await js(async () => (await window.api.personalCall('listProfiles', {})).result.length);
const kid = await js(async () => (await window.api.personalCall('createProfile', { name: 'Doc9 Kid', restriction: 'kids' })).result);
record('createProfile makes a restricted profile', kid && kid.id && kid.restriction === 'kids', JSON.stringify(kid));

const firstChannel = await js(() => window.S.config.channels.filter((c) => !c.hidden).sort((a, b) => a.number - b.number)[0].number);
const kidsChannel = await js(() => {
  const ratings = ['', 'TV-Y', 'TV-Y7', 'TV-G', 'G'];
  const c = window.S.config.channels.find((ch) => !ch.hidden && !ratings.includes(ch.rating || ''));
  return c ? c.number : null;
});

const switched = await js(async ({ id }) => {
  const { switchProfile } = await import('app://bundle/renderer/js/personal/state.js');
  const next = await switchProfile(id);
  return next.id;
}, { id: kid.id });
record('switchProfile moves the active client to the new profile', switched === kid.id, switched);

const kidFavToggle = await js(async ({ n }) => {
  const { toggleFavorite, currentProfile } = await import('app://bundle/renderer/js/personal/state.js');
  await toggleFavorite(n);
  return currentProfile().state.favorites.includes(n);
}, { n: firstChannel });
record('favoriting a channel as the kid profile writes to that profile only', kidFavToggle === true);

const everyoneStillClean = await js(async ({ id, n }) => {
  const r = await window.api.personalCall('getProfile', { id });
  return !r.result.state.favorites.includes(n);
}, { id: 'everyone', n: firstChannel });
record('Everyone profile is unaffected by the kid profile\'s favorite', everyoneStillClean);

if (kidsChannel != null) {
  const hiddenForKid = await js(async ({ n }) => (await import('app://bundle/renderer/js/personal/state.js')).isHiddenForProfile(n), { n: kidsChannel });
  record('a non-kids-rated channel is hidden for the kids-restricted profile', hiddenForKid === true, `channel ${kidsChannel}`);
} else {
  record('restriction filtering: no non-kids-rated channel in this lineup to test', true, 'skipped');
}

// switch back to Everyone
await js(async () => (await import('app://bundle/renderer/js/personal/state.js')).switchProfile('everyone'));
await wait(200);

// ---------------- HOUSEHOLD setup panel renders the new profile ----------------
await js(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(300);
await page.locator('.setup-tab-btn[data-tab="household"]').click();
await wait(400);
const panelRows = await js(() => document.getElementById('household-profiles-list').children.length);
await shot('household-panel');
record('HOUSEHOLD panel lists all profiles including the new one', panelRows >= (beforeProfiles + 1), `${panelRows} rows`);

// ---------------- DVR: request from the guide, see it in HOUSEHOLD, cancel it ----------------
await js(async () => (await import('app://bundle/renderer/js/personal/state.js')).switchProfile('everyone'));
await js(async (n) => { const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js'); await tuneToChannel(n); }, firstChannel);
await wait(1000);
const requestResult = await js(async ({ n }) => {
  const { personalCommand, currentProfile } = await import('app://bundle/renderer/js/personal/state.js');
  const { viewNow } = await import('app://bundle/renderer/js/core/state.js');
  const start = viewNow();
  await personalCommand({ type: 'recording.request', requestType: 'airing', channel: n, start, end: start + 1800000, breaks: 'as-aired' });
  return currentProfile().state.recordingRequests.length;
}, { n: firstChannel });
record('a recording.request personal command is stored on the profile', requestResult >= 1, `${requestResult} requests`);

await page.locator('.setup-tab-btn[data-tab="household"]').click();
await wait(400);
const requestRows = await js(() => document.getElementById('household-recordings-list').children.length);
await shot('household-dvr-request');
record('the DVR request shows up in HOUSEHOLD › MY SHOWS & DVR', requestRows >= 1, `${requestRows} rows`);

const cancelClicked = await js(() => {
  const row = Array.from(document.getElementById('household-recordings-list').children).find((el) => /CANCEL/.test(el.textContent));
  const btn = row && Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'CANCEL');
  if (!btn) return false;
  btn.click();
  return true;
});
await wait(500);
const afterCancel = await js(async () => (await window.api.personalCall('getProfile', { id: 'everyone' })).result.state.recordingRequests.length);
record('CANCEL in the HOUSEHOLD panel removes the request', cancelClicked && afterCancel === 0, `clicked ${cancelClicked}, ${afterCancel} left`);

// ---------------- DVR planner: pure expansion against the real lineup ----------------
const dvrPlan = await js(async ({ n }) => {
  const { querySchedule } = await import('app://bundle/renderer/js/core/schedule-query.js');
  const { expandRecordingRequests } = await import('app://bundle/renderer/js/personal/dvr.js');
  const ch = window.S.config.channels.find((c) => c.number === n);
  const { viewNow } = await import('app://bundle/renderer/js/core/state.js');
  const now = viewNow();
  const { programs } = querySchedule(ch, now, now + 3600000, { offAir: false });
  const current = programs[0];
  if (!current) return -1;
  const request = { id: 'verify', type: 'airing', channel: n, start: current.start, end: current.end, createdAt: current.start - 1, enabled: true };
  return expandRecordingRequests([request], window.S.config.channels, current.start, current.end + 1).length;
}, { n: firstChannel });
record('expandRecordingRequests resolves a concrete airing against the live schedule', dvrPlan >= 1, `${dvrPlan} airings`);

// ---------------- handoff + shared session service calls ----------------
const handoff = await js(async () => {
  try {
    const event = await window.api.personalCall('handoff', { targetClientId: 'verify-client', channel: window.S.currentNumber, timeOffsetMs: 0 });
    return event.ok !== false;
  } catch (e) { return false; }
});
record('a handoff event can be sent through the personal service', handoff === true);

const session = await js(async () => {
  const start = await window.api.personalCall('session', { action: 'start', clientId: 'verify-leader', channel: window.S.currentNumber, timeOffsetMs: 0 });
  const joined = await window.api.personalCall('session', { action: 'join', id: start.result.id, clientId: 'verify-member' });
  const left = await window.api.personalCall('session', { action: 'leave', id: start.result.id, clientId: 'verify-member' });
  return { members: joined.result.members.length, afterLeave: left.result.members.length };
});
record('a shared session accepts a leader, a joining member, then the member leaving', session.members === 2 && session.afterLeave === 1, JSON.stringify(session));

// ---------------- TV menu shows the profile switcher ----------------
await js(async () => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('tv'));
await wait(300);
await js(async () => (await import('app://bundle/renderer/js/tv/menu.js')).openTvMenu());
await wait(300);
const tvMenuLabels = await js(() => Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).map((b) => b.textContent.trim()));
await shot('tv-menu-profile-item');
record('TV menu shows a PROFILE entry naming the active profile', tvMenuLabels.some((l) => /^PROFILE:/.test(l)), tvMenuLabels.join(' | '));
await js(async () => (await import('app://bundle/renderer/js/tv/menu.js')).closeTvMenu());
await js(async () => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('desktop'));
await wait(200);

// ---------------- cleanup the test profile ----------------
const removed = await js(async ({ id }) => {
  try { await window.api.personalCall('deleteProfile', { id }); return true; } catch (e) { return false; }
}, { id: kid.id });
record('the Doc9 Kid test profile was cleaned up', removed);

await cdp.send('Emulation.clearDeviceMetricsOverride');
record('no page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
