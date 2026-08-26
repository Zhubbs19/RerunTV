import { refreshSfxGainLevel, sfxPowerOff, sfxPowerOn, sfxVolumeTick } from './audio.js';
import { getChannel } from './channels.js';
import {
  channelEntryEl, crtContainer, crtPreviewEl, crtToggleFlash, guideGrid, guideMuteEl, guideOverlay, hintBarEl, logoBugEl, player,
  screenCrtOverlayEl, shortcutsOverlayEl, stationIdBarEl, triviaCardEl, tvBezelEl, tvScreen,
  vhsTimestampEl, volumeBarFillEl, volumeIndicatorEl,
} from './dom.js';
import { cancelUpNextBar, resetActiveBreakState, tuneToChannel } from './playback.js';
import { cancelAllInterrupts, getThemePack, interruptEntries, overlayAudioEntries, runCoreHooks } from './plugins.js';
import { POWER_OFF_ANIM_MS, POWER_ON_ANIM_MS, S, saveConfigDebounced, viewNow } from './state.js';
import { stopShuttle } from './timemachine.js';
import { autoHideAfter } from './util.js';
import { effectiveThemeId } from './broadcast-identity.js';

// Three layers multiply together: the master volume (0-1, the existing +/-
// keys), a per-channel override (ch.volume, null = inherit 1x — for a
// channel of old/quiet recordings that always needs to run louder), and
// whichever of the two box-wide "what's on screen right now" multipliers
// applies — S.config.contentVolume for regular show/movie playback, or
// S.config.adVolume for a real video/audio break (commercial/upNext/a
// channelId bumper with its own file). A text-only station ID or trivia
// card doesn't touch `player` at all, so neither multiplier's presence
// matters for those — S.activeBreakKind is what decides which one applies.
// Full status snapshot for the Android companion remote (and the phone web
// remote before it) — pushed to the main process's cached latestRemoteState
// (see startRemoteServer, main.js) on every state-changing action below so
// GET /state always reflects what's actually on screen, not just which
// channel. tuneToChannel (playback.js) calls this too, after setting
// S.currentNumber, to cover the channel-number/name half of the snapshot.
export function pushRemoteState() {
  const ch = getChannel(S.currentNumber);
  window.api.sendRemoteState({
    number: S.currentNumber,
    name: ch ? ch.name : null,
    powered: S.isPoweredOn,
    muted: !!S.config.muted,
    volume: typeof S.config.volume === 'number' ? S.config.volume : 1,
    crt: S.config.crtEnabled !== false,
    pictureMode: S.config.pictureMode || 'standard',
    aspectMode: S.config.aspectMode || 'contain',
    timeMachineOn: !!S.timeMachineOn,
    shuttleDir: S.shuttleDir || 0,
  });
}

export function applyVolume() {
  const master = typeof S.config.volume === 'number' ? S.config.volume : 1;
  const ch = getChannel(S.currentNumber);
  const chMult = (ch && typeof ch.volume === 'number') ? ch.volume : 1;
  const isAdKind = ['commercial', 'adBreakIn', 'adBreakOut', 'upNext', 'channelId', 'signOff', 'signOn', 'promo'].includes(S.activeBreakKind);
  const kindMult = isAdKind
    ? (typeof S.config.adVolume === 'number' ? S.config.adVolume : 1)
    : (typeof S.config.contentVolume === 'number' ? S.config.contentVolume : 1);
  player.volume = Math.min(1, Math.max(0, master * chMult * kindMult));

  // A registered overlay audio source (registerOverlayAudioSource,
  // plugins.js) sits outside the channel/break-kind layering above — it's a
  // background source, not whatever's on screen — so it only ever gets
  // master volume × its own dedicated overlay-volume slider.
  overlayAudioEntries().forEach((src) => {
    const mult = typeof src.overlayVolume === 'function' ? src.overlayVolume() : 0.6;
    src.el.volume = Math.min(1, Math.max(0, master * mult));
  });
  refreshSfxGainLevel();
}


export function applyMuteState() {
  const forceMuted = window.__isViewer && !S.viewerAudioUnlocked;
  player.muted = forceMuted ? true : !!S.config.muted;
  guideMuteEl.classList.toggle('hidden', !player.muted);
  overlayAudioEntries().forEach((src) => { src.el.muted = player.muted; });
  refreshSfxGainLevel();
}

