import { refreshSfxGainLevel, sfxPowerOff, sfxPowerOn, sfxVolumeTick } from '../core/audio.js';
import { getChannel } from '../core/channels.js';
import { computeSourcePosition, getChannelSchedule, resolveActiveSource } from '../core/schedule.js';
import {
  channelEntryEl, creditsSqueezeVideoEl, crtContainer, crtPreviewEl, crtToggleFlash, guideGrid, guideMuteEl, guideOverlay, hintBarEl, logoBugEl, player,
  screenCrtOverlayEl, shortcutsOverlayEl, stationIdBarEl, triviaCardEl, tvBezelEl, tvScreen,
  vhsTimestampEl, volumeBarFillEl, volumeIndicatorEl,
} from '../core/dom.js';
import { tuneToChannel } from './core.js';
import { cancelUpNextBar, resetActiveBreakState } from './breaks.js';
import { resetCreditsSpeedup } from './broadcast-fx.js';
import { cancelAllInterrupts, getThemePack, interruptEntries, overlayAudioEntries, runCoreHooks } from '../plugin/host.js';
import { POWER_OFF_ANIM_MS, POWER_ON_ANIM_MS, S, viewNow, commitInPlace } from '../core/state.js';
import { stopShuttle } from './timemachine.js';
import { autoHideAfter, getDisplayTitle, settingNumber } from '../core/util.js';
import { effectiveThemeId } from '../display/identity.js';
import { Toast } from '../ui/toast.js';
import { levelerGain } from './leveler.js';
import { currentBakedCrop, currentPictureCrop } from './bars.js';
import { shutsDownPcWithBox, startPcShutdown } from './pc-power.js';

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
// What is on now (when it ends) and what follows, for the phone's NOW/NEXT line.
function remoteNowNext(ch) {
  if (!ch) return { nowEndsAtMs: null, nextTitle: '' };
  try {
    const at = viewNow();
    const entries = getChannelSchedule(ch, at, at + 3 * 3600000);
    return {
      nowEndsAtMs: entries[0] ? entries[0].end : null,
      nextTitle: entries[1] ? getDisplayTitle(entries[1].file) : '',
    };
  } catch (e) {
    return { nowEndsAtMs: null, nextTitle: '' }; // a channel with no readable schedule just has no NEXT line
  }
}

