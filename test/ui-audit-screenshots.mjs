import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const phase = process.argv.find((arg) => arg.startsWith('--phase='))?.split('=')[1] || 'current';
const reportsOnly = process.argv.includes('--reports-only');
const themesOnly = process.argv.includes('--themes-only');
const outputDir = path.resolve('docs', 'ui-audit-2026-08-24', phase);
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const pages = context.pages();
const page = pages.find((candidate) => candidate.url().includes('renderer/index.html')) || pages[0];
if (!page) throw new Error('RerunTV renderer page was not found');

page.setDefaultTimeout(60_000);
await page.reload({ waitUntil: 'domcontentloaded' });
const cdp = await context.newCDPSession(page);
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2500);
if (await page.locator('#setup-screen').evaluate((el) => el.classList.contains('hidden'))) {
  await page.keyboard.press('s');
  await page.waitForTimeout(1000);
}

async function settle() {
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    const screen = document.querySelector('#setup-screen');
    if (screen) screen.scrollTop = 0;
  });
}

async function shot(name) {
  await settle();
  if (reportsOnly) return;
  await captureViewport(path.join(outputDir, `${name}.png`));
}

async function captureViewport(filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await fs.writeFile(filePath, Buffer.from(data, 'base64'));
}

async function clickVisible(selector, text) {
  const candidates = page.locator(selector).filter({ hasText: text });
  const count = await candidates.count();
  for (let i = 0; i < count; i += 1) {
    const item = candidates.nth(i);
    if (await item.isVisible()) {
      await item.click();
      return item;
    }
  }
  throw new Error(`No visible ${selector} containing ${text}`);
}

const menuStates = [
  { tab: 'channels', name: 'channels' },
  { tab: 'display', subtab: 'picture', name: 'display-picture' },
  { tab: 'display', subtab: 'interface', name: 'display-interface' },
  { tab: 'programming', subtab: 'flows', name: 'programming-flows' },
  { tab: 'programming', subtab: 'pool', name: 'programming-pool' },
  { tab: 'programming', subtab: 'presets', name: 'programming-presets' },
  { tab: 'programming', subtab: 'onscreen', name: 'programming-onscreen' },
  { tab: 'programming', subtab: 'autocurate', name: 'programming-autocurate' },
  { tab: 'programming', subtab: 'tagtaxonomy', name: 'programming-tag-taxonomy' },
  { tab: 'audio', subtab: 'system', name: 'audio-system' },
  { tab: 'audio', subtab: 'virtual', name: 'audio-virtual-channels' },
  { tab: 'audio', subtab: 'backups', name: 'audio-backups' },
  { tab: 'perf', name: 'performance' },
  { tab: 'plugins', name: 'plugins' },
  { tab: 'help', name: 'help' },
];

const componentReport = [];
if (!themesOnly) {
for (const state of menuStates) {
  await page.locator(`.setup-tab-btn[data-tab="${state.tab}"]`).click();
  if (state.subtab) {
    const panel = page.locator(`.setup-tab-panel[data-tab-panel="${state.tab}"]`);
    await panel.locator(`.setup-subtab-btn[data-subtab="${state.subtab}"]`).click();
  }
  await shot(state.name);
  componentReport.push(await page.evaluate(({ state, phase }) => {
    const panel = document.querySelector(`.setup-tab-panel[data-tab-panel="${state.tab}"]`);
    const root = state.subtab
      ? panel?.querySelector(`.setup-subtab-panel[data-subtab-panel="${state.subtab}"]`)
      : panel;
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const textFor = (el) => {
      const id = el.id;
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return (el.getAttribute('aria-label') || label?.textContent || el.closest('label')?.textContent || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
    };
    return {
      phase,
      menu: state.name,
      controls: Array.from(root?.querySelectorAll('button, input, select, textarea, [tabindex]') || []).filter(visible).map((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(), id: el.id || null, type: el.getAttribute('type'), text: textFor(el),
          fontSize: style.fontSize, color: style.color, backgroundColor: style.backgroundColor,
          width: Math.round(rect.width), height: Math.round(rect.height), clipped: el.scrollWidth > el.clientWidth + 1,
          disabled: !!el.disabled, role: el.getAttribute('role'), ariaLabel: el.getAttribute('aria-label'),
          ariaSelected: el.getAttribute('aria-selected'), labelled: !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))),
          options: el.tagName === 'SELECT' ? Array.from(el.options).map((option) => ({ value: option.value, label: option.textContent.trim(), selected: option.selected, disabled: option.disabled })) : undefined,
        };
      }),
    };
  }, { state, phase }));
}

