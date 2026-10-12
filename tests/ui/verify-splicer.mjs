// Driver: setup › LIBRARY › SPLICER end to end, against synthetic tapes made
// with ffmpeg in the OS temp folder: an 8 s "bumper", a 40 s "commercial" and
// a 130 s "episode" with a second of black silence between each; the second
// tape airs the bumper and the commercial twice. Nothing in the media library
// is read or written; SEND TO RERUNTV writes to the throwaway config copy.
//
// Covers: the page, the old plugin gone, the host's file-or-folder check,
// PREVIEW CUTS into the editor (select, nudge, remove/restore, add a cut,
// name episodes), REVIEW CUTS pictures, FIND REPEATS and skipping them,
// SPLIT THESE CLIPS with names, a frame-accurate clip that starts on the
// right frame and plays across its join in Chromium, SEND TO RERUNTV (new
// channel, ad pool), the RUNS queue (a waiting run cancelled), CANCEL of a
// running re-encode with no ffmpeg left behind, saving and deleting a preset,
// and COMBINE.
//
// Run it through the wrapper, never directly:
//   powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
//     -UserDataSource "<installed-app-dir>\userData" -Script verify-splicer.mjs
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const outDir = path.join(here, 'splicer-out');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ---------- the synthetic tapes ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-splicer-ui-'));
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: work });
const part = (name, seconds, hz) => ff(['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`,
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', name]);
part('a.mp4', 8, 440);
ff(['-f', 'lavfi', '-i', 'color=black:size=320x240:rate=25:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', 'b.mp4']);
part('c.mp4', 40, 660);
part('e.mp4', 130, 880);
const concat = (name, parts) => {
  fs.writeFileSync(path.join(work, `${name}.txt`), parts.map((n) => `file '${n}.mp4'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', `${name}.txt`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', `${name}.mp4`]);
  return path.join(work, `${name}.mp4`);
};
const TAPE = concat('tape', ['a', 'b', 'c', 'b', 'e']);
const TAPE2 = concat('tape2', ['a', 'b', 'c', 'b', 'a', 'b', 'c', 'b', 'e']);
const CLIPS = path.join(work, 'clips');
console.log(`tapes: ${work}`);
const gray = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-frames:v', '1', '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', '-']);
const mad = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;

// ---------- the app ----------
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) { console.log('FAIL could not find the renderer page'); process.exit(1); }
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[error] ${m.text()}`); });

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const js = (fn, arg) => page.evaluate(fn, arg);
async function step(name, fn) { try { await fn(); } catch (e) { record(name, false, e.message.split('\n')[0]); } }
const shot = async (name) => {
  try {
    await wait(250);
    const capture = cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const { data } = await Promise.race([capture, new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 15000))]);
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  } catch (e) { console.log(`(screenshot ${name} skipped: ${e.message})`); }
};
const textOf = (sel) => js((s) => (document.querySelector(s) || {}).textContent || '', sel);
async function until(label, fn, timeoutMs = 60000, every = 300) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const value = await fn();
    if (value) return value;
    // eslint-disable-next-line no-await-in-loop
    await wait(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const scrollTo = (sel) => js((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel);
const clipsOnDisk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(mp4|mkv)$/.test(f)) : []);
const hasVideo = (file) => {
  try { execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) { return /Video:/.test(String(e.stderr)); }
  return false;
};
const ffmpegOnTapes = () => {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name = 'ffmpeg.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter((line) => line.includes(work)).length;
};
// Native pickers can't be driven over CDP, and window.api is frozen by the
// context bridge: fields are typed into, the combine list filled through
// splicer.js's own addClips.
const typeInto = (id, value) => js(([el, v]) => {
  const input = document.getElementById(el);
  input.value = v;
  input.dispatchEvent(new Event('change'));
}, [id, value]);
const setOption = (labelRe, value) => js(([re, v]) => {
  const field = [...document.querySelectorAll('#splicer-options-root .field')].find((f) => new RegExp(re, 'i').test(f.textContent));
  const input = field.querySelector('input');
  if (input.type === 'checkbox') input.checked = v; else input.value = v;
  input.dispatchEvent(new Event('change'));
}, [labelRe, value]);
const runRows = () => js(() => [...document.querySelectorAll('#splicer-runs .splicer-run-row')].map((row) => ({
  label: row.querySelector('.splicer-run-label').textContent, status: row.querySelector('.splicer-run-status').textContent, state: row.className,
})));
const lastRunDone = (label) => until(`run "${label}" to finish`, async () => {
  const rows = await runRows();
  const row = rows.filter((r) => r.label.startsWith(label)).pop();
  return row && /is-done/.test(row.state) ? row : null;
}, 120000);
const clipRows = () => js(() => [...document.querySelectorAll('.splicer-table tbody tr')].map((tr) => ({
  where: tr.querySelector('select').value, name: tr.querySelector('.splicer-clip-name').value, repeat: /REPEAT OF/.test(tr.textContent),
})));

