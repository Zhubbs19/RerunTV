// App-wide display mode (DISPLAY > APP DISPLAY MODE) — simulates the fixed
// aspect/resolution a real box's own display would have had, independent of
// the video-only ASPECT RATIO setting (aspectMode, power.js) which only
// affects object-fit on #player.
import { getChannel } from './channels.js';
import { displayFrameEl, player } from './dom.js';
import { computeLivePosition } from './schedule.js';
import { S } from './state.js';

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

// Top-level resolution decision: a per-channel override (setup-channels.js)
// wins outright when set — including its own independent 'auto' choice —
// and only falls through to the box-wide RESOLUTION select (DISPLAY tab,
// itself possibly 'auto' too) when the channel has no override at all.
function resolveEffectiveResolution(dm) {
  const ch = getChannel(S.currentNumber);
  const override = ch && ch.resolutionOverride;
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
//     without changing "era"), a file's actual aspect ratio is reliable
//     evidence of its shape regardless of encode history, so this is
//     authoritative whenever metadata is available — no high-res-style
//     "inconclusive" case to fall through on.
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

// Top-level aspect decision — same "per-channel override (incl. its own
// AUTO) beats box-wide (incl. its own AUTO)" shape as
// resolveEffectiveResolution above.
function resolveEffectiveAspect(dm) {
  const ch = getChannel(S.currentNumber);
  const override = ch && ch.displayAspectOverride;
  if (override === 'auto') return autoDetectAspect(ch);
  if (override) return override;
  const boxWide = dm.aspect || '16:9';
  return boxWide === 'auto' ? autoDetectAspect(ch) : boxWide;
}

export function applyDisplayMode() {
  if (!displayFrameEl) return;
  const dm = S.config.displayMode || {};
  const aspect = resolveEffectiveAspect(dm);
  const windowMode = dm.windowMode || 'letterbox';
  const resolution = resolveEffectiveResolution(dm);
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
  const targetW = Math.max(1, Math.min(availW, availH * ratio));
  const targetH = targetW / ratio;

  if (resolution === 'native') {
    root.setProperty('--display-frame-width', `${targetW}px`);
    root.setProperty('--display-frame-height', `${targetH}px`);
    root.setProperty('--display-frame-transform', 'none');
    root.setProperty('--display-frame-image-rendering', 'auto');
    root.setProperty('--display-content-zoom', '1');
    root.setProperty('--display-frame-scale', '1');
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
