// Fit to time slots (core/fit.js), live on a real channel: programs end on
// :00/:30 in the schedule, the guide and the Flip Bar; a fitted break airs
// with pool ads or placeholder slots and adds no lost time; a shortened
// program shows the formatted-for-television card and runs its credits in the
// squeeze-back with a NEXT AT line; the settings rows exist.
// Run: tests\ui\run-ui-tests.ps1 -Script verify-program-fit.mjs -UserDataSource <installed userData>
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const B = 'app://bundle/renderer/js';
const shot = async (name) => {
  try { await page.screenshot({ path: `tests/ui/screenshots/fit-${name}.png`, timeout: 15000, animations: 'disabled', caret: 'hide' }); }
  catch (e) {
    // Playwright waits for a stable frame; a playing video can keep it waiting. A raw capture doesn't.
    try {
      const cdp = await context.newCDPSession(page);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`tests/ui/screenshots/fit-${name}.png`, Buffer.from(data, 'base64'));
      await cdp.detach();
    } catch (e2) { console.log(`(screenshot ${name} skipped: ${e.message.split(/\r?\n/)[0]})`); }
  }
};

for (let i = 0; i < 40; i += 1) {
  if (await page.evaluate(() => !!(window.S && window.S.config && window.S.config.channels))) break;
  await wait(500);
}
await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(() => document.querySelectorAll('.onboarding-screen').forEach((el) => el.remove()));

// ---------- Pick a real channel and switch fitting on for it ----------
const pick = await page.evaluate(async (B) => {
  const { dispatch } = await import(`${B}/core/state.js`);
  const fit = await import(`${B}/core/fit.js`);
  const cfg = fit.normalizeFitConfig(fit.FIT_DEFAULTS);
  const channels = (window.S.config.channels || []).filter((c) => !c.hidden && Array.isArray(c.files)
    && c.files.filter((f) => f.duration > 0 && (!f.source || f.source === 'local')).length >= 3);
  // Prefer a channel where at least one program gets shortened (credits + compression), then any.
  let best = null;
  for (const c of channels) {
    const plans = fit.fittedFiles(c.files, cfg).map((f) => f.fit).filter(Boolean);
    const trims = plans.filter((p) => p.trimmed).length;
    const score = trims * 10 + plans.length;
    if (!best || score > best.score) best = { number: c.number, name: c.name, trims, plans: plans.length, score };
  }
  if (!best) return null;
  dispatch({ type: 'channel.setFields', channel: best.number, fields: { programFit: { mode: 'on' } } }, { label: 'test fit' });
  return best;
}, B);
record('a real channel to fit', !!pick, JSON.stringify(pick));
if (!pick) { await browser.close(); process.exit(1); }
const CH = pick.number;

// ---------- Schedule / guide maths ----------
const sched = await page.evaluate(async ({ B, CH }) => {
  const { getChannelSchedule } = await import(`${B}/core/schedule.js`);
  const { getChannel } = await import(`${B}/core/channels.js`);
  const { viewNow } = await import(`${B}/core/state.js`);
  const ch = getChannel(CH);
  const now = viewNow();
  const entries = getChannelSchedule(ch, now - 3600000, now + 12 * 3600000);
  const bad = [];
  let fitted = 0;
  entries.forEach((e) => {
    if (!e.file.fit) return;
    fitted += 1;
    const start = e.start === now - 3600000 ? null : e.start;
    const end = e.start + e.file.duration * 1000;
    const onGrid = (t) => { const d = new Date(t); return d.getSeconds() === 0 && d.getMilliseconds() === 0 && d.getMinutes() % 30 === 0; };
    // A fitted program that follows a run of short clips starts off the grid by design; its end never does.
    if (!onGrid(Math.round(end))) bad.push({ path: e.file.path, end: new Date(end).toTimeString().slice(0, 8) });
    void start;
  });
  const sample = entries.slice(0, 8).map((e) => `${new Date(e.start).toTimeString().slice(0, 5)}-${new Date(e.start + e.file.duration * 1000).toTimeString().slice(0, 5)} ${e.file.fit ? e.file.fit.mode : 'as-is'}`);
  return { count: entries.length, fitted, bad, sample };
}, { B, CH });
record('schedule: every fitted program ends on :00/:30', sched.fitted > 0 && sched.bad.length === 0, JSON.stringify({ fitted: sched.fitted, bad: sched.bad.slice(0, 3) }));
console.log('  ', sched.sample.join(' | '));