export function toggleMute() {
  S.config.muted = !player.muted;
  applyMuteState();
  // Same reasoning as playback.js's lastChannel writes — a remote-control
  // convenience toggled from the TV screen, not a setup edit worth burying
  // real config changes under on the undo stack.
  saveConfigDebounced(600, { skipUndo: true });
  pushRemoteState();
}

// The logo bug can now sit anywhere on screen (free-position + per-
// resolution profiles — see applyLogoBugPlacement, playback.js), not just a
// fixed corner, so a static CSS offset can't reliably keep .volume-indicator
// clear of it. Measures both elements' actual on-screen boxes and nudges
// the volume indicator up only when they'd genuinely overlap — reset first
// so a stale nudge from a previous (now-moved) logo bug position doesn't
// throw off this measurement.
// Shows a brief on-screen confirmation in crtToggleFlash (e.g. "CRT EFFECT:
// ON") and auto-hides it after 1.5s — the same "set text, show, clear any
// still-pending previous hide, arm a fresh one" sequence every one of this
// module's toggle/cycle actions needs. `timerKey` is the S property this
// particular caller's pending hide-timeout lives under (each caller needs
// its own, so flashing one control doesn't cut off another's still-showing
// message).
function flashMessage(text, timerKey) {
  crtToggleFlash.textContent = text;
  crtToggleFlash.classList.add('show');
  S[timerKey] = autoHideAfter(S[timerKey], 1500, () => crtToggleFlash.classList.remove('show'));
}

function avoidLogoBugOverlap() {
  volumeIndicatorEl.style.bottom = '';
  if (logoBugEl.classList.contains('hidden')) return;
  const volRect = volumeIndicatorEl.getBoundingClientRect();
  const bugRect = logoBugEl.getBoundingClientRect();
  const overlaps = volRect.left < bugRect.right && volRect.right > bugRect.left
    && volRect.top < bugRect.bottom && volRect.bottom > bugRect.top;
  if (!overlaps) return;
  const crtRect = crtContainer.getBoundingClientRect();
  volumeIndicatorEl.style.bottom = `${(crtRect.bottom - bugRect.top) + 16}px`;
}

export function adjustVolume(delta) {
  const current = typeof S.config.volume === 'number' ? S.config.volume : 1;
  S.config.volume = Math.min(1, Math.max(0, Math.round((current + delta) * 100) / 100));
  applyVolume();
  if (delta > 0 && player.muted) {
    S.config.muted = false;
    applyMuteState();
  }
  saveConfigDebounced(600, { skipUndo: true });
  sfxVolumeTick(delta > 0);

  volumeBarFillEl.style.width = `${Math.round(S.config.volume * 100)}%`;
  avoidLogoBugOverlap();
  volumeIndicatorEl.classList.add('show');
  S.volumeHideTimer = autoHideAfter(S.volumeHideTimer, 1500, () => volumeIndicatorEl.classList.remove('show'));
  pushRemoteState();
}

export function applyHintBarState() {
  const display = S.config.display || {};
  const configuredShowDuration = Number(display.hintBarShowDuration);
  const configuredHideDuration = Number(display.hintBarHideDuration);
  const showDuration = Number.isFinite(configuredShowDuration) ? Math.min(1500, Math.max(0, configuredShowDuration)) : 250;
  const hideDuration = Number.isFinite(configuredHideDuration) ? Math.min(1500, Math.max(0, configuredHideDuration)) : 200;
  hintBarEl.style.setProperty('--hint-bar-show-duration', `${showDuration}ms`);
  hintBarEl.style.setProperty('--hint-bar-hide-duration', `${hideDuration}ms`);
  hintBarEl.classList.toggle('motion-instant', display.hintBarSlide === false);
  hintBarEl.classList.toggle('is-hidden', display.hintBar === false);
  hintBarEl.setAttribute('aria-hidden', String(display.hintBar === false));
  // A hint-bar item tagged with an interrupt's hintKey (registerInterrupt,
  // plugins.js) is only meaningful when that plugin is actually installed
  // and enabled. Force-hidden regardless of the user's own
  // per-item toggle below, since showing a shortcut for a feature that
  // isn't there would just be confusing, not a real customization choice
  // to preserve.
  const registeredHintKeys = new Set(interruptEntries().map((e) => e.hintKey).filter(Boolean));
  // A hint-bar span tagged data-plugin-hint="true" (index.html) is any
  // interrupt-owned shortcut, not just the two built-in ones — a future
  // interrupt plugin's own hint-bar entry gets this same auto-hide behavior
  // by adding the attribute, no core code changes needed.
  // Per-item visibility, independent of the whole-bar H toggle above — an
  // item hidden here just doesn't show in the bar; the key itself still
  // works, and HELP > SHORTCUTS (setup-settings.js) always lists every
  // item regardless, since that's a reference of what the app can do, not
  // a mirror of what's currently decluttered off the live bar.
  const hidden = display.hintBarHidden || [];
  Array.from(hintBarEl.children).forEach((span) => {
    const key = span.dataset.hintKey;
    const hideForPlugin = span.dataset.pluginHint === 'true' ? !registeredHintKeys.has(key) : false;
    const hideForCompact = S.config.display.hintBarCompact !== false && span.dataset.hintSecondary === 'true';
    span.classList.toggle('hidden', hidden.includes(key) || hideForPlugin || hideForCompact);
  });
}

