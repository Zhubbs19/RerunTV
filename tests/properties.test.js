// Property-based ("fuzz") tests with fast-check: instead of a handful of examples, each test states a rule
// that must hold for ANY input and lets fast-check hunt for a counter-example (and shrink it when it finds
// one). They cover the schedule math, the places that parse untrusted input, and the LAN-only guard.
process.env.TZ = 'America/New_York'; // before any Date use
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fc = require('fast-check');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const loadRenderer = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const RUNS = { numRuns: 300 };

// ---------- the schedule: what is airing is a pure function of (files, anchor, time) ----------
const durations = fc.array(fc.integer({ min: 1, max: 7200 }), { minLength: 1, maxLength: 8 });
const anchors = fc.integer({ min: 1, max: 2_000_000_000_000 });

test('schedule: the position is always inside the file it names, for any lineup and any time', async () => {
  const { computeSourcePosition } = await loadRenderer('core/schedule.js');
  await fc.assert(fc.asyncProperty(durations, anchors, fc.integer({ min: 0, max: 30 * 24 * 3600 * 1000 }), async (ds, anchor, delta) => {
    const files = ds.map((duration, i) => ({ path: `f${i}.mp4`, duration }));
    const total = ds.reduce((a, b) => a + b, 0);
    const pos = computeSourcePosition({ files, anchor }, anchor + delta, { ignoreContentLost: true });
    assert.ok(pos.fileIndex >= 0 && pos.fileIndex < files.length);
    assert.ok(pos.offset >= 0 && pos.offset < files[pos.fileIndex].duration + 1e-6, `offset ${pos.offset} in a ${files[pos.fileIndex].duration}s file`);
    assert.ok(pos.elapsed >= 0 && pos.elapsed < total + 1e-6);
  }), RUNS);
});

test('schedule: a channel repeats exactly every loop length, and counts the loops', async () => {
  const { computeSourcePosition } = await loadRenderer('core/schedule.js');
  await fc.assert(fc.asyncProperty(durations, anchors, fc.integer({ min: 0, max: 10 * 24 * 3600 * 1000 }), fc.integer({ min: 1, max: 20 }), async (ds, anchor, delta, k) => {
    const files = ds.map((duration, i) => ({ path: `f${i}.mp4`, duration }));
    const totalMs = ds.reduce((a, b) => a + b, 0) * 1000;
    const a = computeSourcePosition({ files, anchor }, anchor + delta, { ignoreContentLost: true });
    const b = computeSourcePosition({ files, anchor }, anchor + delta + k * totalMs, { ignoreContentLost: true });
    assert.equal(b.fileIndex, a.fileIndex);
    assert.ok(Math.abs(b.offset - a.offset) < 1e-3, `offset drifted ${a.offset} -> ${b.offset}`);
    assert.equal(b.loopCount, a.loopCount + k);
  }), RUNS);
});

test('schedule: moving forward inside a file moves the offset by exactly that much', async () => {
  const { computeSourcePosition } = await loadRenderer('core/schedule.js');
  await fc.assert(fc.asyncProperty(durations, anchors, fc.integer({ min: 0, max: 5 * 24 * 3600 * 1000 }), fc.integer({ min: 1, max: 5000 }), async (ds, anchor, delta, stepMs) => {
    const files = ds.map((duration, i) => ({ path: `f${i}.mp4`, duration }));
    const a = computeSourcePosition({ files, anchor }, anchor + delta, { ignoreContentLost: true });
    const b = computeSourcePosition({ files, anchor }, anchor + delta + stepMs, { ignoreContentLost: true });
    fc.pre(b.fileIndex === a.fileIndex && b.loopCount === a.loopCount); // same file, same loop: no boundary crossed
    assert.ok(Math.abs((b.offset - a.offset) - stepMs / 1000) < 1e-3);
  }), RUNS);
});

// ---------- untrusted input: the media server's Range header ----------
test('Range header: never throws, never backtracks, and only ever matches digits', () => {
  const { parseRangeHeader } = require('../main/media/protocol.js');
  const header = fc.oneof(
    fc.string({ maxLength: 400 }),
    fc.tuple(fc.constantFrom(' ', '\t', ''), fc.constantFrom('bytes', 'BYTES', 'items'), fc.constantFrom('=', ' = ', ''), fc.stringMatching(/^[0-9 \t-]{0,60}$/), fc.string({ maxLength: 40 })).map((p) => p.join('')),
    fc.nat({ max: 20000 }).map((n) => 'bytes=' + ' '.repeat(n) + 'x'),
  );
  fc.assert(fc.property(header, (h) => {
    const started = process.hrtime.bigint();
    const r = parseRangeHeader(h);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 50, `${ms.toFixed(1)} ms for a ${h.length}-char header`);
    assert.equal(typeof r.malformed, 'boolean');
    if (r.match) {
      assert.match(r.match[1], /^\d*$/);
      assert.match(r.match[2], /^\d*$/);
      assert.equal(r.malformed, false);
    }
  }), RUNS);
});

// ---------- untrusted input: plugin-supplied setting paths ----------
test('settings paths: no path, however hostile, can pollute Object.prototype', async () => {
  const { settingPathPatch } = await loadRenderer('plugin/settings-schema.js');
  const segment = fc.oneof(fc.constantFrom('__proto__', 'constructor', 'prototype', 'polluted', 'a', 'b'), fc.string({ maxLength: 6 }).filter((s) => !s.includes('.')));
  await fc.assert(fc.asyncProperty(fc.array(segment, { minLength: 1, maxLength: 6 }), fc.anything(), async (parts, value) => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort().join();
    const patch = settingPathPatch({ a: { b: {} } }, parts.join('.'), value);
    assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(), before, 'Object.prototype changed');
    assert.equal({}.polluted, undefined);
    const unsafe = parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype');
    if (unsafe) assert.deepEqual(patch, {}, 'an unsafe path must be ignored');
  }), RUNS);
});

// ---------- the LAN-only guard for Cast connections ----------
test('Cast guard: an IPv4 address is accepted exactly when it is private, loopback or link-local', () => {
  const { isLanAddress } = require('../plugins/cast-to-tv/castv2-lite.js');
  const reference = (a, b) => a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  fc.assert(fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (a, b, c, d) => {
    assert.equal(isLanAddress(`${a}.${b}.${c}.${d}`), reference(a, b));
  }), { numRuns: 1000 });
});

test('Cast guard: a hostname is only accepted for plain .local names', () => {
  const { isLanAddress } = require('../plugins/cast-to-tv/castv2-lite.js');
  fc.assert(fc.property(fc.stringMatching(/^[a-z0-9-]{1,20}$/), (name) => {
    assert.equal(isLanAddress(`${name}.local`), true);
    assert.equal(isLanAddress(`${name}.com`), false);
    assert.equal(isLanAddress(`${name}.local.evil.com`), false);
  }), RUNS);
});
