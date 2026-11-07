// Setting defaults written into the config at boot, so every one of them
// exists as a real key. Their behaviour with the key absent was already these
// same values, so nothing changes for the box itself; what it buys is that the
// Companion app's Settings tab (which edits the keys it finds in the config and
// never creates one) can see and change them. "Reset this panel" sets these
// values back rather than deleting keys, for the same reason.
//
// The list is the settings registry's `fill` entries (core/settings-registry.js),
// plus the three no-repeat switches, which take their default from the single
// noRepeatInBreak switch they replaced.
//
// Pure (no DOM), so it is tested.
import { registryDefaultForPath, registryDefaults } from './settings-registry.js';

const NO_REPEAT_KEYS = ['noRepeatCommercials', 'noRepeatBumpers', 'noRepeatInterstitials'];
/**
 * The default for each no-repeat switch: the old single noRepeatInBreak switch's value.
 * @param {object} config The app config.
 * @returns {boolean} True when noRepeatInBreak was on.
 */
const fromNoRepeatInBreak = (config) => !!(config.commercials && config.commercials.noRepeatInBreak);

export const NEW_SETTING_DEFAULTS = [
  ...registryDefaults().filter(([path]) => !(path[0] === 'commercials' && NO_REPEAT_KEYS.includes(path[1]))),
  ...NO_REPEAT_KEYS.map((key) => [['commercials', key], fromNoRepeatInBreak]),
];

/**
 * Deep-copies a JSON-safe default value.
 * @param {*} value The value.
 * @returns {*} The copy.
 */
const clone = (value) => (value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);

/**
 * The default for a settings path (for "reset" and the registry rows), or
 * undefined when the setting has none (the caller then deletes the key, as it
 * always did).
 * @param {string[]} path The settings path, e.g. `['controls', 'startupChannel']`.
 * @param {object} [config={}] The app config, for defaults derived from other settings.
 * @returns {*} The default value, or undefined.
 */
export function defaultForPath(path, config = {}) {
  const hit = NEW_SETTING_DEFAULTS.find(([p]) => p.length === path.length && p.every((key, i) => key === path[i]));
  if (hit) return typeof hit[1] === 'function' ? hit[1](config) : clone(hit[1]);
  return registryDefaultForPath(path);
}

/**
 * Adds whichever of the defaults are missing, leaving every set value alone.
 * Returns how many it added.
 * @param {object} config The app config; changed in place.
 * @returns {number} How many defaults were added.
 */
export function fillNewSettingDefaults(config) {
  let added = 0;
  NEW_SETTING_DEFAULTS.forEach(([path, value]) => {
    let node = config;
    for (let i = 0; i < path.length - 1; i += 1) {
      if (node[path[i]] == null || typeof node[path[i]] !== 'object') node[path[i]] = {};
      node = node[path[i]];
    }
    const key = path[path.length - 1];
    if (node[key] === undefined) {
      node[key] = typeof value === 'function' ? value(config) : clone(value);
      added += 1;
    }
  });
  return added;
}
