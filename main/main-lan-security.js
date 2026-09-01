// Shared LAN-service authentication and abuse controls.
//
// LAN pages are deliberately simple, dependency-free HTTP servers, but they
// are no longer ambiently trusted just because a request came from a private
// address. Each enabled service gets a process-lifetime pairing code. Opening
// the pairing URL exchanges that code for a random HttpOnly session cookie;
// subsequent static/API/media requests must carry that cookie (or the same
// token as an Authorization: Bearer value for native companion clients).
//
// The pairing CODE is still always process-lifetime (a fresh 8-digit code
// every boot, never persisted) — but a SESSION a device already earned by
// entering that code once can optionally survive restarts, so a phone that
// paired yesterday doesn't have to re-enter a code every single time this
// app reopens. Opt in per createLanAccess() call via opts.sessionsFile (an
// absolute path the caller has write access to — main.js's own
// app.getPath('userData') for a core service, or a plugin's own declared
// dataDir; see plugins/companion-app/main.js and plugins/universal-remote/
// main.js) plus opts.sessionTtlMs (how long a remembered session stays
// valid; the module default below is intentionally short for a service that
// doesn't opt in, since without persistence a long TTL only matters until
// the next restart mints a new pairing code anyway). Electron-free, same as
// every other export here — this file is require()'d unchanged from an
// isolated plugin's own forked process (plugin-isolation-runtime.js), so it
// can only touch the filesystem through a path the caller already resolved
// and was granted.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const WINDOW_MS = 60 * 1000;
// The per-IP write rate limit (checkRateLimit below) bounds one source
// address, but the 8-digit pairing code (~26.6 bits of entropy) has no cap
// on failed guesses spread across many source addresses — trivial for
// anyone already on the LAN, and reachable from off-LAN too via any device
// that loads a page making cross-origin pairing attempts (the
// Sec-Fetch-Site check above only closes THAT delivery mechanism, not
// distributed on-LAN guessing). This caps total wrong guesses for the
// code's whole process lifetime, well above what a real mistyped code would
// ever hit, but tiny next to the 10^8 code space — brute-forcing this code
// via guessing is infeasible before the lockout trips.
const MAX_FAILED_PAIR_ATTEMPTS = 200;
// sessions is capped (MAX_SESSIONS, pruneSessions below) but rateWindows had
// no equivalent — every distinct `${kind}:${ip}` key that ever made a
// request stayed in the map forever, even long after its window expired.
// A flood of requests from many distinct source addresses (real IP-aliasing
// on a LAN, or spoofed source addresses on the read-only GET routes) grows
// that unboundedly. Cap it the same way sessions already are.
const MAX_RATE_WINDOWS = 2000;

function loadPersistedSessions(sessionsFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    return new Map(Object.entries(parsed).filter(([, expiresAt]) => Number.isFinite(expiresAt)));
  } catch (e) {
    return new Map(); // no file yet, or corrupt — start fresh rather than fail pairing entirely
  }
}

function savePersistedSessions(sessionsFile, sessions) {
  try {
    fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
    fs.writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)));
  } catch (e) {
    // Best-effort — a failed write just means this session won't survive
    // the next restart, not a broken pairing right now.
  }
}

function isLanServiceEnabled(config, service) {
  if (service === 'party') return !!(config && config.party && config.party.enabled);
  return !!(config && config.network && config.network[`${service}Enabled`]);
}

