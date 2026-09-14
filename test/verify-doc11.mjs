// Scratch: docs/design/11 phases 2–4 against the real lineup — shorts runs,
// break band, call letters, guide program actions, remote hints, the
// time machine scrubber (TV keys, pointer, desktop shuttle unchanged), the
// TV menu's Time Machine › Go to…, and the §5 press counts through both the
// Android bridge (RerunTVInput.native) and trusted key events in TV mode.
// Run through run-ui-tests.ps1 -Script verify-doc11.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'doc11-out');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name) => {
  await wait(120);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
};
const js = (fn, arg) => page.evaluate(fn, arg);
const imp = (name) => `app://bundle/renderer/js/${name}`;
const native = (evt) => js((e) => window.RerunTVInput.native(e), evt);
const visible = (sel) => js((s) => { const el = document.querySelector(s); return !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0; }, sel);
const setMode = (mode) => js(async (m) => (await import('app://bundle/renderer/js/usage-mode.js')).setUsageModePreference(m), mode);
const tune = (n) => js(async (num) => { const { tuneToChannel } = await import('app://bundle/renderer/js/playback-core.js'); await tuneToChannel(num); }, n);
const toLive = () => js(async () => {
  const tm = await import('app://bundle/renderer/js/timemachine.js');
  if (window.S.timeMachineOn) await tm.exitTimeMachine({ toLive: true }); else await tm.returnToLive();
  (await import('app://bundle/renderer/js/guide.js')).closeGuideGrid();
  (await import('app://bundle/renderer/js/tv-menu.js')).closeTvMenu();
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
});
const waitPlaying = async (ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(() => !document.getElementById('player').paused)) return Date.now() - t0; await wait(200); } return null; };
const viewed = () => js(async () => (await import('app://bundle/renderer/js/state.js')).viewNow());
const programStartNow = () => js(async () => {
  const q = await import('app://bundle/renderer/js/schedule-query.js');
  const { viewNow } = await import('app://bundle/renderer/js/state.js');
  const { getChannel } = await import('app://bundle/renderer/js/channels.js');
  const now = viewNow();
  const p = q.querySchedule(getChannel(window.S.currentNumber), now - 6 * 3600000, now + 60000, { breaks: false, offAir: false }).programs.find((x) => now >= x.start && now < x.end);
  return p ? { start: p.start, end: p.end } : null;
});

await wait(4000);
for (let i = 0; i < 40; i += 1) {
  if (await js(() => !!(window.S && window.S.config && window.S.config.channels))) break;
  await wait(500);
}
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await setMode('desktop');
const movieChannel = await js(() => {
  const chans = window.S.config.channels.filter((c) => !c.hidden).sort((a, b) => a.number - b.number);
  const byName = chans.find((c) => /movie/i.test(c.name || ''));
  return (byName || chans[0]).number;
});
const shortsChannel = await js(() => {
  const chans = window.S.config.channels.filter((c) => !c.hidden).sort((a, b) => a.number - b.number);
  const byName = chans.find((c) => /boomerang|cartoon|toon/i.test(c.name || ''));
  return (byName || chans[0]).number;
});
await tune(movieChannel);
await wait(2500);

