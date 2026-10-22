// Shared LAN-service authentication and abuse controls.
//
// LAN pages are deliberately simple, dependency-free HTTP servers, but they
// are no longer ambiently trusted just because a request came from a private
// address. Each enabled service gets a process-lifetime pairing code. Opening
// the pairing URL exchanges that code for a random HttpOnly session cookie;
// subsequent static/API/media requests must carry that cookie (or the same
// token as an Authorization: Bearer value for native companion clients).
//
// A service can offer more than one SCOPE (docs/design/06 §4). Each scope gets
// its own pairing code, and the code a device enters is what fixes its
// session's scope for that session's whole life. `view` is read-only: the
// redacted config projection, media and filtered events. `control` may also
// POST commands and read the unredacted-but-credential-stripped config. There
// is deliberately no upgrade path: entering the control code on a device that
// already holds a view session mints a NEW session rather than widening the
// old one, so a token that was only ever meant to watch can never become a
// token that can write. Administration (plugin install, capability approval,
// updates, network services) is not grantable remotely at all and stays on the
// host window — no `admin` scope is issued here.
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
const { atomicWriteFile } = require('../util/atomic-write');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// A control session can rewrite the lineup, so it gets a hard ceiling that
// sliding renewal never extends past (the pairing code is entered again).
const CONTROL_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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
// Both caps decay: a permanent lockout would let any one device on the LAN
// deny pairing to everyone until the app restarted. Failures are counted per
// source address (a mistyped code on one phone never locks the others out),
// and a global ceiling still bounds guesses spread across many addresses.
const MAX_FAILED_PAIR_ATTEMPTS = 200;
const GLOBAL_PAIR_FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_PAIR_ATTEMPTS_PER_IP = 10;
const PER_IP_PAIR_FAIL_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIR_FAIL_TRACKED_IPS = 2000;
// sessions is capped (MAX_SESSIONS, pruneSessions below) but rateWindows had
// no equivalent — every distinct `${kind}:${ip}` key that ever made a
// request stayed in the map forever, even long after its window expired.
// A flood of requests from many distinct source addresses (real IP-aliasing
// on a LAN, or spoofed source addresses on the read-only GET routes) grows
// that unboundedly. Cap it the same way sessions already are.
const MAX_RATE_WINDOWS = 2000;

// Sessions used to be stored as token -> expiresAt. They now carry a scope, so
// a file written by an older build is read as the view-only sessions it
// described — never silently promoted to something writable.
function normalizeSession(value) {
  if (Number.isFinite(value)) return { expiresAt: value, scope: 'view', profileId: null, createdAt: Date.now() };
  if (value && Number.isFinite(value.expiresAt)) {
    return {
      expiresAt: value.expiresAt,
      scope: value.scope === 'control' ? 'control' : 'view',
      profileId: typeof value.profileId === 'string' ? value.profileId : null,
      // Files from before createdAt existed: treat the session as created
      // now, so an old long-lived control session is clamped to the new cap
      // from this boot rather than surviving its original 90 days.
      createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    };
  }
  return null;
}

function loadPersistedSessions(sessionsFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    return new Map(Object.entries(parsed)
      .map(([token, value]) => [token, normalizeSession(value)])
      .filter(([, session]) => session !== null));
  } catch (e) {
    return new Map(); // no file yet, or corrupt — start fresh rather than fail pairing entirely
  }
}

// file -> { writing, pending }. Writes to one file are serialized (a newer
// snapshot replaces a queued one) so two overlapping writes can never
// interleave, and each write goes to a temp file renamed into place so a
// crash mid-write can't leave a truncated sessions file.
const sessionWrites = new Map();

function savePersistedSessions(sessionsFile, sessions) {
  // Fire-and-forget async write: this runs on nearly every authenticated
  // request (renewSessionIfNeeded), and main is single-threaded — a
  // synchronous write here would briefly block every other request/IPC call.
  let state = sessionWrites.get(sessionsFile);
  if (!state) { state = { writing: false, pending: null }; sessionWrites.set(sessionsFile, state); }
  state.pending = JSON.stringify(Object.fromEntries(sessions));
  if (state.writing) return;
  state.writing = true;
  (async () => {
    while (state.pending !== null) {
      const data = state.pending;
      state.pending = null;
      try {
        await atomicWriteFile(sessionsFile, data, { mode: 0o600, mkdir: true });
      } catch (e) {
        // Best-effort — a failed write just means this session won't survive
        // the next restart, not a broken pairing right now.
      }
    }
    state.writing = false;
  })();
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
    const rawValue = part.slice(idx + 1).trim();
    let value;
    // A malformed escape (%zz) must not throw out of request handling.
    try { value = decodeURIComponent(rawValue); } catch (e) { value = rawValue; }
    out[part.slice(0, idx).trim()] = value;
  });
  return out;
}