function requestIp(req) {
  return (req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function normalizePairingCode(value) {
  return String(value || '').replace(/[\s-]/g, '');
}

function pairingPage(service, message) {
  const title = `${service[0].toUpperCase()}${service.slice(1)} pairing`;
  const note = message
    ? `<p role="alert">${message}</p>`
    : '<p>Enter the pairing code shown by RerunTV on the host. Select the code box with OK to use your TV keyboard.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;background:#171a3b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}main{width:min(360px,calc(100% - 40px));background:#292f6b;padding:28px;border-radius:16px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin-top:12px;border:3px solid transparent}input{letter-spacing:.25em;text-align:center}button{background:#f0b429;color:#171a3b;font-weight:700}input:focus,button:focus{outline:4px solid #73ddff;outline-offset:3px;border-color:#fff}p{line-height:1.45}@media(min-width:900px){body{font-size:26px}main{width:min(680px,calc(100% - 96px));padding:48px;border-radius:24px}input,button{padding:20px;margin-top:20px}input:focus,button:focus{outline-width:6px;outline-offset:5px}}</style></head><body><main><h1>${title}</h1>${note}<form method="post" action="/_pair"><input name="code" type="text" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="12" required autofocus aria-label="Pairing code"><button type="submit">PAIR DEVICE</button></form></main></body></html>`;
}

function readFormBody(req, maxBytes = 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => resolve(new URLSearchParams(raw)));
    req.on('error', reject);
  });
}

