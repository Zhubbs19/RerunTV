const path = require('path');
const crypto = require('crypto');

const SENSITIVE_CONFIG_KEY = /(?:api.?key|token|secret|password|credential|authorization)/i;

function sanitizeViewerConfig(value) {
  if (Array.isArray(value)) return value.map(sanitizeViewerConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_CONFIG_KEY.test(key))
    .map(([key, child]) => [key, sanitizeViewerConfig(child)]));
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
      return value;
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
    resolve: (opaque) => {
      const match = /^viewer:([A-Za-z0-9_-]+)$/.exec(String(opaque || ''));
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

module.exports = { sanitizeViewerConfig, createViewerProjection };
