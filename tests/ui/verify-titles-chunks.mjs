// Scratch: docs/design/03 §4 — the titles list builds rows in chunks as you scroll.
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
await wait(800);
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
const big = await page.evaluate(() => { const c = window.S.config.channels.slice().sort((a, b) => b.files.length - a.files.length)[0]; return { number: c.number, files: c.files.length }; });
await page.locator(`#channel-list-pane .channel-list-item[data-channel-number="${big.number}"]`).click();
await wait(500);
const panelSel = `#channel-${big.number}-edit-panel`;

const timings = [];
for (let run = 0; run < 3; run += 1) {
  await page.locator(`#channel-${big.number}-edit-tab-overview`).click();
  await wait(300);
  timings.push(await page.evaluate(async (n) => {
    const t0 = performance.now();
    document.getElementById(`channel-${n}-edit-tab-content`).click();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return Math.round(performance.now() - t0);
  }, big.number));
}
const first = await page.evaluate((sel) => ({ rows: document.querySelectorAll(`${sel} .title-row`).length, nodes: document.querySelectorAll(`${sel} *`).length, more: document.querySelector(`${sel} .title-rows-more`)?.textContent }), panelSel);
record(`opening a ${big.files}-file CONTENT page builds only the first rows`, first.rows <= 180 && first.rows >= 60 && /of \d+/.test(first.more || ''), `${JSON.stringify(first)} in ${timings.join('/')} ms (was ~1150 ms, 1329 rows)`);
record('opening it takes well under the old second', Math.min(...timings) < 500, `${timings.join('/')} ms`);

// Scroll to the bottom repeatedly: every row gets built and the "more" line goes away.
let rows = first.rows;
for (let i = 0; i < 60 && rows < big.files; i += 1) {
  await page.evaluate(() => { const c = document.getElementById('setup-content'); c.scrollTop = c.scrollHeight; });
  await wait(120);
  rows = await page.evaluate((sel) => document.querySelectorAll(`${sel} .title-row`).length, panelSel);
}
const done = await page.evaluate((sel) => ({ rows: document.querySelectorAll(`${sel} .title-row`).length, more: !!document.querySelector(`${sel} .title-rows-more`) }), panelSel);
record('scrolling down builds the rest until every file has a row', done.rows === big.files && !done.more, JSON.stringify(done));

// Search reaches files whose rows were never built; select all takes every visible file.
await page.locator(`#channel-${big.number}-edit-tab-overview`).click();
await wait(200);
await page.locator(`#channel-${big.number}-edit-tab-content`).click();
await wait(400);
const lastName = await page.evaluate((n) => { const ch = window.S.config.channels.find((c) => c.number === n); const f = ch.files[ch.files.length - 1]; return f.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''); }, big.number);
const search = page.locator(`${panelSel} .titles-search`).first();
await search.fill(lastName);
await wait(400);
const found = await page.evaluate(({ sel, name }) => Array.from(document.querySelectorAll(`${sel} .title-row-file`)).some((el) => el.textContent === name), { sel: panelSel, name: lastName });
record('search finds the last file even though its row was never built', found, lastName);
await search.fill('');
await wait(300);
const selectAll = await page.evaluate((sel) => {
  const btn = Array.from(document.querySelectorAll(`${sel} button`)).find((b) => /^SELECT VISIBLE$/.test(b.textContent.trim()));
  if (!btn) return null;
  btn.click();
  const count = Array.from(document.querySelectorAll(`${sel} *`)).map((el) => el.textContent).find((t) => /^\d+ SELECTED$/.test(t));
  const none = Array.from(document.querySelectorAll(`${sel} button`)).find((b) => /^SELECT NONE$|^CLEAR$/.test(b.textContent.trim()));
  if (none) none.click();
  return count;
}, panelSel);
record('SELECT ALL counts every file, not just built rows', selectAll === `${big.files} SELECTED`, String(selectAll));

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
