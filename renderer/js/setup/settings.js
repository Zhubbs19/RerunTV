// DISPLAY / AUDIO & SYSTEM box-wide settings, the setup-tab bar itself
// (CHANNELS/DISPLAY/PROGRAMMING/AUDIO), and the cross-tab settings search.
// The tab bar, search, HELP tab and the larger panels now live in sibling modules
// (tabs.js, search.js, help.js, ...); this file re-exports the names other
// modules import from here.
import { CUSTOM_SOUND_SLOTS } from '../core/audio.js';
import { applyLogoBugPlacement } from '../playback/broadcast-fx.js';
import { applyHintBarState } from '../playback/power.js';
import { S, commitInPlace, dispatch } from '../core/state.js';
import { buildDynamicOverlaysEditor, buildLogoBugProfileEditor, safeApi, attachSliderReadout } from './util.js';
import { themePackEntries, getThemePack } from '../plugin/host.js';
import { effectiveThemeId } from '../display/identity.js';
import { renderInterstitialsList, renderPresetsList } from './interstitials.js';
import { initFlowBuilder, renderFlowsList } from './flowbuilder.js';
import { renderAutoCurateList } from './autocurate.js';
import { renderTagTaxonomyPanel } from './tagtaxonomy-ui.js';
import { renderLibraryPanels } from './library.js';
import { renderSplicerPanels } from './splicer.js';
import { renderHouseholdPanel } from './household.js';
import { renderEraPanel } from './eras.js';
import { adVolumeSlider, contentVolumeSlider, crtBurninSlider, crtEnabledEl, crtCurvatureSlider, crtFlickerSlider, crtGrainSlider, crtScanlinesSlider, crtVignetteSlider, clock24El, detailsEnabledEl, guideSlotsSelect, guideSlotMinutesSelect, guideCardDurationSlider, reminderLeadMinutesSlider, hintBarEnabledEl, hintBarCompactEl, hintBarSlideEnabledEl, uiScaleSelect, hintBarShowDurationEl, hintBarShowDurationValEl, hintBarHideDurationEl, hintBarHideDurationValEl, aspectModeSelect, bootPowerAnimEnabledEl, crtOverlayWholeScreenEnabledEl, ignoreThemeCrtBiasEnabledEl, guideOpenCloseAnimEnabledEl, guideAnimSpeedSlider, guideLivePreviewEnabledEl, logoBugEditorEl, logoBugMotionSelect, dynamicOverlaysEditorEl, daypartChimeEnabledEl, movieModeEnabledEl, pictureModeSelect, bezelInsetScaleSlider, upNextDurationSlider, noSignalTitleInput, noSignalMessageInput, displayModeAspectSelect, displayModeWindowSelect, displayModeResolutionSelect, displayModeAutoPrioritySelect, displayModeOverlaysNativeSizeEl, displayModeUiExtentSelect, hideTitleBarEnabledEl, staticDurationSlider, staticDurationVal, staticEnabledEl, staticIntensitySlider, hintBarEl, hintBarItemsListEl, stationIdEnabledEl, stationIdIntervalEl, themeSelect, timeMachineEnabledEl, timeMachineBadgeEl, aspectBarsEl, aspectAutofillEl, aspectAutofillMaxEl, logoBugFollowPictureEl, logoBugRefHeightEl, logoBugDefaultSizeEl, logoBugVaryEl, logoBugHideBreaksEl, logoBugHideNumberEl, triviaEnabledEl, triviaIntervalEl, upNextEnabledEl, pinCodeInputEl, pinLockEnabledEl, keepDisplayAwakeEl, playbackResyncEnabledEl } from '../core/dom.js';
import { THEME_GROUP_ORDER, renderThemeBrowser, renderThemeFontSettingsInline, renderGuideGenreSettings } from './theme-browser.js';
import { renderUsageModeSetting, renderScreenSpeakersSettings } from './screens.js';
import { renderRemindersPanel, renderAirChecksPanel, renderViewingHistoryPanel, renderPcShutdownRows, renderBackupsList } from './system-panels.js';
import { renderControlsPanel, renderBakedBarsStatus } from './controls.js';
import { refreshDependentControls } from './dependent-controls.js';
import { renderViewerUrlStatus, renderViewerControlUrlStatus, renderStartupServerStatus, renderConnectedDevices } from './lan-status.js';
import './search.js';
import './display-controls.js';
export { resetSetupTabs } from './tabs.js';
export { renderViewerUrlStatus, renderViewerControlUrlStatus, renderStartupServerStatus, renderConnectedDevices } from './lan-status.js';
export { renderRemindersPanel, renderViewingHistoryPanel, renderAirChecksPanel, renderBackupsList } from './system-panels.js';