// Channel edit menus and the nested Schedule views.
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
const editButton = page.locator('.edit-btn:not([disabled])').first();
if (await editButton.count()) {
  const editableRow = editButton.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " channel-row ")][1]');
  const editPanel = editableRow.locator('xpath=following-sibling::*[contains(concat(" ", normalize-space(@class), " "), " edit-panel ")][1]');
  if (!(await editButton.evaluate((el) => el.classList.contains('edit-btn-open')))) await editButton.click();
  for (const label of ['FOLDERS', 'SCHEDULE', 'TITLES', 'ADS', 'LOGO', 'THEME']) {
    const tab = editPanel.locator('.edit-tab-bar').first().locator('.edit-tab-btn').filter({ hasText: label }).first();
    if (await tab.count()) {
      await tab.click();
      await shot(`channel-edit-${label.toLowerCase()}`);
      if (label === 'SCHEDULE') {
        for (const view of ['TIMELINE', 'BLOCKS', 'CALENDAR']) {
          await clickVisible('.schedule-view-toggle .edit-tab-btn', view);
          await shot(`channel-edit-schedule-${view.toLowerCase()}`);
        }
      }
    }
  }
}

// Secondary channel utility panels.
for (const [button, name] of [
  ['#library-search-toggle-btn', 'channel-library-search'],
  ['#now-next-toggle-btn', 'channel-now-next'],
  ['#bulk-select-toggle-btn', 'channel-bulk-select'],
]) {
  const control = page.locator(button);
  if (await control.count()) {
    await control.click();
    await shot(name);
  }
}

// Programming panels with collapsible record details.
await page.locator('.setup-tab-btn[data-tab="programming"]').click();
await page.locator('.setup-subtab-btn[data-subtab="pool"]').click();
if (await page.locator('#interstitials-expand-all-btn').count()) {
  await page.locator('#interstitials-expand-all-btn').click();
  await shot('programming-pool-expanded');
}
await page.locator('.setup-subtab-btn[data-subtab="presets"]').click();
const presetSummaries = page.locator('[data-subtab-panel="presets"] .interstitial-card-summary');
for (let i = 0; i < await presetSummaries.count(); i += 1) {
  const summary = presetSummaries.nth(i);
  if (await summary.isVisible()) await summary.click();
}
await shot('programming-presets-expanded');

// Every virtual-channel card has its own secondary settings body.
await page.locator('.setup-tab-btn[data-tab="audio"]').click();
await page.locator('.setup-subtab-btn[data-subtab="virtual"]').click();
if (await page.locator('#virtual-expand-all-btn').count()) {
  await page.locator('#virtual-expand-all-btn').click();
  await shot('audio-virtual-channels-expanded');
}

// Plugin category tabs and every plugin SETTINGS submenu.
await page.locator('.setup-tab-btn[data-tab="plugins"]').click();
const categoryTabs = page.locator('#plugins-category-tabs .setup-subtab-btn');
for (let i = 0; i < await categoryTabs.count(); i += 1) {
  const tab = categoryTabs.nth(i);
  const name = (await tab.textContent()).replace(/\d+/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await tab.click();
  await shot(`plugins-category-${name}`);
}
await categoryTabs.first().click();
const pluginEntries = page.locator('.plugin-entry').filter({ has: page.locator('.plugin-settings-toggle-btn') });
const pluginSecondaryReport = [];
for (let i = 0; i < await pluginEntries.count(); i += 1) {
  const entry = pluginEntries.nth(i);
  const toggle = entry.locator('.plugin-settings-toggle-btn');
  await toggle.click();
  const rawName = (await entry.locator('.plugin-row-name').textContent()).replace(/v\d+(?:\.\d+)*/gi, '').trim();
  const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `plugin-${i + 1}`;
  await entry.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  if (!reportsOnly) await captureViewport(path.join(outputDir, `plugin-settings-${String(i + 1).padStart(2, '0')}-${slug}.png`));
  pluginSecondaryReport.push(await entry.evaluate((root, name) => ({
    name,
    controls: Array.from(root.querySelectorAll('button, input, select, textarea')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && rect.width > 0 && rect.height > 0;
    }).map((el) => ({
      tag: el.tagName.toLowerCase(), type: el.type || null,
      text: (el.getAttribute('aria-label') || el.closest('label')?.textContent || el.textContent || el.placeholder || '').replace(/\s+/g, ' ').trim(),
      options: el.tagName === 'SELECT' ? Array.from(el.options).map((option) => option.textContent.trim()) : undefined,
      fontSize: getComputedStyle(el).fontSize,
    })),
  }), rawName));
  await toggle.click();
}
await fs.writeFile(path.join(outputDir, 'plugin-settings-report.json'), `${JSON.stringify(pluginSecondaryReport, null, 2)}\n`);

