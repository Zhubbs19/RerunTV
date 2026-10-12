// One-time config migration for plugins whose ids were renamed (the old ids
// carried third-party trademarks). Pure: takes a parsed channels.json object,
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

const RENAMED_PLUGIN_IDS = {
  'music-choice-channel': 'digital-music-channel',
  prevue: 'guide-channel',
  'theme-prevue-guide-94': 'theme-scrolling-guide-94',
};

const RENAMED_THEME_IDS = {
  'prevue-guide-94': 'scrolling-guide-94',
};

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function renameKeys(obj) {
  let changed = false;
  if (!isObject(obj)) return false;
  for (const [from, to] of Object.entries(RENAMED_PLUGIN_IDS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, from)) continue;
    // If the new id somehow already has a value, it wins; the old one is dropped.
    if (!Object.prototype.hasOwnProperty.call(obj, to)) obj[to] = obj[from];
    delete obj[from];
    changed = true;
  }
  return changed;
}

function renameThemeValues(node) {
  let changed = false;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === 'string' && RENAMED_THEME_IDS[v]) { node[i] = RENAMED_THEME_IDS[v]; changed = true; }
      else if (v && typeof v === 'object' && renameThemeValues(v)) changed = true;
    });
  } else if (isObject(node)) {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && RENAMED_THEME_IDS[v]) { node[k] = RENAMED_THEME_IDS[v]; changed = true; }
      else if (v && typeof v === 'object' && renameThemeValues(v)) changed = true;
    }
  }
  return changed;
}

function migrateRenamedPlugins(config) {
  if (!isObject(config)) return false;
  let changed = false;
  if (isObject(config.plugins)) {
    if (Array.isArray(config.plugins.disabled)) {
      const seen = new Set();
      const next = [];
      for (const id of config.plugins.disabled) {
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

module.exports = { migrateRenamedPlugins, RENAMED_PLUGIN_IDS, RENAMED_THEME_IDS };
