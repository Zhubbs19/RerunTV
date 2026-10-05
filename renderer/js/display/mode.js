// App-wide display mode (DISPLAY > APP DISPLAY MODE) — simulates the fixed
// aspect/resolution a real box's own display would have had, independent of
// the video-only ASPECT RATIO setting (aspectMode, power.js) which only
// affects object-fit on #player.
import { getChannel } from '../core/channels.js';
import { crtContainer, displayFrameEl, player, setupScreen } from '../core/dom.js';
import { getPluginChannelDisplaySettings, getPluginChannelEntryForNumber } from '../plugin/host.js';
import { computeLivePosition } from '../core/schedule.js';
import { S } from '../core/state.js';

// Per-channel RESOLUTION override (ch.resolutionOverride, setup-channels.js)
// — same "inherit box default" shape as ch.aspectRatio (CHANNEL_ASPECT_OPTIONS,
// power.js), but with its OWN independent AUTO choice too: '' inherits
// whatever the box-wide RESOLUTION select is currently set to (including
// AUTO, if that's what it's set to); 'auto' here auto-detects for this
// channel specifically regardless of what the box-wide select says — so a
// box-wide default of NATIVE can still have one specific channel
// auto-detect, or a box-wide AUTO can still pin one channel to a fixed tier.
export const CHANNEL_RESOLUTION_OPTIONS = [
  { value: '', label: 'INHERIT (BOX DEFAULT)' },
  { value: 'auto', label: 'AUTO (BY FILE / ERA)' },
  { value: 'native', label: 'NATIVE (SHARP)' },
  { value: 'sd480', label: 'SD 480-LINE (CHUNKY)' },
  { value: 'sd240', label: 'SD 240-LINE (VERY CHUNKY)' },
];

// Per-channel APP DISPLAY MODE ASPECT override (ch.displayAspectOverride,
// setup-channels.js) — same shape/relationship to the box-wide ASPECT
// select as CHANNEL_RESOLUTION_OPTIONS above has to RESOLUTION. Distinct
// from ch.aspectRatio (CHANNEL_ASPECT_OPTIONS, power.js) — that one crops/
// fits video CONTENT inside #player; this one is the simulated box's own
// screen shape (#display-frame), same "two separate settings" relationship
// the box-wide ASPECT/RESOLUTION selects already have to PICTURE MODE &
// ASPECT's video-only controls.
export const CHANNEL_DISPLAY_ASPECT_OPTIONS = [
  { value: '', label: 'INHERIT (BOX DEFAULT)' },
  { value: 'auto', label: 'AUTO (BY FILE / ERA)' },
  { value: '16:9', label: '16:9 (WIDESCREEN)' },
  { value: '4:3', label: '4:3 (CLASSIC)' },
];

// Box-wide AUTO PRIORITY select (DISPLAY > APP DISPLAY MODE) — see
// autoPriority() below for what each value actually changes.
export const DISPLAY_AUTO_PRIORITY_OPTIONS = [
  { value: 'metadata', label: 'FILE RESOLUTION FIRST (DEFAULT)' },
  { value: 'era', label: 'ERA TAG FIRST' },
];

// Called by playback.js once a file's REAL video size is confirmed
// (loadedmetadata) — see videoSizeCache (state.js) for why this is kept.
export function cacheVideoSize(path, w, h) {
  if (!path || !w || !h) return;
  S.videoSizeCache[path] = { w, h };
}

