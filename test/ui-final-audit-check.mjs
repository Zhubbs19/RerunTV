import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';

const port = process.env.RERUNTV_AUDIT_PORT || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('renderer/index.html'));
assert.ok(page, 'RerunTV renderer page was not found');
page.setDefaultTimeout(30_000);

const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2200);

if (await page.locator('.onboarding-screen').count()) {
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await page.getByRole('button', { name: 'SAVE & OPEN CHANNEL SETUP' }).click();
  await page.waitForTimeout(800);
}
assert.equal(await page.locator('#setup-screen').evaluate((el) => !el.classList.contains('hidden')), true);

const typography = await page.locator('#setup-screen').evaluate((el) => ({
  font: getComputedStyle(el).fontFamily,
  bodyFont: getComputedStyle(document.querySelector('.panel-status')).fontFamily,
}));
assert.match(typography.font, /Archivo Narrow/i);
assert.match(typography.bodyFont, /Barlow/i);

await page.locator('.setup-tab-btn[data-tab="audio"]').click();
await page.locator('.setup-subtab-btn[data-subtab="librarysync"]').click();
assert.equal(await page.locator('#library-sync-status').isVisible(), true);
assert.equal(await page.locator('#library-sync-enabled').isChecked(), false);
assert.equal(await page.locator('#library-sync-remove-missing').isChecked(), false);

await page.evaluate(async () => {
  window.S.config.channels = [{
    number: 7, name: 'AUDIT CHANNEL', anchor: Date.now() - 60000, files: [
      { path: 'audit-one.mp4', duration: 120, folder: null, source: 'local', title: 'Audit Pilot' },
      { path: 'audit-ten.mp4', duration: 120, folder: null, source: 'local', title: 'Audit Ten' },
      { path: 'audit-two.mp4', duration: 120, folder: null, source: 'local', title: 'Audit Two' },
    ],
    folders: [], blocks: [], adsEnabled: false, shuffle: false,
  }];
  const { renderChannelList } = await import('app://bundle/renderer/js/setup-channels.js');
  renderChannelList();
});

await page.locator('.setup-tab-btn[data-tab="channels"]').click();
if (await page.locator('.edit-panel').evaluate((el) => el.classList.contains('hidden'))) {
  await page.locator('.channel-row .edit-btn').click();
}
await page.waitForTimeout(350);
const editTabLabels = await page.locator('.edit-tab-btn').allTextContents();
assert.ok(editTabLabels.includes('TITLES'), `Expected TITLES edit tab; found ${editTabLabels.join(', ')}`);
await page.locator('.edit-tab-btn', { hasText: 'TITLES' }).click();
assert.equal(await page.getByRole('button', { name: 'NATURAL EPISODE SORT' }).isVisible(), true);
assert.equal(await page.getByRole('button', { name: /SEEDED SHUFFLE/ }).isVisible(), true);
await page.locator('.edit-tab-btn', { hasText: 'IDENTITY' }).click();
assert.equal(await page.getByText(/OPTIONAL CHANNEL IDENTITY OVERRIDES/).isVisible(), true);
assert.equal(await page.evaluate(() => window.S.config.channels[0].broadcastIdentity === undefined), true);