// Instants to visit (from the pure schedule): a break start, a shortened program's start and its credits.
const marks = await page.evaluate(async ({ B, CH }) => {
  const { getChannelSchedule } = await import(`${B}/core/schedule.js`);
  const { getChannel } = await import(`${B}/core/channels.js`);
  const { viewNow } = await import(`${B}/core/state.js`);
  const ch = getChannel(CH);
  const now = viewNow();
  const entries = getChannelSchedule(ch, now, now + 48 * 3600000);
  let breakAt = null; let trimStart = null; let creditsAt = null;
  for (const e of entries) {
    const plan = e.file.fit;
    if (!plan) continue;
    const brk = plan.segments.find((s) => s.kind === 'break' && s.airEnd - s.airStart >= 60);
    if (!breakAt && brk && e.start + brk.airStart * 1000 > now + 60000) breakAt = e.start + brk.airStart * 1000;
    if (!trimStart && plan.trimmed && e.start > now + 60000) {
      trimStart = e.start;
      const cr = plan.segments.find((s) => s.kind === 'credits' && s.rate > 1.001);
      if (cr) creditsAt = e.start + cr.airStart * 1000;
    }
    if (breakAt && trimStart) break;
  }
  return { breakAt, trimStart, creditsAt };
}, { B, CH });
console.log('   marks', JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v && new Date(v).toString().slice(0, 24)]))));

const jumpTo = (ms) => page.evaluate(async ({ B, CH, ms }) => {
  const { tuneToChannel } = await import(`${B}/playback/core.js`);
  window.S.timeOffsetMs = ms - Date.now();
  await tuneToChannel(CH);
}, { B, CH, ms });

// ---------- On air: a program plays at the mapped position and rate ----------
await jumpTo(Date.now() + 1000);
await wait(9000);
const onAir = await page.evaluate(async ({ B, CH }) => {
  const { computeSourcePosition, resolveActiveSource } = await import(`${B}/core/schedule.js`);
  const { getChannel } = await import(`${B}/core/channels.js`);
  const { viewNow } = await import(`${B}/core/state.js`);
  const { seekOffsetOf, playbackRateOf } = await import(`${B}/core/fit.js`);
  const p = document.getElementById('player');
  const pos = computeSourcePosition(resolveActiveSource(getChannel(CH), viewNow()), viewNow(), { ignoreContentLost: true });
  return {
    kind: pos.fitAt ? pos.fitAt.kind : 'unfitted', expected: seekOffsetOf(pos), rate: playbackRateOf(pos),
    currentTime: p.currentTime, playbackRate: p.playbackRate, paused: p.paused, breakKey: window.S.activeBreakKey,
    lost: window.S.contentLostMs,
  };
}, { B, CH });
if (onAir.kind === 'break') {
  record('on air now: inside a fitted break', !!onAir.breakKey, JSON.stringify(onAir));
} else {
  record('on air now: the picture is where the fitted schedule says', Math.abs(onAir.currentTime - onAir.expected) < 3 && !onAir.paused, JSON.stringify(onAir));
  record('on air now: playback rate matches the plan', Math.abs(onAir.playbackRate - onAir.rate) < 0.01, `${onAir.playbackRate} vs ${onAir.rate}`);
}
await shot('on-air');

// ---------- Guide and Flip Bar ----------
await page.evaluate(async (B) => {
  const { showGuideOverlay } = await import(`${B}/guide/guide.js`);
  const { getChannel } = await import(`${B}/core/channels.js`);
  showGuideOverlay(window.S.currentNumber, getChannel(window.S.currentNumber));
  clearTimeout(window.S.guideHideTimer);
}, B);
await wait(700);
const banner = await page.evaluate(async ({ B, CH }) => {
  const { computeSourcePosition, resolveActiveSource } = await import(`${B}/core/schedule.js`);
  const { getChannel } = await import(`${B}/core/channels.js`);
  const { viewNow } = await import(`${B}/core/state.js`);
  const { formatClock } = await import(`${B}/core/util.js`);
  const now = viewNow();
  const pos = computeSourcePosition(resolveActiveSource(getChannel(CH), now), now, { ignoreContentLost: true });
  const end = now - pos.offset * 1000 + pos.file.duration * 1000;
  const el = document.getElementById('guide-overlay');
  const text = el ? el.innerText.replace(/\s+/g, ' ') : '';
  const clock = formatClock(new Date(end));
  // The banner writes times either as 12:00 PM or in its compact form (12p, 11:30a).
  const d = new Date(end);
  const h12 = ((d.getHours() + 11) % 12) + 1;
  const compact = `${h12}${d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, '0')}` : ''}${d.getHours() < 12 ? 'a' : 'p'}`;
  return { text: text.slice(0, 200), expectEnd: clock, compact, has: text.includes(clock) || new RegExp(`-${compact}\\b`).test(text) };
}, { B, CH });
record('Flip Bar / banner shows the fitted end time', banner.has, JSON.stringify(banner));
await shot('banner');
await page.evaluate(() => document.getElementById('guide-overlay').classList.add('hidden'));
await page.evaluate(async (B) => {
  const { openGuideGrid } = await import(`${B}/guide/guide.js`);
  openGuideGrid();
}, B);
await wait(2000);
const guideRow = await page.evaluate((CH) => {
  const rows = [...document.querySelectorAll('#guide-grid [data-channel], #guide-grid .guide-row')];
  const row = rows.find((r) => String(r.dataset.channel || '') === String(CH)) || null;
  return row ? row.innerText.replace(/\s+/g, ' ').slice(0, 200) : `(${rows.length} rows, channel row not found)`;
}, CH);
console.log('   guide row:', guideRow);
await shot('guide');
await page.evaluate(async (B) => { const { closeGuideGrid } = await import(`${B}/guide/guide.js`); closeGuideGrid(); }, B);
await wait(500);

// ---------- A fitted break ----------
if (marks.breakAt) {
  await jumpTo(marks.breakAt - 4000);
  await wait(11000);
  const brk = await page.evaluate(() => ({
    key: window.S.activeBreakKey, kind: window.S.activeBreakKind, fit: window.S.activeBreakFit, lost: window.S.contentLostMs,
    card: !document.getElementById('fit-slot-card').classList.contains('hidden'),
    text: document.getElementById('fit-slot-text').textContent,
  }));
  record('a fitted break comes on at its scheduled start', !!brk.key && brk.fit, JSON.stringify(brk));
  record('the fitted break adds no lost time', brk.lost === 0, `contentLostMs=${brk.lost}`);
  const kinds = await page.evaluate(async ({ B, CH, at }) => {
    const { resolveBreakAt } = await import(`${B}/core/interstitials.js`);
    const { getChannel } = await import(`${B}/core/channels.js`);
    const r = resolveBreakAt(getChannel(CH), at);
    return r ? r.segments.map((x) => x.type) : [];
  }, { B, CH, at: marks.breakAt + 10 });
  const real = kinds.filter((k) => k !== 'fitPlaceholder').length;
  record('the fitted break uses the channel’s real pool ads/bumpers first', real > 0, kinds.join(','));
  await shot('break');
} else {
  record('a fitted break in the next 48 hours', false, 'none found');
}

// ---------- A shortened program: disclaimer, credits squeeze-back ----------
if (marks.trimStart) {
  await jumpTo(marks.trimStart + 20000);
  await wait(9000);
  const disc = await page.evaluate(() => {
    const el = document.getElementById('format-disclaimer-card');
    return { show: el.classList.contains('show'), text: el.textContent };
  });
  record('a shortened program shows the formatted-for-television card', disc.show && /MODIFIED|FORMATTED|EDITED/.test(disc.text), JSON.stringify(disc));
  await shot('disclaimer');
  if (marks.creditsAt) {
    for (const layout of ['side', 'right', 'corner', 'banner']) {
      await page.evaluate(async ({ B, CH, layout }) => {
        const { dispatch } = await import(`${B}/core/state.js`);
        dispatch({ type: 'settings.set', path: ['programFit', 'creditsLayout'], value: layout });
      }, { B, CH, layout });
      await jumpTo(marks.creditsAt + 3000);
      await wait(9000);
      const sq = await page.evaluate(() => ({
        active: window.S.creditsSpeedupActive, fit: window.S.creditsSpeedupFit, rate: document.getElementById('player').playbackRate,
        panel: !document.getElementById('credits-squeeze-panel').classList.contains('hidden'),
        next: document.getElementById('credits-squeeze-title').textContent,
        at: document.getElementById('credits-squeeze-time').textContent,
        layout: [...document.querySelector('.crt').classList].filter((c) => c.startsWith('squeeze-')).join(','),
        shrink: Math.round((document.getElementById('player').getBoundingClientRect().width / document.querySelector('.crt').getBoundingClientRect().width) * 100) / 100,
      }));
      record(`credits squeeze-back (${layout}): sped up with UP NEXT and NEXT AT`, sq.active && sq.fit && sq.rate > 1 && sq.panel && /NEXT AT \d/.test(sq.at) && sq.layout === `squeeze-${layout}` && (layout === 'banner' ? sq.shrink > 0.9 : sq.shrink < 0.7), JSON.stringify(sq));
      await shot(`credits-${layout}`);
    }
  }
} else {
  record('a shortened program in the next 48 hours (this channel extends everything)', true, 'skipped: nothing on this channel needs shortening');
}

// ---------- Back to now; settings rows ----------
await jumpTo(Date.now());
await wait(3000);
await page.evaluate(async (B) => { const m = await import(`${B}/setup/program-fit.js`); m.renderProgramFitPanel(); }, B);
const rows = await page.evaluate(() => {
  const host = document.getElementById('program-fit-rows');
  return host ? host.querySelectorAll('.setting-row').length : 0;
});
record('PROGRAMMING › FIT TO TIME SLOTS has its setting rows', rows >= 15, `${rows} rows`);

const relevant = errors.filter((e) => !/favicon|ERR_ABORTED|404/.test(e));
record('no page errors', relevant.length === 0, relevant.slice(0, 5).join(' || '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