const ASPECT_RATIOS = { '16:9': 16 / 9, '4:3': 4 / 3 };
// "Simulate a box that only ever rendered N lines tall" — width is derived
// from the current aspect so resolution and aspect combine freely instead of
// needing a hardcoded option per (aspect, resolution) pair.
const RESOLUTION_LINES = { sd480: 480, sd240: 240 };
// Every card/popup/panel in this app is sized in fixed px, tuned by eye
// against a real desktop window (roughly this tall) — so literally
// rendering the DOM at a genuinely tiny box (640x480 for sd480, 320x240 for
// sd240) makes that fixed-px UI blow way past the available room: text and
// padding don't shrink just because their container did, so things overlap
// or get clipped. --display-content-zoom (applied as CSS `zoom` on
// #tv-screen/#setup-screen, tokens.css) counteracts that by uniformly
// shrinking EVERY descendant's effective px size — fonts, padding, gaps,
// icons, popups — together, automatically, with no per-element tuning
// needed. It's deliberately independent of RESOLUTION_LINES: whichever tier
// is picked, content still lays out against roughly this same reference
// canvas size, so the UI stays equally usable at every tier — only the
// final chunkiness (how blocky the transform-scaled pixels look once blown
// back up to fill the screen) changes with the tier.
const CONTENT_REFERENCE_HEIGHT = 900;

// {aspect, windowMode} last sent to the main process — setAspectLock also
// snaps the real window's current size to the ratio (main.js), so this is
// only re-invoked when the effective lock actually changes, not on every
// screen transition (showSetupScreen/showTvScreen both call
// applyDisplayMode()), or the window would jump size every time.
let lastAppliedLock = null;

// AUTO resolution — auto-detects a tier for whichever channel is passed in,
// cascading through two signals from most to least authoritative:
//  1. The currently-airing file's REAL decoded video size (player.
//     videoWidth/videoHeight) — only once loadedmetadata has actually
//     fired (playback.js calls applyDisplayMode() again from there for
//     exactly this reason); a genuinely low-res source file is real,
//     objective evidence of "old/chunky," unlike a tag someone may or may
//     not have set. Only used as a POSITIVE signal for a low tier — a
//     high-res reading doesn't force 'native' by itself, since plenty of
//     old content has been upscaled/re-encoded at 1080p without becoming
//     any less "old" in spirit, so that case falls through to the era
//     check below instead of being forced native by an unreliable read.
//  2. The currently-airing file's facets.era (free text, TITLES panel) —
//     the first 4-digit year found in it, bucketed by decade. Best-effort:
//     era is user-typed and frequently empty, so this is a fallback, not a
//     primary signal.
//  3. 'native' — the same-as-today default when nothing above resolves.
function resolutionFromVideoSize(w, h) {
  if (!w || !h) return null; // metadata not loaded yet — not evidence of anything
  if (h <= 240) return 'sd240';
  if (h <= 480) return 'sd480';
  return null; // high-res isn't proof of "not old" — let era decide instead
}

function resolutionFromEra(era) {
  if (!era) return null;
  const match = String(era).match(/\d{4}/);
  if (!match) return null;
  const year = parseInt(match[0], 10);
  if (year < 1970) return 'sd240';
  if (year < 1990) return 'sd480';
  return 'native';
}

// Only trust player.videoWidth/videoHeight as evidence for `ch` once
// playback.js has CONFIRMED (via its own loadedmetadata) that they actually
// belong to this channel — applyDisplayMode() gets called from several
// points in the tune sequence, including ones that fire before the new
// channel's own video has loaded, where the player element may still be
// showing a PREVIOUS channel's dimensions. Rapid channel-flipping is
// exactly when this race is most likely: several tunes' async work can be
// in flight at once, and without this check a stale reading could get
// applied and then never get corrected if the flip that finally "wins"
// doesn't happen to trigger a fresh loadedmetadata of its own.
function playerVideoSizeFor(ch) {
  if (!ch || S.currentPlayerChannelNumber !== ch.number) return { w: 0, h: 0 };
  return { w: player.videoWidth, h: player.videoHeight };
}

