// Drives the REAL time-machine UI (not just the pure functions) against the
// real Disney config: tune to ch 71, enter time machine, scrub to a known
// ad-break timestamp, and check whether the shuttle preview actually shows
// something break-like - plus test the jump-to-break keys end to end.
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

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
if (await page.locator('.onboarding-screen').count()) {
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await page.getByRole('button', { name: 'SAVE & OPEN CHANNEL SETUP' }).click();
  await page.waitForTimeout(600);
}

// Tune to channel 71 via the real function (not S.currentNumber directly).
await page.evaluate(async () => {
  const playback = await import('./js/playback/core.js');
  await playback.tuneToChannel(71);
});
await page.waitForTimeout(1500);

const beforeTimeOffset = await page.evaluate(() => window.S.timeOffsetMs);
console.log('timeOffsetMs before entering time machine:', beforeTimeOffset);

// Enter time machine mode the same way the real 'T' key does.
const tmInfo = await page.evaluate(async () => {
  const tm = await import('./js/playback/timemachine.js');
  tm.enterTimeMachine();
  return { timeMachineOn: window.S.timeMachineOn };
});
console.log('After enterTimeMachine:', JSON.stringify(tmInfo));

// Find the next ad break's start via the real functions, then jump straight
// to a moment WELL BEFORE it and manually set the offset the way scrubbing
// would, then call updateShuttlePreview directly (the real function the
// shuttle-drag/tick loop calls) and inspect what actually got shown.
const scrubResult = await page.evaluate(async () => {
  const interstitials = await import('./js/core/interstitials.js');
  const state = await import('./js/core/state.js');
  const tm = await import('./js/playback/timemachine.js');
  const ch = window.getChannel(71);

  // Find an upcoming real (video-file) ad break.
  let found = null;
  let t = state.viewNow();
  for (let i = 0; i < 10 && !found; i++) {
    const start = interstitials.nextBreakStart(ch, t);
    if (!isFinite(start)) break;
    const brk = interstitials.resolveBreakAt(ch, start);
    if (brk && ['adBreakIn', 'commercial', 'adBreakOut'].includes(brk.type)) found = { start, brk };
    else t = brk ? brk.windowEnd : start + 1;
  }
  if (!found) return { error: 'no ad break found ahead of now' };

  // Scrub to 2 seconds into that break (same as landing there via jump-to-break).
  const targetMs = found.start + 2000;
  window.S.timeOffsetMs = targetMs - Date.now();
  await tm.updateShuttlePreview();

  return {
    breakType: found.brk.type,
    hasEntryFile: !!(found.brk.entry && found.brk.entry.file),
    playerSrc: window.RCBPlugins.ctx.player.src,
    playerPaused: window.RCBPlugins.ctx.player.paused,
    stationIdBarShown: !document.getElementById('station-id-bar').classList.contains('hidden') && document.getElementById('station-id-bar').classList.contains('show'),
    triviaCardShown: !document.getElementById('trivia-card').classList.contains('hidden'),
    localAvailCardShown: !document.getElementById('local-avail-card').classList.contains('hidden'),
  };
});
console.log('Scrub-to-break result:', JSON.stringify(scrubResult, null, 2));

// Now test the actual jump-to-break function end to end.
const jumpResult = await page.evaluate(async () => {
  const tm = await import('./js/playback/timemachine.js');
  const before = window.S.timeOffsetMs;
  await tm.jumpToNextBreak();
  const after = window.S.timeOffsetMs;
  return { before, after, changed: before !== after, timeMachineOnDuring: window.S.timeMachineOn };
});
console.log('jumpToNextBreak result:', JSON.stringify(jumpResult, null, 2));

console.log('runtime errors:', runtimeErrors);
process.exit(0);