export function toggleHintBar() {
  S.config.display.hintBar = S.config.display.hintBar === false ? true : false;
  applyHintBarState();
  saveConfigDebounced(600, { skipUndo: true });
  flashMessage(`HINT BAR: ${S.config.display.hintBar === false ? 'OFF' : 'ON'}`, 'hintBarFlashTimer');
}

// Per-theme picture "personality" — a passive multiplier layered on top of
// the user's own CRT sliders (DISPLAY > PICTURE), not a replacement for
// them: the sliders themselves, and S.config.crtIntensity on disk, are
// untouched — turning CURVATURE up to 100 still means "fully curved" on
// every theme, this just shifts what 0-100 renders as by default so the era
// reads passively during ordinary viewing, not only at tune-in/idle. Supplied
// by the active theme pack's `crtBias` field (registerThemePack, plugins.js)
// — a color-only pack simply omits it, same as no bias at all.
// `curvatureFloor` is additive (not multiplicative) since curvature's own
// default is 0 — a multiplier on zero would still be zero, so
// uhf-public-access-80s (the one era that should look faintly curved/warped
// even before the user touches the slider) needs a floor instead.
function crtBias() {
  // DISPLAY > PICTURE > "IGNORE THEME BIAS" opts out of every pack's
  // passive crtBias shift, falling back to the sliders' own raw 0-100
  // values with no per-theme multiplier — a user override for a theme
  // pack field that was previously entirely fixed by the pack.
  if (S.config.display?.ignoreThemeCrtBias) return null;
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber, S.isSetupOpen));
  return (pack && pack.crtBias) || null;
}

export function applyCrtState() {
  crtContainer.classList.toggle('crt-off', S.config.crtEnabled === false);
  const ci = S.config.crtIntensity || {};
  const bias = crtBias();
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  const scanlines = clamp01(((ci.scanlines != null ? ci.scanlines : 100) / 100) * (bias ? bias.scanlines : 1));
  const vignette = clamp01(((ci.vignette != null ? ci.vignette : 100) / 100) * (bias ? bias.vignette : 1));
  const grain = clamp01(((ci.grain != null ? ci.grain : 100) / 100) * (bias ? bias.grain : 1));
  const flickerPct = clamp01(((ci.flicker != null ? ci.flicker : 50) / 100) * (bias ? bias.flicker : 1));
  const curvature = clamp01(Math.max(
    (ci.curvature != null ? ci.curvature : 0) / 100,
    bias ? bias.curvatureFloor / 100 : 0,
  ));

  const applyTo = (el) => {
    el.style.setProperty('--crt-scanlines-opacity', scanlines);
    el.style.setProperty('--crt-vignette-opacity', vignette);
    el.style.setProperty('--crt-grain-opacity', grain * 0.05);
    // 100 = the effect's original full intensity (0.025/0.04 opacity peaks),
    // 50 (default) = toned down by half, 0 = off.
    el.style.setProperty('--crt-flicker-peak1', flickerPct * 0.025);
    el.style.setProperty('--crt-flicker-peak2', flickerPct * 0.04);
    // 0 (default) = flat corners, no curved-tube look at all — off unless the
    // user turns it up (or a theme's curvatureFloor sets a baseline), unlike
    // the other four which default to "on."
    el.style.setProperty('--crt-curvature', curvature);
    el.style.setProperty('--crt-curvature-vignette-opacity', curvature * 0.55);
  };

  applyTo(crtContainer);
  // Setup screen's own live picture-preview swatch (DISPLAY > PICTURE) —
  // same custom properties, mirrored onto a second element so dragging a
  // slider (or switching themes) is visible without leaving setup to check
  // the real screen. Also mirrors the crt-off toggle so the swatch goes
  // dark (no effects) when CRT is globally disabled — it would be confusing
  // if the preview still showed scanlines/vignette while the real screen
  // had them turned off.
  if (crtPreviewEl) {
    applyTo(crtPreviewEl);
    crtPreviewEl.classList.toggle('crt-off', S.config.crtEnabled === false);
  }
  // Whole-screen CRT overlay (DISPLAY > CRT EFFECT INTENSITY > "overlay
  // whole screen") — same custom properties mirrored a third time so its
  // own copy of the effect layers (index.html) matches whatever the
  // sliders are set to, same as the two mirrors above.
  if (screenCrtOverlayEl) {
    applyTo(screenCrtOverlayEl);
    screenCrtOverlayEl.classList.toggle(
      'hidden',
      S.config.crtIntensity?.overlayScope !== 'wholeScreen' || S.config.crtEnabled === false,
    );
  }
}