// The confirmed-live reading above is only available once THIS tune's own
// loadedmetadata has fired — too late to inform the early, pre-metadata
// applyDisplayMode() call that playChannelLive also makes (so the frame
// doesn't sit at a stale previous-channel size while the new file loads).
// videoSizeCache (state.js) remembers every file's real size the first time
// it's ever decoded, so a repeat airing — the common case, since channels
// loop the same pool — can use real, confirmed dimensions on that early call
// too, instead of only the era/default guess. Falls back to {0,0} (same as
// "unknown") the first time any given file is ever seen.
function cachedVideoSizeFor(ch) {
  const pos = ch && computeLivePosition(ch);
  const path = pos && pos.file && pos.file.path;
  const cached = path && S.videoSizeCache[path];
  return cached || { w: 0, h: 0 };
}

function realVideoSizeFor(ch) {
  const live = playerVideoSizeFor(ch);
  if (live.w && live.h) return live;
  return cachedVideoSizeFor(ch);
}

// Box-wide (DISPLAY tab) preference for which AUTO signal wins when both a
// real video size (live or cached) AND an era tag are available — defaults
// to 'metadata' (the file's own real, objective size) since that's normally
// more trustworthy than a free-text tag, but a user who's deliberately
// tagged content with an era to get its PERIOD LOOK regardless of the
// file's actual encode (e.g. a modern remaster of a 1965 show) can flip
// this to prefer that intent instead.
function autoPriority() {
  return (S.config.displayMode && S.config.displayMode.autoPriority) || 'metadata';
}

function autoDetectResolution(ch) {
  if (!ch) return 'native';
  const { w, h } = realVideoSizeFor(ch);
  const byVideoSize = resolutionFromVideoSize(w, h);
  const pos = computeLivePosition(ch);
  const era = pos && pos.file && pos.file.facets && pos.file.facets.era;
  const byEra = resolutionFromEra(era);
  if (autoPriority() === 'era') return byEra || byVideoSize || 'native';
  return byVideoSize || byEra || 'native';
}

// Finds the registerChannelType definition for the current channel number
// when that number isn't in S.config.channels (i.e. it's a virtual plugin
// channel). Used as a fallback by the two resolve functions below so plugin
// channels can use the generic plugin settings namespace. Definition fields
// remain a backward-compatible/default fallback for older plugins.
function pluginChannelDisplaySettingsForNumber(number) {
  const entry = getPluginChannelEntryForNumber(number);
  return entry ? getPluginChannelDisplaySettings(entry.id, entry.definition) : null;
}

// Top-level resolution decision: a per-channel override wins outright when
// set — including its own independent 'auto' choice — and only falls through
// to the box-wide RESOLUTION select (DISPLAY tab, itself possibly 'auto'
// too) when the channel has no override at all.
// Regular user-channel overrides live on the channel config entry; virtual
// plugin-channel overrides live in config.pluginSettings.
function resolveEffectiveResolution(dm) {
  const ch = getChannel(S.currentNumber);
  const override = (ch && ch.resolutionOverride)
    || (!ch && (pluginChannelDisplaySettingsForNumber(S.currentNumber) || {}).resolutionOverride);
  if (override === 'auto') return autoDetectResolution(ch);
  if (override) return override;
  const boxWide = dm.resolution || 'native';
  return boxWide === 'auto' ? autoDetectResolution(ch) : boxWide;
}

// AUTO aspect — same two-signal cascade as AUTO resolution above, but for
// the simulated box's own screen SHAPE rather than its pixel density:
//  1. The currently-airing file's REAL decoded video shape (player.
//     videoWidth/videoHeight) — whichever of 4:3/16:9 its ratio sits closer
//     to. Unlike resolution's video-size signal (only trusted as a POSITIVE
//     signal for a low tier, since a re-encode can raise pixel count
//     without changing \"era\"), a file's actual aspect ratio is reliable
//     evidence of its shape regardless of encode history, so this is
//     authoritative whenever metadata is available — no high-res-style
//     \"inconclusive\" case to fall through on.
//  2. The currently-airing file's facets.era, split at 1998 (roughly when
//     16:9 broadcast/DVD content became common) — same free-text,
//     best-effort fallback as the resolution era check.
//  3. '16:9' — the same-as-today default when nothing above resolves.
function aspectFromVideoSize(w, h) {
  if (!w || !h) return null; // metadata not loaded yet — not evidence of anything
  const ratio = w / h;
  return Math.abs(ratio - 4 / 3) <= Math.abs(ratio - 16 / 9) ? '4:3' : '16:9';
}

function aspectFromEra(era) {
  if (!era) return null;
  const match = String(era).match(/\d{4}/);
  if (!match) return null;
  return parseInt(match[0], 10) < 1998 ? '4:3' : '16:9';
}

function autoDetectAspect(ch) {
  if (!ch) return '16:9';
  const { w, h } = realVideoSizeFor(ch);
  const byVideoSize = aspectFromVideoSize(w, h);
  const pos = computeLivePosition(ch);
  const era = pos && pos.file && pos.file.facets && pos.file.facets.era;
  const byEra = aspectFromEra(era);
  if (autoPriority() === 'era') return byEra || byVideoSize || '16:9';
  return byVideoSize || byEra || '16:9';
}

// Top-level aspect decision — same \"per-channel override (incl. its own
// AUTO) beats box-wide (incl. its own AUTO)\" shape as
// resolveEffectiveResolution above. Same plugin-channel fallback too:
// plugin channels resolve their saved value through the plugin registry.
function resolveEffectiveAspect(dm) {
  const ch = getChannel(S.currentNumber);
  const override = (ch && ch.displayAspectOverride)
    || (!ch && (pluginChannelDisplaySettingsForNumber(S.currentNumber) || {}).displayAspectOverride);
  if (override === 'auto') return autoDetectAspect(ch);
  if (override) return override;
  const boxWide = dm.aspect || '16:9';
  return boxWide === 'auto' ? autoDetectAspect(ch) : boxWide;
}

export function resolveEffectiveDisplayMode() {
  const dm = S.config.displayMode || {};
  return {
    aspect: resolveEffectiveAspect(dm),
    resolution: resolveEffectiveResolution(dm),
    windowMode: dm.windowMode || 'letterbox',
  };
}

// Content-derived context for overlay placement. Unlike the effective app
// display mode, this deliberately ignores manual display overrides so an
// AUTO MATCH CONTENT layout can follow each playing file as it changes.
export function resolveContentDisplayMode() {
  const ch = getChannel(S.currentNumber);
  return {
    aspect: autoDetectAspect(ch),
    resolution: autoDetectResolution(ch),
    windowMode: (S.config.displayMode && S.config.displayMode.windowMode) || 'letterbox',
  };
}

export const OVERLAY_LAYOUT_TARGETS = [
  { id: 'guide-overlay', label: 'CHANNEL / NOW PLAYING CARD' },
  { id: 'station-id-bar', label: "YOU'RE WATCHING CARD" },
  { id: 'upnext-bar', label: 'UP NEXT CARD' },
  { id: 'rating-bug', label: 'CONTENT RATING CARD' },
  { id: 'episode-status-bug', label: 'NEW EPISODE / REPEAT CARD' },
  { id: 'format-disclaimer-card', label: 'FORMATTED-FOR-YOUR-SCREEN CARD' },
  { id: 'content-advisory-card', label: 'CONTENT ADVISORY CARD' },
  { id: 'capability-badge', label: 'CC/SAP/STEREO BADGE' },
  { id: 'channel-entry', label: 'CHANNEL NUMBER POP-UP' },
  { id: 'volume-indicator', label: 'VOLUME POP-UP' },
  { id: 'timeshift-badge', label: 'TIME SHIFT BADGE' },
  { id: 'vcr-osd', label: 'VCR / TIME MACHINE CARD' },
  { id: 'ticker-bar', label: 'TEXT TICKER' },
];

// ticker-bar is the only target in the list above that can also be
// customized per-channel (ch.tickerLayout, channels.js) — every other
// target is box-wide only (S.config.display.overlayLayouts[id]). Kept as an
// explicit set rather than a per-target flag since it's a single entry today.
const PER_CHANNEL_OVERLAY_TARGET_IDS = new Set(['ticker-bar']);

function pickOverlayLayout(profiles, context) {
  return (profiles || [])
    .filter((profile) => (!profile.aspect || profile.aspect === context.aspect)
      && (!profile.resolution || profile.resolution === context.resolution))
    .sort((a, b) => Number(Boolean(b.aspect)) + Number(Boolean(b.resolution))
      - Number(Boolean(a.aspect)) - Number(Boolean(a.resolution)))[0] || null;
}

export function resolveOverlayLayoutContext() {
  return S.config.display && S.config.display.logoBugAutoAdjust
    ? resolveContentDisplayMode()
    : resolveEffectiveDisplayMode();
}

// A few OVERLAY_LAYOUT_TARGETS rely on their own CSS `transform` (not just
// `left`/`top`) for default (no saved custom-position profile) centering —
// overlays.css's `left:50%; transform:translateX(-50%);` idiom. Overwriting
// `transform` outright, the way the KEEP OVERLAYS AT FULL RESOLUTION
// counter-scale below does, would silently un-center these. Not needed once
// a custom profile exists for a target — the layout editor already
// repositions those by explicit top-left corner instead (transform-
// origin:'top left', no base transform), same as it always has; this is
// purely for preserving each target's own DEFAULT appearance.
// The corner badges that sit on the picture rather than on the screen, like
// the logo bug (DISPLAY › Logo bug › Keep the bug on the picture). Their CSS
// offsets add --picture-inset-* (overlays.css); a saved custom position gets
// the same gap added here. The cards and bars stay on the screen.
export const PICTURE_FOLLOWING_OVERLAYS = new Set(['rating-bug', 'episode-status-bug', 'capability-badge', 'timeshift-badge']);
let pictureInsets = { left: 0, top: 0, right: 0, bottom: 0 };

// How far the picture is in from each edge of the overlay layer, in the
// layer's own pixels (black bars, or the docked guide). Zero when the picture
// fills the layer, or the bug is set to ignore the picture.
export function applyPictureInsets() {
  const layer = document.getElementById('overlay-extend-layer');
  const picture = S.pictureRect;
  const follow = !(S.config && S.config.display && S.config.display.logoBugFollowPicture === false);
  let next = { left: 0, top: 0, right: 0, bottom: 0 };
  if (layer && crtContainer && picture && follow && crtContainer.clientWidth && crtContainer.clientHeight && layer.clientWidth && layer.clientHeight) {
    const crt = crtContainer.getBoundingClientRect();
    const box = layer.getBoundingClientRect();
    const crtX = crt.width / crtContainer.clientWidth;
    const crtY = crt.height / crtContainer.clientHeight;
    const layerX = box.width / layer.clientWidth;
    const layerY = box.height / layer.clientHeight;
    const left = crt.left + picture.left * crtX;
    const top = crt.top + picture.top * crtY;
    const right = left + picture.width * crtX;
    const bottom = top + picture.height * crtY;
    const gap = (value) => (value < 1 ? 0 : Math.round(value));
    next = {
      left: gap((left - box.left) / layerX),
      top: gap((top - box.top) / layerY),
      right: gap((box.right - right) / layerX),
      bottom: gap((box.bottom - bottom) / layerY),
    };
  }
  if (Object.keys(next).every((side) => next[side] === pictureInsets[side])) return;
  pictureInsets = next;
  Object.keys(next).forEach((side) => layer && layer.style.setProperty(`--picture-inset-${side}`, `${next[side]}px`));
  applyOverlayLayouts();
}
window.addEventListener('reruntv:picture-framed', applyPictureInsets);
window.addEventListener('resize', applyPictureInsets);

const OVERLAY_BASE_TRANSFORMS = {
  'upnext-bar': 'translateX(-50%)',
  'format-disclaimer-card': 'translateX(-50%)',
  'content-advisory-card': 'translateX(-50%)',
};

export function applyOverlayLayouts() {
  const layouts = (S.config.display && S.config.display.overlayLayouts) || {};
  const context = resolveOverlayLayoutContext();
  const ch = getChannel(S.currentNumber);
  // KEEP OVERLAYS AT FULL RESOLUTION (DISPLAY > APP DISPLAY MODE) — only
  // still relevant to ticker-bar now. Every OTHER OVERLAY_LAYOUT_TARGETS
  // element is an #app-level sibling of #display-frame today (index.html,
  // see the comment above #overlay-extend-layer), specifically so it's no
  // longer subject to #display-frame's own simulated-resolution transform/
  // zoom at all — it renders at native sharpness unconditionally now,
  // regardless of this setting, with nothing left to counter-scale.
  // ticker-bar couldn't make that same move (a plugin injects its DOM at
  // runtime, not core markup here), so it's still nested inside
  // #display-frame and still needs this counter-scale to match native size.
  // A simulated resolution tier shrinks #display-frame's own DOM to a tiny
  // fixed pixel box (--display-frame-width/height), applies a compensating
  // CSS `zoom` (--display-content-zoom) so that tiny box's own layout still
  // fits without overlapping/clipping, then blows the whole thing back up
  // to fill the real letterboxed target via `transform: scale()`
  // (--display-frame-scale) — see applyDisplayMode below. Both stages
  // multiply together; dividing out their product cancels both, landing
  // ticker-bar back at the same size it'd render at RESOLUTION: NATIVE
  // regardless of which tier the video itself is simulating.
  const overlaysNativeSize = !!(S.config.displayMode && S.config.displayMode.overlaysNativeSize);
  let tickerInvScale = 1;
  if (overlaysNativeSize) {
    const root = document.documentElement.style;
    const frameScale = parseFloat(root.getPropertyValue('--display-frame-scale')) || 1;
    const contentZoom = parseFloat(root.getPropertyValue('--display-content-zoom')) || 1;
    const combined = frameScale * contentZoom;
    tickerInvScale = combined ? 1 / combined : 1;
  }

  OVERLAY_LAYOUT_TARGETS.forEach(({ id }) => {
    const element = document.getElementById(id);
    const perChannel = ch && PER_CHANNEL_OVERLAY_TARGET_IDS.has(id) ? ch.tickerLayout : null;
    const profile = pickOverlayLayout(perChannel != null ? perChannel : layouts[id], context);
    if (!element) return;
    const invScale = id === 'ticker-bar' ? tickerInvScale : 1;
    if (!profile && invScale === 1) {
      // No custom position and no counter-scale needed — but a PREVIOUS
      // call may have left an inline transform behind (KEEP OVERLAYS AT
      // FULL RESOLUTION just got turned back off, or resolution changed
      // back to native). Explicitly clear it (empty string, not 'none' —
      // that would permanently kill a target like upnext-bar's own CSS
      // centering transform instead of just handing control back to it)
      // rather than leaving it stuck at whatever scale was last applied.
      element.style.transform = '';
      element.style.transformOrigin = '';
      return;
    }
    const base = (!profile && OVERLAY_BASE_TRANSFORMS[id]) ? `${OVERLAY_BASE_TRANSFORMS[id]} ` : '';
    if (profile) {
      // A badge on the picture keeps its gap to the nearer picture edge.
      const follows = PICTURE_FOLLOWING_OVERLAYS.has(id);
      const dx = follows ? (profile.x < 50 ? pictureInsets.left : -pictureInsets.right) : 0;
      const dy = follows ? (profile.y < 50 ? pictureInsets.top : -pictureInsets.bottom) : 0;
      element.style.left = dx ? `calc(${profile.x}% + ${dx}px)` : `${profile.x}%`;
      element.style.top = dy ? `calc(${profile.y}% + ${dy}px)` : `${profile.y}%`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    }
    if (id === 'ticker-bar') {
      // width/height profile (percentages of the screen), not the generic
      // scale-factor model the other targets use — see
      // normalizeOverlayLayoutProfiles (channels.js) for why: the ticker bar
      // has no natural intrinsic size to scale from.
      if (profile) {
        element.style.width = `${profile.width}%`;
        element.style.height = `${profile.height}%`;
      }
      element.style.transformOrigin = 'top left';
      element.style.transform = invScale === 1 ? 'none' : `${base}scale(${invScale})`;
    } else {
      element.style.transformOrigin = 'top left';
      const baseScale = profile ? (profile.scale || 1) : 1;
      element.style.transform = `${base}scale(${baseScale * invScale})`;
    }
  });
}

// EXTEND GUIDE & OVERLAYS TO FULL SCREEN (DISPLAY > APP DISPLAY MODE) — two
// consumers share these four vars: #guide-grid itself, and
// #overlay-extend-layer (tokens.css), the wrapper around every other
// OVERLAY_LAYOUT_TARGETS badge except ticker-bar. Both are direct #app
// children now (index.html), sized/positioned entirely by these vars rather
// than inheriting #display-frame's own box the way they used to as
// descendants. Off (default): reproduces #display-frame's own centered
// (targetW x targetH) rect exactly, so the guide and badges stay confined
// to the video's simulated content box — today's behavior, unchanged. On:
// they instead cover the real #app window (availW x availH), independent
// of whatever aspect/resolution the video itself is simulating.
function applyExtendLayerBounds({
  availW, availH, targetW, targetH,
}) {
  const root = document.documentElement.style;
  const fullScreen = !!(S.config.displayMode && S.config.displayMode.uiExtent === 'fullscreen');
  if (fullScreen) {
    root.setProperty('--guide-grid-left', '0px');
    root.setProperty('--guide-grid-top', '0px');
    root.setProperty('--guide-grid-width', `${availW}px`);
    root.setProperty('--guide-grid-height', `${availH}px`);
  } else {
    root.setProperty('--guide-grid-left', `${(availW - targetW) / 2}px`);
    root.setProperty('--guide-grid-top', `${(availH - targetH) / 2}px`);
    root.setProperty('--guide-grid-width', `${targetW}px`);
    root.setProperty('--guide-grid-height', `${targetH}px`);
  }
  // The layer's box just changed, so how far the picture sits inside it did too.
  applyPictureInsets();
}

