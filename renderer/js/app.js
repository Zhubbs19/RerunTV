import { S, setConfigNormalizer, viewNow, saveConfigNow, resetUndoBaseline, bumpConfigGeneration, POWER_OFF_ANIM_MS, POWER_ON_ANIM_MS, commitConfigPatch, commitInPlace, dispatch } from './core/state.js';
import { runConfigMigrations } from './core/config-schema.js';
import { randomInterstitialId, getDisplayTitle, settingNumber } from './core/util.js';
import {
  setupScreen, tvScreen, player, staticCanvas, crtContainer, crtToggleFlash, guideGrid, guideSearchEl,
  guideOverlay, channelEntryEl, stationIdBarEl, triviaCardEl, channelFilterEl, shortcutsOverlayEl, detailsOverlayEl,
  previewBannerEl, pluginChannelContainerEl, viewerLiveLinkEl,
  migrationToastEl, migrationToastTextEl, migrationToastDismissBtn,
} from './core/dom.js';
import { showDetailsForCurrentChannel, hideDetailsOverlay } from './tv/details.js';
import { alertDialog, confirmDialog } from './setup/dialogs.js';
import { showOnboarding } from './setup/onboarding.js';
import { applyCustomCss, cancelAllInterrupts, cancelAllScheduledInterrupts, getInterrupt, interruptEntries, loadPlugins, runCoreHooks } from './plugin/host.js';
import {
  foldLogoBugCorner, freshChannel, LOGO_MOTION_PRESETS, normalizeChannel, normalizeDynamicOverlays, parseChannelNumber,
  subChannelsEnabled,
  normalizeLogoBugProfiles, sortedChannels, getChannel,
} from './core/channels.js';
import { getChannelSchedule, resolveActiveCommercials, resolveActiveSource, computeSourcePosition } from './core/schedule.js';
import { resolveBreakAt, boundarySlot } from './core/interstitials.js';
import {
  tuneToChannel, changeChannel, changeFavoriteChannel, jumpToLastChannel, playChannelLive,
  stopChannelScan, toggleChannelScan,
  startScheduleDriftWatchdog,
} from './playback/core.js';
import { cancelUpNextBar, checkBreakState, resetActiveBreakState } from './playback/breaks.js';
import { applyLogoBugPlacement, initMediaSession, showNoSignal } from './playback/broadcast-fx.js';
import {
  showGuideOverlay, updateGuideNowPlaying, openGuideGrid, closeGuideGrid,
  handleGuideGridKey, renderGuideGrid,
} from './guide/guide.js';
import { findLiveViewerLinkChannelType, hideVirtualChannels, isVirtualChannel, showVirtualGuideOverlay, triggerVirtualChannelOk, triggerVirtualChannelKey } from './playback/virtual.js';
import { clearPinBuffer, hidePinLockScreen, popPinDigit, pushPinDigit } from './setup/pin-lock.js';
import { getAudioCtx, playPurchaseConfirmSound, playNoiseBurst } from './core/audio.js';
import {
  enterTimeMachine, exitTimeMachine, restartCurrentShow, startShuttle, shuttlePlay, returnToLive, jumpToNextBreak, jumpToPrevBreak,
} from './playback/timemachine.js';
import {
  applyAspectMode, applyCrtState, applyHintBarState, applyMuteState, applyPictureMode, applyVolume, applyTvBezel,
  adjustVolume, toggleCrt, toggleHintBar, toggleMute, cycleAspectMode, cycleSleepTimer, cyclePictureMode,
  resetIdleTimer, powerOn, powerOff, pushRemoteState, applyDisplayWakeLock, flashMessage,
} from './playback/power.js';
import { saveAirCheck } from './library/airchecks.js';
import { applyDisplayModeSettled } from './display/mode.js';
import { applyTheme, startThemeCheck } from './display/themes.js';
import { initTouchControls } from './tv/touch.js';
import { initUpdateNotice } from './update/notice.js';
import { openTvMenu, handleTvMenuKey } from './tv/menu.js';
import { initUsageMode, installTvScreenRule, isTvMode } from './tv/usage-mode.js';
import { installAudioOutput } from './display/audio-output.js';
import { installTvScreen } from './display/tv-screen.js';
import { applyLeveler } from './playback/leveler.js';
import { applyBakedBars } from './playback/bars.js';
import { handleRecentKey, toggleRecentChannels } from './playback/recent-channels.js';
import { openTimeCalendar } from './playback/time-calendar.js';
import { applyKeyHints, remapKeyboardEvent } from './core/key-remap.js';
import { fillNewSettingDefaults } from './core/setting-defaults.js';
import { installTvSuggestion } from './tv/suggest.js';
import { showTvWizard } from './tv/wizard.js';
import { installGamepad } from './tv/gamepad.js';
import { installTvPlatform } from './tv/platform.js';
import {
  initPersonalState, isFavorite, isHiddenForProfile, personalCommand, setFavorite,
} from './personal/state.js';
import { initDvrScheduler } from './personal/dvr-scheduler.js';
import { exitPromptOpen, installTvInput, routeKeydown } from './tv/input.js';
import { closeBannerHub } from './tv/banner-hub.js';

// Before anything renders: html[data-mode] decides layout and input model for
// the whole app (docs/design/01, contract C1).
initUsageMode();
// Before any media plays, so the first tune already comes out of the chosen
// speakers. The host window only: a LAN viewer plays wherever its browser does.
if (!window.__isViewer) { installAudioOutput(); installTvScreenRule(); }
import { initLibrarySync } from './library/sync.js';
import {
  renderChannelList, renderCommercialsPanel, renderPreemptionWindowsEditor, renderStandbyPanel, renderSettingsPanels, resetSetupTabs,
} from './setup/index.js';

window.addEventListener('error', (e) => {
  console.error('[UNCAUGHT RENDERER ERROR]', e.message, e.filename, e.lineno, e.colno, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason);
});

window.S = S;
window.resolveActiveCommercials = resolveActiveCommercials;
window.resolveActiveSource = resolveActiveSource;
window.computeSourcePosition = computeSourcePosition;
window.resolveBreakAt = resolveBreakAt;
window.boundarySlot = boundarySlot;
window.checkBreakState = checkBreakState;
window.cancelUpNextBar = cancelUpNextBar;
window.playChannelLive = playChannelLive;
// A few core functions plugin settings panels/renderer.js modules need to
// call but can't import directly (different app:// origin, no CORS from
// bundle to plugins — see [[retro_cable_box_plugin_system]] memory). Same
// "expose on window" pattern as tuneToChannel/checkBreakState above.
window.alertDialog = alertDialog;
window.confirmDialog = confirmDialog;
window.getChannel = getChannel;
window.isVirtualChannel = isVirtualChannel;
// getAudioCtx lazily creates+caches S.audioCtx/S.sfxGain on the shared S
// object (window.S, above) — exposed so a plugin's own bespoke sound
// effects can connect into the same AudioContext/mix bus as everything
// else (volume/mute apply to it for free), instead of spinning up a
// second, un-mixed AudioContext of their own.
window.getAudioCtx = getAudioCtx;
// playPurchaseConfirmSound builds on playTone/playNoiseBurst — core
// primitives used 30+ times elsewhere in audio.js, too foundational to
// duplicate into every plugin that wants a "cha-ching" purchase-confirm
// sound — so the composite sound itself is exposed instead, for any plugin
// with an order/purchase flow to use.
window.playPurchaseConfirmSound = playPurchaseConfirmSound;
// playNoiseBurst — another such foundational primitive (22+ other usages),
// exposed for any plugin that wants a short noise-burst stinger of its own.
window.playNoiseBurst = playNoiseBurst;

// See the beforeMigration/applyConfigDefaults call below — shown once per
// boot when the loaded config's shape actually changed, not on every load.
let migrationToastTimer = null;
function showMigrationToast() {
  if (!migrationToastEl) return;
  migrationToastTextEl.textContent = 'Your config was updated for new features — see HELP › WHAT\'S NEW for details.';
  migrationToastEl.classList.remove('hidden');
  clearTimeout(migrationToastTimer);
  migrationToastTimer = setTimeout(() => migrationToastEl.classList.add('hidden'), 12000);
}
if (migrationToastDismissBtn) {
  migrationToastDismissBtn.addEventListener('click', () => {
    clearTimeout(migrationToastTimer);
    migrationToastEl.classList.add('hidden');
  });
}

// ---------- Direct number entry ----------
export function pushDigit(d) {
  if (d === '.') {
    // The sub-channel separator, the way a set-top box's own dash/dot key
    // works: only meaningful after at least one digit, and only once. Typed
    // anywhere else it's ignored rather than starting a nonsense entry.
    if (!S.entryBuffer || S.entryBuffer.includes('.')) return;
    S.entryBuffer += '.';
  } else if (S.entryBuffer.includes('.')) {
    // One sub-channel digit only — 7.1 exists, 7.12 does not (see
    // parseChannelNumber, channels.js).
    if (S.entryBuffer.split('.')[1].length >= 1) return;
    S.entryBuffer += d;
  } else {
    S.entryBuffer += d;
    if (S.entryBuffer.length > 3) S.entryBuffer = S.entryBuffer.slice(-3);
  }
  channelEntryEl.textContent = S.entryBuffer;
  channelEntryEl.classList.remove('hidden');
  channelEntryEl.classList.remove('digit-flash');
  void channelEntryEl.offsetWidth;
  channelEntryEl.classList.add('digit-flash');
  clearTimeout(S.entryTimer);
  const entryDelay = settingNumber(S.config.controls && S.config.controls.entryDelayMs);
  S.entryTimer = setTimeout(commitEntry, entryDelay != null ? Math.min(3000, Math.max(0, entryDelay)) : 800);
}

