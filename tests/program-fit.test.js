// Fit to time slots (renderer/js/core/fit.js) and how schedule.js /
// interstitials.js apply it: programs end on :00/:30, the spare time becomes
// breaks filled from the pool or with placeholder slots, and a program that
// runs a little over is shortened within the caps.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const MIN = 60000;

async function setup(programFit, pool = []) {
  const state = await load('core/state.js');
  const schedule = await load('core/schedule.js');
  const interstitials = await load('core/interstitials.js');
  const fit = await load('core/fit.js');
  state.S.config = {
    commercials: { timing: 'interval', intervalMinutes: 10 },
    interstitials: { pool, presets: [], flows: [] },
    programFit: programFit === undefined ? { enabled: true } : programFit,
  };
  state.S.configGeneration += 1;
  return { state, schedule, interstitials, fit };
}

function channel(files, anchor = new Date(2026, 10, 2, 8, 7).getTime()) {
  return { number: 7, name: 'FIT', anchor, adsEnabled: true, blocks: [], folders: [], files };
}

const cfgOf = (fit, over = {}) => fit.normalizeFitConfig({ ...fit.FIT_DEFAULTS, ...over });
const segTotal = (plan) => plan.segments.reduce((sum, s) => sum + (s.airEnd - s.airStart), 0);

test('a 22-minute show is extended to the half hour with its spare time as breaks', async () => {
  const { fit } = await setup();
  const plan = fit.planFit({ path: 'a', duration: 22 * 60 }, 0, false, cfgOf(fit));
  assert.equal(plan.mode, 'extend');
  assert.equal(plan.slotS, 1800);
  assert.equal(plan.trimmed, false);
  assert.ok(Math.abs(plan.breakS - 480) < 1e-6);
  assert.ok(Math.abs(segTotal(plan) - 1800) < 1e-6, 'segments fill the slot exactly');
  assert.ok(plan.segments.some((s) => s.kind === 'break'));
});

test('a 93-minute movie is shortened to 90 with sped-up credits and a little time compression', async () => {
  const { fit } = await setup();
  const plan = fit.planFit({ path: 'm', duration: 93 * 60, facets: { contentType: 'movie' } }, 0, false, cfgOf(fit));
  assert.equal(plan.mode, 'trim');
  assert.equal(plan.slotS, 90 * 60);
  assert.ok(plan.rateCredits > 1 && plan.rateCredits <= 3 + 1e-9);
  assert.ok(plan.rateBody > 1 && plan.rateBody <= 1.04 + 1e-9);
  assert.ok(Math.abs(plan.airS - 90 * 60) < 1e-6);
  assert.ok(Math.abs(segTotal(plan) - 90 * 60) < 1e-3);
});

test('shortening past the caps extends instead', async () => {
  const { fit } = await setup();
  // 44 minutes: shortening to 30 would need 14 minutes, far over the 5-minute cap.
  const plan = fit.planFit({ path: 'c', duration: 44 * 60 }, 0, false, cfgOf(fit));
  assert.equal(plan.mode, 'extend');
  assert.equal(plan.slotS, 3600);
  // 33 minutes: within the trim cap, but credits + 4% can't save 3 minutes.
  const tight = fit.planFit({ path: 'b', duration: 33 * 60 }, 0, false, cfgOf(fit));
  assert.equal(tight.mode, 'extend');
  // A higher speed-up cap makes it shortenable.
  const loose = fit.planFit({ path: 'b', duration: 33 * 60 }, 0, false, cfgOf(fit, { maxSpeedupPct: 10 }));
  assert.equal(loose.mode, 'trim');
  assert.equal(loose.slotS, 1800);
});

