// Scratch: docs/design/03 §4 — Shift/Ctrl multi-select replaces SELECT CHANNELS mode.
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

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(300);

const state = () => page.evaluate(() => ({
  multi: Array.from(document.querySelectorAll('#channel-list-pane .channel-list-item.multi-selected')).map((i) => i.dataset.channelNumber),
  single: document.querySelector('#channel-list-pane .channel-list-item.selected')?.dataset.channelNumber || null,
  bar: !!document.querySelector('#channel-list #bulk-actions-bar:not(.hidden)'),
  card: !!document.querySelector('#channel-list .channel-row'),
  count: document.getElementById('bulk-selected-count').textContent,
  toggleBtn: !!document.getElementById('bulk-select-toggle-btn'),
  checkboxes: document.querySelectorAll('.channel-select-checkbox').length,
}));
const rows = page.locator('#channel-list-pane .channel-list-item');
const nums = await page.evaluate(() => Array.from(document.querySelectorAll('#channel-list-pane .channel-list-item')).map((i) => i.dataset.channelNumber));
const favs = (list) => page.evaluate((l) => l.map((n) => !!window.S.config.channels.find((c) => String(c.number) === n).favorite), list);

let s = await state();
record('no SELECT CHANNELS button or row checkboxes', !s.toggleBtn && s.checkboxes === 0);

await rows.nth(0).click();
await wait(300);
await rows.nth(2).click({ modifiers: ['Control'] });
await wait(300);
s = await state();
record('Ctrl+click adds a channel: two selected, bulk bar replaces the editor', JSON.stringify(s.multi) === JSON.stringify([nums[0], nums[2]]) && s.bar && !s.card && s.count === '2 SELECTED', JSON.stringify(s));

await rows.nth(4).click({ modifiers: ['Shift'] });
await wait(300);
s = await state();
record('Shift+click selects the range from the last Ctrl+clicked channel', JSON.stringify(s.multi) === JSON.stringify(nums.slice(2, 5)), s.multi.join(','));
await page.screenshot({ path: 'tests/ui/screenshots/channel-multiselect.png' });

await rows.nth(3).click({ modifiers: ['Control'] });
await wait(300);
s = await state();
record('Ctrl+click on a selected channel removes it', JSON.stringify(s.multi) === JSON.stringify([nums[2], nums[4]]), s.multi.join(','));

// A bulk action applies to the selection as one undo step.
const pair = [nums[2], nums[4]];
const before = await favs(pair);
await page.locator('#bulk-favorite-on-btn').click();
await wait(300);
const after = await favs(pair);
const label = await page.evaluate(async () => (await import('app://bundle/renderer/js/core/state.js')).undoLabel());
s = await state();
record('FAVORITE ON sets both and stays multi-selected', after.every(Boolean) && label === 'Favorite on 2 channels' && s.multi.length === 2, `${label} ${JSON.stringify(after)}`);
await page.keyboard.press('Control+z');
await wait(500);
record('one undo restores both', JSON.stringify(await favs(pair)) === JSON.stringify(before));

// Keyboard: Ctrl+A, Esc, Shift+Arrow.
await page.locator('#channel-list-pane .channel-list-item').first().focus();
await page.keyboard.press('Control+a');
await wait(300);
s = await state();
record('Ctrl+A in the list selects every listed channel', s.multi.length === nums.filter((n) => n !== 'plugins').length, `${s.multi.length}`);
await page.keyboard.press('Escape');
await wait(300);
s = await state();
record('Esc goes back to one channel and its editor', s.multi.length === 0 && !!s.single && s.card && !s.bar, JSON.stringify(s));
await page.locator('#channel-list-pane .channel-list-item.selected').focus();
const start = (await state()).single;
await page.keyboard.press('Shift+ArrowDown');
await wait(300);
await page.keyboard.press('Shift+ArrowDown');
await wait(300);
s = await state();
const i0 = nums.indexOf(start);
record('Shift+▼ extends the selection from the focused channel', JSON.stringify(s.multi) === JSON.stringify(nums.slice(i0, i0 + 3)), `${start}: ${s.multi.join(',')}`);
await page.locator('#channel-list .channel-multi-heading .btn').click();
await wait(300);
s = await state();
record('CLEAR SELECTION returns to a single channel', s.multi.length === 0 && s.card);

// A plain click always means one channel.
await rows.nth(1).click({ modifiers: ['Control'] });
await wait(200);
await rows.nth(5).click();
await wait(300);
s = await state();
record('a plain click selects just that channel', s.multi.length === 0 && s.single === nums[5] && s.card, JSON.stringify(s));

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
