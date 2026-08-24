import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('renderer/index.html'));
assert.ok(page, 'RerunTV renderer page was not found');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (await page.locator('#setup-screen').evaluate((el) => el.classList.contains('hidden'))) {
  await page.keyboard.press('s');
  await page.waitForTimeout(500);
}

const semantics = await page.evaluate(() => ({
  stickyPosition: getComputedStyle(document.querySelector('.setup-nav')).position,
  topTabs: Array.from(document.querySelectorAll('#setup-tabs .setup-tab-btn')).every((tab) => {
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    return tab.getAttribute('role') === 'tab' && panel?.getAttribute('role') === 'tabpanel'
      && panel.getAttribute('aria-labelledby') === tab.id;
  }),
  subTabs: Array.from(document.querySelectorAll('.setup-subtabs .setup-subtab-btn')).every((tab) => {
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    return tab.getAttribute('role') === 'tab' && panel?.getAttribute('role') === 'tabpanel';
  }),
  liveRegions: ['migration-toast', 'update-toast', 'scan-progress', 'flow-status-banner', 'plugins-save-status', 'update-status-line']
    .every((id) => document.getElementById(id)?.getAttribute('aria-live') === 'polite'),
}));
assert.deepEqual(semantics, { stickyPosition: 'sticky', topTabs: true, subTabs: true, liveRegions: true });

await page.locator('.setup-tab-btn[data-tab="plugins"]').click();
const partyEntry = page.locator('.plugin-entry[data-search*="party-channel"]').first();
await partyEntry.locator('.plugin-settings-toggle-btn').click();
const partyLayout = await partyEntry.locator('.plugin-settings-section[data-layout="two-column"] .plugin-settings-section-content').evaluate((el) => ({
  display: getComputedStyle(el).display,
  columns: getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,
}));
assert.equal(partyLayout.display, 'grid');
assert.equal(partyLayout.columns, 2);

await page.locator('#done-btn').click();
await page.waitForTimeout(2000);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })));
await page.waitForTimeout(100);
assert.equal(await page.locator('#shortcuts-overlay').getAttribute('role'), 'dialog');
assert.equal(await page.locator('#shortcuts-overlay').getAttribute('aria-modal'), 'true');
assert.equal(await page.locator('.tv-menu-btn').first().evaluate((el) => document.activeElement === el), true);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
assert.equal(await page.locator('#shortcuts-overlay').evaluate((el) => el.classList.contains('hidden')), true);
assert.equal(await page.evaluate(() => document.activeElement?.closest('#shortcuts-overlay') == null), true);

await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' })));
await page.waitForTimeout(150);
assert.equal(await page.locator('#guide-grid').getAttribute('role'), 'dialog');
assert.equal(await page.locator('#guide-search').evaluate((el) => document.activeElement === el), true);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
assert.equal(await page.locator('#guide-grid').evaluate((el) => el.classList.contains('hidden')), true);

console.log(JSON.stringify({ ...semantics, partyLayout, tvMenuFocus: true, guideFocus: true }, null, 2));
await browser.close();