// ---------- boot ----------
await wait(4000);
await until('config', () => js(() => !!(window.S && window.S.config && window.S.config.channels)), 30000);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

await js(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1000);
await js(() => document.querySelector('.setup-tab-btn[data-tab="library"]').click());
await wait(200);
await js(() => document.querySelector('[data-subtab="librarysplicer"]').click());
await wait(800);

await step('the SPLICER page renders with FFmpeg found', async () => {
  const state = await js(() => ({
    visible: !document.querySelector('[data-subtab-panel="librarysplicer"]').classList.contains('hidden'),
    ffmpegNoteHidden: document.getElementById('splicer-ffmpeg-note').classList.contains('hidden'),
    presets: document.querySelectorAll('#splicer-preset option').length,
    fields: document.querySelectorAll('#splicer-options-root .field').length,
    runsHidden: document.getElementById('splicer-runs-panel').hidden,
    queueEmpty: !!document.querySelector('#splicer-queue .empty-state'),
  }));
  record('the SPLICER page renders with FFmpeg found', state.visible && state.ffmpegNoteHidden && state.presets === 4 && state.fields === 16 && state.runsHidden && state.queueEmpty, JSON.stringify(state));
  await shot('01-splicer-page');
});

await step('the old Video Splicer plugin is not listed', async () => {
  const ids = await js(async () => ((await window.api.pluginsList()) || []).map((p) => p.id));
  record('the old Video Splicer plugin is not listed', !ids.includes('video-splicer'), `${ids.length} plugins`);
});

await step('a typed path is checked on the host', async () => {
  await typeInto('splicer-source', work);
  await wait(400);
  const folder = await textOf('#splicer-source-help');
  await typeInto('splicer-source', path.join(work, 'nope.mp4'));
  await wait(400);
  const missing = await textOf('#splicer-source-help');
  await typeInto('splicer-source', TAPE);
  await wait(400);
  const file = await textOf('#splicer-source-help');
  record('a typed path is checked on the host', /This folder/.test(folder) && /Nothing is there/.test(missing) && /A folder splits/.test(file), `${folder} | ${missing} | ${file}`);
});

await typeInto('splicer-out', CLIPS);
await js(() => { const el = document.getElementById('splicer-preset'); el.value = 'mixed'; el.dispatchEvent(new Event('change')); });
await setOption('hard picture changes', false);

await step('PREVIEW CUTS opens the editor with a bumper, a commercial and an episode', async () => {
  await page.click('#splicer-detect-btn');
  await until('the editor', () => js(() => document.querySelectorAll('.splicer-table tbody tr').length), 60000);
  const rows = await clipRows();
  const state = await js(() => ({ markers: document.querySelectorAll('.splicer-tl-cut').length, video: !!document.getElementById('splicer-edit-video') }));
  record('PREVIEW CUTS opens the editor with a bumper, a commercial and an episode', rows.map((r) => r.where).join() === 'bumpers,commercials,episodes' && state.markers === 2 && state.video && !fs.existsSync(CLIPS), `${JSON.stringify(state)} ${rows.map((r) => r.where)}`);
  record('the run is listed in RUNS as done', /Done/.test((await lastRunDone('Preview')).status));
  await scrollTo('#splicer-split-results');
  await shot('02-editor');
});

