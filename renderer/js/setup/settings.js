// DISPLAY / AUDIO & SYSTEM box-wide settings, the setup-tab bar itself
// (CHANNELS/DISPLAY/PROGRAMMING/AUDIO), and the cross-tab settings search.
import { applyConfigDefaults } from '../app.js';
import { CUSTOM_SOUND_SLOTS } from '../core/audio.js';
import { applyDisplayMode } from '../display/mode.js';
import { applyLogoBugMotion, applyLogoBugPlacement, refreshLogoBugGhost, updateLogoBug } from '../playback/broadcast-fx.js';
import { applyAspectMode, applyPictureMode, applyCrtState, applyHintBarState, applyVolume, applyTvBezel, applyDisplayWakeLock } from '../playback/power.js';
import { applyTheme } from '../display/themes.js';
import { S, commitInPlace, dispatch, saveConfigNow, pushUndoSnapshot } from '../core/state.js';
import { getAudioOutputChoice, isAudioOutputPresent, listAudioOutputs, setAudioOutput } from '../display/audio-output.js';
import { getTvModeScreen, setTvModeScreen } from '../tv/usage-mode.js';
import { flashScreenEdgeGuide, getCurrentScreen, getScreenEdge, getScreenOffAction, onCurrentScreenChange, setScreenEdge, setScreenOffAction } from '../display/tv-screen.js';
import { applyLeveler } from '../playback/leveler.js';
import { applyBakedBars } from '../playback/bars.js';
import { KEY_ACTIONS, effectiveKey, keyProblem } from '../core/keymap.js';
import { applyKeyHints } from '../core/key-remap.js';
import { defaultForPath } from '../core/setting-defaults.js';
import { renderHighlights } from '../update/highlights.js';
import { getUsageModePreference, onUsageModeChange, setTvPreview, setUsageModePreference, usageMode, usageModeSource } from '../tv/usage-mode.js';
import { installSettingDependencies, settingRowControl, settingRowSearchText, syncSettingDependencies } from '../ui/field.js';
import { searchActions } from './command-palette.js';
import { searchUpcomingPrograms } from '../guide/program-search.js';
import { viewNow } from '../core/state.js';
import { formatChannelNumber, sortedChannels } from '../core/channels.js';
import { getChannel } from '../core/channels.js';
import { exitTimeMachine, updateTimeShiftBadge } from '../playback/timemachine.js';
import { pad2, toDatetimeLocalValue, escapeHtml, readableReleaseNotes } from '../core/util.js';
import { buildDynamicOverlaysEditor, buildLogoBugProfileEditor, parsePositiveInt } from './util.js';
import { getPluginSearchEntries, runCoreHooks, themePackEntries, getThemePack } from '../plugin/host.js';
import { themeCheckBadge, themeCheckResult } from '../display/theme-check.js';
import { Badge } from '../ui/button.js';
import { effectiveThemeId } from '../display/identity.js';
import { applyGuideDockMode } from '../guide/guide.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { initBackups, renderBackupsList as renderBackupsListFeature } from './backups.js';
import {
  DEFAULT_GUIDE_GENRES, defaultGuideGenreColor, guideGenreThemeConfig, normalizeGuideGenre,
} from '../guide/genres.js';
import { renderCommercialsPanel, renderInterstitialsList, renderPresetsList, renderStandbyPanel } from './interstitials.js';
import { initFlowBuilder, renderFlowsList } from './flowbuilder.js';
import { renderAutoCurateList } from './autocurate.js';
import { renderTagTaxonomyPanel } from './tagtaxonomy-ui.js';
import { renderLibraryPanels } from './library.js';
import { renderSplicerPanels } from './splicer.js';
import { refreshHouseholdPanel, renderHouseholdPanel } from './household.js';
import { renderEraPanel } from './eras.js';
import { attachSliderReadout } from './util.js';
import { renderChannelList } from './channels.js';
import { renderBoxStatus } from './channels-diagnostics.js';
import { hidePinLockScreen } from './pin-lock.js';
import { renderThemeFontSettings } from './plugin-settings.js';
import {
  adVolumeSlider, contentVolumeSlider, crtBurninSlider, crtEnabledEl, crtCurvatureSlider, crtFlickerSlider, crtGrainSlider, crtScanlinesSlider,
  crtVignetteSlider,
  clock24El, detailsEnabledEl,
  guideSlotsSelect, guideSlotMinutesSelect, guideCardDurationSlider, reminderLeadMinutesSlider, hintBarEnabledEl, hintBarCompactEl, hintBarSlideEnabledEl, uiScaleSelect,
  hintBarShowDurationEl, hintBarShowDurationValEl, hintBarHideDurationEl, hintBarHideDurationValEl,
  aspectModeSelect, bootPowerAnimEnabledEl, crtOverlayWholeScreenEnabledEl, ignoreThemeCrtBiasEnabledEl, guideOpenCloseAnimEnabledEl, guideAnimSpeedSlider,
  guideLivePreviewEnabledEl,
  logoBugEditorEl, logoBugMotionSelect, dynamicOverlaysEditorEl, daypartChimeEnabledEl, movieModeEnabledEl, pictureModeSelect, bezelInsetScaleSlider,
  upNextDurationSlider,
  noSignalTitleInput, noSignalMessageInput, noSignalCopyReset,
  displayModeAspectSelect, displayModeWindowSelect, displayModeResolutionSelect, displayModeAutoPrioritySelect,
  displayModeOverlaysNativeSizeEl, displayModeUiExtentSelect, hideTitleBarEnabledEl,
  viewerEnabledEl, viewerUrlStatusEl, controlUrlStatusEl, startupServerEnabledEl, startupServerStatusEl, connectedDevicesListEl, setupScreen,
  setupSearchEl, setupSearchResultsEl, setupSearchEmptyEl, staticDurationSlider, staticDurationVal, staticEnabledEl, staticIntensitySlider,
  setupBreadcrumbEl, helpShortcutsGridEl, helpChangelogListEl, helpVersionEl, checkUpdatesBtn,
  updateModeSelect, updateStatusLineEl, updateSettingsPanelEl,
  helpReleaseNotesListEl, releaseNotesPanelEl,
  helpGuideListEl, helpGuideSearchEl, helpPrintManualBtn, hintBarEl, hintBarItemsListEl,
  player,
  stationIdEnabledEl, stationIdIntervalEl, themeSelect,
  themeBrowserToggle, themeBrowserCurrentLabel, themeBrowserEl, themeBrowserSearch, themeBrowserClose, themeBrowserGroups, themeBrowserEmpty,
  timeMachineEnabledEl, timeMachineBadgeEl, aspectBarsEl, aspectAutofillEl, aspectAutofillMaxEl, logoBugFollowPictureEl, logoBugRefHeightEl, logoBugDefaultSizeEl, logoBugVaryEl, logoBugHideBreaksEl, logoBugHideNumberEl, startupChannelEl, entryDelayEl, scanDwellEl, sleepStepsEl, volumeStepEl, volumeMaxEl, rememberChannelVolumeEl, tuneFadeInEl, sleepFadeOutEl, triviaEnabledEl, triviaIntervalEl, upNextEnabledEl,
  pinCancelBtn, pinCodeInputEl, pinCodeRevealBtn, pinLockEnabledEl,
  reminderAutoTuneEl, reminderNotifyEl, remindersListEl, remindersClearAllBtn,
  airChecksListEl, airChecksClearAllBtn,
  keepDisplayAwakeEl, playbackResyncEnabledEl,
  viewingHistoryEnabledEl, historyListEl, historyTotalTimeEl, historyRowCountEl,
  historyTopChannelEl, historyTopTitleEl, historyRefreshBtn, historyClearBtn,
} from '../core/dom.js';
import { airCheckLabel, airChecks, clearAirChecks, removeAirCheck } from '../library/airchecks.js';
import { clearViewingHistory, formatWatchTime, listViewingHistory, summarizeHistory } from '../playback/history.js';
import { currentProfile, personalCommand } from '../personal/state.js';

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

function setDependentControlState(control, enabled) {
  if (!control) return;
  control.disabled = !enabled;
  const row = control.closest('.setting-row');
  if (row) row.classList.toggle('is-disabled', !enabled);
  else control.closest('label, .panel-interval')?.classList.toggle('control-disabled', !enabled);
}

function refreshDependentControls() {
  setDependentControlState(guideAnimSpeedSlider, guideOpenCloseAnimEnabledEl.checked);
  setDependentControlState(staticIntensitySlider, staticEnabledEl.checked);
  setDependentControlState(staticDurationSlider, staticEnabledEl.checked);
  // With CRT switched off the sliders keep their values but do nothing, so
  // show them as unavailable rather than letting them look live.
  [crtScanlinesSlider, crtVignetteSlider, crtGrainSlider, crtFlickerSlider, crtCurvatureSlider]
    .forEach((slider) => setDependentControlState(slider, crtEnabledEl.checked));
  // Every other data-depends-on row (ui/field.js).
  syncSettingDependencies(setupScreen);
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

// Theme options now come from installed "pack" plugins (registerThemePack,
// plugins.js) instead of a hardcoded HTML <option> list — rebuilt each time
// the settings screen renders, same as renderLogoBugEditor below, since the
// installed-plugin set can change (install/enable/disable) between visits.
// Preserves the current selection even if its pack isn't in the list this
// time (e.g. that plugin was just disabled) — options list is what plugins
// exist, not what's currently selected, so a still-selected-but-now-
// unavailable theme doesn't silently jump to something else under the user.
// Group order is deliberate (not alphabetical) — physical-era themes first
// since they're the most commonly picked, "OTHER" (any pack with no group
// field) always last as a catch-all rather than wherever it'd alphabetize
// to. A group name not in this list (a new one a theme plugin introduces)
// still renders — just appended after these, alphabetically among any
// other unlisted groups — so nothing silently disappears if a pack picks a
// group name that isn't pre-registered here.
const THEME_GROUP_ORDER = ['ERA (BY DECADE)', 'REAL CABLE-BOX UI', 'BROADCAST/STUDIO', 'STYLIZED'];

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

// Surfaces the same THEME TYPOGRAPHY control PLUGINS > [theme] > SETTINGS
// already has (renderThemeFontSettings, setup-plugin-settings.js) right next
// to the theme picker itself — customizing the theme you're looking at
// shouldn't require knowing it's really a plugin under the hood and finding
// its settings panel on a different tab. Re-render on every theme switch
// since the override values shown are per-theme.
function renderThemeFontSettingsInline() {
  const container = document.getElementById('display-theme-font-settings');
  if (!container) return;
  renderThemeFontSettings(container, S.config.theme || 'digital-2000s');
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
      const path = await window.api.selectAudio();
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

import { startPerfMonitor, stopPerfMonitor } from '../core/perf.js';
import { openPluginFromSearch, renderPluginsTab, reportPluginAttention } from './plugins.js';
import { refreshSidebarBadges } from './sidebar.js';
import { renderPluginDiagnostics } from '../plugin/diagnostics.js';

// ---------- Settings screen tabs ----------
const setupTabBtns = document.querySelectorAll('.setup-tab-btn');
const setupTabPanels = document.querySelectorAll('.setup-tab-panel');
// The page body scrolls inside #setup-content; the sidebar, header and status
// bar stay put (docs/design/03 §4).
const setupContentEl = document.getElementById('setup-content');
const settingsViewButtons = {
  simple: document.getElementById('setup-view-simple'),
  advanced: document.getElementById('setup-view-advanced'),
};
const SETTINGS_VIEW_KEY = 'reruntv.settingsView';
let settingsView = 'advanced';
installSettingDependencies(setupScreen);

// Watch TV in the sidebar is the same action as the status bar's button.
document.getElementById('setup-watch-btn')?.addEventListener('click', () => document.getElementById('done-btn')?.click());


// ---------- Breadcrumb + session resume ----------
// Session resume is deliberately in-memory only (not written to
// S.config/disk) — it's "don't lose my place if I tab away to watch
// something and press S again," not a persisted preference that should
// survive an app restart. Only the top-level tab needs explicit tracking —
// each .setup-subtabs bar already remembers its own last-clicked sub-tab
// for free, since its buttons keep their .active class on the same live
// DOM elements across setup-screen show/hide (this is an SPA, nothing gets
// torn down); restoreActiveSubtabPanels() below already re-applies
// whichever sub-tab is currently marked active.
let lastSetupTab = 'channels';

// This is a per-device navigation preference, not part of the shared channel
// config. The same controls and save handlers are used in both views.
function setSettingsView(view, persist = true) {
  const nextView = view === 'simple' ? 'simple' : 'advanced';
  const changed = settingsView !== nextView;
  settingsView = nextView;
  setupScreen.dataset.settingsView = settingsView;
  Object.entries(settingsViewButtons).forEach(([name, button]) => {
    button?.setAttribute('aria-pressed', String(name === settingsView));
  });
  if (persist) {
    try { window.localStorage.setItem(SETTINGS_VIEW_KEY, settingsView); } catch (e) { /* storage unavailable */ }
  }
  if (changed && persist && setupContentEl) setupContentEl.scrollTop = 0;
  if (changed && persist && S.config?.channels) renderChannelList();
  const activeTab = Array.from(setupTabBtns).find((button) => button.classList.contains('active'));
  if (activeTab) updateSetupHeading(activeTab.dataset.tab);
  if (settingsView !== 'simple') return;
  if (activeTab && !activeTab.hasAttribute('data-simple-settings')) {
    document.querySelector('.setup-tab-btn[data-tab="channels"]')?.click();
    return;
  }
  const activePanel = document.querySelector('.setup-tab-panel:not(.hidden)');
  const activeSubtab = activePanel?.querySelector('.setup-subtab-btn.active');
  if (activeSubtab && !activeSubtab.hasAttribute('data-simple-settings')) {
    activePanel.querySelector('.setup-subtab-btn[data-simple-settings]')?.click();
  }
}

function isSimpleSearchTarget(target) {
  const tabPanel = target.closest('.setup-tab-panel');
  if (!tabPanel) return true;
  const tabButton = document.querySelector(`.setup-tab-btn[data-tab="${tabPanel.dataset.tabPanel}"]`);
  if (!tabButton?.hasAttribute('data-simple-settings')) return false;
  const subPanel = target.closest('.setup-subtab-panel');
  if (subPanel && !tabPanel.querySelector(`.setup-subtab-btn[data-subtab="${subPanel.dataset.subtabPanel}"]`)?.hasAttribute('data-simple-settings')) return false;
  if (['display', 'guide', 'audio'].includes(tabPanel.dataset.tabPanel)) {
    const panel = target.closest('.panel');
    if (panel && !panel.hasAttribute('data-simple-settings')) return false;
    const row = target.closest('.setting-row');
    if (row && panel && !row.hasAttribute('data-simple-settings')) return false;
  }
  return true;
}

// Sections follow docs/design/03 §3. The data-tab ids are older than the
// names: display is Picture & sound, audio is System.
const SETUP_SECTION_COPY = {
  channels: ['CHANNEL LINEUP', 'Build and manage the channels you watch, their media, identity, and schedule.'],
  programming: ['PROGRAMMING', 'Shape show timing, breaks, bumpers, and automation.'],
  library: ['LIBRARY', 'Keep channel folders in sync and tidy the tags that connect your media.'],
  display: ['PICTURE & SOUND', 'Picture, the CRT look, display mode, volume, and sounds.'],
  guide: ['GUIDE & THEME', 'The theme, the guide, the clock and hint bar, reminders, and on-screen overlays.'],
  household: ['HOUSEHOLD', 'The parental lock, this device, and the other screens that watch along.'],
  audio: ['SYSTEM', 'Power, updates, backups, air checks, and diagnostics.'],
  plugins: ['PLUGINS', 'Manage optional channels, themes, on-screen features, integrations, and their permissions.'],
  help: ['HELP', 'How the box works, keyboard shortcuts, and what’s new.'],
};
const SIMPLE_SECTION_DESCRIPTIONS = {
  channels: 'Add a channel, choose its media, and start watching.',
  display: 'Adjust the picture, screen, speakers, and volume.',
  guide: 'Choose the guide theme, era, clock, and hint bar.',
  audio: 'Set startup and power behavior, updates, and backups.',
  help: 'Get started and find keyboard shortcuts.',
};

// System › Diagnostics refreshes every second while it is on screen, and only then.
function syncDiagnosticsMonitor() {
  const statusPanel = document.querySelector('.setup-subtab-panel[data-subtab-panel="status"]');
  const tabPanel = statusPanel?.closest('.setup-tab-panel');
  const visible = statusPanel && !statusPanel.classList.contains('hidden') && !tabPanel.classList.contains('hidden');
  if (visible) {
    startPerfMonitor();
    renderBoxStatus();
  } else {
    stopPerfMonitor();
  }
}

function updateSetupHeading(tab) {
  const [title, description] = SETUP_SECTION_COPY[tab] || SETUP_SECTION_COPY.channels;
  const titleEl = document.getElementById('setup-page-title');
  const descriptionEl = document.getElementById('setup-page-description');
  if (titleEl) titleEl.textContent = title;
  if (descriptionEl) descriptionEl.textContent = settingsView === 'simple' ? (SIMPLE_SECTION_DESCRIPTIONS[tab] || description) : description;
}

function closeSettingsSearch() {
  if (setupSearchResultsEl) {
    setupSearchResultsEl.classList.add('hidden');
    setupSearchResultsEl.innerHTML = '';
  }
  if (setupSearchEl) setupSearchEl.setAttribute('aria-expanded', 'false');
  if (setupSearchEl) setupSearchEl.removeAttribute('aria-activedescendant');
  if (setupSearchEmptyEl) setupSearchEmptyEl.classList.add('hidden');
}

// Restarts the .panel-reveal fade — a plain class add is a no-op if the
// panel already carries it from a previous switch, so force a reflow
// between removing and re-adding (same technique as the guide crossfades).
function revealPanel(panel) {
  if (!panel) return;
  panel.classList.remove('panel-reveal');
  void panel.offsetWidth;
  panel.classList.add('panel-reveal');
}

function updateBreadcrumb() {
  if (!setupBreadcrumbEl) return;
  const activeTabBtn = Array.from(setupTabBtns).find((b) => b.classList.contains('active'));
  if (!activeTabBtn) { setupBreadcrumbEl.textContent = ''; return; }
  updateSetupHeading(activeTabBtn.dataset.tab);
  const parts = [activeTabBtn.textContent.trim()];
  const activePanel = Array.from(setupTabPanels).find((p) => p.dataset.tabPanel === activeTabBtn.dataset.tab);
  const subBtn = activePanel && activePanel.querySelector('.setup-subtabs .setup-subtab-btn.active');
  if (subBtn) parts.push(subBtn.textContent.trim());
  // A section with no sub-tabs is already named by the page title.
  if (parts.length === 1) { setupBreadcrumbEl.textContent = ''; return; }
  setupBreadcrumbEl.innerHTML = parts
    .map((p, i) => (i === parts.length - 1 ? `<span class="crumb-current">${p}</span>` : p))
    .join('<span class="crumb-sep">›</span>');
}

setupTabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (settingsView === 'simple' && !btn.hasAttribute('data-simple-settings')) setSettingsView('advanced');
    // Leaving the page you searched from also ends the search, so the box doesn't keep a stale query.
    if (setupSearchEl) setupSearchEl.value = '';
    closeSettingsSearch();
    const tab = btn.dataset.tab;
    lastSetupTab = tab;
    setupTabBtns.forEach((b) => b.classList.toggle('active', b === btn));
    setupTabPanels.forEach((p) => p.classList.toggle('hidden', p.dataset.tabPanel !== tab));
    revealPanel(Array.from(setupTabPanels).find((p) => p.dataset.tabPanel === tab));
    if (tab === 'help') renderHelpTab();
    if (tab === 'plugins') { renderPluginsTab(); renderPluginDiagnostics(); }
    if (tab === 'household') refreshHouseholdPanel();
    restoreActiveSubtabPanels();
    syncDiagnosticsMonitor();
    updateBreadcrumb();
    if (setupContentEl) setupContentEl.scrollTop = 0;
  });
});