test('strategy: extend never shortens, trim shortens whenever the caps allow', async () => {
  const { fit } = await setup();
  const movie = { path: 'm', duration: 93 * 60 };
  assert.equal(fit.planFit(movie, 0, false, cfgOf(fit, { strategy: 'extend' })).mode, 'extend');
  // 15 minutes over a half hour: auto extends (cutting 15 is no smaller a change than adding 15)...
  const show = { path: 's', duration: 45 * 60 };
  assert.equal(fit.planFit(show, 0, false, cfgOf(fit, { maxTrimMinutes: 30, maxSpeedupPct: 10, creditsMaxSqueezeSeconds: 1800, creditsLeadSeconds: 900, creditsRate: 8 })).mode, 'extend');
  // ...trim shortens it because the (raised) caps allow it.
  assert.equal(fit.planFit(show, 0, false, cfgOf(fit, { strategy: 'trim', maxTrimMinutes: 30, maxSpeedupPct: 10, creditsMaxSqueezeSeconds: 1800, creditsLeadSeconds: 900, creditsRate: 8 })).mode, 'trim');
});

test('a minimum break time per half hour is reserved in every slot', async () => {
  const { fit } = await setup();
  const plan = fit.planFit({ path: 'a', duration: 25 * 60 }, 0, false, cfgOf(fit, { minBreakMinutesPerHalfHour: 8 }));
  // 25 minutes can't fit in 30 with 8 minutes of breaks, so it takes an hour.
  assert.equal(plan.slotS, 3600);
  assert.ok(plan.breakS >= 16 * 60 - 1e-6);
});

test('mapFitAir walks content forward, stops on breaks and runs credits fast', async () => {
  const { fit } = await setup();
  const plan = fit.planFit({ path: 'm', duration: 93 * 60 }, 0, false, cfgOf(fit));
  let last = -1;
  for (let a = 0; a < plan.slotS; a += 7) {
    const at = fit.mapFitAir(plan, a);
    assert.ok(at.contentS >= last - 1e-9, `content never goes backward at ${a}`);
    last = at.contentS;
  }
  const credits = plan.segments.find((s) => s.kind === 'credits');
  assert.equal(fit.mapFitAir(plan, credits.airStart + 1).kind, 'credits');
  const extended = fit.planFit({ path: 'a', duration: 22 * 60 }, 0, false, cfgOf(fit));
  const brk = extended.segments.find((s) => s.kind === 'break');
  const inBreak = fit.mapFitAir(extended, brk.airStart + 1);
  assert.equal(inBreak.kind, 'break');
  assert.equal(inBreak.contentS, brk.contentAt);
});

test('the guide schedule lines every full program up on the half hour', async () => {
  const { schedule } = await setup();
  const files = [
    { path: 'a', duration: 22 * 60 }, { path: 'b', duration: 33 * 60 },
    { path: 'm', duration: 93 * 60, facets: { contentType: 'movie' } },
    { path: 's1', duration: 6 * 60 }, { path: 's2', duration: 7 * 60 }, { path: 'c', duration: 44 * 60 },
  ];
  const ch = channel(files);
  const day = new Date(2026, 10, 3, 0, 0).getTime();
  const entries = schedule.getChannelSchedule(ch, day, day + 24 * 3600000);
  assert.ok(entries.length > 10);
  for (const e of entries) {
    if (e.file.path.startsWith('s')) continue; // grouped shorts air back to back
    const end = e.start + e.file.duration * 1000;
    assert.equal(new Date(end).getMinutes() % 30, 0, `${e.file.path} ends on a boundary`);
    assert.equal(new Date(end).getSeconds(), 0);
  }
  // The loop itself lasts whole slots, so it keeps lining up every time round.
  const total = files.reduce((sum, f) => sum + (entries.find((e) => e.file.path === f.path).file.duration), 0);
  assert.equal(total % 1800, 0);
});

test('fitting off leaves the schedule exactly as it was', async () => {
  const files = [{ path: 'a', duration: 22 * 60 }, { path: 'b', duration: 33 * 60 }];
  const { schedule } = await setup({ enabled: false });
  const ch = channel(files);
  const day = new Date(2026, 10, 3, 0, 0).getTime();
  const plain = schedule.getChannelSchedule(ch, day, day + 6 * 3600000);
  assert.ok(plain.every((e) => !e.file.fit));
  assert.ok(plain.every((e) => files.includes(e.file)), 'the original file objects, untouched');
  // A channel switched on by itself fits even with the box off...
  ch.programFit = { mode: 'on' };
  assert.ok(schedule.getChannelSchedule(ch, day, day + 3600000).some((e) => e.file.fit));
  // ...and one switched off stays as is with the box on.
  const { schedule: s2 } = await setup({ enabled: true });
  const off = channel(files);
  off.programFit = { mode: 'off' };
  assert.ok(s2.getChannelSchedule(off, day, day + 3600000).every((e) => !e.file.fit));
});

