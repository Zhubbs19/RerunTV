// Defaults for settings added in the 2026-10 passes, written into the config
// at boot so every one of them exists as a real key. Their behaviour with the
// key absent was already these same values, so nothing changes for the box
// itself; what it buys is that the Companion app's Settings tab (which edits
// the keys it finds in the config and never creates one) can see and change
// them. "Reset this panel" sets these values back rather than deleting keys,
// for the same reason.
//
// Pure (no DOM), so it is tested.

export const NEW_SETTING_DEFAULTS = [
  [['controls', 'startupChannel'], 'last'],
  [['controls', 'entryDelayMs'], 800],
  [['controls', 'scanDwellSec'], 8],
  [['controls', 'sleepSteps'], [30, 60, 90, 120]],
  [['controls', 'volumeStepPct'], 10],
  [['controls', 'volumeMaxPct'], 100],
  [['controls', 'rememberChannelVolume'], false],
  [['controls', 'tuneFadeInMs'], 0],
  [['controls', 'sleepFadeOut'], true],
  [['display', 'guideSlotMinutes'], 30],
  [['display', 'autoFillWidescreen'], false],
  [['display', 'autoFillMaxCropPct'], 30],
  [['display', 'removeBakedBars'], false],
  [['display', 'logoBugFollowPicture'], true],
  [['display', 'logoBugHideOnBreaks'], false],
  [['display', 'logoBugHideNumber'], false],
  [['display', 'logoBugVaryWithContent'], false],
  [['timeMachine', 'showTimeShiftBadge'], true],
  // The three no-repeat switches started life as one, noRepeatInBreak.
  [['commercials', 'noRepeatCommercials'], (config) => !!(config.commercials && config.commercials.noRepeatInBreak)],
  [['commercials', 'noRepeatBumpers'], (config) => !!(config.commercials && config.commercials.noRepeatInBreak)],
  [['commercials', 'noRepeatInterstitials'], (config) => !!(config.commercials && config.commercials.noRepeatInBreak)],
];

const clone = (value) => JSON.parse(JSON.stringify(value));

// The default for a settings path, or undefined when the setting has none
// (the caller then deletes the key, as it always did).
export function defaultForPath(path, config = {}) {
  const hit = NEW_SETTING_DEFAULTS.find(([p]) => p.length === path.length && p.every((key, i) => key === path[i]));
  if (!hit) return undefined;
  return typeof hit[1] === 'function' ? hit[1](config) : clone(hit[1]);
}

// Adds whichever of the defaults are missing, leaving every set value alone.
// Returns how many it added.
export function fillNewSettingDefaults(config) {
  let added = 0;
  NEW_SETTING_DEFAULTS.forEach(([path]) => {
    let node = config;
    for (let i = 0; i < path.length - 1; i += 1) {
      if (node[path[i]] == null || typeof node[path[i]] !== 'object') node[path[i]] = {};
      node = node[path[i]];
    }
    const key = path[path.length - 1];
    if (node[key] === undefined) {
      node[key] = defaultForPath(path, config);
      added += 1;
    }
  });
  return added;
}
