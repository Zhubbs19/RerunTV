// Shared helper for the two outbound-internet integrations (TMDB metadata,
// NOAA weather alerts) — everything else in this app works fully offline, so
// both callers need the same "never let a slow/unreachable API stall or
// crash a request" behavior and a disk cache so a previous result is still
// available the next time the box is offline. Not used by anything LAN-local
// (a plugin's own local child-process/remote/party servers) — those don't
// go over the internet.
const { app } = require('electron');
const path = require('path');
const { cacheTable } = require('../util/db');
const { optionsForRedirect, readBodyTextLimited } = require('../util/fetch-guards');

const FETCH_TIMEOUT_MS = 8000;

// TMDB (one entry per unique search query / credits lookup) is the entry
// that can actually grow large — a user cataloguing a big library over
// weeks of MATCH-button use adds a permanent, never-expiring entry per
// query. 500 is plenty of headroom for a large multi-week cataloguing
// session; oldest-by-fetch-time entries go first once over it. Each entry is
// its own row in rerun.db (main/util/db.js), so a new entry no longer means
// rewriting all the others — entries run to ~10 KB, so the cap now only
// bounds the database's size.
const MAX_CACHE_ENTRIES = 500;

/**
 * Looked up on every call rather than at require() time: main.js's one-time
 * portable-userData migration (config.js's migrateUserDataIfNeeded()) can
 * still repoint app.getPath('userData') after this module is first required.
 * cacheTable() hands back the same table for the same folder after the first call.
 * @returns {object} The `api` cache table.
 */
function apiCache() {
  const userDataDir = app.getPath('userData');
  return cacheTable(userDataDir, 'api', {
    maxEntries: MAX_CACHE_ENTRIES,
    // The pre-SQLite cache: { [key]: { at, data } }.
    importFrom: {
      file: path.join(userDataDir, 'api-cache.json'),
      toEntries: (store) => (store && typeof store === 'object'
        ? Object.entries(store).filter(([, e]) => e && typeof e === 'object' && 'data' in e).map(([key, e]) => [key, e.data, e.at || 0])
        : null),
    },
  });
}

/**
 * A failed cache read or write must never break the fetch it was saving.
 * @param {string} key The cache key.
 * @returns {?object} `{ at, data }`, or null.
 */
function readEntry(key) {
  try {
    const row = apiCache().get(key);
    return row ? { at: row.at, data: row.value } : null;
  } catch (e) {
    return null;
  }
}

/**
 * Stores a fetched value in the cache, ignoring failures.
 * @param {string} key The cache key.
 * @param {*} data The JSON value.
 */
function writeEntry(key, data) {
  try { apiCache().set(key, data); } catch (e) { /* only costs a refetch later */ }
}

// This is handed to every plugin as ctx.fetchJsonCached — unlike
// ctx.spawn/ctx.createServer/ctx.ipcMain, it isn't gated by anything in
// manifest.json's capabilities, so any installed plugin (isolated or not,
// declaring nothing at all) can otherwise reach an internal LAN address or a
// cloud metadata endpoint (169.254.169.254) with attacker-controlled
// headers/body. This doesn't add a manifest-capability gate (that's a
// bigger, separate schema change — see main-media-dispatch.js's own header
// comment on the same gap for mediaSource providers), but it does close the
// specific, most damaging targets: private/loopback/link-local destinations
// no legitimate TMDB/NOAA-style integration ever needs to reach. A literal
// IP check, not a DNS-resolved one — doesn't stop DNS rebinding, but that's
// a materially harder attack than "just point at 169.254.169.254" and out of
// scope for this pass.
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '[::]', '::', '::1']);
/**
 * Checks a dotted IPv4 literal against loopback, private, link-local and carrier-grade NAT ranges.
 * @param {string} host The host.
 * @returns {boolean} True for a blocked address.
 */
function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}
/**
 * Checks whether a URL points at a local, private or internal address (literal IPs only).
 * @param {string} rawUrl The URL.
 * @returns {boolean} True when it must not be fetched; an unparseable URL counts as blocked.
 */
function isBlockedFetchTarget(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { return true; } // unparseable — refuse rather than guess
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (isPrivateIPv4(host)) return true;
  // The fc/fd/fe80 prefix checks are for literal IPv6 only — a hostname such as
  // "fdic.gov" or "fc.example.com" must not be mistaken for a unique-local range.
  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true; // loopback/link-local/unique-local
    // IPv4-mapped (::ffff:a.b.c.d, which URL normalizes to ::ffff:7f00:1): judge the embedded IPv4.
    const mapped = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
    if (mapped) {
      if (mapped[1]) return isPrivateIPv4(mapped[1]);
      const hi = parseInt(mapped[2], 16);
      const lo = parseInt(mapped[3], 16);
      return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (host.startsWith('::ffff:')) return true; // unrecognized mapped form — refuse rather than guess
  }
  return false;
}

/**
 * Fetches `url` as JSON, using a cached response up to `ttlMs` old on
 * success. On network failure (offline, DNS, timeout, non-2xx) falls back to
 * whatever's cached regardless of age — stale metadata/alert data beats none
 * — and only throws if there's truly nothing cached yet.
 * @param {string} key The cache key.
 * @param {string} url The URL to fetch.
 * @param {object} [opts] `fetch` options such as headers.
 * @param {number} ttlMs How old a cached response may be before it is refetched.
 * @returns {Promise<*>} The parsed JSON.
 * @throws {Error} When the target is private, or the fetch fails and nothing is cached.
 */
async function fetchJsonCached(key, url, opts, ttlMs) {
  if (isBlockedFetchTarget(url)) throw new Error(`fetchJsonCached: refusing to fetch a private/internal address (${url})`);
  const entry = readEntry(key);
  if (entry && Date.now() - entry.at < ttlMs) return entry.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Redirects are followed by hand so every hop passes the same private-address
    // filter; a public URL that 302s to 169.254.169.254 is refused.
    let res;
    let target = url;
    let hopOpts = opts;
    for (let hop = 0; ; hop++) {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(target, { ...hopOpts, redirect: 'manual', signal: controller.signal });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location || hop >= 3) throw new Error('too many redirects');
      const next = new URL(location, target).toString();
      if (isBlockedFetchTarget(next)) throw new Error('fetchJsonCached: refusing a redirect to a private/internal address');
      // Authorization/Cookie/API-key headers are meant for the host the plugin
      // named; they do not follow a redirect to a different origin.
      hopOpts = optionsForRedirect(hopOpts, target, next);
      target = next;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // A bounded read: a hostile or broken endpoint cannot make the host buffer
    // an arbitrarily large body.
    const data = JSON.parse(await readBodyTextLimited(res));
    writeEntry(key, data);
    return data;
  } catch (err) {
    if (entry) return entry.data; // stale-but-cached beats a hard failure
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchJsonCached };
