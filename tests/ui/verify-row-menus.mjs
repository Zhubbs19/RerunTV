// Scratch: docs/design/03 §5.3 — row actions in a ⋯ menu (channel list rows and the channel card).
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

const order = () => page.evaluate(() => Array.from(document.querySelectorAll('#channel-list-pane .channel-list-item')).map((i) => i.dataset.channelNumber).filter((n) => n !== 'plugins'));
const menuItems = () => page.evaluate(() => Array.from(document.querySelectorAll('.row-menu .row-menu-item')).map((b) => `${b.textContent}${b.disabled ? ' (off)' : ''}${b.classList.contains('is-danger') ? ' !' : ''}`));
const selectedName = () => page.evaluate(() => { const n = document.querySelector('#channel-list-pane .channel-list-item.selected')?.dataset.channelNumber; return window.S.config.channels.find((c) => String(c.number) === n)?.name; });

record('the channel card has no ▲▼ or MORE… buttons', await page.evaluate(() => !document.querySelector('#channel-list .move-btn, #channel-list .channel-more')));

const before = await order();
const names = () => page.evaluate(() => Array.from(document.querySelectorAll('#channel-list-pane .channel-list-item .channel-list-name')).map((n) => n.textContent));
const namesBefore = await names();
await page.locator('#channel-list-pane .channel-list-item').nth(2).click();
await wait(300);
const name2 = await selectedName();
await page.locator('#channel-list-pane .channel-list-item.selected .row-menu-btn').click();
await wait(200);
const items = await menuItems();
record('a list row ⋯ opens Move up/down, Add folder, Preview, Duplicate and Remove (last, danger)', items.join('|') === 'Move up|Move down|Add folder…|Preview…|Duplicate|Remove channel… !', items.join(' | '));
record('focus lands on the first menu item', await page.evaluate(() => document.activeElement?.textContent === 'Move up'));

await page.keyboard.press('Enter');
await wait(400);
const namesAfter = await names();
record('Move up swaps the channel with the one above and keeps it selected', namesAfter[1] === namesBefore[2] && namesAfter[2] === namesBefore[1] && (await selectedName()) === name2, `${namesBefore.slice(0, 4)} → ${namesAfter.slice(0, 4)}`);
await page.keyboard.press('Control+z');
await wait(400);
record('undo puts the order back', JSON.stringify(await names()) === JSON.stringify(namesBefore));

// Keyboard: Shift+F10 on the focused row, arrows, Esc returns focus to ⋯.
await page.locator('#channel-list-pane .channel-list-item.selected').focus();
await page.keyboard.press('Shift+F10');
await wait(200);
const opened = await page.evaluate(() => !!document.querySelector('.row-menu'));
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
const focusedItem = await page.evaluate(() => document.activeElement?.textContent);
await page.keyboard.press('Escape');
await wait(150);
const back = await page.evaluate(() => ({ menu: !!document.querySelector('.row-menu'), focus: document.activeElement?.classList.contains('row-menu-btn') }));
record('Shift+F10 opens the row menu, arrows move, Esc closes back to ⋯', opened && focusedItem === 'Add folder…' && !back.menu && back.focus, `${focusedItem} ${JSON.stringify(back)}`);

// Right-click another row selects it and opens its menu at the pointer; outside click closes.
const target = page.locator('#channel-list-pane .channel-list-item').nth(4);
await target.click({ button: 'right' });
await wait(300);
const rc = await page.evaluate(() => ({ menu: !!document.querySelector('.row-menu'), selected: document.querySelector('#channel-list-pane .channel-list-item.selected')?.dataset.channelNumber }));
record('right-click selects the row and opens its menu', rc.menu && rc.selected === before[4], JSON.stringify(rc));
await page.mouse.click(900, 40);
await wait(150);
record('clicking outside closes the menu', await page.evaluate(() => !document.querySelector('.row-menu')));

// Duplicate from the card's ⋯, then remove the copy from its ⋯ (with confirm), then undo both.
const count0 = await page.evaluate(() => window.S.config.channels.length);
await page.locator('#channel-list .channel-card-menu-btn').click();
await page.locator('.row-menu .row-menu-item', { hasText: 'Duplicate' }).click();
await wait(500);
const dup = await page.evaluate(() => ({ count: window.S.config.channels.length, name: document.querySelector('#channel-list .channel-row input[placeholder="CHANNEL NAME"]')?.value }));
record('Duplicate from the card menu adds a copy and selects it', dup.count === count0 + 1 && / COPY$/.test(dup.name || ''), JSON.stringify(dup));
await page.locator('#channel-list-pane .channel-list-item.selected .row-menu-btn').click();
await page.locator('.row-menu .row-menu-item', { hasText: 'Remove channel' }).click();
await wait(300);
const confirm = page.locator('.confirm-dialog button', { hasText: /REMOVE|OK|CONFIRM|YES/ }).last();
if (await confirm.count()) await confirm.click();
await wait(500);
record('Remove from the row menu confirms and removes the copy', await page.evaluate(() => window.S.config.channels.length) === count0);
await page.keyboard.press('Control+z');
await wait(300);
await page.keyboard.press('Control+z');
await wait(400);
record('undoing both leaves the lineup as it was', await page.evaluate(() => window.S.config.channels.length) === count0 && JSON.stringify(await order()) === JSON.stringify(before));

