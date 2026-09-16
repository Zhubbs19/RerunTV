// Scratch driver: the TV-mode docked-guide picture shrink (docs/design/11 §2.2),
// the one explicit omission left in doc 11.
//
// What makes this worth doing live rather than as a unit test: the thing being
// checked is a GEOMETRIC relationship between three things that are each
// computed at runtime — the strip's resolved height after CSS clamping, the
// picture's fitted rect after the bezel's safe-area/crop math, and the video's
// own aspect ratio. None of that exists outside a running renderer.
//
// Run it through the wrapper, never directly:
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource "C:\Users\zhubb\Apps\RerunTV\userData" `
//     -Script verify-docked-picture.mjs
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) { console.log('FAIL could not find the renderer page'); process.exit(1); }

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
async function step(name, fn) { try { await fn(); } catch (e) { record(name, false, e.message.split('\n')[0]); } }

await wait(3500);
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();

// Tune to something real and let its metadata arrive — the bezel math needs a
// decoded videoWidth/videoHeight to frame anything at all.
await page.evaluate(async () => {
  const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js');
  const first = [...window.S.config.channels].sort((a, b) => a.number - b.number)[0];
  await tuneToChannel(first.number);
});
await wait(4000);

// The theme picker is only populated once the setup screen has rendered, and
// the sweep reads the same element — so open it once, then go back to the TV.
await page.evaluate(async () => {
  const { showSetupScreen, showTvScreen } = await import('app://bundle/renderer/js/app.js');
  await showSetupScreen();
  await showTvScreen();
});
await wait(1500);

// A helper that reads the live geometry of everything involved.
const geometry = () => page.evaluate(() => {
  const crt = document.querySelector('.crt');
  const player = document.getElementById('player');
  const grid = document.querySelector('.guide-grid');
  // LAYOUT pixels, not bounding rects. Two things make rects the wrong unit
  // here: the app can scale the whole stage (simulated resolution, viewer UI
  // zoom), and .guide-grid is a SIBLING of #display-frame rather than a child,
  // so the strip and the picture can sit in different transform contexts. A
  // rect-to-rect comparison across that boundary is not measuring what it
  // looks like it is measuring — it read "picture bottom 337, strip top 296"
  // for a picture that was in fact exactly the right size.
  //
  // offsetTop/offsetHeight and clientHeight are all pre-transform, and the
  // player's offsetParent is inside the container, so these are comparable.
  const rect = player.getBoundingClientRect();
  return {
    mode: document.documentElement.dataset.mode,
    docked: crt.classList.contains('guide-docked'),
    guideOpen: !grid.classList.contains('hidden'),
    containerH: crt.clientHeight,
    stripH: grid.offsetHeight,
    // What is left for the picture once the strip has taken its share.
    availableH: crt.clientHeight - grid.offsetHeight,
    pictureTop: player.offsetTop,
    pictureH: player.offsetHeight,
    pictureBottom: player.offsetTop + player.offsetHeight,
    offsetParent: player.offsetParent ? (player.offsetParent.id || player.offsetParent.className) : null,
    pictureVar: crt.style.getPropertyValue('--guide-picture-h'),
    // Only for the aspect-ratio check, where a single element's own rect is
    // internally consistent whatever it sits inside.
    drawn: { w: rect.width, h: rect.height },
    video: { w: player.videoWidth, h: player.videoHeight },
  };
});

// isTvMode() answers from usage-mode.js's own resolved state, not from the
// data-mode attribute, so the preference is what has to change.
const setMode = async (mode) => {
  await page.evaluate(async (m) => {
    const usage = await import('app://bundle/renderer/js/tv/usage-mode.js');
    usage.setUsageModePreference(m);
  }, mode);
  await wait(400);
};
const openGuide = () => page.evaluate(async () => {
  const guide = await import('app://bundle/renderer/js/guide/guide.js');
  window.S.guideDocked = true;
  guide.openGuideGrid();
});
const closeGuide = () => page.evaluate(async () => {
  const guide = await import('app://bundle/renderer/js/guide/guide.js');
  guide.closeGuideGrid();
});

await step('desktop docked keeps the picture full-size, as it always has', async () => {
  await setMode('desktop');
  await openGuide();
  await wait(900);
  const g = await geometry();
  record('the guide is docked and open', g.docked && g.guideOpen, JSON.stringify({ docked: g.docked, open: g.guideOpen }));
  record('desktop publishes no picture-area override', g.pictureVar === '', `"${g.pictureVar}"`);
  record('and the picture still uses the whole container',
    Math.abs(g.pictureBottom - g.containerH) <= 2,
    `picture bottom ${Math.round(g.pictureBottom)}, container ${g.containerH}`);
  await closeGuide();
  await wait(400);
});

await step('TV docked shrinks the picture into the space above the strip', async () => {
  await setMode('tv');
  await openGuide();
  await wait(1200);
  const g = await geometry();
  record('a picture area is published', /px$/.test(g.pictureVar), `"${g.pictureVar}"`);
  record('the picture ends at or above the strip',
    g.pictureBottom <= g.availableH + 2,
    `picture bottom ${Math.round(g.pictureBottom)}, space above the strip ${Math.round(g.availableH)}`);
  record('and it actually shrank rather than being clipped',
    g.pictureH < g.containerH - 20, `${Math.round(g.pictureH)} of ${g.containerH}`);
  record('nothing is left overlapping the strip', g.pictureTop >= -2, `picture top ${Math.round(g.pictureTop)}`);

  // Aspect ratio: the drawn picture must still match the source's shape. One
  // element's own rect is internally consistent whatever transform it sits in.
  const sourceRatio = g.video.w / g.video.h;
  const drawnRatio = g.drawn.w / g.drawn.h;
  record('the aspect ratio is preserved',
    Math.abs(sourceRatio - drawnRatio) / sourceRatio < 0.02,
    `source ${sourceRatio.toFixed(3)}, drawn ${drawnRatio.toFixed(3)} (object-fit letterboxes inside the box)`);
});

await step('undocking and closing give the whole screen back', async () => {
  await page.evaluate(async () => {
    const guide = await import('app://bundle/renderer/js/guide/guide.js');
    guide.toggleGuideDockMode(); // to full page
  });
  await wait(700);
  const full = await geometry();
  record('full-page mode releases the picture area', full.pictureVar === '', `"${full.pictureVar}"`);

  await page.evaluate(async () => {
    const guide = await import('app://bundle/renderer/js/guide/guide.js');
    guide.toggleGuideDockMode(); // back to docked
  });
  await wait(700);
  const backDocked = await geometry();
  record('docking again re-applies it', /px$/.test(backDocked.pictureVar), `"${backDocked.pictureVar}"`);

  await closeGuide();
  await wait(700);
  const closed = await geometry();
  record('closing the guide releases it', closed.pictureVar === '', `"${closed.pictureVar}"`);
  record('and the picture is full-size again',
    Math.abs(closed.pictureBottom - closed.containerH) <= 2,
    `picture bottom ${Math.round(closed.pictureBottom)}, container ${closed.containerH}`);
});

await step('the picture follows the strip across every theme', async () => {
  // Same source the theme sweep uses: the setup screen's own theme picker,
  // which is populated from the installed packs.
  const themes = await page.locator('#theme-select option').evaluateAll((options) => (
    [...new Set(options.map((option) => option.value).filter(Boolean))]
  )).catch(() => []);
  const list = themes.length ? themes : ['digital-2000s'];

  await setMode('tv');
  await openGuide();
  await wait(900);

  const bad = [];
  for (const theme of list) {
    await page.evaluate(async (id) => {
      const { applyTheme } = await import('app://bundle/renderer/js/display/themes.js');
      // Both, per the sweep: applyTheme reads S.config.theme, and the dataset
      // attribute is what the CSS actually keys on.
      window.S.config.theme = id;
      document.documentElement.dataset.theme = id;
      applyTheme({});
      const guide = await import('app://bundle/renderer/js/guide/guide.js');
      guide.renderGuideGrid();
    }, theme);
    await wait(260);
    const g = await geometry();
    // A theme changes the strip's chrome height, so the picture must track it
    // rather than sitting at a height computed for a different theme.
    if (g.pictureBottom > g.availableH + 2 || g.pictureH >= g.containerH - 5 || !/px$/.test(g.pictureVar)) {
      bad.push({ theme, bottom: Math.round(g.pictureBottom), available: Math.round(g.availableH), h: Math.round(g.pictureH) });
    }
  }
  record(`the picture clears the strip in all ${list.length} themes`, bad.length === 0,
    bad.length ? JSON.stringify(bad.slice(0, 4)) : `${list.length} themes checked`);
});

// Not a real window resize: page.setViewportSize() does not resize an Electron
// window over CDP (the same family of gap as the missing Browser.* methods).
// What this does exercise is the invariant that matters — when the strip's
// height changes for any reason, the picture is re-fitted to the new space
// rather than left at the height it was computed for.
await step('the picture is re-fitted when the strip changes height', async () => {
  const before = await geometry();
  await page.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await wait(1200);
  const after = await geometry();
  record('the strip really did change height', after.availableH !== before.availableH,
    `space above the strip ${Math.round(before.availableH)} -> ${Math.round(after.availableH)}`);
  record('and the picture still clears it',
    after.pictureBottom <= after.availableH + 2,
    `picture bottom ${Math.round(after.pictureBottom)}, space above the strip ${Math.round(after.availableH)}`);
});

await setMode('auto');
await closeGuide();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length) console.log(`renderer runtime errors: ${errors.length}\n${errors.slice(0, 10).join('\n')}`);
else console.log('renderer runtime errors: 0');
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
