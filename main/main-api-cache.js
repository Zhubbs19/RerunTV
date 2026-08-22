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

const CACHE_PATH = path.join(app.getPath('userData'), 'api-cache.json');
const FETCH_TIMEOUT_MS = 8000;

let cache = null;
function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch (e) {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf-8');
  } catch (e) { /* best-effort — a failed cache write shouldn't break the caller */ }
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
