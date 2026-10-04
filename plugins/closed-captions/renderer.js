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

export function setCaptionsEnabled(enabled) {
  const captionsConfig = cfg();
  captionsConfig.enabled = !!enabled;
  saveConfigDebounced();
  if (!captionsConfig.enabled) clearActiveTrack();
}

// Prefers a sidecar file (an intentional, purpose-made caption file) over an
// embedded stream, and among embedded streams prefers one already tagged
// 'eng' if present — otherwise just the first one found.
function pickTrack(tracks) {
  const sidecar = tracks.find((t) => t.type === 'sidecar');
  if (sidecar) return sidecar;
  // The preferred language (SETTINGS › Closed captions, an ISO 639-2 code
  // such as eng, spa or fre), else the first stream found.
  const wanted = String(cfg().language || 'eng').trim().toLowerCase();
  const preferred = wanted && wanted !== 'any' ? tracks.find((t) => t.type === 'embedded' && String(t.lang || '').toLowerCase() === wanted) : null;
  return preferred || tracks[0];
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
    if (!trackEl.track) return;
    trackEl.track.mode = 'showing';
    // Captions at the top of the picture when asked (clear of a lower-third
    // or a ticker); a cue's line 1 is the first row from the top.
    if (cfg().position === 'top') {
      Array.from(trackEl.track.cues || []).forEach((cue) => { cue.snapToLines = true; cue.line = 1; });
    }
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

// User-chosen size multiplier on top of whatever the active theme's own
// captionStyle.fontSize specifies — theme picks the *look*, this scales the
// *legibility* independent of it, applied via calc() so it works regardless
// of what unit the theme's fontSize happens to use.
export function applyCaptionStyle() {
  const pack = window.RCBPlugins.getThemePack ? window.RCBPlugins.getThemePack(S.config.theme) : null;
  const style = (pack && pack.captionStyle) || DEFAULT_CAPTION_STYLE;
  const c = cfg();
  const sizeScale = c.sizeScale || 1;
  const FONTS = { sans: 'Arial, Helvetica, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: '"Courier New", monospace' };
  const EDGES = { none: 'none', shadow: '2px 2px 3px rgba(0, 0, 0, 0.9)', outline: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000' };
  const background = Number.isFinite(c.bgOpacity) ? `rgba(0, 0, 0, ${Math.min(100, Math.max(0, c.bgOpacity)) / 100})` : (style.background || DEFAULT_CAPTION_STYLE.background);
  const color = /^#[0-9a-f]{3,8}$/i.test(c.color || '') ? c.color : (style.color || DEFAULT_CAPTION_STYLE.color);
  const fontFamily = FONTS[c.font] || style.fontFamily || DEFAULT_CAPTION_STYLE.fontFamily;
  const textShadow = EDGES[c.edge] || style.textShadow || DEFAULT_CAPTION_STYLE.textShadow;
  const textTransform = c.allCaps ? 'uppercase' : (style.textTransform || DEFAULT_CAPTION_STYLE.textTransform);
  let styleEl = document.getElementById('cc-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'cc-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    #player::cue {
      background: ${background};
      color: ${color};
      font-family: ${fontFamily};
      font-size: calc(${style.fontSize || DEFAULT_CAPTION_STYLE.fontSize} * ${sizeScale});
      text-transform: ${textTransform};
      padding: ${style.padding || DEFAULT_CAPTION_STYLE.padding};
      text-shadow: ${textShadow};
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
    setCaptionsEnabled(!c.enabled);
  },
});