// Same slider->CSS-custom-property mechanism as applyCrtState, but for a
// picture-filter chain on the player element instead of the CRT texture
// layers (see #player's `filter` rule in tv.css).
const PICTURE_PRESETS = {
  standard: { brightness: 1, contrast: 1, saturate: 1 },
  vivid: { brightness: 1.05, contrast: 1.15, saturate: 1.3 },
  cinema: { brightness: 0.95, contrast: 1.08, saturate: 0.85 },
};
const PICTURE_ORDER = ['standard', 'vivid', 'cinema'];

export function applyPictureMode() {
  const preset = PICTURE_PRESETS[S.config.pictureMode] || PICTURE_PRESETS.standard;
  crtContainer.style.setProperty('--pic-brightness', preset.brightness);
  crtContainer.style.setProperty('--pic-contrast', preset.contrast);
  crtContainer.style.setProperty('--pic-saturate', preset.saturate);
}

export function cyclePictureMode() {
  const idx = PICTURE_ORDER.indexOf(S.config.pictureMode || 'standard');
  const next = PICTURE_ORDER[(idx + 1) % PICTURE_ORDER.length];
  S.config.pictureMode = next;
  applyPictureMode();
  saveConfigDebounced(600, { skipUndo: true });
  pushRemoteState();
  flashMessage(`PICTURE MODE: ${next.toUpperCase()}`, 'pictureModeFlashTimer');
}

// 'contain' (default, today's letterbox/pillarbox-safe behavior) vs
// 'stretch' — a deliberately badly-distorted "fill the tube" mode, the retro
// cable-box joke of a 4:3 CRT stretching a mismatched-aspect signal — vs
// 'fill', a real modern-TV "zoom"/"crop" mode: scales content up to cover
// the screen edge-to-edge with no distortion and no letterbox bars, cropping
// whatever overflows top/bottom or left/right instead. Same class-on-.crt/
// CSS-rule mechanism as the guide/power-off #player overrides already in
// guide.css/overlays.css (see .aspect-stretch/.aspect-fill in tv.css).
const ASPECT_ORDER = ['contain', 'stretch', 'fill'];

// Per-channel aspect override (ch.aspectRatio, CHANNELS tab OPTIONS panel —
// see setup-channels.js) reuses the same contain/stretch/fill vocabulary as
// the box-wide cycleAspectMode() above, plus a handful of named crop ratios
// that force the content into that shape instead of just letterboxing/
// cropping to whatever the screen's own aspect happens to be — e.g. a
// 4:3-shot show on an otherwise-widescreen box, or a deliberate cinemascope
// look. '' / null / any unrecognized value means "inherit S.config.aspectMode",
// same fallback style as ch.volume/ch.color.
const CROP_RATIOS = { '4:3': 4 / 3, '1:1': 1, '2.35:1': 2.35 };

export const CHANNEL_ASPECT_OPTIONS = [
  { value: '', label: 'INHERIT (BOX DEFAULT)' },
  { value: 'contain', label: 'STANDARD (SAFE)' },
  { value: 'stretch', label: 'STRETCH (DISTORT TO FILL)' },
  { value: 'fill', label: 'FILL (CROP, NO DISTORTION)' },
  { value: '4:3', label: 'CROP TO 4:3' },
  { value: '1:1', label: 'CROP TO 1:1 (SQUARE)' },
  { value: '2.35:1', label: 'CROP TO 2.35:1 (CINEMASCOPE)' },
];

function effectiveAspectSetting(ch) {
  return (ch && ch.aspectRatio) || S.config.aspectMode || 'contain';
}

// Maps an effective aspect setting to the object-fit semantics it renders
// with — a named crop ratio always crops (like 'fill') once it's been
// resolved down to a target box (see applyTvBezel's targetBox).
function cssFitFor(mode) {
  if (mode === 'fill' || CROP_RATIOS[mode]) return 'cover';
  if (mode === 'stretch') return 'fill';
  return 'contain';
}

export function applyAspectMode() {
  crtContainer.classList.toggle('aspect-stretch', S.config.aspectMode === 'stretch');
  crtContainer.classList.toggle('aspect-fill', S.config.aspectMode === 'fill');
}

export function cycleAspectMode() {
  const idx = ASPECT_ORDER.indexOf(S.config.aspectMode || 'contain');
  const next = ASPECT_ORDER[(idx + 1) % ASPECT_ORDER.length];
  S.config.aspectMode = next;
  applyAspectMode();
  saveConfigDebounced(600, { skipUndo: true });
  pushRemoteState();
  flashMessage(`ASPECT: ${next.toUpperCase()}`, 'aspectModeFlashTimer');
}

// Standard object-fit:contain math — the browser computes this internally
// for #player's own native letterboxing, but there's no CSS selector for
// "the empty bars around a contain-fit video," so a bezel that needs to
// fill exactly that space has to replicate the same math itself and size
// #player explicitly instead of relying on object-fit alone.
function computeContainedRect(containerW, containerH, videoW, videoH) {
  const containerAspect = containerW / containerH;
  const videoAspect = videoW / videoH;
  let width, height;
  if (videoAspect > containerAspect) {
    width = containerW;
    height = containerW / videoAspect;
  } else {
    height = containerH;
    width = containerH * videoAspect;
  }
  return { left: (containerW - width) / 2, top: (containerH - height) / 2, width, height };
}

