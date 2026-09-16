// Scratch: docs/design/03 step 1 — the setup shell's behaviour and budgets.
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
const openSetup = () => page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
const setupVisible = () => page.evaluate(() => !document.getElementById('setup-screen').classList.contains('hidden'));

await wait(4000);
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await openSetup();
await wait(1500);

const session = await context.newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await wait(600);
const budget = await page.evaluate(() => {
  const h = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height);
  const tabs = ['channels', 'programming', 'library', 'display', 'guide', 'household', 'audio', 'plugins', 'help'];
  const hscroll = [];
  tabs.forEach((tab) => {
    document.querySelector(`.setup-tab-btn[data-tab="${tab}"]`).click();
    const c = document.getElementById('setup-content');
    if (c.scrollWidth > c.clientWidth + 2) hscroll.push(tab);
  });
  document.querySelector('.setup-tab-btn[data-tab="channels"]').click();
  return { header: h('#setup-screen .setup-nav'), status: h('#setup-screen .setup-status-bar'), hscroll, workspaceSwitch: !!document.querySelector('.setup-workspace-switch') };
});
record('1280×720: header + status bar ≤ 104 px', budget.header + budget.status <= 104, `${budget.header} + ${budget.status}`);
record('1280×720: no section scrolls horizontally', budget.hscroll.length === 0, budget.hscroll.join(','));
record('the workspace switch is gone; every section is in the sidebar', !budget.workspaceSwitch && (await page.locator('#setup-tabs .setup-tab-btn').count()) === 9);

// The status bar stays on screen however far the page scrolls.
const pinned = await page.evaluate(async () => {
  const c = document.getElementById('setup-content');
  c.scrollTop = c.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const bar = document.querySelector('#setup-screen .setup-status-bar').getBoundingClientRect();
  const done = document.getElementById('done-btn').getBoundingClientRect();
  const r = { barBottom: Math.round(bar.bottom), vh: window.innerHeight, doneVisible: done.bottom <= window.innerHeight && done.top >= 0, stuck: document.querySelector('#setup-screen .setup-nav').classList.contains('is-stuck') };
  c.scrollTop = 0;
  return r;
});
record('START WATCHING and undo stay visible at the bottom of a long page; the header shows it has scrolled', pinned.doneVisible && pinned.barBottom <= pinned.vh && pinned.stuck, JSON.stringify(pinned));

// Sidebar keyboard: roving focus with ▲▼, Enter/click opens.
await page.locator('.setup-tab-btn[data-tab="channels"]').focus();
await page.keyboard.press('ArrowDown');
const focusedTab = await page.evaluate(() => document.activeElement && document.activeElement.dataset.tab);
record('▼ in the sidebar moves to the next section', focusedTab === 'programming', focusedTab);
await page.keyboard.press('Enter');
await wait(300);
const heading = await page.evaluate(() => ({ title: document.getElementById('setup-page-title').textContent, crumb: document.getElementById('setup-breadcrumb').textContent }));
record('Enter opens it; the header names the section and sub-tab', /^PROGRAMMING$/.test(heading.title) && /›/.test(heading.crumb), JSON.stringify(heading));
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(200);
record('a section without sub-tabs shows no duplicate breadcrumb', (await page.evaluate(() => document.getElementById('setup-breadcrumb').textContent)) === '');

// Export/import live with backups.
const moved = await page.evaluate(() => {
  const btn = document.getElementById('config-export-btn');
  return { inBackups: !!btn.closest('[data-subtab-panel="backups"]'), inStatusBar: !!btn.closest('.setup-status-bar') };
});
record('EXPORT/IMPORT CONFIG moved from every page to System › Backups', moved.inBackups && !moved.inStatusBar);

// Search still navigates into a section.
await page.locator('#setup-search').fill('guide slots');
await wait(400);
const searchHit = await page.evaluate(() => Array.from(document.querySelectorAll('#setup-search-results [role="option"], #setup-search-results .setup-search-result')).map((el) => el.textContent).slice(0, 3));
if (searchHit.length) {
  await page.keyboard.press('Enter');
  await wait(700);
}
const landed = await page.evaluate(() => ({ tab: document.querySelector('.setup-tab-btn.active').dataset.tab, visible: !!document.getElementById('guide-slots-select').offsetParent }));
record('search for "guide slots" lands on the control inside the scroll pane', searchHit.length > 0 && landed.tab === 'guide' && landed.visible, `${searchHit[0] || 'no results'} -> ${landed.tab}`);

// Watch TV from the sidebar, and Ctrl+Enter.
await page.locator('#setup-watch-btn').click();
await wait(1200);
record('WATCH TV in the sidebar returns to live TV', !(await setupVisible()));
await openSetup();
await wait(1200);
await page.locator('#setup-search').focus();
await page.keyboard.press('Control+Enter');
await wait(1200);
record('Ctrl+Enter returns to live TV from anywhere in setup', !(await setupVisible()));

// A few theme packs: the shell keeps its layout under their rules.
await openSetup();
await wait(1000);
const themes = ['outrun-synthwave', 'passport-03', 'hotel-headend-92', 'neo-brutalist', 'analog-90s'];
const themeLayouts = [];
for (const theme of themes) {
  const layout = await page.evaluate(async (id) => {
    const { applyTheme } = await import('app://bundle/renderer/js/display/themes.js');
    window.S.config.theme = id;
    applyTheme();
    await new Promise((r) => setTimeout(r, 700));
    const side = document.querySelector('#setup-screen .setup-sidebar').getBoundingClientRect();
    const first = document.querySelectorAll('#setup-tabs .setup-tab-btn')[0].getBoundingClientRect();
    const second = document.querySelectorAll('#setup-tabs .setup-tab-btn')[1].getBoundingClientRect();
    return { id, sidebarW: Math.round(side.width), vertical: second.top > first.bottom - 2, header: Math.round(document.querySelector('#setup-screen .setup-nav').getBoundingClientRect().height), themeApplied: document.documentElement.dataset.theme };
  }, theme);
  themeLayouts.push(layout);
  await page.screenshot({ path: path.join('tests/ui/screenshots', `shell-theme-${theme}.png`) });
}
const badThemes = themeLayouts.filter((l) => !l.vertical || l.sidebarW < 150 || l.header > 70);
record('theme packs keep the sidebar vertical and the header compact', badThemes.length === 0, JSON.stringify(badThemes.length ? badThemes : themeLayouts.map((l) => `${l.themeApplied}:${l.header}px`)));

await session.send('Emulation.clearDeviceMetricsOverride');
record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
