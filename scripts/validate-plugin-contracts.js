#!/usr/bin/env node
// Sandboxable, CI-runnable checks with no Electron/display dependency:
//
//   1. Every plugins/*/manifest.json has the shape PLUGIN_DEVELOPMENT.md
//      documents (required `id`, correct types on every optional field,
//      well-formed `capabilities` entries).
//   2. renderer/js/api-contract.js's method list stays in sync with the
//      real preload surface (main/preload.js) — this is the check
//      test/contracts.test.js used to run before that suite (and
//      package.json's "test" script that pointed at it) was deleted; see
//      CLAUDE.md's "Working conventions" section for why it hasn't been
//      resurrected wholesale. This script only reconstructs the one check
//      that's genuinely runnable without Electron.
//
// Usage: node scripts/validate-plugin-contracts.js
// Exits non-zero (and prints every problem found) on any failure.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const errors = [];

// ---------- manifest.json validation ----------

const CATEGORY_VALUES = new Set(['channel', 'theme', 'onscreen', 'system']);
const ID_RE = /^[a-z][a-z0-9-]*$/;
const netPortOwners = new Map([
  [8724, 'core LAN viewer'],
  [41234, 'core LAN discovery'],
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateCapabilityEntry(list, entry, tag, requiredKey, requiredKeyType) {
  entry.forEach((item, i) => {
    const where = `capabilities.${tag}[${i}]`;
    if (!isPlainObject(item)) { errors.push(`${where}: expected an object`); return; }
    if (typeof item.why !== 'string' || !item.why.trim()) errors.push(`${where}: missing required "why" string`);
    if (requiredKey && typeof item[requiredKey] !== requiredKeyType) {
      errors.push(`${where}: missing required "${requiredKey}" (${requiredKeyType})`);
    }
  });
}

function validateCapabilities(caps, pluginTag) {
  if (caps === undefined) return;
  if (!isPlainObject(caps)) { errors.push(`${pluginTag}: "capabilities" must be an object`); return; }
  const known = ['ipc', 'spawn', 'net', 'mediaSource', 'system'];
  Object.keys(caps).forEach((k) => {
    if (!known.includes(k)) errors.push(`${pluginTag}: unknown capabilities key "${k}"`);
  });
  ['ipc', 'spawn', 'net', 'mediaSource', 'system'].forEach((key) => {
    if (caps[key] === undefined) return;
    if (!Array.isArray(caps[key])) { errors.push(`${pluginTag}: capabilities.${key} must be an array`); return; }
    if (key === 'ipc') validateCapabilityEntry(caps, caps[key], key, 'channel', 'string');
    if (key === 'spawn') validateCapabilityEntry(caps, caps[key], key, 'bin', 'string');
    if (key === 'net') validateCapabilityEntry(caps, caps[key], key, 'port', 'number');
    if (key === 'mediaSource') validateCapabilityEntry(caps, caps[key], key, 'providerId', 'string');
    if (key === 'system') validateCapabilityEntry(caps, caps[key], key, 'action', 'string');
  });
}

function validateManifest(dir, manifestPath) {
  const tag = `plugins/${dir}/manifest.json`;
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    errors.push(`${tag}: could not read file (${e.message})`);
    return;
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    errors.push(`${tag}: invalid JSON (${e.message})`);
    return;
  }
  if (!isPlainObject(m)) { errors.push(`${tag}: must be a JSON object`); return; }

  if (typeof m.id !== 'string' || !m.id) errors.push(`${tag}: missing required "id" string`);
  else if (!ID_RE.test(m.id)) errors.push(`${tag}: "id" (${JSON.stringify(m.id)}) should be lowercase-hyphenated, matching ${ID_RE}`);
  else if (m.id !== dir) errors.push(`${tag}: "id" (${JSON.stringify(m.id)}) doesn't match its folder name (${JSON.stringify(dir)})`);

  ['name', 'version', 'description', 'style', 'renderer', 'settings', 'main', 'dataDir', 'userPaths'].forEach((field) => {
    if (m[field] !== undefined && typeof m[field] !== 'string') errors.push(`${tag}: "${field}" must be a string if present`);
  });
  if (m.category !== undefined && !CATEGORY_VALUES.has(m.category)) {
    // Non-fatal per PLUGIN_DEVELOPMENT.md ("omit or use anything else and
    // your plugin just lands in an OTHER tab, nothing breaks") — still worth
    // flagging as a likely typo rather than a silent OTHER-tab landing.
    errors.push(`${tag}: "category" ${JSON.stringify(m.category)} isn't one of ${[...CATEGORY_VALUES].join(', ')} (plugin will just land in OTHER — probably not intended)`);
  }
  if (m.dependsOn !== undefined) {
    if (!Array.isArray(m.dependsOn) || m.dependsOn.some((d) => typeof d !== 'string')) {
      errors.push(`${tag}: "dependsOn" must be an array of plugin-id strings`);
    }
  }
  if (m.isolated !== undefined && typeof m.isolated !== 'boolean') errors.push(`${tag}: "isolated" must be a boolean`);
  if (m.userPaths !== undefined && !m.dataDir) {
    errors.push(`${tag}: "userPaths" needs a "dataDir" too — it widens where a plugin may write, it doesn't replace having somewhere of its own`);
  }
  if (m.minCtxVersion !== undefined && !Number.isInteger(m.minCtxVersion)) errors.push(`${tag}: "minCtxVersion" must be an integer`);
  validateCapabilities(m.capabilities, tag);
  for (const entry of m.capabilities?.net || []) {
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
      errors.push(`${tag}: capabilities.net port ${JSON.stringify(entry.port)} must be an integer from 1 to 65535`);
      continue;
    }
    const owner = netPortOwners.get(entry.port);
    if (owner && owner !== m.id) {
      errors.push(`${tag}: capabilities.net port ${entry.port} is already owned by ${owner}`);
    } else {
      netPortOwners.set(entry.port, m.id);
    }
  }
  if (!m.style && !m.renderer && !m.settings && !m.main) {
    errors.push(`${tag}: none of style/renderer/settings/main is set — this plugin does nothing`);
  }
}

