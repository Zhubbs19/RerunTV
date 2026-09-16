// Scratch: docs/design/03 §4 — below 900 px, list → detail with Back.
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
const vis = (sel) => page.evaluate((q) => { const el = document.querySelector(q); return !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none'; }, sel);

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

// Wide: both panes, no Back.
record('wide: list and editor side by side, no Back button', await vis('#channel-list-pane') && await vis('#channel-list') && !(await vis('.channel-master-detail > .list-detail-back')));

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 700, deviceScaleFactor: 1, mobile: false });
await wait(600);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(300);
record('narrow: channels shows the list only', await vis('#channel-list-pane') && !(await vis('#channel-list')), '');
await shot('narrow-channels-list');
await page.locator('#channel-list-pane .channel-list-item').nth(2).click();
await wait(600);
const opened = { list: await vis('#channel-list-pane'), detail: await vis('#channel-list'), back: await vis('.channel-master-detail > .list-detail-back') };
record('choosing a channel swaps to its editor with Back', !opened.list && opened.detail && opened.back, JSON.stringify(opened));
await shot('narrow-channels-detail');
await page.locator('.channel-master-detail > .list-detail-back').click();
await wait(300);
const focusedRow = await page.evaluate(() => document.activeElement?.matches('.channel-list-item.selected'));
record('Back returns to the list with the chosen row focused', await vis('#channel-list-pane') && !(await vis('#channel-list')) && focusedRow);
await page.keyboard.press('Enter');
await wait(500);
record('Enter on a row opens it too', await vis('#channel-list') && !(await vis('#channel-list-pane')));
await page.keyboard.press('Enter');
await wait(300);
await page.keyboard.press('Escape');
await wait(300);
record('Esc in the editor goes back to the list', await vis('#channel-list-pane') && !(await vis('#channel-list')));

// Plugins: the enable checkbox does not open the detail; the row does.
await page.locator('.setup-tab-btn[data-tab="plugins"]').click();
await wait(1500);
await page.evaluate(() => { const box = document.querySelector('#plugins-list .plugin-entry:not(.filtered-out) input[type=checkbox]'); box.click(); box.click(); });
await wait(200);
record('plugins: toggling the checkbox stays on the list', await vis('#plugins-list') && !(await vis('#plugins-detail')));
await page.locator('#plugins-list .plugin-entry:not(.filtered-out) .plugin-row-name').first().click();
await wait(400);
record('plugins: choosing a row opens its detail', await vis('#plugins-detail') && !(await vis('#plugins-list')));
await shot('narrow-plugins-detail');
await page.locator('.plugins-list-detail > .list-detail-back').click();

// No horizontal scroll at this width on the collections.
const h = await page.evaluate(() => { const c = document.getElementById('setup-content'); return c.scrollWidth > c.clientWidth + 1; });
record('no horizontal scroll at 820 px', !h);

await cdp.send('Emulation.clearDeviceMetricsOverride');
await wait(400);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(300);
record('back to wide: both panes again', await vis('#channel-list-pane') && await vis('#channel-list'));
record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
