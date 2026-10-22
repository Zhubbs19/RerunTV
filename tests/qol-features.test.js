'use strict';
// Pure helpers behind the quality-of-life batch: the guide's channel views, the
// sign-on card text, "run behind" anchor math, and the why-is-this-airing line.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core', name)).href);

test('guide views cycle all -> favorites -> unseen -> all', async () => {
  const { nextGuideView } = await load('guide-filter.js');
  assert.equal(nextGuideView('all'), 'favorites');
  assert.equal(nextGuideView('favorites'), 'unseen');
  assert.equal(nextGuideView('unseen'), 'all');
  assert.equal(nextGuideView('nonsense'), 'all');
});

test('favorites view keeps only favorites', async () => {
  const { applyGuideView } = await load('guide-filter.js');
  const channels = [{ number: 2 }, { number: 3 }, { number: 4 }];
  const out = applyGuideView(channels, 'favorites', { isFavorite: (n) => n === 3, now: 0 });
  assert.deepEqual(out.map((c) => c.number), [3]);
});

test('unseen view lists channels not watched within the window, and never-watched ones', async () => {
  const { applyGuideView, lastWatchedByChannel, UNSEEN_DAYS } = await load('guide-filter.js');
  const now = Date.UTC(2026, 9, 22);
  const day = 86400000;
  const watched = lastWatchedByChannel([
    { channelNumber: 2, at: now - 1 * day },
    { channelNumber: 3, at: now - (UNSEEN_DAYS + 1) * day },
    { channelNumber: 3, at: now - (UNSEEN_DAYS + 5) * day },
    { channelNumber: 'x', at: now },
    null,
  ]);
  assert.equal(watched.get(3), now - (UNSEEN_DAYS + 1) * day, 'the latest watch per channel wins');
  const channels = [{ number: 2 }, { number: 3 }, { number: 4 }];
  const out = applyGuideView(channels, 'unseen', { isFavorite: () => false, lastWatched: watched, now });
  assert.deepEqual(out.map((c) => c.number), [3, 4]);
  assert.equal(applyGuideView(channels, 'all', { isFavorite: () => false, now }).length, 3);
});

test('sign-on says nothing for a short absence with no reminders', async () => {
  const { buildSignOn } = await load('sign-on.js');
  const now = Date.now();
  assert.equal(buildSignOn({ now, lastSeenAt: now - 600000, reminders: [], formatTime: String }), null);
  assert.equal(buildSignOn({ now, lastSeenAt: undefined, reminders: [], formatTime: String }), null);
});

test('sign-on reports a long absence and lists upcoming reminders in order', async () => {
  const { buildSignOn, DIGEST_MAX } = await load('sign-on.js');
  const now = 1_000_000_000_000;
  const hour = 3600000;
  const reminders = [
    { channelNumber: 5, title: 'Later', start: now + 5 * hour, end: now + 6 * hour },
    { channelNumber: 3, title: 'Soon', start: now + hour, end: now + 2 * hour },
    { channelNumber: 9, title: 'Too far', start: now + 40 * hour, end: now + 41 * hour },
    { channelNumber: 1, title: 'Over', start: now - 3 * hour, end: now - 2 * hour },
  ];
  const info = buildSignOn({ now, lastSeenAt: now - 5 * hour, reminders, formatTime: (ms) => `T${(ms - now) / hour}` });
  assert.match(info.lines[0], /AWAY FOR 5 HR/);
  assert.match(info.lines[1], /^T1 {2}SOON {2}CH 3$/);
  assert.match(info.lines[2], /LATER/);
  assert.equal(info.lines.length, 3);
  assert.ok(DIGEST_MAX >= 3);
});

test('sign-on caps the digest and says how many more', async () => {
  const { buildSignOn, DIGEST_MAX } = await load('sign-on.js');
  const now = 1_000_000_000_000;
  const reminders = Array.from({ length: DIGEST_MAX + 2 }, (_, i) => ({
    channelNumber: i + 1, title: `Show ${i}`, start: now + (i + 1) * 60000, end: now + (i + 2) * 60000,
  }));
  const info = buildSignOn({ now, lastSeenAt: now, reminders, formatTime: String });
  assert.equal(info.lines.length, DIGEST_MAX + 1);
  assert.match(info.lines[DIGEST_MAX], /\+ 2 MORE/);
});

test('shift hours: parsed, bounded, and applied to the anchor', async () => {
  const { parseShiftHours, shiftedAnchor, describeShift, HOUR_MS } = await load('anchor-shift.js');
  assert.equal(parseShiftHours('3'), 3);
  assert.equal(parseShiftHours(' -2.5 '), -2.5);
  assert.equal(parseShiftHours('0'), null);
  assert.equal(parseShiftHours(''), null);
  assert.equal(parseShiftHours('abc'), null);
  assert.equal(parseShiftHours('99999999'), null);
  assert.equal(shiftedAnchor(1000, 2, 5), 1000 + 2 * HOUR_MS);
  assert.equal(shiftedAnchor(undefined, -1, 10 * HOUR_MS), 9 * HOUR_MS, 'a channel with no anchor yet uses the fallback');
  assert.equal(describeShift(1), '1 hour behind');
  assert.equal(describeShift(-3), '3 hours ahead');
});

test('why-airing names the block and the ad source that won', async () => {
  const { describeWhyAiring } = await load('why-airing.js');
  assert.equal(describeWhyAiring(null), '');
  const line = describeWhyAiring({
    layers: [
      { group: 'content', kind: 'block', item: { name: 'Saturday Morning' }, role: 'wins' },
      { group: 'content', kind: 'default', item: null, role: 'outranked' },
      { group: 'breaks', kind: 'flow', item: { name: 'Kids Ads' }, role: 'wins' },
      { group: 'breaks', kind: 'globalAds', item: null, role: 'outranked' },
    ],
  });
  assert.equal(line, 'BLOCK: SATURDAY MORNING  ·  ADS: FLOW KIDS ADS');
  assert.equal(describeWhyAiring({ layers: [{ group: 'content', kind: 'default', item: null, role: 'wins' }, { group: 'breaks', kind: 'adsSwitch', item: null, role: 'wins' }] }), 'CHANNEL LINEUP  ·  ADS OFF');
  assert.match(describeWhyAiring({ layers: [{ group: 'content', kind: 'block', item: {}, role: 'wins' }] }), /UNNAMED/);
});
