// A short-lived cache of "this media file's playable path and URL". Every video that goes
// on screen (a show, an ad, a bumper) is looked up through two main-process round trips,
// which cost 50-200 ms each time and sit in the gap between one picture and the next.
// Breaks know what comes next, so they look it up while the current segment is still
// playing and the cut finds the answer waiting.
//
// Not cached: a file whose provider has not finished caching it (transcodable === false) or
// that was already fixed by a transcode, since those answers change on their own. Anything
// that retries a failed file calls invalidatePlayableUrl first.
const TTL_MS = 120000;
const MAX_ENTRIES = 64;
const cache = new Map(); // `${source}|${path}` -> { resolved, url, at }
const inflight = new Map();

const keyFor = (source, path) => `${source || 'local'}|${path}`;

export async function resolvePlayableUrl(source, path) {
  const key = keyFor(source, path);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { resolved: hit.resolved, url: hit.url };
  if (inflight.has(key)) return inflight.get(key);
  const pending = (async () => {
    const resolved = await window.api.resolvePlayablePath(source || 'local', path);
    const url = await window.api.toFileUrl(resolved.path);
    if (resolved.transcodable !== false && !resolved.alreadyFixed) {
      cache.delete(key);
      cache.set(key, { resolved, url, at: Date.now() });
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    }
    return { resolved, url };
  })();
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(key);
  }
}

// Fire and forget: look a file up a moment before it is needed. onUrl, if given, is handed
// the URL once known (the break code uses it to load the file into the standby video).
export function prefetchPlayableUrl(file, onUrl) {
  if (!file || !file.path) return;
  resolvePlayableUrl(file.source || 'local', file.path)
    .then(({ url }) => { if (onUrl) onUrl(url); })
    .catch(() => {});
}

export function invalidatePlayableUrl(source, path) {
  cache.delete(keyFor(source, path));
}
