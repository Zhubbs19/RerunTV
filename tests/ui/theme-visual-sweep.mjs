// Fast, real-data theme visual sweep. Based on ui-theme-matrix.mjs (proven —
// 46 screenshots across 23 themes in ~6.5 minutes in an earlier pass), minus
// its synthetic-fixture channel injection: this version runs against
// whatever real channels.json is already loaded into the throwaway userData
// the .ps1 wrapper seeds (a copy of the real one, so real media paths
// resolve and channel-flipping/guide views show real content).
//
// Never calls saveConfig/saveConfigDebounced — every mutation here
// (S.config.theme, tuning) is in-memory only, so even if this were ever run
// against real userData directly (it isn't — the wrapper always copies),
// nothing would be persisted back.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const port = process.env.RERUNTV_AUDIT_PORT || '9222';
const requestedTheme = process.argv.find((arg) => arg.startsWith('--theme='))?.split('=')[1] || '';
// Defaults inside tests/ui/ (the .ps1 wrapper always runs this with the repo
// root as cwd), not repo-root screenshots/ — only tests/ui/ is gitignored, and
// 400+MB of PNGs at repo root would otherwise sit there ready to be swept
// into a `git add -A` by accident (this happened once already).
const outputDir = path.resolve(process.argv.find((arg) => arg.startsWith('--out='))?.split('=')[1] || path.join('tests', 'ui', 'theme-sweep-screenshots'));
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
// Real userData means main.js's startup update-check gate (strategy
// "startup-auto") shows a separate small "CHECKING FOR UPDATES" window
// first and only creates the real renderer window once that resolves (up
// to a 12s network-timeout fallback) — a fresh/synthetic userData skips
// this via the first-run flag, which is why a single immediate
// context.pages() grab worked in that case but not here. Poll instead.
let page = null;
for (let i = 0; i < 40 && !page; i += 1) {
  page = context.pages().find((candidate) => candidate.url().includes('renderer/index.html'));
  if (!page) await new Promise((resolve) => { setTimeout(resolve, 500); });
}
if (!page) throw new Error('RerunTV renderer page was not found (still waiting after 20s — check the startup update-check gate)');
page.setDefaultTimeout(30_000);
const cdp = await context.newCDPSession(page);
const runtimeErrors = [];
page.on('pageerror', (error) => runtimeErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
if (await page.locator('.onboarding-screen').count()) {
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await page.getByRole('button', { name: 'SAVE & OPEN CHANNEL SETUP' }).click();
  await page.waitForTimeout(600);
}
// A real (installed) userData carries an update history, so the post-update
// WHAT'S NEW dialog opens off an unawaited IPC promise and then covers the
// whole app — every click below failed against it, for every theme. Await
// the same IPC so the dialog is already up, then close it (same approach as
// run-ui-tests.mjs).
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) {
    try { await window.api.getPostUpdateNotice(); } catch (e) { /* no notice */ }
  }
});
await page.waitForTimeout(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) {
  await page.locator('#update-changelog-done').click();
  await page.waitForTimeout(250);
}
if (await page.locator('#setup-screen').evaluate((element) => element.classList.contains('hidden'))) {
  await page.keyboard.press('s');
  await page.waitForTimeout(350);
}

const firstRealChannel = await page.evaluate(() => {
  const channels = window.S.config.channels || [];
  return channels.length ? channels[0].number : null;
});

let themeIds = await page.locator('#theme-select option').evaluateAll((options) => (
  [...new Set(options.map((option) => option.value).filter(Boolean))]
));
if (requestedTheme) themeIds = themeIds.filter((id) => id === requestedTheme);
if (!themeIds.length) throw new Error(`Theme not found: ${requestedTheme}`);
const originalTheme = await page.evaluate(() => ({
  applied: document.documentElement.dataset.theme || 'digital-2000s',
  configured: window.S.config.theme || 'digital-2000s',
}));

const screenStates = await page.evaluate(() => {
  const states = [];
  document.querySelectorAll('#setup-tabs .setup-tab-btn').forEach((tab) => {
    const tabId = tab.dataset.tab;
    const workspaces = (tab.dataset.workspaces || 'viewing headend').split(/\s+/);
    const workspace = workspaces.includes('viewing') ? 'viewing' : 'headend';
    const panel = document.querySelector(`.setup-tab-panel[data-tab-panel="${tabId}"]`);
    const subtabs = Array.from(panel?.querySelectorAll(':scope > .setup-subtabs .setup-subtab-btn') || []);
    if (!subtabs.length) states.push({ workspace, tab: tabId, subtab: null, name: tabId });
    else subtabs.forEach((subtab) => states.push({
      workspace,
      tab: tabId,
      subtab: subtab.dataset.subtab,
      name: `${tabId}-${subtab.dataset.subtab}`,
    }));
  });
  return states;
});