await step('a cut can be selected, nudged, removed and restored', async () => {
  await page.locator('.splicer-tl-cut').first().click();
  const label0 = await textOf('.splicer-cut-label');
  await page.locator('button[aria-label="Move the cut 1 second later"]').click();
  const label1 = await textOf('.splicer-cut-label');
  const lengths = await js(() => [...document.querySelectorAll('.splicer-table tbody tr')].map((tr) => tr.children[2].textContent));
  await page.click('#splicer-cut-toggle-btn');
  const afterRemove = (await clipRows()).length;
  await page.click('#splicer-cut-toggle-btn');
  const afterRestore = (await clipRows()).length;
  await page.locator('button[aria-label="Move the cut 1 second earlier"]').click();
  record('a cut can be selected, nudged, removed and restored',
    /0:08\.5/.test(label0) && /0:09\.5 \(moved\)/.test(label1) && lengths[0] === '0:09' && afterRemove === 2 && afterRestore === 3,
    `${label0} → ${label1}; lengths ${lengths}; ${afterRemove}/${afterRestore} clips`);
  await shot('03-editor-cut-selected');
});

await step('a cut added at the player’s position splits a clip', async () => {
  await js(() => { document.getElementById('splicer-edit-video').currentTime = 100; });
  await wait(400);
  await page.click('#splicer-add-cut-btn');
  const added = (await clipRows()).length;
  await page.click('#splicer-cut-toggle-btn');
  const removed = (await clipRows()).length;
  record('a cut added at the player’s position splits a clip', added === 4 && removed === 3, `${added} then ${removed}`);
});

await step('episodes can be numbered', async () => {
  await page.fill('.splicer-naming input[aria-label="Series name"]', 'Test Show');
  await page.click('#splicer-number-btn');
  const names = (await clipRows()).map((r) => r.name);
  record('episodes can be numbered', names[2] === 'Test Show - S01E01' && !names[0], JSON.stringify(names));
});

await step('REVIEW CUTS shows real pictures on either side of each gap', async () => {
  await typeInto('splicer-source', TAPE2);
  await wait(300);
  await page.click('#splicer-review-btn');
  await until('pictures', () => js(() => {
    const imgs = [...document.querySelectorAll('.splicer-thumb img')];
    return imgs.length && imgs.every((img) => img.complete && img.naturalWidth > 0) ? imgs.length : 0;
  }), 90000);
  const count = await js(() => document.querySelectorAll('.splicer-thumb').length);
  // The pictures come from the last frame before a gap and the first after,
  // so none of them sits in the black: check one on disk.
  const firstThumb = await js(() => document.querySelector('.splicer-thumb img').src);
  const thumbFile = decodeURIComponent((firstThumb.match(/[?&]p=([^&]+)/) || [])[1] || '');
  const brightness = thumbFile ? gray(['-i', thumbFile]).reduce((a, b) => a + b, 0) / 256 : null;
  record('REVIEW CUTS shows real pictures on either side of each gap', count === 4 && brightness !== null && brightness > 40, `${count} pictures; first averages ${brightness && brightness.toFixed(0)}/255`);
  await scrollTo('#splicer-split-results');
  await shot('04-review-pictures');
});

await step('FIND REPEATS marks the second bumper and commercial, and they can be left out', async () => {
  await page.click('#splicer-find-repeats-btn');
  await lastRunDone('Find repeats');
  await until('repeat chips', () => js(() => document.querySelectorAll('.splicer-table .ui-chip').length), 10000);
  const repeats = (await clipRows()).map((r) => r.repeat);
  await page.click('#splicer-skip-repeats-btn');
  const where = (await clipRows()).map((r) => r.where);
  record('FIND REPEATS marks the second bumper and commercial, and they can be left out',
    JSON.stringify(repeats) === '[false,false,true,true,false]' && JSON.stringify(where) === '["bumpers","commercials","skip","skip","episodes"]', `${repeats} / ${where}`);
  await shot('05-repeats');
});

await step('SPLIT THESE CLIPS writes exactly the edited clips, with names', async () => {
  const input = page.locator('.splicer-table tbody tr:nth-child(5) .splicer-clip-name');
  await input.fill('Tape Two Feature');
  await input.dispatchEvent('change');
  await page.click('#splicer-plan-split-btn');
  await lastRunDone('Split tape2');
  const files = clipsOnDisk(CLIPS);
  record('SPLIT THESE CLIPS writes exactly the edited clips, with names',
    files.length === 3 && files.some((f) => /episodes[\\/]Tape Two Feature\.mp4$/.test(f)) && files.every((f) => hasVideo(path.join(CLIPS, f))), files.join(', '));
  await until('the send panel', () => js(() => !!document.querySelector('.splicer-send')), 10000);
  await scrollTo('#splicer-split-results');
  await shot('06-split-done-send');
});

