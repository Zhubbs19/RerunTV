// Scratch: docs/design/10 (eras as a presentation layer) against the real
// lineup. Exercises the ERA panel in Guide & theme setup, the box override
// mechanics, apply-then-clear (the doc's own acceptance test), and the TV
// menu's Left/Right era stepping. Run through run-ui-tests.ps1 -Script verify-doc10.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'doc10-out');
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

const snapshotFields = () => js(() => ({
  theme: window.S.config.theme, crtEnabled: window.S.config.crtEnabled,
  crtIntensity: { ...window.S.config.crtIntensity }, displayMode: { ...window.S.config.displayMode },
  clock24: window.S.config.display.clock24,
}));

await js(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(300);
await page.locator('.setup-tab-btn[data-tab="guide"]').click();
await wait(400);

const before = await snapshotFields();
record('starting point captured with no era active', await js(() => !window.S.config.era));

// ---------------- apply an era from the setup panel ----------------
const applied = await js(() => {
  const btn = Array.from(document.querySelectorAll('#era-picker button')).find((b) => /1994/.test(b.textContent));
  if (!btn) return false;
  btn.click();
  return true;
});
await wait(400);
await shot('era-1994-applied');
const after1994 = await snapshotFields();
record('clicking a built-in era in the setup panel changes theme, CRT, display mode and clock together', applied
  && after1994.theme === 'scrolling-guide-94' && after1994.crtEnabled === true
  && after1994.displayMode.resolution === 'sd480' && after1994.clock24 === false, JSON.stringify(after1994));

const domReflects = await js(() => ({
  themeLabel: document.getElementById('theme-browser-current-label')?.textContent,
  crtChecked: document.getElementById('crt-enabled')?.checked,
  resolution: document.getElementById('display-mode-resolution-select')?.value,
  clock24: document.getElementById('clock24-enabled')?.checked,
}));
record('setup-screen controls (theme label, CRT checkbox, resolution select, clock) resync after an era apply', /guide|scroll|94/i.test(domReflects.themeLabel || '') && domReflects.crtChecked === true && domReflects.resolution === 'sd480' && domReflects.clock24 === false, JSON.stringify(domReflects));

const notesShown = await js(() => document.getElementById('era-notes')?.textContent || '');
record('the era notes panel explains the era\'s choices', /1994/.test(notesShown) && notesShown.length > 20, notesShown.slice(0, 80));

const fieldRows = await js(() => Array.from(document.getElementById('era-fields-list').children).map((r) => r.textContent));
record('every field the era set is listed with its source in setup (doc 10 §8)', fieldRows.length >= 8 && fieldRows.every((r) => /SET BY ERA/.test(r)), `${fieldRows.length} rows`);

// ---------------- override one field, see it flip to a box exception ----------------
const overrode = await js(() => {
  const el = document.getElementById('crt-enabled');
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
});
await wait(300);
await shot('era-field-overridden');
const overrideRow = await js(() => Array.from(document.getElementById('era-fields-list').children).find((r) => /CRT EFFECT/.test(r.textContent))?.textContent);
record('hand-changing an era-controlled setting marks it a box override, not a broken era', overrode && /BOX OVERRIDE/.test(overrideRow || ''), overrideRow);

const resetWorked = await js(() => {
  const row = Array.from(document.getElementById('era-fields-list').children).find((r) => /CRT EFFECT/.test(r.textContent));
  const btn = row && Array.from(row.querySelectorAll('button')).find((b) => /RESET TO ERA/.test(b.textContent));
  if (!btn) return false;
  btn.click();
  return true;
});
await wait(300);
const afterReset = await js(() => ({ crtEnabled: window.S.config.crtEnabled, row: Array.from(document.getElementById('era-fields-list').children).find((r) => /CRT EFFECT/.test(r.textContent))?.textContent }));
record('RESET TO ERA restores just that field and its source back to "era"', resetWorked && afterReset.crtEnabled === true && /SET BY ERA/.test(afterReset.row || ''), JSON.stringify(afterReset));

// ---------------- re-override, then clear the whole era: override survives, everything else restores ----------------
await js(() => {
  const el = document.getElementById('crt-enabled');
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await wait(300);
const cleared = await js(() => {
  const btn = Array.from(document.querySelectorAll('#era-picker button')).find((b) => /NO ERA/.test(b.textContent));
  if (!btn) return false;
  btn.click();
  return true;
});
await wait(400);
await shot('era-cleared-with-override');
const afterClear = await snapshotFields();
const eraGone = await js(() => !window.S.config.era);
record('clearing the era with an active override restores everything except that override', cleared && eraGone
  && afterClear.crtEnabled === false // the override survives
  && afterClear.theme === before.theme && afterClear.displayMode.resolution === before.displayMode.resolution && afterClear.clock24 === before.clock24,
  JSON.stringify({ before, afterClear }));

// ---------------- clean apply/clear with no overrides: config diff empty (doc 10 §8's own test) ----------------
await js(() => { const btn = Array.from(document.querySelectorAll('#era-picker button')).find((b) => /1994/.test(b.textContent)); btn.click(); });
await wait(300);
await js(() => { const btn = Array.from(document.querySelectorAll('#era-picker button')).find((b) => /NO ERA/.test(b.textContent)); btn.click(); });
await wait(300);
const afterCleanCycle = await snapshotFields();
const eraGone2 = await js(() => !window.S.config.era);
record('apply then clear with no overrides restores every value exactly (config diff empty)', eraGone2 && JSON.stringify(afterCleanCycle) === JSON.stringify(before), JSON.stringify(afterCleanCycle));

// ---------------- TV menu: Guide & Theme > ERA steps with Left/Right ----------------
await js(() => document.getElementById('done-btn')?.click());
await wait(300);
await js(async () => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('tv'));
await wait(300);
const K = { up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, playPause: 85 };
const android = (name) => js((e) => window.RerunTVInput.native(e), { source: 'android', keyCode: K[name], action: 'down' });
await android('playPause'); await wait(300);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'SETUP ›'); b && b.focus(); });
await android('ok'); await wait(300);
await js(() => { const b = Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).find((x) => x.textContent === 'GUIDE & THEME ›'); b && b.focus(); });
await android('ok'); await wait(300);
const labelsBefore = await js(() => Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).map((b) => b.textContent.trim()));
await shot('tv-menu-guide-theme');
await js(() => { const b = document.querySelectorAll('#tv-menu-grid .tv-menu-btn')[0]; b && b.focus(); });
await android('right'); await wait(400);
const labelsAfter = await js(() => Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).map((b) => b.textContent.trim()));
const tvTheme = await js(() => ({ theme: window.S.config.theme, era: window.S.config.era?.id }));
record('TV menu GUIDE & THEME lists ERA first, and ▶ steps it to the next built-in era', /^ERA:/.test(labelsBefore[0]) && labelsAfter[0] !== labelsBefore[0] && !!tvTheme.era, `${labelsBefore[0]} -> ${labelsAfter[0]} (${JSON.stringify(tvTheme)})`);
await android('left'); await wait(300);
await android('back'); await wait(200);

// reset for a clean exit
await js(() => { const btn = Array.from(document.querySelectorAll('#era-picker button')).find((b) => /NO ERA/.test(b.textContent)); if (btn) btn.click(); });
await js(async () => (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('desktop'));
await wait(200);

record('no page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
