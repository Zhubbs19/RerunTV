// SAP / alternate audio track switching. No metadata about WHAT a second
// track actually is (language, descriptive audio, etc.) exists anywhere in
// this app - no ffprobe binary is bundled, and HTMLMediaElement.audioTracks
// only ever tells you a track exists, not what it's for - so this is
// deliberately the smallest honest slice: detect real multi-track files via
// the player's own native AudioTrackList at playback time (not a pre-scan
// guess), and let the user cycle through them by number ("AUDIO 1"/"AUDIO
// 2"), same "never invent data we don't have" rule closed-captions already
// follows for caption text.
const { S, player } = window.RCBPlugins.ctx;

const toastEl = document.createElement('div');
toastEl.className = 'sap-toast hidden';
document.querySelector('.crt').appendChild(toastEl);
let toastTimer = null;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2000);
}

// player.audioTracks (Chromium's native AudioTrackList) only reliably
// reflects a file's real track count once enough of it has loaded to
// demux - not guaranteed the instant 'loadedmetadata' fires, so this also
// listens for 'addtrack' to catch tracks Chromium discovers a beat later.
// Independent of core's own S.metaHandler slot (playback.js) - a plain
// addEventListener here never conflicts with it.
function currentTrackIndex() {
  const tracks = player.audioTracks;
  if (!tracks) return -1;
  for (let i = 0; i < tracks.length; i++) if (tracks[i].enabled) return i;
  return -1;
}

function cycleAudioTrack() {
  const tracks = player.audioTracks;
  // Unlike captions (hidden entirely when a file has none), the hint-bar
  // item for this has no per-file "is this even relevant" visibility today
  // (applyHintBarState, power.js, only knows "installed or not") - so most
  // presses of U land on an ordinary single-track file. Say so plainly
  // rather than doing nothing silently.
  if (!tracks || tracks.length < 2) { showToast('ONLY ONE AUDIO TRACK ON THIS FILE'); return; }
  const from = currentTrackIndex();
  const to = (from + 1) % tracks.length;
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === to;
  showToast(`AUDIO ${to + 1} / ${tracks.length}`);
}

// Re-evaluated on every real content start (registerCoreHook, plugins.js) -
// hides the toast/resets nothing else, since the hint-bar item's own
// visibility already only ever depends on the registered interrupt existing
// (applyHintBarState, power.js), not any per-file state this plugin tracks.
// The track to start on (SETTINGS › Plug-ins › SAP / Alternate Audio). Only
// the number is known, never the language, so this is "track 2" and not
// "Spanish". A file with fewer tracks than that plays on its first.
function applyDefaultTrack() {
  const cfg = S.config.sapAudio || {};
  const want = (Number(cfg.defaultTrack) || 1) - 1;
  const tracks = player.audioTracks;
  if (want < 1 || !tracks || tracks.length <= want) return;
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === want;
}

window.RCBPlugins.registerCoreHook('content-playing', () => {
  toastEl.classList.add('hidden');
  // Chromium may not list every track until a moment after the file starts.
  [0, 400, 1500].forEach((ms) => setTimeout(applyDefaultTrack, ms));
});

window.RCBPlugins.registerInterrupt('sap-audio', {
  label: 'AUDIO TRACK', hintKey: 'sap-audio', hotkey: 'u',
  run: cycleAudioTrack,
  // No cancel/scheduleNext - this is a plain toggle disguised as an
  // interrupt, same as closed-captions' own registerInterrupt usage (see
  // that plugin's comment for why: registerInterrupt is the one existing
  // extension point that already wires a hotkey + hint-bar item + TV-menu
  // button, and this app has no separate "plain toggle" registry yet).
});
