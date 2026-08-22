// Shared helper for the two outbound-internet integrations (TMDB metadata,
// NOAA weather alerts) — everything else in this app works fully offline, so
// both callers need the same "never let a slow/unreachable API stall or
// crash a request" behavior and a disk cache so a previous result is still
// available the next time the box is offline. Not used by anything LAN-local
// (a plugin's own local child-process/remote/party servers) — those don't
// go over the internet.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// A function, not a top-level constant — computed lazily on every call
// rather than captured at require() time, since main.js's one-time
// portable-userData migration (main-config.js's migrateUserDataIfNeeded())
// can still repoint app.getPath('userData') after this module is first
// required but before loadCache()/saveCache() actually run.
function getCachePath() { return path.join(app.getPath('userData'), 'api-cache.json'); }
const FETCH_TIMEOUT_MS = 8000;

let cache = null;
function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(getCachePath(), 'utf-8'));
  } catch (e) {
    cache = {};
  }
  return cache;
}

// TMDB (one entry per unique search query / credits lookup) is the entry
// that can actually grow large — a user cataloguing a big library over
// weeks of MATCH-button use adds a permanent, never-expiring entry per
// query. Without a cap the file (and the cost of rewriting all of it on
// every save, below) grows for as long as the app is used. 500 is plenty
// of headroom for a genuinely large multi-week cataloguing session while
// keeping the file — and every write of it — small; oldest-by-fetch-time
// entries are evicted first once over the cap, same as an LRU would.
const MAX_CACHE_ENTRIES = 500;
function pruneCache(store) {
  const keys = Object.keys(store);
  const over = keys.length - MAX_CACHE_ENTRIES;
  if (over <= 0) return;
  keys.sort((a, b) => (store[a].at || 0) - (store[b].at || 0));
  for (let i = 0; i < over; i++) delete store[keys[i]];
}

// Debounced + async rather than an immediate synchronous write — this used
// to do a blocking fs.writeFileSync of the ENTIRE cache (every unrelated
// plugin's entries, not just the one that just changed) on every single
// cache miss, on the Electron main process's own thread. NOAA's poll
// interval nearly guarantees a miss every ~5min for the app's whole
// lifetime, so that was a recurring main-process stall that also got
// slower as the cache grew. Coalescing rapid successive saves (e.g. a
// TMDB bulk-match run) into one write, off the sync fs API, removes both
// costs; losing the last couple seconds of cache writes if the app quits
// mid-debounce is an acceptable tradeoff for a cache that only ever saves
// an API call, never real user data.
const SAVE_DEBOUNCE_MS = 2000;
let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    pruneCache(cache);
    fs.writeFile(getCachePath(), JSON.stringify(cache), 'utf-8', (err) => {
      // best-effort — a failed cache write shouldn't break the caller, and
      // the caller (fetchJsonCached) has long since returned by the time
      // this runs anyway.
    });
  }, SAVE_DEBOUNCE_MS);
}

// Fetches `url` as JSON, using a cached response up to `ttlMs` old on
// success. On network failure (offline, DNS, timeout, non-2xx) falls back to
// whatever's cached regardless of age — stale metadata/alert data beats none
// — and only throws if there's truly nothing cached yet.
async function fetchJsonCached(key, url, opts, ttlMs) {
  const store = loadCache();
  const entry = store[key];
  if (entry && Date.now() - entry.at < ttlMs) return entry.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    store[key] = { at: Date.now(), data };
    saveCache();
    return data;
  } catch (err) {
    if (entry) return entry.data; // stale-but-cached beats a hard failure
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchJsonCached };
