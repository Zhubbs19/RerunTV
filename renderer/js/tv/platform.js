// Samsung Tizen and LG webOS browsers (docs/design/01 §5.2, §5.4, §9;
// Phase E). Tizen delivers most remote buttons only after
// tizen.tvinputdevice.registerKey(name); webOS delivers its keyCodes
// (461 Back, 403–406 colour) without registration. On both, the app going
// hidden is the TV's own standby or input change, so RerunTV follows it into
// standby and back.
//
// UNVERIFIED on real hardware — written against the platform documentation
// and covered by unit tests with fake platform objects only.

// Keys worth registering: everything remote-input.js understands by name.
export const TIZEN_KEYS = [
  'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward',
  'MediaTrackPrevious', 'MediaTrackNext', 'MediaRecord',
  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
  'ChannelUp', 'ChannelDown', 'Info', 'Guide', 'Exit', 'Caption',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Minus',
];

export function detectTvPlatform(win) {
  if (win && win.tizen && win.tizen.tvinputdevice) return 'tizen';
  if (win && (win.webOS || win.PalmSystem)) return 'webos';
  return null;
}

// Registers what this TV supports of TIZEN_KEYS. Returns the names registered.
export function registerTizenKeys(tizen) {
  const device = tizen && tizen.tvinputdevice;
  if (!device) return [];
  let supported = [];
  try {
    supported = (device.getSupportedKeys() || []).map((k) => k.name);
  } catch (e) {
    supported = [];
  }
  const wanted = TIZEN_KEYS.filter((name) => supported.includes(name));
  const registered = [];
  wanted.forEach((name) => {
    try { device.registerKey(name); registered.push(name); } catch (e) { /* this TV won't give it up */ }
  });
  return registered;
}

// hooks: { standby(), wake() }
export function installTvPlatform(win, doc, hooks) {
  const platform = detectTvPlatform(win);
  if (!platform) return null;
  if (platform === 'tizen') registerTizenKeys(win.tizen);
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') hooks.standby();
    else hooks.wake();
  });
  return platform;
}
