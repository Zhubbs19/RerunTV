// Captures the README / website screenshots (docs/screenshots/) from the synthetic demo library.
//
// Run it from a clean clone of the repo, not a working checkout: a dev profile copies every
// folder in plugins/ into itself, so local-only plugins would show up in the pictures.
//   node scripts/make-demo-library.js demo-library --config demo-userdata --seconds 1320
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource demo-userdata -Script capture-doc-screenshots.mjs
// --seconds 1320 makes 22-minute programs. The default 8-minute clips are narrower than a
// guide label, so the guide folds them into "Shorts & Bumpers" cells.
//
// Writes 1920x1080 PNGs to tests/ui/doc-screenshots/ (override with RERUNTV_SHOTS_OUT) in both
// cable-guide skins: live TV with the channel banner, the docked and full-page guide, the time
// machine rewinding, and channel setup. docs/screenshots/ takes the Classic live, full guide,
// time machine and setup shots plus the HD full guide (guide-hd.jpg), as JPEG (ffmpeg -q:v 3)
// except setup.png. Nothing is saved back to the config: every change here is in-memory.

// The page.evaluate callbacks run inside the app's renderer, where these exist.
/* global document, window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
const outDir = path.resolve(process.env.RERUNTV_SHOTS_OUT || path.join('tests', 'ui', 'doc-screenshots'));
const WIDTH = 1920;
const HEIGHT = 1080;
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 40 && !page; i += 1) {
  page = context.pages().find((candidate) => candidate.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => { setTimeout(r, 500); });
}
if (!page) throw new Error('RerunTV renderer page not found');
page.setDefaultTimeout(30_000);
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// A fixed 1920x1080 picture whatever screen the window opened on.
await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(2500);

if (await page.locator('.onboarding-screen').count()) {
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await page.getByRole('button', { name: 'SAVE & OPEN CHANNEL SETUP' }).click();
  await page.waitForTimeout(600);
}

async function shot(name) {
  // The one-time "config was updated" toast a fresh demo profile gets.
  await page.evaluate(() => document.getElementById('migration-toast')?.classList.add('hidden'));
  // Page.captureScreenshot sometimes never answers on a busy renderer: race it, and retry.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timer = new Promise((_, reject) => { setTimeout(() => reject(new Error('timed out')), 10_000); });
    try {
      const { data } = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }), timer]);
      await fs.writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`captured ${name}`);
      return;
    } catch (e) {
      console.log(`retry ${name} (${e.message})`);
      await page.waitForTimeout(500);
    }
  }
  console.log(`SKIPPED ${name}`);
}

async function step(name, fn) {
  try { await fn(); } catch (e) { console.log(`FAILED ${name}: ${e.message}`); errors.push(`${name}: ${e.message}`); }
}

async function mute() {
  await page.evaluate(() => { document.querySelectorAll('video, audio').forEach((m) => { m.volume = 0; }); });
}

async function setTheme(id) {
  await page.evaluate((themeId) => {
    window.S.config.theme = themeId;
    window.applyTheme();
  }, id);
  await page.waitForTimeout(600);
}

async function showTv(number) {
  await page.evaluate(async (num) => {
    const { showTvScreen } = await import('app://bundle/renderer/js/app.js');
    await showTvScreen();
    const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js');
    await tuneToChannel(num);
  }, number);
  await mute();
  await page.waitForTimeout(1500);
  await mute();
}

async function showSetup() {
  await page.evaluate(async () => {
    const { showSetupScreen } = await import('app://bundle/renderer/js/app.js');
    await showSetupScreen();
  });
  await page.waitForTimeout(500);
}

async function closeOverlays() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

for (const theme of ['cable-guide-hd-15', 'cable-guide-classic-05']) {
  const tag = theme === 'cable-guide-hd-15' ? 'hd' : 'classic';
  await step(`${tag} theme`, () => setTheme(theme));

  await step(`${tag} live`, async () => {
    await showTv(7);
    // Channel up to 9 (the bluest demo picture) so the channel banner is on screen, as it is after a real change.
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(1600);
    await mute();
    await shot(`${tag}-live`);
  });

  await step(`${tag} guide`, async () => {
    await page.keyboard.press('g');
    await page.waitForTimeout(900);
    await shot(`${tag}-guide`);
    await page.keyboard.press('d');
    await page.waitForTimeout(700);
    await shot(`${tag}-guide-full`);
    await page.keyboard.press('d');
    await page.waitForTimeout(300);
    await page.keyboard.press('g');
    await page.waitForTimeout(400);
  });

  await step(`${tag} time machine`, async () => {
    await page.keyboard.press('t');
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(2200);
    await shot(`${tag}-time-machine`);
    await page.keyboard.press('l');
    await page.waitForTimeout(800);
    await closeOverlays();
  });

  await step(`${tag} setup`, async () => {
    await showSetup();
    await page.evaluate(() => { window.S.setupSelectedChannel = 9; });
    const row = page.locator('.setup-tab-btn[data-tab="channels"]');
    if (await row.count()) await row.first().click();
    await page.waitForTimeout(400);
    const row9 = page.locator('[data-channel-number="9"]').first();
    if (await row9.count()) { await row9.click(); await page.waitForTimeout(400); }
    await shot(`${tag}-setup`);
  });
}

await fs.writeFile(path.join(outDir, 'errors.json'), `${JSON.stringify(errors, null, 2)}\n`);
await browser.close();
console.log(`done, ${errors.length} error(s)`);
