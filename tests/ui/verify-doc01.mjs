// Scratch: docs/design/01 phases B–E against the real lineup, in TV mode,
// through the real input paths — RerunTVInput.native with raw Android
// keycodes, trusted key events, a stubbed Gamepad API — plus desktop checks
// that nothing changed there. Run through run-ui-tests.ps1 -Script verify-doc01.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'doc01-out');
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
const notFound = [];
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const js = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await wait(150);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
};
// Android KeyEvent codes (what the new APK posts).
const K = { up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, chUp: 166, chDown: 167, playPause: 85, red: 183, yellow: 185, blue: 186, guide: 172, info: 165 };
const android = (name, extra = {}) => js((e) => window.RerunTVInput.native(e), { source: 'android', keyCode: K[name], action: 'down', ...extra });
const visible = (sel) => js((s) => { const el = document.querySelector(s); return !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0; }, sel);
const focusedText = () => js(() => (document.activeElement && document.activeElement.textContent || '').trim());
const menuLabels = () => js(() => Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).map((b) => b.textContent.trim()));
const menuTitle = () => js(() => document.getElementById('tv-menu-title').textContent);
const setMode = (m) => js(async (mode) => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference(mode), m);
const reset = () => js(async () => {
  (await import('app://bundle/renderer/js/tv/menu.js')).closeTvMenu();
  (await import('app://bundle/renderer/js/guide/guide.js')).closeGuideGrid();
  (await import('app://bundle/renderer/js/tv/banner-hub.js')).closeBannerHub();
  (await import('app://bundle/renderer/js/tv/handoff.js')).closeHandoff();
  const rt = await import('app://bundle/renderer/js/remote/test.js');
  rt.closeLearnMode(); rt.closeRemoteTest();
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
});

await wait(4000);
for (let i = 0; i < 40; i += 1) {
  if (await js(() => !!(window.S && window.S.config && window.S.config.channels))) break;
  await wait(500);
}
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
const firstChannel = await js(() => window.S.config.channels.filter((c) => !c.hidden).sort((a, b) => a.number - b.number)[0].number);
await js(async (n) => { const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js'); await tuneToChannel(n); }, firstChannel);
await wait(1500);

// ---------------- desktop: unchanged ----------------
await setMode('desktop');
await reset();
await page.keyboard.press('?');
await wait(300);
const desktopMenu = await js(() => ({ list: document.getElementById('tv-menu-grid').classList.contains('tv-menu-list'), first: document.querySelector('#tv-menu-grid .tv-menu-btn')?.textContent, cols: getComputedStyle(document.getElementById('tv-menu-grid')).gridTemplateColumns.split(' ').length }));
record('desktop: ? opens the grid menu as before (4 columns, CH ▲ first)', !desktopMenu.list && desktopMenu.first === 'CH ▲' && desktopMenu.cols === 4, JSON.stringify(desktopMenu));
await page.keyboard.press('Escape');
await wait(200);
await page.keyboard.press('Enter');
await wait(300);
record('desktop: Enter on live TV shows the banner, not the hub', await visible('#guide-overlay') && !(await js(async () => (await import('app://bundle/renderer/js/tv/banner-hub.js')).bannerHubOpen())));

// ---------------- TV mode: raw Android keycodes ----------------
await setMode('tv');
await reset();
await wait(300);
record('bridge reports version 2', await js(() => window.RerunTVInput.version === 2));
await android('playPause');
await wait(300);
let labels = await menuLabels();
record('Play/Pause (keycode 85) opens the one-column TV menu with Guide then Time machine', await js(() => document.getElementById('tv-menu-grid').classList.contains('tv-menu-list')) && labels[0] === 'GUIDE' && labels[1] === 'TIME MACHINE ›', labels.join(' | '));
await shot('tv-menu-root');
// into CHANNELS › with ▼ ▼ OK, then back with BACK
await android('down'); await android('down'); await wait(100);
const onChannels = await focusedText();
await android('ok'); await wait(300);
const channelsTitle = await menuTitle();
labels = await menuLabels();
record('▼▼ OK opens CHANNELS › with a breadcrumb', onChannels === 'CHANNELS ›' && /CHANNELS/.test(channelsTitle) && labels.includes('TUNE TO NUMBER…'), `${channelsTitle}: ${labels.join(' | ')}`);
await android('back', { action: 'up' }); // Back arrives on release from the client
await android('back'); await wait(300);
record('BACK goes up a level, not out of the menu', /^TV MENU$/.test(await menuTitle()) && await visible('#shortcuts-overlay'), await menuTitle());
await reset();

// number pad
await android('playPause'); await wait(250);
await android('down'); await android('down'); await android('ok'); await wait(250);
await android('down'); await android('down'); await android('down'); await android('ok'); await wait(250);
const padTitle = await menuTitle();
const padCols = await js(() => getComputedStyle(document.getElementById('tv-menu-grid')).gridTemplateColumns.split(' ').length);
const target = String(firstChannel);
for (const digit of target) {
  // focus the digit button and press OK
  await js((d) => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === d); b && b.focus(); }, digit);
  await android('ok'); await wait(150);
}
const typedTitle = await menuTitle();
record('TUNE TO NUMBER… is a 3-column pad that fills the entry buffer', padCols === 3 && /TUNE TO/.test(padTitle) && typedTitle.includes(target), `${padTitle} → ${typedTitle}`);
await shot('tv-number-pad');
await reset();
await js(() => { window.S.entryBuffer = ''; });