export function commitEntry() {
  if (S.entryBuffer) {
    // parseChannelNumber handles a trailing separator ("7." reads as 7) and
    // rejects anything that isn't a channel number outright, rather than
    // parseInt's habit of quietly tuning to the leading digits of garbage.
    const target = parseChannelNumber(S.entryBuffer);
    if (Number.isFinite(target)) tuneToChannel(target);
  }
  S.entryBuffer = '';
  channelEntryEl.classList.add('hidden');
}

// ---------- Keyboard controls ----------
// Extracted into a named function (rather than an inline listener callback)
// so the universal remote (a phone browser page relaying button presses via
// IPC — see preload.js's onRemoteCommand and main.js's startRemoteServer)
// can drive the exact same logic through a synthesized event object
// ({key, shiftKey, preventDefault(){}}) instead of duplicating this switch.
export function handleKey(e) {
  if (tvScreen.classList.contains('hidden')) return;

  resetIdleTimer();

  if (!S.isPoweredOn) {
    // Any key wakes it — manual power-off or auto-standby, doesn't matter
    // which. The waking keypress is consumed, not also acted on.
    e.preventDefault();
    powerOn();
    return;
  }

  if (!shortcutsOverlayEl.classList.contains('hidden')) {
    handleTvMenuKey(e);
    return;
  }

  // Checked before the guide-grid branch below so I/Escape closes the
  // details card back to whatever's underneath (the guide, if that's where
  // it was opened from, or live TV otherwise) without also closing the
  // guide itself.
  if (S.pinLockActive) {
    if (e.key === 'Escape') { hidePinLockScreen(); return; }
    if (e.key === 'Backspace') { popPinDigit(); return; }
    if (e.key >= '0' && e.key <= '9') { pushPinDigit(e.key); return; }
    return;
  }

  // Generic keyboard handling for a plugin channel's own modal (an order/
  // success confirmation, etc.) — any modal built inside
  // pluginChannelContainerEl following the
  // data-modal-dismiss/data-modal-confirm convention (see
  // [[retro_cable_box_plugin_system]]) gets Escape-to-dismiss and
  // Enter/Space-to-confirm for free, without app.js needing to know about
  // each plugin's specific modal by name.
  const openPluginModal = pluginChannelContainerEl && pluginChannelContainerEl.querySelector('.preview-modal:not(.hidden)');
  if (openPluginModal) {
    const dismissBtn = openPluginModal.querySelector('[data-modal-dismiss]');
    const confirmBtn = openPluginModal.querySelector('[data-modal-confirm]');
    if (e.key === 'Escape') { (dismissBtn || confirmBtn)?.click(); return; }
    if (e.key === 'Enter' || e.key === ' ') { (confirmBtn || dismissBtn)?.click(); return; }
  }

  if (!detailsOverlayEl.classList.contains('hidden')) {
    if (e.key === 'i' || e.key === 'I' || e.key === 'Escape') hideDetailsOverlay();
    else if (e.key === 'Tab') { e.preventDefault(); detailsOverlayEl.focus(); }
    return;
  }

  if (!guideGrid.classList.contains('hidden')) {
    handleGuideGridKey(e);
    return;
  }

  // Any other focused text field on the TV screen (currently just a plugin
  // channel's own search box) needs to receive normal
  // typing instead of every letter being intercepted as a channel-control
  // shortcut (T/L/S/M/... below). guideSearchEl is deliberately excluded —
  // it already gets this same treatment, with its own Escape/Enter
  // behavior, from handleGuideGridKey above.
  const activeTag = document.activeElement && document.activeElement.tagName;
  if ((activeTag === 'INPUT' || activeTag === 'TEXTAREA') && document.activeElement !== guideSearchEl) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }

  // Escape always closes the time machine outright (same convention as
  // every other overlay in this handler), independent of the T key's
  // enter/commit/close cycle below.
  if (S.timeMachineOn && e.key === 'Escape') {
    exitTimeMachine({ toLive: true });
    return;
  }

  // Touching the remote is how you stop a SCAN on a real box, so any input
  // at all ends it — placed ahead of every branch below so digit entry and
  // shifted combos cancel it too. The SCAN key itself falls through to its
  // own toggle rather than being eaten here.
  if (S.scanTimer != null && e.key !== 'n' && e.key !== 'N') stopChannelScan();

  // The recent-channels card (Shift+Backspace) takes its own keys while up.
  if (handleRecentKey(e)) return;

  if (triggerVirtualChannelKey(S.currentNumber, e.key)) return;

  if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
    S.quickJumpSlots[e.key] = S.currentNumber;
    if (S.personalProfile) personalCommand({ type: 'state.set', key: 'quickJumpSlots', value: S.quickJumpSlots }).catch(() => {});
    showGuideOverlay(S.currentNumber, getChannel(S.currentNumber));
    const guideNow = document.getElementById('guide-now');
    if (guideNow) guideNow.textContent = `⭐ QUICK-JUMP SLOT ${e.key} SAVED!`;
    return;
  }

  if (e.altKey && e.key >= '1' && e.key <= '4') {
    const target = S.quickJumpSlots[e.key];
    if (target != null) tuneToChannel(target);
    return;
  }

  if (e.shiftKey && (e.key === 'm' || e.key === 'M')) {
    const modes = ['stereo', 'mono', 'sap'];
    const idx = (modes.indexOf(S.sapMode) + 1) % modes.length;
    S.sapMode = modes[idx];
    showGuideOverlay(S.currentNumber, getChannel(S.currentNumber));
    const guideNow = document.getElementById('guide-now');
    if (guideNow) guideNow.textContent = `🔊 AUDIO MODE: ${S.sapMode.toUpperCase()}`;
    return;
  }

  if (e.key >= '0' && e.key <= '9') {
    pushDigit(e.key);
    return;
  }
  // The sub-channel separator. Only '.' (including the numpad's decimal
  // key): '-' is already VOLUME DOWN, and taking a working volume key away
  // to gain a second way to type the same separator is a bad trade.
  // pushDigit ignores it unless a number entry is genuinely in progress, so
  // a stray press outside one does nothing rather than opening the overlay.
  // Left free for a plugin hotkey when sub-channels are switched off, rather
  // than silently swallowed by a feature that isn't in use.
  if (e.key === '.' && subChannelsEnabled()) {
    pushDigit('.');
    return;
  }
  switch (e.key) {
    case 'ArrowUp':
    case 'PageUp':
      if (e.shiftKey) changeFavoriteChannel(1); else changeChannel(1);
      break;
    case 'ArrowDown':
    case 'PageDown':
      if (e.shiftKey) changeFavoriteChannel(-1); else changeChannel(-1);
      break;
    case 'Backspace':
      if (e.shiftKey) toggleRecentChannels(); else jumpToLastChannel();
      break;
    case 'ArrowLeft':
      if (S.timeMachineOn) startShuttle(-1);
      break;
    case 'ArrowRight':
      if (S.timeMachineOn) startShuttle(1);
      break;
    // Jump straight to the previous/next break instead of shuttling through
    // content to find one by eye — same bracket convention as "previous/
    // next chapter" in most video players. Time-machine only, same as the
    // shuttle keys above.
    case '[':
      if (S.timeMachineOn) jumpToPrevBreak();
      break;
    case ']':
      if (S.timeMachineOn) jumpToNextBreak();
      break;
    case 't':
    case 'T':
      // Three-way cycle: off -> on; shuttling -> commit the shuttled
      // position (VCR "play"); already on and stopped -> close. Without
      // that last branch T could enter time machine but never leave it,
      // since shuttlePlay() with no active shuttle just re-commits the
      // same position and leaves S.timeMachineOn untouched.
      if (!S.timeMachineOn) enterTimeMachine();
      else if (S.shuttleDir !== 0 || S.scrubPending) shuttlePlay();
      else exitTimeMachine();
      break;
    case 'd':
    case 'D':
      openTimeCalendar();
      break;
    case 'l':
    case 'L':
      returnToLive();
      break;
    case 'j':
    case 'J':
      restartCurrentShow();
      break;
    case ' ':
    case 'Enter':
      if (triggerVirtualChannelOk(S.currentNumber)) { /* handled by a plugin channel's own onOk */ }
      else if (S.timeMachineOn && (S.shuttleDir !== 0 || S.scrubPending)) shuttlePlay();
      else if (S.entryBuffer) commitEntry();
      else {
        const ch = getChannel(S.currentNumber);
        showGuideOverlay(S.currentNumber, ch);
      }
      break;
    case 'g':
    case 'G':
      openGuideGrid();
      break;
    case 'i':
    case 'I':
      showDetailsForCurrentChannel();
      break;
    case 's':
    case 'S':
      showSetupScreen();
      break;
    case 'm':
    case 'M':
      toggleMute();
      break;
    case 'c':
    case 'C':
      toggleCrt();
      break;
    case 'v':
    case 'V':
      cyclePictureMode();
      break;
    case 'a':
    case 'A':
      cycleAspectMode();
      break;
    case 'z':
    case 'Z':
      cycleSleepTimer();
      break;
    case '+':
    case '=':
      adjustVolume(0.1);
      break;
    case '-':
    case '_':
      adjustVolume(-0.1);
      break;
    case 'f':
    case 'F':
      window.api.toggleFullscreen();
      break;
    case 'p':
    case 'P':
      powerOff();
      break;
    case 'h':
    case 'H':
      toggleHintBar();
      break;
    case 'o':
    case 'O': {
      // Quick access to the live drag/resize logo bug editor for whatever
      // channel is currently tuned, without a trip through Setup ->
      // Channels -> this channel -> OVERLAYS first. Edits whatever's
      // actually controlling this channel's logo right now — its own
      // override if it has one, else the box-wide default — same
      // inherit/override resolution applyLogoBugPlacement itself uses, so
      // there's nothing new to create just to open this.
      const ch = getChannel(S.currentNumber);
      if (!ch) break;
      import('./setup/util.js').then(({ openLiveLogoBugEditor }) => openLiveLogoBugEditor({
        getProfiles: () => ch.logoBugProfiles || (S.config.display && S.config.display.logoBugProfiles),
        setProfiles: (profiles) => {
          if (ch.logoBugProfiles != null) ch.logoBugProfiles = profiles;
          else { S.config.display = S.config.display || {}; S.config.display.logoBugProfiles = profiles; }
          if (ch.logoBugProfiles != null) commitInPlace({ type: 'channel.setFields', channel: ch.number, fields: { logoBugProfiles: ch.logoBugProfiles } }, { coalesce: `ch:${ch.number}:logoBugProfiles` });
          else commitInPlace({ type: 'settings.set', path: ['display', 'logoBugProfiles'], value: profiles }, { coalesce: 'display:logoBugProfiles' });
        },
        onLiveChange: () => applyLogoBugPlacement(ch),
        channelNumber: ch.number,
      }));
      break;
    }
    case 'n':
    case 'N':
      flashMessage(toggleChannelScan() ? 'SCANNING…' : 'SCAN STOPPED', 'scanFlashTimer');
      break;
    case 'x':
    case 'X':
      saveAirCheck();
      break;
    case '?':
      openTvMenu();
      break;
    default: {
      // Any letter not already claimed by a case above is a candidate
      // registerInterrupt hotkey (plugins.js) — any plugin can claim one at
      // registration time. Which plugin (if any) responds is data on the
      // registration, not a hardcoded plugin id here.
      const entry = interruptEntries().find((en) => en.hotkey === e.key.toLowerCase());
      if (entry) entry.run({ manual: true });
      break;
    }
  }
}

// TV mode routes remote buttons to actions first (tv-input.js); whatever it
// doesn't claim — and everything in desktop mode — reaches handleKey exactly as
// a keystroke always has.
window.addEventListener('keydown', (e) => {
  if (routeKeydown(e)) return;
  if (exitPromptOpen()) { e.preventDefault(); return; } // modal over live TV
  handleKey(remapKeyboardEvent(e));
});
installTvInput({ handleKey });
// Never switches on its own — it only offers (docs/design/01 §4).
installTvSuggestion(() => document.documentElement.dataset.mode || 'desktop');
// Phase E platforms (docs/design/01): game controllers anywhere, and a
// Samsung/LG TV browser's key registration and standby-on-hide.
installGamepad({ isTvMode });
installTvPlatform(window, document, {
  standby: () => { if (S.isPoweredOn) powerOff(); },
  wake: () => { if (!S.isPoweredOn) powerOn(); },
});
// An explicit route back to live TV for remote clients. Escape remains a
// context-sensitive "back" key inside Setup, so overloading it as an exit
// would make text fields, dialogs, and nested setup panels unpredictable.
window.addEventListener('reruntv:watch-tv', () => showTvScreen());
// Universal remote: every button press the phone page sends arrives here as
// {key, shift} and is fed through the exact same handler real keystrokes
// use — digit-entry buffering, guide-grid interception, wake-on-any-key,
// time-machine shuttle, all of it, with zero duplicated logic.
window.api.onRemoteCommand((cmd) => {
  if (cmd?.action === 'watch-tv') {
    showTvScreen();
    return;
  }
  const init = {
    key: cmd.key,
    shiftKey: !!cmd.shift,
    ctrlKey: !!cmd.ctrl,
    altKey: !!cmd.alt,
  };
  if (tvScreen.classList.contains('hidden')) {
    // Setup has its own window-level keyboard navigation (setup-keyboard.js).
    // The old direct handleKey call returned immediately while Setup was
    // visible, turning the remote's SETUP button into a one-way trip. A real
    // KeyboardEvent reaches those same setup listeners and keeps every
    // tab/subtab/dialog navigable from the Companion.
    // A remote button always means the default key, whatever the keyboard is remapped to.
    window.__remoteKeyDispatch = true;
    try { window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true })); } finally { window.__remoteKeyDispatch = false; }
  } else {
    handleKey({ ...init, preventDefault() {} });
  }
});
// Direct channel jump from the Android companion remote's quick-tap grid —
// bypasses the digit-entry buffer entirely (unlike pushDigit) since the app
// already knows the exact channel number, no need to simulate keypresses.
window.api.onRemoteTune((data) => {
  if (data && Number.isFinite(data.number)) {
    if (!S.isPoweredOn) powerOn();
    tuneToChannel(data.number);
  }
});
// Toggling a channel's FAVORITE/quickAccess flag from the companion app's
// channel-list editor. quickAccess mutates the same in-memory config the
// desktop setup screen edits, so it's picked up by the existing debounced
// autosave with no separate write path. FAVORITE is different: doc 09 moved
// favorites into per-profile storage (isFavorite/setFavorite, personal/
// state.js), so writing ch.favorite here would toggle a field the on-screen
// guide no longer reads once a household profile is active — go through the
// same profile-aware command the desktop UI uses instead, falling back to
// the legacy per-channel field only for a box with no profile loaded yet
// (isFavorite's own fallback, so reads and writes agree on which value is
// canonical).
window.api.onRemoteSetChannelFlag((data) => {
  if (!data || !Number.isFinite(data.number)) return;
  const ch = getChannel(data.number);
  if (!ch || (data.field !== 'favorite' && data.field !== 'quickAccess')) return;
  if (data.field === 'favorite' && S.personalProfile) {
    setFavorite(data.number, !!data.value).catch((e) => console.error('[companion] favorite toggle failed:', e));
    return;
  }
  ch[data.field] = !!data.value;
  commitInPlace({ type: 'channel.set', channel: ch.number, field: data.field, value: ch[data.field] });
});
// Recursively merges `patch` into `target` in place, at any depth, but only
// ever assigns a leaf onto a key that already exists on `target` — never
// invents a new key at any level. Used below so a companion-app edit to one
// deeply-nested leaf (e.g. display.overlayLayouts['ticker-bar'].x) can't
// wipe out sibling keys the way a plain Object.assign one level deep would
// (that would replace the whole nested object with just the edited leaf).
// Returns whether anything was actually changed.
function deepMergeExistingKeys(target, patch) {
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
    const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (isPlainObject(value) && isPlainObject(target[key])) {
      if (deepMergeExistingKeys(target[key], value)) changed = true;
    } else {
      target[key] = value;
      changed = true;
    }
  }
  return changed;
}

function sameConfigShape(current, incoming) {
  if (Array.isArray(current) || Array.isArray(incoming)) {
    return Array.isArray(current) && Array.isArray(incoming);
  }
  const currentIsObject = current !== null && typeof current === 'object';
  const incomingIsObject = incoming !== null && typeof incoming === 'object';
  if (currentIsObject || incomingIsObject) return currentIsObject && incomingIsObject;
  return typeof current === typeof incoming;
}

function applyCompanionSettingsLive(changedSections) {
  if (!changedSections.size) return;

  // Resize the layout canvas before recomputing picture/overlay geometry.
  if (changedSections.has('display')) window.api.setUiScale?.(S.config.display?.uiScale || 'auto');

  // A desktop settings control normally performs both halves of an edit:
  // mutate S.config and immediately refresh the live surface that consumes
  // it. Companion edits bypass those individual DOM listeners, so replay
  // the same inexpensive, idempotent refreshes here after the patch lands.
  applyTheme({ boxOnly: S.isSetupOpen });
  applyCrtState();
  applyPictureMode();
  applyAspectMode();
  applyMuteState();
  applyVolume();
  applyLeveler();
  applyBakedBars();
  applyHintBarState();
  applyKeyHints();
  applyDisplayModeSettled();
  window.applyTickerState?.();
  pushRemoteState();

  if (changedSections.has('display')) {
    applyCustomCss();
  }
  if (changedSections.has('timeMachine') && S.config.timeMachine?.enabled === false && S.timeMachineOn) {
    exitTimeMachine({ toLive: true });
  }
  if (changedSections.has('display')) {
    document.documentElement.classList.toggle('titlebar-hidden', !!S.config.display?.hideTitleBar);
  }
  if (S.isSetupOpen) renderSettingsPanels();
}

