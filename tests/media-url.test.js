// resolvePlayableUrl (playback/media-url.js): the short-lived lookup cache behind break and tune cuts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'playback', 'media-url.js')).href);

function fakeApi(resolveExtra = {}) {
  const calls = { resolve: 0, url: 0 };
  globalThis.window = {
    api: {
      resolvePlayablePath: async (source, p) => { calls.resolve += 1; return { path: `R:${p}`, ...resolveExtra }; },
      toFileUrl: async (p) => { calls.url += 1; return `app://${p}`; },
    },
  };
  return calls;
}

test('a second lookup of the same file is answered from the cache', async () => {
  const calls = fakeApi();
  const { resolvePlayableUrl } = await load();
  const a = await resolvePlayableUrl('local', 'a.mp4');
  const b = await resolvePlayableUrl('local', 'a.mp4');
  assert.equal(a.url, 'app://R:a.mp4');
  assert.equal(b.url, a.url);
  assert.deepEqual(calls, { resolve: 1, url: 1 });
});

test('concurrent lookups share one round trip', async () => {
  const calls = fakeApi();
  const { resolvePlayableUrl } = await load();
  await Promise.all([resolvePlayableUrl('local', 'b.mp4'), resolvePlayableUrl('local', 'b.mp4'), resolvePlayableUrl('local', 'b.mp4')]);
  assert.equal(calls.resolve, 1);
});

test('invalidating a file makes the next lookup go back to the main process', async () => {
  const calls = fakeApi();
  const { resolvePlayableUrl, invalidatePlayableUrl } = await load();
  await resolvePlayableUrl('local', 'c.mp4');
  invalidatePlayableUrl('local', 'c.mp4');
  await resolvePlayableUrl('local', 'c.mp4');
  assert.equal(calls.resolve, 2);
});

test('answers that can change on their own are never cached', async () => {
  for (const extra of [{ transcodable: false }, { alreadyFixed: true }]) {
    const calls = fakeApi(extra);
    const { resolvePlayableUrl } = await load();
    const name = `d-${Object.keys(extra)[0]}.mp4`;
    await resolvePlayableUrl('plugin', name);
    await resolvePlayableUrl('plugin', name);
    assert.equal(calls.resolve, 2, JSON.stringify(extra));
  }
});

test('a prefetch that fails is silent, and a later real lookup still works', async () => {
  fakeApi();
  const { prefetchPlayableUrl, resolvePlayableUrl } = await load();
  globalThis.window.api.resolvePlayablePath = async () => { throw new Error('gone'); };
  prefetchPlayableUrl({ path: 'e.mp4' });
  await new Promise((r) => setTimeout(r, 10));
  fakeApi();
  assert.equal((await resolvePlayableUrl('local', 'e.mp4')).url, 'app://R:e.mp4');
});

test('warming without a DOM, or releasing nothing, is harmless', async () => {
  fakeApi();
  const { warmMedia, releaseWarm, prefetchPlayableUrl } = await load();
  assert.doesNotThrow(() => { warmMedia('app://x', 5); releaseWarm(); });
  prefetchPlayableUrl({ path: 'w.mp4' }, 12);
  await new Promise((r) => setTimeout(r, 10));
});
