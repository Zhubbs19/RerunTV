#!/usr/bin/env node
// Launches a built or installed RerunTV and checks that it boots. CI runs this against the app the
// silent installer just installed (.github/workflows/installer-smoke.yml), so a broken package,
// missing bundled file or startup crash fails the build instead of reaching a release.
//
//   node scripts/smoke-test-installer.js <path\to\RerunTV.exe> <expected-version>
//
// It starts the app with a remote-debugging port, connects over the Chrome DevTools Protocol and
// asserts: the window loads, the app reports the expected version, the renderer finished booting,
// every bundled plugin loaded without an error, and no uncaught page errors were thrown. Then it
// stops the app. The app keeps its data in a "userData" folder next to the exe, so run it against a
// fresh install (not your own copy of RerunTV).

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const exe = process.argv[2];
const expectedVersion = process.argv[3];
const PORT = 9333;
const BOOT_TIMEOUT_MS = 90000;
const MIN_BUNDLED_PLUGINS = 40;

if (!exe || !expectedVersion) {
  console.error('usage: node scripts/smoke-test-installer.js <path\\to\\RerunTV.exe> <expected-version>');
  process.exit(2);
}
if (!fs.existsSync(exe)) {
  console.error(`not found: ${exe}`);
  process.exit(2);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(name);
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForDevTools() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { return await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error(`the app did not open its debugging port within ${BOOT_TIMEOUT_MS / 1000}s`);
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

(async () => {
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, '--allow-multiple-instances'], { stdio: 'ignore', windowsHide: false });
  let exitedEarly = null;
  child.on('exit', (code) => { exitedEarly = code; });
  let browser = null;
  try {
    await waitForDevTools();
    check('the app started and opened its debugging port', true);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    let page = null;
    const pageDeadline = Date.now() + 30000;
    while (!page && Date.now() < pageDeadline) {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html/.test(p.url()));
      if (!page) await new Promise((r) => setTimeout(r, 300));
    }
    check('the main window loaded', !!page, page ? page.url() : 'no window with index.html');
    if (!page) throw new Error('no window');

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.waitForFunction(() => window.S && window.S.config, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000); // give start-up code time to throw if it is going to

    const info = await page.evaluate(async () => {
      const plugins = window.api && window.api.pluginsList ? await window.api.pluginsList().catch(() => null) : null;
      return {
        title: document.title,
        version: window.api && window.api.getAppVersion ? await window.api.getAppVersion().catch(() => null) : null,
        booted: !!(window.S && window.S.config),
        onboarding: !!document.querySelector('.onboarding-screen'),
        plugins: plugins ? plugins.map((p) => ({ id: p.id, error: p.error || null })) : null,
      };
    });

    check('the window title is RerunTV', info.title === 'RerunTV', info.title);
    check(`the app reports version ${expectedVersion}`, info.version === expectedVersion, String(info.version));
    check('the renderer finished booting', info.booted);
    check('the first-run setup shows on a fresh install', info.onboarding);
    check(`at least ${MIN_BUNDLED_PLUGINS} bundled plugins were found`, !!info.plugins && info.plugins.length >= MIN_BUNDLED_PLUGINS, info.plugins ? `${info.plugins.length} found` : 'plugin list unavailable');
    const broken = info.plugins ? info.plugins.filter((p) => p.error) : [];
    check('no plugin failed to load', broken.length === 0, broken.map((p) => `${p.id}: ${p.error}`).join('; '));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('the app is still running', exitedEarly === null);
    check('the portable userData folder was created next to the app', fs.existsSync(path.join(path.dirname(exe), 'userData')));
  } catch (e) {
    check('smoke test ran to completion', false, e.message);
    if (exitedEarly !== null) console.log(`the app exited early with code ${exitedEarly}`);
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    stop(child);
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})();