// Resumes whichever top-level tab (and, within it, sub-tab) was last open
// this session instead of always landing on CHANNELS — the setup screen's
// tab/sub-tab nesting got deep enough (5 tabs × several sub-tabs × a
// per-channel edit view with its own 6 tabs) that losing your place every
// time you glance back at the TV screen and press S again got old.
export function resetSetupTabs() {
  setupSearchEl.value = '';
  closeSettingsSearch();
  setupTabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === lastSetupTab));
  setupTabPanels.forEach((p) => p.classList.toggle('hidden', p.dataset.tabPanel !== lastSetupTab));
  if (lastSetupTab === 'help') renderHelpTab();
  if (lastSetupTab === 'plugins') { renderPluginsTab(); renderPluginDiagnostics(); }
  if (lastSetupTab === 'household') refreshHouseholdPanel();
  restoreActiveSubtabPanels();
  syncDiagnosticsMonitor();
  updateBreadcrumb();
  refreshSidebarBadges();
  reportPluginAttention();
}

// ---------- Second-level sub-tabs within a single top-level tab ----------
// Generic — any `.setup-subtabs` bar wires up its sibling `.setup-subtab-
// panel` elements the same way the top-level tab bar above does, just
// scoped to its own parent instead of the whole document. Used to split a
// top-level tab that outgrew "everything in one scroll" (DISPLAY, PROGRAMMING,
// AUDIO & SYSTEM) — see index.html for the markup shape.
document.querySelectorAll('.setup-subtabs').forEach((bar) => {
  const parent = bar.parentElement;
  const btns = Array.from(bar.querySelectorAll('.setup-subtab-btn'));
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (settingsView === 'simple' && !btn.hasAttribute('data-simple-settings')) setSettingsView('advanced');
      btns.forEach((b) => b.classList.toggle('active', b === btn));
      parent.querySelectorAll(':scope > .setup-subtab-panel').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.subtabPanel !== btn.dataset.subtab);
      });
      revealPanel(parent.querySelector(`:scope > .setup-subtab-panel[data-subtab-panel="${btn.dataset.subtab}"]`));
      syncDiagnosticsMonitor();
      updateBreadcrumb();
    });
  });
});

settingsViewButtons.simple?.addEventListener('click', () => setSettingsView('simple'));
settingsViewButtons.advanced?.addEventListener('click', () => setSettingsView('advanced'));
try { setSettingsView(window.localStorage.getItem(SETTINGS_VIEW_KEY), false); }
catch (e) { setSettingsView('advanced', false); }

// Re-applies whichever sub-tab is currently marked active in each bar —
// needed after the global search below temporarily reveals every sub-tab
// panel at once (so a match hiding in an inactive sub-tab is still found).
function restoreActiveSubtabPanels() {
  document.querySelectorAll('.setup-subtabs').forEach((bar) => {
    const activeBtn = bar.querySelector('.setup-subtab-btn.active') || bar.querySelector('.setup-subtab-btn');
    if (!activeBtn) return;
    bar.parentElement.querySelectorAll(':scope > .setup-subtab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.subtabPanel !== activeBtn.dataset.subtab);
    });
  });
}

// ---------- HELP tab: feature guide + shortcuts reference + changelog ----------
// The shortcuts grid is built from the hint bar's own spans (index.html)
// rather than a second hand-typed copy — one source of truth for "what do
// the keys do," so this can't drift out of sync with the real hint bar the
// way a duplicated list would the next time a shortcut changes. The guide
// below has no such live source to build from (it's explaining *why*/*how*,
// not reciting an existing list), so it's hand-written and needs updating by
// hand when a covered feature changes shape.
let helpTabRendered = false;

