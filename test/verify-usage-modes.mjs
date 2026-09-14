// Scratch: docs/design/01 Phase A — usage modes and TV-mode remote input,
// driven with trusted key events (CDP) and the Android bridge entry point,
// against the real installed lineup.
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const visible = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.classList.contains('hidden'); }, sel);
const state = () => page.evaluate(() => ({
  mode: document.documentElement.dataset.mode,
  channel: window.S.currentNumber,
  guideRow: window.S.guideSelRowIdx,
  muted: !!window.S.config.muted,
  focused: document.activeElement && document.activeElement.textContent,
}));
const press = async (key, holdMs = 0) => {
  await page.keyboard.down(key);
  if (holdMs) await wait(holdMs);
  await page.keyboard.up(key);
  await wait(250);
};

await wait(4000);
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => {
  const mode = await import('app://bundle/renderer/js/usage-mode.js');
  mode.setUsageModePreference('auto');
  const { tuneToChannel } = await import('app://bundle/renderer/js/playback-core.js');
  const first = window.S.config.channels.slice().sort((a, b) => a.number - b.number)[0].number;
  await tuneToChannel(first);
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
});
await wait(1500);

// ---- desktop (the default for Electron): nothing new happens ----
let s = await state();
record('Electron starts in desktop mode', s.mode === 'desktop', s.mode);
await press('ArrowLeft');
record('desktop: ◀ on live TV does not open the guide (unchanged)', !(await visible('#guide-grid')));
await press('Escape');
record('desktop: Escape on live TV shows no exit prompt (unchanged)', !(await visible('#tv-exit-prompt')));
const desktopHints = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('#hint-bar > span'));
  const shown = (el) => getComputedStyle(el).display !== 'none';
  return { tv: spans.filter((el) => el.dataset.hintMode === 'tv' && shown(el)).length, desktop: spans.filter((el) => el.dataset.hintMode !== 'tv' && shown(el) && !el.classList.contains('hidden')).length };
});
record('desktop hint bar shows letter hints, no remote hints', desktopHints.tv === 0 && desktopHints.desktop > 0, JSON.stringify(desktopHints));

// ---- switch this device to TV mode from settings ----
await page.evaluate(async () => {
  const el = document.getElementById('usage-mode-select');
  el.value = 'tv';
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await wait(300);
s = await state();
const tvHints = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('#hint-bar > span'));
  const shown = (el) => getComputedStyle(el).display !== 'none';
  return { tv: spans.filter((el) => el.dataset.hintMode === 'tv' && shown(el)).map((el) => el.textContent), desktop: spans.filter((el) => el.dataset.hintMode !== 'tv' && shown(el)).length, status: document.getElementById('usage-mode-status').textContent, stored: localStorage.getItem('reruntv.usageMode') };
});
record('the settings choice switches this device to TV mode and is stored locally', s.mode === 'tv' && tvHints.stored === 'tv' && /TV \(DEVICE CHOICE\)/.test(tvHints.status), tvHints.status);
record('TV hint bar names remote buttons only', tvHints.desktop === 0 && tvHints.tv.length === 5, tvHints.tv.join(' | '));

// ---- watching ----
const ch0 = (await state()).channel;
await press('ArrowUp');
await wait(600);
const ch1 = (await state()).channel;
record('TV: ▲ on live TV still changes channel', ch1 !== ch0, `${ch0} -> ${ch1}`);

await press('ArrowLeft');
record('TV: ◀ on live TV opens the guide', await visible('#guide-grid'));
const rowBefore = (await state()).guideRow;
await press('ArrowDown');
const afterDown = await state();
record('TV: ▼ in the guide moves one row and does not change channel', afterDown.guideRow === rowBefore + 1 && afterDown.channel === ch1, `${rowBefore} -> ${afterDown.guideRow}, CH ${afterDown.channel}`);
await press('PageDown');
const afterPage = await state();
record('TV: CH▼ pages the guide by more than one row', afterPage.guideRow > afterDown.guideRow + 1, `${afterDown.guideRow} -> ${afterPage.guideRow}`);
await press('Escape');
record('TV: Back closes the guide', !(await visible('#guide-grid')));