test('a settings change re-plans immediately (cache keyed on the config generation)', async () => {
  const { state, schedule } = await setup({ enabled: true, gridMinutes: 30 });
  const ch = channel([{ path: 'a', duration: 22 * 60 }]);
  const t = new Date(2026, 10, 3, 9, 5).getTime();
  assert.equal(schedule.resolveActiveSource(ch, t).files[0].duration, 1800);
  state.S.config.programFit.gridMinutes = 60;
  state.S.configGeneration += 1;
  assert.equal(schedule.resolveActiveSource(ch, t).files[0].duration, 3600);
});

test('fitted breaks are filled from the pool, then with placeholder slots', async () => {
  const pool = [
    { id: 'in', type: 'adBreakIn', channelAffinity: 'any', file: { path: 'in.mp4', duration: 5 } },
    { id: 'out', type: 'adBreakOut', channelAffinity: 'any', file: { path: 'out.mp4', duration: 5 } },
    { id: 'ad1', type: 'commercial', channelAffinity: 'any', file: { path: 'ad1.mp4', duration: 30 } },
  ];
  const { schedule, interstitials } = await setup({ enabled: true, breakPlacement: 'end' }, pool);
  const ch = channel([{ path: 'a', duration: 22 * 60 }], new Date(2026, 10, 3, 9, 0).getTime());
  const breakStart = new Date(2026, 10, 3, 9, 22).getTime();
  const breakEnd = new Date(2026, 10, 3, 9, 30).getTime();
  const first = interstitials.resolveBreakAt(ch, breakStart + 10);
  assert.ok(first && first.fit, 'a fitted break airs once the show ends');
  assert.equal(first.type, 'adBreakIn');
  const segs = first.segments;
  assert.equal(segs[0].windowStart, breakStart);
  assert.equal(segs[segs.length - 1].windowEnd, breakEnd);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].windowStart, segs[i - 1].windowEnd, 'segments are back to back');
  assert.equal(segs[segs.length - 1].type, 'adBreakOut');
  assert.ok(segs.some((s) => s.type === 'commercial'));
  // The pool's one ad airs once; placeholder slots fill the rest rather than repeating it.
  const { interstitials: i2 } = await setup({ enabled: true, breakPlacement: 'end' }, pool);
  const segs2 = i2.resolveBreakAt(ch, breakStart + 10).segments;
  assert.equal(segs2.filter((s) => s.type === 'commercial').length, 1);
  const holders = segs2.filter((s) => s.type === 'fitPlaceholder');
  assert.ok(holders.length > 1);
  assert.ok(holders.every((s) => s.entry.placeholder && s.entry.role === 'commercial'));
  // Content resumes at the next slot: nothing airs as a break at 9:30.
  assert.equal(i2.resolveBreakAt(ch, breakEnd + 100), null);
  assert.equal(schedule.computeSourcePosition(schedule.resolveActiveSource(ch, breakEnd + 100), breakEnd + 100, { ignoreContentLost: true }).fitAt.kind, 'content');
});

test('placeholder-only fill marks every slot, bumpers included', async () => {
  const pool = [{ id: 'ad1', type: 'commercial', channelAffinity: 'any', file: { path: 'ad1.mp4', duration: 30 } }];
  const { interstitials } = await setup({ enabled: true, breakPlacement: 'end', fill: 'placeholders' }, pool);
  const ch = channel([{ path: 'a', duration: 22 * 60 }], new Date(2026, 10, 3, 9, 0).getTime());
  const segs = interstitials.resolveBreakAt(ch, new Date(2026, 10, 3, 9, 22).getTime() + 10).segments;
  assert.ok(segs.every((s) => s.type === 'fitPlaceholder'));
  assert.equal(segs[0].entry.role, 'bumper');
  assert.equal(segs[segs.length - 1].entry.role, 'bumper');
  assert.ok(segs.slice(1, -1).every((s) => s.entry.role === 'commercial'));
});

