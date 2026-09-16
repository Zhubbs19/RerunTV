// Scratch: docs/design/03 step 2 — the CHANNELS list + detail, on the real lineup.
import { chromium } from 'playwright-core';
import path from 'node:path';

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
const shot = (name) => page.screenshot({ path: path.join('tests/ui/screenshots', `${name}.png`) });

await wait(4000);
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1500);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(500);

const view = () => page.evaluate(() => ({
  items: Array.from(document.querySelectorAll('#channel-list-pane .channel-list-item')).map((el) => el.dataset.channelNumber),
  selected: document.querySelector('#channel-list-pane .channel-list-item.selected')?.dataset.channelNumber,
  cards: Array.from(document.querySelectorAll('#channel-list .channel-row')).map((el) => el.dataset.channelNumber),
  editorOpen: !!document.querySelector('#channel-list .edit-panel:not(.hidden) .edit-tab-content'),
  channelCount: window.S.config.channels.length,
  focused: document.activeElement && document.activeElement.dataset && document.activeElement.dataset.channelNumber,
}));

let v = await view();
record('the lineup is a compact list with one editor card (the selection) beside it', v.items.length >= v.channelCount && v.cards.length === 1 && v.cards[0] === v.selected && v.editorOpen, `${v.items.length} rows, card CH ${v.cards[0]}`);
const listHeight = await page.evaluate(() => Math.round(document.getElementById('channel-list-pane').scrollHeight));
record('the whole lineup fits in a short list (was ~300+ px per channel)', listHeight < 70 * (v.channelCount + 2), `${listHeight}px for ${v.channelCount} channels`);
await shot('channels-list-detail');

// Click and keyboard selection.
const third = v.items[2];
await page.locator(`#channel-list-pane .channel-list-item[data-channel-number="${third}"]`).click();
await wait(300);
v = await view();
record('clicking a row shows that channel in the detail pane', v.selected === third && v.cards[0] === third, `CH ${v.cards[0]}`);
await page.keyboard.press('ArrowDown');
await wait(300);
v = await view();
record('▼ in the list selects the next channel and keeps focus in the list', v.selected === v.items[3] && v.cards[0] === v.items[3] && v.focused === v.items[3], `CH ${v.selected}`);

// Rename from the detail pane reflects in the list.
const nameInput = page.locator('#channel-list .channel-row input[placeholder="CHANNEL NAME"]');
const oldName = await nameInput.inputValue();
await nameInput.fill(`${oldName} X`);
await page.keyboard.press('Tab');
await wait(200);
await page.evaluate(async () => { (await import('app://bundle/renderer/js/setup/channels.js')).renderChannelList(); });
await wait(200);
const listName = await page.evaluate((n) => document.querySelector(`#channel-list-pane .channel-list-item[data-channel-number="${n}"] .channel-list-name`).textContent, v.selected);
record('renaming in the editor shows in the list row', listName === `${oldName} X`, listName);
await page.evaluate(async () => { const st = await import('app://bundle/renderer/js/core/state.js'); st.performUndo(); });

// Swap down keeps the same channel selected under its new number.
const before = await page.evaluate(() => {
  const sel = document.querySelector('#channel-list-pane .channel-list-item.selected').dataset.channelNumber;
  return { sel, name: window.S.config.channels.find((c) => String(c.number) === sel).name };
});
await page.locator('#channel-list .channel-card-menu-btn').click();
await page.locator('.row-menu .row-menu-item', { hasText: 'Move down' }).click();
await wait(300);
const afterSwap = await page.evaluate(() => {
  const sel = document.querySelector('#channel-list-pane .channel-list-item.selected').dataset.channelNumber;
  return { sel, name: window.S.config.channels.find((c) => String(c.number) === sel).name };
});
record('swapping a channel down keeps it selected at its new number', afterSwap.name === before.name && afterSwap.sel !== before.sel, `${before.sel} -> ${afterSwap.sel}`);

// Add selects the new channel; remove selects a neighbour.
await page.locator('#add-channel-btn').click();
await wait(400);
v = await view();
const added = await page.evaluate(() => window.S.config.channels.find((c) => !c.name && !c.files.length));
record('+ ADD CHANNEL selects the new channel', added && v.selected === String(added.number) && v.cards[0] === String(added.number), `CH ${v.selected}`);
page.once('dialog', () => {});
await page.locator('#channel-list .channel-row .channel-card-menu-btn').click();
await page.locator('.row-menu .row-menu-item', { hasText: 'Remove channel' }).click();
await wait(300);
const confirm = page.locator('.confirm-dialog button', { hasText: /REMOVE|OK|CONFIRM|YES/ }).last();
if (await confirm.count()) await confirm.click();
await wait(500);
v = await view();
record('removing it selects a neighbouring channel', v.channelCount === added ? false : !v.items.includes(String(added.number)) && !!v.selected && v.cards.length === 1, `CH ${v.selected}`);

// Ctrl+click a second channel: the detail pane becomes the bulk bar.
await page.locator('#channel-list-pane .channel-list-item').nth(1).click({ modifiers: ['Control'] });
await wait(300);
const barVisible = await page.evaluate(() => !!document.querySelector('#channel-list #bulk-actions-bar:not(.hidden)'));
record('Ctrl+click selects several channels and shows the bulk bar in the detail pane', barVisible);
await page.keyboard.press('Escape');
await wait(200);

// Filter narrows the list and keeps a valid selection.
await page.locator('#channel-filter').fill('zzzz-no-match');
await page.evaluate(() => document.getElementById('channel-filter').dispatchEvent(new Event('input', { bubbles: true })));
await wait(300);
const noMatch = await page.evaluate(() => document.getElementById('channel-list').textContent);
await page.locator('#channel-filter').fill('');
await page.evaluate(() => document.getElementById('channel-filter').dispatchEvent(new Event('input', { bubbles: true })));
await wait(300);
v = await view();
record('a filter with no match says so; clearing it restores the list and a selection', /no channels match|plugin/i.test(noMatch) && v.items.length >= v.channelCount && !!v.selected);

// Plugin channels are their own list entry.
const pluginsItem = page.locator('#channel-list-pane .channel-list-plugins');
if (await pluginsItem.count()) {
  await pluginsItem.click();
  await wait(300);
  const pluginRows = await page.locator('#channel-list .plugin-channel-row').count();
  record('PLUGIN CHANNELS in the list shows the plugin channel rows in the detail pane', pluginRows > 0, `${pluginRows} rows`);
  await shot('channels-list-detail-plugins');
}

// 1280x720: the list stays usable beside a long editor.
const session = await context.newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await page.locator('#channel-list-pane .channel-list-item').first().click();
await wait(500);
const layout = await page.evaluate(() => {
  const content = document.getElementById('setup-content');
  content.scrollTop = content.scrollHeight;
  const pane = document.getElementById('channel-list-pane').getBoundingClientRect();
  const r = { paneTop: Math.round(pane.top), paneBottom: Math.round(pane.bottom), vh: window.innerHeight, hscroll: content.scrollWidth > content.clientWidth + 2 };
  content.scrollTop = 0;
  return r;
});
await shot('channels-list-detail-720p');
record('1280×720: the list stays on screen while the editor scrolls, no horizontal scroll', layout.paneTop >= 0 && layout.paneBottom <= layout.vh && !layout.hscroll, JSON.stringify(layout));
await session.send('Emulation.clearDeviceMetricsOverride');

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