// Live numeric readouts for every box-wide range slider — wired once at
// module load since these elements are all static (not rebuilt per-render),
// unlike the per-channel volume slider (setup-channels.js), which attaches
// its own readout when each channel row is built. Readouts only update on a
// real 'input' event, so renderSettingsPanels (which sets .value directly
// from loaded config, not via user drag) explicitly refreshes them below —
// otherwise a freshly opened settings screen would show every slider's
// readout stuck at its HTML default instead of the loaded value.
const sliderReadouts = [
  crtScanlinesSlider, crtVignetteSlider, crtGrainSlider, crtFlickerSlider, crtCurvatureSlider, crtBurninSlider, staticIntensitySlider,
  adVolumeSlider, contentVolumeSlider,
].map((s) => attachSliderReadout(s, { suffix: '%' }))
  .concat([bezelInsetScaleSlider].map((s) => attachSliderReadout(s, { suffix: '%' })))
  .concat([guideAnimSpeedSlider, guideCardDurationSlider, upNextDurationSlider].map((s) => attachSliderReadout(s, { suffix: 'ms' })))
  .concat([reminderLeadMinutesSlider].map((s) => attachSliderReadout(s, { suffix: ' MIN' })));

// Mirrors guide.js's own guideLivePreviewEnabled() (not exported/shared —
// this one only needs the box-wide default, not the per-channel theme
// override guide.js also has to account for) so the checkbox reflects the
// theme-provided default until the user explicitly sets a value of their
// own, at which point that explicit choice always wins. See
// registerThemePack's guidePreviewDefault field (plugins.js).
function effectiveGuideLivePreview() {
  const display = S.config.display || {};
  if (Object.prototype.hasOwnProperty.call(display, 'guideLivePreview')) return !!display.guideLivePreview;
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber, S.isSetupOpen));
  return !(pack && pack.guidePreviewDefault === false);
}

// Built from the live #hint-bar spans themselves (same "one source of
// truth" pattern the HELP tab's shortcuts grid already uses below) rather
// than a hand-maintained second list — a new hint added to the bar shows up
// here automatically, nothing to keep in sync by hand. Rebuilt in full on
// every settings-screen visit (cheap, ~18 checkboxes) rather than diffed,
// matching how other small lists in this file (e.g. renderPluginsList) work.
// These two hint items only ever show up live if their owning plugin is
// actually installed+enabled (see applyHintBarState's PLUGIN_DEPENDENT_HINTS,
// power.js — this is just the matching UI-side note, not a second source of
// truth for the behavior itself). Flagged here so unchecking one that's
// already invisible because the plugin is off isn't mistaken for broken.
const PLUGIN_DEPENDENT_HINT_NAMES = { 'alert-test': 'EAS Alerts', 'news-alert': 'Breaking News Alerts', 'sap-audio': 'SAP / Alternate Audio' };