// ---------------- desktop: time machine strip, shuttle unchanged, pointer ----------------
await page.keyboard.press('t');
await wait(700);
const strip = await js(() => {
  const s = document.querySelector('.tm-scrubber');
  const osd = document.getElementById('vcr-osd');
  return {
    osdVisible: !osd.classList.contains('hidden'), bottomStrip: osd.classList.contains('has-scrubber'),
    programs: s ? s.querySelectorAll('.tm-scrub-program').length : 0,
    breaks: s ? s.querySelectorAll('.tm-scrub-break').length : 0,
    liveShown: s ? !s.querySelector('.tm-scrub-live').classList.contains('hidden') : false,
    cursorLeft: s ? parseFloat(s.querySelector('.tm-scrub-cursor').style.left) : -1,
    at: s ? s.querySelector('.tm-scrub-at').textContent : '',
    osdBottom: Math.round(osd.getBoundingClientRect().bottom), inner: window.innerHeight,
  };
});
record('desktop T opens the time machine as a bottom scrubber strip', strip.osdVisible && strip.bottomStrip && strip.osdBottom <= strip.inner, JSON.stringify(strip));
record('strip shows programs, a LIVE marker and the cursor mid-window', strip.programs > 0 && strip.liveShown && Math.abs(strip.cursorLeft - 50) < 2, `programs ${strip.programs}, breaks ${strip.breaks}, cursor ${strip.cursorLeft}%, "${strip.at}"`);
await shot('desktop-strip');
await page.keyboard.press('ArrowLeft');
await wait(400);
const shuttleDir = await js(() => window.S.shuttleDir);
record('desktop ← in the time machine still shuttles (unchanged)', shuttleDir === -1, `shuttleDir ${shuttleDir}`);
await page.keyboard.press('t');
await wait(1500);
record('desktop T commits the shuttle', await js(() => window.S.shuttleDir === 0 && window.S.timeMachineOn && !window.S.scrubPending));