// General object-fit math for fitting a contentW×contentH box inside an
// arbitrary `box` rect (not necessarily the full container) — the same
// contain/cover scaling the browser does natively, but computed by hand so
// it can be applied twice in a row: once to fit a named crop ratio's shape
// inside the border's safe area (targetBox, applyTvBezel), then again to
// crop the actual video into that shape.
function computeFitRect(box, contentW, contentH, fit) {
  if (fit === 'fill') return { left: box.left, top: box.top, width: box.width, height: box.height };
  const scale = fit === 'cover'
    ? Math.max(box.width / contentW, box.height / contentH)
    : Math.min(box.width / contentW, box.height / contentH);
  const width = contentW * scale;
  const height = contentH * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

// A theme pack without its own declared `safeAreaPct` (registerThemePack,
// plugins.js) still gets a modest auto inset once its border is shown —
// otherwise "auto-adjust content to fit within the border" would do nothing
// for every existing theme pack, none of which declare one today. Border art
// is assumed full-bleed to the container edge either way (tv-bezel is
// inset:0, tv.css) — only the video content itself shrinks to clear it.
const DEFAULT_SAFE_AREA_PCT = { top: 0.04, right: 0.04, bottom: 0.04, left: 0.04 };
const ZERO_SAFE_AREA = { top: 0, right: 0, bottom: 0, left: 0 };

// A mismatch this small (near-16:9 content — a lot of "4:3" source video is
// actually already very close, or a widescreen film is 1.85:1 vs the
// container's 1.777:1) produces a pillarbox/letterbox bar too thin for any
// border design's corner brackets/edge detail to read as intentional — it'd
// just clip a sliver of the art. Below this, treat it as "no border" instead
// of showing a barely-there strip.
const MIN_BEZEL_MARGIN_PX = 24;

// Retro TV bezel/border around non-16:9 content (active theme pack's
// `borderImage`, registerThemePack — see plugins.js) — called from
// playback.js's onMeta handler once player.videoWidth/videoHeight are real.
// Purely additive: with no active pack/border, in aspect-stretch/aspect-fill
// mode (nothing to frame either way — stretch distorts to fill, fill crops
// to fill — see cycleAspectMode above), or with MOVIE MODE on (still the
// same safe letterbox/pillarbox math, just plain black bars instead of the
// decorative frame — see the DISPLAY tab checkbox, setup-settings.js), both
// #player and the bezel reset to exactly today's default look.
export function applyTvBezel(videoWidth, videoHeight, ch) {
  if (!videoWidth || !videoHeight) {
    player.style.left = '';
    player.style.top = '';
    player.style.width = '';
    player.style.height = '';
    player.style.objectFit = '';
    player.style.clipPath = '';
    tvBezelEl.classList.add('hidden');
    tvBezelEl.classList.remove('default-frame');
    tvBezelEl.style.backgroundImage = '';
    return;
  }

  const effective = effectiveAspectSetting(ch);
  const ratio = CROP_RATIOS[effective];
  const containerW = crtContainer.clientWidth;
  const containerH = crtContainer.clientHeight;

  // A border is only worth showing when the effective mode actually leaves
  // letterbox space to frame — plain 'fill'/'stretch' cover the screen
  // edge-to-edge with nothing to decorate. 'contain' additionally needs a
  // real margin (a near-16:9 source produces a bar too thin for any border
  // art to read as intentional — see MIN_BEZEL_MARGIN_PX above). A forced
  // crop ratio skips that check: picking one is a deliberate "frame this
  // like a movie poster" choice, so even a slim margin should still show it.
  let borderEligible = !!ratio;
  if (effective === 'contain') {
    const rawRect = computeContainedRect(containerW, containerH, videoWidth, videoHeight);
    borderEligible = Math.max(rawRect.left, rawRect.top) >= MIN_BEZEL_MARGIN_PX;
  }

  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber, S.isSetupOpen));
  const borderImage = pack && borderEligible && !S.config.display.movieMode ? pack.borderImage : null;

  // Content auto-shrinks/repositions to clear the border's safe area only
  // while a border is actually shown — with no pack/border, or in
  // fill/stretch mode, the video uses the full screen exactly as before.
  // DISPLAY > PICTURE MODE & ASPECT > "BEZEL SAFE AREA" scales whichever
  // safe-area percentages are in play (the pack's own, or the DEFAULT_SAFE_
  // AREA_PCT fallback) — 100 (default) reproduces exactly what the theme
  // pack declares, unchanged from before this override existed.
  const insetScale = (S.config.display.bezelInsetScale != null ? S.config.display.bezelInsetScale : 100) / 100;
  const basePct = borderImage ? (pack.safeAreaPct || DEFAULT_SAFE_AREA_PCT) : ZERO_SAFE_AREA;
  const safeAreaPct = insetScale === 1 ? basePct : {
    top: basePct.top * insetScale,
    right: basePct.right * insetScale,
    bottom: basePct.bottom * insetScale,
    left: basePct.left * insetScale,
  };
  const availableRect = {
    left: containerW * safeAreaPct.left,
    top: containerH * safeAreaPct.top,
    width: containerW * (1 - safeAreaPct.left - safeAreaPct.right),
    height: containerH * (1 - safeAreaPct.top - safeAreaPct.bottom),
  };

  // A named crop ratio first carves out its own shape (letterboxed within
  // the safe area, same as 'contain'), then the video is cropped to fill
  // that shape exactly — two passes of the same fit math. Every other mode
  // just fits straight into the safe area.
  const targetBox = ratio ? computeFitRect(availableRect, ratio, 1, 'contain') : availableRect;
  const finalRect = computeFitRect(targetBox, videoWidth, videoHeight, cssFitFor(effective));

  player.style.left = `${finalRect.left}px`;
  player.style.top = `${finalRect.top}px`;
  player.style.width = `${finalRect.width}px`;
  player.style.height = `${finalRect.height}px`;
  // finalRect already IS the fitted/cropped box (computeFitRect did the
  // contain/cover math by hand) — 'fill' just stretches #player's content
  // to exactly match it, a no-op for contain/cover since those rects were
  // built preserving the video's own aspect ratio, and the actual "distort"
  // behavior for stretch mode (whose rect is the raw, non-aspect-matched box).
  player.style.objectFit = 'fill';
  // A named crop ratio's 'cover' pass (above) deliberately sizes #player
  // bigger than targetBox — that's what makes it a crop instead of a
  // letterbox. .crt's own overflow:hidden only clips at the *container*
  // edge, though, which is only the same boundary as targetBox for a plain
  // 'fill'/no-ratio crop; a ratio box sitting inside the safe area is
  // smaller than that, so without this the oversized video bleeds straight
  // through the border margin instead of stopping at the ratio box's own
  // edges. clip-path insets are relative to #player's own (already
  // oversized) box, so translate targetBox's container-relative edges into
  // offsets from #player's edges first.
  if (ratio) {
    const insetTop = targetBox.top - finalRect.top;
    const insetLeft = targetBox.left - finalRect.left;
    const insetRight = (finalRect.left + finalRect.width) - (targetBox.left + targetBox.width);
    const insetBottom = (finalRect.top + finalRect.height) - (targetBox.top + targetBox.height);
    player.style.clipPath = `inset(${insetTop}px ${insetRight}px ${insetBottom}px ${insetLeft}px)`;
  } else {
    player.style.clipPath = '';
  }

  if (!borderImage) {
    tvBezelEl.classList.add('hidden');
    tvBezelEl.classList.remove('default-frame');
    tvBezelEl.style.backgroundImage = '';
    return;
  }
  tvBezelEl.classList.remove('hidden');
  if (borderImage === true) {
    // A pack can enable a border without shipping its own image — the
    // plain CSS-drawn fallback frame (tv.css) covers that case.
    tvBezelEl.classList.add('default-frame');
    tvBezelEl.style.backgroundImage = '';
  } else {
    tvBezelEl.classList.remove('default-frame');
    tvBezelEl.style.backgroundImage = `url("${borderImage}")`;
  }
}