async function settle() {
  await page.waitForTimeout(90);
  await page.evaluate(() => { const el = document.getElementById('setup-content') || document.getElementById('setup-screen'); el.scrollTop = 0; });
}

async function capture(dir, fileName) {
  await settle();
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  await fs.writeFile(path.join(dir, fileName), Buffer.from(data, 'base64'));
}

async function activateState(state) {
  // Older builds grouped tabs into workspaces; the setup shell (docs/design/03)
  // lists every section in its sidebar, so there is nothing to switch first.
  const workspaceBtn = page.locator(`.setup-workspace-btn[data-setup-workspace="${state.workspace}"]`);
  if (await workspaceBtn.count()) await workspaceBtn.click();
  await page.locator(`.setup-tab-btn[data-tab="${state.tab}"]`).click();
  if (state.subtab) {
    const panel = page.locator(`.setup-tab-panel[data-tab-panel="${state.tab}"]`);
    await panel.locator(`.setup-subtab-btn[data-subtab="${state.subtab}"]`).click();
  }
}

const report = { generatedAt: new Date().toISOString(), themes: themeIds, screens: screenStates, captures: [], runtimeErrors };

for (let themeIndex = 0; themeIndex < themeIds.length; themeIndex += 1) {
  const themeId = themeIds[themeIndex];
  const themeDir = path.join(outputDir, `theme-${themeId}`);
  try {
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(themeDir, { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate((id) => {
      window.S.config.theme = id;
      document.documentElement.dataset.theme = id;
    }, themeId);

    for (const state of screenStates) {
      // eslint-disable-next-line no-await-in-loop
      await activateState(state);
      const fileName = `${state.name}.png`;
      // eslint-disable-next-line no-await-in-loop
      await capture(themeDir, fileName);
      report.captures.push({ theme: themeId, state: state.name, file: path.join(`theme-${themeId}`, fileName) });
    }

    // Real on-air TV view — actually tune via tuneToChannel (not a bare
    // S.currentNumber assignment, which doesn't invoke playback) so a real
    // channel's real media is genuinely live before the guide is captured.
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async (num) => {
      const { showTvScreen } = await import('app://bundle/renderer/js/app.js');
      await showTvScreen();
      if (num != null) {
        const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js');
        await tuneToChannel(num);
      }
    }, firstRealChannel);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(400);
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('g');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(350);
    let fileName = 'tv-guide.png';
    // eslint-disable-next-line no-await-in-loop
    await capture(themeDir, fileName);
    report.captures.push({ theme: themeId, state: 'tv-guide', file: path.join(`theme-${themeId}`, fileName) });

    // Full-page guide (the 'd' hotkey / DOCK / FULL PAGE hint — toggleGuideDockMode,
    // guide.js) — a distinct layout from the docked overlay above, not just a
    // scaled-up version of it, so it needs its own capture per theme.
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('d');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(300);
    fileName = 'tv-guide-full.png';
    // eslint-disable-next-line no-await-in-loop
    await capture(themeDir, fileName);
    report.captures.push({ theme: themeId, state: 'tv-guide-full', file: path.join(`theme-${themeId}`, fileName) });
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('d');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(150);

    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('g');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(150);
    fileName = 'tv-live.png';
    // eslint-disable-next-line no-await-in-loop
    await capture(themeDir, fileName);
    report.captures.push({ theme: themeId, state: 'tv-live', file: path.join(`theme-${themeId}`, fileName) });

    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => {
      const { showSetupScreen } = await import('app://bundle/renderer/js/app.js');
      await showSetupScreen();
    });
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(180);
    process.stdout.write(`Captured ${themeIndex + 1}/${themeIds.length}: ${themeId}\n`);
  } catch (e) {
    // One theme's runtime error (a bad channelChangeSfx hook, a missing
    // asset, whatever) must not abort the whole sweep — record it and move
    // on to the next theme, same "one plugin's failure is isolated" spirit
    // as the rest of this codebase's plugin-loading error handling.
    report.captures.push({ theme: themeId, state: 'ERROR', error: e.message });
    process.stdout.write(`FAILED ${themeIndex + 1}/${themeIds.length}: ${themeId} — ${e.message}\n`);
    // eslint-disable-next-line no-await-in-loop
    try {
      await page.evaluate(async () => {
        const { showSetupScreen } = await import('app://bundle/renderer/js/app.js');
        await showSetupScreen();
      });
    } catch (e2) { /* best-effort recovery only */ }
  }
}

await page.evaluate(({ applied, configured }) => {
  window.S.config.theme = configured;
  document.documentElement.dataset.theme = applied;
}, originalTheme);
await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
console.log(JSON.stringify({
  outputDir, themes: themeIds.length, screensPerTheme: screenStates.length + 3, captures: report.captures.length, runtimeErrors: runtimeErrors.length,
}, null, 2));