test('the break timer finds fitted breaks and the ordinary cadence stays off', async () => {
  const { interstitials } = await setup({ enabled: true, breakPlacement: 'end' });
  const ch = channel([{ path: 'a', duration: 22 * 60 }], new Date(2026, 10, 3, 9, 0).getTime());
  const from = new Date(2026, 10, 3, 9, 1).getTime();
  // The 10-minute interval cadence would have fired at 9:10; fitted, the first break is 9:22.
  const next = interstitials.nextBreakBoundary(ch, from);
  assert.ok(Math.abs(next - new Date(2026, 10, 3, 9, 22).getTime()) < 1000, `next break at ${new Date(next)}`);
  assert.equal(interstitials.resolveBreakAt(ch, new Date(2026, 10, 3, 9, 10).getTime() + 5), null);
});

test('the disclaimer card shows only for shortened programs', async () => {
  const { fit } = await setup();
  const cfg = cfgOf(fit);
  const trimmed = { path: 'm', facets: { contentType: 'movie' }, fit: { trimmed: true } };
  assert.match(fit.fitDisclaimerFor(cfg, trimmed), /FORMATTED FOR TELEVISION/);
  assert.equal(fit.fitDisclaimerFor(cfg, { path: 'a', fit: { trimmed: false } }), null);
  assert.equal(fit.fitDisclaimerFor(cfgOf(fit, { disclaimer: false }), trimmed), null);
  assert.equal(fit.fitDisclaimerFor(cfgOf(fit, { disclaimerText: 'edited for time' }), trimmed), 'EDITED FOR TIME');
});

test('a channel END CREDITS panel feeds the fit, and its own fit fields win', async () => {
  const { state, fit } = await setup({ enabled: true, creditsRate: 3 });
  const ch = channel([]);
  ch.creditsSpeedup = { enabled: true, rate: 5, leadSeconds: 120, applies: 'always' };
  let cfg = fit.fitConfigFor(ch);
  assert.equal(cfg.creditsRate, 5);
  assert.equal(cfg.creditsLeadSeconds, 120);
  assert.equal(cfg.creditsApplies, 'always');
  ch.programFit = { creditsRate: 2 };
  state.S.configGeneration += 1;
  cfg = fit.fitConfigFor(ch);
  assert.equal(cfg.creditsRate, 2);
  // Credits squeezed 'always' make room even when the show is extended.
  const plan = fit.planFit({ path: 'a', duration: 22 * 60 }, 0, false, cfgOf(fit, { creditsApplies: 'always' }));
  assert.ok(plan.rateCredits > 1);
  assert.ok(plan.breakS > 480);
});

test('fitting is pure in (channel, timestamp): the same instant resolves the same way', async () => {
  const { schedule, interstitials } = await setup({ enabled: true });
  const ch = channel([{ path: 'a', duration: 22 * 60 }, { path: 'm', duration: 93 * 60 }]);
  const t = new Date(2026, 9, 15, 20, 47, 13).getTime();
  const a = schedule.computeSourcePosition(schedule.resolveActiveSource(ch, t), t, { ignoreContentLost: true });
  const b = schedule.computeSourcePosition(schedule.resolveActiveSource(ch, t), t, { ignoreContentLost: true });
  assert.deepEqual({ ...a, files: null, file: null }, { ...b, files: null, file: null });
  assert.deepEqual(interstitials.resolveBreakAt(ch, t), interstitials.resolveBreakAt(ch, t));
});