function createLanAccess(service, opts = {}) {
  const pairingCode = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  const cookieName = `reruntv_${service.replace(/[^a-z0-9_-]/gi, '_')}`;
  const sessionsFile = opts.sessionsFile || null;
  const sessionTtlMs = opts.sessionTtlMs || SESSION_TTL_MS;
  const sessions = sessionsFile ? loadPersistedSessions(sessionsFile) : new Map(); // token -> expiresAt
  const rateWindows = new Map(); // `${kind}:${ip}` -> {start, count}
  const readLimit = opts.readLimit || 600;
  const writeLimit = opts.writeLimit || 90;
  let failedPairAttempts = 0;
  let pairingLockedOut = false;

  function pruneSessions() {
    const now = Date.now();
    let removed = false;
    sessions.forEach((expiresAt, token) => { if (expiresAt <= now) { sessions.delete(token); removed = true; } });
    while (sessions.size > MAX_SESSIONS) { sessions.delete(sessions.keys().next().value); removed = true; }
    if (removed && sessionsFile) savePersistedSessions(sessionsFile, sessions);
  }

  function issueSession() {
    pruneSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + sessionTtlMs);
    if (sessionsFile) savePersistedSessions(sessionsFile, sessions);
    return token;
  }

  function tokenFromRequest(req) {
    const auth = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
    return parseCookies(req.headers.cookie)[cookieName] || '';
  }

  function isAuthenticated(req) {
    pruneSessions();
    const token = tokenFromRequest(req);
    return !!token && sessions.has(token);
  }

  function pruneRateWindows(now) {
    rateWindows.forEach((state, key) => { if (now - state.start >= WINDOW_MS) rateWindows.delete(key); });
    // Still over the cap after dropping expired entries (a burst of many
    // distinct addresses within one window) — evict oldest-inserted first,
    // same fallback pruneSessions uses.
    while (rateWindows.size > MAX_RATE_WINDOWS) rateWindows.delete(rateWindows.keys().next().value);
  }

  function checkRateLimit(req, res, kind = 'read') {
    const key = `${kind}:${requestIp(req)}`;
    const now = Date.now();
    let state = rateWindows.get(key);
    if (!state || now - state.start >= WINDOW_MS) state = { start: now, count: 0 };
    state.count += 1;
    rateWindows.set(key, state);
    if (rateWindows.size > MAX_RATE_WINDOWS) pruneRateWindows(now);
    const limit = kind === 'write' ? writeLimit : readLimit;
    if (state.count <= limit) return true;
    res.writeHead(429, { 'Retry-After': String(Math.ceil((WINDOW_MS - (now - state.start)) / 1000)) }).end('Too many requests');
    return false;
  }

  function setSession(res, token) {
    // Must match issueSession()'s own expiry (sessionTtlMs, not the module
    // default) — a service that opts into a longer persisted-session TTL
    // (the LAN viewer, companion-app: 90 days) needs the cookie the browser
    // actually keeps to agree with how long the server-side session record
    // stays valid, or the persisted-pairing feature silently doesn't persist.
    res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; Max-Age=${Math.floor(sessionTtlMs / 1000)}; Path=/; HttpOnly; SameSite=Strict`);
    res.setHeader('Cache-Control', 'no-store');
  }

  // A legitimate pairing attempt is either a direct top-level navigation (the
  // user typed/pasted the pairing URL, or a QR scan opened it) or a same-
  // origin form submit from the pairing page itself. Neither of those is
  // "cross-site" per the Sec-Fetch-Site header modern Chromium-based
  // browsers send on every request. A malicious page embedding
  // <img src=".../?pair=code"> or auto-submitting a cross-origin
  // <form action=".../_pair"> both come back "cross-site" — reject those
  // before they can spend a guess against the pairing code. Browsers old
  // enough to omit the header entirely fail open here (same exposure as
  // before this check existed), but that's a shrinking minority and this
  // still closes the hole for everything that can actually run the attack.
  function isCrossSitePairingAttempt(req) {
    return req.headers['sec-fetch-site'] === 'cross-site';
  }

  async function handlePairing(req, res, url) {
    if (isCrossSitePairingAttempt(req)) {
      res.writeHead(403).end('Cross-site pairing requests are not allowed.');
      return true;
    }
    if (pairingLockedOut) {
      res.writeHead(423, { 'Content-Type': 'text/plain' }).end('Too many failed pairing attempts. Restart RerunTV to get a new pairing code.');
      return true;
    }
    if (!checkRateLimit(req, res, 'write')) return true;
    let supplied = url.searchParams.get('pair') || '';
    if (req.method === 'POST' && url.pathname === '/_pair') {
      try { supplied = (await readFormBody(req)).get('code') || ''; } catch (e) {
        if (!res.writableEnded) res.writeHead(400).end('Bad request');
        return true;
      }
    }
    supplied = normalizePairingCode(supplied);
    if (supplied && safeEqual(supplied, pairingCode)) {
      failedPairAttempts = 0;
      const token = issueSession();
      setSession(res, token);
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, expiresIn: SESSION_TTL_MS / 1000 }));
      } else {
        res.writeHead(303, { Location: '/' }).end();
      }
      return true;
    }
    if (supplied) {
      failedPairAttempts += 1;
      if (failedPairAttempts >= MAX_FAILED_PAIR_ATTEMPTS) pairingLockedOut = true;
    }
    if (req.method === 'GET' || (req.method === 'POST' && url.pathname === '/_pair')) {
      const message = supplied ? 'That pairing code was not accepted.' : '';
      res.writeHead(supplied ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(pairingPage(service, message));
      return true;
    }
    res.writeHead(401, { 'WWW-Authenticate': `Bearer realm="RerunTV ${service}"` }).end('Pairing required');
    return true;
  }

  async function authorize(req, res, url, kind = 'read') {
    // Always consume the pairing form endpoint, even when this browser
    // already has a valid session. A phone can submit a cached pairing page
    // after a QR preview/prefetch established its cookie; letting that POST
    // pass into the service router makes its static-file fallback answer
    // 405 Method Not Allowed instead of completing pairing idempotently.
    if (req.method === 'POST' && url.pathname === '/_pair') {
      await handlePairing(req, res, url);
      return false;
    }
    if (!isAuthenticated(req)) {
      await handlePairing(req, res, url);
      return false;
    }
    return checkRateLimit(req, res, kind);
  }

  function pairingUrl(url) {
    const parsed = new URL(url);
    parsed.searchParams.set('pair', pairingCode);
    return parsed.toString();
  }

  return {
    service, pairingCode, pairingUrl, authorize, checkRateLimit, isAuthenticated,
    sessionCount: () => { pruneSessions(); return sessions.size; },
  };
}

module.exports = { createLanAccess, isLanServiceEnabled, requestIp };