// banner hub
const liveBefore = await js(() => window.S.currentNumber);
await android('ok'); await wait(400);
const hubOpen = await js(async () => (await import('app://bundle/renderer/js/tv/banner-hub.js')).bannerHubOpen());
await android('right'); await wait(300);
const bannerNumber = await js(() => document.getElementById('guide-number').textContent);
const stillOn = await js(() => window.S.currentNumber);
await shot('tv-banner-browse');
await android('down'); await wait(300);
const actionsShown = await visible('.banner-actions');
await shot('tv-banner-actions');
await android('back'); await wait(200);
await android('ok'); await wait(1800);
const tunedTo = await js(() => window.S.currentNumber);
record('OK opens the banner hub; ▶ browses without tuning; ▼ shows actions; OK tunes', hubOpen && stillOn === liveBefore && actionsShown && tunedTo !== liveBefore && String(tunedTo).replace(/^0+/, '') === bannerNumber.replace(/^0+/, ''),
  `open ${hubOpen}, showed ${bannerNumber} while on ${stillOn}, actions ${actionsShown}, tuned ${tunedTo}`);
await js(async (n) => { const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js'); await tuneToChannel(n); }, firstChannel);
await wait(1200);
await reset();

// guide colour keys
await android('left'); await wait(900);
await android('blue'); await wait(300);
const reminders = await js(() => { const l = document.querySelector('.guide-actions'); return l ? l.querySelector('.guide-run-heading').textContent : null; });
record('blue in the guide lists reminders', /REMINDER/.test(reminders || ''), reminders);
await android('back'); await wait(200);
await android('yellow'); await wait(400);
const oskOpen = await visible('.osk');
await shot('tv-guide-search-osk');
record('yellow in the guide opens search on the on-screen keyboard', oskOpen);
// type "A" then DONE via D-pad + OK
await android('ok'); await wait(100); // first key "A" is focused
await js(() => { const b = Array.from(document.querySelectorAll('.osk-key')).find((x) => x.textContent === 'DONE'); b && b.focus(); });
await android('ok'); await wait(400);
const filter = await js(() => document.getElementById('guide-search').value);
record('the keyboard types into the guide filter', !(await visible('.osk')) && filter === 'A', `filter "${filter}"`);
await js(async () => { const s = document.getElementById('guide-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
await reset();

// observed-profile hints: GUIDE hint appears only after a Guide key
await js(async () => { (await import('app://bundle/renderer/js/tv/input.js')).remoteProfile().reset(); document.querySelectorAll('.hint-available').forEach((el) => el.classList.remove('hint-available')); });
const hintBefore = await js(() => { const el = document.querySelector('[data-hint-key="tv-guide-button"]'); return el ? getComputedStyle(el).display : 'missing'; });
await android('guide'); await wait(600);
await reset();
const hintAfter = await js(() => { const el = document.querySelector('[data-hint-key="tv-guide-button"]'); return el ? getComputedStyle(el).display : 'missing'; });
record('● GUIDE hint hidden until this remote sends Guide, then shown', hintBefore === 'none' && hintAfter !== 'none', `${hintBefore} → ${hintAfter}`);

// remote test: swallow everything, save on 3× back
await js(async () => (await import('app://bundle/renderer/js/remote/test.js')).openRemoteTest());
await wait(300);
const chBefore = await js(() => window.S.currentNumber);
await android('chUp'); await android('guide'); await js((e) => window.RerunTVInput.native(e), { source: 'android', keyCode: 999, action: 'down' });
await wait(300);
const rt = await js(() => ({ events: document.querySelectorAll('.remote-test-event').length, unmapped: document.querySelectorAll('.remote-test-event.unmapped').length, seen: document.querySelectorAll('.remote-test-key.seen').length, guideOpen: !document.getElementById('guide-grid').classList.contains('hidden') }));
await shot('tv-remote-test');
record('remote test shows every press (unmapped too) and routes none of them', rt.events === 3 && rt.unmapped === 1 && !rt.guideOpen && chBefore === await js(() => window.S.currentNumber), JSON.stringify(rt));
await android('back'); await android('back'); await android('back');
await wait(1200);
const saved = await js(() => document.querySelector('.remote-test-status')?.textContent || '');
record('three BACK presses save the capture on the host', /Saved on the host/.test(saved) && /remote-profiles/.test(saved), saved);
await wait(2500);

// learn mode: remap an unmapped keycode to GUIDE
await js(async () => (await import('app://bundle/renderer/js/remote/test.js')).openLearnMode());
await wait(300);
const firstLearn = await focusedText();
await android('ok'); await wait(150); // capture for the first item (GUIDE)
await js((e) => window.RerunTVInput.native(e), { source: 'android', keyCode: 998, action: 'down' });
await wait(200);
const learnStatus = await js(() => document.querySelector('.remote-learn-status')?.textContent || '');
await android('back'); await wait(300);
await js((e) => window.RerunTVInput.native(e), { source: 'android', keyCode: 998, action: 'down' });
await wait(900);
const remapped = await visible('#guide-grid');
record('learn mode: a new button assigned to GUIDE opens the guide', /^GUIDE/.test(firstLearn) && /android:998 now means GUIDE/.test(learnStatus) && remapped, `${firstLearn} / ${learnStatus} / guide ${remapped}`);
await js(async () => (await import('app://bundle/renderer/js/tv/input.js')).remoteProfile().resetOverrides());
await reset();

// handoff
await js(async () => (await import('app://bundle/renderer/js/tv/handoff.js')).openHandoff());
await wait(1500);
const handoff = await js(() => ({ url: document.querySelector('.handoff-url')?.textContent, qr: !document.querySelector('.handoff-qr')?.classList.contains('hidden'), label: document.querySelector('.handoff-label')?.textContent, focused: document.activeElement?.textContent }));
await shot('tv-handoff');
record('handoff shows the Companion address with a QR (or says how to turn it on)', (handoff.qr && /^http/.test(handoff.url)) || /Companion/.test(handoff.label || ''), JSON.stringify(handoff));
await android('back'); await wait(200);
record('BACK closes the handoff', !(await visible('.handoff')));

// TV setup: theme steps with ▶ and applies; rename through the keyboard
const themeBefore = await js(() => window.S.config.theme);
await android('playPause'); await wait(250);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'SETUP ›'); b && b.focus(); });
await android('ok'); await wait(250);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'GUIDE & THEME ›'); b && b.focus(); });
await android('ok'); await wait(250);
const themeRow = await focusedText();
await android('right'); await wait(500);
const themeAfter = await js(() => ({ config: window.S.config.theme, applied: document.documentElement.dataset.theme }));
const themeRowAfter = await focusedText();
await shot('tv-setup-theme');
record('SETUP › GUIDE & THEME: ▶ on THEME steps and applies the next theme', /^THEME:/.test(themeRow) && themeAfter.config !== themeBefore && themeRowAfter !== themeRow, `${themeRow} → ${themeRowAfter} (${themeBefore} → ${themeAfter.config}/${themeAfter.applied})`);
await android('left'); await wait(500);
record('◀ steps it back', await js((t) => window.S.config.theme === t, themeBefore));
await reset();

await android('playPause'); await wait(250);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'SETUP ›'); b && b.focus(); });
await android('ok'); await wait(200);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'CHANNELS ›'); b && b.focus(); });
await android('ok'); await wait(200);
await android('ok'); await wait(250); // first channel
const chTitle = await menuTitle();
const originalName = await js((n) => window.S.config.channels.find((c) => c.number === n).name, firstChannel);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'RENAME…'); b && b.focus(); });
await android('ok'); await wait(300);
await js(() => { const b = Array.from(document.querySelectorAll('.osk-key')).find((x) => x.textContent === 'CLEAR'); b && b.focus(); });
await android('ok');
for (const letter of 'ZZ') {
  await js((l) => { const b = Array.from(document.querySelectorAll('.osk-key')).find((x) => x.textContent === l); b && b.focus(); }, letter);
  await android('ok');
}
await js(() => { const b = Array.from(document.querySelectorAll('.osk-key')).find((x) => x.textContent === 'DONE'); b && b.focus(); });
await android('ok'); await wait(400);
const renamed = await js((n) => window.S.config.channels.find((c) => c.number === n).name, firstChannel);
record('SETUP › CHANNELS › RENAME… uses the keyboard and dispatches a rename', /SETUP · CH/.test(chTitle) && renamed === 'ZZ', `${chTitle}: "${originalName}" → "${renamed}"`);
await js(async ({ n, name }) => { const { dispatch } = await import('app://bundle/renderer/js/core/state.js'); dispatch({ type: 'channel.rename', channel: n, name }); }, { n: firstChannel, name: originalName });
await reset();