export function pushRemoteState() {
  const ch = getChannel(S.currentNumber);
  window.api.sendRemoteState({
    ...remoteNowNext(ch),
    sleepEndsAtMs: S.sleepEndsAt || null,
    number: S.currentNumber,
    name: ch ? ch.name : null,
    powered: S.isPoweredOn,
    muted: !!S.config.muted,
    volume: typeof S.config.volume === 'number' ? S.config.volume : 1,
    crt: S.config.crtEnabled !== false,
    pictureMode: S.config.pictureMode || 'standard',
    aspectMode: S.config.aspectMode || 'contain',
    audioMode: S.sapMode || 'stereo',
    timeMachineOn: !!S.timeMachineOn,
    shuttleDir: S.shuttleDir || 0,
    // How far behind live the picture is (minutes), for the phone's readout.
    timeOffsetMin: Math.round((S.timeOffsetMs || 0) / 60000),
    // The ceiling the volume keys stop at, so the phone's meter reads against it.
    volumeMax: volumeMax(),
    // The last few channels watched, for a RECENT row on the phone.
    recent: (S.recentChannels || []).filter((n) => n !== S.currentNumber).slice(0, 6).map((n) => {
      const rc = getChannel(n);
      return { number: n, name: rc ? rc.name : null };
    }),
    quickJumpSlots: { ...S.quickJumpSlots },
    // What is actually on screen this second, so a remote can say so rather
    // than only naming the channel. Break-aware on purpose: a phone showing
    // the episode title while a commercial is airing is worse than saying
    // nothing, because it makes the viewer think the remote is stale.
    onAir: S.activeBreakKind ? 'break' : 'content',
    breakKind: S.activeBreakKind || null,
    // The outcome of the last settings patch the companion sent (see
    // onCompanionApplySettings, app.js). Rides along here because the HTTP
    // route that accepted the patch answers before this side has decided
    // anything, so this is the only path by which the phone can learn what
    // really happened without a new IPC channel.
    settingsResult: S.lastCompanionSettingsResult || null,
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
  player.volume = Math.min(1, Math.max(0, master * chMult * kindMult * levelerGain() * (S.tuneFadeGain == null ? 1 : S.tuneFadeGain) * (S.sleepFadeGain == null ? 1 : S.sleepFadeGain)));

  // Credits-squeeze video mode (playback.js's startCreditsSpeedup) plays a
  // real upNext-pool promo with its own audio while #player is force-muted
  // for the sped-up credits — gets the same ad-kind layering `player`
  // itself would get for an upNext bumper (upNext is already one of the
  // isAdKind types above), applied here since applyVolume already re-runs
  // on every volume-relevant event (+/-, mute, channel change) rather than
  // needing its own separate event wiring.
  if (S.creditsSpeedupActive) {
    creditsSqueezeVideoEl.volume = Math.min(1, Math.max(0, master * chMult * (typeof S.config.adVolume === 'number' ? S.config.adVolume : 1)));
  }

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
  // Same reasoning as applyVolume's own credits-squeeze-video handling
  // above — the promo is the one thing actually making sound while
  // #player is force-muted for the sped-up credits, so the box's own mute
  // toggle (M key) needs to reach it too, not just #player/overlay sources.
  if (S.creditsSpeedupActive) creditsSqueezeVideoEl.muted = player.muted;
  refreshSfxGainLevel();
}

export function toggleMute() {
  S.config.muted = !player.muted;
  applyMuteState();
  // Same reasoning as playback.js's lastChannel writes — a remote-control
  // convenience toggled from the TV screen, not a setup edit worth burying
  // real config changes under on the undo stack.
  commitInPlace({ type: 'settings.set', path: ['muted'], value: S.config.muted }, { skipUndo: true });
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
// Exported so any feature that needs a one-line on-screen confirmation gets
// the same transient centre-screen readout the CRT/picture-mode toggles
// already use, rather than each growing its own overlay element. `timerKey`
// names that caller's own auto-hide timer (a kit Toast key), so two
// features flashing near each other don't cancel one another's.
export function flashMessage(text, timerKey) {
  Toast(text, { element: crtToggleFlash, key: timerKey, duration: 1500 });
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

// SETTINGS › System › Tuning & controls: step size and ceiling for the volume
// keys. Callers pass +/-0.1; only the sign matters.
export function volumeMax() {
  const pct = settingNumber(S.config.controls && S.config.controls.volumeMaxPct);
  return pct != null ? Math.min(100, Math.max(10, pct)) / 100 : 1;
}

function volumeStep() {
  const pct = settingNumber(S.config.controls && S.config.controls.volumeStepPct);
  return pct != null ? Math.min(25, Math.max(1, pct)) / 100 : 0.1;
}

// "Remember each channel's volume" (SETTINGS › System › Tuning & controls):
// the level you left a channel at comes back when you tune to it. Kept in its
// own host-local key so a volume change doesn't make paired TVs refetch the
// whole lineup.
function rememberVolumeOn() {
  return !!(S.config.controls && S.config.controls.rememberChannelVolume);
}

function rememberChannelVolume() {
  if (!rememberVolumeOn() || S.currentNumber == null) return;
  const next = { ...(S.config.channelVolumes || {}), [S.currentNumber]: S.config.volume };
  S.config.channelVolumes = next;
  commitInPlace({ type: 'settings.set', path: ['channelVolumes'], value: next }, { skipUndo: true });
}

// Called by every tune: the remembered level for this channel, then the
// optional fade-in from silence (tuneFadeInMs) so a loud start is softened.
export function applyTuneVolume(number) {
  const remembered = rememberVolumeOn() && S.config.channelVolumes ? S.config.channelVolumes[number] : null;
  if (typeof remembered === 'number' && remembered >= 0 && remembered <= 1 && remembered !== S.config.volume) {
    S.config.volume = Math.min(volumeMax(), remembered);
    volumeBarFillEl.style.width = `${Math.round((S.config.volume / volumeMax()) * 100)}%`;
  }
  const fadeMs = Number(S.config.controls && S.config.controls.tuneFadeInMs);
  cancelAnimationFrame(S.tuneFadeRAF);
  if (!(fadeMs > 0)) { S.tuneFadeGain = 1; applyVolume(); return; }
  const start = performance.now();
  S.tuneFadeGain = 0;
  applyVolume();
  const step = (now) => {
    const t = Math.min(1, (now - start) / fadeMs);
    S.tuneFadeGain = t * t;
    applyVolume();
    if (t < 1) S.tuneFadeRAF = requestAnimationFrame(step);
  };
  S.tuneFadeRAF = requestAnimationFrame(step);
}

export function adjustVolume(delta) {
  const current = typeof S.config.volume === 'number' ? S.config.volume : 1;
  const max = volumeMax();
  S.config.volume = Math.min(max, Math.max(0, Math.round((current + Math.sign(delta) * volumeStep()) * 100) / 100));
  applyVolume();
  if (delta > 0 && player.muted) {
    S.config.muted = false;
    applyMuteState();
  }
  commitInPlace([
    { type: 'settings.set', path: ['volume'], value: S.config.volume },
    { type: 'settings.set', path: ['muted'], value: S.config.muted },
  ], { skipUndo: true });
  sfxVolumeTick(delta > 0);
  rememberChannelVolume();

  volumeBarFillEl.style.width = `${Math.round((S.config.volume / max) * 100)}%`;
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
  commitInPlace({ type: 'settings.set', path: ['display','hintBar'], value: S.config.display.hintBar }, { skipUndo: true });
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
  commitInPlace({ type: 'settings.set', path: ['pictureMode'], value: S.config.pictureMode }, { skipUndo: true });
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
  commitInPlace({ type: 'settings.set', path: ['aspectMode'], value: S.config.aspectMode }, { skipUndo: true });
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
// ---------- How much of the screen the picture may use (docs/design/11 §2.2) ----------
// Normally the whole CRT container. In TV mode with the guide docked, the strip
// along the bottom takes part of the screen and the picture shrinks into what
// is left instead of sitting behind it. guide.js publishes that height as
// --guide-picture-h on the container.
//
// Deliberately one number feeding the EXISTING framing math rather than a CSS
// rule that overrides #player's geometry: the safe area, a named crop ratio and
// the bezel art are all computed from the container's height, so shrinking that
// height keeps the bezel framing the picture correctly at its new size. An
// !important geometry override (the way full-page mode shrinks into its corner
// preview) would have left the bezel drawn for the old, larger picture.
export function pictureAreaHeight() {
  const containerH = crtContainer.clientHeight;
  const published = parseFloat(getComputedStyle(crtContainer).getPropertyValue('--guide-picture-h'));
  return Number.isFinite(published) && published > 0 ? Math.min(published, containerH) : containerH;
}

// Re-frames the picture after the area it may use changed — the guide docking,
// undocking, being resized or closing. A no-op before any metadata has arrived,
// since there is nothing to frame yet.
export function refreshPictureArea() {
  if (!player.videoWidth || !player.videoHeight) return;
  applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
}

// Frames the picture, then tells the logo bug where the picture ended up so a
// bug anchored to the picture (DISPLAY › Logo bug) can follow it.
export function applyTvBezel(videoWidth, videoHeight, ch) {
  applyTvBezelInner(videoWidth, videoHeight, ch);
  window.dispatchEvent(new Event('reruntv:picture-framed'));
}

function applyTvBezelInner(videoWidth, videoHeight, ch) {
  if (!videoWidth || !videoHeight) {
    S.pictureRect = null;
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

  let effective = effectiveAspectSetting(ch);
  const containerW = crtContainer.clientWidth;
  // Not clientHeight: the docked guide takes the bottom of the screen in TV
  // mode, and the picture is framed inside what is left (see pictureAreaHeight).
  const containerH = pictureAreaHeight();
  // Auto-fill widescreen (DISPLAY › Picture): content wider than the screen
  // would sit between black bars, so crop its sides to fill instead — but
  // only when that costs no more than the configured share of the picture.
  // A channel's own aspect override and the stretch/fill modes win as usual.
  const display = S.config.display || {};
  // Baked-in black bars (DISPLAY › Picture › Remove baked-in black bars, found
  // by ffmpeg in main — bars.js): the picture inside the frame is what gets
  // fitted below, and the bars around it are clipped away. contentW/H is that
  // picture in video pixels; the whole frame when there are no bars.
  const baked = currentBakedCrop();
  const contentW = baked ? videoWidth * baked.w : videoWidth;
  const contentH = baked ? videoHeight * baked.h : videoHeight;
  if (effective === 'contain' && !(ch && ch.aspectRatio) && display.autoFillWidescreen) {
    const videoAspect = contentW / contentH;
    const screenAspect = containerW / containerH;
    const maxCrop = Math.min(0.6, Math.max(0.02, (Number.isFinite(display.autoFillMaxCropPct) ? display.autoFillMaxCropPct : 30) / 100));
    if (videoAspect > screenAspect && (1 - screenAspect / videoAspect) <= maxCrop) effective = 'fill';
  }
  const ratio = CROP_RATIOS[effective];

  // A border is only worth showing when the effective mode actually leaves
  // letterbox space to frame — plain 'fill'/'stretch' cover the screen
  // edge-to-edge with nothing to decorate. 'contain' additionally needs a
  // real margin (a near-16:9 source produces a bar too thin for any border
  // art to read as intentional — see MIN_BEZEL_MARGIN_PX above). A forced
  // crop ratio skips that check: picking one is a deliberate "frame this
  // like a movie poster" choice, so even a slim margin should still show it.
  let borderEligible = !!ratio;
  if (effective === 'contain') {
    const rawRect = computeContainedRect(containerW, containerH, contentW, contentH);
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
  const finalRect = computeFitRect(targetBox, contentW, contentH, cssFitFor(effective));
  // The element itself: just finalRect, or — with baked bars — the whole
  // frame scaled so its picture lands exactly on finalRect.
  let elRect = finalRect;
  if (baked) {
    const sx = finalRect.width / contentW;
    const sy = finalRect.height / contentH;
    elRect = {
      left: finalRect.left - baked.x * videoWidth * sx,
      top: finalRect.top - baked.y * videoHeight * sy,
      width: videoWidth * sx,
      height: videoHeight * sy,
    };
  }

  // The part of the picture actually on screen (a cropped picture overhangs
  // the box it fills), for anything that should sit on the picture itself.
  const shown = ratio ? targetBox : finalRect;
  // With the bars left in, the picture is still the box inside the frame.
  let onScreen = shown;
  const bars = baked ? null : currentPictureCrop();
  if (bars) {
    const left = Math.max(shown.left, finalRect.left + bars.x * finalRect.width);
    const top = Math.max(shown.top, finalRect.top + bars.y * finalRect.height);
    const right = Math.min(shown.left + shown.width, finalRect.left + (bars.x + bars.w) * finalRect.width);
    const bottom = Math.min(shown.top + shown.height, finalRect.top + (bars.y + bars.h) * finalRect.height);
    if (right > left && bottom > top) onScreen = { left, top, width: right - left, height: bottom - top };
  }
  const pLeft = Math.max(0, onScreen.left);
  const pTop = Math.max(0, onScreen.top);
  S.pictureRect = {
    left: pLeft,
    top: pTop,
    width: Math.max(1, Math.min(containerW, onScreen.left + onScreen.width) - pLeft),
    height: Math.max(1, Math.min(containerH, onScreen.top + onScreen.height) - pTop),
    containerW,
    containerH,
  };
  player.style.left = `${elRect.left}px`;
  player.style.top = `${elRect.top}px`;
  player.style.width = `${elRect.width}px`;
  player.style.height = `${elRect.height}px`;
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
  if (ratio || baked) {
    // `shown` is what stays visible: the ratio box, or the picture sans bars.
    const insetTop = shown.top - elRect.top;
    const insetLeft = shown.left - elRect.left;
    const insetRight = (elRect.left + elRect.width) - (shown.left + shown.width);
    const insetBottom = (elRect.top + elRect.height) - (shown.top + shown.height);
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
    // Progressive tape wear — the more times this channel's current content
    // pool has looped since its source's anchor, the worse the tracking/
    // chroma artifacts get (tv.css scales its fixed opacities by this var).
    // loopCount (computeSourcePosition, schedule.js) is a pure derivation
    // from anchor+duration, not a stored play-count — same "no play-count
    // log" reasoning as the NEW EPISODE/REPEAT bug (playback.js). Clamped
    // to 1 (~7 loops) so a channel that's been running for months doesn't
    // become illegibly noisy.
    const source = resolveActiveSource(ch, viewNow());
    const pos = computeSourcePosition(source, viewNow(), { ignoreContentLost: true });
    const loopCount = (pos && pos.loopCount) || 0;
    // Loop count at which the tape reads as maximally worn — configurable
    // per channel (ch.vhsWearLoops, setup-channels.js) since a channel
    // that's been running for months and one that just started shouldn't
    // necessarily degrade on the same fixed curve. Defaults to the
    // original fixed constant (7) when unset.
    const wearLoops = Math.max(1, ch.vhsWearLoops || 7);
    const degradation = Math.min(1, loopCount / wearLoops);
    crtContainer.style.setProperty('--vhs-degradation', String(degradation));
  } else {
    crtContainer.style.removeProperty('--vhs-degradation');
  }
}

// Cycles OFF -> 30 -> 60 -> 90 -> 120 (minutes), arming a one-shot power-off
// — a per-viewing-session control like a real remote's sleep button, not
// persisted in config. Reuses the same crtToggleFlash confirmation pattern
// as toggleCrt().
const DEFAULT_SLEEP_STEPS = [30, 60, 90, 120];
// Length of the sleep timer's fade-out; 0 = a straight cut. On by default.
function sleepFadeMs() {
  const c = S.config.controls || {};
  if (c.sleepFadeOut === false) return 0;
  return 25000;
}
// The steps are SETTINGS › System › Tuning & controls; OFF is always first.
export function sleepOptions() {
  const steps = S.config.controls && S.config.controls.sleepSteps;
  const valid = Array.isArray(steps) ? steps.filter((n) => Number.isFinite(n) && n > 0) : [];
  return [0, ...(valid.length ? valid : DEFAULT_SLEEP_STEPS)];
}

// A small "SLEEP 4:59" badge over the picture for the last five minutes, so the
// fade-out never comes as a surprise. The timer is wall-clock by design (a
// real TV's sleep button), hence Date.now() and not viewNow().
const SLEEP_BADGE_WINDOW_MS = 5 * 60000;
let sleepBadgeEl = null;
let sleepBadgeTick = null;
export function sleepRemainingMs() {
  return S.sleepEndsAt ? Math.max(0, S.sleepEndsAt - Date.now()) : 0;
}
export function formatSleepRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function updateSleepBadge() {
  const left = sleepRemainingMs();
  if (!S.sleepEndsAt || !S.isPoweredOn || left <= 0 || left > SLEEP_BADGE_WINDOW_MS) {
    if (sleepBadgeEl) sleepBadgeEl.classList.add('hidden');
    if (!S.sleepEndsAt || left <= 0) { clearInterval(sleepBadgeTick); sleepBadgeTick = null; }
    return;
  }
  if (!sleepBadgeEl) {
    sleepBadgeEl = document.createElement('div');
    sleepBadgeEl.className = 'sleep-badge hidden';
    crtContainer.appendChild(sleepBadgeEl);
  }
  sleepBadgeEl.textContent = `SLEEP ${formatSleepRemaining(left)}`;
  sleepBadgeEl.classList.remove('hidden');
}
function stopSleepBadge() {
  S.sleepEndsAt = 0;
  updateSleepBadge();
}

export function cycleSleepTimer() {
  const options = sleepOptions();
  const idx = options.indexOf(S.sleepMinutes || 0);
  const next = options[(idx + 1) % options.length];
  S.sleepMinutes = next;
  stopSleepBadge();
  setTimeout(pushRemoteState, 0); // the phone shows the countdown too
  clearTimeout(S.sleepTimer); S.sleepTimer = null;
  clearTimeout(S.sleepFadeTimer);
  cancelAnimationFrame(S.sleepFadeRAF);
  S.sleepFadeGain = 1;
  applyVolume();
  if (next > 0) {
    S.sleepEndsAt = Date.now() + next * 60000;
    clearInterval(sleepBadgeTick);
    sleepBadgeTick = setInterval(updateSleepBadge, 1000);
    S.sleepTimer = setTimeout(() => {
      if (S.isPoweredOn) powerOff();
      S.sleepFadeGain = 1; // back to full for the next time it's switched on
    }, next * 60000);
    // The last stretch fades the sound out instead of cutting it, like
    // falling asleep to a real TV's sleep timer (SETTINGS › Tuning & controls).
    const fadeMs = sleepFadeMs();
    if (fadeMs > 0 && next * 60000 > fadeMs) {
      S.sleepFadeTimer = setTimeout(() => {
        const begin = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - begin) / fadeMs);
          S.sleepFadeGain = 1 - t;
          applyVolume();
          if (t < 1 && S.isPoweredOn) S.sleepFadeRAF = requestAnimationFrame(step);
        };
        S.sleepFadeRAF = requestAnimationFrame(step);
      }, next * 60000 - fadeMs);
    }
  }
  flashMessage(next > 0 ? `SLEEP TIMER: ${next} MIN` : 'SLEEP TIMER: OFF', 'sleepTimerFlashTimer');
}

export function toggleCrt() {
  S.config.crtEnabled = S.config.crtEnabled === false ? true : false;
  applyCrtState();
  // A watching action, not a setup edit: saved straight away, no undo step.
  commitInPlace({ type: 'settings.set', path: ['crtEnabled'], value: S.config.crtEnabled }, { skipUndo: true, delay: 0 });
  pushRemoteState();
  flashMessage(`CRT EFFECT: ${S.config.crtEnabled === false ? 'OFF' : 'ON'}`, 'crtFlashTimer');
}

// Asks main to hold or release a display wake lock, matching "is this set
// switched on". Powering off is the one state where letting the monitor
// sleep is obviously right — the screen is already showing nothing on
// purpose — so the lock tracks S.isPoweredOn rather than merely "the app is
// running". Host-only: setKeepDisplayAwake isn't part of the LAN viewer's
// api surface (api-contract.js), and a browser tab has no business holding
// its device awake for a page it may not even be showing.
export function applyDisplayWakeLock() {
  if (!window.api || typeof window.api.setKeepDisplayAwake !== 'function') return;
  const wanted = S.isPoweredOn && S.config.keepDisplayAwake?.enabled !== false;
  Promise.resolve(window.api.setKeepDisplayAwake(wanted)).catch(() => {});
}

// `reason` says who is switching the box off: 'user' (the power key, the
// remote's power button, the TV menu — the default), 'standby' (auto standby,
// a TV platform hiding the page) or 'screen' (following the TV's power,
// display/tv-screen.js). Only a deliberate power-off can take the PC down
// with it (SYSTEM › POWER, playback/pc-power.js).
export function powerOff({ reason = 'user' } = {}) {
  if (!S.isPoweredOn) return;
  S.isPoweredOn = false;
  applyDisplayWakeLock();

  clearTimeout(S.breakTimer);
  clearTimeout(S.blockBoundaryTimer);
  clearTimeout(S.sleepTimer); S.sleepTimer = null;
  stopSleepBadge();
  // A fade armed for the sleep timer just cleared would silence the next power-on.
  clearTimeout(S.sleepFadeTimer); S.sleepFadeTimer = null;
  if (S.sleepFadeRAF) { cancelAnimationFrame(S.sleepFadeRAF); S.sleepFadeRAF = null; }
  S.sleepFadeGain = 1;
  runCoreHooks('power-off');
  triviaCardEl.classList.add('hidden');
  stationIdBarEl.classList.remove('show');
  crtToggleFlash.classList.remove('show');
  cancelUpNextBar();
  resetCreditsSpeedup();
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
  if (reason === 'user' && shutsDownPcWithBox()) startPcShutdown({ source: 'power-off', poweredOffBox: true });
}

export function powerOn() {
  if (S.isPoweredOn) return;
  S.isPoweredOn = true;
  applyDisplayWakeLock();

  clearTimeout(S.powerAnimTimer);
  crtContainer.classList.remove('power-off', 'powering-off');
  crtContainer.classList.add('powering-on');
  // A theme with its own sluggish tube-warm-up CSS animation (e.g.
  // wood-console-70s's crt-fx-on-line override) can run longer than the
  // default POWER_ON_ANIM_MS via registerThemePack's optional `powerOnMs`
  // field — otherwise the .powering-on class would be removed mid-animation,
  // cutting the theme's own warm-up look short.
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber, S.isSetupOpen));
  const powerOnMs = (pack && pack.powerOnMs) || POWER_ON_ANIM_MS;
  S.powerAnimTimer = setTimeout(() => crtContainer.classList.remove('powering-on'), powerOnMs);

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
