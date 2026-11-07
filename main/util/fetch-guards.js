// Small, Electron-free guards for the outbound requests plugins can make on
// their own behalf (api-cache.js's fetchJsonCached) and the URLs they may ask
// the host to open. Kept apart from api-cache.js so they can be unit-tested
// without Electron.

// Headers that carry credentials. They are dropped when a redirect leaves the
// origin they were meant for, so a public endpoint that bounces to a different
// host cannot harvest a plugin's API key or token.
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-auth-token']);

/**
 * A copy of `headers` without the credential headers in `CREDENTIAL_HEADERS`.
 * Accepts the same shapes fetch does and returns the same shape it was given.
 * @param {Headers|Array<Array<string>>|object} headers The request headers.
 * @returns {Headers|Array<Array<string>>|object} The filtered headers.
 */
function stripCredentialHeaders(headers) {
  if (!headers) return headers;
  const keep = (name) => !CREDENTIAL_HEADERS.has(String(name).toLowerCase());
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out = new Headers();
    headers.forEach((value, name) => { if (keep(name)) out.append(name, value); });
    return out;
  }
  if (Array.isArray(headers)) return headers.filter(([name]) => keep(name));
  if (typeof headers === 'object') {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => keep(name)));
  }
  return headers;
}

/**
 * The request options for the next redirect hop: same options, minus credential
 * headers when the origin changed.
 * @param {object} opts The request options.
 * @param {string} fromUrl The URL that redirected.
 * @param {string} toUrl The redirect target.
 * @returns {object} The options to use for the next hop.
 */
function optionsForRedirect(opts, fromUrl, toUrl) {
  let sameOrigin;
  try { sameOrigin = new URL(fromUrl).origin === new URL(toUrl).origin; } catch (e) { sameOrigin = false; }
  if (sameOrigin || !opts || !opts.headers) return opts;
  return { ...opts, headers: stripCredentialHeaders(opts.headers) };
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Reads a fetch Response body as text, refusing more than `limit` bytes. A
 * Content-Length over the limit is refused before reading anything.
 * @param {Response} res The fetch response.
 * @param {number} [limit=MAX_RESPONSE_BYTES] Maximum body size in bytes.
 * @returns {Promise<string>} The body text.
 * @throws {Error} When the body is larger than `limit`.
 */
async function readBodyTextLimited(res, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`response too large (${declared} bytes)`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > limit) throw new Error('response too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      throw new Error(`response too large (over ${limit} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The only URL schemes a plugin may hand to shell.openExternal: a web page or a
 * mail composer. file:, smb:, custom protocol handlers and javascript: can run
 * local programs or leak credentials.
 * @param {*} value The URL to check.
 * @returns {boolean} Whether it may be opened externally.
 */
function isAllowedExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  let parsed;
  try { parsed = new URL(value); } catch (e) { return false; }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
}

module.exports = {
  stripCredentialHeaders, optionsForRedirect, readBodyTextLimited, isAllowedExternalUrl,
  CREDENTIAL_HEADERS, MAX_RESPONSE_BYTES,
};