// first-run wizard (called directly; the real trigger needs an empty lineup)
const wizardDone = js(async () => {
  const { showTvWizard } = await import('app://bundle/renderer/js/tv/wizard.js');
  window.__wizardResult = await showTvWizard({ updateStrategy: 'manual', addFolderChannel: null });
  return window.__wizardResult;
});
await wait(500);
const step1 = await js(() => document.querySelector('.tv-wizard-title')?.textContent);
await shot('tv-wizard-welcome');
await android('ok'); await wait(300);
const step2 = await js(() => document.querySelector('.tv-wizard-title')?.textContent);
await js(() => { const b = Array.from(document.querySelectorAll('.tv-wizard-btn')).find((x) => x.textContent === 'CONTINUE'); b && b.focus(); });
await android('ok'); await wait(300);
const step3 = await js(() => document.querySelector('.tv-wizard-title')?.textContent);
await android('ok'); await wait(400); // keeps the focused (current) strategy
const step4 = await js(() => document.querySelector('.tv-wizard-prompt')?.textContent);
await android('ok'); await wait(150);
await android('back'); await wait(150);
await android('ok', { longPress: true }); await wait(1400);
const step5 = await js(() => document.querySelector('.tv-wizard-title')?.textContent);
await shot('tv-wizard-done');
await android('ok');
const wizard = await wizardDone;
record('first-run wizard walks welcome → channels → updates → remote check → done with D-pad + OK',
  /WELCOME/.test(step1) && /ADD YOUR CHANNELS/.test(step2) && /UPDATE/.test(step3) && /Press OK/.test(step4) && /ALL SET/.test(step5) && wizard && wizard.updateStrategy === 'manual',
  `${step1} → ${step2} → ${step3} → ${step4} → ${step5} → ${JSON.stringify(wizard)}`);