// A block can optionally carry its own accent colors (block.theme.accent/
// accent2/staticTint, set via the THEME button in buildSchedulePanel,
// setup-schedule.js) — applied here as CSS custom properties the same way
// applyPictureMode/applyCrtState already drive their sliders, consumed by
// var(--block-accent, var(--gold))-style fallbacks in overlays.css so an
// unthemed block (the overwhelming default) looks exactly like it did
// before this existed. Uses removeProperty rather than setting to a
// box-theme color directly, so the CSS fallback chain (not a copied value)
// is what makes an unthemed block track the box theme/analog-90s palette.
export function applyBlockTheme(block) {
  const theme = block && block.theme;
  if (theme && theme.accent) crtContainer.style.setProperty('--block-accent', theme.accent);
  else crtContainer.style.removeProperty('--block-accent');
  if (theme && theme.accent2) crtContainer.style.setProperty('--block-accent2', theme.accent2);
  else crtContainer.style.removeProperty('--block-accent2');
}

export function applyChannelIdentity(ch) {
  const identity = ch && ch.broadcastIdentity;
  if (identity && identity.accent) crtContainer.style.setProperty('--channel-accent', identity.accent);
  else crtContainer.style.removeProperty('--channel-accent');
  if (identity && identity.accent2) crtContainer.style.setProperty('--channel-accent2', identity.accent2);
  else crtContainer.style.removeProperty('--channel-accent2');
}

function tickVhsTimestamp() {
  const d = new Date(viewNow());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  vhsTimestampEl.textContent = `▶ REC ${hh}:${mm}:${ss}`;
}

// Toggles the tape-sourced look (tracking noise, chroma fringe, REC
// timestamp burn-in) for a channel, mirroring applyBlockTheme's reset/apply
// discipline: called with null on every tune so the look never bleeds into
// a channel tuned to right after a VHS one, then re-applied only if the
// tune actually reaches live playback.
export function applyVhsQuality(ch) {
  const on = !!(ch && ch.vhsQuality);
  crtContainer.classList.toggle('vhs-quality', on);
  clearInterval(S.vhsTimestampTimer);
  S.vhsTimestampTimer = null;
  if (on) {
    tickVhsTimestamp();
    S.vhsTimestampTimer = setInterval(tickVhsTimestamp, 1000);
  }
}

