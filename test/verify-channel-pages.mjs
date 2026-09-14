// Scratch: docs/design/03 §3 — a channel's editor is OVERVIEW · CONTENT · SCHEDULE · LOOK · BREAKS · ADVANCED.
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
const shot = async (name) => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join('test/screenshots', `${name}.png`), Buffer.from(s.data, 'base64')); };

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
const num = await page.evaluate(() => window.S.config.channels.slice().sort((a, b) => a.number - b.number).find((c) => c.files.length > 0).number);
await page.locator(`#channel-list-pane .channel-list-item[data-channel-number="${num}"]`).click();
await wait(600);

const tabs = await page.evaluate((n) => Array.from(document.querySelectorAll(`#channel-list .edit-tab-bar .edit-tab-btn`)).map((b) => b.id.replace(`channel-${n}-edit-tab-`, '')), num);
record('one page bar: overview, content, schedule, look, breaks, advanced', JSON.stringify(tabs) === JSON.stringify(['overview', 'content', 'schedule', 'look', 'breaks', 'advanced']), tabs.join(','));
record('no second group bar and no collapsible OPTIONS row', await page.evaluate(() => !document.querySelector('#channel-list .edit-tab-group-bar, #channel-list .channel-options-header')));

const pageInfo = () => page.evaluate((n) => {
  const panel = document.getElementById(`channel-${n}-edit-panel`);
  return {
    active: document.querySelector('#channel-list .edit-tab-btn.active')?.id.replace(`channel-${n}-edit-tab-`, ''),
    groups: Array.from(panel.querySelectorAll('.channel-option-group-title')).map((t) => t.textContent),
    sections: Array.from(panel.querySelectorAll(':scope > .edit-section')).map((s) => s.dataset.editSection),
  };
}, num);

const expectations = {
  overview: (p) => JSON.stringify(p.groups) === JSON.stringify(['LINEUP', 'RATING & VOLUME']),
  content: (p) => JSON.stringify(p.sections) === JSON.stringify(['folders', 'titles']),
  schedule: (p) => p.sections.length === 0,
  look: (p) => JSON.stringify(p.sections) === JSON.stringify(['logo', 'overlays', 'ticker', 'identity']),
  breaks: (p) => JSON.stringify(p.sections) === JSON.stringify(['ads', 'credits']),
  advanced: (p) => JSON.stringify(p.groups) === JSON.stringify(['PICTURE', 'AUDIO & CAPTIONS', 'ON-SCREEN EXTRAS']),
};
for (const id of Object.keys(expectations)) {
  await page.locator(`#channel-${num}-edit-tab-${id}`).click();
  await wait(id === 'content' ? 1500 : 500);
  const p = await pageInfo();
  record(`${id.toUpperCase()} shows its parts`, p.active === id && expectations[id](p), JSON.stringify(p));
  await shot(`channel-page-${id}`);
}

// An edit on OVERVIEW saves, re-renders, and stays on OVERVIEW.
await page.locator(`#channel-${num}-edit-tab-overview`).click();
await wait(300);
const fav = await page.evaluate((n) => window.S.config.channels.find((c) => c.number === n).favorite, num);
await page.evaluate(() => {
  const label = Array.from(document.querySelectorAll('#channel-list .channel-option-group label.shuffle-toggle')).find((l) => /FAVORITE/.test(l.textContent));
  label.querySelector('input').click();
});
await wait(400);
const after = await page.evaluate((n) => window.S.config.channels.find((c) => c.number === n).favorite, num);
record('a change on OVERVIEW saves', after === !fav, `${fav} → ${after}`);
await page.keyboard.press('Control+z');
await wait(600);
record('undo restores it and the editor stays on OVERVIEW', await page.evaluate((n) => window.S.config.channels.find((c) => c.number === n).favorite, num) === fav && (await pageInfo()).active === 'overview');

// The page is remembered per channel, and an old stored sub-tab id maps to its page.
await page.locator(`#channel-${num}-edit-tab-breaks`).click();
await wait(300);
const other = await page.evaluate((n) => window.S.config.channels.slice().sort((a, b) => a.number - b.number).find((c) => c.number !== n).number, num);
await page.locator(`#channel-list-pane .channel-list-item[data-channel-number="${other}"]`).click();
await wait(500);
await page.locator(`#channel-list-pane .channel-list-item[data-channel-number="${num}"]`).click();
await wait(500);
record('coming back to a channel reopens the page last used on it', (await pageInfo()).active === 'breaks');

// Arrow keys move along the page bar.
await page.locator(`#channel-${num}-edit-tab-breaks`).focus();
await page.keyboard.press('ArrowRight');
await wait(400);
record('ArrowRight moves to the next page', (await pageInfo()).active === 'advanced');

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