// plugin actions: Digital Music ◀▶ cycles its station through onAction
const mc = await js(() => { const n = 910; return window.S.config && (async () => { const v = await import('app://bundle/renderer/js/playback/virtual.js'); return v.virtualChannelNumbers().includes(n) ? n : null; })(); });
if (mc) {
  await js(async (n) => { const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js'); await tuneToChannel(n); }, mc);
  await wait(2500);
  const handles = await js(async (n) => (await import('app://bundle/renderer/js/playback/virtual.js')).virtualChannelHandlesActions(n), mc);
  const stationCount = await js(() => ((window.S.config.pluginSettings || {})['digital-music-channel'] || {}).stations?.length || 0);
  const stationBefore = await js(() => document.querySelector('[data-el="station-name"]')?.textContent);
  const handled = await js(async (n) => (await import('app://bundle/renderer/js/playback/virtual.js')).triggerVirtualChannelAction(n, 'move.right'), mc);
  await wait(900);
  const stationAfter = await js(() => document.querySelector('[data-el="station-name"]')?.textContent);
  const onMc = await js(() => window.S.currentNumber);
  await android('chUp'); await wait(1500);
  const leftMc = await js(() => window.S.currentNumber);
  const changed = stationCount < 2 ? true : stationBefore !== stationAfter;
  record('plugin onAction: ▶ reaches Digital Music (station changes when it has 2+), CH ▲ still tunes away', handles && handled && changed && onMc === mc && leftMc !== mc, `handles ${handles}, handled ${handled}, ${stationCount} stations, "${stationBefore}" → "${stationAfter}", on ${onMc}, then ${leftMc}`);
} else {
  record('plugin onAction: Digital Music not installed in this copy', true, 'skipped');
}
await js(async (n) => { const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js'); await tuneToChannel(n); }, firstChannel);
await wait(1200);
await reset();

// gamepad: stub the Gamepad API and press Start then A
await js(() => {
  const state = { buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0], connected: true, mapping: 'standard', index: 0, id: 'fake' };
  window.__pad = state;
  navigator.getGamepads = () => [state];
  window.dispatchEvent(new Event('gamepadconnected'));
});
const pressPad = async (i) => {
  await js((b) => { window.__pad.buttons[b] = { pressed: true, value: 1 }; }, i); await wait(120);
  await js((b) => { window.__pad.buttons[b] = { pressed: false, value: 0 }; }, i); await wait(200);
};
await pressPad(9); // Start
const padMenu = await visible('#shortcuts-overlay');
await pressPad(1); // B
const padClosed = !(await visible('#shortcuts-overlay'));
record('gamepad: Start opens the TV menu and B closes it', padMenu && padClosed, `${padMenu} / ${padClosed}`);
await reset();

// preview TV mode from settings
await setMode('desktop');
await js(() => { document.getElementById('tv-preview-btn').click(); });
await wait(800);
const preview = await js(async () => { const u = await import('app://bundle/renderer/js/tv/usage-mode.js'); return { mode: document.documentElement.dataset.mode, previewing: u.isPreviewingTvMode(), stored: localStorage.getItem('reruntv.usageMode') }; });
await android('playPause'); await wait(250);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'SYSTEM ›'); b && b.focus(); });
await android('ok'); await wait(250);
const endLabel = (await menuLabels()).find((l) => /PREVIEW/.test(l));
record('Preview TV mode is session-only and ends from System', preview.mode === 'tv' && preview.previewing && preview.stored === 'desktop' && endLabel === 'END TV PREVIEW', `${JSON.stringify(preview)} / ${endLabel}`);
await js(async () => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setTvPreview(false));
await reset();

// themes: TV menu list and on-screen keyboard fit on screen
const themes = await js(async () => (await import('app://bundle/renderer/js/plugin/host.js')).themePackEntries().map((e) => e.id));
await setMode('tv');
const problems = [];
for (const id of themes) {
  await js(async (theme) => { window.S.config.theme = theme; const { applyTheme } = await import('app://bundle/renderer/js/display/themes.js'); applyTheme({ boxOnly: true }); }, id);
  await android('playPause'); await wait(250);
  // Sizes in CSS px: .screen applies --display-content-zoom, so on-screen
  // rects shrink with the window while the target stays 64 CSS px.
  const menu = await js(() => { const el = document.activeElement; const f = el.getBoundingClientRect(); return { onScreen: f.top >= 0 && f.bottom <= window.innerHeight, h: el.offsetHeight, minH: getComputedStyle(el).minHeight, list: document.getElementById('tv-menu-grid').classList.contains('tv-menu-list') }; });
  if (!menu.onScreen || !menu.list || parseFloat(menu.minH) < 64) problems.push(`${id} menu ${JSON.stringify(menu)}`);
  await shot(`theme-${id}-menu`);
  await reset();
  js(async () => (await import('app://bundle/renderer/js/ui/on-screen-keyboard.js')).openOnScreenKeyboard({ title: 'TEST' }));
  await wait(300);
  const osk = await js(() => { const p = document.querySelector('.osk-panel')?.getBoundingClientRect(); return p ? { inside: p.top >= 0 && p.bottom <= window.innerHeight + 1 && p.left >= 0 && p.right <= window.innerWidth + 1 } : null; });
  if (!osk || !osk.inside) problems.push(`${id} keyboard ${JSON.stringify(osk)}`);
  if (id === themes[0] || id === 'frutiger-aero') await shot(`theme-${id}-osk`);
  await android('back'); await wait(200);
}
record(`TV menu and keyboard fit on screen with 64 px targets in all ${themes.length} themes`, problems.length === 0, problems.join(' | '));

await setMode('desktop');
await cdp.send('Emulation.clearDeviceMetricsOverride');
record('no page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
console.log('404s:', JSON.stringify([...new Set(notFound)].slice(0, 12)));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