// Companion app's Settings tab (plugins/companion-app/main.js's POST
// /api/settings) — a patch mirrors the full config JSON: top-level scalars
// are replaced, while object sections may contain arbitrarily deep partial
// values. Existing objects merge through deepMergeExistingKeys above; every
// other value must retain its existing shape. The handler never creates a
// new section/key and never touches channels/plugins (those need dedicated,
// validated flows), so malformed or unexpected data is silently dropped.
window.api.onCompanionApplySettings?.((patch) => {
  if (!patch || typeof patch !== 'object') return;
  const BLOCKED_SECTIONS = new Set(['channels', 'plugins']);
  const changedSections = new Set();
  // Every section this handler declines, and why. The HTTP route that
  // delivered this patch answered 202/204 the moment it relayed it — it
  // cannot know what happened here — so the phone used to report "changes
  // accepted" for a patch that was silently dropped in full, then reload
  // the config and watch the value snap back with no explanation. Reporting
  // the outcome in the next pushed remote state (see pushRemoteState,
  // power.js) is what makes that honest: the companion polls /state every
  // 1.5s anyway, so the truth reaches it within one tick without a new IPC
  // channel (which would need a fresh capability approval) or a request/
  // response round trip the one-way relay can't do.
  const rejected = [];
  for (const [section, values] of Object.entries(patch)) {
    if (BLOCKED_SECTIONS.has(section)) {
      rejected.push({ section, reason: 'edited from the box itself, not the companion' });
      continue;
    }
    if (section === '__proto__' || section === 'constructor' || section === 'prototype'
      || !Object.prototype.hasOwnProperty.call(S.config, section)) {
      rejected.push({ section, reason: 'no such setting on this box' });
      continue;
    }
    const target = S.config[section];
    const targetIsPlainObject = target !== null && typeof target === 'object' && !Array.isArray(target);
    const valuesIsPlainObject = values !== null && typeof values === 'object' && !Array.isArray(values);
    if (targetIsPlainObject && valuesIsPlainObject) {
      if (deepMergeExistingKeys(target, values)) changedSections.add(section);
      continue;
    }
    // Top-level scalar settings (theme, crtEnabled, pictureMode,
    // aspectMode, volume, and others) used to be silently skipped here
    // because the old handler only accepted object/object pairs. Arrays are
    // also legitimate leaf values from the Companion's generic editor.
    if (!sameConfigShape(target, values)) {
      rejected.push({ section, reason: 'wrong kind of value for this setting' });
      continue;
    }
    const equal = Array.isArray(target)
      ? JSON.stringify(target) === JSON.stringify(values)
      : Object.is(target, values);
    if (!equal) {
      S.config[section] = values;
      changedSections.add(section);
    }
  }
  S.lastCompanionSettingsResult = {
    at: Date.now(), // a real timestamp so the phone can tell one save from the next
    applied: [...changedSections],
    rejected,
  };
  if (!changedSections.size) {
    // Nothing to save or re-render, but the phone still needs to hear that
    // — this is exactly the case that used to report success.
    pushRemoteState();
    return;
  }
  commitConfigPatch('Companion settings');
  applyCompanionSettingsLive(changedSections); // ends with its own pushRemoteState()
});

// Companion app's ALERTS section (REMOTE tab) — dedicated relays rather than
// routing through onCompanionApplySettings above, because both of these need
// to actually DO something live (fire an interrupt, refresh a visible bar),
// not just mutate config for the next natural re-render.
window.api.onCompanionTriggerNews?.((data) => {
  const interrupt = getInterrupt('breaking-news');
  if (!interrupt) return; // plugin not installed — button just does nothing, same as a missing hotkey
  interrupt.run({ manual: true, headline: data && typeof data.headline === 'string' && data.headline.trim() ? data.headline.trim() : undefined });
});

window.api.onCompanionSetTicker?.((data) => {
  if (!data || typeof data !== 'object') return;
  // Same lazy-seed guard as the ticker plugin's own settings.js — this can
  // arrive before that plugin's SETTINGS panel has ever been opened once.
  if (!S.config.ticker) S.config.ticker = { enabled: false, text: '', speed: 30 };
  if (typeof data.text === 'string') S.config.ticker.text = data.text;
  if (typeof data.enabled === 'boolean') S.config.ticker.enabled = data.enabled;
  commitInPlace({ type: 'settings.set', path: ['ticker'], value: S.config.ticker });
  if (window.applyTickerState) window.applyTickerState();
});

// ---------- Companion lineup snapshot ----------
// What each channel is showing now and next, pushed to the companion app's
// cached state so its GUIDE tab can list real programming instead of bare
// channel names. Rides on the existing 'remote:state' push (pushRemoteState,
// power.js) rather than a channel of its own: the companion plugin merges
// what arrives, so a new IPC channel — and the fresh capability approval a
// manifest change would demand of every paired install — isn't needed for
// what is really just more of the same status.
//
// Only the tuned box computes this; a LAN viewer resolves its own schedule
// and has no companion server to feed. Deliberately a snapshot on a slow
// timer, not a live feed: a phone guide that is 30s stale is fine, and the
// per-channel schedule sweep is the same one guide.js already runs on its
// own 30s tick.
const COMPANION_LINEUP_PUSH_MS = 30000;
const COMPANION_LINEUP_MAX_CHANNELS = 300;
function pushCompanionLineup() {
  if (!window.api || typeof window.api.sendRemoteState !== 'function') return;
  const now = viewNow();
  const lineup = [];
  for (const ch of sortedChannels(S.config.channels || [])) {
    if (lineup.length >= COMPANION_LINEUP_MAX_CHANNELS) break;
    // isHiddenForProfile mirrors the box's own tuneToChannel guard (playback/
    // core.js) — a household profile's parental restriction or explicit
    // hidden list. Without this, a restricted profile's blocked channels
    // still showed up with real now/next info in the companion's guide and
    // channel list, even though tapping one would just no-signal on the box.
    if (ch.hidden || isHiddenForProfile(ch.number)) continue;
    const row = {
      number: ch.number,
      name: ch.name || '',
      favorite: isFavorite(ch.number),
      quickAccess: !!ch.quickAccess,
      now: '', next: '', endsAtMs: null,
    };
    try {
      // Three hours is enough to always contain a "next" even for a long
      // movie, and short enough that the walk stays cheap.
      const entries = getChannelSchedule(ch, now, now + 3 * 3600000);
      if (entries[0]) {
        row.now = getDisplayTitle(entries[0].file);
        row.endsAtMs = entries[0].end;
      }
      if (entries[1]) row.next = getDisplayTitle(entries[1].file);
    } catch (e) {
      // A channel whose folders have gone missing shouldn't cost the rest
      // of the lineup its listing — it just has no programming to report.
    }
    lineup.push(row);
  }
  window.api.sendRemoteState({ lineup, lineupAt: Date.now() });
}

function startCompanionLineupPushes() {
  pushCompanionLineup();
  setInterval(() => {
    try { pushCompanionLineup(); } catch (e) { console.error('[companion] lineup push failed:', e); }
  }, COMPANION_LINEUP_PUSH_MS);
}

const pinCancelBtnEl = document.getElementById('pin-cancel-btn');
if (pinCancelBtnEl) pinCancelBtnEl.addEventListener('click', hidePinLockScreen);

let clickTimer = null;
if (tvScreen) {
  tvScreen.addEventListener('click', (e) => {
    if (e.target.closest('button, input, select, textarea, #setup-screen, #guide-grid, .modal-card')) return;
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      if (window.api && window.api.toggleFullscreen) window.api.toggleFullscreen();
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (isVirtualChannel(S.currentNumber)) {
          showVirtualGuideOverlay(S.currentNumber);
        } else {
          showGuideOverlay(S.currentNumber, getChannel(S.currentNumber));
        }
      }, 250);
    }
  });

  tvScreen.addEventListener('contextmenu', (e) => {
    if (e.target.closest('button, input, select, textarea, #setup-screen, #guide-grid, .modal-card')) return;
    e.preventDefault();
    openGuideGrid();
  });
}

const pinKeypad = document.getElementById('pin-keypad');
if (pinKeypad) {
  pinKeypad.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const digit = btn.dataset.digit;
    if (digit === 'clear') {
      clearPinBuffer();
    } else if (digit) {
      pushPinDigit(digit);
    }
  });
}

guideSearchEl.addEventListener('input', () => {
  S.guideFilterQuery = guideSearchEl.value;
  S.guideSelNumber = null; // first matching row
  renderGuideGrid();
});

// ================= SCREEN SWITCHING =================
export async function showSetupScreen() {
  if (!S.config.channels || S.config.channels.length === 0) {
    try {
      const fresh = await window.api.loadConfig();
      if (fresh && fresh.channels && fresh.channels.length > 0) {
        S.config = fresh;
        bumpConfigGeneration();
      }
    } catch (e) {}
  }
  if (S.setupPreviewActive) {
    S.setupPreviewActive = false;
    S.timeOffsetMs = 0;
    previewBannerEl.classList.add('hidden');
  }
  player.pause();
  S.isSetupOpen = true;
  runCoreHooks('enter-setup');
  clearTimeout(S.breakTimer);
  clearTimeout(S.blockBoundaryTimer);
  cancelAllScheduledInterrupts();
  resetActiveBreakState();
  triviaCardEl.classList.add('hidden');
  stationIdBarEl.classList.remove('show');
  crtToggleFlash.classList.remove('show');
  cancelAllInterrupts();
  cancelUpNextBar();
  hideDetailsOverlay();
  // Stops the guide's 30 s tick and drops a half-browsed banner while setup is up.
  closeGuideGrid();
  closeBannerHub();
  exitTimeMachine();
  hideVirtualChannels();
  clearTimeout(S.idleTimer); S.idleTimer = null;
  tvScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  applyTheme({ boxOnly: true });
  applyDisplayModeSettled();
  resetSetupTabs();
  S.setupFilterQuery = '';
  channelFilterEl.value = '';
  // Open on the channel being watched, so "fix this channel" needs no hunting
  // in the lineup (docs/design/03 §9).
  if ((S.config.channels || []).some((c) => c.number === S.currentNumber)) {
    S.bulkSelectedChannels.clear();
    S.setupSelectedChannel = S.currentNumber;
  }
  renderChannelList();
  renderCommercialsPanel();
  renderPreemptionWindowsEditor();
  renderStandbyPanel();
  renderSettingsPanels();
}