export function applyDisplayMode() {
  if (!displayFrameEl) return;
  const { aspect, windowMode, resolution } = resolveEffectiveDisplayMode();
  const ratio = ASPECT_RATIOS[aspect] || ASPECT_RATIOS['16:9'];
  const root = document.documentElement.style;

  const lockKey = windowMode === 'lockWindow' ? aspect : null;
  if (lockKey !== lastAppliedLock && window.api && window.api.setAspectLock) {
    lastAppliedLock = lockKey;
    window.api.setAspectLock(lockKey);
  }

  // The always-on letterbox/pillarbox target: the biggest box of the chosen
  // aspect that fits inside #app's real on-screen size. CSS's own
  // `aspect-ratio` property can't do this by itself here — it only
  // constrains whichever dimension is `auto`, but #display-frame needs both
  // dimensions explicit to also support the simulated-resolution transform
  // below — so both the native and simulated-resolution cases compute this
  // target in JS instead.
  const appEl = displayFrameEl.parentElement;
  const availW = appEl ? appEl.clientWidth : window.innerWidth;
  const availH = appEl ? appEl.clientHeight : window.innerHeight;

  // The Control Center is an administration workspace, not set-top-box
  // output. Keeping it inside a simulated 4:3/240-line frame produced large
  // pillarboxes and needlessly tiny forms on modern displays. Give Setup the
  // whole application canvas while leaving TV, channel cards, and both guide
  // modes faithful to the selected box aspect/resolution. The window aspect
  // lock remains the user's explicit window preference; only the content
  // frame is decoupled here.
  const setupVisible = setupScreen && !setupScreen.classList.contains('hidden');
  displayFrameEl.classList.toggle('display-frame-control-center', Boolean(setupVisible));
  if (setupVisible) {
    root.setProperty('--display-frame-width', `${Math.max(1, availW)}px`);
    root.setProperty('--display-frame-height', `${Math.max(1, availH)}px`);
    root.setProperty('--display-frame-transform', 'none');
    root.setProperty('--display-frame-image-rendering', 'auto');
    root.setProperty('--display-content-zoom', '1');
    root.setProperty('--display-frame-scale', '1');
    applyExtendLayerBounds({
      availW, availH, targetW: availW, targetH: availH,
    });
    return;
  }

  const targetW = Math.max(1, Math.min(availW, availH * ratio));
  const targetH = targetW / ratio;

  if (resolution === 'native') {
    root.setProperty('--display-frame-width', `${targetW}px`);
    root.setProperty('--display-frame-height', `${targetH}px`);
    root.setProperty('--display-frame-transform', 'none');
    root.setProperty('--display-frame-image-rendering', 'auto');
    root.setProperty('--display-content-zoom', '1');
    root.setProperty('--display-frame-scale', '1');
    applyExtendLayerBounds({
      availW, availH, targetW, targetH,
    });
    applyOverlayLayouts();
    return;
  }

  // Render the real DOM at a small fixed pixel box (period-correct line
  // count), then scale it up to fill the same letterboxed target area —
  // chunky/blocky like real old hardware, not just a smaller sharp frame.
  // transform-origin:center (tokens.css) plus #app's flex-centering means
  // scaling this small centered box up stays centered with no translate math.
  const lines = RESOLUTION_LINES[resolution] || RESOLUTION_LINES.sd480;
  const boxHeight = lines;
  const boxWidth = Math.round(lines * ratio);
  root.setProperty('--display-frame-width', `${boxWidth}px`);
  root.setProperty('--display-frame-height', `${boxHeight}px`);
  root.setProperty('--display-frame-image-rendering', 'pixelated');
  const scale = targetW / boxWidth;
  root.setProperty('--display-frame-transform', `scale(${scale})`);
  root.setProperty('--display-content-zoom', String(Math.min(1, boxHeight / CONTENT_REFERENCE_HEIGHT)));
  // Raw numeric scale (unlike --display-frame-transform's full `scale(N)`
  // string) — tokens.css uses this to pre-inflate <option> font-size (a
  // native <select> popup never receives the transform above, so its text
  // would otherwise render at a fraction of how big the closed select's
  // OWN text appears on screen once magnified by it).
  root.setProperty('--display-frame-scale', String(scale));
  applyExtendLayerBounds({
    availW, availH, targetW, targetH,
  });
  applyOverlayLayouts();
}

// The px sizes/scale computed above are a snapshot of #app's size at call
// time — unlike a pure-CSS aspect-ratio box (which would reflow on its own),
// they need recomputing on every resize, or the frame stops matching the
// window after one.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyDisplayMode, 100);
});

// showTvScreen/showSetupScreen (app.js) call this instead of plain
// applyDisplayMode() — a screen switch is just a `.hidden` class toggle
// between siblings under #app, not a real window resize, so it fires no
// `resize` event for the listener above to catch a stale read with. Found
// live: on the very first Setup -> TV transition after onboarding, #app's
// measured size can lag one frame behind the window's real (already-
// maximized) geometry, baking a too-small letterbox target into the fixed-px
// CSS vars with nothing to ever re-trigger a fix — until the next channel
// tune, itself a coincidental fix via applyDisplayMode()'s other call sites,
// not a dedicated one. Re-measuring one frame later catches that race
// without needing to reproduce its exact trigger.
export function applyDisplayModeSettled() {
  applyDisplayMode();
  requestAnimationFrame(applyDisplayMode);
}