// A browser attaches Origin to cross-site writes. A native LAN client (the
// companion app) sends none; a client that does send one must be talking to
// the host it is addressing. Shared by every mutating route via authorize().
function originMatchesHost(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

// JSON writes only: an HTML form cannot send application/json, so requiring
// it closes the simple-request CSRF route. Multipart is allowed only where the
// caller says so (the asset upload), and still passes the Origin check.
function hasJsonContentType(req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
}
function hasMultipartContentType(req) {
  return /^multipart\/form-data\b/i.test(String(req.headers['content-type'] || ''));
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
    // Collect Buffers and decode once: a multi-byte character split across
    // two chunks would otherwise decode to replacement characters.
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

const sessionId = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
const newCode = () => String(crypto.randomInt(0, 100000000)).padStart(8, '0');

// opts.scopes: which scopes this service hands out, most privileged last.
// Omitted means view-only, which is every existing caller.
function createLanAccess(service, opts = {}) {
  const scopes = Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : ['view'];
  // One code per scope. They are independent: knowing the view code tells you
  // nothing about the control code.
  const pairingCodes = Object.fromEntries(scopes.map((scope) => [scope, newCode()]));
  const pairingCode = pairingCodes.view || pairingCodes[scopes[0]];
  const cookieName = `reruntv_${service.replace(/[^a-z0-9_-]/gi, '_')}`;
  const sessionsFile = opts.sessionsFile || null;
  const sessionTtlMs = opts.sessionTtlMs || SESSION_TTL_MS;
  const controlMaxAgeMs = opts.controlSessionMaxAgeMs || CONTROL_SESSION_MAX_AGE_MS;
  // How long a session of this scope may live in total from pairing. View
  // sessions keep the service's TTL and slide; control sessions are capped.
  const ttlForScope = (scope) => (scope === 'control' ? Math.min(sessionTtlMs, controlMaxAgeMs) : sessionTtlMs);
  const sessions = sessionsFile ? loadPersistedSessions(sessionsFile) : new Map(); // token -> { expiresAt, scope, createdAt }
  sessions.forEach((session) => {
    if (session.scope === 'control') session.expiresAt = Math.min(session.expiresAt, session.createdAt + controlMaxAgeMs);
  });
  const rateWindows = new Map(); // `${kind}:${ip}` -> {start, count}
  const readLimit = opts.readLimit || 600;
  const writeLimit = opts.writeLimit || 90;
  const failedPairByIp = new Map(); // ip -> { count, start }
  let globalPairFailures = { count: 0, start: 0 };

  function pairingLockedFor(ip) {
    const now = Date.now();
    if (globalPairFailures.count >= MAX_FAILED_PAIR_ATTEMPTS) {
      if (now - globalPairFailures.start < GLOBAL_PAIR_FAIL_WINDOW_MS) return true;
      globalPairFailures = { count: 0, start: 0 };
    }
    const entry = failedPairByIp.get(ip);
    if (!entry) return false;
    if (now - entry.start >= PER_IP_PAIR_FAIL_WINDOW_MS) { failedPairByIp.delete(ip); return false; }
    return entry.count >= MAX_FAILED_PAIR_ATTEMPTS_PER_IP;
  }

  function recordPairFailure(ip) {
    const now = Date.now();
    if (!globalPairFailures.count || now - globalPairFailures.start >= GLOBAL_PAIR_FAIL_WINDOW_MS) {
      globalPairFailures = { count: 0, start: now };
    }
    globalPairFailures.count += 1;
    let entry = failedPairByIp.get(ip);
    if (!entry || now - entry.start >= PER_IP_PAIR_FAIL_WINDOW_MS) entry = { count: 0, start: now };
    entry.count += 1;
    failedPairByIp.set(ip, entry);
    while (failedPairByIp.size > MAX_PAIR_FAIL_TRACKED_IPS) failedPairByIp.delete(failedPairByIp.keys().next().value);
  }

  function pruneSessions() {
    const now = Date.now();
    let removed = false;
    sessions.forEach((session, token) => { if (session.expiresAt <= now) { sessions.delete(token); removed = true; } });
    // Hard cap as a backstop; issueSession() makes room scope-aware first.
    while (sessions.size > MAX_SESSIONS) { sessions.delete(sessions.keys().next().value); removed = true; }
    if (removed && sessionsFile) savePersistedSessions(sessionsFile, sessions);
  }

  function issueSession(scope = 'view') {
    pruneSessions();
    // Make room by evicting the oldest session of the SAME scope, so a flood
    // of view pairings can't push out the control session an editor holds (and
    // vice versa). Map order is insertion order, oldest first.
    if (sessions.size >= MAX_SESSIONS) {
      let victim = null;
      for (const [existingToken, existing] of sessions) {
        if (existing.scope === scope) { victim = existingToken; break; }
      }
      sessions.delete(victim !== null ? victim : sessions.keys().next().value);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    sessions.set(token, { expiresAt: createdAt + ttlForScope(scope), scope, profileId: null, createdAt });
    if (sessionsFile) savePersistedSessions(sessionsFile, sessions);
    return token;
  }

  function tokenFromRequest(req) {
    const auth = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
    return parseCookies(req.headers.cookie)[cookieName] || '';
  }

  function authenticatedToken(req) {
    pruneSessions();
    const token = tokenFromRequest(req);
    return token && sessions.has(token) ? token : '';
  }

  function isAuthenticated(req) {
    return !!authenticatedToken(req);
  }

  // The scope this request's session holds, or '' when it has none. Scope lives
  // on the token, never on anything the client sends alongside it.
  function scopeOf(req) {
    const token = authenticatedToken(req);
    const session = token ? sessions.get(token) : null;
    return session ? session.scope : '';
  }

  // The household profile belongs to the authenticated device session. It is
  // deliberately server-owned like scope: a viewer cannot read another
  // profile merely by naming its id in a request body.
  function profileOf(req) {
    const token = authenticatedToken(req);
    const session = token ? sessions.get(token) : null;
    return session && typeof session.profileId === 'string' ? session.profileId : null;
  }

  function setProfile(req, profileId) {
    const token = authenticatedToken(req);
    const session = token ? sessions.get(token) : null;
    if (!session) return false;
    session.profileId = typeof profileId === 'string' ? profileId : null;
    sessions.set(token, session);
    if (sessionsFile) savePersistedSessions(sessionsFile, sessions);
    return true;
  }

  // Gate for a route that needs more than `view`. Answers 403 itself so every
  // caller refuses the same way, and says nothing about what the route does.
  function requireScope(req, res, scope) {
    if (scopeOf(req) === scope) return true;
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ error: `This device is not paired for ${scope}.` }));
    return false;
  }

  // Which scope, if any, a supplied pairing code unlocks. Compared against
  // every scope's code in constant time, so a wrong guess leaks nothing about
  // which code it was close to.
  function scopeForCode(supplied) {
    return scopes.find((scope) => safeEqual(supplied, pairingCodes[scope])) || '';
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

  function setSession(res, token, expiresAtMs) {
    // Must match issueSession()'s own expiry (sessionTtlMs, not the module
    // default) — a service that opts into a longer persisted-session TTL
    // (the LAN viewer, companion-app: 90 days) needs the cookie the browser
    // actually keeps to agree with how long the server-side session record
    // stays valid, or the persisted-pairing feature silently doesn't persist.
    const session = sessions.get(token);
    const expiresAt = Number.isFinite(expiresAtMs) ? expiresAtMs : (session ? session.expiresAt : Date.now() + sessionTtlMs);
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}; Path=/; HttpOnly; SameSite=Strict`);
    res.setHeader('Cache-Control', 'no-store');
  }

  function renewSessionIfNeeded(res, token) {
    const session = sessions.get(token);
    if (!session) return;
    const expiresAt = session.expiresAt;
    const ttl = ttlForScope(session.scope);
    // Control sessions never slide past createdAt + max age; the device
    // enters the control code again. View sessions slide as before.
    const ceiling = session.scope === 'control' ? session.createdAt + controlMaxAgeMs : Infinity;
    // Sliding renewal means a TV that is still used does not unexpectedly
    // return to the pairing screen merely because 90 days elapsed since the
    // original code entry. Refresh only in the final half of the lifetime so
    // normal media/config polling does not rewrite the sessions file.
    if (expiresAt - Date.now() > ttl / 2) return;
    const next = Math.min(Date.now() + ttl, ceiling);
    if (next <= expiresAt) return; // already at the ceiling
    // Renewal extends the session it already is; it never changes its scope.
    sessions.set(token, { expiresAt: next, scope: session.scope, profileId: session.profileId || null, createdAt: session.createdAt });
    if (sessionsFile) savePersistedSessions(sessionsFile, sessions);
    setSession(res, token, next);
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
    if (pairingLockedFor(requestIp(req))) {
      res.writeHead(423, { 'Content-Type': 'text/plain', 'Retry-After': '300' }).end('Too many failed pairing attempts. Try again in a few minutes.');
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
    const scope = supplied ? scopeForCode(supplied) : '';
    if (scope) {
      failedPairByIp.delete(requestIp(req));
      const token = issueSession(scope);
      setSession(res, token);
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, scope, expiresIn: Math.floor(ttlForScope(scope) / 1000) }));
      } else {
        res.writeHead(303, { Location: '/' }).end();
      }
      return true;
    }
    if (supplied) recordPairFailure(requestIp(req));
    if (req.method === 'GET' || (req.method === 'POST' && url.pathname === '/_pair')) {
      const message = supplied ? 'That pairing code was not accepted.' : '';
      res.writeHead(supplied ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(pairingPage(service, message));
      return true;
    }
    res.writeHead(401, { 'WWW-Authenticate': `Bearer realm="RerunTV ${service}"` }).end('Pairing required');
    return true;
  }

  // Gate for a mutating route inside the service's router: JSON body (or
  // multipart where `allowMultipart`), and an Origin that matches this host.
  // Answers 403 itself, in the same shape requireScope uses.
  function requireWriteHeaders(req, res, { allowMultipart = false } = {}) {
    const typeOk = hasJsonContentType(req) || (allowMultipart && hasMultipartContentType(req));
    if (typeOk && originMatchesHost(req)) return true;
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ error: 'Forbidden' }));
    return false;
  }

  async function authorize(req, res, url, kind = 'read') {
    // Any mutating request must come from this host's own pages or a native
    // client (no Origin header at all). This runs before pairing and session
    // checks so a cross-origin page cannot spend a pairing guess either.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !originMatchesHost(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Cross-origin requests are not allowed.');
      return false;
    }
    // Always consume the pairing form endpoint, even when this browser
    // already has a valid session. A phone can submit a cached pairing page
    // after a QR preview/prefetch established its cookie; letting that POST
    // pass into the service router makes its static-file fallback answer
    // 405 Method Not Allowed instead of completing pairing idempotently.
    if (req.method === 'POST' && url.pathname === '/_pair') {
      await handlePairing(req, res, url);
      return false;
    }
    // A device that already holds a session but is presenting a pairing code is
    // claiming a different scope — most often a viewer being handed the control
    // code. Run pairing, which mints a SEPARATE session at that code's scope.
    // The old token keeps whatever it had; nothing is widened in place.
    const token = authenticatedToken(req);
    if (!token || url.searchParams.has('pair')) {
      await handlePairing(req, res, url);
      return false;
    }
    renewSessionIfNeeded(res, token);
    return checkRateLimit(req, res, kind);
  }

  function pairingUrl(url, scope = 'view') {
    const parsed = new URL(url);
    parsed.searchParams.set('pair', pairingCodes[scope] || pairingCode);
    return parsed.toString();
  }

  return {
    service, pairingCode, pairingCodes, scopes, pairingUrl, authorize, checkRateLimit, isAuthenticated,
    scopeOf, profileOf, setProfile, requireScope, requireWriteHeaders,
    // Revocation and visibility for the host (never exposes full tokens).
    listSessions: () => {
      pruneSessions();
      return Array.from(sessions, ([token, s]) => ({
        id: sessionId(token),
        scope: s.scope, createdAt: s.createdAt, expiresAt: s.expiresAt, profileId: s.profileId || null,
      }));
    },
    revokeAll: (scope) => {
      let count = 0;
      sessions.forEach((s, token) => {
        if (!scope || s.scope === scope) { sessions.delete(token); count += 1; }
      });
      if (count && sessionsFile) savePersistedSessions(sessionsFile, sessions);
      return count;
    },
    revokeSession: (id) => {
      for (const [token] of sessions) {
        if (sessionId(token) === id) {
          sessions.delete(token);
          if (sessionsFile) savePersistedSessions(sessionsFile, sessions);
          return true;
        }
      }
      return false;
    },
    sessionCount: () => { pruneSessions(); return sessions.size; },
    sessionCounts: () => {
      pruneSessions();
      const counts = Object.fromEntries(scopes.map((scope) => [scope, 0]));
      sessions.forEach((session) => { counts[session.scope] = (counts[session.scope] || 0) + 1; });
      return counts;
    },
  };
}

module.exports = {
  createLanAccess, isLanServiceEnabled, requestIp, originMatchesHost, hasJsonContentType, hasMultipartContentType,
  CONTROL_SESSION_MAX_AGE_MS,
};