// ---------- Collections ----------
const openRowMenu = async (rowSel) => {
  await page.locator(`${rowSel} .row-menu-btn`).first().click();
  await wait(200);
  return menuItems();
};
const undoLabel = () => page.evaluate(async () => (await import('app://bundle/renderer/js/core/state.js')).undoLabel());

await page.locator('.setup-tab-btn[data-tab="programming"]').click();
await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="pool"]').click();
await wait(500);
const poolCount = await page.evaluate(() => window.S.config.interstitials.pool.length);
let m = await openRowMenu('#interstitials-list .interstitial-card.selected');
record('pool row ⋯: Duplicate, Remove entry (danger)', m.join('|') === 'Duplicate|Remove entry… !', m.join(' | '));
record('pool list rows no longer carry a REMOVE button', await page.evaluate(() => !document.querySelector('#interstitials-list .remove-btn')));
await page.locator('.row-menu .row-menu-item', { hasText: 'Duplicate' }).click();
await wait(400);
record('Duplicate adds a pool entry, selects it, one undo step', await page.evaluate(() => window.S.config.interstitials.pool.length) === poolCount + 1 && (await undoLabel()) === 'Duplicate ad pool entry');
await page.keyboard.press('Control+z');
await wait(400);

await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="presets"]').click();
await wait(400);
const presetCount = await page.evaluate(() => window.S.config.interstitials.presets.length);
m = await openRowMenu('#presets-list .interstitial-card.selected');
record('preset row ⋯: Duplicate, Remove preset (danger)', m.join('|') === 'Duplicate|Remove preset… !', m.join(' | '));
await page.locator('.row-menu .row-menu-item', { hasText: 'Remove preset' }).click();
await wait(300);
const confirmPreset = page.locator('.confirm-dialog button', { hasText: /REMOVE|OK|CONFIRM|YES/ }).last();
if (await confirmPreset.count()) await confirmPreset.click();
await wait(400);
record('Remove preset asks, removes, and undoes', await page.evaluate(() => window.S.config.interstitials.presets.length) === presetCount - 1);
await page.keyboard.press('Control+z');
await wait(400);
record('…and undo brings it back', await page.evaluate(() => window.S.config.interstitials.presets.length) === presetCount);

await page.locator('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="flows"]').click();
await wait(400);
const flowCount = await page.evaluate(() => window.S.config.interstitials.flows.length);
m = await openRowMenu('#flow-list .flow-list-item.selected');
record('flow row ⋯: Duplicate, Delete flow (danger)', m.join('|') === 'Duplicate|Delete flow… !', m.join(' | '));
await page.locator('.row-menu .row-menu-item', { hasText: 'Duplicate' }).click();
await wait(400);
const flowDup = await page.evaluate(() => ({ count: window.S.config.interstitials.flows.length, selected: document.querySelector('#flow-list .flow-list-item.selected .flow-list-name')?.textContent, stepIds: (() => { const f = window.S.config.interstitials.flows; const a = f[f.length - 1]; return new Set(a.steps.map((s) => s.id)).size === a.steps.length; })() }));
record('Duplicate flow adds a selected copy with its own step ids', flowDup.count === flowCount + 1 && / copy$/.test(flowDup.selected || '') && flowDup.stepIds, JSON.stringify(flowDup));
await page.keyboard.press('Control+z');
await wait(400);
record('flow list rows are not nested buttons', await page.evaluate(() => !document.querySelector('#flow-list button.flow-list-item') && !document.querySelector('button button')));

await page.locator('.setup-tab-btn[data-tab="audio"]').click();
await page.locator('[data-tab-panel="audio"] .setup-subtab-btn[data-subtab="backups"]').click();
await wait(1500);
m = await openRowMenu('#backups-list .backup-list-item.selected');
record('backup row ⋯: Restore, label and pin, Delete (danger)', /^Restore…\|(Add label…|Relabel…)\|(Pin|Unpin)\|Delete snapshot… !$/.test(m.join('|')), m.join(' | '));
const pinnedBefore = await page.evaluate(() => document.querySelector('#backups-list .backup-list-item.selected .backup-row-time')?.textContent.startsWith('★'));
await page.locator('.row-menu .row-menu-item', { hasText: /^(Pin|Unpin)$/ }).click();
await wait(1200);
const pinnedAfter = await page.evaluate(() => document.querySelector('#backups-list .backup-list-item.selected .backup-row-time')?.textContent.startsWith('★'));
record('Pin from the row menu toggles the star', pinnedAfter === !pinnedBefore, `${pinnedBefore} → ${pinnedAfter}`);
await page.locator('#backups-list .backup-list-item.selected .row-menu-btn').click();
await page.locator('.row-menu .row-menu-item', { hasText: /^(Pin|Unpin)$/ }).click();
await wait(1000);

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