await press('Enter', 60);
await wait(200);
record('TV: a short OK shows the channel banner, not the menu', (await visible('#guide-overlay')) && !(await visible('#shortcuts-overlay')));
await press('Enter', 750);
const menu = await page.evaluate(() => ({ open: !document.getElementById('shortcuts-overlay').classList.contains('hidden'), labels: Array.from(document.querySelectorAll('.tv-menu-btn')).map((b) => b.textContent), hint: document.querySelector('#shortcuts-overlay .shortcuts-hint').textContent }));
record('TV: holding OK opens the TV menu, which offers DESKTOP MODE', menu.open && menu.labels.includes('DESKTOP MODE') && /BACK TO CLOSE/.test(menu.hint), menu.hint);
await press('Escape');
record('TV: Back closes the TV menu', !(await visible('#shortcuts-overlay')));
await page.keyboard.press('MediaPlayPause');
await wait(250);
record('TV: Play/Pause opens the TV menu', await visible('#shortcuts-overlay'));
await page.keyboard.press('MediaPlayPause');
await wait(250);
record('TV: Play/Pause closes it again', !(await visible('#shortcuts-overlay')));

// ---- exit prompt ----
await page.evaluate(() => { const g = document.getElementById('guide-overlay'); if (g) g.classList.add('hidden'); });
await press('Escape');
const prompt = await page.evaluate(() => ({
  open: !!document.querySelector('#tv-exit-prompt:not(.hidden)'),
  focused: document.activeElement && document.activeElement.textContent,
  buttons: Array.from(document.querySelectorAll('#tv-exit-prompt button')).map((b) => b.textContent),
}));
record('TV: Back on bare live TV asks before leaving, focused on KEEP WATCHING', prompt.open && prompt.focused === 'KEEP WATCHING' && prompt.buttons.includes('EXIT'), prompt.buttons.join(', '));
const mutedBefore = (await state()).muted;
await press('m');
await press('ArrowRight');
const inPrompt = await state();
record('TV: the prompt is modal (letters do nothing behind it) and ▶ moves focus', inPrompt.muted === mutedBefore && inPrompt.focused === 'STANDBY', inPrompt.focused);
await press('Escape');
record('TV: Back closes the prompt and keeps watching', !(await visible('#tv-exit-prompt')) && (await page.evaluate(() => window.S.isPoweredOn)));

// ---- Android bridge entry point ----
const bridge = await page.evaluate(async () => {
  const r = {};
  const pause = (ms) => new Promise((res) => { setTimeout(res, ms); });
  r.version = window.RerunTVInput.version;
  r.left = window.RerunTVInput.native({ key: 'left' });
  await pause(700);
  r.guideOpen = !document.getElementById('guide-grid').classList.contains('hidden');
  r.back = window.RerunTVInput.native({ key: 'back' });
  await pause(900);
  r.guideClosed = document.getElementById('guide-grid').classList.contains('hidden');
  r.long = window.RerunTVInput.native({ key: 'ok', longPress: true });
  await pause(300);
  r.menuOpen = !document.getElementById('shortcuts-overlay').classList.contains('hidden');
  window.RerunTVInput.native({ key: 'back' });
  await pause(500);
  r.unknown = window.RerunTVInput.native({ key: 'nonsense' });
  return r;
});
record('Android bridge: RerunTVInput.native routes ◀, Back and long OK the same way', bridge.version === 1 && bridge.guideOpen && bridge.guideClosed && bridge.menuOpen && bridge.back === 'handled' && bridge.unknown === 'ignored', JSON.stringify(bridge));

// ---- cursor ----
await page.mouse.move(200, 200);
await page.mouse.move(210, 205);
await wait(3300);
record('TV: the cursor hides after 3 s without pointer movement', await page.evaluate(() => document.documentElement.classList.contains('cursor-idle')));
await page.mouse.move(250, 250);
await wait(100);
record('TV: moving the pointer brings the cursor back', await page.evaluate(() => !document.documentElement.classList.contains('cursor-idle')));

// ---- back to desktop from the TV menu, with a remote ----
await page.evaluate(() => window.RerunTVInput.native({ key: 'ok', longPress: true }));
await wait(200);
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.tv-menu-btn')).find((x) => x.textContent === 'DESKTOP MODE'); b.focus(); });
await press('Enter');
s = await state();
await press('ArrowLeft');
record('DESKTOP MODE in the TV menu switches back, and ◀ is inert again', s.mode === 'desktop' && !(await visible('#guide-grid')), s.mode);

// ---- launch flag ----
await page.evaluate(() => { localStorage.removeItem('reruntv.usageMode'); });
await page.goto(`${page.url().split('?')[0]}?mode=tv`);
await wait(6000);
const flagged = await page.evaluate(async () => {
  const mode = await import('app://bundle/renderer/js/usage-mode.js');
  return { mode: mode.usageMode(), source: mode.usageModeSource(), attr: document.documentElement.dataset.mode };
});
record('?mode=tv (what --mode=tv adds) starts in TV mode when the device has no choice', flagged.mode === 'tv' && flagged.source === 'launch flag' && flagged.attr === 'tv', JSON.stringify(flagged));
await page.goto(page.url().split('?')[0]);
await wait(5000);

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
