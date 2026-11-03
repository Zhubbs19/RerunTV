// Boot-time plugin activation order (main/plugins/activation-order.js):
// independent plugins start together, a dependent starts only after what it
// dependsOn has finished, and nothing is ever left un-run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { orderByDependencies, runInDependencyOrder } = require('../main/plugins/activation-order.js');

const plugin = (id, dependsOn = []) => ({ id, dependsOn });
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Records start/finish order and the most plugins seen running at once.
function recorder(durations = {}) {
  const log = [];
  let running = 0;
  let peak = 0;
  const run = async (p) => {
    running += 1;
    peak = Math.max(peak, running);
    log.push(`start ${p.id}`);
    await tick(durations[p.id] ?? 10);
    log.push(`end ${p.id}`);
    running -= 1;
  };
  return { run, log, peak: () => peak };
}

test('orderByDependencies puts dependencies first and keeps list order otherwise', () => {
  const ordered = orderByDependencies([plugin('tape', ['ffmpeg']), plugin('noaa'), plugin('ffmpeg'), plugin('loop', ['loop'])]);
  assert.deepEqual(ordered.map((p) => p.id), ['noaa', 'ffmpeg', 'tape', 'loop']);
});

test('independent plugins activate at the same time', async () => {
  const r = recorder();
  await runInDependencyOrder([plugin('a'), plugin('b'), plugin('c')], r.run, 8);
  assert.equal(r.peak(), 3);
  assert.deepEqual(r.log.slice(0, 3), ['start a', 'start b', 'start c']);
});

test('a dependent starts only after its dependency has finished', async () => {
  const r = recorder({ ffmpeg: 30, tape: 5, noaa: 5 });
  await runInDependencyOrder(orderByDependencies([plugin('tape', ['ffmpeg']), plugin('ffmpeg'), plugin('noaa')]), r.run, 8);
  assert.ok(r.log.indexOf('end ffmpeg') < r.log.indexOf('start tape'), r.log.join(', '));
  // The unrelated plugin did not wait for ffmpeg.
  assert.ok(r.log.indexOf('start noaa') < r.log.indexOf('end ffmpeg'), r.log.join(', '));
});

test('a plugin with two dependencies waits for both', async () => {
  const r = recorder({ party: 10, search: 40 });
  await runInDependencyOrder([plugin('party'), plugin('search'), plugin('jukebox', ['party', 'search'])], r.run, 8);
  assert.ok(r.log.indexOf('end search') < r.log.indexOf('start jukebox'), r.log.join(', '));
});

test('never runs more than the limit at once', async () => {
  const r = recorder();
  await runInDependencyOrder(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => plugin(id)), r.run, 2);
  assert.equal(r.peak(), 2);
  assert.equal(r.log.filter((line) => line.startsWith('end')).length, 6);
});

test('a dependency that is not in the list is not waited for', async () => {
  const r = recorder();
  await runInDependencyOrder([plugin('tape', ['ffmpeg-not-approved']), plugin('noaa')], r.run, 8);
  assert.equal(r.peak(), 2);
});

test('a dependency cycle still runs every plugin once nothing else is running', async () => {
  const r = recorder();
  await runInDependencyOrder([plugin('x', ['y']), plugin('y', ['x']), plugin('free')], r.run, 8);
  const starts = r.log.filter((line) => line.startsWith('start')).map((line) => line.slice(6));
  assert.deepEqual(starts.sort(), ['free', 'x', 'y']);
  assert.ok(r.log.indexOf('end free') < r.log.indexOf('start x'), r.log.join(', '));
});

test('a plugin that fails still releases the plugins waiting on it', async () => {
  const started = [];
  await runInDependencyOrder([plugin('broken'), plugin('child', ['broken'])], async (p) => {
    started.push(p.id);
    if (p.id === 'broken') throw new Error('activate() blew up');
  }, 8);
  assert.deepEqual(started, ['broken', 'child']);
});

test('an empty list resolves', async () => {
  await runInDependencyOrder([], async () => { throw new Error('should not run'); }, 4);
});
