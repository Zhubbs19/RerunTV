const path = require('path');
const crypto = require('crypto');

// Was `authorization` (the literal word) instead of `auth` — missed a key
// named plain "auth" entirely, even though it's exactly what this regex
// exists to catch. `auth` as a substring still matches "authorization" too,
// so this is strictly broader, not a behavior change for the existing case.
const SENSITIVE_CONFIG_KEY = /(?:api.?key|token|secret|password|credential|auth|^pinLock$|^pin$|pin.?code)/i;

function sanitizeViewerConfig(value) {
  if (Array.isArray(value)) return value.map(sanitizeViewerConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_CONFIG_KEY.test(key))
    .map(([key, child]) => [key, sanitizeViewerConfig(child)]));
}

// Key-name filtering above only catches a secret stored as its own
// key/value pair. A credential embedded INSIDE a string value — most
// commonly a webhook/callback URL's own query string (?token=..., ?key=...)
// — isn't a key at all, so it sails through untouched. Since this is the
// projection every paired LAN viewer receives over the network, redact any
// query parameter on a URL-shaped string value whose own name looks
// sensitive, the same way a key would be dropped.
function redactSensitiveUrlValue(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  let url;
  try { url = new URL(value); } catch (e) { return value; }
  let changed = false;
  if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
  Array.from(url.searchParams.keys()).forEach((param) => {
    if (SENSITIVE_CONFIG_KEY.test(param)) { url.searchParams.set(param, '[redacted]'); changed = true; }
  });
  return changed ? url.toString() : value;
}

function createViewerProjection(secret = crypto.randomBytes(32)) {
  const refs = new Map();
  function opaqueRef(ref) {
    const id = crypto.createHmac('sha256', secret).update(String(ref)).digest('base64url');
    refs.set(id, { ref: String(ref), name: path.basename(String(ref), path.extname(String(ref))) });
    return `viewer:${id}`;
  }
  function project(value, key = '') {
    if (Array.isArray(value)) return value.map((child) => project(child));
    if (!value || typeof value !== 'object') {
      const looksLikePathValue = typeof value === 'string'
        && (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value) || value.startsWith('mediasource:'));
      const looksLikePrivateRef = key === 'path' || key === 'ref' || key === 'file'
        || /(?:Path|File|Folder)$/.test(key) || looksLikePathValue;
      if (typeof value === 'string' && looksLikePrivateRef) return opaqueRef(value);
      return redactSensitiveUrlValue(value);
    }
    const out = {};
    Object.entries(value).forEach(([childKey, child]) => {
      if (SENSITIVE_CONFIG_KEY.test(childKey)) return;
      if (childKey === 'customCssPath') { out[childKey] = null; return; }
      out[childKey] = project(child, childKey);
    });
    if (typeof value.path === 'string' && !out.title) {
      out.title = path.basename(value.path, path.extname(value.path));
    }
    return out;
  }
  return {
    project: (config) => project(sanitizeViewerConfig(config)),
    // Registers a single ref (e.g. a mediasource: ref the host window itself
    // needs to play, not one encountered while projecting a full config) and
    // returns its opaque viewer: id, so callers outside project() can still
    // hand /media a client-suppliable id rather than a raw path/ref.
    registerRef: (ref) => opaqueRef(ref),
    resolve: (opaque) => {
      // Config values use `viewer:<id>`, while the browser shim deliberately
      // strips that marker when building /media?id=<id>. Accept both forms;
      // either way the value is only useful if it exists in this process's
      // private map, so this does not widen access to raw filesystem paths.
      const match = /^(?:viewer:)?([A-Za-z0-9_-]+)$/.exec(String(opaque || ''));
      const entry = match ? refs.get(match[1]) : null;
      return entry ? entry.ref : null;
    },
    name: (id) => {
      const entry = refs.get(String(id || '').replace(/^viewer:/, ''));
      return entry ? entry.name : '';
    },
    size: () => refs.size,
  };
}

// The commands the host applied (config-host.js's update), as published to
// control sessions on the viewer event bus. A command payload can carry a
// credential — plugin.setSettings holds a plugin's whole settings object (API
// keys included), settings.set a single value under a path — and the client's
// own config copy never had those keys (/api/control/config strips them), so
// dropping them here keeps both sides consistent. Sensitive keys are removed at
// any depth; a command addressed to a sensitive path loses its value too.
function sanitizeAppliedUpdate(update) {
  if (!update || typeof update !== 'object' || !Array.isArray(update.commands)) return update;
  const commands = update.commands.map((cmd) => {
    if (!cmd || typeof cmd !== 'object') return cmd;
    const clean = sanitizeViewerConfig(cmd);
    const addressed = []
      .concat(Array.isArray(cmd.path) ? cmd.path : [])
      .concat(typeof cmd.key === 'string' ? [cmd.key] : [])
      .concat(typeof cmd.field === 'string' ? [cmd.field] : []);
    if (addressed.some((segment) => typeof segment === 'string' && SENSITIVE_CONFIG_KEY.test(segment))) {
      delete clean.value;
      delete clean.settings;
    }
    return clean;
  });
  return { ...update, commands };
}

module.exports = { sanitizeViewerConfig, sanitizeAppliedUpdate, createViewerProjection };
