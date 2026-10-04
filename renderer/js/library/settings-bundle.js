// Portable "settings only" bundles: the box's look, controls and options
// without its channels, interstitial pool or watching history, so a second
// machine (an HTPC, a laptop) can take the same setup without the lineup.
// The list is explicit: a key that isn't named here never leaves the box, and
// an imported file can only ever write the keys named here.
// Kept free of imports so it loads anywhere (the tests load it bare).
const clone = (value) => JSON.parse(JSON.stringify(value));

export const SETTINGS_BUNDLE_KEYS = [
  'display', 'crtEnabled', 'crtIntensity', 'staticEffect', 'theme', 'pictureMode', 'aspectMode', 'displayMode',
  'contentVolume', 'adVolume', 'audioLeveler', 'upNext', 'details', 'timeMachine', 'stationId', 'trivia',
  'commercials', 'autoStandby', 'keepDisplayAwake', 'playbackResync', 'controls', 'closedCaptions', 'ticker',
  'screensaver', 'weather', 'sapAudio', 'reminderAutoTune', 'reminderNotify', 'reminderLeadMinutes',
  'subChannels', 'updates',
];

// Per-install values inside those sections that describe this machine rather
// than the setup, so they stay behind.
const MACHINE_FIELDS = { display: ['logoBugAuthoredHeight'] };

export function buildSettingsBundle(config, now = new Date()) {
  const settings = {};
  SETTINGS_BUNDLE_KEYS.forEach((key) => {
    if (config && config[key] !== undefined) settings[key] = clone(config[key]);
  });
  Object.entries(MACHINE_FIELDS).forEach(([section, fields]) => {
    if (settings[section]) fields.forEach((field) => { delete settings[section][field]; });
  });
  return { kind: 'reruntv-settings', version: 1, exportedAt: now.toISOString(), settings };
}

// The keys of a bundle that may be applied, or null when the file isn't one.
export function readSettingsBundle(imported) {
  if (!imported || imported.kind !== 'reruntv-settings' || !imported.settings || typeof imported.settings !== 'object') return null;
  const settings = {};
  SETTINGS_BUNDLE_KEYS.forEach((key) => {
    if (imported.settings[key] !== undefined) settings[key] = clone(imported.settings[key]);
  });
  return Object.keys(settings).length ? settings : null;
}

// Writes the bundle's sections over `config` in place, keeping this machine's
// own fields. Returns the keys written.
export function applySettingsBundle(config, settings) {
  const written = [];
  Object.entries(settings).forEach(([key, value]) => {
    const keep = {};
    (MACHINE_FIELDS[key] || []).forEach((field) => {
      if (config[key] && config[key][field] !== undefined) keep[field] = config[key][field];
    });
    config[key] = Object.keys(keep).length && value && typeof value === 'object' ? { ...value, ...keep } : value;
    written.push(key);
  });
  return written;
}