await step('a frame-accurate clip starts on the right frame and plays across its join', async () => {
  // A cut 21 s into the commercial is mid-way between keyframes (every 10 s
  // on these tapes), so the clip is re-encoded up to its first keyframe and
  // copied after it.
  const out = path.join(work, 'exact');
  const plan = { files: [{ sourcePath: TAPE, clips: [{ start: 30, end: 48, category: 'commercials', name: 'Exact' }] }] };
  const ok = await js(async ([p, o]) => (await window.api.splicerCall('startJob', { kind: 'splitPlan', plan: p, out: o, label: 'Exact clip' })).ok, [plan, out]);
  await lastRunDone('Exact clip');
  const file = path.join(out, 'commercials', 'Exact.mp4');
  const firstFrameDiff = mad(gray(['-i', file]), gray(['-ss', '30', '-i', TAPE]));
  const played = await js(async (p) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = await window.api.toFileUrl(p);
    document.body.appendChild(v);
    await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 5000); });
    v.currentTime = 7.5;
    await new Promise((r) => { v.onseeked = r; setTimeout(r, 3000); });
    const before = v.getVideoPlaybackQuality().totalVideoFrames;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const result = { t: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames - before, error: v.error && v.error.message, duration: v.duration };
    v.remove();
    return result;
  }, file);
  record('a frame-accurate clip starts on the right frame and plays across its join',
    ok && hasVideo(file) && firstFrameDiff < 8 && played.t > 9.2 && played.frames > 20 && !played.error && Math.abs(played.duration - 18) < 0.5,
    `first frame differs by ${firstFrameDiff.toFixed(1)}/255; ${JSON.stringify(played)}`);
});

await step('SEND TO RERUNTV makes a channel of the episodes and puts the rest in the ad pool', async () => {
  const before = await js(() => ({ channels: window.S.config.channels.length, pool: window.S.config.interstitials.pool.length }));
  await js(() => { const s = document.querySelector('.splicer-send select'); s.value = 'new'; });
  await page.click('#splicer-send-episodes-btn');
  await until('the channel', () => js((n) => window.S.config.channels.length > n, before.channels), 20000);
  await page.click('#splicer-send-commercials-btn');
  await until('the commercial', () => js((n) => window.S.config.interstitials.pool.length > n, before.pool), 20000);
  await page.click('#splicer-send-bumpers-btn');
  await until('the bumper', () => js((n) => window.S.config.interstitials.pool.length > n + 1, before.pool), 20000);
  const after = await js(() => {
    const ch = window.S.config.channels.find((c) => c.number === window.S.setupSelectedChannel);
    const pool = window.S.config.interstitials.pool.slice(-2);
    return { name: ch && ch.name, files: ch ? ch.files.map((f) => [f.path.split(/[\\/]/).pop(), Math.round(f.duration)]) : [], pool: pool.map((e) => [e.type, e.file.path.split(/[\\/]/).pop()]) };
  });
  record('SEND TO RERUNTV makes a channel of the episodes and puts the rest in the ad pool',
    after.files.length === 1 && after.files[0][0] === 'Tape Two Feature.mp4' && Math.abs(after.files[0][1] - 130) <= 1 && after.pool.map((p) => p[0]).sort().join() === 'adBreakIn,commercial',
    JSON.stringify(after));
  const undo = await js(async () => (await import('app://bundle/renderer/js/core/state.js')).undoLabel());
  record('each send is one undo step', /ad pool/.test(undo || ''), undo);
  await shot('07-sent');
});