// Every Help guide card is a secondary menu. Capture its expanded element,
// which is more legible and complete than a viewport crop of the long list.
await page.locator('.setup-tab-btn[data-tab="help"]').click();
const helpCards = page.locator('.help-guide-card');
for (let i = 0; i < await helpCards.count(); i += 1) {
  const card = helpCards.nth(i);
  if (!(await card.evaluate((el) => el.classList.contains('open')))) await card.locator('.help-guide-card-header').click();
  const title = (await card.locator('.help-guide-card-header').textContent()).replace(/^[▾▸]/, '').trim();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  await captureViewport(path.join(outputDir, `help-topic-${String(i + 1).padStart(2, '0')}-${slug}.png`));
  if (i > 0) await card.locator('.help-guide-card-header').click();
}
}

// Theme parity: render the same sticky setup surface under every registered
// theme without dispatching a change event (the audit must not save a theme
// preference). Record resolved colors/tokens beside one screenshot per pack.
await page.locator('.setup-tab-btn[data-tab="display"]').click();
await page.locator('.setup-subtab-btn[data-subtab="interface"]').click();
const themeIds = await page.locator('#theme-select option').evaluateAll((options) => [...new Set(options.map((option) => option.value).filter(Boolean))]);
const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme || 'digital-2000s');
const themeReport = [];
for (const themeId of themeIds) {
  themeReport.push(await page.evaluate((id) => {
    document.documentElement.dataset.theme = id;
    const resolvedColor = (value, property = 'color') => {
      const node = document.createElement('div');
      node.style.cssText = 'position:fixed;left:-9999px';
      node.style[property] = value;
      document.body.appendChild(node);
      const resolved = getComputedStyle(node)[property];
      node.remove();
      return resolved;
    };
    const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = (value) => {
      const channels = rgb(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (foreground, background) => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
    };
    const root = getComputedStyle(document.documentElement);
    const paper = resolvedColor('var(--paper)');
    const paperDim = resolvedColor('var(--paper-dim)');
    const gold = resolvedColor('var(--gold)');
    const cell = resolvedColor('var(--cell)', 'backgroundColor');
    const inkDeep = resolvedColor('var(--ink-deep)', 'backgroundColor');
    const result = {
      id,
      paper, cell, paperDim, gold, inkDeep,
      contrast: {
        paperOnCell: contrast(paper, cell),
        paperDimOnCell: contrast(paperDim, cell),
        goldOnInkDeep: contrast(gold, inkDeep),
      },
      setupNavBg: root.getPropertyValue('--setup-nav-bg').trim(),
      setupOverflowShadow: root.getPropertyValue('--setup-overflow-shadow').trim(),
    };
    return result;
  }, themeId));
  await page.evaluate(() => { document.querySelector('#setup-screen').scrollTop = 260; });
  await page.waitForTimeout(80);
  await captureViewport(path.join(outputDir, `theme-${themeId}-setup.png`));
}
await page.evaluate((id) => { document.documentElement.dataset.theme = id; }, originalTheme);
await fs.writeFile(path.join(outputDir, 'theme-report.json'), `${JSON.stringify(themeReport, null, 2)}\n`);

if (!themesOnly) {
await fs.writeFile(path.join(outputDir, 'component-report.json'), `${JSON.stringify(componentReport, null, 2)}\n`);
const summary = componentReport.map((menu) => ({
  menu: menu.menu,
  controls: menu.controls.length,
  dropdowns: menu.controls.filter((control) => control.tag === 'select').length,
  dropdownOptions: menu.controls.filter((control) => control.tag === 'select').reduce((sum, control) => sum + control.options.length, 0),
  unlabeled: menu.controls.filter((control) => ['input', 'select', 'textarea'].includes(control.tag) && !control.labelled).length,
  clipped: menu.controls.filter((control) => control.clipped).length,
  under12px: menu.controls.filter((control) => !['checkbox', 'radio', 'range'].includes(control.type) && Number.parseFloat(control.fontSize) < 12).length,
}));
await fs.writeFile(path.join(outputDir, 'component-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(JSON.stringify(themeReport, null, 2));
}
await browser.close();