// pointer click at 25% of the strip
const track = await js(() => { const r = document.querySelector('.tm-scrub-track').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
const winBefore = await js(() => { const s = document.querySelector('.tm-scrub-from'); return s.textContent; });
const beforeClick = await viewed();
await page.mouse.click(track.x + track.w * 0.25, track.y);
await wait(500);
const afterClick = await js(async () => ({ pending: window.S.scrubPending, paused: document.getElementById('player').paused, v: (await import('app://bundle/renderer/js/state.js')).viewNow() }));
const expectedJump = -0.25 * 6 * 3600000; // 25% of a 6 h window centred on the viewed time
record('clicking the strip moves there, paused', afterClick.pending && afterClick.paused && Math.abs((afterClick.v - beforeClick) - expectedJump) < 20 * 60000,
  `moved ${Math.round((afterClick.v - beforeClick) / 60000)} min (expected about ${Math.round(expectedJump / 60000)}), window from ${winBefore}`);
await page.mouse.move(track.x + track.w * 0.25, track.y);
await page.mouse.down();
await page.mouse.move(track.x + track.w * 0.35, track.y, { steps: 5 });
await page.mouse.up();
await wait(400);
const afterDrag = await viewed();
record('dragging on the strip scrubs forward', afterDrag - afterClick.v > 10 * 60000, `${Math.round((afterDrag - afterClick.v) / 60000)} min`);
await page.keyboard.press('Enter');
await wait(2500);
const committed = await js(() => ({ pending: window.S.scrubPending, paused: document.getElementById('player').paused, on: window.S.timeMachineOn }));
record('Enter plays from the scrubbed position', !committed.pending && !committed.paused && committed.on, JSON.stringify(committed));
await page.keyboard.press('Escape');
await wait(1500);
record('Escape returns to live and closes the time machine', await js(() => Math.abs(window.S.timeOffsetMs) < 1000 && !window.S.timeMachineOn));

// ---------------- desktop guide: shorts runs, break band, call letters ----------------
await tune(shortsChannel);
await wait(1800);
await js(async () => { const g = await import('app://bundle/renderer/js/guide.js'); window.S.guideDocked = false; g.openGuideGrid(); });
await wait(900);
const runs = await js(() => Array.from(document.querySelectorAll('#guide-rows .guide-entry-run')).map((el) => ({ label: el.textContent, w: Math.round(el.getBoundingClientRect().width) })));
record('runs of shorts render as merged cells', runs.length > 0, JSON.stringify(runs.slice(0, 4)));
if (runs.length) {
  const box = await js(() => { const el = document.querySelector('#guide-rows .guide-entry-run'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: Number((el.textContent.match(/\((\d+)\)/) || [])[1]) }; });
  await page.mouse.click(box.x, box.y);
  await wait(500);
  const list = await js(() => { const l = document.querySelector('.guide-run-list'); return l ? { items: l.querySelectorAll('.guide-run-item').length, active: Array.from(l.querySelectorAll('.guide-run-item')).findIndex((i) => i.classList.contains('active')), heading: l.querySelector('.guide-run-heading').textContent } : null; });
  record('clicking a merged cell opens its list with every entry', !!list && list.items === box.n, JSON.stringify(list));
  await shot('guide-shorts-list');
  await page.keyboard.press('ArrowDown');
  const moved = await js(() => Array.from(document.querySelectorAll('.guide-run-item')).findIndex((i) => i.classList.contains('active')));
  record('▼ moves within the list', list && moved === Math.min(list.active + 1, list.items - 1), `${list && list.active} -> ${moved}`);
  await page.keyboard.press('Escape');
  await wait(200);
  record('Escape closes the list, the guide stays open', !(await js(() => !!document.querySelector('.guide-run-list'))) && await visible('#guide-grid'));
}
await js(async () => { const { dispatch } = await import('app://bundle/renderer/js/state.js'); dispatch({ type: 'settings.set', path: ['display', 'guideMergeShorts'], value: false }); (await import('app://bundle/renderer/js/guide.js')).renderGuideGrid(); });
await wait(300);
record('turning grouping off shows no merged cells', await js(() => document.querySelectorAll('#guide-rows .guide-entry-run').length === 0));
await js(async () => { const { dispatch } = await import('app://bundle/renderer/js/state.js'); dispatch({ type: 'settings.set', path: ['display', 'guideMergeShorts'], value: true }); });

await js(async () => { window.S.guideShowBreaks = true; (await import('app://bundle/renderer/js/guide.js')).renderGuideGrid(); });
await wait(500);
const band = await js(() => ({
  bands: Array.from(document.querySelectorAll('#guide-rows .guide-break')).map((el) => Math.round(el.getBoundingClientRect().height)),
  oldBlocks: document.querySelectorAll('.guide-entry-break').length,
  lifted: (() => { const t = document.querySelector('#guide-rows .guide-row-track.has-breaks .guide-entry'); return t ? getComputedStyle(t).bottom : null; })(),
}));
record('break display draws thin bands under programs, no overlapping blocks', band.bands.length > 0 && band.bands.every((h) => h <= 6) && band.oldBlocks === 0 && band.lifted === '9px', `${band.bands.length} bands, heights ${[...new Set(band.bands)].join(',')}, program bottom ${band.lifted}`);
await shot('guide-break-band');
await js(async () => { window.S.guideShowBreaks = false; });

const letters = await js(async () => {
  const { dispatch } = await import('app://bundle/renderer/js/state.js');
  const g = await import('app://bundle/renderer/js/guide.js');
  const model = await import('app://bundle/renderer/js/guide-model.js');
  dispatch({ type: 'settings.set', path: ['display', 'guideChannelNames'], value: 'short' });
  const ch = window.S.config.channels.find((c) => /nick/i.test(c.name || '')) || window.S.config.channels[0];
  dispatch({ type: 'channel.set', channel: ch.number, field: 'callLetters', value: 'NICK' });
  g.renderGuideGrid();
  const names = Array.from(document.querySelectorAll('#guide-rows .guide-row-chan')).map((cell) => ({ n: cell.dataset.channelNumber, t: cell.querySelector('.grc-name').textContent }));
  const auto = window.S.config.channels.filter((c) => c.number !== ch.number && !c.hidden).map((c) => ({ n: String(c.number), want: model.channelCallLetters(c) }));
  const own = names.find((x) => x.n === String(ch.number));
  const autoOk = auto.every((a) => { const got = names.find((x) => x.n === a.n); return !got || got.t === a.want; });
  dispatch({ type: 'channel.set', channel: ch.number, field: 'callLetters', value: undefined });
  const cleared = !Object.prototype.hasOwnProperty.call(ch, 'callLetters');
  return { own: own && own.t, autoOk, cleared, sample: names.slice(0, 8) };
});
record('abbreviated names show call letters: own ones, then derived ones', letters.own === 'NICK' && letters.autoOk && letters.cleared, JSON.stringify(letters.sample));
await shot('guide-call-letters');
await js(async () => { const { dispatch } = await import('app://bundle/renderer/js/state.js'); dispatch({ type: 'settings.set', path: ['display', 'guideChannelNames'], value: 'full' }); (await import('app://bundle/renderer/js/guide.js')).closeGuideGrid(); });
await wait(400);

// ---------------- TV mode: press counts (§5) through the Android bridge ----------------
await setMode('tv');
await tune(movieChannel);
await wait(2500);
await toLive();
await wait(1500);
let presses = 0;
let expected = await programStartNow();
presses += 1; await native({ key: 'left' }); await wait(900);
const guideOpen = await visible('#guide-grid');
presses += 1; await native({ key: 'ok', longPress: true }); await wait(400);
const firstAction = await js(() => { const l = document.querySelector('.guide-actions'); return l ? l.querySelector('.guide-run-item').textContent : null; });
await shot('tv-guide-actions');
presses += 1; await native({ key: 'ok' }); await wait(2500);
let v = await viewed();
record(`bridge: start of this show in ${presses} presses (◀, hold OK, OK)`, presses <= 3 && guideOpen && firstAction === 'WATCH FROM START' && expected && Math.abs(v - expected.start - 2500) < 6000 && !(await visible('#guide-grid')),
  `first action "${firstAction}", landed ${expected ? Math.round((v - expected.start) / 1000) : '?'} s after the start`);

await toLive();
await wait(1500);
presses = 0;
const liveAt = await viewed();
presses += 1; await native({ key: 'playPause' }); await wait(300);
presses += 1; await native({ key: 'down' }); await wait(200);
const focused = await js(() => document.activeElement && document.activeElement.textContent);
presses += 1; await native({ key: 'ok' }); await wait(300);
const firstGoTo = await js(() => document.activeElement && document.activeElement.textContent);
await shot('tv-menu-time-machine');
presses += 1; await native({ key: 'ok' }); await wait(1500);
const banner = await js(() => { const b = document.querySelector('.tm-scrub-banner'); return { text: b && !b.classList.contains('hidden') ? b.textContent : null, pending: window.S.scrubPending, paused: document.getElementById('player').paused }; });
await shot('tv-far-jump-banner');
presses += 1; await native({ key: 'ok' }); await wait(1000);
const startMs = await waitPlaying();
v = await viewed() - (startMs || 0) - 1000 + 3000;
const played = await js(() => ({ pending: window.S.scrubPending, paused: document.getElementById('player').paused }));
const yesterdayErr = v - (liveAt - 86400000) - 6000;
record(`bridge: yesterday same time in ${presses} presses (Play, ▼, OK, OK, OK)`, presses <= 5 && focused === 'TIME MACHINE ›' && firstGoTo === 'YESTERDAY SAME TIME' && !!banner.text && banner.pending && !played.pending && !played.paused && Math.abs(yesterdayErr) < 15000,
  `focus "${focused}" → "${firstGoTo}", banner "${banner.text}", off by ${Math.round(yesterdayErr / 1000)} s, playing ${!played.paused}`);

// ---------------- TV mode: scrubber keys ----------------
presses = 0;
await native({ key: 'back' }); await wait(1500);
record('bridge: Back from the time machine returns to live', await js(() => Math.abs(window.S.timeOffsetMs) < 1000 && !window.S.timeMachineOn));
await native({ key: 'rewind' }); await wait(600);
record('bridge: Rewind opens the time machine', await js(() => window.S.timeMachineOn));
let before = await viewed();
await native({ key: 'right' }); await wait(250);
let after = await viewed();
record('bridge: ▶ steps 10 s', Math.abs(after - before - 10000) < 1500, `${Math.round((after - before) / 100) / 10} s`);
// hold: repeats for 2.2 s, then measure one step
await native({ key: 'right' });
const holdStart = Date.now();
while (Date.now() - holdStart < 2200) { await native({ key: 'right', repeat: true }); await wait(90); }
before = await viewed(); await native({ key: 'right', repeat: true }); after = await viewed();
record('bridge: holding ▶ past 1.5 s steps 30 s', Math.abs(after - before - 30000) < 1500, `${Math.round((after - before) / 1000)} s`);
while (Date.now() - holdStart < 4200) { await native({ key: 'right', repeat: true }); await wait(90); }
before = await viewed(); await native({ key: 'right', repeat: true }); after = await viewed();
record('bridge: holding ▶ past 3.5 s steps 2 min', Math.abs(after - before - 120000) < 2000, `${Math.round((after - before) / 1000)} s`);
while (Date.now() - holdStart < 6300) { await native({ key: 'right', repeat: true }); await wait(90); }
await wait(450);
before = await viewed(); await native({ key: 'right', repeat: true }); await wait(100); after = await viewed();
const startsAfter = await js(async () => {
  const q = await import('app://bundle/renderer/js/schedule-query.js');
  const { getChannel } = await import('app://bundle/renderer/js/channels.js');
  const { viewNow } = await import('app://bundle/renderer/js/state.js');
  const now = viewNow();
  return q.querySchedule(getChannel(window.S.currentNumber), now - 6 * 3600000, now + 6 * 3600000, { breaks: false, offAir: false }).programs.some((p) => Math.abs(p.start - now) < 1500);
});
record('bridge: holding ▶ past 6 s jumps to a program start', after > before && startsAfter, `${Math.round((after - before) / 60000)} min`);
await native({ key: 'right' }); await wait(200); // off the start
await native({ key: 'up' }); await wait(300);
const atStart = await programStartNow();
v = await viewed();
record('bridge: ▲ goes to the current program\'s start', atStart && Math.abs(v - atStart.start) < 1500, atStart ? `${Math.round((v - atStart.start) / 1000)} s from start` : 'no program');
await native({ key: 'down' }); await wait(300);
const nextStart = await programStartNow();
v = await viewed();
record('bridge: ▼ goes to the next program\'s start', nextStart && atStart && nextStart.start > atStart.start && Math.abs(v - nextStart.start) < 1500);
await shot('tv-strip-scrubbing');
await native({ key: 'ok' }); await wait(2500);
record('bridge: OK plays from the scrubbed position', await js(() => !window.S.scrubPending && !document.getElementById('player').paused && window.S.timeMachineOn));
await native({ key: 'back' }); await wait(1500);

// ---------------- TV mode: trusted key events ----------------
await toLive(); await wait(1500);
expected = await programStartNow();
presses = 0;
presses += 1; await page.keyboard.press('ArrowLeft'); await wait(900);
presses += 1; await page.keyboard.down('Enter'); await wait(700); await page.keyboard.up('Enter'); await wait(400);
const keysAction = await js(() => { const l = document.querySelector('.guide-actions'); return l ? l.querySelector('.guide-run-item.active').textContent : null; });
presses += 1; await page.keyboard.press('Enter'); await wait(2500);
v = await viewed();
record(`keys: start of this show in ${presses} presses (◀, hold OK, OK)`, keysAction === 'WATCH FROM START' && expected && Math.abs(v - expected.start - 2500) < 6000, `action "${keysAction}", ${expected ? Math.round((v - expected.start) / 1000) : '?'} s after start`);
await toLive(); await wait(1500);
const liveAt2 = await viewed();
presses = 0;
presses += 1; await page.keyboard.press('MediaPlayPause'); await wait(300);
presses += 1; await page.keyboard.press('ArrowDown'); await wait(200);
presses += 1; await page.keyboard.press('Enter'); await wait(300);
presses += 1; await page.keyboard.press('Enter'); await wait(1500);
presses += 1; await page.keyboard.press('Enter'); await wait(3000);
v = await viewed();
const err2 = v - (liveAt2 - 86400000) - 6000;
record(`keys: yesterday same time in ${presses} presses`, Math.abs(err2) < 15000 && await js(() => !window.S.scrubPending && !document.getElementById('player').paused), `off by ${Math.round(err2 / 1000)} s`);
await page.keyboard.press('Escape'); await wait(1500);

// ---------------- TV mode: guide popover, hints, TV menu in the guide ----------------
await toLive(); await wait(800);
await native({ key: 'left' }); await wait(900);
await native({ key: 'ok', longPress: true }); await wait(300);
await native({ key: 'back' }); await wait(300);
record('bridge: Back closes the actions menu, not the guide', !(await js(() => !!document.querySelector('.guide-actions'))) && await visible('#guide-grid'));
const hints = await js(() => Array.from(document.querySelectorAll('.guide-hint > span')).filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.textContent));
record('TV guide hints name remote buttons only, no colour-key hint yet', hints.length > 0 && hints.every((h) => !/^[A-Z] |ESC|ENTER|\//.test(h)) && !hints.some((h) => /RED/.test(h)), hints.join(' | '));
await native({ key: 'red' }); await wait(400);
const afterRed = await js(() => ({ hasColour: document.documentElement.classList.contains('remote-has-colour'), hint: Array.from(document.querySelectorAll('.guide-hint > span')).some((s) => /RED/.test(s.textContent) && getComputedStyle(s).display !== 'none') }));
record('a colour key reveals the colour hint (and red steps a day)', afterRed.hasColour && afterRed.hint, JSON.stringify(afterRed));
await native({ key: 'playPause' }); await wait(300);
const menuFirst = await js(() => Array.from(document.querySelectorAll('#tv-menu-grid .tv-menu-btn')).slice(0, 4).map((b) => b.textContent));
record('TV menu over the guide starts with dock, breaks and search', /GUIDE$/.test(menuFirst[0]) && /BREAKS$/.test(menuFirst[1]) && menuFirst[2] === 'SEARCH GUIDE', menuFirst.join(' | '));
await native({ key: 'back' }); await wait(300);
await native({ key: 'back' }); await wait(800);
await shot('tv-docked-guide');

// ---------------- themes: popover and strip render in every theme ----------------
const themes = await page.evaluate(async () => (await import('app://bundle/renderer/js/plugins.js')).themePackEntries().map((e) => e.id));
const themeProblems = [];
await setMode('tv');
for (const id of themes) {
  await js(async (theme) => { window.S.config.theme = theme; const { applyTheme } = await import('app://bundle/renderer/js/themes.js'); applyTheme({ boxOnly: true }); }, id);
  await toLive(); await wait(300);
  await native({ key: 'left' }); await wait(700);
  await native({ key: 'ok', longPress: true }); await wait(300);
  const pop = await js(() => { const l = document.querySelector('.guide-actions'); if (!l) return null; const r = l.getBoundingClientRect(); const g = document.getElementById('guide-grid').getBoundingClientRect(); return { inside: r.left >= g.left - 1 && r.right <= g.right + 1 && r.top >= g.top - 1 && r.bottom <= g.bottom + 1, color: getComputedStyle(l.querySelector('.guide-run-item.active')).color, bg: getComputedStyle(l.querySelector('.guide-run-item.active')).backgroundImage + getComputedStyle(l.querySelector('.guide-run-item.active')).backgroundColor }; });
  if (!pop || !pop.inside) themeProblems.push(`${id}: actions menu ${pop ? 'outside the guide' : 'missing'}`);
  await shot(`theme-${id}-actions`);
  await native({ key: 'back' }); await wait(200);
  await native({ key: 'back' }); await wait(700);
  await native({ key: 'rewind' }); await wait(500);
  const s = await js(() => { const osd = document.getElementById('vcr-osd'); const r = osd.getBoundingClientRect(); return { onScreen: r.bottom <= window.innerHeight + 1 && r.top >= 0, programs: document.querySelectorAll('.tm-scrub-program').length }; });
  if (!s.onScreen || !s.programs) themeProblems.push(`${id}: strip ${JSON.stringify(s)}`);
  await shot(`theme-${id}-strip`);
  await native({ key: 'back' }); await wait(900);
}
record(`popover and scrubber render inside the screen in all ${themes.length} themes`, themeProblems.length === 0, themeProblems.join(' | '));

await setMode('desktop');
await cdp.send('Emulation.clearDeviceMetricsOverride');
record('no page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