function validateAllManifests() {
  const pluginsDir = path.join(ROOT, 'plugins');
  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    errors.push(`could not read plugins/ directory (${e.message})`);
    return;
  }
  entries.forEach((entry) => {
    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) { errors.push(`plugins/${entry.name}: missing manifest.json`); return; }
    validateManifest(entry.name, manifestPath);
  });
}

// ---------- api-contract.js <-> preload.js parity ----------

function extractPreloadMethodNames(preloadSource) {
  // Every top-level property of the object passed to
  // contextBridge.exposeInMainWorld('api', {...}) is a single-line
  // `  name: (...) => ...` entry (verified against the real file — see
  // main/preload.js) — a lightweight line regex is enough without a real
  // JS parser, and avoids adding a parser dependency for one script.
  const names = [];
  const re = /^ {2}([A-Za-z][A-Za-z0-9]*):\s*\(/gm;
  let match = re.exec(preloadSource);
  while (match) {
    names.push(match[1]);
    match = re.exec(preloadSource);
  }
  return names;
}

function validateApiContractParity() {
  const preloadPath = path.join(ROOT, 'main', 'preload.js');
  const contractPath = path.join(ROOT, 'renderer', 'js', 'api-contract.js');
  let preloadSource;
  try {
    preloadSource = fs.readFileSync(preloadPath, 'utf-8');
  } catch (e) {
    errors.push(`could not read main/preload.js (${e.message})`);
    return;
  }
  const preloadMethods = new Set(extractPreloadMethodNames(preloadSource));
  if (preloadMethods.size === 0) {
    errors.push('main/preload.js: extracted zero method names — the extraction regex likely needs updating to match the file\'s current style');
    return;
  }

  let contract;
  try {
    // api-contract.js supports being require()'d directly (see its own
    // `if (typeof module !== 'undefined' && module.exports)` branch).
    delete require.cache[require.resolve(contractPath)];
    contract = require(contractPath);
  } catch (e) {
    errors.push(`could not load renderer/js/api-contract.js (${e.message})`);
    return;
  }
  const contractMethods = new Set(Object.keys(contract.methods || {}));

  const missingFromContract = [...preloadMethods].filter((m) => !contractMethods.has(m)).sort();
  const staleInContract = [...contractMethods].filter((m) => !preloadMethods.has(m)).sort();

  if (missingFromContract.length) {
    errors.push(`renderer/js/api-contract.js is missing ${missingFromContract.length} method(s) that main/preload.js actually exposes: ${missingFromContract.join(', ')}`);
  }
  if (staleInContract.length) {
    errors.push(`renderer/js/api-contract.js lists ${staleInContract.length} method(s) that main/preload.js no longer exposes: ${staleInContract.join(', ')}`);
  }
}

// ---------- run ----------

validateAllManifests();
validateApiContractParity();

if (errors.length) {
  console.error(`\n${errors.length} problem(s) found:\n`);
  errors.forEach((e) => console.error(`  - ${e}`));
  console.error('');
  process.exit(1);
} else {
  console.log('All plugin manifests and the api-contract/preload surface check out.');
}
