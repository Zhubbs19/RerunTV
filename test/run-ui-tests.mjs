// UI test suite for RerunTV — drives the REAL running app over Chrome
// DevTools Protocol (no mocks of the app itself, only of native OS file
// dialogs — see stubFilePickers below). Screenshots every top-level tab,
// subtab, and per-channel edit tab, then runs targeted functional checks for
// this session's newly-added features (logo bug opacity/motion/video logos,
// dynamic overlays, the CRT-overlay guide-coverage fix, auto-update theming).
//
// Expected to be launched by run-ui-tests.ps1, which starts Electron with a
// throwaway userData dir and a --remote-debugging-port, and tears it down
// afterward. Running this script directly assumes something already did
// that and passed the port as argv[2] (default 9222).
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectToApp, sleep } from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 9222);
const SHOT_DIR = path.join(__dirname, 'screenshots');
const FIXTURE_LOGO = path.join(__dirname, 'fixtures', 'test-logo.png');
const FIXTURE_OVERLAY = path.join(__dirname, 'fixtures', 'test-overlay.png');

const results = [];
let shotIndex = 0;
let activeSession = null;

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function shot(session, name) {
  shotIndex += 1;
  const file = path.join(SHOT_DIR, `${String(shotIndex).padStart(3, '0')}-${name}.png`);
  await session.screenshot(file);
  return file;
}

// The setup page scrolls inside #setup-content (the setup shell, docs/design/03;
// #setup-screen on older builds), an internal overflow-y:auto pane sized to fit the window
// (not normal document flow), so a viewport screenshot alone silently drops
// anything below the fold on a tall panel. Shoots once at the current
// scroll position, then again after scrolling that pane all the way down if
// it actually has more content than fits - restoring scroll to the top
// afterward so the next step starts from a known position.
async function scrollAndShot(session, name) {
  await shot(session, name);
  const scrolled = await evalJs(session, `
    const el = document.getElementById('setup-content') || document.getElementById('setup-screen');
    if (!el || el.scrollHeight <= el.clientHeight + 4) return false;
    el.scrollTop = el.scrollHeight;
    return true;
  `);
  if (scrolled) {
    await sleep(150);
    await shot(session, `${name}-scrolled`);
    await evalJs(session, `
      const el = document.getElementById('setup-content') || document.getElementById('setup-screen');
      if (el) el.scrollTop = 0;
      return true;
    `);
  }
}

// Every expression is wrapped in an async IIFE so it always evaluates to a
// genuine Promise — CDP's Runtime.evaluate is happier awaiting consistently
// than branching on whether a given expression happens to return one.
async function evalJs(session, body) {
  return session.evaluate(`(async () => { ${body} })()`, { awaitPromise: true });
}