// Cycles OFF -> 30 -> 60 -> 90 -> 120 (minutes), arming a one-shot power-off
// — a per-viewing-session control like a real remote's sleep button, not
// persisted in config. Reuses the same crtToggleFlash confirmation pattern
// as toggleCrt().
const SLEEP_OPTIONS = [0, 30, 60, 90, 120];
export function cycleSleepTimer() {
  const idx = SLEEP_OPTIONS.indexOf(S.sleepMinutes || 0);
  const next = SLEEP_OPTIONS[(idx + 1) % SLEEP_OPTIONS.length];
  S.sleepMinutes = next;
  clearTimeout(S.sleepTimer); S.sleepTimer = null;
  if (next > 0) {
    S.sleepTimer = setTimeout(() => { if (S.isPoweredOn) powerOff(); }, next * 60000);
  }
  flashMessage(next > 0 ? `SLEEP TIMER: ${next} MIN` : 'SLEEP TIMER: OFF', 'sleepTimerFlashTimer');
}

export function toggleCrt() {
  S.config.crtEnabled = S.config.crtEnabled === false ? true : false;
  applyCrtState();
  window.api.saveConfig(S.config);
  pushRemoteState();
  flashMessage(`CRT EFFECT: ${S.config.crtEnabled === false ? 'OFF' : 'ON'}`, 'crtFlashTimer');
}

export function powerOff() {
  if (!S.isPoweredOn) return;
  S.isPoweredOn = false;

  clearTimeout(S.breakTimer);
  clearTimeout(S.blockBoundaryTimer);
  clearTimeout(S.sleepTimer); S.sleepTimer = null;
  runCoreHooks('power-off');
  triviaCardEl.classList.add('hidden');
  stationIdBarEl.classList.remove('show');
  crtToggleFlash.classList.remove('show');
  cancelUpNextBar();
  cancelAllInterrupts();
  resetActiveBreakState();
  stopShuttle();
  clearTimeout(S.idleTimer); S.idleTimer = null;
  clearTimeout(S.guideHideTimer); guideOverlay.classList.add('hidden');
  clearTimeout(S.entryTimer); S.entryBuffer = ''; channelEntryEl.classList.add('hidden');
  shortcutsOverlayEl.classList.add('hidden');
  // The logo-bug burn-in ghost's own tick timer (playback.js) — no reason to
  // keep polling every 15s while the screen is off; powerOn's tuneToChannel
  // call re-arms it (applyLogoBugGhost) same as every other tune.
  clearInterval(S.logoBugBurnTimer); S.logoBugBurnTimer = null;

  sfxPowerOff();
  player.pause();
  overlayAudioEntries().forEach((src) => src.el.pause());

  clearTimeout(S.powerAnimTimer);
  crtContainer.classList.remove('powering-on');
  crtContainer.classList.add('powering-off');
  S.powerAnimTimer = setTimeout(() => {
    crtContainer.classList.remove('powering-off');
    crtContainer.classList.add('power-off');
  }, POWER_OFF_ANIM_MS);
  pushRemoteState();
}

export function powerOn() {
  if (S.isPoweredOn) return;
  S.isPoweredOn = true;

  clearTimeout(S.powerAnimTimer);
  crtContainer.classList.remove('power-off', 'powering-off');
  crtContainer.classList.add('powering-on');
  S.powerAnimTimer = setTimeout(() => crtContainer.classList.remove('powering-on'), POWER_ON_ANIM_MS);

  sfxPowerOn();
  runCoreHooks('power-on');

  // Route back through tuneToChannel (silent — no static burst on power-on)
  // rather than re-deriving position and reapplying gating logic here, so
  // power-on always agrees with a fresh channel-change about broadcast-hours
  // sign-off/sign-on and empty-channel "COMING SOON" — the simulated
  // broadcast never stopped just because the display was off.
  tuneToChannel(S.currentNumber, { silent: true });
  resetIdleTimer();
  overlayAudioEntries().forEach((src) => { if (src.resumeIfNeeded) src.resumeIfNeeded(); });
}

export function resetIdleTimer() {
  clearTimeout(S.idleTimer);
  S.idleTimer = null;
  runCoreHooks('idle-reset');
  if (!S.isPoweredOn || tvScreen.classList.contains('hidden')) return;
  const sb = S.config.autoStandby;
  if (sb && sb.enabled) {
    const ms = Math.max(1, sb.intervalMinutes || 15) * 60000;
    S.idleTimer = setTimeout(onIdleTimeout, ms);
  }
  runCoreHooks('idle-armed');
}

export function onIdleTimeout() {
  if (!guideGrid.classList.contains('hidden')) {
    // Mid-browse counts as "in use" — check again next interval instead
    // of cutting the guide off from under the user.
    resetIdleTimer();
    return;
  }
  powerOff();
}
