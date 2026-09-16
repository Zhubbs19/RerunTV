// Scratch: the setup shell (header, sub-tab row) must never be scrolled out of place.
// Only #setup-content scrolls. Drives search, keyboard jumps, focus moves and list selection,
// and checks every shell ancestor's scrollTop and the header's position after each.
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const cdp = await page.context().newCDPSession(page);

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);
if (!process.env.NATIVE_SIZE) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await wait(500);

const shift = () => page.evaluate(() => {
  const moved = Array.from(document.querySelectorAll('html, body, #setup-screen, .setup-panel, .setup-shell, .setup-main, .setup-nav, .setup-sidebar, .screen, .display-frame-control-center'))
    .filter((el) => el.scrollTop > 0 || el.scrollLeft > 0)
    .map((el) => `${el.id || el.className.toString().split(' ')[0] || el.tagName}:${el.scrollTop}/${el.scrollLeft}`);
  const navTop = Math.round(document.querySelector('#setup-screen .setup-nav').getBoundingClientRect().top);
  return { moved, navTop };
});
const problems = [];
const check = async (step) => {
  await wait(450);
  const s = await shift();
  if (s.moved.length || s.navTop !== 0) problems.push(`${step}: ${JSON.stringify(s)}`);
};

// Search results that open over the page, then choose settings far down long pages.
for (const q of ['dynamic overlays', 'custom sound', 'hint bar items', 'release notes', 'library sync', 'guide genre']) {
  await page.locator('#setup-search').click();
  await page.keyboard.type(q);
  await wait(300);
  await check(`search typed "${q}"`);
  await page.keyboard.press('Enter');
  await check(`search chose "${q}"`);
}
// Ctrl+K from deep in a page, arrow through results, Esc.
await page.keyboard.press('Control+k');
await page.keyboard.type('a');
for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowDown');
await check('arrowing through search results');
await page.keyboard.press('Escape');
await check('closing search');

// Section jumps and Tab-key focus walking through a long page.
for (const k of ['l', 's', 'g', 'y', 'u', 'p', 'c']) {
  await page.keyboard.press('Escape');
  await page.locator('#setup-content').click({ position: { x: 4, y: 4 } }).catch(() => {});
  await page.keyboard.press('g');
  await page.keyboard.press(k);
  await check(`G then ${k}`);
  for (let i = 0; i < 25; i += 1) await page.keyboard.press('Tab');
  await check(`tabbing through section ${k}`);
}

// Channel list: selection, Enter into the editor, pages.
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
const rows = page.locator('#channel-list-pane .channel-list-item');
for (const n of [6, 1, 9]) {
  await rows.nth(n).click();
  await check(`select channel row ${n}`);
}
await page.keyboard.press('Enter');
await check('Enter into channel editor');
for (const id of ['content', 'look', 'breaks']) {
  await page.locator(`#channel-list .edit-tab-btn[id$="-edit-tab-${id}"]`).click();
  await check(`channel page ${id}`);
}

console.log(problems.join('\n'));
record('the header and sub-tab row never move: only #setup-content scrolls', problems.length === 0, `${problems.length} problem(s)`);
await cdp.send('Emulation.clearDeviceMetricsOverride');
record('no renderer page errors', errors.length === 0, errors.slice(0, 3).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