export async function showTvScreen() {
  if (!S.config.channels || S.config.channels.length === 0) {
    try {
      const fresh = await window.api.loadConfig();
      if (fresh && fresh.channels && fresh.channels.length > 0) {
        S.config = fresh;
        bumpConfigGeneration();
      }
    } catch (e) {}
  }
  if (!S.config.channels || S.config.channels.length === 0) {
    alertDialog('No channels found. Please add a channel with video files.');
    return;
  }
  setupScreen.classList.add('hidden');
  tvScreen.classList.remove('hidden');
  S.isSetupOpen = false;
  applyCrtState();
  applyPictureMode();
  applyAspectMode();
  window.applyTickerState?.();
  applyMuteState();
  applyVolume();
  applyLeveler();
  applyBakedBars();
  applyHintBarState();
  applyKeyHints();
  applyTheme();
  applyDisplayModeSettled();
  applyLogoBugPlacement();

  // Power state never persists across a screen transition or app restart —
  // always boot powered-on, matching the existing boot-to-live-channel behavior.
  S.isPoweredOn = true;
  clearTimeout(S.powerAnimTimer);
  crtContainer.classList.remove('power-off', 'powering-off', 'powering-on');
  // Reuses power.js's manual powerOn() animation (DISPLAY > PICTURE toggle) so
  // boot starts from the same "off" black state the index.html/tokens.css
  // boot-flash fix already lands on, instead of an instant cut to live video —
  // tuneToChannel below still fires immediately either way, the class is
  // purely a CSS overlay on top.
  if (S.config.display.bootPowerOnAnim !== false) {
    crtContainer.classList.add('powering-on');
    S.powerAnimTimer = setTimeout(() => crtContainer.classList.remove('powering-on'), POWER_ON_ANIM_MS);
  }

  const list = sortedChannels();
  if (list.length === 0) return;
  const startup = S.config.controls && S.config.controls.startupChannel;
  // A channel number may arrive as text from the Companion's Settings editor.
  const startupNumber = typeof startup === 'string' && startup.trim() !== '' ? Number(startup) : startup;
  const wanted = startup === 'first' ? list[0].number : (typeof startupNumber === 'number' && Number.isFinite(startupNumber) ? startupNumber : S.config.lastChannel);
  const resume = list.find((c) => c.number === wanted);
  tuneToChannel((resume || list[0]).number, { silent: true });
  resetIdleTimer();
}

window.addEventListener('resize', () => {
  staticCanvas.width = staticCanvas.clientWidth;
  staticCanvas.height = staticCanvas.clientHeight;
  // The retro-bezel feature (applyTvBezel, power.js) sizes #player with
  // explicit inline px left/top/width/height instead of plain CSS
  // percentages, so — unlike #player's old always-100%-of-container
  // behavior — it does NOT automatically track a container resize on its
  // own. Without this, any window resize (or the fullscreen toggle below,
  // which is a resize) leaves the video stuck at its previous, now-stale
  // size instead of filling the new window.
  if (player.videoWidth && player.videoHeight) {
    applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  }
});

// Fullscreen: hide the hint bar (nothing to hint at when there's no
// title bar/taskbar to reference anyway) and let #player fill the space it
// frees up — see main.js's enter-full-screen/leave-full-screen listeners,
// which fire this for every trigger (F-key, OS window controls, F11), not
// just the app's own toggle.
if (window.api && window.api.onFullscreenChange) {
  window.api.onFullscreenChange((isFullscreen) => {
    document.body.classList.toggle('is-fullscreen', isFullscreen);
    // Fullscreen changes the window's actual dimensions immediately, but
    // some platforms deliver the OS-level resize a frame or two after this
    // event — re-run once now and once after layout settles so #player
    // never sits at a stale size in between.
    if (player.videoWidth && player.videoHeight) {
      applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
    }
    setTimeout(() => {
      if (player.videoWidth && player.videoHeight) {
        applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
      }
    }, 150);
  });
}

// Commercials/trivia/box-wide-commercials used to each carry their own
// content (a per-owner bumper folder, or a flat facts[] array) — fold any of
// that into tagged S.config.interstitials.pool entries, then strip the
// retired fields so the owner object is left in its new content-free shape.
// No-op once already migrated (the retired fields are gone by then, so
// there's nothing left to find) — same idempotent-by-construction idiom as
// normalizeChannel's other field migrations.
function migrateCommercialsToPool(pool, cc, channelAffinity, blockAffinity) {
  if (cc && cc.useOwnFolder && cc.files && cc.files.length) {
    cc.files.forEach((f) => {
      pool.push({ id: randomInterstitialId(), type: 'commercial', channelAffinity, blockAffinity, weight: 1, file: { path: f.path, duration: f.duration }, text: null });
    });
  }
  if (cc) { delete cc.folder; delete cc.files; delete cc.useOwnFolder; }
}

function normalizeUpdateStrategy(updates) {
  const valid = ['startup-auto', 'background-auto', 'background-notify', 'manual', 'off'];
  if (updates && valid.includes(updates.strategy)) return updates.strategy;
  if (updates && updates.mode === 'off') return 'off';
  if (updates && updates.mode === 'manual') return 'manual';
  if (updates && updates.mode === 'auto') {
    return updates.showLaunchPopup === false ? 'background-auto' : 'background-notify';
  }
  return 'startup-auto';
}