async function clickSelector(session, selector) {
  const ok = await evalJs(session, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  `);
  if (!ok) throw new Error(`clickSelector: no element matched ${selector}`);
}

// Sets a checkbox to an exact state (not a click-to-toggle, which is
// ambiguous when the checkbox's starting state depends on earlier steps).
async function setCheckbox(session, selector, checked, index = 0) {
  const ok = await evalJs(session, `
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return false;
    el.checked = ${checked ? 'true' : 'false'};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  if (!ok) throw new Error(`setCheckbox: no element matched ${selector} at index ${index}`);
}

async function setSelectValue(session, selector, value) {
  const ok = await evalJs(session, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  if (!ok) throw new Error(`setSelectValue: no element matched ${selector}`);
}

async function elementExists(session, selector) {
  return evalJs(session, `return !!document.querySelector(${JSON.stringify(selector)});`);
}

async function countMatches(session, selector) {
  return evalJs(session, `return document.querySelectorAll(${JSON.stringify(selector)}).length;`);
}

// Native OS file/image/video pickers (window.api.select*) can't be driven
// over CDP — they're real OS dialogs, not page content. Stubbing them at the
// window.api boundary is the only way to exercise "pick a file" UI flows
// unattended; everything past that boundary (config storage, thumbnail
// rendering, actual playback wiring) is still the real app code, untouched.
async function stubFilePickers(session) {
  await evalJs(session, `
    window.api.selectImage = async () => ${JSON.stringify(FIXTURE_LOGO)};
    window.api.selectVideo = async () => ${JSON.stringify(FIXTURE_LOGO)};
    return true;
  `);
}

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  // The window itself is launched maximized by run-ui-tests.ps1 pre-seeding
  // window-state.json in the throwaway userData dir (Electron's CDP here
  // has no Browser.setWindowBounds to do it after the fact) — screenshots
  // below capture the full scrollable page height regardless, but a
  // maximized window means less of the app needs virtual scrolling to be
  // captured at all, and a resolution more representative of real usage.
  const session = await connectToApp(PORT);
  activeSession = session;
  console.log('Connected to app over CDP.');

  await stubFilePickers(session);

  // ---------- Dismiss first-run onboarding ----------
  // A genuinely fresh userData (see run-ui-tests.ps1's throwaway-profile
  // safety wrapper) always boots into the two-step "FIRST-TIME SETUP"
  // overlay (onboarding.js) before anything else — it's a real role="dialog"
  // that sits on top of the whole app until dismissed, so every later step
  // in this suite depends on clearing it first.
  const hasOnboarding = await elementExists(session, '.onboarding-screen');
  if (hasOnboarding) {
    await clickSelector(session, '.onboarding-screen .btn-primary'); // step 1 -> 2 (CONTINUE)
    await sleep(150);
    await clickSelector(session, '.onboarding-screen .btn-primary'); // step 2 -> done (SAVE & OPEN CHANNEL SETUP)
    await sleep(200);
  }
  record('onboarding dismissed', !(await elementExists(session, '.onboarding-screen')));

  // ---------- Dismiss the post-update "WHAT'S NEW" changelog ----------
  // Only appears when the config carries an update history (update-notice.js)
  // — i.e. whenever this run starts from a real installed userData rather than
  // an empty one. It is a role="dialog" covering the whole app, so it blanks
  // out every screenshot taken while it is up and dims #screen-crt-overlay to
  // .32 (tokens.css), which silently breaks the CRT-overlay check much later.
  // update-notice.js opens it off an unawaited getPostUpdateNotice() promise,
  // so a plain "is it there yet" check right after boot loses the race and it
  // pops up mid-sweep instead. Await the same IPC first, so by the time we
  // look, the handler that opens it has already been queued.
  await evalJs(session, `
    if (window.api && window.api.getPostUpdateNotice) {
      try { await window.api.getPostUpdateNotice(); } catch (e) { /* no notice */ }
    }
    return true;
  `);
  await sleep(300);
  if (await elementExists(session, '#update-changelog:not(.hidden)')) {
    await clickSelector(session, '#update-changelog-done');
    await sleep(250);
  }
  record('post-update changelog dismissed', !(await elementExists(session, '#update-changelog:not(.hidden)')));

  // ---------- Seed a synthetic test channel ----------
  // No real media files are needed for anything this suite checks (logo
  // rendering, motion, dynamic-overlay triggering, opacity) — updateLogoBug
  // runs before playback even looks at ch.files (see playback.js), so a
  // channel with an icon but no folders is enough to exercise all of it.
  const seeded = await evalJs(session, `
    const channels = await import('./js/channels.js');
    const ch = channels.freshChannel();
    ch.number = 1;
    ch.name = 'UI TEST CHANNEL';
    ch.icon = ${JSON.stringify(FIXTURE_LOGO)};
    window.S.config.channels = [ch];
    await window.api.saveConfig(window.S.config);
    return true;
  `);
  record('seed synthetic test channel', seeded === true);

  // ---------- Open setup screen ----------
  await evalJs(session, `const app = await import('./js/app.js'); app.showSetupScreen(); return true;`);
  await sleep(400);
  record('setup screen opens', await elementExists(session, '#setup-screen:not(.hidden)'));
  await scrollAndShot(session, 'setup-channels');

  // ---------- Full tab/subtab screenshot sweep ----------
  const TABS = [
    { id: 'channels', subtabs: [] },
    { id: 'display', subtabs: ['picture', 'interface'] },
    { id: 'programming', subtabs: ['presets', 'flows', 'pool', 'onscreen', 'autocurate', 'tagtaxonomy', 'aircheck'] },
    { id: 'audio', subtabs: ['system', 'network', 'backups', 'librarysync'] },
    // STATUS is a single page now - its three former sub-tabs each held one
    // panel on an otherwise empty screen.
    { id: 'perf', subtabs: [] },
    { id: 'plugins', subtabs: ['installed', 'appearance', 'diagnostics'] },
    { id: 'help', subtabs: ['guide', 'shortcuts', 'updates', 'releases'] },
  ];
  for (const tab of TABS) {
    await clickSelector(session, `.setup-tab-btn[data-tab="${tab.id}"]`);
    await sleep(300);
    const tabOk = await elementExists(session, `.setup-tab-panel[data-tab-panel="${tab.id}"]:not(.hidden)`);
    record(`tab opens: ${tab.id}`, tabOk);
    await scrollAndShot(session, `tab-${tab.id}`);
    for (const sub of tab.subtabs) {
      const subSelector = `.setup-tab-panel[data-tab-panel="${tab.id}"] .setup-subtab-btn[data-subtab="${sub}"]`;
      if (!(await elementExists(session, subSelector))) continue;
      await clickSelector(session, subSelector);
      await sleep(250);
      await scrollAndShot(session, `tab-${tab.id}-sub-${sub}`);
    }
  }

  // ---------- DISPLAY > INTERFACE: logo motion + dynamic overlays UI ----------
  await clickSelector(session, '.setup-tab-btn[data-tab="display"]');
  await clickSelector(session, '.setup-tab-panel[data-tab-panel="display"] .setup-subtab-btn[data-subtab="interface"]');
  await sleep(300);

  const motionOptionCount = await countMatches(session, '#logo-bug-motion-select option');
  record('logo motion select has 4 presets', motionOptionCount === 4, `found ${motionOptionCount}`);

  await setSelectValue(session, '#logo-bug-motion-select', 'pulse');
  const motionSaved = await evalJs(session, `return window.S.config.display.logoBugMotion === 'pulse';`);
  record('logo motion select updates config', motionSaved === true);

  record('dynamic overlays editor renders', await elementExists(session, '#dynamic-overlays-editor .dynamic-overlays-editor'));
  const rowsBefore = await countMatches(session, '.dynamic-overlay-rule-row');
  await clickSelector(session, '#dynamic-overlays-editor .dynamic-overlays-editor > button');
  await sleep(150);
  const rowsAfter = await countMatches(session, '.dynamic-overlay-rule-row');
  record('ADD OVERLAY RULE adds a row', rowsAfter === rowsBefore + 1, `${rowsBefore} -> ${rowsAfter}`);
  await scrollAndShot(session, 'display-interface-dynamic-overlays');

  // Assign real fixture media directly (bypassing the stubbed picker button
  // entirely, to also prove the config-shape path independently) and
  // re-render to confirm the thumbnail actually resolves.
  const ruleWithMedia = await evalJs(session, `
    const channels = await import('./js/channels.js');
    window.S.config.display.dynamicOverlays = [{
      id: channels.newDynamicOverlayId(), trigger: 'tuneIn',
      mediaPath: ${JSON.stringify(FIXTURE_OVERLAY)},
      corner: 'bottom-right', size: 160, durationMs: 0,
    }];
    await window.api.saveConfig(window.S.config);
    return true;
  `);
  record('dynamic overlay rule with real media saves', ruleWithMedia === true);
  // Force a re-render so the panel picks up the config change above -
  // switching sub-tabs only toggles visibility (setup-settings.js), it does
  // NOT re-run renderSettingsPanels(); only entering the DISPLAY tab (or the
  // settings screen as a whole) does that normally.
  await evalJs(session, `const s = await import('./js/setup-settings.js'); s.renderSettingsPanels(); return true;`);
  await sleep(300);
  await scrollAndShot(session, 'display-interface-dynamic-overlays-with-media');

  // ---------- CHANNELS > per-channel OPTIONS row ----------
  // The row is collapsed unless the channel already has non-default options,
  // so a fresh test channel never shows it without an explicit expand.
  await clickSelector(session, '.setup-tab-btn[data-tab="channels"]');
  await sleep(300);
  // List + detail (docs/design/03): pick channel 1 in the lineup list; its
  // card and editor appear in the detail pane.
  await clickSelector(session, '.channel-list-item[data-channel-number="1"]');
  await sleep(300);
  await clickSelector(session, '.channel-row[data-channel-number="1"] .channel-options-header');
  await sleep(250);
  const optionGroupCount = await countMatches(session, '.channel-row[data-channel-number="1"] .channel-option-group');
  record('channel OPTIONS row is split into 4 named groups', optionGroupCount === 4, `found ${optionGroupCount}`);
  // Every label must sit in the same non-wrapping group as the control it
  // names — a bare .option-label directly in the wrap-flow is exactly the
  // orphaning this grouping exists to prevent.
  const orphanLabels = await evalJs(session, `
    const row = document.querySelector('.channel-row[data-channel-number="1"]');
    return Array.from(row.querySelectorAll('.option-label'))
      .filter((el) => !el.closest('.channel-option-field'))
      .map((el) => el.textContent.trim());
  `);
  record('no OPTIONS label is orphaned from its control', orphanLabels.length === 0, orphanLabels.join(', '));
  await scrollAndShot(session, 'channel-1-options-expanded');

  // ---------- CHANNELS > edit > LOGO / OVERLAYS tabs ----------
  record('channel edit panel opens', await elementExists(session, '#channel-1-edit-panel'));
  await scrollAndShot(session, 'channel-1-edit-default');

  // #channel-1-edit-panel is the edit panel's inner CONTENT div, and the
  // CONTENT/LOOK/PLAYBACK group bar is its SIBLING (setup-channels.js) - so
  // the obvious '#channel-1-edit-panel .edit-tab-group-btn' never matched
  // anything. Reach the bar through the wrapper that holds both.
  await clickSelector(session, '.edit-panel:has(> #channel-1-edit-panel) .edit-tab-group-btn[data-edit-group=look]');
  await sleep(120);
  await clickSelector(session, '#channel-1-edit-tab-logo');
  await sleep(200);
  // Default state (fresh channel): logoBugProfiles is null, meaning "inherit
  // the box-wide default" — buildLogoBugPanel shows an explanatory hint
  // instead of the editor in that state, same convention as OVERLAYS below.
  record('per-channel LOGO tab shows inherit hint by default', await elementExists(session, '#channel-1-edit-panel .titles-empty'));
  await scrollAndShot(session, 'channel-1-edit-logo-inherit');
  await setCheckbox(session, '#channel-1-edit-panel .shuffle-toggle input[type="checkbox"]', true); // OVERRIDE LOGO BUG FOR THIS CHANNEL
  await sleep(200);
  record('per-channel LOGO override reveals live-editor button', await elementExists(session, '#channel-1-edit-panel .logobug-live-open'));
  await scrollAndShot(session, 'channel-1-edit-logo-override');

  await clickSelector(session, '#channel-1-edit-tab-overlays');
  await sleep(200);
  record('per-channel OVERLAYS tab shows inherit hint by default', await elementExists(session, '#channel-1-edit-panel .titles-empty'));
  await setCheckbox(session, '#channel-1-edit-panel .shuffle-toggle input[type="checkbox"]', true); // OVERRIDE DYNAMIC OVERLAYS FOR THIS CHANNEL
  await sleep(200);
  record('per-channel OVERLAYS override reveals the rule editor', await elementExists(session, '#channel-1-edit-panel .dynamic-overlays-editor'));
  await scrollAndShot(session, 'channel-1-edit-overlays-override');
  // Uncheck it again so the rest of the suite (which reads/writes
  // S.config.display.dynamicOverlays as the box-wide default) isn't shadowed
  // by a per-channel override on this same test channel.
  await setCheckbox(session, '#channel-1-edit-panel .shuffle-toggle input[type="checkbox"]', false);
  await sleep(150);

  // ---------- Per-channel ticker placement/content override ----------
  await clickSelector(session, '#channel-1-edit-tab-ticker');
  await sleep(200);
  record('per-channel TICKER tab shows inherit hints by default', await elementExists(session, '#channel-1-edit-panel .titles-empty'));
  await scrollAndShot(session, 'channel-1-edit-ticker-inherit');
  const tickerCheckboxes = '#channel-1-edit-panel .shuffle-toggle input[type="checkbox"]';
  await setCheckbox(session, tickerCheckboxes, true, 0); // OVERRIDE TICKER PLACEMENT FOR THIS CHANNEL
  await sleep(200);
  record('per-channel TICKER placement override reveals live-editor button', await elementExists(session, '#channel-1-edit-panel .logobug-live-open'));
  await setCheckbox(session, tickerCheckboxes, true, 1); // OVERRIDE TICKER TEXT/SPEED FOR THIS CHANNEL
  await sleep(200);
  record('per-channel TICKER content override reveals text/speed fields', await elementExists(session, '#channel-1-edit-panel textarea.pubaccess-slide-input'));
  await scrollAndShot(session, 'channel-1-edit-ticker-override');
  await clickSelector(session, '#channel-1-edit-panel .logobug-live-open');
  await sleep(600);
  record('ticker live editor opens targeted at ticker-bar', await elementExists(session, '.logobug-live-toolbar'));
  await shot(session, 'ticker-live-editor');
  await clickSelector(session, '.logobug-live-actions .btn:not(.btn-primary)'); // CANCEL
  await sleep(400);
  // Reset both overrides so the rest of the suite isn't shadowed by a
  // per-channel ticker override on this same test channel.
  await setCheckbox(session, tickerCheckboxes, false, 1);
  await sleep(150);
  await setCheckbox(session, tickerCheckboxes, false, 0);
  await sleep(150);

  // ---------- Live logo placement editor (opacity slider) ----------
  // LOGO's own override checkbox is still checked from the step above (it
  // wasn't turned back off, unlike OVERLAYS), so this tab already shows the
  // live-editor button without needing to touch the checkbox again.
  await clickSelector(session, '#channel-1-edit-tab-logo');
  await sleep(200);
  await clickSelector(session, '#channel-1-edit-panel .logobug-live-open');
  await sleep(600);
  record('live overlay editor opens', await elementExists(session, '.logobug-live-toolbar'));
  record('live overlay editor has an opacity slider', await elementExists(session, '.logobug-live-opacity input[type="range"]'));
  await shot(session, 'logobug-live-editor');
  record('image logo renders as <img>, not <video>', await elementExists(session, '#logo-bug img'));
  await clickSelector(session, '.logobug-live-actions .btn:not(.btn-primary)'); // CANCEL
  await sleep(400);

  // ---------- Animated (video) logo bug — code-path check ----------
  // No real playable video fixture exists in this sandbox (no ffmpeg to
  // encode one), so this checks the branch logic directly: isVideoMediaPath
  // routes updateLogoBug to build a <video> element for a video-looking
  // path, even though this particular file won't actually decode.
  const videoBranch = await evalJs(session, `
    window.S.config.channels[0].icon = 'C:\\\\fake\\\\logo.mp4';
    const playback = await import('./js/playback-broadcast-fx.js');
    playback.updateLogoBug(window.S.config.channels[0]);
    return !!document.querySelector('#logo-bug video');
  `);
  record('video-extension logo renders as <video>', videoBranch === true);
  // Restore the real (image) fixture logo for the rest of the suite.
  await evalJs(session, `
    window.S.config.channels[0].icon = ${JSON.stringify(FIXTURE_LOGO)};
    const playback = await import('./js/playback-broadcast-fx.js');
    playback.updateLogoBug(window.S.config.channels[0]);
    return true;
  `);

  // ---------- Dynamic overlay trigger — runtime rendering check ----------
  const overlayShown = await evalJs(session, `
    const mod = await import('./js/dynamic-overlays.js');
    mod.triggerDynamicOverlays(window.S.config.channels[0], 'tuneIn');
    await new Promise((r) => setTimeout(r, 150));
    const el = document.getElementById('dynamic-overlay');
    return el.classList.contains('show') && !el.classList.contains('hidden') && !!el.querySelector('img,video');
  `);
  record('triggerDynamicOverlays shows the overlay element', overlayShown === true);
  await evalJs(session, `const app = await import('./js/app.js'); app.showTvScreen(); return true;`);
  await sleep(300);
  await shot(session, 'tv-screen-dynamic-overlay');
  await evalJs(session, `const m = await import('./js/dynamic-overlays.js'); m.hideDynamicOverlay(); return true;`);

  // ---------- CRT whole-screen overlay: guide must NOT get dimmed ----------
  await evalJs(session, `const app = await import('./js/app.js'); app.showTvScreen(); return true;`);
  await sleep(300);
  await evalJs(session, `
    window.S.config.crtIntensity = window.S.config.crtIntensity || {};
    window.S.config.crtIntensity.overlayScope = 'wholeScreen';
    window.S.config.crtEnabled = true;
    const power = await import('./js/power.js');
    power.applyCrtState();
    return true;
  `);
  const opacityBeforeGuide = await evalJs(session, `return getComputedStyle(document.getElementById('screen-crt-overlay')).opacity;`);
  // tokens.css dims this overlay to .32 whenever setup or any non-guide
  // [role=dialog] is open, so anything left open by an earlier step makes the
  // assertion below fail for a reason that has nothing to do with the guide.
  // Name the culprits rather than just reporting a number.
  const dimmers = await evalJs(session, `
    const open = [];
    if (!document.getElementById('setup-screen').classList.contains('hidden')) open.push('#setup-screen');
    document.querySelectorAll('[role="dialog"]:not(#guide-grid):not(.hidden)').forEach((el) => {
      open.push('#' + (el.id || '(no id)') + '.' + (el.className || '').split(' ').join('.'));
    });
    return open.join(', ') || 'none';
  `);
  let guideOpen = false;
  try {
    await evalJs(session, `const g = await import('./js/guide.js'); g.openGuideGrid(); return true;`);
    await sleep(300);
    guideOpen = await elementExists(session, '#guide-grid:not(.hidden)');
  } catch (e) {
    record('open guide grid for CRT-overlay check', false, e.message);
  }
  if (guideOpen) {
    const opacityWithGuide = await evalJs(session, `return getComputedStyle(document.getElementById('screen-crt-overlay')).opacity;`);
    record(
      'whole-screen CRT overlay stays at full opacity while guide is open',
      Number(opacityBeforeGuide) === 1 && Number(opacityWithGuide) === 1,
      `before=${opacityBeforeGuide} with-guide=${opacityWithGuide} dimmers=[${dimmers}]`,
    );
    await shot(session, 'tv-screen-guide-wholescreen-crt');
  } else {
    record('whole-screen CRT overlay stays at full opacity while guide is open', false, 'guide grid did not open');
  }

  // ---------- Auto-update popup theming: verify reported CSS vars ----------
  await evalJs(session, `
    window.S.config.theme = 'analog-90s';
    const t = await import('./js/themes.js');
    t.applyTheme();
    return true;
  `);
  await sleep(200);
  const goldVar = await evalJs(session, `return getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();`);
  record('theme switch resolves --gold for analog-90s', goldVar.toLowerCase() === '#ffb000', `got ${goldVar}`);

  session.close();
  activeSession = null;

  // ---------- Summary ----------
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failures:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
  }
  await fs.writeFile(
    path.join(SHOT_DIR, '..', 'results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
  );
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('Test suite crashed:', err);
  if (activeSession) activeSession.close();
  process.exitCode = 2;
});
