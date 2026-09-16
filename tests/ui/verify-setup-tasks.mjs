// Scratch: docs/design/03 §4 status bar — background task progress follows you across sections.
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
const status = () => page.evaluate(() => { const el = document.getElementById('setup-task-status'); return { shown: !el.hidden && el.offsetParent !== null, text: el.textContent.trim() }; });

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

record('nothing shows in the status bar when nothing is running', !(await status()).shown, JSON.stringify(await status()));

// The channel page's scan line is mirrored, and stays visible on other sections.
await page.evaluate(() => { const el = document.getElementById('scan-progress'); el.classList.remove('hidden'); el.textContent = 'PROBING VIDEO 3 / 40…'; });
await wait(100);
await page.locator('.setup-tab-btn[data-tab="household"]').click();
await wait(200);
let s = await status();
record('a folder scan shows in the status bar on another section', s.shown && s.text === 'PROBING VIDEO 3 / 40…', JSON.stringify(s));
await page.evaluate(() => { document.getElementById('scan-progress').textContent = 'PROBING VIDEO 4 / 40…'; });
await wait(100);
s = await status();
record('its progress text updates', s.text === 'PROBING VIDEO 4 / 40…', s.text);
await page.evaluate(() => document.getElementById('scan-progress').classList.add('hidden'));
await wait(100);
record('it disappears when the scan line hides', !(await status()).shown);

// A real health check reports while it runs and clears after.
const seen = await page.evaluate(async () => {
  const { checkChannelHealth } = await import('app://bundle/renderer/js/setup/channels-diagnostics.js');
  const el = document.getElementById('setup-task-status');
  const running = checkChannelHealth();
  await Promise.resolve();
  const during = { shown: !el.hidden, text: el.textContent.trim() };
  const total = await running;
  return { during, after: { shown: !el.hidden }, total };
});
record('a health check shows while it runs and clears when done', seen.during.shown && /CHECKING CHANNEL FILES/.test(seen.during.text) && !seen.after.shown && Number.isFinite(seen.total), JSON.stringify(seen));

// Two tasks at once read as one line with a count.
const both = await page.evaluate(async () => {
  const { beginTask } = await import('app://bundle/renderer/js/setup/tasks.js');
  const a = beginTask('SYNCING LIBRARY FOLDERS…');
  const b = beginTask('CHECKING CHANNEL FILES…');
  const text = document.getElementById('setup-task-status').textContent.trim();
  a.end(); b.end();
  return { text, hidden: document.getElementById('setup-task-status').hidden };
});
record('two tasks show the latest with a count', both.text === 'CHECKING CHANNEL FILES… (+1 MORE)' && both.hidden, JSON.stringify(both));

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
