// Scratch: docs/design/03 §9 — rename a watched channel and change its rating in three actions:
// press S, type the name, pick the rating.
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
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();

// Watch channel 7 (or the third channel) on the TV screen, with setup last left on another channel.
const target = await page.evaluate(async () => {
  const list = window.S.config.channels.slice().sort((a, b) => a.number - b.number);
  const ch = list.find((c) => c.number === 7) || list[2];
  window.S.setupSelectedChannel = list[0].number;
  const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js');
  await tuneToChannel(ch.number);
  return { number: ch.number, name: ch.name, rating: ch.rating || '' };
});
await wait(1500);

// 1. Press S.
await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press('s');
await wait(1500);
const opened = await page.evaluate(() => ({ setup: !document.getElementById('setup-screen').classList.contains('hidden'), tab: document.querySelector('.setup-tab-btn.active')?.dataset.tab, selected: document.querySelector('#channel-list-pane .channel-list-item.selected')?.dataset.channelNumber }));
record('pressing S opens setup on the channel being watched', opened.setup && opened.selected === String(target.number), JSON.stringify(opened));

// 2. Type the name (the name field is on the channel card, no expanding needed).
const nameInput = page.locator('#channel-list .channel-row input[placeholder="CHANNEL NAME"]');
const nameVisible = await nameInput.isVisible();
await nameInput.fill(`${target.name} Test`);
// 3. Pick the rating (on OVERVIEW, the default page).
const rating = page.locator(`#channel-${target.number}-edit-panel select.rating-select`);
const ratingVisible = await rating.isVisible();
const newRating = target.rating === 'TV-PG' ? 'TV-G' : 'TV-PG';
await rating.selectOption(newRating);
await wait(400);
const saved = await page.evaluate((n) => { const c = window.S.config.channels.find((x) => x.number === n); return { name: c.name, rating: c.rating }; }, target.number);
record('the name field and the rating are both on screen without expanding anything', nameVisible && ratingVisible);
record('three actions rename the channel and change its rating', saved.name === `${target.name} Test` && saved.rating === newRating, JSON.stringify(saved));

await page.keyboard.press('Control+z');
await wait(200);
await page.keyboard.press('Control+z');
await wait(400);
record('undo restores both', await page.evaluate(({ n, name, r }) => { const c = window.S.config.channels.find((x) => x.number === n); return c.name === name && (c.rating || '') === r; }, { n: target.number, name: target.name, r: target.rating }));

record('no renderer page errors', errors.length === 0, errors.slice(0, 3).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
