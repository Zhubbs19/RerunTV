// Shared LAN-service authentication and abuse controls.
//
// LAN pages are deliberately simple, dependency-free HTTP servers, but they
// are no longer ambiently trusted just because a request came from a private
// address. Each enabled service gets a process-lifetime pairing code. Opening
// the pairing URL exchanges that code for a random HttpOnly session cookie;
// subsequent static/API/media requests must carry that cookie (or the same
// token as an Authorization: Bearer value for native companion clients).
const crypto = require('crypto');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const WINDOW_MS = 60 * 1000;

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
  const note = message ? `<p role="alert">${message}</p>` : '<p>Enter the pairing code shown by RerunTV on the host.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;background:#171a3b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}main{width:min(360px,calc(100% - 40px));background:#292f6b;padding:28px;border-radius:16px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin-top:12px}input{letter-spacing:.25em;text-align:center}button{background:#f0b429;border:0;font-weight:700}p{line-height:1.45}</style></head><body><main><h1>${title}</h1>${note}<form method="post" action="/_pair"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required aria-label="Pairing code"><button type="submit">PAIR DEVICE</button></form></main></body></html>`;
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
  const sessions = new Map(); // token -> expiresAt
  const rateWindows = new Map(); // `${kind}:${ip}` -> {start, count}
  const readLimit = opts.readLimit || 600;
  const writeLimit = opts.writeLimit || 90;

  function pruneSessions() {
    const now = Date.now();
    sessions.forEach((expiresAt, token) => { if (expiresAt <= now) sessions.delete(token); });
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function issueSession() {
    pruneSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
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

  function checkRateLimit(req, res, kind = 'read') {
    const key = `${kind}:${requestIp(req)}`;
    const now = Date.now();
    let state = rateWindows.get(key);
    if (!state || now - state.start >= WINDOW_MS) state = { start: now, count: 0 };
    state.count += 1;
    rateWindows.set(key, state);
    const limit = kind === 'write' ? writeLimit : readLimit;
    if (state.count <= limit) return true;
    res.writeHead(429, { 'Retry-After': String(Math.ceil((WINDOW_MS - (now - state.start)) / 1000)) }).end('Too many requests');
    return false;
  }

  function setSession(res, token) {
    res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Strict`);
    res.setHeader('Cache-Control', 'no-store');
  }

  async function handlePairing(req, res, url) {
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
      const token = issueSession();
      setSession(res, token);
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, expiresIn: SESSION_TTL_MS / 1000 }));
      } else {
        res.writeHead(303, { Location: '/' }).end();
      }
      return true;
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