test('a fitted break picks the ads and bumpers the channel flow tags for its pods', async () => {
  const pool = [
    { id: 'intro', type: 'adBreakIn', channelAffinity: 7, contentTags: ['intro'], file: { path: 'intro.mp4', duration: 4 } },
    { id: 'ad', type: 'commercial', channelAffinity: 7, contentTags: ['ad'], file: { path: 'ad.mp4', duration: 30 } },
    { id: 'other', type: 'commercial', channelAffinity: 7, contentTags: ['elsewhere'], file: { path: 'other.mp4', duration: 30 } },
  ];
  const { state, interstitials } = await setup({ enabled: true, breakPlacement: 'end' }, pool);
  state.S.config.interstitials.flows = [{
    id: 'f', channels: [7], contentTags: [],
    steps: [{ type: 'contentSegment' }, { type: 'adPod', podMin: 1, podMax: 2, commercialTags: ['ad'], bumpInTags: ['intro'] }],
  }];
  state.S.configGeneration += 1;
  const ch = channel([{ path: 'a', duration: 22 * 60, tags: ['show'] }], new Date(2026, 10, 3, 9, 0).getTime());
  const segs = interstitials.resolveBreakAt(ch, new Date(2026, 10, 3, 9, 22).getTime() + 10).segments;
  assert.equal(segs[0].entry.id, 'intro');
  const ads = segs.filter((s) => s.type === 'commercial');
  assert.deepEqual(ads.map((s) => s.entry.id), ['ad'], 'the flow-tagged ad, once; never the other channel tag');
});

test('spread breaks move to the program\'s fades to black when that switch is on', async () => {
  const { fit, state, interstitials } = await setup();
  const show = { path: 'a', duration: 22 * 60, breakMarks: [{ at: 300, strength: 0.4 }, { at: 700, strength: 1 }] };
  const inProgram = (plan) => plan.segments.filter((s) => s.kind === 'break' && s.airEnd < plan.slotS - 1e-6).map((s) => s.contentAt);
  // The one in-program break sits halfway through the program (before its 90 s of credits).
  assert.deepEqual(inProgram(fit.planFit(show, 0, false, cfgOf(fit))), [615]);
  state.S.config.commercials.snapToFades = true;
  state.S.configGeneration += 1;
  const plan = fit.planFit(show, 0, false, cfgOf(fit));
  assert.deepEqual(inProgram(plan), [700], 'the fade 85 s later wins');
  assert.ok(Math.abs(segTotal(plan) - 1800) < 1e-6, 'segments still fill the slot exactly');
  // The schedule follows the plan: the break airs when the program reaches the fade.
  const ch = channel([show], new Date(2026, 10, 2, 8, 0).getTime());
  const brk = plan.segments.find((s) => s.kind === 'break');
  assert.ok(interstitials.resolveBreakAt(ch, ch.anchor + (brk.airStart + 2) * 1000), 'a break is on at the fade');
  assert.equal(interstitials.resolveBreakAt(ch, ch.anchor + 650 * 1000), null, 'and not at the old halfway point');
  // A fade out of reach leaves the break where it was.
  state.S.config.commercials.snapWindowMinutes = 1;
  state.S.configGeneration += 1;
  assert.deepEqual(inProgram(fit.planFit(show, 0, false, cfgOf(fit))), [615]);
});

test('a fitted film squeezes its credits from where they were found', async () => {
  const { fit, state } = await setup();
  const film = { path: 'm', duration: 93 * 60, facets: { contentType: 'movie' }, creditsFound: { at: 93 * 60 - 300, leadS: 300, density: 1 } };
  const cfg = cfgOf(fit, { creditsApplies: 'always', creditsMaxSqueezeSeconds: 1800 });
  assert.equal(fit.planFit(film, 0, false, cfg).creditsAtS, 93 * 60 - 300, 'from the found start, not 90 s before the end');
  state.S.config.commercials.useFoundCredits = false;
  state.S.configGeneration += 1;
  assert.equal(fit.planFit(film, 0, false, cfg).creditsAtS, 93 * 60 - 90, 'switched off: the lead time');
  state.S.config.commercials.useFoundCredits = true;
  assert.equal(fit.planFit({ ...film, creditsLeadS: 120 }, 0, false, cfg).creditsAtS, 93 * 60 - 120, 'a lead typed for the file wins');
});
