// Scratch: docs/design/03 §7 keyboard — G then a letter, J/K in lists, Enter into and Esc out of detail panes.
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const activeTab = () => page.evaluate(() => document.querySelector('.setup-tab-btn.active')?.dataset.tab);
const focusInfo = () => page.evaluate(() => {
  const el = document.activeElement;
  return { id: el?.id, cls: el?.className?.toString(), inDetail: !!el?.closest('#channel-list, .list-detail-detail, .flow-detail'), channel: el?.dataset?.channelNumber, flow: el?.dataset?.flowId };
});

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await page.locator('.setup-tab-btn[data-tab="channels"]').focus();

const jumps = [['l', 'library'], ['s', 'display'], ['g', 'guide'], ['h', 'household'], ['y', 'audio'], ['u', 'plugins'], ['p', 'programming'], ['c', 'channels']];
const landed = [];
for (const [letter, tab] of jumps) {
  await page.keyboard.press('g');
  await page.keyboard.press(letter);
  await wait(250);
  landed.push(`${letter}:${await activeTab() === tab ? 'ok' : await activeTab()}`);
}
record('G then a letter opens each section', landed.every((x) => x.endsWith(':ok')), landed.join(' '));

// A lone letter does nothing; G in a text field types.
await page.keyboard.press('y');
await wait(200);
record('a letter without G does not jump', await activeTab() === 'channels');
await page.locator('#setup-search').fill('');
await page.locator('#setup-search').focus();
await page.keyboard.type('gy');
await wait(200);
const typed = await page.evaluate(() => document.getElementById('setup-search').value);
record('G then Y inside the search box just types', typed === 'gy' && await activeTab() === 'channels', typed);
await page.keyboard.press('Escape');
await page.locator('#setup-search').fill('');

// Channels: J/K, Enter into the editor, Esc back.
const first = page.locator('#channel-list-pane .channel-list-item.selected');
await first.focus();
const start = (await focusInfo()).channel;
await page.keyboard.press('j');
await wait(500);
const afterJ = await focusInfo();
await page.keyboard.press('k');
await wait(500);
const afterK = await focusInfo();
record('J and K move the channel selection down and up', afterJ.channel && afterJ.channel !== start && afterK.channel === start, `${start} → ${afterJ.channel} → ${afterK.channel}`);
await page.keyboard.press('Enter');
await wait(400);
const intoDetail = await focusInfo();
record('Enter on the selected channel moves focus into its editor', intoDetail.inDetail, JSON.stringify(intoDetail));
await page.keyboard.press('Escape');
await wait(300);
const back = await focusInfo();
record('Esc in the editor returns to the selected channel row', back.channel === start, JSON.stringify(back));

// Flows: same keys on another list + detail.
await page.keyboard.press('g');
await page.keyboard.press('p');
await wait(300);
await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="flows"]').click();
await wait(500);
await page.locator('#flow-list .flow-list-item.selected').focus();
const flowStart = (await focusInfo()).flow;
await page.keyboard.press('j');
await wait(400);
const flowJ = await focusInfo();
await page.keyboard.press('Enter');
await wait(300);
const flowIn = await focusInfo();
await page.keyboard.press('Escape');
await wait(300);
const flowBack = await focusInfo();
record('flows: J moves, Enter goes into the editor, Esc comes back', flowJ.flow && flowJ.flow !== flowStart && flowIn.inDetail && flowBack.flow === flowJ.flow, `${flowStart} → ${flowJ.flow}; in=${flowIn.inDetail}; back=${flowBack.flow}`);
await page.keyboard.press('k');
await wait(300);

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
