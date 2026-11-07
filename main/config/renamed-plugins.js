// One-time config migration for plugins whose ids were renamed (the old ids
// carried third-party trademarks) and theme packs that were removed. Pure: takes a parsed channels.json object,
// moves everything keyed by an old id to the new id, and returns whether it
// changed anything. loadConfig() calls it on every load; it is idempotent.
//
// What is keyed by plugin id in config:
//   plugins.disabled[]               ids of switched-off plugins
//   plugins.approvedCapabilities{}   id -> approved capability signature
//   pluginSettings{} / pluginSettingsMeta{}   id -> settings / version stamp
// Theme packs also register a theme id that is stored as config.theme (and in
// era snapshots), so renamed theme ids are rewritten wherever they appear as a
// string value.

// Old plugin id to new plugin id.
const RENAMED_PLUGIN_IDS = {
  'music-choice-channel': 'digital-music-channel',
  prevue: 'guide-channel',
  'theme-prevue-guide-94': 'theme-scrolling-guide-94',
};

// Old theme id to new theme id, for the renamed theme packs above.
const RENAMED_THEME_IDS = {
  'prevue-guide-94': 'scrolling-guide-94',
};

// Theme packs removed in 2026-11 (old guide grids the cable-guide layout
// covers, near-duplicates, and looks not tied to a TV box). Each maps to the
// kept pack closest to it, so a box, era snapshot or profile that used one
// keeps a look of the same kind instead of core's bare default palette. The
// pack's own plugin-keyed config is dropped.
const RETIRED_THEME_IDS = {
  'addressable-converter-89': 'scrolling-guide-94',
  'hotel-headend-92': 'scrolling-guide-94',
  'passport-03': 'cable-guide-classic-05',
  'dual-tuner-dvr-05': 'cable-guide-classic-05',
  'aqua-grid-06': 'cable-guide-classic-05',
  'slate-grid-10': 'cable-guide-hd-15',
  'dark-grid-12': 'cable-guide-hd-15',
  'widescreen-grid-13': 'cable-guide-hd-15',
  'cyberpunk-synth': 'outrun-synthwave',
  'ops-dashboard': 'master-control',
  'emerald-matrix': 'cable-guide-hd-15',
  'midnight-oled': 'cable-guide-hd-15',
  'neo-brutalist': 'cable-guide-hd-15',
  'frutiger-aero': 'cable-guide-hd-15',
};
// Plugin ids of the retired theme packs; their plugin-keyed config is dropped.
const RETIRED_PLUGIN_IDS = new Set(Object.keys(RETIRED_THEME_IDS).map((id) => `theme-${id}`));

// Every old theme id (renamed or retired) to the id that replaces it.
const THEME_ID_MAP = { ...RENAMED_THEME_IDS, ...RETIRED_THEME_IDS };

/**
 * The theme id to use for a stored one (config, era snapshot, profile).
 * @param {string} id A stored theme id.
 * @returns {string} The replacement id, or `id` unchanged.
 */
function currentThemeId(id) {
  return THEME_ID_MAP[id] || id;
}

/**
 * Whether a value is a plain (non-array) object.
 * @param {*} v The value.
 * @returns {boolean} True for a non-null, non-array object.
 */
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Drops retired plugin ids and moves renamed ones to their new id in an object keyed by plugin id. Mutates `obj` in place.
 * @param {?object} obj An id-keyed object such as `pluginSettings`.
 * @returns {boolean} True when anything changed.
 */
function renameKeys(obj) {
  let changed = false;
  if (!isObject(obj)) return false;
  for (const id of RETIRED_PLUGIN_IDS) {
    if (!Object.prototype.hasOwnProperty.call(obj, id)) continue;
    delete obj[id];
    changed = true;
  }
  for (const [from, to] of Object.entries(RENAMED_PLUGIN_IDS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, from)) continue;
    // If the new id somehow already has a value, it wins; the old one is dropped.
    if (!Object.prototype.hasOwnProperty.call(obj, to)) obj[to] = obj[from];
    delete obj[from];
    changed = true;
  }
  return changed;
}

/**
 * Rewrites old theme ids found as string values anywhere in a tree. Mutates in place.
 * @param {object|Array} node The tree to walk.
 * @returns {boolean} True when anything changed.
 */
function renameThemeValues(node) {
  let changed = false;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === 'string' && THEME_ID_MAP[v]) { node[i] = THEME_ID_MAP[v]; changed = true; }
      else if (v && typeof v === 'object' && renameThemeValues(v)) changed = true;
    });
  } else if (isObject(node)) {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && THEME_ID_MAP[v]) { node[k] = THEME_ID_MAP[v]; changed = true; }
      else if (v && typeof v === 'object' && renameThemeValues(v)) changed = true;
    }
  }
  return changed;
}

/**
 * Carries renamed plugins' config over to their new ids and drops retired theme packs. Mutates `config` in place; idempotent.
 * @param {object} config The parsed channels.json object.
 * @returns {boolean} True when anything changed.
 */
function migrateRenamedPlugins(config) {
  if (!isObject(config)) return false;
  let changed = false;
  if (isObject(config.plugins)) {
    if (Array.isArray(config.plugins.disabled)) {
      const seen = new Set();
      const next = [];
      for (const id of config.plugins.disabled) {
        if (RETIRED_PLUGIN_IDS.has(id)) { changed = true; continue; }
        const mapped = RENAMED_PLUGIN_IDS[id] || id;
        if (mapped !== id) changed = true;
        if (!seen.has(mapped)) { seen.add(mapped); next.push(mapped); } else changed = true;
      }
      if (changed) config.plugins.disabled = next;
    }
    if (renameKeys(config.plugins.approvedCapabilities)) changed = true;
  }
  if (renameKeys(config.pluginSettings)) changed = true;
  if (renameKeys(config.pluginSettingsMeta)) changed = true;
  if (renameThemeValues(config)) changed = true;
  return changed;
}

module.exports = { migrateRenamedPlugins, currentThemeId, RENAMED_PLUGIN_IDS, RENAMED_THEME_IDS, RETIRED_THEME_IDS };
