// Scratch: docs/design/03 §3 sections + §9 layout acceptance on every page.
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
const shots = true;

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

const labels = await page.evaluate(() => Array.from(document.querySelectorAll('.setup-tab-btn')).map((b) => b.textContent.trim()));
record('sidebar lists the doc 03 sections in order', JSON.stringify(labels) === JSON.stringify(['CHANNELS', 'PROGRAMMING', 'LIBRARY', 'PICTURE & SOUND', 'GUIDE & THEME', 'HOUSEHOLD', 'SYSTEM', 'PLUG-INS', 'HELP']), labels.join(' | '));

// Every page and sub-page at 1280x720: no horizontal scroll, no nested vertical
// scroll box on settings pages (collections may scroll a list), title set.
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await wait(500);
record('emulating 1280×720', await page.evaluate(() => innerWidth === 1280 && innerHeight === 720), await page.evaluate(() => innerWidth + 'x' + innerHeight));
const pages = await page.evaluate(() => Array.from(document.querySelectorAll('.setup-tab-panel')).flatMap((panel) => {
  const tab = panel.dataset.tabPanel;
  const subs = Array.from(panel.querySelectorAll(':scope > .setup-subtabs .setup-subtab-btn')).map((b) => b.dataset.subtab);
  return subs.length ? subs.map((sub) => ({ tab, sub })) : [{ tab, sub: null }];
}));
const problems = [];
for (const p of pages) {
  await page.locator(`.setup-tab-btn[data-tab="${p.tab}"]`).click();
  if (p.sub) await page.locator(`.setup-tab-panel[data-tab-panel="${p.tab}"] .setup-subtab-btn[data-subtab="${p.sub}"]`).click();
  await wait(350);
  const m = await page.evaluate(() => {
    const content = document.getElementById('setup-content');
    const vw = document.documentElement.clientWidth;
    const nested = Array.from(content.querySelectorAll('*')).filter((el) => {
      if (el.offsetParent === null || el.closest('.list-detail, .channel-list-pane')) return false;
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 40;
    }).map((el) => el.id || el.className.toString().split(' ')[0]);
    return {
      hScroll: content.scrollWidth > content.clientWidth + 1 || document.body.scrollWidth > vw + 1,
      chrome: document.querySelector('.setup-nav').offsetHeight + document.querySelector('.setup-status-bar').offsetHeight,
      nested,
      title: document.getElementById('setup-page-title').textContent,
      shellShift: Array.from(document.querySelectorAll('html, body, #setup-screen, .setup-panel, .setup-main')).filter((el) => el.scrollTop > 0).map((el) => (el.id || el.className.toString().split(' ')[0] || el.tagName) + ':' + el.scrollTop).join(' ') + ' navTop=' + Math.round(document.querySelector('.setup-nav').getBoundingClientRect().top),
    };
  });
  const name = p.sub ? `${p.tab}/${p.sub}` : p.tab;
  if (m.shellShift !== ' navTop=0') problems.push(`${name}: shell shifted ${m.shellShift}`);
  if (m.hScroll) problems.push(`${name}: horizontal scroll`);
  if (m.chrome > 104 || m.chrome < 96) problems.push(`${name}: chrome ${m.chrome}px`);
  if (m.nested.length) problems.push(`${name}: nested scroll ${m.nested.join(',')}`);
  if (shots) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join('test/screenshots', `section-${name.replace('/', '-')}.png`), Buffer.from(shot.data, 'base64'));
  }
}
console.log(problems.join('\n'));
console.log('RECTS', JSON.stringify(await page.evaluate(() => Object.fromEntries(['.setup-main', '.setup-nav', '.setup-header', '#setup-page-title', '#setup-content', '.setup-tab-panel:not(.hidden) .setup-subtabs', '.setup-status-bar'].map((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return [q, r && [Math.round(r.top), Math.round(r.height)]]; })))));
const scrolled = await page.evaluate(() => Array.from(document.querySelectorAll('html, body, #setup-screen, .setup-panel, .setup-main, .setup-nav, .setup-sidebar'))
  .filter((el) => el.scrollTop > 0).map((el) => `${el.id || el.className.toString().split(' ')[0] || el.tagName}:${el.scrollTop}`));
record('the shell itself never scrolls (only #setup-content does)', scrolled.length === 0, scrolled.join(' '));
record(`${pages.length} pages: no horizontal scroll and chrome ≤ 104 px at 1280×720`, !problems.some((x) => /horizontal|chrome/.test(x)));
record('no nested scroll boxes on any page', !problems.some((x) => /nested/.test(x)));

// Diagnostics refreshes only while shown.
await page.locator('.setup-tab-btn[data-tab="audio"]').click();
await page.locator('.setup-tab-panel[data-tab-panel="audio"] .setup-subtab-btn[data-subtab="status"]').click();
await page.evaluate(() => { document.getElementById('perf-fps-val').textContent = 'X'; });
await wait(1300);
const live = await page.evaluate(() => document.getElementById('perf-fps-val').textContent);
await page.locator('.setup-tab-panel[data-tab-panel="audio"] .setup-subtab-btn[data-subtab="backups"]').click();
await page.evaluate(() => { document.getElementById('perf-fps-val').textContent = 'X'; });
await wait(1300);
const stopped = await page.evaluate(() => document.getElementById('perf-fps-val').textContent);
record('System › Diagnostics refreshes while shown and stops when left', live !== 'X' && stopped === 'X', `${live} / ${stopped}`);

// Search lands in the new homes.
for (const [q, tab, id] of [['parental', 'household', 'pin-lock-enabled'], ['commercials and bumpers', 'display', 'ad-volume-slider'], ['update policy', 'audio', 'update-mode-select'], ['keep channel folders', 'library', 'library-sync-enabled']]) {
  await page.locator('#setup-search').fill(q);
  await wait(300);
  await page.keyboard.press('Enter');
  await wait(600);
  const where = await page.evaluate(() => ({ tab: document.querySelector('.setup-tab-btn.active')?.dataset.tab, focus: document.activeElement?.id }));
  record(`search "${q}" opens ${tab}`, where.tab === tab && where.focus === id, JSON.stringify(where));
}

await cdp.send('Emulation.clearDeviceMetricsOverride');
record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
