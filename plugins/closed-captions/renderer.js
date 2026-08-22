// Closed captions — attaches a native <track kind="subtitles"> to the shared
// #player element whenever real content starts (registerCoreHook,
// plugins.js's 'content-playing' event), sourced from whatever
// plugins/closed-captions/main.js found (a sidecar file or an embedded
// container stream). Deliberately never invents caption text — a file with
// neither source just plays without captions, same honesty rule this app
// already applies to SAP/closed-caption-adjacent features.
const { S, player, saveConfigDebounced } = window.RCBPlugins.ctx;

function cfg() {
  // Lazily defaulted, not core-migrated — this key is entirely owned by this
  // plugin (same pattern other optional-config plugins use for their own
  // S.config.<pluginKey>), so an absent key just reads as "off" rather
  // than needing a core applyConfigDefaults change for an optional plugin.
  if (!S.config.closedCaptions) S.config.closedCaptions = { enabled: false };
  return S.config.closedCaptions;
}

let activeTrackEl = null;

function clearActiveTrack() {
  if (activeTrackEl) {
    activeTrackEl.remove();
    activeTrackEl = null;
  }
}

// Prefers a sidecar file (an intentional, purpose-made caption file) over an
// embedded stream, and among embedded streams prefers one already tagged
// 'eng' if present — otherwise just the first one found.
function pickTrack(tracks) {
  const sidecar = tracks.find((t) => t.type === 'sidecar');
  if (sidecar) return sidecar;
  const english = tracks.find((t) => t.type === 'embedded' && t.lang === 'eng');
  return english || tracks[0];
}

async function onContentPlaying({ file, ch }) {
  clearActiveTrack();
  if (!cfg().enabled || !file || !file.path) return;
  const chNumber = ch.number;

  let scan;
  try {
    scan = await window.api.captionsScanForFile(file.path);
  } catch (e) {
    return;
  }
  if (S.currentNumber !== chNumber) return; // tuned away mid-scan
  const tracks = (scan && scan.tracks) || [];
  if (!tracks.length) return;

  const track = pickTrack(tracks);
  let extracted;
  try {
    extracted = await window.api.captionsExtractTrack({ filePath: file.path, track });
  } catch (e) {
    return;
  }
  if (S.currentNumber !== chNumber) return; // tuned away mid-extract
  if (!extracted || extracted.error || !extracted.url) return;

  const trackEl = document.createElement('track');
  trackEl.kind = 'subtitles';
  trackEl.src = extracted.url;
  trackEl.srclang = track.lang || 'en';
  trackEl.addEventListener('load', () => {
    if (trackEl.track) trackEl.track.mode = 'showing';
  });
  player.appendChild(trackEl);
  activeTrackEl = trackEl;
}

window.RCBPlugins.registerCoreHook('content-playing', onContentPlaying);
window.RCBPlugins.registerCoreHook('power-off', clearActiveTrack);

// Era-appropriate cue styling — reuses the theme-switch hook every theme
// pack's own audio texture already listens on (themes.js fires this on
// every switch) rather than adding a second theme-change event just for
// this. A theme pack with no captionStyle field (registerThemePack,
// plugins.js) falls back to a plain readable default below.
const DEFAULT_CAPTION_STYLE = {
  background: 'rgba(0, 0, 0, 0.75)',
  color: '#ffffff',
  fontFamily: 'inherit',
  fontSize: '1em',
  textTransform: 'none',
  padding: '0.1em 0.3em',
  textShadow: 'none',
};

function applyCaptionStyle() {
  const pack = window.RCBPlugins.getThemePack ? window.RCBPlugins.getThemePack(S.config.theme) : null;
  const style = (pack && pack.captionStyle) || DEFAULT_CAPTION_STYLE;
  let styleEl = document.getElementById('cc-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'cc-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    #player::cue {
      background: ${style.background || DEFAULT_CAPTION_STYLE.background};
      color: ${style.color || DEFAULT_CAPTION_STYLE.color};
      font-family: ${style.fontFamily || DEFAULT_CAPTION_STYLE.fontFamily};
      font-size: ${style.fontSize || DEFAULT_CAPTION_STYLE.fontSize};
      text-transform: ${style.textTransform || DEFAULT_CAPTION_STYLE.textTransform};
      padding: ${style.padding || DEFAULT_CAPTION_STYLE.padding};
      text-shadow: ${style.textShadow || DEFAULT_CAPTION_STYLE.textShadow};
    }
  `;
}
window.RCBPlugins.registerCoreHook('theme-audio-refresh', applyCaptionStyle);
applyCaptionStyle();

// A plain on/off toggle, not a real "interrupt" (no slate, nothing to
// cancel) — reuses registerInterrupt anyway because it's the one existing
// extension point that already wires a hotkey + hint-bar item + TV-menu
// entry generically (app.js's key handler, power.js's hint bar, tv-menu.js),
// and this app has no separate "plain toggle" registry yet. 'k' is free —
// every other plausible mnemonic letter (c/e/b/...) is already claimed by
// another feature (see app.js's key switch / other plugins' own hotkeys).
window.RCBPlugins.registerInterrupt('closed-captions', {
  label: 'TOGGLE CAPTIONS (CC)',
  hintKey: 'closed-captions',
  hotkey: 'k',
  run() {
    const c = cfg();
    c.enabled = !c.enabled;
    saveConfigDebounced();
    if (!c.enabled) clearActiveTrack();
  },
});

window.RCBPlugins.registerSettingsPanel('closed-captions', {
  render(container) {
    const c = cfg();
    container.innerHTML = `
      <label class="panel-toggle">
        <input type="checkbox" id="cc-plugin-enabled">
        CLOSED CAPTIONS (K TO TOGGLE)
      </label>
      <span class="panel-status">Real captions only — a sidecar .srt/.vtt file next to the video, or a subtitle stream already embedded in the file. Nothing is auto-generated. Caption styling follows the active guide/OSD theme.</span>
    `;
    const enabledEl = container.querySelector('#cc-plugin-enabled');
    enabledEl.checked = !!c.enabled;
    enabledEl.addEventListener('change', () => {
      c.enabled = enabledEl.checked;
      saveConfigDebounced();
      if (!c.enabled) clearActiveTrack();
    });
  },
});
