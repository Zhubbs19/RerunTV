// Event wiring for the box-wide DISPLAY and GUIDE controls (CRT, hint bar,
// volumes, guide layout, picture and display mode, no-signal copy). Split out
// of settings.js.
import { applyDisplayMode } from '../display/mode.js';
import { applyLogoBugMotion, refreshLogoBugGhost } from '../playback/broadcast-fx.js';
import { applyAspectMode, applyPictureMode, applyCrtState, applyHintBarState, applyVolume, applyTvBezel } from '../playback/power.js';
import { S, dispatch, saveConfigNow } from '../core/state.js';
import { getChannel } from '../core/channels.js';
import { exitTimeMachine } from '../playback/timemachine.js';
import { runCoreHooks } from '../plugin/host.js';
import { applyGuideDockMode } from '../guide/guide.js';
import { adVolumeSlider, contentVolumeSlider, crtBurninSlider, crtEnabledEl, crtCurvatureSlider, crtFlickerSlider, crtGrainSlider, crtScanlinesSlider, crtVignetteSlider, clock24El, guideSlotsSelect, guideSlotMinutesSelect, guideCardDurationSlider, reminderLeadMinutesSlider, hintBarEnabledEl, hintBarCompactEl, hintBarSlideEnabledEl, uiScaleSelect, hintBarShowDurationEl, hintBarShowDurationValEl, hintBarHideDurationEl, hintBarHideDurationValEl, aspectModeSelect, bootPowerAnimEnabledEl, crtOverlayWholeScreenEnabledEl, ignoreThemeCrtBiasEnabledEl, guideOpenCloseAnimEnabledEl, guideAnimSpeedSlider, guideLivePreviewEnabledEl, logoBugMotionSelect, daypartChimeEnabledEl, movieModeEnabledEl, pictureModeSelect, bezelInsetScaleSlider, noSignalTitleInput, noSignalMessageInput, noSignalCopyReset, displayModeAspectSelect, displayModeWindowSelect, displayModeResolutionSelect, displayModeAutoPrioritySelect, displayModeOverlaysNativeSizeEl, displayModeUiExtentSelect, hideTitleBarEnabledEl, player, timeMachineEnabledEl } from '../core/dom.js';
import { refreshDependentControls } from './dependent-controls.js';

crtEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['crtEnabled'], value: crtEnabledEl.checked });
  applyCrtState();
  refreshDependentControls();
});
crtScanlinesSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['crtIntensity', 'scanlines'], value: parseInt(crtScanlinesSlider.value, 10) }, { coalesce: 'crt:scanlines' });
  applyCrtState();
});
crtVignetteSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['crtIntensity', 'vignette'], value: parseInt(crtVignetteSlider.value, 10) }, { coalesce: 'crt:vignette' });
  applyCrtState();
});
crtGrainSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['crtIntensity', 'grain'], value: parseInt(crtGrainSlider.value, 10) }, { coalesce: 'crt:grain' });
  applyCrtState();
});
crtFlickerSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['crtIntensity', 'flicker'], value: parseInt(crtFlickerSlider.value, 10) }, { coalesce: 'crt:flicker' });
  applyCrtState();
});
crtCurvatureSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['crtIntensity', 'curvature'], value: parseInt(crtCurvatureSlider.value, 10) }, { coalesce: 'crt:curvature' });
  applyCrtState();
});
crtBurninSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['crtIntensity', 'burnIn'], value: parseInt(crtBurninSlider.value, 10) }, { coalesce: 'crt:burnIn' });
  refreshLogoBugGhost();
});
clock24El.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'clock24'], value: clock24El.checked });
});
hintBarEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'hintBar'], value: hintBarEnabledEl.checked });
  applyHintBarState();
});
hintBarCompactEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'hintBarCompact'], value: hintBarCompactEl.checked });
  applyHintBarState();
});
adVolumeSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['adVolume'], value: parseInt(adVolumeSlider.value, 10) / 100 }, { coalesce: 'settings:adVolume' });
  applyVolume();
});
contentVolumeSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['contentVolume'], value: parseInt(contentVolumeSlider.value, 10) / 100 }, { coalesce: 'settings:contentVolume' });
  applyVolume();
});
guideSlotMinutesSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideSlotMinutes'], value: parseInt(guideSlotMinutesSelect.value, 10) || 30 });
});
guideSlotsSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideSlots'], value: parseInt(guideSlotsSelect.value, 10) || 3 });
});

uiScaleSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'uiScale'], value: uiScaleSelect.value });
  if (window.api && window.api.setUiScale) window.api.setUiScale(S.config.display.uiScale);
});
pictureModeSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['pictureMode'], value: pictureModeSelect.value });
  applyPictureMode();
});
aspectModeSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['aspectMode'], value: aspectModeSelect.value });
  applyAspectMode();
  if (player.videoWidth && player.videoHeight) applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
});
movieModeEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'movieMode'], value: movieModeEnabledEl.checked });
  if (player.videoWidth && player.videoHeight) applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  runCoreHooks('theme-audio-refresh');
});
daypartChimeEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'daypartChimeEnabled'], value: daypartChimeEnabledEl.checked });
});
displayModeAspectSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['displayMode', 'aspect'], value: displayModeAspectSelect.value });
  applyDisplayMode();
});
displayModeWindowSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['displayMode', 'windowMode'], value: displayModeWindowSelect.value });
  applyDisplayMode();
});
// Unlike every other DISPLAY-tab toggle, this one needs the main process to
// actually close and reopen the OS window (frame is a BrowserWindow
// constructor-only option — see main.js's window:setTitleBarHidden) — so the
// config write is flushed with an immediate saveConfig() rather than the
// usual debounce. Debouncing here would risk the window recreating (and
// wiping this renderer's in-memory state) before the setting even reached
// disk, reopening with the OLD value still in config.json. Guarded the same
// way applyDisplayMode's setAspectLock call is: the LAN viewer's window.api
// has no host-only window:* methods at all, so this just persists the config
// value there and lets the actual host pick it up next time it loads it.
hideTitleBarEnabledEl.addEventListener('change', async () => {
  S.config.display.hideTitleBar = hideTitleBarEnabledEl.checked;
  await saveConfigNow();
  if (window.api && window.api.setTitleBarHidden) window.api.setTitleBarHidden(S.config.display.hideTitleBar);
});
displayModeResolutionSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['displayMode', 'resolution'], value: displayModeResolutionSelect.value });
  applyDisplayMode();
});
displayModeAutoPrioritySelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['displayMode', 'autoPriority'], value: displayModeAutoPrioritySelect.value });
  applyDisplayMode();
});
displayModeOverlaysNativeSizeEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['displayMode', 'overlaysNativeSize'], value: displayModeOverlaysNativeSizeEl.checked });
  applyDisplayMode();
});
displayModeUiExtentSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['displayMode', 'uiExtent'], value: displayModeUiExtentSelect.value });
  applyDisplayMode();
});
logoBugMotionSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'logoBugMotion'], value: logoBugMotionSelect.value });
  applyLogoBugMotion();
});
crtOverlayWholeScreenEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['crtIntensity', 'overlayScope'], value: crtOverlayWholeScreenEnabledEl.checked ? 'wholeScreen' : 'video' });
  applyCrtState();
});
ignoreThemeCrtBiasEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'ignoreThemeCrtBias'], value: ignoreThemeCrtBiasEnabledEl.checked });
  applyCrtState();
});
bezelInsetScaleSlider?.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['display', 'bezelInsetScale'], value: parseInt(bezelInsetScaleSlider.value, 10) }, { coalesce: 'settings:display.bezelInsetScale' });
  if (player.videoWidth && player.videoHeight) applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
});
bootPowerAnimEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'bootPowerOnAnim'], value: bootPowerAnimEnabledEl.checked });
});
guideOpenCloseAnimEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideOpenCloseAnim'], value: guideOpenCloseAnimEnabledEl.checked });
  refreshDependentControls();
});
guideLivePreviewEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideLivePreview'], value: guideLivePreviewEnabledEl.checked });
  applyGuideDockMode();
});
// Where special (plugin) channels sit in the guide (docs/design/11 §2.1).
const guideSpecialsTopEnabledEl = document.getElementById('guide-specials-top-enabled');
// Full names or abbreviated call letters in the guide rail (docs/design/11 §2.2).
const guideChannelNamesSelect = document.getElementById('guide-channel-names-select');
guideChannelNamesSelect?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideChannelNames'], value: guideChannelNamesSelect.value === 'short' ? 'short' : 'full' });
});
// Runs of very short programs merged into one "Shorts & bumpers" cell.
const guideMergeShortsEl = document.getElementById('guide-merge-shorts-enabled');
guideMergeShortsEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideMergeShorts'], value: guideMergeShortsEl.checked });
});
guideSpecialsTopEnabledEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideSpecialsAtTop'], value: guideSpecialsTopEnabledEl.checked });
});
guideAnimSpeedSlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideOpenCloseAnimMs'], value: parseInt(guideAnimSpeedSlider.value, 10) }, { coalesce: 'settings:display.guideOpenCloseAnimMs' });
});
guideCardDurationSlider?.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['display', 'guideCardDuration'], value: parseInt(guideCardDurationSlider.value, 10) || 4000 }, { coalesce: 'settings:display.guideCardDuration' });
});
reminderLeadMinutesSlider?.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['reminderLeadMinutes'], value: parseInt(reminderLeadMinutesSlider.value, 10) || 1 }, { coalesce: 'settings:reminderLeadMinutes' });
});
hintBarSlideEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['display', 'hintBarSlide'], value: hintBarSlideEnabledEl.checked });
  hintBarShowDurationEl.disabled = !hintBarSlideEnabledEl.checked;
  hintBarHideDurationEl.disabled = !hintBarSlideEnabledEl.checked;
  applyHintBarState();
});
hintBarShowDurationEl.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['display', 'hintBarShowDuration'], value: parseInt(hintBarShowDurationEl.value, 10) }, { coalesce: 'settings:display.hintBarShowDuration' });
  hintBarShowDurationValEl.textContent = `${S.config.display.hintBarShowDuration}ms`;
  applyHintBarState();
});
hintBarHideDurationEl.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['display', 'hintBarHideDuration'], value: parseInt(hintBarHideDurationEl.value, 10) }, { coalesce: 'settings:display.hintBarHideDuration' });
  hintBarHideDurationValEl.textContent = `${S.config.display.hintBarHideDuration}ms`;
  applyHintBarState();
});
noSignalTitleInput.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['display', 'noSignalTitle'], value: noSignalTitleInput.value.slice(0, 48) }, { coalesce: 'settings:display.noSignalTitle' });
});
noSignalMessageInput.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['display', 'noSignalMessage'], value: noSignalMessageInput.value.slice(0, 120) }, { coalesce: 'settings:display.noSignalMessage' });
});
noSignalCopyReset.addEventListener('click', () => {
  dispatch([
    { type: 'settings.set', path: ['display', 'noSignalTitle'], value: '' },
    { type: 'settings.set', path: ['display', 'noSignalMessage'], value: '' },
  ], { label: 'Reset no-signal message' });
  noSignalTitleInput.value = '';
  noSignalMessageInput.value = '';
});
timeMachineEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['timeMachine', 'enabled'], value: timeMachineEnabledEl.checked });
  if (!S.config.timeMachine.enabled && S.timeMachineOn) exitTimeMachine({ toLive: true });
});
