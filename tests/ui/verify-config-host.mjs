// Scratch: host-owned config edits (main/config-host.js) in the real app.
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if ((m.type() === 'error' || m.type() === 'warning') && !/\[config-host\]/.test(m.text())) errors.push(`[${m.type()}] ${m.text()}`);
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
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

const FAKE = 'verify-config-host-fake-plugin';

await step('approval reaches the renderer copy by broadcast, alongside a pending edit', async () => {
  const r = await page.evaluate(async (fake) => {
    const st = await import('app://bundle/renderer/js/core/state.js');
    const revBefore = st.getHostRevision();
    const hostRevBefore = await window.api.getConfigRevision();
    const themeBefore = window.S.config.theme;
    window.S.config.display.clock24 = !window.S.config.display.clock24; // pending unconverted edit
    st.saveConfigDebounced(1500);
    // Call the IPC directly and ignore its reply: only the broadcast can update S.config now.
    await window.api.pluginsApproveCapabilities(fake, 'sig-live');
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const inRenderer = (window.S.config.plugins.approvedCapabilities || {})[fake];
    const revAfter = st.getHostRevision();
    const hostRevAfter = await window.api.getConfigRevision();
    await new Promise((resolve) => { setTimeout(resolve, 1700); }); // let the pending save land
    const onDisk = await window.api.loadConfig();
    return {
      revBefore, hostRevBefore, revAfter, hostRevAfter, inRenderer,
      diskApproval: (onDisk.plugins.approvedCapabilities || {})[fake],
      diskClock: onDisk.display.clock24, rendererClock: window.S.config.display.clock24,
      canUndo: st.canUndo(), undoLabel: st.undoLabel(), themeSame: onDisk.theme === themeBefore,
    };
  }, FAKE);
  record('renderer copy got the approval without any manual mirroring', r.inRenderer === 'sig-live', JSON.stringify(r));
  record('renderer and host agree on the revision', r.revAfter === r.hostRevAfter && r.revAfter === r.revBefore + 1, `renderer ${r.revAfter} host ${r.hostRevAfter}`);
  record('disk has both the host edit and the pending renderer edit', r.diskApproval === 'sig-live' && r.diskClock === r.rendererClock);
  record('the host edit is not an undo step of the setup screen', r.undoLabel === 'Change display', r.undoLabel);
  await page.evaluate(async () => { const st = await import('app://bundle/renderer/js/core/state.js'); st.performUndo(); });
});

await step('a deliberately stale whole-config save does not revert the host edit', async () => {
  const r = await page.evaluate(async (fake) => {
    const st = await import('app://bundle/renderer/js/core/state.js');
    const build = () => {
      const stale = JSON.parse(JSON.stringify(window.S.config));
      delete stale.plugins.approvedCapabilities[fake];
      return stale;
    };
    // This renderer's own stale save: host commands it hadn't seen are replayed
    // onto it, so its own pending edit and the host's both survive.
    const mine = await window.api.saveConfig(build(), 0, st.getClientId());
    const afterMine = await window.api.loadConfig();
    // The same save arriving from a DIFFERENT client is refused instead of
    // repaired, because replaying is only sound for the host's own set-only
    // commands — another client's may have spliced an array (docs/design/05 §2.3).
    const foreign = await window.api.saveConfig(build(), 0, 'verify-foreign-device');
    const afterForeign = await window.api.loadConfig();
    return {
      mine, foreign,
      diskApproval: (afterMine.plugins.approvedCapabilities || {})[fake],
      stillThere: (afterForeign.plugins.approvedCapabilities || {})[fake],
    };
  }, FAKE);
  record('this client\'s own stale save is repaired by replay on the host',
    r.diskApproval === 'sig-live' && r.mine && r.mine.ok === true && r.mine.replayed >= 1, JSON.stringify(r.mine));
  record('a stale save from another client is refused rather than applied',
    r.foreign && r.foreign.ok === false && r.foreign.reason === 'conflict' && r.stillThere === 'sig-live', JSON.stringify(r.foreign));
});

await step('revoke and enable/disable round-trip through host commands', async () => {
  const r = await page.evaluate(async (fake) => {
    const st = await import('app://bundle/renderer/js/core/state.js');
    const revoke = await window.api.pluginsRevokeCapabilities(fake);
    st.applyHostUpdate(revoke.hostUpdate);
    const off = await window.api.pluginsSetEnabled(fake, false);
    st.applyHostUpdate(off.hostUpdate);
    const disabledNow = window.S.config.plugins.disabled.filter((id) => id === fake).length;
    const on = await window.api.pluginsSetEnabled(fake, true);
    st.applyHostUpdate(on.hostUpdate);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    const onDisk = await window.api.loadConfig();
    return {
      revokedInRenderer: !(fake in (window.S.config.plugins.approvedCapabilities || {})),
      revokedOnDisk: !(fake in (onDisk.plugins.approvedCapabilities || {})),
      disabledNow,
      enabledAgainRenderer: !window.S.config.plugins.disabled.includes(fake),
      enabledAgainDisk: !onDisk.plugins.disabled.includes(fake),
      revisions: [revoke.hostUpdate.revision, off.hostUpdate.revision, on.hostUpdate.revision],
      renderer: st.getHostRevision(),
    };
  }, FAKE);
  record('revoke, disable and re-enable all land on disk and in the renderer', r.revokedInRenderer && r.revokedOnDisk && r.disabledNow === 1 && r.enabledAgainRenderer && r.enabledAgainDisk, JSON.stringify(r));
});

await step('TV-screen CRT toggle still saves', async () => {
  const before = await page.evaluate(() => window.S.config.crtEnabled !== false);
  await page.evaluate(async () => { const { showTvScreen } = await import('app://bundle/renderer/js/app.js'); await showTvScreen(); });
  await wait(800);
  await page.keyboard.press('c');
  await wait(400);
  const after = await page.evaluate(async () => {
    const onDisk = await window.api.loadConfig();
    return { mem: window.S.config.crtEnabled !== false, disk: onDisk.crtEnabled !== false };
  });
  record('C key flips CRT in memory and on disk', after.mem === !before && after.disk === !before, JSON.stringify({ before, ...after }));
  await page.keyboard.press('c');
  await wait(300);
});

record('no renderer errors or warnings', errors.length === 0, errors.slice(0, 6).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
