// Scratch: docs/design/03 §4 sidebar — attention badges and the icon rail below 1100 px.
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
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
const cdp = await page.context().newCDPSession(page);
const shot = async (name) => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join('tests/ui/screenshots', `${name}.png`), Buffer.from(s.data, 'base64')); };

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(2000);

const badges = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#setup-tabs .setup-tab-btn')).map((b) => [b.dataset.tab, b.dataset.badge || ''])));
let b = await badges();
const expected = await page.evaluate(async () => {
  const plugins = await window.api.pluginsList();
  return { empty: window.S.config.channels.filter((c) => !(c.files || []).length).length, plugins: plugins.length };
});
record('plug-ins shows a badge when plugins need attention', /^\d+$/.test(b.plugins) && Number(b.plugins) > 0, JSON.stringify(b));
record('channels badge counts channels with nothing to play', (b.channels || '0') === String(expected.empty || 0).replace(/^0$/, '0') || (!b.channels && expected.empty === 0), `${b.channels} vs ${expected.empty}`);
const texts = await page.evaluate(() => Array.from(document.querySelectorAll('#setup-tabs .setup-tab-btn')).map((x) => x.textContent.trim()));
const crumb = await page.evaluate(() => { document.querySelector('.setup-tab-btn[data-tab="plugins"]').click(); return document.getElementById('setup-page-title').textContent; });
record('badges never change the section names (text, title, search)', texts.includes('PLUG-INS') && texts.includes('CHANNELS') && crumb === 'PLUGINS', texts.join('|'));
const label = await page.evaluate(() => document.querySelector('.setup-tab-btn[data-tab="plugins"]').getAttribute('aria-label'));
record('the badge is announced in the section’s accessible name', /PLUG-INS, \d+ need attention/.test(label || ''), label);

// Adding an empty channel raises the channels badge; undo lowers it.
const before = Number(b.channels || 0);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await page.locator('#add-channel-btn').click();
await wait(700);
b = await badges();
const raised = Number(b.channels || 0);
await page.keyboard.press('Control+z');
await wait(700);
b = await badges();
record('adding an empty channel raises the badge and undo lowers it', raised === before + 1 && Number(b.channels || 0) === before, `${before} → ${raised} → ${b.channels || 0}`);
await shot('sidebar-badges');

// Icon rail below 1100 px.
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
await wait(600);
const rail = await page.evaluate(() => {
  const side = document.querySelector('.setup-sidebar').getBoundingClientRect();
  const btn = document.querySelector('.setup-tab-btn[data-tab="audio"]');
  const content = document.getElementById('setup-content');
  return { width: Math.round(side.width), btnFont: getComputedStyle(btn).webkitTextFillColor, icon: getComputedStyle(btn, '::before').content, title: btn.title, hScroll: content.scrollWidth > content.clientWidth + 1 };
});
record('below 1100 px the sidebar is a 64 px icon rail with tooltips', rail.width === 64 && rail.btnFont === "rgba(0, 0, 0, 0)" && rail.icon !== 'none' && /SYSTEM/.test(rail.title) && !rail.hScroll, JSON.stringify(rail));
await shot('sidebar-rail-1024');
await page.locator('.setup-tab-btn[data-tab="household"]').click();
await wait(300);
record('icon buttons still open their sections', await page.evaluate(() => document.querySelector('.setup-tab-btn.active').dataset.tab) === 'household');
await cdp.send('Emulation.clearDeviceMetricsOverride');

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