await page.locator('.setup-tab-btn[data-tab="programming"]').click();
await page.locator('.setup-subtab-btn[data-subtab="aircheck"]').click();
assert.equal(await page.locator('#aircheck-summary .aircheck-row').count(), 5);
assert.match(await page.locator('#aircheck-summary').innerText(), /AUDIT PILOT|AUDIT TEN|AUDIT TWO/i);
const aircheckControls = await page.evaluate(() => {
  const select = getComputedStyle(document.getElementById('aircheck-channel'));
  const pool = getComputedStyle(document.getElementById('aircheck-pool-entry'));
  const datetime = getComputedStyle(document.getElementById('aircheck-datetime'));
  return {
    selectBackground: select.backgroundColor,
    poolBackground: pool.backgroundColor,
    datetimeBackground: datetime.backgroundColor,
    selectAppearance: select.appearance,
    hasArrow: select.backgroundImage !== 'none',
  };
});
assert.equal(aircheckControls.selectAppearance, 'none');
assert.equal(aircheckControls.hasArrow, true);
assert.equal(aircheckControls.selectBackground, aircheckControls.poolBackground);
assert.equal(aircheckControls.selectBackground, aircheckControls.datetimeBackground);
assert.doesNotMatch(aircheckControls.selectBackground, /255, 255, 255/);
await page.screenshot({ path: path.resolve('.runtime-audit', 'aircheck-dropdowns.png'), fullPage: false });

await page.locator('.setup-tab-btn[data-tab="help"]').click();
const updatePolicyControl = await page.locator('#update-mode-select').evaluate((element) => {
  const style = getComputedStyle(element);
  return {
    appearance: style.appearance,
    background: style.backgroundColor,
    hasArrow: style.backgroundImage !== 'none',
  };
});
assert.equal(updatePolicyControl.appearance, 'none');
assert.equal(updatePolicyControl.hasArrow, true);
assert.equal(updatePolicyControl.background, aircheckControls.selectBackground);
assert.doesNotMatch(updatePolicyControl.background, /255, 255, 255/);
await page.locator('#update-settings-panel').screenshot({ path: path.resolve('.runtime-audit', 'software-update-dropdown.png') });

await page.locator('.setup-tab-btn[data-tab="plugins"]').click();
await page.waitForTimeout(900);
assert.equal(await page.locator('#plugin-diagnostics-summary .perf-telemetry-item').count(), 6);
assert.match(await page.locator('#plugin-diagnostics-summary').innerText(), /RELOAD STATUS/);
assert.doesNotMatch(await page.locator('#plugin-diagnostics-log').innerText(), /DIAGNOSTICS ERROR/);

const dropdownAudit = await page.evaluate(() => [...document.querySelectorAll('select')].map((element) => {
  const style = getComputedStyle(element);
  return {
    id: element.id || element.getAttribute('data-el') || element.className || '(anonymous select)',
    appearance: style.appearance,
    background: style.backgroundColor,
    color: style.color,
    hasArrow: style.backgroundImage !== 'none',
  };
}));
const brokenDropdowns = dropdownAudit.filter((control) => (
  control.appearance !== 'none'
  || !control.hasArrow
  || control.background === 'rgba(0, 0, 0, 0)'
  || control.background === 'rgb(255, 255, 255)'
));
assert.deepEqual(brokenDropdowns, [], `Unthemed dropdowns: ${JSON.stringify(brokenDropdowns)}`);

const toast = page.locator('#update-toast');
await toast.evaluate((el) => {
  el.classList.remove('hidden');
  document.getElementById('update-toast-text').textContent = 'A deliberately long update message verifies that update copy wraps without covering the action buttons at a narrow desktop width.';
});
await page.setViewportSize({ width: 900, height: 650 });
const toastFit = await toast.evaluate((el) => {
  const text = document.getElementById('update-toast-text').getBoundingClientRect();
  const actions = document.getElementById('update-toast-install').getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return { inside: text.right <= box.right && actions.right <= box.right, separate: text.bottom <= actions.top || text.right <= actions.left };
});
assert.equal(toastFit.inside, true);
assert.equal(toastFit.separate, true);
await toast.evaluate((el) => el.classList.add('hidden'));

await page.screenshot({ path: path.resolve('.runtime-audit', 'final-audit.png'), fullPage: false });
assert.deepEqual(errors, []);
if (process.env.RERUNTV_AUDIT_CLOSE === '1') await page.close();
await browser.close();
console.log(JSON.stringify({ typography, dropdownsAudited: dropdownAudit.length, toastFit, runtimeErrors: errors.length }));
