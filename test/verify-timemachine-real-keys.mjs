// Simulates REAL keyboard input (not direct function calls) through the
// live TV screen: T to enter time machine, arrow keys to shuttle, [ ] to
// jump to break - to see if the keyboard event pipeline itself (app.js's
// handleKey) actually reaches the already-verified-working timemachine.js
// functions, or breaks somewhere before that.
import { chromium } from 'playwright-core';

const port = process.env.RERUNTV_AUDIT_PORT || '9222';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 40 && !page; i += 1) {
  page = context.pages().find((c) => c.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) throw new Error('page not found');
page.setDefaultTimeout(30_000);
const runtimeErrors = [];
page.on('pageerror', (e) => runtimeErrors.push(e.message));

// Tune to channel 71 via real function (as if the user pressed channel-up
// enough times / used direct entry) - not a UI concern, just getting there.
await page.evaluate(async () => {
  const playback = await import('./js/playback-core.js');
  await playback.tuneToChannel(71);
});
await page.waitForTimeout(1500);

// Force a clean starting state - a previous test run in this same live
// session may have left S.timeMachineOn stuck true, which would make the
// first real 'T' press below CLOSE time machine instead of opening it
// (T is a 3-way cycle - see app.js's comment on the 't'/'T' case).
await page.evaluate(async () => {
  const tm = await import('./js/timemachine.js');
  if (window.S.timeMachineOn) tm.exitTimeMachine();
});
await page.waitForTimeout(300);

async function state() {
  return page.evaluate(() => ({
    timeMachineOn: window.S.timeMachineOn,
    shuttleDir: window.S.shuttleDir,
    timeOffsetMs: window.S.timeOffsetMs,
    tvScreenHidden: document.getElementById('tv-screen').classList.contains('hidden'),
    vcrOsdHidden: document.getElementById('vcr-osd').classList.contains('hidden'),
    isPoweredOn: window.S.isPoweredOn,
    guideHidden: document.getElementById('guide-grid').classList.contains('hidden'),
    shortcutsHidden: document.getElementById('shortcuts-overlay')?.classList.contains('hidden'),
  }));
}

console.log('Initial state:', JSON.stringify(await state()));

// Real key press: T
await page.keyboard.press('t');
await page.waitForTimeout(300);
console.log('After pressing T:', JSON.stringify(await state()));

// Real key press: ArrowLeft (shuttle backward) - hold briefly.
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(600);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(300);
console.log('After ArrowLeft shuttle:', JSON.stringify(await state()));

// Real key press: ] (jump to next break)
const before = await state();
await page.keyboard.press(']');
await page.waitForTimeout(500);
const after = await state();
console.log('Before ]:', JSON.stringify(before));
console.log('After ]:', JSON.stringify(after));
console.log('timeOffsetMs changed:', before.timeOffsetMs !== after.timeOffsetMs);

console.log('Runtime errors:', runtimeErrors);
process.exit(0);