// ================= INIT =================
// Fills in any config field a fresh/older/imported config might be missing —
// shared by the normal boot load and by importConfig() (setup.js) so an
// imported file goes through the exact same schema-migration pass a config
// loaded from disk would.
export function applyConfigDefaults(config) {
  config = runConfigMigrations(config);
  if (!config.channels) config.channels = [];
  config.channels.forEach(normalizeChannel);

  if (!config.pinLock) config.pinLock = { enabled: false, code: '1234', channels: [98, 95, 51], ratings: [] };
  if (!config.pinLock.ratings) config.pinLock.ratings = [];

  if (!config.interstitials) config.interstitials = { pool: [] };
  if (!config.interstitials.presets) config.interstitials.presets = [];

  // Saved auto-curation profiles (PROGRAMMING > AUTO-CURATE) — see
  // freshCurationProfile (channels.js) / curation.js.
  if (!config.curationProfiles) config.curationProfiles = [];

  // Curated per-facet-category vocabulary (PROGRAMMING > TAG TAXONOMY) —
  // powers autocomplete suggestions (collectAllTags, setup-util.js) even for
  // a tag that hasn't been used on any file yet. No contentTypes category:
  // that facet is already a fixed 5-value enum edited via <select> in every
  // UI that touches it (TITLES facets, day-part slots), not a free-text tag
  // needing a curated vocabulary.
  if (!config.tagTaxonomy) config.tagTaxonomy = { genres: [], eras: [], moods: [] };

  // Runs after normalizeChannel so ch.blocks[] (which may have just absorbed
  // old ch.dateOverrides[]) is already unified — every block, old or new, is
  // walked the same way.
  config.channels.forEach((ch) => {
    migrateCommercialsToPool(config.interstitials.pool, ch.commercials, ch.number, null);
    (ch.blocks || []).forEach((b) => migrateCommercialsToPool(config.interstitials.pool, b.commercials, ch.number, b.id));
  });

  if (config.commercials && config.commercials.files && config.commercials.files.length) {
    config.commercials.files.forEach((f) => {
      config.interstitials.pool.push({ id: randomInterstitialId(), type: 'commercial', channelAffinity: 'any', blockAffinity: null, weight: 1, file: { path: f.path, duration: f.duration }, text: null });
    });
  }
  if (config.commercials) { delete config.commercials.folder; delete config.commercials.files; }
  if (!config.commercials) config.commercials = { enabled: false, timing: 'interval', intervalMinutes: 10 };
  if (!config.commercials.timing) config.commercials.timing = 'interval';

  if (config.trivia && config.trivia.facts) {
    config.trivia.facts.forEach((text) => {
      if (text && text.trim()) config.interstitials.pool.push({ id: randomInterstitialId(), type: 'trivia', channelAffinity: 'any', blockAffinity: null, weight: 1, file: null, text });
    });
    delete config.trivia.facts;
  }
  if (!config.trivia) config.trivia = { enabled: false, intervalMinutes: 20 };

  if (!config.stationId) config.stationId = { enabled: true, intervalMinutes: 15 };
  if (config.stationId.intervalMinutes == null) config.stationId.intervalMinutes = 15;

  if (!config.autoStandby) {
    config.autoStandby = { enabled: false, intervalMinutes: 15 };
  }
  if (!config.eas) config.eas = { enabled: false };
  // Real-alert fields, set by whichever plugin (if any) polls for them —
  // separate from `enabled` above, which only gates the random *test*
  // slate; a real alert firing isn't gated by that toggle. This
  // shared-namespace field is a deliberate exception to "a plugin seeds its
  // own config" below: core itself reads config.eas.enabled for the random
  // test slate, so core keeps seeding the whole object even though these
  // specific fields are only ever read/written by that other plugin.
  if (config.eas.noaaEnabled === undefined) config.eas.noaaEnabled = false;
  if (config.eas.lat === undefined) config.eas.lat = null;
  if (config.eas.lon === undefined) config.eas.lon = null;
  if (!config.upNext) config.upNext = { enabled: true };
  // On-screen duration of the "UP NEXT: <title>" banner — 8000ms matches the
  // original hardcoded value (scheduleUpNextBar, playback.js) exactly.
  const upNextDuration = Number(config.upNext.duration);
  config.upNext.duration = Number.isFinite(upNextDuration) ? Math.min(15000, Math.max(3000, upNextDuration)) : 8000;
  if (!config.details) config.details = { enabled: true };
  if (!config.timeMachine) config.timeMachine = { enabled: false };
  // Periodic "is the picture still where the schedule says it is" check
  // (startScheduleDriftWatchdog, playback-core.js). On by default because
  // the alternative is the app quietly lying about what's airing after the
  // machine wakes from sleep; the toggle exists for anyone whose media sits
  // on something slow enough that they'd rather ride out a stall than be
  // seeked through it.
  if (!config.playbackResync) config.playbackResync = { enabled: true };
  // Holds a display wake lock while the TV is powered on (power:
  // setKeepDisplayAwake, main.js). Real video playback usually keeps the
  // screen up on its own, but a virtual channel, a no-signal card, and the
  // guide are all still-image states where it doesn't.
  if (!config.keepDisplayAwake) config.keepDisplayAwake = { enabled: true };
  if (!Array.isArray(config.reminders)) config.reminders = [];
  // Marked moments — {channelNumber, at} on the viewing clock, no recording
  // involved. See airchecks.js for why that's a complete description of a
  // moment here.
  // Sub-channel numbering (7.1) is opt-in — see subChannelsEnabled
  // (channels.js) for what the flag does and does not gate.
  if (!config.subChannels) config.subChannels = { enabled: false };
  if (!Array.isArray(config.airChecks)) config.airChecks = [];
  // The log itself lives in its own file (main-history.js); this is only the
  // switch that decides whether anything gets written to it.
  if (!config.viewingHistory) config.viewingHistory = { enabled: true };
  // How many minutes before a REMIND ME program's start the toast fires
  // (checkProgramReminders, guide.js) — 1 matches the original hardcoded
  // 60000ms lead exactly, so an existing config keeps today's timing.
  const reminderLeadMinutes = Number(config.reminderLeadMinutes);
  config.reminderLeadMinutes = Number.isFinite(reminderLeadMinutes) ? Math.min(30, Math.max(1, reminderLeadMinutes)) : 1;
  // Tune to the channel when a reminder comes due instead of waiting for
  // TUNE NOW to be clicked. Off by default: changing the channel out from
  // under someone is the surprising option, so it stays opt-in.
  if (config.reminderAutoTune == null) config.reminderAutoTune = false;
  // Hand a due reminder to the OS as a real notification when the window
  // isn't focused. On by default — the app is built to keep running behind
  // other windows, which is exactly when an in-app toast is invisible.
  if (config.reminderNotify == null) config.reminderNotify = true;
  if (!config.librarySync) config.librarySync = { enabled: false, runAtStartup: true, intervalMinutes: 30, removeMissing: false };
  if (config.librarySync.runAtStartup == null) config.librarySync.runAtStartup = true;
  if (!config.librarySync.intervalMinutes) config.librarySync.intervalMinutes = 30;
  if (config.librarySync.removeMissing == null) config.librarySync.removeMissing = false;
  // One policy describes check timing and install behavior. Old two-field
  // configs migrate to their equivalent background behavior; only a truly
  // new install receives startup-auto as its default.
  if (!config.updates) config.updates = {};
  config.updates.strategy = normalizeUpdateStrategy(config.updates);
  delete config.updates.mode;
  delete config.updates.showLaunchPopup;
  if (!config.landing) config.landing = { audio: null };
  // A plugin's own config namespace (config.<pluginId>) is seeded by that
  // plugin's own renderer.js at load time, not here — core doesn't need to
  // know any given plugin exists to apply its defaults. See
  // [[retro_cable_box_plugin_system]].
  if (!config.crtIntensity) config.crtIntensity = { scanlines: 100, vignette: 100, grain: 100, flicker: 50, curvature: 0 };
  if (config.crtIntensity.flicker == null) config.crtIntensity.flicker = 50;
  if (config.crtIntensity.curvature == null) config.crtIntensity.curvature = 0;
  // Logo-bug burn-in ghosting — off unless turned up, same "gimmick, not
  // on-by-default authenticity" convention as curvature above.
  if (config.crtIntensity.burnIn == null) config.crtIntensity.burnIn = 0;
  // 'video' (default, today's exact behavior) = the CRT texture layers only
  // ever cover #player; 'wholeScreen' = a second copy of the same layers
  // (#screen-crt-overlay, index.html; applyCrtState, power.js) also sits
  // above the guide and setup screen, like a real tube's phosphor covers
  // everything shown on the glass, not just video content. Opt-in since
  // it's a real look change, not a bugfix.
  if (!config.crtIntensity.overlayScope) config.crtIntensity.overlayScope = 'video';
  if (!config.display) config.display = { clock24: false, guideSlots: 3 };
  if (!['auto', '100', '125', '150', '175', '200'].includes(String(config.display.uiScale || 'auto'))) {
    config.display.uiScale = 'auto';
  }
  if (!config.display.uiScale) config.display.uiScale = 'auto';
  // logoBugPosition/logoBugSize (old corner-enum + size-px) -> logoBugProfiles
  // (see foldLogoBugCorner, channels.js) — the box-wide default always has
  // at least the one folded-forward DEFAULT profile, never null.
  if (!config.display.logoBugProfiles) {
    config.display.logoBugProfiles = foldLogoBugCorner(config.display.logoBugPosition, config.display.logoBugSize);
  }
  config.display.logoBugProfiles = normalizeLogoBugProfiles(config.display.logoBugProfiles);
  if (config.display.logoBugAutoAdjust == null) config.display.logoBugAutoAdjust = false;
  // Automatic bug/overlay sizing (DISPLAY › Logo bug › "sizes were set on")
  // needs the screen the sizes were made for. The display the box is first
  // opened on after this was added stands in for it, recorded once; moving
  // to a 1080p or 4K display later then scales from that. A host-only
  // record: a LAN viewer reads the host's, it doesn't write its own.
  if (config.display.logoBugAuthoredHeight == null && !window.__isViewer) {
    config.display.logoBugAuthoredHeight = Math.round(window.screen && window.screen.height ? window.screen.height : 1080);
    // On a big screen with logo sizes already tuned, that guess may be wrong
    // (tuned on a 1080p screen, first opened on a 4K one), so ask once.
    const tuned = (config.display.logoBugProfiles || []).some((p) => p.size !== 46 || p.aspect || p.resolution)
      || (config.channels || []).some((c) => Array.isArray(c.logoBugProfiles) && c.logoBugProfiles.length > 1);
    if (tuned && config.display.logoBugAuthoredHeight > 1200) config.display.logoBugAuthoredAsk = true;
  }
  // Settings added since: written as real keys so the Companion's Settings tab can edit them.
  fillNewSettingDefaults(config);
  if (![0, 1, 2.5, 5, 10].includes(Number(config.display.overlaySnapIncrement))) {
    config.display.overlaySnapIncrement = 0;
  }
  if (typeof config.display.noSignalTitle !== 'string') config.display.noSignalTitle = '';
  if (typeof config.display.noSignalMessage !== 'string') config.display.noSignalMessage = '';
  config.display.noSignalTitle = config.display.noSignalTitle.slice(0, 48);
  config.display.noSignalMessage = config.display.noSignalMessage.slice(0, 120);
  if (!config.display.guideGenreStyles || typeof config.display.guideGenreStyles !== 'object') {
    config.display.guideGenreStyles = {};
  }
  if (!config.display.overlayLayouts || typeof config.display.overlayLayouts !== 'object') config.display.overlayLayouts = {};
  // Box-wide default rule list — unlike logoBugProfiles above, an empty
  // array is a perfectly valid "no dynamic overlays configured" state, not
  // something that needs a folded-forward DEFAULT entry.
  config.display.dynamicOverlays = normalizeDynamicOverlays(config.display.dynamicOverlays);
  // Box-wide (or per-channel, via channelNumber) special-event preemption
  // windows — absolute real-clock ranges resolveBreakAt (interstitials.js)
  // checks ahead of everything else. Same "empty array is valid" reasoning
  // as dynamicOverlays above.
  if (!Array.isArray(config.preemptionWindows)) config.preemptionWindows = [];
  config.preemptionWindows = config.preemptionWindows.filter((w) => w && typeof w === 'object').map((w) => ({
    id: w.id || `preempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: typeof w.label === 'string' ? w.label.slice(0, 60) : '',
    channelNumber: Number.isFinite(Number(w.channelNumber)) ? Number(w.channelNumber) : null,
    // 'once' (default): absolute real-clock startMs/endMs, unchanged from
    // before recurring windows existed. 'weekly': a standing weekday/time
    // slot (weekday/startHour/startMinute/durationMin) instead — see
    // matchesWeeklyPreemptionWindow, interstitials.js.
    kind: w.kind === 'weekly' ? 'weekly' : 'once',
    startMs: Number.isFinite(Number(w.startMs)) ? Number(w.startMs) : Date.now(),
    endMs: Number.isFinite(Number(w.endMs)) ? Number(w.endMs) : Date.now(),
    weekday: Math.min(6, Math.max(0, Number.isFinite(Number(w.weekday)) ? Number(w.weekday) : 0)),
    startHour: Math.min(23, Math.max(0, Number.isFinite(Number(w.startHour)) ? Number(w.startHour) : 13)),
    startMinute: Math.min(59, Math.max(0, Number.isFinite(Number(w.startMinute)) ? Number(w.startMinute) : 0)),
    durationMin: Math.max(1, Number.isFinite(Number(w.durationMin)) ? Number(w.durationMin) : 30),
  }));
  // 'none' (default) = today's static logo bug, unchanged. See LOGO_MOTION_
  // PRESETS (channels.js) for the rest.
  if (!LOGO_MOTION_PRESETS.includes(config.display.logoBugMotion)) config.display.logoBugMotion = 'none';
  if (!config.customSounds || typeof config.customSounds !== 'object') config.customSounds = {};
  delete config.display.logoBugPosition;
  delete config.display.logoBugSize;
  if (config.display.hintBar == null) config.display.hintBar = true;
  if (config.display.hintBarCompact == null) config.display.hintBarCompact = true;
  if (config.display.hintBarSlide == null) config.display.hintBarSlide = true;
  const hintBarShowDuration = Number(config.display.hintBarShowDuration);
  const hintBarHideDuration = Number(config.display.hintBarHideDuration);
  config.display.hintBarShowDuration = Number.isFinite(hintBarShowDuration) ? Math.min(1500, Math.max(0, hintBarShowDuration)) : 250;
  config.display.hintBarHideDuration = Number.isFinite(hintBarHideDuration) ? Math.min(1500, Math.max(0, hintBarHideDuration)) : 200;
  if (!Array.isArray(config.display.hintBarHidden)) config.display.hintBarHidden = [];
  if (config.display.customCssPath === undefined) config.display.customCssPath = null;
  if (config.display.bootPowerOnAnim === undefined) config.display.bootPowerOnAnim = true;
  if (config.display.hideTitleBar == null) config.display.hideTitleBar = false;
  // How long the small "channel card" (name/logo/now-playing bar, F to
  // reopen the full guide) stays up after a channel change before
  // auto-hiding — see showGuideOverlay (guide.js) / virtual.js's own copy.
  // 4000ms matches the original hardcoded value exactly, so a config that
  // never touches this slider keeps today's timing.
  const guideCardDuration = Number(config.display.guideCardDuration);
  config.display.guideCardDuration = Number.isFinite(guideCardDuration) ? Math.min(8000, Math.max(1000, guideCardDuration)) : 4000;
  // Scales the theme border's safe-area inset (how much the video shrinks
  // to clear the decorative bezel art) — 100 (default) reproduces each
  // theme's own safeAreaPct (or the DEFAULT_SAFE_AREA_PCT fallback,
  // power.js) exactly unchanged; 0 fills to the border's edge, 200 doubles
  // the inset for a border with unusually thin frame art.
  const bezelInsetScale = Number(config.display.bezelInsetScale);
  config.display.bezelInsetScale = Number.isFinite(bezelInsetScale) ? Math.min(200, Math.max(0, bezelInsetScale)) : 100;
  // Opts out of a theme pack's own crtBias (registerThemePack, plugins.js)
  // passively shifting the CRT sliders' effective intensity — off (default)
  // preserves every existing theme's current passive look exactly.
  if (config.display.ignoreThemeCrtBias == null) config.display.ignoreThemeCrtBias = false;
  if (!config.plugins) config.plugins = { disabled: [] };
  if (!Array.isArray(config.plugins.disabled)) config.plugins.disabled = [];
  // {pluginId: capabilitiesSignature} — a plugin the user has approved the
  // *current* declared capabilities.ipc/spawn/net for (setup-plugins.js's
  // approval prompt, main-plugins.js's capabilitiesSignature). Missing or
  // changed capabilities re-prompts rather than silently activating.
  if (!config.plugins.approvedCapabilities || typeof config.plugins.approvedCapabilities !== 'object') {
    config.plugins.approvedCapabilities = {};
  }
  if (!config.network || typeof config.network !== 'object') config.network = {};
  if (config.network.viewerEnabled == null) config.network.viewerEnabled = false;
  if (config.network.remoteEnabled == null) config.network.remoteEnabled = false;
  if (config.muted == null) config.muted = false;
  if (config.adVolume == null) config.adVolume = 1;
  if (config.contentVolume == null) config.contentVolume = 1;
  if (!['off', 'on'].includes(config.audioLeveler)) config.audioLeveler = 'off';
  if (!config.ticker) config.ticker = { enabled: false, text: '' };
  if (config.ticker.speed == null) config.ticker.speed = 30;
  if (!config.staticEffect) config.staticEffect = { enabled: true, intensity: 100, durationMs: 150 };
  if (config.staticEffect.durationMs == null) config.staticEffect.durationMs = 150;
  if (!config.testPattern) config.testPattern = { enabled: true };
  if (!config.pictureMode) config.pictureMode = 'standard';
  if (!config.theme) config.theme = 'digital-2000s';
  // App-wide display mode (DISPLAY > APP DISPLAY MODE, display-mode.js) —
  // simulates the box's own fixed aspect/resolution, separate from
  // aspectMode above which only affects video content's object-fit.
  if (!config.displayMode) config.displayMode = { aspect: '16:9', windowMode: 'letterbox', resolution: 'native' };
  if (!config.displayMode.aspect) config.displayMode.aspect = '16:9';
  if (!config.displayMode.windowMode) config.displayMode.windowMode = 'letterbox';
  if (!config.displayMode.resolution) config.displayMode.resolution = 'native';
  if (!config.displayMode.autoPriority) config.displayMode.autoPriority = 'metadata';
  if (!config.displayMode.uiExtent) config.displayMode.uiExtent = 'confined';
  return config;
}

// One-time question after the first launch on a big screen with logo sizes
// already tuned: were they set up on this screen? Decides the size the
// Automatic scaling starts from (DISPLAY › Logo bug).
async function askAboutDisplaySizes() {
  const d = S.config && S.config.display;
  if (!d || !d.logoBugAuthoredAsk || window.__isViewer) return;
  const height = d.logoBugAuthoredHeight;
  const sameScreen = await confirmDialog({
    title: 'YOUR LOGO SIZES',
    message: `RerunTV can now size the logo bug and pop-up overlays for whichever screen it is on. This screen is ${Math.round(window.screen.width * (window.devicePixelRatio || 1))}×${Math.round(window.screen.height * (window.devicePixelRatio || 1))}. Were your logo sizes set up on this screen, or on a smaller 1080p one?`,
    danger: false,
    confirmText: 'THIS SCREEN',
    cancelText: 'A 1080p SCREEN',
  });
  dispatch([
    { type: 'settings.set', path: ['display', 'logoBugAuthoredHeight'], value: sameScreen ? height : 1080 },
    { type: 'settings.set', path: ['display', 'logoBugAuthoredAsk'], value: undefined },
  ], { skipUndo: true });
  applyLogoBugPlacement();
}

async function init() {
  let loaded;
  try {
    loaded = await window.api.loadConfig();
  } catch (e) {
    // Without this the window just stays blank; say what happened instead.
    console.error('[boot] loadConfig failed:', e);
    document.body.insertAdjacentHTML('beforeend', '<div role="alert" style="position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:32px;background:#000;color:#fff;font:20px monospace;text-align:center">RerunTV could not load its configuration.<br>Restart the app. If this keeps happening, the log has the details.</div>');
    return;
  }
  let configLoadFailedThisSession = false;
  const isFirstRun = !!loaded._isFirstRun;
  delete loaded._isFirstRun;
  if (loaded._configLoadError) {
    // channels.json existed but failed to parse (main.js's loadConfig) — the
    // real config was preserved on disk rather than silently discarded, but
    // the user needs to know this happened and where to find it, or they'll
    // just see an empty setup screen and assume everything is gone.
    alertDialog(
      'Your saved channels.json could not be read (it may have been corrupted by an ' +
      'incomplete write or an external edit) and could not be loaded.\n\n' +
      (loaded._configLoadErrorBackupPath
        ? `The original file was preserved at:\n${loaded._configLoadErrorBackupPath}`
        : 'The original file is still at its usual location.') +
      '\n\nStarting from an empty configuration. Until the file is repaired, ordinary edits are ' +
      'not written to it, but IMPORT CONFIG (or any action that saves the whole configuration) ' +
      'replaces it with what is on screen. If you have a config export backup, ' +
      'use IMPORT CONFIG in settings to restore it.',
      { variant: 'error', title: 'CONFIG LOAD ERROR' },
    );
    // These are a one-time signal from main.js's loadConfig, not real config
    // shape — strip them so the next autosave doesn't persist them into a
    // fresh channels.json.
    delete loaded._configLoadError;
    delete loaded._configLoadErrorBackupPath;
    configLoadFailedThisSession = true;
  }
  // Snapshotted before applyConfigDefaults so a boot-time schema migration
  // (a new config section getting its defaults, a virtual-channel-number
  // renumbering, etc.) can be surfaced instead of happening invisibly —
  // deliberately only on this, the real boot-load path, not on import/
  // restore/backup-restore (setup-channels.js, setup-settings.js), which
  // already have their own explicit user-driven confirmation flows and
  // don't need a second notice layered on top.
  const beforeMigration = JSON.stringify(loaded);
  setConfigNormalizer(applyConfigDefaults); // a host resync must be normalized like boot is
  S.config = applyConfigDefaults(loaded);
  await initPersonalState();
  if (window.__isViewer) window.api.setUiScale(S.config.display.uiScale);
  resetUndoBaseline();
  if (!configLoadFailedThisSession && beforeMigration !== JSON.stringify(S.config)) {
    showMigrationToast();
  }
  // Drives the drag-strip CSS below (tv.css) so a frameless/borderless
  // window (main.js's window:setTitleBarHidden) can still be moved with no
  // native title bar to grab. Only ever needs setting once here at boot —
  // toggling the setting itself closes and reopens this whole renderer (see
  // setup-settings.js's hideTitleBarEnabledEl handler), so there's no live
  // in-page case to also update.
  document.documentElement.classList.toggle('titlebar-hidden', !!S.config.display.hideTitleBar);
  applyCustomCss();
  // Plugin registration is part of boot correctness, not background polish:
  // a LAN viewer can legitimately reopen while tuned to a plugin channel,
  // and showTvScreen() must see that channel type before its first tune.
  // Styles/modules are local assets, so the small startup cost is bounded.
  await loadPlugins();
  initDvrScheduler();
  startThemeCheck(); // background: theme contrast results for the browser badge and diagnostics
  // Declarative plugin settings schemas may have filled defaults or applied
  // migrations during registration. Treat that boot normalization as the
  // baseline, not as a user edit that Ctrl+Z should be able to undo.
  resetUndoBaseline();
  applyHintBarState();
  applyKeyHints();
  askAboutDisplaySizes();
  // Any plugin's own periodic/self-starting behavior (a random-alert
  // schedule, a poll loop, etc.) self-starts from its own module top-level
  // code once loadPlugins()'s dynamic imports resolve, rather than being
  // kicked off from here.
  initUpdateNotice();
  initLibrarySync();
  // Runs on a viewer too: a LAN viewer resolves the same schedule against
  // the same clock and can drift for exactly the same reasons (its device
  // sleeping, a slow stream off the host), so it wants the same correction.
  startScheduleDriftWatchdog();
  // Media keys on a keyboard and the OS now-playing overlay, mapped to
  // channel up/down — the honest equivalent of next/previous track on a box
  // with no tracks. See initMediaSession (playback-broadcast-fx.js).
  initMediaSession((delta) => changeChannel(delta));
  // Host only — a viewer has no companion server listening for these.
  if (!window.__isViewer) startCompanionLineupPushes();
  // The set boots powered on, so claim the wake lock now rather than waiting
  // for the first powerOn() — which only ever fires on a transition out of
  // standby and would otherwise never run at all in a normal session.
  applyDisplayWakeLock();

  // A LAN viewer (browser-api-shim.js, window.__isViewer) always boots
  // straight to live playback — there's no first-run "add a channel" setup
  // flow on a read-only device, and Setup being reachable at all there is
  // just for looking, not editing (every window.api setup/save method is a
  // no-op in that shim).
  if (window.__controlClient) {
    // The LAN control panel (docs/design/06 §3): the setup shell, and nothing
    // playing. Same bundle as the viewer, but it boots to the editor and never
    // auto-tunes — the point of it is to change the lineup from another room,
    // not to watch on the device doing the changing.
    //
    // Deliberately NOT startViewerConfigPolling(): that refetches and replaces
    // S.config wholesale, which would throw away an edit in progress. A
    // control client stays in step through the command protocol instead —
    // config:applied for another editor's commands, and an authoritative
    // resync whenever the host refuses one of its own (docs/design/05 §2.3).
    await showSetupScreen();
  } else if (window.__isViewer) {
    showTvScreen();
    startViewerConfigPolling();
    initViewerAudioUnlock();
    initTouchControls();
    initViewerLiveLink();
  } else if (S.config.channels.length === 0 && isTvMode()) {
    // First run on a TV (docs/design/01 §6.5): a remote-driven wizard on the
    // TV screen instead of the desktop onboarding and setup screen.
    await showTvScreen();
    const wizard = await showTvWizard({
      updateStrategy: S.config.updates.strategy,
      addFolderChannel: window.api && window.api.selectFolder ? async () => {
        const folder = await window.api.selectFolder();
        if (!folder) return null;
        const { createChannelFromFolder } = await import('./setup/channels.js');
        return createChannelFromFolder(folder);
      } : null,
    });
    S.config.updates.strategy = wizard.updateStrategy;
    await saveConfigNow();
    resetUndoBaseline();
    const first = S.config.channels.slice().sort((x, y) => x.number - y.number)[0];
    if (first) tuneToChannel(first.number);
  } else if (S.config.channels.length === 0) {
    if (isFirstRun) {
      const onboarding = await showOnboarding({ updateStrategy: S.config.updates.strategy });
      S.config.updates.strategy = onboarding.updateStrategy;
      // Persist the choice before the first setup interaction so the next
      // launch's main-process preflight can enforce it even if the user
      // closes the app without adding a channel.
      await saveConfigNow();
      resetUndoBaseline();
    }
    showSetupScreen();
  } else {
    // Screen edges and following the TV's power start once the set is on:
    // a TV that's still off at boot puts it straight back in standby.
    await showTvScreen();
  }
  if (!window.__isViewer && !window.__controlClient) installTvScreen();
}

// Keeps a LAN viewer's channel/block/interstitial data in sync with edits
// made on the host. The host announces each write a viewer would see on the
// viewer event bus (config:changed, main/config-host.js), so a refetch
// normally follows an edit within a second; the interval below is only a
// fallback for a missed notice (a server restart, a dropped poll). Replaces
// S.config wholesale on each successful poll rather than diffing, since
// every read path (resolveActiveSource, getChannel, etc.) just reads
// through S.config fresh each time with no cached long-lived references.
// A poll that hits a momentarily-corrupted config (main.js's loadConfig,
// mid-write on the host) is skipped rather than blanking the viewer's own
// still-good in-memory config — no alert either, unlike the boot path,
// since a dialog firing on every failed 10s poll would be unusable.
const VIEWER_CONFIG_POLL_MS = 60000;
function startViewerConfigPolling() {
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const fresh = await window.api.loadConfig();
      if (fresh._configLoadError) {
        console.warn('[LAN viewer] config poll got a corrupted read from the host — keeping the last good config.');
        return;
      }
      const next = applyConfigDefaults(fresh);
      const changed = new Set(Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(S.config[key])));
      S.config = next;
      bumpConfigGeneration();
      applyCompanionSettingsLive(changed);
      // Whichever plugin's toggle controls this can change live on the host
      // while a viewer sits open — just a visibility flip against config
      // already in hand, not another network round trip (the URL itself was
      // fetched once, at boot, in initViewerLiveLink below). Generic: app.js
      // has no idea which plugin (if any) this is.
      if (viewerLiveLinkEl) viewerLiveLinkEl.classList.toggle('hidden', !viewerLiveLinkEl.dataset.url || !findLiveViewerLinkChannelType());
    } catch (e) {
      console.warn('[LAN viewer] config poll failed:', e);
    } finally {
      refreshing = false;
    }
  }
  window.api.onConfigChanged?.(refresh);
  window.api.onCompanionConfigChanged?.(refresh);
  setInterval(refresh, VIEWER_CONFIG_POLL_MS);
}

// Cross-link to whatever plugin's own guest/companion page (if any) wants to
// offer a "watch live" link on the LAN viewer — generic across whichever
// plugin, if any, declares registerChannelType's optional `viewerLink`
// capability (plugins.js) and is the one actually live right now
// (findLiveViewerLinkChannelType, virtual.js). Fetched once (the host's LAN
// addresses don't change mid-session); the URL is stashed on the element's
// dataset so the config-poll visibility check above can tell "never got a
// URL" apart from "got one, just currently hidden."
function initViewerLiveLink() {
  if (!viewerLiveLinkEl) return;
  const live = findLiveViewerLinkChannelType();
  if (!live) return;
  live.viewerLink.fetchUrl().then((url) => {
    if (!url) return;
    viewerLiveLinkEl.href = url;
    viewerLiveLinkEl.dataset.url = url;
    viewerLiveLinkEl.classList.remove('hidden');
  }).catch(() => {});
}

// Browsers block *all* autoplay (video freezes on its first frame, not just
// silently — this was the actual root cause of "video shows but never
// advances" on another device) unless the element is muted, or a real
// user gesture has already happened on the page. applyMuteState (power.js)
// force-mutes until S.viewerAudioUnlocked flips true — this is the only
// place that happens, on the first genuinely browser-trusted gesture
// (touchstart/pointerdown/keydown; a JS-dispatched synthetic event, like
// the ones touch-controls.js's swipe handling or the Android wrapper send,
// does NOT count for this — browsers deliberately don't treat those as user
// activation). { once: true } since only the very first one matters.
function initViewerAudioUnlock() {
  // The native Android TV shell explicitly sets
  // mediaPlaybackRequiresUserGesture=false before loading this page. Its
  // D-pad events are injected into the WebView as synthetic KeyboardEvents,
  // so waiting for a browser-trusted DOM gesture here would leave that
  // client force-muted forever even though the native player policy already
  // permits audible autoplay. Ordinary LAN browsers keep the gesture gate.
  if (document.documentElement.dataset.tvClient === 'android') {
    S.viewerAudioUnlocked = true;
    applyMuteState();
    if (player.paused && S.isPoweredOn) player.play().catch(() => {});
    return;
  }

  const unlock = () => {
    if (S.viewerAudioUnlocked) return;
    S.viewerAudioUnlocked = true;
    applyMuteState();
    if (player.paused && S.isPoweredOn) player.play().catch(() => {});
  };
  ['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, unlock, { once: true, capture: true });
  });
}

init();