function renderHintBarItemsList() {
  if (!hintBarItemsListEl || !hintBarEl) return;
  hintBarItemsListEl.innerHTML = '';
  const hidden = S.config.display.hintBarHidden || [];
  Array.from(hintBarEl.children).forEach((span) => {
    const key = span.dataset.hintKey;
    if (!key || span.dataset.hintMode === 'tv') return; // TV-mode hints aren't per-item toggles
    const label = document.createElement('label');
    label.className = 'shuffle-toggle';
    const pluginName = PLUGIN_DEPENDENT_HINT_NAMES[key];
    if (pluginName) label.title = `Only shows in the bar while the "${pluginName}" plugin is installed and enabled.`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hidden.includes(key);
    checkbox.addEventListener('change', () => {
      const current = Array.isArray(S.config.display.hintBarHidden) ? S.config.display.hintBarHidden : [];
      const next = checkbox.checked ? current.filter((entry) => entry !== key) : [...new Set([...current, key])];
      dispatch({ type: 'settings.set', path: ['display', 'hintBarHidden'], value: next });
      applyHintBarState();
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(span.textContent + (pluginName ? ' *' : '')));
    hintBarItemsListEl.appendChild(label);
  });
  if (Array.from(hintBarEl.children).some((s) => PLUGIN_DEPENDENT_HINT_NAMES[s.dataset.hintKey])) {
    const note = document.createElement('div');
    note.className = 'panel-status';
    // .hintbar-items-list is a wrapping flex row (see setup.css) — flex-basis
    // 100% forces this note onto its own full-width line instead of
    // shrink-wrapping into the checkbox grid like another chip.
    note.style.cssText = 'flex: 1 1 100%; margin-top: 8px;';
    note.textContent = '* Only appears in the bar while its plugin is installed and enabled, regardless of this checkbox.';
    hintBarItemsListEl.appendChild(note);
  }
}

function renderThemeSelectOptions() {
  const current = themeSelect.value;
  themeSelect.innerHTML = '';

  const byGroup = new Map();
  themePackEntries().forEach((entry) => {
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push(entry);
  });
  const groupNames = Array.from(byGroup.keys()).sort((a, b) => {
    const ai = THEME_GROUP_ORDER.indexOf(a);
    const bi = THEME_GROUP_ORDER.indexOf(b);
    if (a === 'OTHER') return 1;
    if (b === 'OTHER') return -1;
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  groupNames.forEach((groupName) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupName;
    byGroup.get(groupName).forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      optgroup.appendChild(opt);
    });
    themeSelect.appendChild(optgroup);
  });

  if (current && !Array.from(themeSelect.options).some((o) => o.value === current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current} (PLUGIN NOT INSTALLED)`;
    themeSelect.appendChild(opt);
  }
}

// Box-wide default logo bug placement — rebuilt each time the settings
// screen is (re)shown, same as renderHintBarItemsList above, since the
// editor's own DOM isn't kept in sync with S.config any other way (it only
// mutates the array it was handed, it doesn't re-read S.config on its own).
function renderLogoBugEditor() {
  logoBugEditorEl.innerHTML = '';
  logoBugEditorEl.appendChild(buildLogoBugProfileEditor(
    () => S.config.display.logoBugProfiles,
    (profiles) => {
      S.config.display.logoBugProfiles = profiles;
      commitInPlace({ type: 'settings.set', path: ['display', 'logoBugProfiles'], value: profiles }, { coalesce: 'display:logoBugProfiles' });
    },
    () => applyLogoBugPlacement(),
  ));
}

// Box-wide default dynamic-overlay rules — same rebuild-on-show reasoning as
// renderLogoBugEditor above.
function renderDynamicOverlaysEditor() {
  dynamicOverlaysEditorEl.innerHTML = '';
  dynamicOverlaysEditorEl.appendChild(buildDynamicOverlaysEditor(
    () => S.config.display.dynamicOverlays,
    (rules) => {
      S.config.display.dynamicOverlays = rules;
      commitInPlace({ type: 'settings.set', path: ['display', 'dynamicOverlays'], value: rules }, { coalesce: 'display:dynamicOverlays' });
    },
  ));
}

function renderCustomSoundSettings() {
  const root = document.getElementById('custom-sounds-list');
  if (!root) return;
  root.innerHTML = '';
  S.config.customSounds = S.config.customSounds || {};
  CUSTOM_SOUND_SLOTS.forEach(([slot, label]) => {
    const row = document.createElement('div');
    row.className = 'custom-sound-row';
    const name = document.createElement('strong');
    name.textContent = label;
    const status = document.createElement('span');
    status.className = 'custom-sound-status';
    const refresh = async () => {
      const value = S.config.customSounds[slot];
      status.textContent = value === false ? 'SILENT' : (typeof value === 'string' ? await window.api.basename(value) : 'BUILT-IN');
    };
    const choose = document.createElement('button');
    choose.type = 'button'; choose.className = 'btn'; choose.textContent = 'CHOOSE…';
    choose.disabled = !window.api.selectAudio;
    choose.addEventListener('click', async () => {
      const path = await safeApi('Opening the file picker', () => window.api.selectAudio());
      if (!path) return;
      dispatch({ type: 'settings.set', path: ['customSounds', slot], value: path });
      refresh();
    });
    const builtIn = document.createElement('button');
    builtIn.type = 'button'; builtIn.className = 'btn'; builtIn.textContent = 'BUILT-IN';
    builtIn.addEventListener('click', () => { dispatch({ type: 'settings.set', path: ['customSounds', slot], value: undefined }); refresh(); });
    const silent = document.createElement('button');
    silent.type = 'button'; silent.className = 'btn'; silent.textContent = 'SILENT';
    silent.addEventListener('click', () => { dispatch({ type: 'settings.set', path: ['customSounds', slot], value: false }); refresh(); });
    row.append(name, status, choose, builtIn, silent);
    root.appendChild(row);
    refresh();
  });
}

export function renderSettingsPanels() {
  const ci = S.config.crtIntensity;
  crtEnabledEl.checked = S.config.crtEnabled !== false;
  crtScanlinesSlider.value = ci.scanlines;
  crtVignetteSlider.value = ci.vignette;
  crtGrainSlider.value = ci.grain;
  crtFlickerSlider.value = ci.flicker != null ? ci.flicker : 50;
  crtCurvatureSlider.value = ci.curvature != null ? ci.curvature : 0;
  crtBurninSlider.value = ci.burnIn != null ? ci.burnIn : 0;
  clock24El.checked = !!S.config.display.clock24;
  hintBarEnabledEl.checked = S.config.display.hintBar !== false;
  hintBarCompactEl.checked = S.config.display.hintBarCompact !== false;
  hintBarSlideEnabledEl.checked = S.config.display.hintBarSlide !== false;
  hintBarShowDurationEl.disabled = !hintBarSlideEnabledEl.checked;
  hintBarHideDurationEl.disabled = !hintBarSlideEnabledEl.checked;
  hintBarShowDurationEl.value = String(S.config.display.hintBarShowDuration);
  hintBarShowDurationValEl.textContent = `${S.config.display.hintBarShowDuration}ms`;
  hintBarHideDurationEl.value = String(S.config.display.hintBarHideDuration);
  hintBarHideDurationValEl.textContent = `${S.config.display.hintBarHideDuration}ms`;
  renderHintBarItemsList();
  adVolumeSlider.value = Math.round((typeof S.config.adVolume === 'number' ? S.config.adVolume : 1) * 100);
  contentVolumeSlider.value = Math.round((typeof S.config.contentVolume === 'number' ? S.config.contentVolume : 1) * 100);
  guideSlotsSelect.value = String(S.config.display.guideSlots || 3);
  guideSlotMinutesSelect.value = String(S.config.display.guideSlotMinutes || 30);
  uiScaleSelect.value = S.config.display.uiScale || 'auto';
  renderUsageModeSetting();
  renderScreenSpeakersSettings();
  logoBugMotionSelect.value = S.config.display.logoBugMotion || 'none';
  renderLogoBugEditor();
  renderDynamicOverlaysEditor();
  renderCustomSoundSettings();
  pictureModeSelect.value = S.config.pictureMode || 'standard';
  aspectModeSelect.value = S.config.aspectMode || 'contain';
  movieModeEnabledEl.checked = !!S.config.display.movieMode;
  daypartChimeEnabledEl.checked = !!S.config.display.daypartChimeEnabled;
  displayModeAspectSelect.value = S.config.displayMode.aspect || '16:9';
  displayModeWindowSelect.value = S.config.displayMode.windowMode || 'letterbox';
  hideTitleBarEnabledEl.checked = !!S.config.display.hideTitleBar;
  displayModeResolutionSelect.value = S.config.displayMode.resolution || 'native';
  displayModeAutoPrioritySelect.value = S.config.displayMode.autoPriority || 'metadata';
  displayModeOverlaysNativeSizeEl.checked = !!S.config.displayMode.overlaysNativeSize;
  displayModeUiExtentSelect.value = S.config.displayMode.uiExtent || 'confined';
  crtOverlayWholeScreenEnabledEl.checked = S.config.crtIntensity.overlayScope === 'wholeScreen';
  ignoreThemeCrtBiasEnabledEl.checked = !!S.config.display.ignoreThemeCrtBias;
  if (bezelInsetScaleSlider) bezelInsetScaleSlider.value = S.config.display.bezelInsetScale != null ? S.config.display.bezelInsetScale : 100;
  bootPowerAnimEnabledEl.checked = S.config.display.bootPowerOnAnim !== false;
  guideOpenCloseAnimEnabledEl.checked = !!S.config.display.guideOpenCloseAnim;
  guideAnimSpeedSlider.value = S.config.display.guideOpenCloseAnimMs || 180;
  guideLivePreviewEnabledEl.checked = effectiveGuideLivePreview();
  const specialsTopEl = document.getElementById('guide-specials-top-enabled');
  if (specialsTopEl) specialsTopEl.checked = !!S.config.display.guideSpecialsAtTop;
  const channelNamesEl = document.getElementById('guide-channel-names-select');
  if (channelNamesEl) channelNamesEl.value = S.config.display.guideChannelNames === 'short' ? 'short' : 'full';
  const mergeShortsEl = document.getElementById('guide-merge-shorts-enabled');
  if (mergeShortsEl) mergeShortsEl.checked = S.config.display.guideMergeShorts !== false;
  if (guideCardDurationSlider) {
    guideCardDurationSlider.value = S.config.display.guideCardDuration != null ? S.config.display.guideCardDuration : 4000;
  }
  if (reminderLeadMinutesSlider) {
    reminderLeadMinutesSlider.value = S.config.reminderLeadMinutes != null ? S.config.reminderLeadMinutes : 1;
  }
  renderRemindersPanel();
  renderAirChecksPanel();
  renderViewingHistoryPanel();
  renderHouseholdPanel();
  renderEraPanel();
  if (keepDisplayAwakeEl) keepDisplayAwakeEl.checked = S.config.keepDisplayAwake?.enabled !== false;
  if (playbackResyncEnabledEl) playbackResyncEnabledEl.checked = S.config.playbackResync?.enabled !== false;
  renderPcShutdownRows();
  noSignalTitleInput.value = S.config.display.noSignalTitle || '';
  noSignalMessageInput.value = S.config.display.noSignalMessage || '';
  renderThemeSelectOptions();
  themeSelect.value = S.config.theme || 'digital-2000s';
  renderThemeBrowser();
  renderThemeFontSettingsInline();
  renderGuideGenreSettings();
  upNextEnabledEl.checked = S.config.upNext.enabled !== false;
  if (upNextDurationSlider) {
    upNextDurationSlider.value = S.config.upNext.duration != null ? S.config.upNext.duration : 8000;
  }
  detailsEnabledEl.checked = S.config.details.enabled !== false;
  timeMachineEnabledEl.checked = !!S.config.timeMachine.enabled;
  timeMachineBadgeEl.checked = S.config.timeMachine.showTimeShiftBadge !== false;
  renderControlsPanel();
  aspectBarsEl.checked = !!S.config.display.removeBakedBars;
  renderBakedBarsStatus();
  aspectAutofillEl.checked = !!S.config.display.autoFillWidescreen;
  aspectAutofillMaxEl.value = Number.isFinite(S.config.display.autoFillMaxCropPct) ? S.config.display.autoFillMaxCropPct : 30;
  logoBugFollowPictureEl.checked = S.config.display.logoBugFollowPicture !== false;
  logoBugRefHeightEl.value = S.config.display.logoBugReferenceHeight != null ? String(S.config.display.logoBugReferenceHeight) : 'auto';
  const refHelp = logoBugRefHeightEl.closest('.setting-row')?.querySelector('.setting-row-help');
  if (refHelp) {
    if (!refHelp.dataset.base) refHelp.dataset.base = refHelp.textContent;
    const dpr = window.devicePixelRatio || 1;
    refHelp.textContent = `${refHelp.dataset.base} This display: ${Math.round(window.screen.width * dpr)}×${Math.round(window.screen.height * dpr)}; sizes set for ${S.config.display.logoBugAuthoredHeight || 1080}p.`;
  }
  const defaultProfile = (S.config.display.logoBugProfiles || []).find((p) => !p.aspect && !p.resolution);
  logoBugDefaultSizeEl.value = String((defaultProfile && defaultProfile.size) || 46);
  const sizeReadout = document.getElementById('logo-bug-default-size-value');
  if (sizeReadout) sizeReadout.textContent = `${logoBugDefaultSizeEl.value} PX`;
  logoBugVaryEl.checked = !!S.config.display.logoBugVaryWithContent;
  logoBugHideBreaksEl.checked = !!S.config.display.logoBugHideOnBreaks;
  logoBugHideNumberEl.checked = !!S.config.display.logoBugHideNumber;
  stationIdEnabledEl.checked = S.config.stationId.enabled !== false;
  stationIdIntervalEl.value = S.config.stationId.intervalMinutes || 15;
  staticEnabledEl.checked = S.config.staticEffect.enabled !== false;
  staticIntensitySlider.value = S.config.staticEffect.intensity != null ? S.config.staticEffect.intensity : 100;
  if (staticDurationSlider) {
    const durMs = S.config.staticEffect.durationMs != null ? S.config.staticEffect.durationMs : 150;
    staticDurationSlider.value = durMs;
    if (staticDurationVal) staticDurationVal.textContent = durMs === 0 ? '0ms (INSTANT)' : `${durMs}ms`;
  }
  refreshDependentControls();
  triviaEnabledEl.checked = !!S.config.trivia.enabled;
  triviaIntervalEl.value = S.config.trivia.intervalMinutes || 20;
  if (!S.config.pinLock) S.config.pinLock = { enabled: false, code: '1234' };
  if (pinLockEnabledEl) pinLockEnabledEl.checked = !!S.config.pinLock.enabled;
  if (pinCodeInputEl) pinCodeInputEl.value = S.config.pinLock.code || '1234';
  renderFlowsList();
  renderInterstitialsList();
  renderPresetsList();
  renderAutoCurateList();
  renderTagTaxonomyPanel();
  renderLibraryPanels();
  renderSplicerPanels();
  renderBackupsList();
  renderViewerUrlStatus();
  renderViewerControlUrlStatus();
  renderStartupServerStatus();
  renderConnectedDevices();
  sliderReadouts.forEach((r) => r.refresh());
}

initFlowBuilder();