// Written to be read by an actual beginner, not a hobbyist who already knows
// what a "bumper pool" is — short sentences, plain everyday words, one idea
// per paragraph. Still uses numbered SECTIONs and NOTE:/TIP:/CAUTION:
// callouts (renderHelpGuide below bolds those words) since that structure
// genuinely helps scanning, but the prose itself should read like a friendly
// person explaining the app, not a 1980s owner's manual. `group` doubles as
// the SECTION heading shown above a run of same-group entries.
const HELP_GUIDE = [
  { group: 'SECTION 1 — WELCOME', title: 'Getting Started With This Guide', body: [
    'Welcome! This guide explains what everything in the setup screen does, organized by tab so it\'s easy to find what you need.',
    'TIP: Use the SEARCH THE GUIDE box above if you already know roughly what you\'re looking for — it searches both the topic titles and the text inside them.',
    'Don\'t feel like you need to read this all at once. Most people just build their first channel (see SECTION 2 below) and come back here later when they want to try something new.',
  ] },
  { group: 'SECTION 2 — GETTING STARTED', title: '2.1 Setting Up Your First Channel', body: [
    'STEP 1: Go to the LINEUP tab and click "+ ADD CHANNEL". A new, empty channel will show up.',
    'STEP 2: Click "ADD FOLDER" and pick a folder of video files on your computer. The app scans it, figures out how long each video is, and builds a playlist for you automatically. A big folder might take a minute — that\'s normal.',
    'STEP 3: Want more than one folder on the same channel? Just repeat step 2. You could put cartoons and movies on the same channel, or keep them on separate channels — totally up to you.',
    'NOTE: You can rename a channel or change its number any time by clicking directly on its NAME or NUMBER in the list.',
    'TIP: Checking "SHUFFLE ORDER" mixes up the playback order once. It won\'t keep re-shuffling every time the channel loops — uncheck and recheck it whenever you want a new shuffle.',
    'STEP 4: When you\'re ready, click "START WATCHING" in the bottom-right corner to leave this screen and start watching. That\'s it!',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.1 Editing a Channel: Folders, Schedule, Titles, Ads, and Logo', body: [
    'Click "EDIT" on any channel to open its full settings. Its tabs are grouped under CONTENT (FOLDERS, TITLES, SCHEDULE), LOOK (LOGO, OVERLAYS, TICKER, IDENTITY) and PLAYBACK (ADS, CREDITS). The main ones:',
    'FOLDERS — add or remove which video folders feed this channel.',
    'SCHEDULE — set up a real broadcast-style schedule using PROGRAMMING BLOCKS, plus a CALENDAR for marking special dates.',
    'TITLES — rename individual shows, or automatically pull in a poster and description for each one.',
    'ADS — control how often commercial breaks happen on this channel.',
    'LOGO — show a small logo in the corner of the screen while this channel is playing, like a real TV network watermark.',
    'NOTE: If you don\'t set up any BLOCKS, the channel just plays through its whole library on a loop. Blocks are completely optional — only bother with them once you want an actual schedule, like "cartoons in the morning, movies at night."',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.2 Programming Blocks and the Calendar', body: [
    'A PROGRAMMING BLOCK is just a time slot with its own lineup — for example, "cartoons, weekdays, 4–6 PM." You can trigger a block two ways: by day of the week and time (repeats every week), or by a specific date range (great for holidays or a limited-time marathon).',
    'TIP: Turn on WEEKLY ROTATION on a block if you want its lineup to change from week to week instead of repeating the exact same shows every time.',
    'ON AIR (the first view in SCHEDULE) shows the week this channel will actually broadcast, with every show, ad break and sign-off after blocks, calendar days, presets and flows are all applied. Click any program to see which block or preset produced it, the breaks inside it, and a WATCH FROM HERE button.',
    'The CALENDAR (same tab as SCHEDULE) shows you a full month at once, color-coded by what\'s playing each day. It automatically flags anything that conflicts, and you can override a single day without messing up your regular schedule.',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.3 Previewing, Fixing Problems, and Editing Multiple Channels', body: [
    'PREVIEW (on every channel row) shows you what that channel would look like at any date and time, right in the setup screen — no need to actually tune to it. Use the quick-jump buttons to skip to the start of a show, the next ad break, an hour later, and so on.',
    'CAUTION: If you move, rename, or delete video files outside the app, the channel won\'t know where they went. Click "CHECK CHANNELS" to scan for anything missing, and "FIX PLAYBACK" to relink or remove those files.',
    'Need to change something on a bunch of channels at once — like favoriting several, or bulk-deleting? Ctrl+click channels in the list to pick several (Shift+click picks a range, Ctrl+A picks them all) and the editor turns into bulk actions for the selection. Esc goes back to one channel.',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.4 Playback Order, Channel Packages, and Broadcast Identity', body: [
    'The TITLES editor can sort naturally, reverse, restore folder order, create a repeatable seeded shuffle, or accept drag-and-drop ordering. Every automatic reorder previews the change and asks before it re-anchors the live channel.',
    'EXPORT CHANNEL creates a portable package containing that channel and the programming resources it directly uses. IMPORT CHANNEL merges one into your current box, remaps conflicting channel/resource numbers, and can relink missing local folders without replacing unrelated settings.',
    'IDENTITY lets one channel override the box theme, tune sound, static style, and accent colors. Leave any choice on INHERIT to keep following the box-wide theme.',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.5 Sub-Channels (7.1, 7.2)', body: [
    'Off by default. Most lineups are whole numbers all the way through, and there is no reason to put decimal points in front of everyone who does not want them.',
    'Switch on ALLOW SUB-CHANNELS at the bottom of the LINEUP tab and a channel number can then carry one decimal place, so you can run 7.1 and 7.2 alongside 7 the way a digital broadcast station carries sub-channels. Type the number into a channel\'s number box as 7.1.',
    'To tune one from the remote, type the main number, press the period key, then the sub-channel digit: 7 . 1. Everything else treats it as an ordinary channel — it sorts straight after 7, appears in the guide, takes blocks and breaks, and can be marked as a favorite.',
    'Only one decimal place is allowed. 7.1 is a channel, 7.12 is not.',
    'NOTE: with the option on, the up/down arrows in a number box step in tenths rather than whole numbers — that is the trade, and why it is off unless you ask for it. Switching it back off later does not break a sub-channel you already made: it stays in the lineup, in the guide and tunable. The option only controls whether you can type a new one.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.1 The Bumper & Ad Pool', body: [
    'This is the shared library of everything that plays between shows — commercials, station IDs, "up next" bumpers, trivia cards. Each item is tagged with which channels or blocks it belongs to, so ad breaks automatically pull from the right ones.',
    'STEP 1: Click "+ ADD FOLDER" to bring in a whole folder of commercials at once, or "+ ADD ENTRY" to add one by hand — you can even make a text-only station ID with no video file needed.',
    'The GLOBAL DEFAULT AD CADENCE sets how often breaks happen for any channel that hasn\'t set its own. Drag directly on the timeline, or type in exact break points.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.2 Ad Presets and the Show & Ad Flow Builder', body: [
    'CADENCE & PRESETS lets you save a break pattern and apply it to anything with a matching tag, instead of picking one channel at a time — handy if you want every "sitcom"-tagged show to break the same way.',
    'ADVANCED FLOWS is a visual builder for the rare channel that needs an exact order of segments, bumpers, ad pods, and IDs instead of the usual automatic cadence.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.3 On-Screen Extras', body: [
    'TEXT TICKER scrolls a message along the bottom of the screen, like a news channel.',
    'The Emergency Alert System and Breaking News Alerts have their own settings — look for SETTINGS next to each one in the PLUG-INS tab. EAS runs a periodic test alert (or press E to trigger one now); Breaking News interrupts with a styled bulletin, either automatically or on demand with the B key.',
    'NOTE: Press I any time to see details about what\'s currently playing. Press T to open the TIME MACHINE and jump the schedule backward or forward.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.4 Air Check', body: [
    'AIR CHECK is the broadcast resolver console. Pick a channel and time to see which source, show position, schedule block, ad policy, and output RerunTV resolves, plus why that result won. Previous/next boundary buttons make timing problems easier to isolate.',
    'The pool inspector shows which bumper and ad entries are eligible. FORCE ON TV previews one selected entry without rewriting the real schedule.',
  ] },
  { group: 'SECTION 5 — PICTURE & SOUND, GUIDE & THEME', title: '5.1 Picture Adjustments and the CRT Look', body: [
    'The CRT sliders — SCANLINES, VIGNETTE, GRAIN, FLICKER, CURVATURE, and BURN-IN — recreate the look of an old TV screen. Watch the preview update live as you drag each one.',
    'Press V any time to cycle through picture-color presets (P is POWER), or press A to cycle how the picture fits the screen: STANDARD (safe letterboxing, with a border for non-widescreen content if your theme has one), STRETCH (deliberately distorted, like squeezing a widescreen picture onto an old TV), and FILL (zooms in to fill the whole screen, cropping the edges).',
  ] },
  { group: 'SECTION 5 — PICTURE & SOUND, GUIDE & THEME', title: '5.2 Themes and the Channel Logo', body: [
    'GUIDE THEME (INTERFACE sub-tab, CLOCK & GUIDE panel) changes the whole look and feel of your box in one click — the channel-change animation, the idle screensaver, the sound effects, the on-screen guide, and the picture\'s color, all at once, not just a color swap.',
    'CHANNEL LOGO shows a small logo in a corner of the screen while you\'re watching. TIP: Leave it in the same spot long enough and it develops a faint "burn-in" ghost, just like a real old TV — that\'s intentional, not a bug.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.1 Volume Controls', body: [
    'The box has two separate volume levels — CONTENT (your shows) and COMMERCIAL/BUMPER — both set as a percentage you can adjust live with the +/- keys. Turn up the commercial volume if your ads always sound quiet, or down if they blast.',
    'NOTE: Any individual channel or block can set its own volume, which always overrides the two sliders above.',
    'VINTAGE CRT AUDIO FILTER & SFX softens the sound a bit and can add a faint hum and mechanical click sounds, for that old-TV-speaker feel.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.2 The Universal Remote (Phone Browser Page)', body: [
    'Enable PHONE REMOTE LAN ACCESS in the Universal Remote plugin, save, and restart. Its pairing link opens a full remote in any browser on the same WiFi; the short code is exchanged for a private session before controls or channel data are available.',
    'NOTE: This only works on your home WiFi, not over cellular data or from outside the house.',
    'TIP: If the remote page won\'t load, double check your phone is on the exact same WiFi network as the box (not a guest network) — that\'s the most common issue.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.3 Watching on Other Screens (The LAN Viewer)', body: [
    'WATCH ON OTHER DEVICES is off by default. Enable it, save, and restart, then open its pairing link on a laptop, tablet, or second TV. The viewer receives schedule data and opaque media ids, never host filesystem paths.',
    'NOTE: Each paired viewer is an independent read-only instance of the channel lineup and can tune locally without changing the main box.',
    'There\'s also an early Android TV app included in this project for a proper big-screen version of the same viewer, if you\'re comfortable building it yourself.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.4 The Party Page (Guest Bulletin & Jukebox)', body: [
    'When the PARTY channel (see SECTION 7) is enabled and RerunTV restarted, it shows a pairing QR code for the guest page. Guests need no account, but must use that host-issued link before posting or controlling party features.',
    'From that page, a guest can: post a photo or short video to the screen, send a text-to-speech announcement, play a sound effect, join a trivia round, submit a caption contest entry, vote for what plays next, check in on the guest wall, and — if the jukebox is turned on — add or vote to skip a song.',
    'TIP: The QR code shows right on screen whenever the PARTY channel is idle, so guests can just scan it — no need to read a URL out loud over the music.',
    'NOTE: Anything posted from the party page only lasts for that session — it\'s not saved permanently, and clears out the next time the box restarts.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.5 The Android Companion App and Connected Devices', body: [
    'There\'s also a separate Android app (different from the browser remote above) with quick-tap favorite channels you set up yourself, plus the same core remote controls — a faster option if you\'re often using just one hand.',
    'CONNECTED DEVICES shows every remote, viewer, and party guest currently active on your network. NOTE: A device drops off this list about 30 seconds after it stops checking in — think of it as "who\'s active right now," not a permanent list.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.6 Backing Up Your Settings', body: [
    'CAUTION: Your settings are backed up automatically on a rotating basis, and you can also click "snapshot now" any time for a manual backup. If something ever goes wrong, click "RESTORE" next to any backup to roll back to it — and if that wasn\'t what you wanted, Ctrl+Z undoes even that (see SECTION 8).',
    'TIP: Give an important backup a LABEL (like "before reorganizing cartoons") and PIN it so automatic rotation never removes it. PREVIEW shows channel, title-count, schedule, and box-setting differences before you restore.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.7 Opt-In Library Synchronization', body: [
    'LIBRARY SYNC is off by default. When enabled, it checks only the folders already linked to your channels, either after startup or at your chosen interval, and adds new titles automatically.',
    'Likely renames preserve your title, tags, and other metadata only when the match is unambiguous. Missing titles are reported but kept by default; automatic removal is a separate warned option you must explicitly enable.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.8 Staying On Schedule and Staying Awake', body: [
    'Two settings in SYSTEM › POWER keep a long unattended session honest.',
    'KEEP THE DISPLAY AWAKE holds off your monitor\'s screensaver and sleep timer while the set is powered on. Playing video normally keeps a screen up by itself, but a plugin channel, a NO SIGNAL card, or an open guide is a still picture as far as your computer is concerned. Powering the set off, including into AUTO STANDBY, releases it again immediately.',
    'KEEP PLAYBACK IN SYNC re-checks every 20 seconds that the picture is still at the point the schedule says it should be, and eases it back if it has fallen behind. This matters most after the computer sleeps and wakes, when the wall clock has moved on but the video has not. It also covers a file that stalls long enough to lose its place.',
    'NOTE: Turn the sync option off if your media lives somewhere slow enough that you would rather sit through an occasional stall than be moved past it. Everything else about the schedule is unaffected either way.',
  ] },
  { group: 'SECTION 7 — SPECIAL & VIRTUAL CHANNELS', title: '7.1 The Built-In Channels', body: [
    'Alongside your own channels, the box comes with a few special built-in ones — a program guide, a community bulletin board, a weather channel, a party channel, and more. Each one is its own plugin, and you can turn any of them on or off from the PLUG-INS tab, even the ones that come on by default.',
    'CH1 PREVIEW GUIDE is a scrolling program guide, like an old cable listings channel. CH2 PUBLIC ACCESS shows rotating community bulletin slides.',
    'CH0 AUX/VIDEO IN acts like a "line in" — it can even capture a window or app running on this same computer (like a karaoke app). CH3 WEATHER shows current conditions for your area.',
    'CH94 PARTY (see SECTION 6.4) is the interactive guest channel with photos, trivia, voting, and more.',
    'A few higher channel numbers (51, 88, and 94–99) are used for fun extras — a fake late-night channel, a game channel, shopping-channel parodies, a music visualizer, a pay-per-view screen, and a teletext channel. Each is its own plugin too, and any of them will automatically step aside if you already have a real channel using that number.',
  ] },
  { group: 'SECTION 7 — SPECIAL & VIRTUAL CHANNELS', title: '7.2 CH 100 — The Channel Mosaic', body: [
    'CH 100 is a preview mosaic: a grid showing what is airing on every one of your other channels right now, paging through the lineup a screenful at a time.',
    'Each tile is a still frame taken from that channel\'s current position, not a live picture. That is deliberate — a wall of moving video would cost far more than the whole rest of the box put together, and a real cable mosaic was a page of near-stills too.',
    'Tiles per page, how long a page stays up, and how often the frames refresh are all on the PLUG-INS tab under Channel Mosaic. If a big lineup makes the page stutter, lower the tile count first; it matters more than the refresh rate.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.1 Undo, Redo, the Command Palette, and Keyboard Shortcuts', body: [
    'Made a mistake? Press Ctrl+Z to undo your last change, and Ctrl+Shift+Z (or Ctrl+Y) to redo it. There are also UNDO/REDO buttons at the bottom of the screen — they gray out automatically when there\'s nothing to undo or redo.',
    'NOTE: Regular watching — changing the channel, adjusting volume, switching picture mode — doesn\'t count as a "setting" and won\'t show up in this undo history.',
    'Press Ctrl+K, or the SEARCH button, to search everything on this screen — settings, channels, upcoming programs, and actions like adding a channel or exporting your settings.',
    'TIP: You can also get around this whole screen with just the keyboard. Arrow keys (or J and K) move between sections and list rows, Enter selects a row and Enter again moves into its editor, Esc goes back to the list, Delete removes, and Ctrl+Enter starts watching.',
    'Press G and then a letter to jump to a section: C Channels, P Programming, L Library, S Picture & Sound, G Guide & Theme, H Household, Y System, U Plug-ins, ? Help.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.2 Searching the Guide and Reminders', body: [
    'Type at least two letters in the full guide search to find matching program titles, descriptions, or tags across the next seven days. Choose a result to jump the guide to it.',
    'SET REMINDER creates a local reminder. When the viewing clock reaches the program, a toast offers TUNE NOW or DISMISS; reminders follow the time-machine clock just like the schedule itself.',
    'Everything you have pending is listed under PROGRAM REMINDERS in GUIDE & THEME. Remove one you set by mistake, or clear the lot. Each reminder tidies itself up a few minutes after its program ends.',
    'Two options live with that list. TUNE AUTOMATICALLY changes the channel for you the moment a reminder comes due. The desktop-notification option covers the case this box is built for — still broadcasting behind whatever you are actually working in, where an on-screen toast is invisible. It only fires when the RerunTV window is not the one you are looking at.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.3 Air Checks — Marking a Moment', body: [
    'Press X while watching, or pick MARK AIR CHECK from the TV menu, and the box remembers exactly where you were: which channel, and what moment of its schedule was on screen.',
    'To go back, open the TV menu and choose one of the AIR CHECK entries listed there. The viewing clock shifts to that instant and the channel tunes, so the programme picks up exactly where it was.',
    'Nothing is recorded and nothing is copied. Because a channel plays the same thing at the same time no matter when you ask, a channel number and a timestamp already describe the moment completely. A mark costs a few dozen bytes.',
    'CAUTION: re-scanning a channel\'s folder or changing its playback order re-anchors that channel. Marks made before that will land on whatever airs at that time afterwards, which may be something else. The full list, with a REMOVE button on each, is under SYSTEM › AIR CHECK.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.4 Channel Scan and the Viewing Log', body: [
    'Press N to start SCAN. The box holds on each channel for about eight seconds and then moves on, showing the channel banner as it goes, exactly like the SCAN button on an old cable box. Pressing any key stops it on whatever is on screen.',
    'SYSTEM › DIAGNOSTICS keeps a VIEWING HISTORY: one row for each programme that actually reached the screen, with an estimated watch time and your most-watched channel and programme.',
    'That log lives in its own file, separate from your channel configuration. It is never included in a config backup or export, which also means CLEAR HISTORY cannot be undone by restoring a backup. Turn the whole thing off with the checkbox on that panel if you would rather nothing were logged.',
  ] },
  { group: 'SECTION 9 — THE PLUG-INS TAB', title: '9.1 Installing, Turning On/Off, and Removing Plugins', body: [
    'A lot of what this box can do — every special channel from SECTION 7, the remote control, weather and show-info lookups, even audio streaming features that need extra processing behind the scenes — comes from individual PLUGINS, listed on the PLUG-INS tab. Some come built in and turned on by default; you can add more yourself.',
    'STEP 1: To add one, either click "INSTALL FROM ZIP…" and pick the file, or drop its folder into the plugins folder (click "OPEN PLUGINS FOLDER" to find it) and click "RESCAN".',
    'Use the checkbox next to each plugin to turn it on or off, then click "SAVE CHANGES". Like most changes on this tab, turning a plugin on/off or adding a new one only takes effect after you restart the app.',
    'NOTE: To remove a plugin you installed yourself, delete its folder from the plugins folder ("OPEN PLUGINS FOLDER") and click RESCAN. Plugins that came built in are different — if a future app update removes one, it cleans up after itself automatically the next time you restart. You don\'t need to do anything.',
  ] },
  { group: 'SECTION 9 — THE PLUG-INS TAB', title: '9.2 What a Plugin Is Allowed to Do', body: [
    'Some plugins need extra permissions — to talk to the internet, open another program, or run their own little web page. Each plugin lists exactly which of these it needs and why, right in the PLUG-INS tab. The first time you use a plugin like this (or after an update adds a new permission), you\'ll see a prompt to approve it before it can run.',
    'CAUTION: Only install plugins from sources you trust. Approving a permission limits what a plugin is allowed to do — it doesn\'t guarantee the plugin only does good things with the access you give it.',
    'Many plugins also run in their own separate, walled-off space instead of sharing the app\'s own — similar to how each tab in a web browser runs separately. That way, if one plugin crashes or misbehaves, it can\'t take the rest of the box down with it, and it\'s genuinely limited by your computer to only what it asked permission for.',
  ] },
  { group: 'SECTION 9 — THE PLUG-INS TAB', title: '9.3 Developer Diagnostics and Support Bundles', body: [
    'PLUGIN DEVELOPER DIAGNOSTICS shows main and renderer load state, registered extension points, declared capability activity, published services, recent bounded logs, and whether a restart is still needed.',
    'EXPORT REDACTED SUPPORT BUNDLE writes that snapshot as JSON. Credential-shaped fields, authorization strings, URL credentials, and user-specific filesystem roots are removed first; your channel configuration and media inventory are not included.',
  ] },
];

function guideMatchesQuery(entry, q) {
  if (!q) return true;
  const haystack = `${entry.group} ${entry.title} ${entry.body.join(' ')}`.toLowerCase();
  return haystack.includes(q);
}

function renderHelpGuide() {
  if (!helpGuideListEl) return;
  const q = (helpGuideSearchEl && helpGuideSearchEl.value.trim().toLowerCase()) || '';
  helpGuideListEl.innerHTML = '';
  const matches = HELP_GUIDE.filter((entry) => guideMatchesQuery(entry, q));
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO GUIDE TOPICS MATCH THAT SEARCH.';
    helpGuideListEl.appendChild(empty);
    return;
  }
  let lastGroup = null;
  matches.forEach((entry, i) => {
    if (entry.group !== lastGroup) {
      lastGroup = entry.group;
      const groupHeader = document.createElement('div');
      groupHeader.className = 'help-guide-group-header';
      groupHeader.textContent = entry.group;
      helpGuideListEl.appendChild(groupHeader);
    }

    const card = document.createElement('div');
    // Expanded by default while a search is narrowing things down (so a
    // match's own text is immediately visible, not hidden behind another
    // click), and for the very first topic otherwise — everything else
    // starts collapsed so the guide reads as a scannable table of contents
    // rather than one long wall of text.
    const open = !!q || i === 0;
    card.className = 'help-guide-card' + (open ? ' open' : '');

    // A plain div with role="button" here, not a real <button> — a real
    // <button> given `display: flex` collapsed to ~8px regardless of its
    // content (its flex-computed height never made it into the parent
    // div's auto-height calculation, a Blink quirk specific to form
    // controls with an overridden display), so its content painted outside
    // the card's own overflow:hidden clip and never showed on screen.
    // Every other custom clickable header in this codebase (e.g.
    // .interstitial-card-summary) already uses a div for exactly this
    // reason — tabIndex + a keydown handler restore the button-like
    // keyboard activation a real <button> would give for free.
    const header = document.createElement('div');
    header.className = 'help-guide-card-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(open));
    header.tabIndex = 0;
    const chevron = document.createElement('span');
    chevron.className = 'help-guide-chevron';
    chevron.textContent = open ? '▾' : '▸';
    const title = document.createElement('span');
    title.textContent = entry.title;
    header.appendChild(chevron);
    header.appendChild(title);
    const toggle = () => {
      const nowOpen = card.classList.toggle('open');
      chevron.textContent = nowOpen ? '▾' : '▸';
      header.setAttribute('aria-expanded', String(nowOpen));
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'help-guide-card-body';
    entry.body.forEach((para) => {
      const p = document.createElement('p');
      // A paragraph opening with one of the manual's own callout words —
      // STEP 1:, NOTE:, TIP:, CAUTION: — gets that lead-in word bolded and
      // set off, the way a real manual's marginal callouts read, instead of
      // just running straight into the sentence like the rest of the prose.
      const calloutMatch = para.match(/^((?:STEP \d+|NOTE|TIP|CAUTION):)\s*/);
      if (calloutMatch) {
        const strong = document.createElement('strong');
        strong.className = 'manual-callout';
        strong.textContent = calloutMatch[1];
        p.appendChild(strong);
        p.appendChild(document.createTextNode(' ' + para.slice(calloutMatch[0].length)));
      } else {
        p.textContent = para;
      }
      body.appendChild(p);
    });
    card.appendChild(body);

    helpGuideListEl.appendChild(card);
  });
}

if (helpGuideSearchEl) helpGuideSearchEl.addEventListener('input', renderHelpGuide);

// Renders the same manual-voice callout ("STEP 1:", "NOTE:", "TIP:",
// "CAUTION:") that renderHelpGuide bolds on screen, so the printed page
// keeps that visual distinction too instead of reading as flat prose.
function paraToHtml(para) {
  const calloutMatch = para.match(/^((?:STEP \d+|NOTE|TIP|CAUTION):)\s*/);
  if (!calloutMatch) return `<p>${escapeHtml(para)}</p>`;
  const label = escapeHtml(calloutMatch[1]);
  const rest = escapeHtml(para.slice(calloutMatch[0].length));
  let kind = 'step';
  if (/CAUTION/.test(label)) kind = 'caution';
  else if (/TIP/.test(label)) kind = 'tip';
  else if (/NOTE/.test(label)) kind = 'note';
  return `<p class="callout callout-${kind}"><strong>${label}</strong> ${rest}</p>`;
}

// Builds a complete, self-contained (inline CSS, no external assets) HTML
// document styled like the perfect-bound owner's manual that used to ship
// taped inside a real cable box — reuses HELP_GUIDE verbatim rather than
// keeping a second hand-written copy of the same instructions, so the
// on-screen guide and the printable one can never drift out of sync with
// each other. Handed to window.api.openPrintableManual (main.js writes it
// to a temp file and opens it with the OS's default browser, since a
// sandboxed renderer can't write files or reliably open a real
// window.open() window itself) rather than rendered inside this app's own
// window, so Ctrl+P / the browser's own print dialog works normally.
function buildPrintableManualHtml() {
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  let sectionsHtml = '';
  let lastGroup = null;
  let tocHtml = '';
  HELP_GUIDE.forEach((entry) => {
    if (entry.group !== lastGroup) {
      lastGroup = entry.group;
      sectionsHtml += `<h2>${escapeHtml(entry.group)}</h2>`;
      tocHtml += `<li>${escapeHtml(entry.group)}</li>`;
    }
    sectionsHtml += `<div class="topic"><h3>${escapeHtml(entry.title)}</h3>${entry.body.map(paraToHtml).join('')}</div>`;
  });

  // Palette pulled from this app's own indigo/gold theme (tokens.css's
  // default digital-2000s vars) rather than literal antique sepia paper —
  // the manual VOICE stays retro (SECTION numbering, STEP/NOTE/TIP/CAUTION
  // callouts, "congratulations on your new..." framing), but the visual
  // design is a clean, modern print layout: a sans display face for
  // headings, generous whitespace, a two-column grid TOC, and rounded
  // color-coded callout cards instead of parchment-and-serif pastiche.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RerunTV — Owner's Manual</title>
<style>
  @page { margin: 0.75in; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    color: #1b1f3b;
    background: #f3f4fb;
    max-width: 7.6in;
    margin: 0 auto;
    padding: 48px 28px 90px;
    line-height: 1.55;
    font-size: 13px;
  }
  .cover {
    text-align: center;
    padding: 56px 32px;
    margin-bottom: 40px;
    border-radius: 20px;
    background: linear-gradient(160deg, #292f6b 0%, #4147a3 55%, #6a6fd6 100%);
    color: #fff;
  }
  .cover .badge {
    display: inline-block;
    font-size: 28px;
    width: 60px; height: 60px; line-height: 60px;
    border-radius: 50%;
    background: rgba(255,255,255,0.15);
    margin-bottom: 16px;
  }
  .cover .eyebrow { letter-spacing: 4px; font-size: 11px; opacity: 0.75; text-transform: uppercase; font-weight: 600; }
  .cover h1 { font-size: 38px; letter-spacing: 1px; margin: 10px 0 6px; font-weight: 800; }
  .cover .subtitle { font-size: 14px; opacity: 0.85; margin-bottom: 18px; }
  .cover .model-line {
    display: inline-block;
    font-size: 11px; letter-spacing: 0.5px; font-weight: 600;
    background: rgba(255,255,255,0.14);
    padding: 6px 14px;
    border-radius: 999px;
  }
  .toc {
    background: #fff;
    border: 1px solid #dcdff2;
    border-radius: 14px;
    padding: 22px 26px;
    margin-bottom: 40px;
    box-shadow: 0 1px 3px rgba(30,35,90,0.06);
  }
  .toc h2 { margin: 0 0 12px; font-size: 12px; letter-spacing: 2px; color: #4147a3; text-transform: uppercase; border: none; padding: 0; }
  .toc ul { columns: 2; gap: 28px; padding-left: 18px; font-size: 12.5px; color: #3a3f5c; }
  .toc li { margin-bottom: 4px; break-inside: avoid; }
  h2 {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #4147a3;
    border-bottom: 2px solid #dcdff2;
    padding-bottom: 8px;
    margin-top: 40px;
    page-break-after: avoid;
  }
  .topic {
    page-break-inside: avoid;
    margin: 16px 0;
    padding: 16px 18px;
    background: #fff;
    border: 1px solid #e4e6f4;
    border-radius: 12px;
  }
  .topic h3 { font-size: 14px; margin: 0 0 8px; color: #1b1f3b; font-weight: 700; }
  .topic p { margin: 8px 0; font-size: 12.5px; color: #3a3f5c; }
  .callout {
    border-radius: 8px;
    border-left: 4px solid #6a6fd6;
    padding: 8px 14px;
    background: #f3f4fb;
    margin: 10px 0 !important;
  }
  .callout strong { color: #4147a3; }
  .callout-caution { border-left-color: #d64550; background: #fdf2f3; }
  .callout-caution strong { color: #b3313b; }
  .callout-tip { border-left-color: #2fa36a; background: #f1f9f4; }
  .callout-tip strong { color: #23825a; }
  footer {
    margin-top: 56px;
    padding-top: 18px;
    border-top: 1px solid #dcdff2;
    font-size: 10.5px;
    color: #6b70a0;
    text-align: center;
  }
  @media print {
    body { background: #fff; }
    .cover { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .toc { break-after: page; }
    .topic { box-shadow: none; }
  }
</style>
</head>
<body>
  <div class="cover">
    <div class="badge">&#128250;</div>
    <div class="eyebrow">Owner's Manual</div>
    <h1>RerunTV</h1>
    <div class="subtitle">Channel Setup &amp; Programming System</div>
    <div class="model-line">MODEL: SYSTEM CONFIG REV 1.0 &nbsp;·&nbsp; PRINTED ${escapeHtml(today)}</div>
  </div>
  <div class="toc">
    <h2>Table of Contents</h2>
    <ul>${tocHtml}</ul>
  </div>
  ${sectionsHtml}
  <footer>Please retain this manual for future reference. Ctrl+P (or your browser's Print command) to print or save as PDF.</footer>
</body></html>`;
}

if (helpPrintManualBtn) {
  helpPrintManualBtn.addEventListener('click', async () => {
    try {
      await window.api.openPrintableManual(buildPrintableManualHtml());
    } catch (e) {
      alertDialog(`Couldn't open the printable manual: ${e.message}`, { variant: 'error' });
    }
  });
}

const CHANGELOG = [
  { date: '2026-10-12', items: [
    'RerunTV is now in beta: releases are numbered 0.2.0-beta.N, and the update check follows them.',
    'Three plugins have new names (your settings, approvals and theme carry over on first launch): Music Choice Channel is now Digital Music Channel (CH 910 asks you to approve it once), the guide plugin is now Guide Channel, and the 1994 guide theme is now Scrolling Guide 94.',
    'A generated demo library (scripts/make-demo-library.js) lets anyone try the app with slow, soft test video and static and flicker already off, and the README has a photosensitivity notice listing the CRT effect, flicker and channel static switches.',
  ] },
  { date: '2026-10-08', items: [
    'Time machine: a scrub you have parked now holds still, so pressing Enter or T lands exactly where the picture was however long you waited. Picking a date on the calendar plays straight away with a note of where it landed, and T after a scrub no longer reloads the video.',
  ] },
  { date: '2026-10-07', items: [
    'Time machine calendar: press D (or TIME MACHINE › PICK A DATE… in the TV menu, or CALENDAR… in a channel\'s PREVIEW) to pick any date and time on a month grid. Days with a date-range block carry a dot, and the footer shows what would be airing there.',
    'Date-range blocks can repeat every year on their own: RESTART FROM ITS FIRST FILE EACH YEAR begins the playlist again at the start of each year\'s range, and STARTS ON THANKSGIVING follows the 4th Thursday of November.',
  ] },
  { date: '2026-10-06', items: [
    'Bumper text can count calendar days: DAY {dayNumber:12/1} OF 25 shows the day of a run that started Dec 1, and {daysLeft:12/25} counts down to Dec 25. Both stay blank outside the range.',
    'A channel can take individual videos as well as whole folders: ADD FILES in the channel\'s actions (or its ⋯ menu, or CONTENT › Folders) picks several at once, and files you add this way are listed there with their own REMOVE buttons.',
    'Audit fixes: the REPEAT / NEW EPISODE badge and other start-of-show corner cards no longer linger after a channel change or sit on top of a break; the sponsor message card no longer sticks on screen; the O-key layout editor now returns to the picture instead of Setup; the footer no longer sticks on SAVING…; release notes in HELP read as plain text.',
    'Setup polish: sentence-case helper text on a channel\'s LOOK page, tidier Sound rows, the No signal card lines up under Dynamic overlays, and the header search clears when you change tabs.',
    'The flow editor shows older bump-in/bump-out steps in its Bumper type list, the flow list updates its target channels as you edit, and the guide explains an empty channel search when upcoming programs still match.',
  ] },
  { date: '2026-10-05', items: [
    'The live overlay layout editor (O key) was rebuilt: a preview of the real picture, smart snapping to edges and other elements, undo/redo, and H to tuck the controls away into a clean view.',
    'The logo and corner badges keep their margin on letterboxed or pillarboxed pictures and stay on the picture instead of on black bars.',
    'Two audit rounds hardened the LAN viewer, plugin approvals, media limits and the personal PIN, and finished setup-screen validation and accessibility.',
  ] },
  { date: '2026-10-04', items: [
    'Remove baked-in black bars: finds letterbox bars inside the video itself and frames just the picture. New default logo size that scales to 1080p or 4K, reset-this-panel buttons, and a settings-only export/import.',
    'Remappable keys for live TV (SYSTEM › Keys), per-channel number chip, and a Guide & Theme page split into Guide, Theme and On-screen.',
    'Music channel: cover art, a CD-rack / record-crate cabinet and search by artist, song, album or year.',
    'Combiner now converts only the clips that differ, reports progress, and uses the GPU when re-encoding.',
  ] },
  { date: '2026-09-29', items: [
    'Simple and Advanced settings views: Simple shows everyday controls and search still finds everything; Advanced shows the lot.',
  ] },
  { date: '2026-09-26', items: [
    'The Video Splicer is built in (LIBRARY › SPLICER): cut recordings into episodes, ads and bumpers, then combine clips.',
    'Updates now keep your library, profiles and assets when the installer replaces the app folder.',
    'Digital Music: pause and seek on demand, and search the library by song, artist, album or year.',
  ] },
  { date: '2026-09-23', items: [
    'TV on a second screen: per-screen placement and fullscreen, TV mode per screen, a sound output picker, screen edges, follow the TV\'s power state, and volume levelling per file.',
  ] },
  { date: '2026-09-13', items: [
    'TV mode for a couch and remote: a TV menu, banner hub, remote test and learn mode, on-screen keyboard, game controllers, Tizen/webOS remotes and HDMI-CEC.',
    'Time machine scrubber strip with a Go to menu, guide program actions, shorts grouped in the guide, breaks drawn as a band, and call letters.',
    'SCHEDULE › ON AIR is an editable programming timeline with edit previews and an explanation of every layer.',
    'A media library with catalogue, review and smart channels; households, DVR and watching together; theme eras; a LAN control panel; and full undo/redo for every setting.',
  ] },
  { date: '2026-08-24', items: [
    'Unified the app typography around the original cable-guide face, with a separate readable face reserved for longer descriptions; fixed the downloaded-update notice so its copy and actions fit as a responsive card.',
    'Added five explicit update policies, including the new recommended pre-launch update flow, plus a two-step first-time setup that explains local-media privacy, autosave/backups, optional integrations, and the update choice.',
    'Channel Health can now relink a moved local media folder: it preserves the old relative layout, verifies the proposed replacement, previews unresolved files, and updates shared channel/schedule references as one undoable edit.',
    'Completed the feature audit: channel packages, Air Check, safe playback-order editing, guide-wide program search/reminders, backup comparison and pinned snapshots, per-channel broadcast identity, opt-in smart library sync, and redacted plugin diagnostics/support export.',
  ] },
  { date: '2026-08-19', items: [
    'Boot-time power-on animation (DISPLAY > PICTURE toggle, on by default) — the app now plays the same powering-on CRT flash the manual power button uses when it first lands on the TV screen, instead of cutting straight to live video. Wood-Grain Console, Late-Night UHF, and Digital Satellite each got their own period-appropriate version (sluggish tube warm-up, tearing signal, crisp digital snap).',
    'Fixed a real bug where an approved plugin\'s REVIEW & APPROVE PERMISSIONS button could keep showing (and the approval could silently be lost) after a restart — the approval write and the settings screen\'s own autosave were racing each other.',
    'PLUGINS tab: an approved plugin now shows a plain "Permissions approved" note instead of the approve button, with REVOKE PERMISSIONS and FULLY UNINSTALL actions next to it — uninstall opens its own themed confirm dialog since it permanently deletes the plugin\'s files.',
  ] },
  { date: '2026-08-17', items: [
    'Full undo/redo (Ctrl+Z / Ctrl+Shift+Z) for setup-screen edits, with toolbar buttons and a command palette (Ctrl+K) for jumping to any tab/sub-tab or running common actions.',
    'Keyboard-nav overhaul of the setup screen: arrow-key navigation between tabs/sub-tabs and between channel rows/interstitial cards, with Enter/Delete acting on the focused row.',
    'Drag video files straight from Explorer onto a channel row or the interstitials pool to add them, instead of only via CHOOSE/ADD FOLDER.',
    'App-wide QOL batch: save-state indicator, breadcrumb trail, session-resume for setup tabs, labeled backups, a migration notice, cross-channel search + NOW/NEXT dashboard, copy-channel-settings, drag-to-reorder channels, a combined health dashboard, and bulk bumper/ad preview.',
    'This HELP tab.',
  ] },
  { date: '2026-08-16', items: [
    '4 new theme eras — Wood-Grain Console (1978), Late-Night UHF (1988), Network Prime Time (1996), Digital Satellite (2001) — each with its own channel-change transition, idle screensaver, synthesized sound (tune/power SFX + ambient texture), guide-grid look, and CRT picture bias, not just a recolor.',
    'Fixed a Shopping Network modal that could survive a channel change; fixed the PPV order button showing the wrong price; fixed a clipped bulk-title input.',
    'Virtual Channels settings panel is now collapsible with a filter instead of one long scroll of 17 cards.',
    'New "STRIP RELEASE TAGS" bulk button cleans up scene-release-style filenames in the Titles editor.',
    'Live CRT-effect preview swatch on the DISPLAY tab.',
  ] },
  { date: '2026-08-09', items: [
    'Bulk-tag by folder/selection with tag autocomplete, rotating config backups with restore, PREVIEW/test-tune (with block picker + quick-jump buttons), channel health check, SMPTE test pattern for unconfigured channels, episode countdown bumper placeholder.',
    'Interstitials/ad-preset UI redesigned into collapsible cards; settings sub-tabs added across DISPLAY/PROGRAMMING/AUDIO & SYSTEM; setup screen widened to use most of the window.',
  ] },
  { date: '2026-08-05', items: [
    'Channel EDIT view unified into one tabbed panel (Folders/Schedule/Titles/Ads/Logo); per-channel calendar with color-coded days, conflict detection, and inline day-override editing; blocks unified onto one trigger schema (day-of-week or date-range, with daily/weekly advent-calendar modes); tagged-interstitials pool replacing the old separate commercial/station-ID/trivia systems; per-channel/per-block volume and content-vs-ad volume layers.',
  ] },
];

// 'off' also disables CHECK NOW — "never" means no update network requests,
// including user-triggered ones. main-updater.js enforces the same rule.
function refreshUpdateModeUI() {
  const strategy = (S.config.updates && S.config.updates.strategy) || 'startup-auto';
  if (checkUpdatesBtn) checkUpdatesBtn.disabled = strategy === 'off';
}

function setUpdateStatus(text) {
  if (updateStatusLineEl) updateStatusLineEl.textContent = text;
}

// Bound once (renderHelpTab's helpTabRendered guard keeps this from
// double-firing) — config.updates itself can still change afterward via
// undo/import, same caveat as the rest of this once-rendered tab.
function initUpdateSettingsPanel() {
  if (updateModeSelect) {
    updateModeSelect.value = (S.config.updates && S.config.updates.strategy) || 'startup-auto';
    updateModeSelect.addEventListener('change', () => {
      dispatch({ type: 'settings.set', path: ['updates', 'strategy'], value: updateModeSelect.value });
      refreshUpdateModeUI();
      setUpdateStatus('');
    });
  }
  refreshUpdateModeUI();

  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener('click', async () => {
      checkUpdatesBtn.disabled = true;
      const originalText = checkUpdatesBtn.textContent;
      checkUpdatesBtn.textContent = 'CHECKING…';
      try {
        const result = await window.api.checkForUpdates();
        if (result.status === 'dev-mode') {
          setUpdateStatus('Update checks only run in a packaged build — this is a dev copy running from source.');
        } else if (result.status === 'disabled') {
          setUpdateStatus('Update checks are turned off (UPDATE POLICY: NEVER, above).');
        } else if (result.status === 'downloading') {
          setUpdateStatus(`Update v${result.version} found — downloading now. You'll be notified once it's ready.`);
        } else if (result.status === 'up-to-date') {
          setUpdateStatus(`You're on the latest version (v${result.version}), checked just now.`);
        } else {
          setUpdateStatus(`Update check failed: ${result.message}`);
        }
      } catch (e) {
        setUpdateStatus(`Update check failed: ${e.message}`);
      } finally {
        checkUpdatesBtn.disabled = (S.config.updates && S.config.updates.strategy) === 'off';
        checkUpdatesBtn.textContent = originalText;
      }
    });
  }
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatReleaseDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Live GitHub Releases feed — fetched once per HELP-tab visit (main
// process caches the actual HTTP call for an hour regardless, see
// main-updater.js's RELEASE_NOTES_TTL_MS), so re-opening HELP later in the
// same session still shows current data without hammering GitHub's API.
async function renderReleaseNotes() {
  if (!helpReleaseNotesListEl) return;
  helpReleaseNotesListEl.textContent = 'Loading…';
  let releases;
  try {
    releases = await window.api.getReleaseNotes();
  } catch (e) {
    releases = [];
  }
  if (!releases || releases.length === 0) {
    helpReleaseNotesListEl.textContent = 'Couldn\'t reach GitHub for release notes right now — try again later.';
    return;
  }
  helpReleaseNotesListEl.innerHTML = '';
  releases.forEach((r) => {
    const entry = document.createElement('div');
    entry.className = 'help-changelog-entry';
    const date = document.createElement('div');
    date.className = 'help-changelog-date';
    date.textContent = `${r.name}${r.prerelease ? ' (pre-release)' : ''} — ${formatReleaseDate(r.publishedAt)}`;
    entry.appendChild(date);
    const body = document.createElement('div');
    // Release bodies are markdown but this is a plain-text panel, not a
    // markdown renderer — bullet lines still read fine as plain text
    // (GitHub's own convention, "- " per line), and escaping the rest
    // avoids trusting arbitrary release-note HTML/script content.
    body.className = 'help-release-body';
    body.textContent = r.body ? readableReleaseNotes(r.body) : 'No description.';
    entry.appendChild(body);
    helpReleaseNotesListEl.appendChild(entry);
  });
}

function renderHelpTab() {
  if (helpTabRendered) return; // static content — no need to rebuild on every visit
  helpTabRendered = true;

  renderHelpGuide();

  if (helpVersionEl) {
    window.api.getAppVersion().then((v) => {
      if (v) helpVersionEl.textContent = `v${v}`;
    });
  }

  // Not exposed to the LAN viewer's browser-api-shim (nothing to install on
  // a read-only browser tab) — hide the whole panel rather than wire up
  // controls that would just error.
  if (!window.api.checkForUpdates) {
    if (updateSettingsPanelEl) updateSettingsPanelEl.classList.add('hidden');
  } else {
    initUpdateSettingsPanel();
  }

  if (!window.api.getReleaseNotes) {
    if (releaseNotesPanelEl) releaseNotesPanelEl.classList.add('hidden');
  } else {
    renderReleaseNotes();
  }

  if (helpShortcutsGridEl && hintBarEl) {
    helpShortcutsGridEl.innerHTML = '';
    Array.from(hintBarEl.children).filter((span) => span.dataset.hintMode !== 'tv').forEach((span) => {
      const item = document.createElement('div');
      item.className = 'help-shortcut-item';
      item.innerHTML = span.innerHTML;
      helpShortcutsGridEl.appendChild(item);
    });
  }

  if (helpChangelogListEl) {
    helpChangelogListEl.innerHTML = '';
    CHANGELOG.forEach((entry) => {
      const group = document.createElement('div');
      group.className = 'help-changelog-entry';
      const date = document.createElement('div');
      date.className = 'help-changelog-date';
      date.textContent = entry.date;
      group.appendChild(date);
      const list = document.createElement('ul');
      entry.items.forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
      });
      group.appendChild(list);
      helpChangelogListEl.appendChild(group);
    });
  }
}

// ---------- Global settings and action search ----------
// Results remain a compact list and navigate to their real tab/sub-tab.
// Earlier behavior temporarily exposed every matching panel from every tab
// in one stacked page, which removed navigation context and produced a very
// long, surprising layout for broad queries.
function searchableUnits() {
  return Array.from(document.querySelectorAll('.setup-tab-panel .panel'));
}

function searchableRows() {
  return Array.from(document.querySelectorAll('.setup-tab-panel .setting-row'));
}

function cleanSearchText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function searchEntryForPanel(panel) {
  const tabPanel = panel.closest('.setup-tab-panel[data-tab-panel]');
  const subPanel = panel.closest('.setup-subtab-panel[data-subtab-panel]');
  const tab = tabPanel && tabPanel.dataset.tabPanel;
  const subtab = subPanel && subPanel.dataset.subtabPanel;
  const topButton = document.querySelector(`.setup-tab-btn[data-tab="${tab}"]`);
  const subButton = subtab && tabPanel.querySelector(`.setup-subtab-btn[data-subtab="${subtab}"]`);
  const heading = panel.querySelector('.panel-toggle, .flow-timeline-title, h2, h3');
  const title = cleanSearchText(heading ? heading.textContent : 'Settings');
  const previewNode = panel.querySelector('.panel-status, p, .plugin-row-desc');
  return {
    tab, subtab, target: panel, title,
    path: [topButton && cleanSearchText(topButton.textContent), subButton && cleanSearchText(subButton.textContent), title].filter(Boolean).join(' › '),
    preview: cleanSearchText(previewNode && previewNode.textContent),
    haystack: cleanSearchText(panel.textContent).toLowerCase(),
  };
}

// A single setting (ui/field.js): its label, help and synonyms are what
// search matches; opening it focuses the control itself.
function searchEntryForRow(row) {
  const panelEntry = searchEntryForPanel(row.closest('.panel') || row);
  const { label, help, haystack } = settingRowSearchText(row);
  return {
    tab: panelEntry.tab,
    subtab: panelEntry.subtab,
    target: row,
    focus: settingRowControl(row),
    title: label,
    path: [panelEntry.path, label].filter(Boolean).join(' › '),
    preview: help,
    haystack,
    kind: 'setting',
  };
}

// One search (docs/design/03 §6), results grouped: settings, channels,
// actions, sections, then upcoming programs. Settings are single rows
// (ui/field.js); sections are whole cards for pages not on rows yet.
const SEARCH_GROUPS = [
  ['setting', 'SETTINGS', 8],
  ['channel', 'CHANNELS', 6],
  ['plugin', 'PLUG-INS', 5],
  ['action', 'ACTIONS', 6],
  ['panel', 'SECTIONS', 5],
  ['program', 'PROGRAMS', 5],
];

function matchesWords(haystack, words) {
  return words.every((word) => haystack.includes(word));
}

function actionEntries() {
  return searchActions().map((action) => ({
    kind: 'action',
    title: action.label,
    path: action.label,
    preview: action.hint,
    disabled: !!action.disabled,
    run: action.run,
    haystack: `${action.label} ${action.hint} ${action.keywords || ''}`.toLowerCase(),
  }));
}

function channelEntries(words) {
  return ((S.config && S.config.channels) || [])
    .filter((ch) => matchesWords(`ch ${ch.number} ${formatChannelNumber(ch.number)} ${ch.name || ''}`.toLowerCase(), words))
    .sort((a, b) => a.number - b.number)
    .map((ch) => ({
      kind: 'channel',
      title: ch.name || 'UNTITLED',
      path: `CH ${formatChannelNumber(ch.number)} — ${ch.name || 'UNTITLED'}`,
      preview: `${ch.files.length} video${ch.files.length === 1 ? '' : 's'}`,
      run: () => openChannelFromSearch(ch.number),
    }));
}

// Plugins by name and description, and the settings plugins registered
// search entries for (ctx.search.registerEntries). Both open the plugin in
// Plug-ins, so its settings need not be on screen to be found.
function pluginEntries(words) {
  return getPluginSearchEntries()
    .filter((entry) => matchesWords(entry.haystack, words))
    .map((entry) => ({
      kind: entry.kind,
      title: entry.label,
      path: entry.kind === 'plugin' ? `PLUG-INS › ${entry.pluginName}` : `PLUG-INS › ${entry.pluginName} › ${entry.label}`,
      preview: entry.preview,
      run: () => openPluginFromSearch(entry.pluginId, entry.section),
    }));
}

function programEntries(query) {
  if (query.length < 3) return [];
  let results = [];
  try {
    results = searchUpcomingPrograms((S.config && S.config.channels) || [], query, viewNow(), { limit: 5 });
  } catch (e) {
    return [];
  }
  return results.map(({ channel, entry, title }) => ({
    kind: 'program',
    title,
    path: title,
    preview: `CH ${formatChannelNumber(channel.number)} · ${new Date(entry.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
    run: () => openChannelFromSearch(channel.number),
  }));
}

function openChannelFromSearch(number) {
  S.setupSelectedChannel = number;
  S.setupFilterQuery = '';
  const filter = document.getElementById('channel-filter');
  if (filter) filter.value = '';
  document.querySelector('.setup-tab-btn[data-tab="channels"]')?.click();
  renderChannelList();
  document.querySelector(`#channel-list-pane .channel-list-item[data-channel-number="${number}"]`)?.focus();
}

function allSearchEntries(query) {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return actionEntries().filter((entry) => !entry.disabled);
  // A label that starts with the query beats one that contains it, which
  // beats a match only in help text or synonyms.
  const rowScore = (entry) => {
    const label = entry.title.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (words.every((word) => label.includes(word))) return 1;
    return 2;
  };
  const rows = searchableRows().map(searchEntryForRow)
    .filter((entry) => entry.tab && entry.title && matchesWords(entry.haystack, words))
    .map((entry, order) => ({ entry, order, score: rowScore(entry) }))
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map(({ entry }) => entry);
  const panels = searchableUnits().map(searchEntryForPanel)
    .filter((entry) => entry.tab && matchesWords(entry.haystack, words))
    .map((entry) => ({ ...entry, kind: 'panel' }));
  const actions = actionEntries().filter((entry) => matchesWords(entry.haystack, words));
  return [...rows, ...channelEntries(words), ...pluginEntries(words), ...actions, ...panels, ...programEntries(q)];
}

function navigateToSearchEntry(entry) {
  if (entry.run) {
    setupSearchEl.value = '';
    closeSettingsSearch();
    if (!entry.disabled) entry.run();
    return;
  }
  if (settingsView === 'simple' && !isSimpleSearchTarget(entry.target)) setSettingsView('advanced');
  const topButton = document.querySelector(`.setup-tab-btn[data-tab="${entry.tab}"]`);
  if (topButton) topButton.click();
  if (entry.subtab) {
    const panel = document.querySelector(`.setup-tab-panel[data-tab-panel="${entry.tab}"]`);
    panel?.querySelector(`.setup-subtab-btn[data-subtab="${entry.subtab}"]`)?.click();
  }
  setupSearchEl.value = '';
  closeSettingsSearch();
  requestAnimationFrame(() => {
    entry.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (entry.focus && !entry.focus.disabled) entry.focus.focus({ preventScroll: true });
    entry.target.classList.remove('search-target-flash');
    void entry.target.offsetWidth;
    entry.target.classList.add('search-target-flash');
    setTimeout(() => entry.target.classList.remove('search-target-flash'), 1200);
  });
}

function renderSettingsSearch() {
  const query = setupSearchEl.value;
  const showActionsOnly = !query.trim();
  setupSearchResultsEl.innerHTML = '';
  if (showActionsOnly && document.activeElement !== setupSearchEl) { closeSettingsSearch(); return; }
  const entries = allSearchEntries(query);
  const byKind = new Map();
  entries.forEach((entry) => {
    const kind = entry.kind || 'panel';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(entry);
  });
  let index = 0;
  SEARCH_GROUPS.forEach(([kind, heading, limit]) => {
    const group = (byKind.get(kind) || []).slice(0, showActionsOnly ? 12 : limit);
    if (!group.length) return;
    const headingEl = document.createElement('div');
    headingEl.className = 'setup-search-group';
    headingEl.setAttribute('role', 'presentation');
    headingEl.textContent = showActionsOnly ? 'ACTIONS — OR TYPE TO FIND A SETTING, CHANNEL OR PROGRAM' : heading;
    setupSearchResultsEl.appendChild(headingEl);
    group.forEach((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `setup-search-result-${index}`;
      button.className = `setup-search-result${index === 0 ? ' active' : ''}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === 0));
      if (entry.disabled) button.disabled = true;
      const pathEl = document.createElement('span');
      pathEl.className = 'setup-search-result-path';
      pathEl.textContent = entry.path;
      const preview = document.createElement('span');
      preview.className = 'setup-search-result-preview';
      preview.textContent = entry.preview || 'Open this setting';
      button.append(pathEl, preview);
      button.addEventListener('click', () => navigateToSearchEntry(entry));
      setupSearchResultsEl.appendChild(button);
      index += 1;
    });
  });
  setupSearchEmptyEl.classList.toggle('hidden', index > 0);
  setupSearchResultsEl.classList.toggle('hidden', index === 0);
  setupSearchEl.setAttribute('aria-expanded', String(index > 0));
  if (index) setupSearchEl.setAttribute('aria-activedescendant', 'setup-search-result-0');
  else setupSearchEl.removeAttribute('aria-activedescendant');
}

// Ctrl+K and the status bar's SEARCH button (setup-command-palette.js).
window.addEventListener('reruntv:open-setup-search', () => {
  setupSearchEl.focus();
  setupSearchEl.select();
  renderSettingsSearch();
});

// Applying/clearing an era (eras.js) writes the theme/CRT/display-mode/clock
// config paths this screen's own controls own, directly rather than through
// their input handlers — resync those controls' displayed values.
window.addEventListener('reruntv:era-applied', () => renderSettingsPanels());

setupSearchEl.addEventListener('input', renderSettingsSearch);
setupSearchEl.addEventListener('keydown', (event) => {
  const results = Array.from(setupSearchResultsEl.querySelectorAll('.setup-search-result'));
  if (!results.length) return;
  let index = results.findIndex((result) => result.classList.contains('active'));
  if (event.key === 'ArrowDown') index = (index + 1) % results.length;
  else if (event.key === 'ArrowUp') index = (index - 1 + results.length) % results.length;
  else if (event.key === 'Enter') {
    event.preventDefault();
    results[Math.max(0, index)].click();
    return;
  } else if (event.key === 'Escape') {
    closeSettingsSearch();
    return;
  } else return;
  event.preventDefault();
  results.forEach((result, resultIndex) => {
    const active = resultIndex === index;
    result.classList.toggle('active', active);
    result.setAttribute('aria-selected', String(active));
  });
  setupSearchEl.setAttribute('aria-activedescendant', results[index].id);
  results[index].scrollIntoView({ block: 'nearest' });
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.setup-nav')) closeSettingsSearch();
});

// The header shows a separating shadow once the page under it has scrolled.
const setupNavEl = setupScreen.querySelector('.setup-nav');
function syncSetupNavStickySurface() {
  if (!setupNavEl || !setupContentEl) return;
  setupNavEl.classList.toggle('is-stuck', setupContentEl.scrollTop > 0);
}

function activeGuideGenreThemeId() {
  return themeSelect.value || S.config.theme || 'digital-2000s';
}

function guideGenreKeys(themeConfig) {
  const keys = new Set([...Object.keys(DEFAULT_GUIDE_GENRES), ...Object.keys(themeConfig.colors)]);
  (S.config.channels || []).forEach((channel) => (channel.files || []).forEach((file) => {
    (file.facets?.genre || []).forEach((genre) => {
      const key = normalizeGuideGenre(genre);
      if (key) keys.add(key);
    });
  }));
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function updateGuideGenreTheme(mutator) {
  const themeId = activeGuideGenreThemeId();
  const current = guideGenreThemeConfig(S.config, themeId);
  const next = { enabled: current.enabled, colors: { ...current.colors } };
  mutator(next);
  dispatch({ type: 'settings.set', path: ['display', 'guideGenreStyles', themeId], value: next });
  renderGuideGenreSettings();
}

function renderGuideGenreSettings() {
  const enabled = document.getElementById('guide-genre-colors-enabled');
  const label = document.getElementById('guide-genre-theme-label');
  const list = document.getElementById('guide-genre-color-list');
  if (!enabled || !label || !list) return;
  const themeId = activeGuideGenreThemeId();
  const config = guideGenreThemeConfig(S.config, themeId);
  enabled.checked = config.enabled;
  label.textContent = `EDITING PALETTE FOR ${themeSelect.selectedOptions[0]?.textContent || themeId}`;
  list.innerHTML = '';
  guideGenreKeys(config).forEach((genre) => {
    const row = document.createElement('div');
    row.className = 'guide-genre-color-row';
    const name = document.createElement('strong');
    name.textContent = genre.toUpperCase();
    const color = document.createElement('input');
    color.type = 'color';
    color.value = config.colors[genre] || defaultGuideGenreColor(genre);
    color.setAttribute('aria-label', `${genre} guide color`);
    color.addEventListener('change', () => updateGuideGenreTheme((entry) => { entry.colors[genre] = color.value; }));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-small';
    reset.textContent = 'DEFAULT';
    reset.disabled = !config.colors[genre];
    reset.addEventListener('click', () => updateGuideGenreTheme((entry) => { delete entry.colors[genre]; }));
    row.append(name, color, reset);
    list.appendChild(row);
  });
}

function closeThemeBrowser({ restoreFocus = false } = {}) {
  if (!themeBrowserEl) return;
  themeBrowserEl.classList.add('hidden');
  document.body.classList.remove('theme-browser-open');
  themeBrowserToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) themeBrowserToggle.focus();
}

function renderThemeBrowser() {
  if (!themeBrowserGroups) return;
  const entries = themePackEntries();
  const query = themeBrowserSearch ? themeBrowserSearch.value.trim().toLowerCase() : '';
  const currentId = themeSelect.value || S.config.theme || 'digital-2000s';
  const current = entries.find((entry) => entry.id === currentId);
  themeBrowserCurrentLabel.textContent = current ? current.label : `${currentId} (PLUGIN NOT INSTALLED)`;
  themeBrowserGroups.innerHTML = '';

  const byGroup = new Map();
  entries.forEach((entry) => {
    if (query && !`${entry.label} ${entry.group}`.toLowerCase().includes(query)) return;
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push(entry);
  });
  const groups = Array.from(byGroup.keys()).sort((a, b) => {
    const ai = THEME_GROUP_ORDER.indexOf(a);
    const bi = THEME_GROUP_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  groups.forEach((groupName) => {
    const section = document.createElement('section');
    section.className = 'theme-browser-group';
    const heading = document.createElement('div');
    heading.className = 'theme-browser-group-title';
    heading.textContent = groupName;
    section.appendChild(heading);
    const grid = document.createElement('div');
    grid.className = 'theme-browser-grid';
    byGroup.get(groupName).sort((a, b) => a.label.localeCompare(b.label)).forEach((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `theme-browser-option${entry.id === currentId ? ' active' : ''}`;
      button.dataset.themeId = entry.id;
      button.setAttribute('aria-pressed', String(entry.id === currentId));
      const swatch = document.createElement('span');
      swatch.className = 'theme-browser-swatch';
      swatch.dataset.previewTheme = entry.id;
      const preview = entry.preview || {};
      swatch.style.setProperty('--theme-preview-bg', preview.background || '#101522');
      swatch.style.setProperty('--theme-preview-accent', preview.accent || '#d7dbe7');
      swatch.style.setProperty('--theme-preview-secondary', preview.secondary || '#68728a');
      const label = document.createElement('span');
      label.textContent = entry.label;
      button.append(swatch, label);
      // docs/design/04 §4.4: a theme that fails the contrast check still loads,
      // and says so here. The tooltip lists the failing pairs.
      const check = themeCheckResult(entry.id);
      const badge = themeCheckBadge(check);
      if (badge) {
        button.appendChild(Badge({
          text: badge === 'low' ? 'Low contrast' : 'Low contrast (exempt)',
          tone: 'warning',
          className: 'theme-browser-contrast',
          title: check.failures.map((f) => `${f.pair}: ${f.ratio}:1, needs ${f.min}:1${f.exempt ? ` (exempt: ${f.exempt})` : ''}`).join('\n'),
        }));
      }
      button.addEventListener('click', () => {
        themeSelect.value = entry.id;
        themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        closeThemeBrowser({ restoreFocus: true });
      });
      grid.appendChild(button);
    });
    section.appendChild(grid);
    themeBrowserGroups.appendChild(section);
  });
  themeBrowserEmpty.classList.toggle('hidden', groups.length > 0);
}
setupContentEl?.addEventListener('scroll', syncSetupNavStickySurface, { passive: true });
window.addEventListener('resize', syncSetupNavStickySurface);
syncSetupNavStickySurface();

// The URL list is a live property of whatever network adapters the machine
// currently has (see getLanUrls, main.js) — not part of S.config, so this
// is a fresh main-process query on demand, same pattern a plugin with its
// own LAN-facing URL panel would use, one port over — see
// startViewerServer/getViewerUrls (main.js). Any browser on the LAN that
// opens one of these URLs gets a fully independent, read-only instance of
// this same app (browser-api-shim.js), tuning its own channel and seeing
// the exact same breaks/bumpers/CRT effects the host does.
export function renderViewerUrlStatus() {
  viewerEnabledEl.checked = !!(S.config.network && S.config.network.viewerEnabled);
  if (!viewerEnabledEl.checked) {
    viewerUrlStatusEl.textContent = 'Off by default. Enable this, save, and restart RerunTV to accept paired viewers.';
    return;
  }
  window.api.getViewerUrl().then((candidates) => {
    if (!candidates || !candidates.length) {
      viewerUrlStatusEl.textContent = 'Viewer access is enabled but not active yet. Restart RerunTV, or connect this computer to WiFi/ethernet.';
      return;
    }
    const list = candidates.map((c) => `${c.url} (${c.name})`).join(', ');
    viewerUrlStatusEl.textContent = `Open a pairing link on the other device. The code is exchanged for a private read-only session: ${list}`;
  });
}

viewerEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['network', 'viewerEnabled'], value: viewerEnabledEl.checked });
  viewerUrlStatusEl.textContent = `${viewerEnabledEl.checked ? 'Viewer access will start' : 'Viewer access will stop'} after RerunTV restarts.`;
  renderViewerControlUrlStatus();
});

// docs/design/06 §4's control pairing code, previously visible only on the
// loopback /server page (host-only IPC — see api-contract.js). Uses the same
// "share with devices" toggle as the read-only viewer above, since /control
// is served by the same LAN process.
export function renderViewerControlUrlStatus() {
  if (!controlUrlStatusEl || typeof window.api.getViewerControlUrl !== 'function') return;
  if (!viewerEnabledEl.checked) {
    controlUrlStatusEl.textContent = 'Off by default. Enable "Share with devices on this network" above, save, and restart RerunTV.';
    return;
  }
  window.api.getViewerControlUrl().then((candidates) => {
    if (!candidates || !candidates.length) {
      controlUrlStatusEl.textContent = 'Not active yet. Restart RerunTV, or connect this computer to WiFi/ethernet.';
      return;
    }
    const list = candidates.map((c) => `${c.url} (${c.name})`).join(', ');
    controlUrlStatusEl.textContent = `Open one of these on a laptop, tablet or phone for the same setup screen — writable there, unlike the read-only viewer link above: ${list}`;
  });
}

// "Open RerunTV when I sign in" (startup-server.js's window entry). Only one
// startup entry is on at a time, so changing either re-reads both.
const startupWindowEnabledEl = document.getElementById('startup-window-enabled');
const startupWindowStatusEl = document.getElementById('startup-window-status');

async function renderStartupWindowStatus(statusOverride = null) {
  if (!startupWindowEnabledEl || !startupWindowStatusEl || typeof window.api.getStartupWindowStatus !== 'function') return;
  let status = statusOverride;
  if (!status) {
    try {
      status = await window.api.getStartupWindowStatus();
    } catch (error) {
      status = { supported: false, enabled: false, error: error.message };
    }
  }
  startupWindowEnabledEl.checked = !!status.enabled;
  startupWindowEnabledEl.disabled = !status.supported;
  startupWindowEnabledEl.closest('.setting-row')?.classList.toggle('is-disabled', !status.supported);
  if (status.reason === 'windows-only') {
    startupWindowStatusEl.textContent = 'Opening at sign-in is currently available on Windows PCs.';
  } else if (status.reason === 'installed-build-only') {
    startupWindowStatusEl.textContent = 'Available in the installed RerunTV build. Development mode will not change Windows startup.';
  } else if (status.error) {
    startupWindowStatusEl.textContent = `Windows could not change the startup setting: ${status.error}`;
  } else if (status.enabled && status.launchAllowed === false) {
    startupWindowStatusEl.textContent = 'Registered, but disabled in Windows Startup Apps. Re-enable RerunTV there to open it at sign-in.';
  } else if (status.enabled) {
    startupWindowStatusEl.textContent = 'At sign-in, RerunTV opens on its screen (see Picture & Sound › Show on screen) and starts the network server too.';
  } else {
    startupWindowStatusEl.textContent = 'Open the box on its screen when you sign in to Windows, like a cable box that’s already on. Replaces the background server below.';
  }
}

startupWindowEnabledEl?.addEventListener('change', async () => {
  if (typeof window.api.setStartupWindowEnabled !== 'function') return;
  startupWindowEnabledEl.disabled = true;
  startupWindowStatusEl.textContent = startupWindowEnabledEl.checked
    ? 'Adding RerunTV to Windows startup…'
    : 'Removing RerunTV from Windows startup…';
  try {
    await renderStartupWindowStatus(await window.api.setStartupWindowEnabled(startupWindowEnabledEl.checked));
  } catch (error) {
    await renderStartupWindowStatus({ supported: true, enabled: false, error: error.message });
  }
  renderStartupServerStatus();
});

export async function renderStartupServerStatus(statusOverride = null) {
  if (!startupServerEnabledEl || !startupServerStatusEl) return;
  renderStartupWindowStatus();
  const panel = startupServerEnabledEl.closest('.panel');
  if (typeof window.api.getStartupServerStatus !== 'function') {
    // The LAN viewer uses the same renderer files but intentionally receives
    // no host-only OS controls through browser-api-shim.js.
    panel?.classList.add('hidden');
    return;
  }
  panel?.classList.remove('hidden');
  let status = statusOverride;
  if (!status) {
    try {
      status = await window.api.getStartupServerStatus();
    } catch (error) {
      status = { supported: false, enabled: false, error: error.message };
    }
  }
  startupServerEnabledEl.checked = !!status.enabled;
  startupServerEnabledEl.disabled = !status.supported;
  startupServerEnabledEl.closest('.setting-row')?.classList.toggle('is-disabled', !status.supported);

  if (status.reason === 'windows-only') {
    startupServerStatusEl.textContent = 'Automatic server startup is currently available on Windows PCs.';
  } else if (status.reason === 'installed-build-only') {
    startupServerStatusEl.textContent = 'Available in the installed RerunTV build. Development mode will not change Windows startup.';
  } else if (status.error) {
    startupServerStatusEl.textContent = `Windows could not change the startup setting: ${status.error}`;
  } else if (status.enabled && status.launchAllowed === false) {
    startupServerStatusEl.textContent = 'Registered, but disabled in Windows Startup Apps. Re-enable RerunTV Server there to run it at sign-in.';
  } else if (status.enabled) {
    startupServerStatusEl.textContent = 'At sign-in, RerunTV checks for updates in its updater box, then opens the local server control site.';
  } else {
    startupServerStatusEl.textContent = 'Start the paired viewer server and open its local control site automatically when you sign in to Windows.';
  }
}

startupServerEnabledEl?.addEventListener('change', async () => {
  if (typeof window.api.setStartupServerEnabled !== 'function') return;
  startupServerEnabledEl.disabled = true;
  startupServerStatusEl.textContent = startupServerEnabledEl.checked
    ? 'Adding RerunTV Server to Windows startup…'
    : 'Removing RerunTV Server from Windows startup…';
  try {
    const status = await window.api.setStartupServerEnabled(startupServerEnabledEl.checked);
    await renderStartupServerStatus(status);
    renderStartupWindowStatus();
  } catch (error) {
    await renderStartupServerStatus({ supported: true, enabled: false, error: error.message });
  }
});

// Host visibility into who's actually on the LAN right now — see
// trackConnection/getConnectedDevices (main.js). Polled on an interval
// rather than one-shot like renderViewerUrlStatus above, since who's
// connected genuinely changes while the settings screen
// sits open; the interval itself is cheap (one small IPC call every 5s) and
// self-gates on the settings screen actually being visible, so it's a no-op
// once you leave setup instead of needing a matching stop call wired into
// every place setup can close.
const CONNECTED_DEVICES_POLL_MS = 5000;
const SERVER_LABELS = { remote: 'PHONE REMOTE', viewer: 'LAN VIEWER', party: 'PARTY GUEST' };
let connectedDevicesPollStarted = false;

export function renderConnectedDevices() {
  window.api.getConnectedDevices().then((devices) => {
    connectedDevicesListEl.innerHTML = '';
    if (!devices || !devices.length) {
      const empty = document.createElement('div');
      empty.className = 'titles-empty';
      empty.textContent = 'NO DEVICES CONNECTED RIGHT NOW.';
      connectedDevicesListEl.appendChild(empty);
      return;
    }
    devices.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'block-row';
      const label = document.createElement('span');
      label.className = 'block-count';
      // Scope (docs/design/06 §7 presence) only means something for the LAN
      // viewer server — a view session can only watch, a control session can
      // also write, and everything else (party, phone remote) has no scopes
      // to report at all.
      const scopeSuffix = d.server === 'viewer' && d.scope ? ` (${d.scope === 'control' ? 'EDITING' : 'WATCHING'})` : '';
      label.textContent = `${SERVER_LABELS[d.server] || d.server.toUpperCase()} — ${d.ip}${scopeSuffix}`;
      row.appendChild(label);
      connectedDevicesListEl.appendChild(row);
    });
  });
  if (!connectedDevicesPollStarted) {
    connectedDevicesPollStarted = true;
    setInterval(() => {
      if (setupScreen.classList.contains('hidden')) return;
      renderConnectedDevices();
    }, CONNECTED_DEVICES_POLL_MS);
  }
}


// ---------- Program reminders (GUIDE & THEME) ----------
// Reminders are created from the guide's program search (guide.js's
// addProgramReminder) and used to be invisible from the moment they were set
// until the moment they fired — no list, no way to cancel one added by
// mistake, no way to check whether one was still pending. They live in
// S.config.reminders and clear themselves a few minutes after their own
// program ends (checkProgramReminders, guide.js), so this is a view of
// pending ones only and needs no expiry logic of its own.
export function renderRemindersPanel() {
  if (reminderAutoTuneEl) reminderAutoTuneEl.checked = !!S.config.reminderAutoTune;
  if (reminderNotifyEl) reminderNotifyEl.checked = S.config.reminderNotify !== false;
  if (!remindersListEl) return;
  const reminders = (currentProfile()?.state.reminders || S.config.reminders || []).slice().sort((a, b) => a.start - b.start);
  if (remindersClearAllBtn) remindersClearAllBtn.disabled = !reminders.length;
  remindersListEl.innerHTML = '';
  if (!reminders.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO REMINDERS SET. OPEN THE GUIDE (G), PRESS /, AND SEARCH FOR A PROGRAM.';
    remindersListEl.appendChild(empty);
    return;
  }
  reminders.forEach((reminder) => {
    const row = document.createElement('div');
    row.className = 'block-row';
    const label = document.createElement('span');
    label.className = 'block-count';
    // The channel name is stored on the reminder itself, but a channel
    // renamed since then should read as its current name — fall back to the
    // stored copy only for a channel that no longer exists at all, so a
    // reminder for a deleted channel still says what it was for.
    const channel = getChannel(reminder.channelNumber);
    const name = (channel && channel.name) || reminder.channelName || 'UNNAMED';
    label.textContent = `${reminder.title} — CH ${reminder.channelNumber} · ${name} · ${new Date(reminder.start).toLocaleString()}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'REMOVE';
    remove.addEventListener('click', () => {
      const next = (currentProfile()?.state.reminders || S.config.reminders || []).filter((entry) => entry.id !== reminder.id);
      if (currentProfile()) personalCommand({ type: 'state.set', key: 'reminders', value: next }).then(renderRemindersPanel);
      else dispatch({ type: 'settings.set', path: ['reminders'], value: next }, { label: 'Remove reminder' });
      renderRemindersPanel();
    });
    row.append(label, remove);
    remindersListEl.appendChild(row);
  });
}

reminderAutoTuneEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['reminderAutoTune'], value: reminderAutoTuneEl.checked });
});

reminderNotifyEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['reminderNotify'], value: reminderNotifyEl.checked });
});

remindersClearAllBtn?.addEventListener('click', async () => {
  const count = (currentProfile()?.state.reminders || S.config.reminders || []).length;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'CLEAR REMINDERS',
    message: `Remove all ${count} pending program reminder${count === 1 ? '' : 's'}?`,
    confirmText: 'CLEAR ALL',
  });
  if (!ok) return;
  if (currentProfile()) await personalCommand({ type: 'state.set', key: 'reminders', value: [] });
  else dispatch({ type: 'settings.set', path: ['reminders'], value: [] }, { label: 'Clear reminders' });
  renderRemindersPanel();
});

// ---------- Viewing history (SYSTEM > DIAGNOSTICS) ----------
// Reads from main-history.js's own file rather than from S.config, so this
// panel is the only thing in the setup screen that does its own async fetch
// on render. Kept to the most recent slice: the log holds thousands of rows
// and this is a "what have I been watching" readout, not an audit trail.
const HISTORY_PANEL_ROWS = 40;

export function renderViewingHistoryPanel() {
  if (viewingHistoryEnabledEl) {
    viewingHistoryEnabledEl.checked = !S.config.viewingHistory || S.config.viewingHistory.enabled !== false;
  }
  if (!historyListEl) return;
  listViewingHistory(500).then((entries) => {
    const summary = summarizeHistory(entries);
    if (historyTotalTimeEl) historyTotalTimeEl.textContent = summary.rowCount ? formatWatchTime(summary.totalMs) : '—';
    if (historyRowCountEl) historyRowCountEl.textContent = summary.rowCount ? String(summary.rowCount) : '—';
    if (historyTopChannelEl) {
      const top = summary.channels[0];
      historyTopChannelEl.textContent = top ? `CH ${top.number}${top.name ? ` ${top.name}` : ''}` : '—';
    }
    if (historyTopTitleEl) {
      const top = summary.titles[0];
      historyTopTitleEl.textContent = top && top.title ? top.title : '—';
    }
    historyListEl.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'titles-empty';
      empty.textContent = 'NOTHING LOGGED YET. WATCH SOMETHING AND COME BACK.';
      historyListEl.appendChild(empty);
      return;
    }
    entries.slice(0, HISTORY_PANEL_ROWS).forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'block-row';
      const label = document.createElement('span');
      label.className = 'block-count';
      const when = new Date(entry.at).toLocaleString();
      const name = entry.channelName ? ` ${entry.channelName}` : '';
      label.textContent = `${when} · CH ${entry.channelNumber}${name} · ${entry.title || 'UNTITLED'}`;
      row.appendChild(label);
      historyListEl.appendChild(row);
    });
  }).catch(() => {});
}

viewingHistoryEnabledEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['viewingHistory', 'enabled'], value: viewingHistoryEnabledEl.checked });
});

historyRefreshBtn?.addEventListener('click', () => renderViewingHistoryPanel());

historyClearBtn?.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'CLEAR VIEWING HISTORY',
    message: 'Delete the whole log of what this box has played? This cannot be undone — the log is not part of your config, so config backups do not contain it.',
    confirmText: 'CLEAR HISTORY',
  });
  if (!ok) return;
  await clearViewingHistory();
  renderViewingHistoryPanel();
});

// ---------- Air checks (SYSTEM > AIR CHECK) ----------
// The TV menu offers the most recent few as one-press recalls; this is the
// full list, and the only place a mark can be deleted. Same shape as the
// reminders list above on purpose — both are "things you marked while
// watching that you may want to undo later".
export function renderAirChecksPanel() {
  if (!airChecksListEl) return;
  const marks = airChecks();
  if (airChecksClearAllBtn) airChecksClearAllBtn.disabled = !marks.length;
  airChecksListEl.innerHTML = '';
  if (!marks.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO AIR CHECKS MARKED. PRESS X WHILE WATCHING TO MARK THE MOMENT.';
    airChecksListEl.appendChild(empty);
    return;
  }
  marks.forEach((mark) => {
    const row = document.createElement('div');
    row.className = 'block-row';
    const label = document.createElement('span');
    label.className = 'block-count';
    const channel = getChannel(mark.channelNumber);
    const name = (channel && channel.name) || mark.channelName || 'UNNAMED';
    label.textContent = `${airCheckLabel(mark)} · ${name} · ${new Date(mark.at).toLocaleDateString()}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'REMOVE';
    remove.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'REMOVE AIR CHECK', message: `Remove "${airCheckLabel(mark)}" from your marked moments?`, confirmText: 'REMOVE', danger: true }))) return;
      removeAirCheck(mark.id);
      renderAirChecksPanel();
    });
    row.append(label, remove);
    airChecksListEl.appendChild(row);
  });
}

airChecksClearAllBtn?.addEventListener('click', async () => {
  const count = airChecks().length;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'CLEAR AIR CHECKS',
    message: `Remove all ${count} marked moment${count === 1 ? '' : 's'}?`,
    confirmText: 'CLEAR ALL',
  });
  if (!ok) return;
  clearAirChecks();
  renderAirChecksPanel();
});

keepDisplayAwakeEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['keepDisplayAwake', 'enabled'], value: keepDisplayAwakeEl.checked });
  // Applied immediately rather than at the next power transition — the
  // setting is only meaningful as a live claim on the OS, so leaving the old
  // one held until the next standby would read as the toggle not working.
  applyDisplayWakeLock();
});

playbackResyncEnabledEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['playbackResync', 'enabled'], value: playbackResyncEnabledEl.checked });
});

// ---------- Config backups (AUDIO & SYSTEM tab) ----------
// See main.js's backupCurrentConfig/listBackups/restoreBackup — rotating,
// rate-limited snapshots of channels.json taken automatically at session
// start and at most every 15 minutes during active editing.
// Set right before a renderBackupsList() triggered by an actual new
// snapshot, so only that row plays a reveal — not every row on a plain
// refresh/tab-switch re-list (listBackups sorts newest-first, so a new
// snapshot is always index 0).
export function renderBackupsList() {
  return renderBackupsListFeature();
}
initBackups((restored) => {
  S.config = applyConfigDefaults(restored);
  pushUndoSnapshot();
  renderChannelList();
  renderCommercialsPanel();
  renderStandbyPanel();
  renderSettingsPanels();
});

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
// Usage mode is per device (usage-mode.js), not config: a laptop and the
// living-room box sharing one channels.json can be in different modes.
const usageModeSelectEl = document.getElementById('usage-mode-select');
const usageModeStatusEl = document.getElementById('usage-mode-status');
function renderUsageModeSetting() {
  if (!usageModeSelectEl) return;
  usageModeSelectEl.value = getUsageModePreference();
  if (usageModeStatusEl) usageModeStatusEl.textContent = `NOW: ${usageMode().toUpperCase()} (${usageModeSource().toUpperCase()})`;
}
usageModeSelectEl?.addEventListener('change', () => {
  setUsageModePreference(usageModeSelectEl.value);
  renderUsageModeSetting();
});
onUsageModeChange(() => renderUsageModeSetting());
// Preview TV mode (docs/design/01 §8): session only, straight to live TV.
document.getElementById('tv-preview-btn')?.addEventListener('click', () => {
  setTvPreview(true);
  window.dispatchEvent(new CustomEvent('reruntv:watch-tv'));
});
renderUsageModeSetting();

// ---------- Screen & speakers ----------
// Host window only: a LAN viewer has no OS window to place and plays sound
// wherever its own browser does. Both lists are re-read whenever a select
// gets focus, since screens and speakers come and go (a TV switched off).
const screenTargetSelect = document.getElementById('screen-target-select');
const screenTargetHelp = document.getElementById('screen-target-help');
const audioOutputSelect = document.getElementById('audio-output-select');
const audioOutputHelp = document.getElementById('audio-output-help');
const SCREEN_HELP = 'RerunTV opens on this screen, and goes back to it when it reconnects, like after the TV wakes up.';
const AUDIO_HELP = 'Play through the TV’s speakers without changing the Windows default. Set on this computer only.';
let screenOptions = [];
let audioOptions = [];

function screenName(screen) {
  const name = screen.label || (screen.primary ? 'Main screen' : 'Screen');
  return `${name.toUpperCase()} — ${screen.width}×${screen.height}`;
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map((option) => {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.text;
    return el;
  }));
  select.value = value;
}

async function renderScreenTarget() {
  const row = screenTargetSelect && screenTargetSelect.closest('.setting-row');
  if (!row) return;
  const info = window.api && window.api.listScreens ? await window.api.listScreens().catch(() => null) : null;
  row.hidden = !info;
  if (!info) return;
  const preferred = info.preferred;
  const current = info.screens.find((screen) => screen.current);
  screenOptions = [{ value: '', text: 'LAST ONE USED', ref: null }];
  info.screens.forEach((screen) => {
    screenOptions.push({ value: screen.id, text: `${screenName(screen)}${screen.current ? ' (HERE NOW)' : ''}`, ref: { id: screen.id, label: screen.label } });
  });
  const preferredConnected = preferred && info.screens.some((screen) => screen.id === preferred.id || (preferred.label && screen.label === preferred.label));
  if (preferred && !preferredConnected) {
    screenOptions.push({ value: preferred.id, text: `${(preferred.label || 'Saved screen').toUpperCase()} (NOT CONNECTED)`, ref: preferred });
  }
  const selected = !preferred ? ''
    : (info.screens.find((screen) => screen.id === preferred.id) || info.screens.find((screen) => preferred.label && screen.label === preferred.label) || preferred).id;
  fillSelect(screenTargetSelect, screenOptions, selected);
  if (info.pendingReturn) {
    screenTargetHelp.textContent = `Waiting for ${info.pendingReturn.label || 'the saved screen'} to reconnect. RerunTV moves there as soon as it does.`;
  } else if (!preferred && current) {
    screenTargetHelp.textContent = `${SCREEN_HELP} Now on ${current.label || 'this screen'}.`;
  } else {
    screenTargetHelp.textContent = SCREEN_HELP;
  }
}

async function renderAudioOutput() {
  const row = audioOutputSelect && audioOutputSelect.closest('.setting-row');
  if (!row) return;
  row.hidden = !!window.__isViewer;
  if (window.__isViewer) return;
  const outputs = await listAudioOutputs();
  const choice = getAudioOutputChoice();
  audioOptions = [{ value: '', text: 'SYSTEM DEFAULT', device: null }];
  outputs.forEach((device) => audioOptions.push({ value: device.deviceId, text: device.label.toUpperCase(), device }));
  let selected = '';
  if (choice) {
    const match = outputs.find((d) => d.deviceId === choice.deviceId) || outputs.find((d) => choice.label && d.label === choice.label);
    if (match) selected = match.deviceId;
    else {
      audioOptions.push({ value: choice.deviceId, text: `${(choice.label || 'Saved output').toUpperCase()} (NOT CONNECTED)`, device: choice });
      selected = choice.deviceId;
    }
  }
  fillSelect(audioOutputSelect, audioOptions, selected);
  audioOutputHelp.textContent = choice && !isAudioOutputPresent()
    ? 'That output isn’t connected, so sound plays through the system default until it’s back.'
    : AUDIO_HELP;
}

const tvModeScreenSelect = document.getElementById('tv-mode-screen-select');
const tvModeScreenHelp = document.getElementById('tv-mode-screen-help');
const TV_SCREEN_HELP = 'Use the remote-friendly TV layout while the window is on this screen, and the desktop layout everywhere else.';
let tvScreenOptions = [];

async function renderTvModeScreen() {
  const row = tvModeScreenSelect && tvModeScreenSelect.closest('.setting-row');
  if (!row) return;
  const info = window.api && window.api.listScreens ? await window.api.listScreens().catch(() => null) : null;
  row.hidden = !info;
  if (!info) return;
  const chosen = getTvModeScreen();
  tvScreenOptions = [{ value: '', text: 'OFF', ref: null }];
  info.screens.forEach((screen) => tvScreenOptions.push({ value: screen.id, text: screenName(screen), ref: { id: screen.id, label: screen.label } }));
  let selected = '';
  if (chosen) {
    const match = info.screens.find((screen) => screen.id === chosen.id) || info.screens.find((screen) => chosen.label && screen.label === chosen.label);
    if (match) selected = match.id;
    else {
      tvScreenOptions.push({ value: chosen.id, text: `${(chosen.label || 'Saved screen').toUpperCase()} (NOT CONNECTED)`, ref: chosen });
      selected = chosen.id;
    }
  }
  fillSelect(tvModeScreenSelect, tvScreenOptions, selected);
  const pref = getUsageModePreference();
  tvModeScreenHelp.textContent = chosen && pref !== 'auto'
    ? `Usage mode is set to ${pref.toUpperCase()} in System › This device, which wins over this. Set it to AUTO to use this.`
    : TV_SCREEN_HELP;
}

tvModeScreenSelect?.addEventListener('focus', () => renderTvModeScreen());
tvModeScreenSelect?.addEventListener('change', () => {
  const option = tvScreenOptions.find((o) => o.value === tvModeScreenSelect.value);
  setTvModeScreen(option ? option.ref : null);
  renderTvModeScreen();
  renderUsageModeSetting();
});

const screenOffActionSelect = document.getElementById('screen-off-action-select');
const screenEdgeSlider = document.getElementById('screen-edge-slider');
const screenEdgeValue = document.getElementById('screen-edge-value');
const screenEdgeHelp = document.getElementById('screen-edge-help');
const SCREEN_EDGE_HELP = 'If the TV cuts off the clock or banners, pull everything in until the white frame shows on all four sides. Saved for this screen only.';

function renderScreenPowerAndEdges() {
  const hostWindow = !!(window.api && window.api.listScreens);
  [screenOffActionSelect, screenEdgeSlider].forEach((el) => {
    const row = el && el.closest('.setting-row');
    if (row) row.hidden = !hostWindow;
  });
  if (!hostWindow) return;
  if (screenOffActionSelect) screenOffActionSelect.value = getScreenOffAction();
  if (screenEdgeSlider) {
    const screen = getCurrentScreen();
    const pct = getScreenEdge();
    screenEdgeSlider.value = String(pct);
    screenEdgeValue.textContent = `${pct}%`;
    screenEdgeHelp.textContent = screen && screen.label
      ? `${SCREEN_EDGE_HELP} Now adjusting ${screen.label}.`
      : SCREEN_EDGE_HELP;
  }
}

screenOffActionSelect?.addEventListener('change', () => setScreenOffAction(screenOffActionSelect.value));
screenEdgeSlider?.addEventListener('input', () => {
  setScreenEdge(Number(screenEdgeSlider.value));
  screenEdgeValue.textContent = `${Number(screenEdgeSlider.value)}%`;
  flashScreenEdgeGuide();
});
screenEdgeSlider?.addEventListener('focus', () => flashScreenEdgeGuide());
onCurrentScreenChange(() => renderScreenPowerAndEdges());

const audioLevelerSelect = document.getElementById('audio-leveler-select');
audioLevelerSelect?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['audioLeveler'], value: audioLevelerSelect.value });
  applyLeveler();
  setTimeout(renderAudioLeveler, 500);
});

const LEVELER_HELP = 'Evens out loud and quiet shows and commercials. Each file is measured once in the background.';

async function renderAudioLeveler() {
  if (!audioLevelerSelect) return;
  audioLevelerSelect.value = S.config.audioLeveler || 'off';
  const help = document.getElementById('audio-leveler-help');
  if (!help) return;
  const status = window.api && window.api.getLoudnessStatus ? await window.api.getLoudnessStatus().catch(() => null) : null;
  if (!status) {
    help.textContent = window.__isViewer ? 'Levels the sound on the box itself, not on this device.' : LEVELER_HELP;
  } else if (!status.available) {
    help.textContent = 'Needs ffmpeg to measure files. Install it from Plug-ins › FFmpeg Transcode.';
  } else if (S.config.audioLeveler === 'on' && status.queued) {
    help.textContent = `${LEVELER_HELP} ${status.measured} measured, ${status.queued} to go.`;
  } else {
    help.textContent = LEVELER_HELP;
  }
}

function renderScreenSpeakersSettings() {
  renderScreenPowerAndEdges();
  renderAudioLeveler();
  Promise.all([renderScreenTarget(), renderTvModeScreen(), renderAudioOutput()]).then(() => {
    const panel = document.getElementById('screen-speakers-panel');
    if (panel) panel.hidden = [...panel.querySelectorAll('.setting-row')].every((row) => row.hidden);
  });
}

screenTargetSelect?.addEventListener('focus', () => renderScreenTarget());
screenTargetSelect?.addEventListener('change', async () => {
  const option = screenOptions.find((o) => o.value === screenTargetSelect.value);
  if (window.api && window.api.setPreferredScreen) await window.api.setPreferredScreen(option ? option.ref : null);
  renderScreenTarget();
});
audioOutputSelect?.addEventListener('focus', () => renderAudioOutput());
audioOutputSelect?.addEventListener('change', async () => {
  const option = audioOptions.find((o) => o.value === audioOutputSelect.value);
  await setAudioOutput(option ? option.device : null);
  renderAudioOutput();
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
document.getElementById('guide-genre-colors-enabled')?.addEventListener('change', (event) => {
  updateGuideGenreTheme((entry) => { entry.enabled = event.target.checked; });
});
document.getElementById('guide-genre-add-btn')?.addEventListener('click', () => {
  const nameInput = document.getElementById('guide-genre-add-name');
  const colorInput = document.getElementById('guide-genre-add-color');
  const genre = normalizeGuideGenre(nameInput.value);
  if (!genre) return;
  updateGuideGenreTheme((entry) => { entry.colors[genre] = colorInput.value; });
  nameInput.value = '';
});
document.getElementById('guide-genre-reset-btn')?.addEventListener('click', () => {
  updateGuideGenreTheme((entry) => { entry.colors = {}; });
});
themeSelect.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['theme'], value: themeSelect.value });
  applyTheme();
  renderThemeBrowser();
  renderGuideGenreSettings();
  renderThemeFontSettingsInline();
});
if (themeBrowserToggle) {
  themeBrowserToggle.addEventListener('click', () => {
    const opening = themeBrowserEl.classList.contains('hidden');
    themeBrowserEl.classList.toggle('hidden', !opening);
    document.body.classList.toggle('theme-browser-open', opening);
    themeBrowserToggle.setAttribute('aria-expanded', String(opening));
    if (opening) {
      renderThemeBrowser();
      themeBrowserSearch.focus();
    }
  });
}
if (themeBrowserSearch) {
  themeBrowserSearch.addEventListener('input', renderThemeBrowser);
  themeBrowserSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeThemeBrowser({ restoreFocus: true });
  });
}
if (themeBrowserClose) {
  themeBrowserClose.addEventListener('click', () => closeThemeBrowser({ restoreFocus: true }));
}
if (themeBrowserEl) {
  themeBrowserEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeThemeBrowser({ restoreFocus: true });
    if (event.key === 'Tab') {
      const focusable = Array.from(themeBrowserEl.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}
document.addEventListener('pointerdown', (event) => {
  if (!themeBrowserEl || themeBrowserEl.classList.contains('hidden')) return;
  if (themeBrowserEl.contains(event.target) || themeBrowserToggle.contains(event.target)) return;
  closeThemeBrowser();
});
timeMachineEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['timeMachine', 'enabled'], value: timeMachineEnabledEl.checked });
  if (!S.config.timeMachine.enabled && S.timeMachineOn) exitTimeMachine({ toLive: true });
});
// ---------- Widescreen fill and logo bug options (Display) ----------
// Re-frames the picture and re-places the bug so the change shows at once.
function reframePicture() {
  if (player.videoWidth) applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  updateLogoBug(getChannel(S.currentNumber));
}
const setDisplay = (key, value) => dispatch({ type: 'settings.set', path: ['display', key], value });
const BARS_HELP = 'Finds black bars that are part of the video itself and frames the picture without them. Each file is checked once in the background.';
async function renderBakedBarsStatus() {
  const help = document.getElementById('aspect-bars-help');
  if (!help) return;
  const status = window.api && window.api.getCropStatus ? await window.api.getCropStatus().catch(() => null) : null;
  if (!status) {
    help.textContent = window.__isViewer ? 'Frames the picture on the box itself, not on this device.' : BARS_HELP;
  } else if (!status.available) {
    help.textContent = 'Needs ffmpeg to check files. Install it from Plug-ins › FFmpeg Transcode.';
  } else if (S.config.display.removeBakedBars && status.queued) {
    help.textContent = `${BARS_HELP} ${status.checked} checked (${status.withBars} with bars), ${status.queued} to go.`;
  } else if (status.checked) {
    help.textContent = `${BARS_HELP} ${status.checked} checked, ${status.withBars} with bars.`;
  } else {
    help.textContent = BARS_HELP;
  }
}
aspectBarsEl.addEventListener('change', () => {
  setDisplay('removeBakedBars', aspectBarsEl.checked);
  applyBakedBars();
  setTimeout(renderBakedBarsStatus, 500);
});
aspectAutofillEl.addEventListener('change', () => { setDisplay('autoFillWidescreen', aspectAutofillEl.checked); reframePicture(); });
aspectAutofillMaxEl.addEventListener('change', () => {
  const pct = Math.round(Math.min(60, Math.max(2, parseFloat(aspectAutofillMaxEl.value) || 30)));
  aspectAutofillMaxEl.value = pct;
  setDisplay('autoFillMaxCropPct', pct);
  reframePicture();
});
logoBugFollowPictureEl.addEventListener('change', () => { setDisplay('logoBugFollowPicture', logoBugFollowPictureEl.checked); applyBakedBars(); });
logoBugRefHeightEl.addEventListener('change', () => { setDisplay('logoBugReferenceHeight', logoBugRefHeightEl.value === 'auto' ? undefined : Number(logoBugRefHeightEl.value)); reframePicture(); });
logoBugDefaultSizeEl.addEventListener('input', () => {
  const size = parseInt(logoBugDefaultSizeEl.value, 10);
  const readout = document.getElementById('logo-bug-default-size-value');
  if (readout) readout.textContent = `${size} PX`;
  const profiles = (S.config.display.logoBugProfiles || []).map((p) => ({ ...p }));
  let target = profiles.find((p) => !p.aspect && !p.resolution);
  if (!target) { target = { id: 'default', aspect: null, resolution: null, x: 94, y: 90, size }; profiles.push(target); }
  target.size = size;
  delete target.width;
  delete target.height;
  dispatch({ type: 'settings.set', path: ['display', 'logoBugProfiles'], value: profiles }, { coalesce: 'display:logoBugDefaultSize' });
  reframePicture();
});
logoBugVaryEl.addEventListener('change', () => { setDisplay('logoBugVaryWithContent', logoBugVaryEl.checked); reframePicture(); });
logoBugHideBreaksEl.addEventListener('change', () => setDisplay('logoBugHideOnBreaks', logoBugHideBreaksEl.checked));
logoBugHideNumberEl.addEventListener('change', () => { setDisplay('logoBugHideNumber', logoBugHideNumberEl.checked); reframePicture(); });

// ---------- Help › What's new: things to try ----------
const helpHighlightsEl = document.getElementById('help-highlights');
if (helpHighlightsEl) renderHighlights(helpHighlightsEl);

// ---------- Keyboard shortcuts (System › Keys) ----------
function renderKeymapEditor() {
  const host = document.getElementById('keymap-editor');
  if (!host) return;
  const map = S.config.keyMap || {};
  host.innerHTML = '';
  const message = document.createElement('div');
  message.className = 'keymap-message panel-status';
  KEY_ACTIONS.forEach((action) => {
    const row = document.createElement('div');
    row.className = 'keymap-row';
    const label = document.createElement('span');
    label.className = 'keymap-label';
    label.textContent = action.label;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn keymap-key';
    const current = effectiveKey(map, action);
    button.textContent = current.toUpperCase();
    button.classList.toggle('keymap-changed', current !== action.key);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn keymap-reset';
    reset.textContent = current === action.key ? '' : `RESET (${action.key.toUpperCase()})`;
    reset.hidden = current === action.key;
    reset.addEventListener('click', () => {
      dispatch({ type: 'settings.set', path: ['keyMap', action.id], value: undefined });
      applyKeyHints();
      renderKeymapEditor();
    });
    button.addEventListener('click', () => {
      button.textContent = 'PRESS A KEY…';
      message.textContent = '';
      const onKey = (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        if (event.key === 'Escape') { renderKeymapEditor(); return; }
        const problem = keyProblem(S.config.keyMap || {}, action.id, event.key);
        if (problem) { renderKeymapEditor(); const m = document.querySelector('#keymap-editor .keymap-message'); if (m) m.textContent = problem; return; }
        const chosen = event.key.toLowerCase();
        dispatch({ type: 'settings.set', path: ['keyMap', action.id], value: chosen === action.key ? undefined : chosen });
        applyKeyHints();
        renderKeymapEditor();
      };
      window.addEventListener('keydown', onKey, true);
    });
    row.append(label, button, reset);
    host.appendChild(row);
  });
  host.appendChild(message);
}
document.querySelector('.setup-subtab-btn[data-subtab="keys"]')?.addEventListener('click', renderKeymapEditor);

// ---------- Reset a panel to its defaults ----------
// A panel marked data-reset-keys='[["display","clock24"],…]' gets a RESET
// button listing the settings it owns. Resetting removes those keys, so every
// reader falls back to its own default, as one undoable step (UNDO below).
function resetPanelKeys(panel) {
  let paths = [];
  try { paths = JSON.parse(panel.dataset.resetKeys || '[]'); } catch (e) { paths = []; }
  // The ones that differ from their default (or, with no default, that are set at all).
  const present = paths.filter((path) => {
    let node = S.config;
    for (const key of path) {
      if (node == null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return false;
      node = node[key];
    }
    const fallback = defaultForPath(path, S.config);
    return fallback === undefined || JSON.stringify(fallback) !== JSON.stringify(node);
  });
  return present;
}

document.querySelectorAll('.panel[data-reset-keys]').forEach((panel) => {
  const row = document.createElement('div');
  row.className = 'panel-body panel-reset-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn panel-reset-btn';
  button.textContent = 'RESET THIS PANEL TO DEFAULTS';
  row.appendChild(button);
  panel.appendChild(row);
  const refreshState = () => {
    const count = resetPanelKeys(panel).length;
    button.disabled = count === 0;
    button.title = count ? `Puts ${count} changed setting${count === 1 ? '' : 's'} back to default (undoable)` : 'Already at the defaults';
  };
  button.addEventListener('click', () => {
    const present = resetPanelKeys(panel);
    if (!present.length) return;
    const title = (panel.querySelector('.panel-toggle')?.textContent || 'panel').trim().toLowerCase();
    dispatch(present.map((path) => ({ type: 'settings.set', path, value: defaultForPath(path, S.config) })), { label: `Reset ${title}` });
    applyAspectMode();
    applyPictureMode();
    applyCrtState();
    applyHintBarState();
    applyVolume();
    renderSettingsPanels();
    renderKeymapEditor();
    applyKeyHints();
    reframePicture();
    button.textContent = 'RESET ✓ (UNDO BELOW)';
    setTimeout(() => { button.textContent = 'RESET THIS PANEL TO DEFAULTS'; refreshState(); }, 2500);
  });
  // The state follows config changes from anywhere (edits, undo, search).
  refreshState();
  panel.addEventListener('mouseenter', refreshState);
  panel.addEventListener('change', () => setTimeout(refreshState, 200));
  panel.addEventListener('input', () => setTimeout(refreshState, 300));
  window.addEventListener('reruntv:config-replaced', refreshState);
});

// ---------- Tuning & controls (System) ----------
const controlsCfg = () => S.config.controls || {};

function renderControlsPanel() {
  const c = controlsCfg();
  startupChannelEl.innerHTML = '';
  const addOption = (value, label) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    startupChannelEl.appendChild(opt);
  };
  addOption('last', 'LAST CHANNEL WATCHED');
  addOption('first', 'FIRST CHANNEL');
  for (const ch of sortedChannels()) addOption(String(ch.number), `CH ${formatChannelNumber(ch.number)}${ch.name ? ` · ${ch.name}` : ''}`);
  // A channel number may be saved as text (the Companion's Settings editor does).
  const startupRaw = c.startupChannel;
  const startup = typeof startupRaw === 'string' && startupRaw.trim() !== '' && Number.isFinite(Number(startupRaw)) ? Number(startupRaw) : startupRaw;
  startupChannelEl.value = typeof startup === 'number' ? String(startup) : (startup === 'first' ? 'first' : 'last');
  if (startupChannelEl.value === '') startupChannelEl.value = 'last';
  entryDelayEl.value = ((Number.isFinite(c.entryDelayMs) ? c.entryDelayMs : 800) / 1000).toFixed(1);
  scanDwellEl.value = Number.isFinite(c.scanDwellSec) ? c.scanDwellSec : 8;
  sleepStepsEl.value = (Array.isArray(c.sleepSteps) && c.sleepSteps.length ? c.sleepSteps : [30, 60, 90, 120]).join(', ');
  volumeStepEl.value = Number.isFinite(c.volumeStepPct) ? c.volumeStepPct : 10;
  volumeMaxEl.value = Number.isFinite(c.volumeMaxPct) ? c.volumeMaxPct : 100;
  rememberChannelVolumeEl.checked = !!c.rememberChannelVolume;
  sleepFadeOutEl.checked = c.sleepFadeOut !== false;
  tuneFadeInEl.value = String(Number.isFinite(c.tuneFadeInMs) ? c.tuneFadeInMs : 0);
}

const setControl = (key, value, opts) => dispatch({ type: 'settings.set', path: ['controls', key], value }, opts);
const clampNum = (el, min, max, fallback) => {
  const n = parseFloat(el.value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
};

startupChannelEl.addEventListener('change', () => {
  const v = startupChannelEl.value;
  setControl('startupChannel', v === 'last' || v === 'first' ? v : Number(v));
});
entryDelayEl.addEventListener('change', () => {
  const sec = clampNum(entryDelayEl, 0.2, 3, 0.8);
  entryDelayEl.value = sec.toFixed(1);
  setControl('entryDelayMs', Math.round(sec * 1000));
});
scanDwellEl.addEventListener('change', () => {
  const sec = Math.round(clampNum(scanDwellEl, 2, 60, 8));
  scanDwellEl.value = sec;
  setControl('scanDwellSec', sec);
});
sleepStepsEl.addEventListener('change', () => {
  const steps = [...new Set(sleepStepsEl.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 1440).map(Math.round))].sort((a, b) => a - b);
  const value = steps.length ? steps : [30, 60, 90, 120];
  sleepStepsEl.value = value.join(', ');
  setControl('sleepSteps', value);
});
volumeStepEl.addEventListener('change', () => {
  const pct = Math.round(clampNum(volumeStepEl, 1, 25, 10));
  volumeStepEl.value = pct;
  setControl('volumeStepPct', pct);
});
rememberChannelVolumeEl.addEventListener('change', () => setControl('rememberChannelVolume', rememberChannelVolumeEl.checked));
sleepFadeOutEl.addEventListener('change', () => setControl('sleepFadeOut', sleepFadeOutEl.checked));
tuneFadeInEl.addEventListener('change', () => setControl('tuneFadeInMs', parseInt(tuneFadeInEl.value, 10) || 0));
volumeMaxEl.addEventListener('input', () => {
  const pct = parseInt(volumeMaxEl.value, 10);
  setControl('volumeMaxPct', pct, { coalesce: 'settings:volumeMax' });
  // Lowering the ceiling pulls an over-limit volume down with it.
  if (typeof S.config.volume === 'number' && S.config.volume > pct / 100) {
    S.config.volume = pct / 100;
    commitInPlace({ type: 'settings.set', path: ['volume'], value: S.config.volume }, { skipUndo: true });
    applyVolume();
  }
});

timeMachineBadgeEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['timeMachine', 'showTimeShiftBadge'], value: timeMachineBadgeEl.checked });
  updateTimeShiftBadge();
});
upNextEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['upNext', 'enabled'], value: upNextEnabledEl.checked });
});
upNextDurationSlider?.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['upNext', 'duration'], value: parseInt(upNextDurationSlider.value, 10) || 8000 }, { coalesce: 'settings:upNext.duration' });
});
detailsEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['details', 'enabled'], value: detailsEnabledEl.checked });
});
stationIdEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['stationId', 'enabled'], value: stationIdEnabledEl.checked });
});
stationIdIntervalEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['stationId', 'intervalMinutes'], value: (stationIdIntervalEl.value = parsePositiveInt(stationIdIntervalEl.value, 15)) });
});
staticEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['staticEffect', 'enabled'], value: staticEnabledEl.checked });
  refreshDependentControls();
});
staticIntensitySlider.addEventListener('input', () => {
  dispatch({ type: 'settings.set', path: ['staticEffect', 'intensity'], value: parseInt(staticIntensitySlider.value, 10) }, { coalesce: 'settings:staticEffect.intensity' });
});
if (staticDurationSlider) {
  staticDurationSlider.addEventListener('input', () => {
    const ms = parseInt(staticDurationSlider.value, 10);
    dispatch({ type: 'settings.set', path: ['staticEffect', 'durationMs'], value: ms }, { coalesce: 'settings:staticEffect.durationMs' });
    if (staticDurationVal) staticDurationVal.textContent = ms === 0 ? '0ms (INSTANT)' : `${ms}ms`;
  });
}
triviaEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['trivia', 'enabled'], value: triviaEnabledEl.checked });
});
triviaIntervalEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['trivia', 'intervalMinutes'], value: (triviaIntervalEl.value = parsePositiveInt(triviaIntervalEl.value, 20)) });
});

if (pinLockEnabledEl) pinLockEnabledEl.addEventListener('change', () => { dispatch({ type: 'settings.set', path: ['pinLock', 'enabled'], value: pinLockEnabledEl.checked }); });
if (pinCodeInputEl) pinCodeInputEl.addEventListener('input', () => {
  // The keypad only accepts exactly four digits, so anything else would lock channels for good.
  pinCodeInputEl.value = pinCodeInputEl.value.replace(/\D/g, '').slice(0, 4);
  if (!/^\d{4}$/.test(pinCodeInputEl.value)) return;
  dispatch({ type: 'settings.set', path: ['pinLock', 'code'], value: pinCodeInputEl.value }, { coalesce: 'settings:pinLock.code', label: 'Change PIN' });
});
// The PIN is masked by default — it sits on a settings page that is itself
// reachable without the lock, so a plain text input meant anyone glancing at
// the screen could read the code the lock exists to keep. SHOW is for the
// person who set it and forgot it.
if (pinCodeRevealBtn && pinCodeInputEl) {
  pinCodeRevealBtn.addEventListener('click', () => {
    const revealed = pinCodeInputEl.type === 'text';
    pinCodeInputEl.type = revealed ? 'password' : 'text';
    pinCodeRevealBtn.textContent = revealed ? 'SHOW' : 'HIDE';
    pinCodeRevealBtn.setAttribute('aria-pressed', String(!revealed));
    pinCodeRevealBtn.setAttribute('aria-label', revealed ? 'Show PIN' : 'Hide PIN');
  });
}
if (pinCancelBtn) pinCancelBtn.addEventListener('click', hidePinLockScreen);

initFlowBuilder();