await step('runs queue: a second run waits, and a waiting run can be cancelled', async () => {
  await typeInto('splicer-source', TAPE);
  await setOption('Re-encode whole clips', true);
  await typeInto('splicer-out', path.join(work, 'queued'));
  await page.click('#splicer-split-btn');
  await page.click('#splicer-split-btn');
  const rows = await until('two new runs', async () => { const r = await runRows(); return r.filter((x) => x.label === 'Split tape.mp4').length >= 2 ? r : null; }, 10000, 100);
  const mine = rows.filter((x) => x.label === 'Split tape.mp4');
  await scrollTo('#splicer-runs-panel');
  await shot('08-runs-queue');
  const waitingOk = /Waiting/.test(mine[mine.length - 1].status);
  await page.locator('#splicer-runs .splicer-run-row').last().locator('button', { hasText: 'CANCEL' }).click();
  await until('the waiting run cancelled', async () => /Cancelled/.test((await runRows()).pop().status), 10000, 100);
  record('runs queue: a second run waits, and a waiting run can be cancelled', waitingOk, JSON.stringify(mine.map((r) => r.status)));

  // …and the running one, mid re-encode, stops with its ffmpeg.
  await until('a clip being re-encoded', async () => /Splitting · \d of 3/.test((await runRows()).filter((x) => x.label === 'Split tape.mp4')[0].status), 90000, 100);
  await page.locator('#splicer-runs .splicer-run-row.is-running button', { hasText: 'CANCEL' }).click();
  await until('the running run cancelled', async () => (await runRows()).filter((x) => x.label === 'Split tape.mp4').every((x) => /is-done/.test(x.state)), 20000, 200);
  await wait(1500);
  const leftover = ffmpegOnTapes();
  record('CANCEL stops the run and its ffmpeg', leftover === 0, `${leftover} ffmpeg left on the tapes`);
  await setOption('Re-encode whole clips', false);
  await typeInto('splicer-out', CLIPS);
});

await step('a preset can be saved and deleted', async () => {
  await scrollTo('#splicer-split-panel');
  await page.click('#splicer-preset-save-btn');
  await until('the name prompt', () => js(() => !!document.querySelector('.confirm-dialog input')), 5000, 100);
  await page.locator('.confirm-dialog input').last().fill('My VHS tapes');
  await page.locator('.confirm-dialog .confirm-dialog-actions button', { hasText: 'OK' }).last().click();
  await wait(300);
  const saved = await js(() => ({ label: document.getElementById('splicer-preset').selectedOptions[0].textContent, group: !!document.querySelector('#splicer-preset optgroup'), del: !document.getElementById('splicer-preset-delete-btn').hidden }));
  await shot('09-preset-saved');
  await page.click('#splicer-preset-delete-btn');
  await until('the confirm', () => js(() => !!document.querySelector('.confirm-dialog')), 5000, 100);
  await page.locator('.confirm-dialog .confirm-dialog-actions button', { hasText: 'DELETE' }).last().click();
  await wait(300);
  const gone = await js(() => !document.querySelector('#splicer-preset optgroup'));
  record('a preset can be saved and deleted', saved.label === 'My VHS tapes' && saved.group && saved.del && gone, JSON.stringify(saved));
});

await step('COMBINE joins two clips in the listed order', async () => {
  const bumper = clipsOnDisk(CLIPS).find((f) => f.startsWith('bumpers'));
  const commercial = clipsOnDisk(CLIPS).find((f) => f.startsWith('commercials'));
  const out = path.join(work, 'combined.mp4');
  await scrollTo('#splicer-combine-panel');
  await js(async (files) => { (await import('app://bundle/renderer/js/setup/splicer.js')).addClips(files); }, [path.join(CLIPS, commercial), path.join(CLIPS, bumper)]);
  await page.locator('.splicer-queue-row').nth(1).locator('button[aria-label$="earlier"]').click();
  const order = await js(() => [...document.querySelectorAll('.splicer-queue-name')].map((el) => el.textContent));
  await typeInto('splicer-combine-out', out);
  await shot('10-combine-queue');
  await page.click('#splicer-combine-btn');
  await until('the combine note', () => js(() => /Wrote combined\.mp4/.test(document.getElementById('splicer-combine-results').textContent)), 90000);
  record('COMBINE joins two clips in the listed order', order[0] === path.basename(bumper) && fs.existsSync(out) && hasVideo(out), `${order.join(' → ')}; ${await textOf('#splicer-combine-results')}`);
});

await step('remembered settings are written to the splicer folder', async () => {
  await wait(800);
  const file = path.join(here, '..', '..', 'userData', 'video-splicer', 'settings.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  record('remembered settings are written to the splicer folder', saved.defaultOutDir === CLIPS && saved.detectOptions && saved.detectOptions.useScene === false && saved.sendTargets && saved.sendTargets.episodes === 'new', JSON.stringify(saved).slice(0, 240));
});

record('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, errors }, null, 2));
try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close().catch(() => {});
process.exit(failed.length ? 1 : 0);
