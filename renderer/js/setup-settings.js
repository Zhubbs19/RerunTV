// DISPLAY / AUDIO & SYSTEM box-wide settings, the setup-tab bar itself
// (CHANNELS/DISPLAY/PROGRAMMING/AUDIO), and the cross-tab settings search.
import { applyConfigDefaults } from './app.js';
import { CUSTOM_SOUND_SLOTS } from './audio.js';
import { applyDisplayMode } from './display-mode.js';
import { applyLogoBugPlacement, refreshLogoBugGhost } from './playback.js';
import { applyAspectMode, applyPictureMode, applyCrtState, applyHintBarState, applyVolume, applyTvBezel } from './power.js';
import { applyTheme } from './themes.js';
import { S, saveConfigDebounced, pushUndoSnapshot } from './state.js';
import { getChannel } from './channels.js';
import { exitTimeMachine } from './timemachine.js';
import { pad2, toDatetimeLocalValue } from './util.js';
import { buildLogoBugProfileEditor, parsePositiveInt } from './setup-util.js';
import { runCoreHooks, themePackEntries } from './plugins.js';
import { confirmDialog, alertDialog } from './setup-dialogs.js';
import { initBackups, renderBackupsList as renderBackupsListFeature } from './setup-backups.js';
import {
  DEFAULT_GUIDE_GENRES, defaultGuideGenreColor, guideGenreThemeConfig, normalizeGuideGenre,
} from './guide-genres.js';
import { renderCommercialsPanel, renderInterstitialsList, renderPresetsList, renderStandbyPanel } from './setup-interstitials.js';
import { initFlowBuilder, renderFlowsList } from './setup-interstitials-flowbuilder.js';
import { renderAutoCurateList } from './setup-autocurate.js';
import { renderTagTaxonomyPanel } from './setup-tagtaxonomy.js';
import { attachSliderReadout } from './setup-util.js';
import { renderChannelList } from './setup-channels.js';
import { renderBoxStatus } from './setup-channels-diagnostics.js';
import { hidePinLockScreen } from './pin-lock.js';
import {
  adVolumeSlider, contentVolumeSlider, crtBurninSlider, crtCurvatureSlider, crtFlickerSlider, crtGrainSlider, crtScanlinesSlider,
  crtVignetteSlider,
  clock24El, detailsEnabledEl,
  guideSlotsSelect, hintBarEnabledEl, hintBarCompactEl, hintBarSlideEnabledEl,
  hintBarShowDurationEl, hintBarShowDurationValEl, hintBarHideDurationEl, hintBarHideDurationValEl,
  aspectModeSelect, bootPowerAnimEnabledEl, crtOverlayWholeScreenEnabledEl, guideOpenCloseAnimEnabledEl, guideAnimSpeedSlider, logoBugEditorEl, movieModeEnabledEl, pictureModeSelect,
  noSignalTitleInput, noSignalMessageInput, noSignalCopyReset,
  displayModeAspectSelect, displayModeWindowSelect, displayModeResolutionSelect, displayModeAutoPrioritySelect,
  viewerEnabledEl, viewerUrlStatusEl, connectedDevicesListEl, setupScreen,
  setupSearchEl, setupSearchResultsEl, setupSearchEmptyEl, staticDurationSlider, staticDurationVal, staticEnabledEl, staticIntensitySlider,
  virtualFilterInputEl, virtualExpandAllBtn, virtualCollapseAllBtn,
  setupBreadcrumbEl, helpShortcutsGridEl, helpChangelogListEl, helpVersionEl, checkUpdatesBtn,
  updateModeSelect, updateStatusLineEl, updateSettingsPanelEl,
  helpReleaseNotesListEl, releaseNotesPanelEl,
  helpGuideListEl, helpGuideSearchEl, helpPrintManualBtn, hintBarEl, hintBarItemsListEl,
  player,
  stationIdEnabledEl, stationIdIntervalEl, themeSelect,
  themeBrowserToggle, themeBrowserCurrentLabel, themeBrowserEl, themeBrowserSearch, themeBrowserClose, themeBrowserGroups, themeBrowserEmpty,
  timeMachineEnabledEl, triviaEnabledEl, triviaIntervalEl, upNextEnabledEl,
  pinCancelBtn, pinCodeInputEl, pinLockEnabledEl,
} from './dom.js';

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
  .concat([attachSliderReadout(guideAnimSpeedSlider, { suffix: 'ms' })]);

function setDependentControlState(control, enabled) {
  if (!control) return;
  control.disabled = !enabled;
  control.closest('label, .panel-interval')?.classList.toggle('control-disabled', !enabled);
}

function refreshDependentControls() {
  setDependentControlState(guideAnimSpeedSlider, guideOpenCloseAnimEnabledEl.checked);
  setDependentControlState(staticIntensitySlider, staticEnabledEl.checked);
  setDependentControlState(staticDurationSlider, staticEnabledEl.checked);
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
const PLUGIN_DEPENDENT_HINT_NAMES = { 'alert-test': 'EAS Alerts', 'news-alert': 'Breaking News Alerts' };

function renderHintBarItemsList() {
  if (!hintBarItemsListEl || !hintBarEl) return;
  hintBarItemsListEl.innerHTML = '';
  const hidden = S.config.display.hintBarHidden || [];
  Array.from(hintBarEl.children).forEach((span) => {
    const key = span.dataset.hintKey;
    if (!key) return;
    const label = document.createElement('label');
    label.className = 'shuffle-toggle';
    const pluginName = PLUGIN_DEPENDENT_HINT_NAMES[key];
    if (pluginName) label.title = `Only shows in the bar while the "${pluginName}" plugin is installed and enabled.`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hidden.includes(key);
    checkbox.addEventListener('change', () => {
      if (!Array.isArray(S.config.display.hintBarHidden)) S.config.display.hintBarHidden = [];
      const idx = S.config.display.hintBarHidden.indexOf(key);
      if (checkbox.checked && idx !== -1) S.config.display.hintBarHidden.splice(idx, 1);
      if (!checkbox.checked && idx === -1) S.config.display.hintBarHidden.push(key);
      applyHintBarState();
      saveConfigDebounced();
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
    (profiles) => { S.config.display.logoBugProfiles = profiles; saveConfigDebounced(); },
    () => applyLogoBugPlacement(),
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
      const path = await window.api.selectAudio();
      if (!path) return;
      S.config.customSounds[slot] = path;
      saveConfigDebounced();
      refresh();
    });
    const builtIn = document.createElement('button');
    builtIn.type = 'button'; builtIn.className = 'btn'; builtIn.textContent = 'BUILT-IN';
    builtIn.addEventListener('click', () => { delete S.config.customSounds[slot]; saveConfigDebounced(); refresh(); });
    const silent = document.createElement('button');
    silent.type = 'button'; silent.className = 'btn'; silent.textContent = 'SILENT';
    silent.addEventListener('click', () => { S.config.customSounds[slot] = false; saveConfigDebounced(); refresh(); });
    row.append(name, status, choose, builtIn, silent);
    root.appendChild(row);
    refresh();
  });
}

export function renderSettingsPanels() {
  const ci = S.config.crtIntensity;
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
  renderLogoBugEditor();
  renderCustomSoundSettings();
  pictureModeSelect.value = S.config.pictureMode || 'standard';
  aspectModeSelect.value = S.config.aspectMode || 'contain';
  movieModeEnabledEl.checked = !!S.config.display.movieMode;
  displayModeAspectSelect.value = S.config.displayMode.aspect || '16:9';
  displayModeWindowSelect.value = S.config.displayMode.windowMode || 'letterbox';
  displayModeResolutionSelect.value = S.config.displayMode.resolution || 'native';
  displayModeAutoPrioritySelect.value = S.config.displayMode.autoPriority || 'metadata';
  crtOverlayWholeScreenEnabledEl.checked = S.config.crtIntensity.overlayScope === 'wholeScreen';
  bootPowerAnimEnabledEl.checked = S.config.display.bootPowerOnAnim !== false;
  guideOpenCloseAnimEnabledEl.checked = !!S.config.display.guideOpenCloseAnim;
  guideAnimSpeedSlider.value = S.config.display.guideOpenCloseAnimMs || 180;
  noSignalTitleInput.value = S.config.display.noSignalTitle || '';
  noSignalMessageInput.value = S.config.display.noSignalMessage || '';
  renderThemeSelectOptions();
  themeSelect.value = S.config.theme || 'digital-2000s';
  renderThemeBrowser();
  renderGuideGenreSettings();
  upNextEnabledEl.checked = S.config.upNext.enabled !== false;
  detailsEnabledEl.checked = S.config.details.enabled !== false;
  timeMachineEnabledEl.checked = !!S.config.timeMachine.enabled;
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
  renderBackupsList();
  renderViewerUrlStatus();
  renderConnectedDevices();
  sliderReadouts.forEach((r) => r.refresh());
}

import { startPerfMonitor, stopPerfMonitor } from './perf.js';
import { renderPluginsTab } from './setup-plugins.js';
import { renderPluginDiagnostics } from './plugin-diagnostics.js';

// ---------- Settings screen tabs ----------
const setupTabBtns = document.querySelectorAll('.setup-tab-btn');
const setupTabPanels = document.querySelectorAll('.setup-tab-panel');

// The original SYSTEM markup mixed audio/power with LAN device access in a
// single grid. Move the two network cards into their dedicated sub-tab at
// boot; keeping their existing elements/ids means all listeners and config
// contracts remain unchanged.
const networkSettingsGrid = document.getElementById('network-settings-grid');
if (networkSettingsGrid) {
  const viewerPanel = viewerEnabledEl?.closest('.panel');
  const devicesPanel = connectedDevicesListEl?.closest('.panel');
  if (viewerPanel) networkSettingsGrid.appendChild(viewerPanel);
  if (devicesPanel) networkSettingsGrid.appendChild(devicesPanel);
}

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

const SETUP_SECTION_COPY = {
  channels: ['CHANNELS', 'Build and manage the lineup, media folders, schedules, titles, ads, and logos.'],
  display: ['DISPLAY', 'Tune picture behavior, display simulation, guide presentation, and on-screen identity.'],
  programming: ['PROGRAMMING', 'Shape show timing, breaks, bumpers, automation, and the tags that connect them.'],
  audio: ['AUDIO, NETWORK & STORAGE', 'Control audio levels, connected viewing, access, virtual channels, and backups.'],
  perf: ['STATUS & DIAGNOSTICS', 'Check library health, playback performance, and system activity.'],
  plugins: ['PLUGINS', 'Manage optional channels, themes, on-screen features, integrations, and their permissions.'],
  help: ['HELP & UPDATES', 'Find guidance, shortcuts, software updates, and release notes.'],
};

function updateSetupHeading(tab) {
  const [title, description] = SETUP_SECTION_COPY[tab] || SETUP_SECTION_COPY.channels;
  const titleEl = document.getElementById('setup-page-title');
  const descriptionEl = document.getElementById('setup-page-description');
  if (titleEl) titleEl.textContent = title;
  if (descriptionEl) descriptionEl.textContent = description;
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
  setupBreadcrumbEl.innerHTML = parts
    .map((p, i) => (i === parts.length - 1 ? `<span class="crumb-current">${p}</span>` : p))
    .join('<span class="crumb-sep">›</span>');
}

setupTabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    closeSettingsSearch();
    const tab = btn.dataset.tab;
    lastSetupTab = tab;
    setupTabBtns.forEach((b) => b.classList.toggle('active', b === btn));
    setupTabPanels.forEach((p) => p.classList.toggle('hidden', p.dataset.tabPanel !== tab));
    revealPanel(Array.from(setupTabPanels).find((p) => p.dataset.tabPanel === tab));
    if (tab === 'perf') {
      startPerfMonitor();
      renderBoxStatus();
    } else {
      stopPerfMonitor();
    }
    if (tab === 'help') renderHelpTab();
    if (tab === 'plugins') { renderPluginsTab(); renderPluginDiagnostics(); }
    restoreActiveSubtabPanels();
    updateBreadcrumb();
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
  if (lastSetupTab === 'perf') { startPerfMonitor(); renderBoxStatus(); }
  if (lastSetupTab === 'plugins') { renderPluginsTab(); renderPluginDiagnostics(); }
  restoreActiveSubtabPanels();
  updateBreadcrumb();
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
      btns.forEach((b) => b.classList.toggle('active', b === btn));
      parent.querySelectorAll(':scope > .setup-subtab-panel').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.subtabPanel !== btn.dataset.subtab);
      });
      revealPanel(parent.querySelector(`:scope > .setup-subtab-panel[data-subtab-panel="${btn.dataset.subtab}"]`));
      updateBreadcrumb();
    });
  });
});

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
    'STEP 1: Go to the CHANNELS tab and click "+ ADD CHANNEL". A new, empty channel will show up.',
    'STEP 2: Click "ADD FOLDER" and pick a folder of video files on your computer. The app scans it, figures out how long each video is, and builds a playlist for you automatically. A big folder might take a minute — that\'s normal.',
    'STEP 3: Want more than one folder on the same channel? Just repeat step 2. You could put cartoons and movies on the same channel, or keep them on separate channels — totally up to you.',
    'NOTE: You can rename a channel or change its number any time by clicking directly on its NAME or NUMBER in the list.',
    'TIP: Checking "SHUFFLE ORDER" mixes up the playback order once. It won\'t keep re-shuffling every time the channel loops — uncheck and recheck it whenever you want a new shuffle.',
    'STEP 4: When you\'re ready, click "START WATCHING" in the bottom-right corner to leave this screen and start watching. That\'s it!',
  ] },
  { group: 'SECTION 3 — THE CHANNELS TAB', title: '3.1 Editing a Channel: Folders, Schedule, Titles, Ads, and Logo', body: [
    'Click "EDIT" on any channel to open its full settings. You\'ll see five smaller tabs inside:',
    'FOLDERS — add or remove which video folders feed this channel.',
    'SCHEDULE — set up a real broadcast-style schedule using PROGRAMMING BLOCKS, plus a CALENDAR for marking special dates.',
    'TITLES — rename individual shows, or automatically pull in a poster and description for each one.',
    'ADS — control how often commercial breaks happen on this channel.',
    'LOGO — show a small logo in the corner of the screen while this channel is playing, like a real TV network watermark.',
    'NOTE: If you don\'t set up any BLOCKS, the channel just plays through its whole library on a loop. Blocks are completely optional — only bother with them once you want an actual schedule, like "cartoons in the morning, movies at night."',
  ] },
  { group: 'SECTION 3 — THE CHANNELS TAB', title: '3.2 Programming Blocks and the Calendar', body: [
    'A PROGRAMMING BLOCK is just a time slot with its own lineup — for example, "cartoons, weekdays, 4–6 PM." You can trigger a block two ways: by day of the week and time (repeats every week), or by a specific date range (great for holidays or a limited-time marathon).',
    'TIP: Turn on WEEKLY ROTATION on a block if you want its lineup to change from week to week instead of repeating the exact same shows every time.',
    'The CALENDAR (same tab as SCHEDULE) shows you a full month at once, color-coded by what\'s playing each day. It automatically flags anything that conflicts, and you can override a single day without messing up your regular schedule.',
  ] },
  { group: 'SECTION 3 — THE CHANNELS TAB', title: '3.3 Previewing, Fixing Problems, and Editing Multiple Channels', body: [
    'PREVIEW (on every channel row) shows you what that channel would look like at any date and time, right in the setup screen — no need to actually tune to it. Use the quick-jump buttons to skip to the start of a show, the next ad break, an hour later, and so on.',
    'CAUTION: If you move, rename, or delete video files outside the app, the channel won\'t know where they went. Click "CHECK CHANNELS" to scan for anything missing, and "FIX PLAYBACK" to relink or remove those files.',
    'Need to change something on a bunch of channels at once — like favoriting several, or bulk-deleting? Click "SELECT CHANNELS" to turn on checkboxes for the whole list.',
  ] },
  { group: 'SECTION 3 — THE CHANNELS TAB', title: '3.4 Playback Order, Channel Packages, and Broadcast Identity', body: [
    'The TITLES editor can sort naturally, reverse, restore folder order, create a repeatable seeded shuffle, or accept drag-and-drop ordering. Every automatic reorder previews the change and asks before it re-anchors the live channel.',
    'EXPORT CHANNEL creates a portable package containing that channel and the programming resources it directly uses. IMPORT CHANNEL merges one into your current box, remaps conflicting channel/resource numbers, and can relink missing local folders without replacing unrelated settings.',
    'IDENTITY lets one channel override the box theme, tune sound, static style, and accent colors. Leave any choice on INHERIT to keep following the box-wide theme.',
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
    'The Emergency Alert System and Breaking News Alerts have their own settings — look for SETTINGS next to each one in the PLUGINS tab. EAS runs a periodic test alert (or press E to trigger one now); Breaking News interrupts with a styled bulletin, either automatically or on demand with the B key.',
    'NOTE: Press I any time to see details about what\'s currently playing. Press T to open the TIME MACHINE and jump the schedule backward or forward.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.4 Air Check', body: [
    'AIR CHECK is the broadcast resolver console. Pick a channel and time to see which source, show position, schedule block, ad policy, and output RerunTV resolves, plus why that result won. Previous/next boundary buttons make timing problems easier to isolate.',
    'The pool inspector shows which bumper and ad entries are eligible. FORCE ON TV previews one selected entry without rewriting the real schedule.',
  ] },
  { group: 'SECTION 5 — THE DISPLAY TAB', title: '5.1 Picture Adjustments and the CRT Look', body: [
    'The CRT sliders — SCANLINES, VIGNETTE, GRAIN, FLICKER, CURVATURE, and BURN-IN — recreate the look of an old TV screen. Watch the preview update live as you drag each one.',
    'Press P any time to cycle through picture-color presets, or press A to cycle how the picture fits the screen: STANDARD (safe letterboxing, with a border for non-widescreen content if your theme has one), STRETCH (deliberately distorted, like squeezing a widescreen picture onto an old TV), and FILL (zooms in to fill the whole screen, cropping the edges).',
  ] },
  { group: 'SECTION 5 — THE DISPLAY TAB', title: '5.2 Themes and the Channel Logo', body: [
    'THEME (under CLOCK & GUIDE) changes the whole look and feel of your box in one click — the channel-change animation, the idle screensaver, the sound effects, the on-screen guide, and the picture\'s color, all at once, not just a color swap.',
    'CHANNEL LOGO shows a small logo in a corner of the screen while you\'re watching. TIP: Leave it in the same spot long enough and it develops a faint "burn-in" ghost, just like a real old TV — that\'s intentional, not a bug.',
  ] },
  { group: 'SECTION 6 — AUDIO & SYSTEM', title: '6.1 Volume Controls', body: [
    'The box has two separate volume levels — CONTENT (your shows) and COMMERCIAL/BUMPER — both set as a percentage you can adjust live with the +/- keys. Turn up the commercial volume if your ads always sound quiet, or down if they blast.',
    'NOTE: Any individual channel or block can set its own volume, which always overrides the two sliders above.',
    'VINTAGE CRT AUDIO FILTER & SFX softens the sound a bit and can add a faint hum and mechanical click sounds, for that old-TV-speaker feel.',
  ] },
  { group: 'SECTION 6 — AUDIO & SYSTEM', title: '6.2 The Universal Remote (Phone Browser Page)', body: [
    'Enable PHONE REMOTE LAN ACCESS in the Universal Remote plugin, save, and restart. Its pairing link opens a full remote in any browser on the same WiFi; the short code is exchanged for a private session before controls or channel data are available.',
    'NOTE: This only works on your home WiFi, not over cellular data or from outside the house.',
    'TIP: If the remote page won\'t load, double check your phone is on the exact same WiFi network as the box (not a guest network) — that\'s the most common issue.',
  ] },
  { group: 'SECTION 6 — AUDIO & SYSTEM', title: '6.3 Watching on Other Screens (The LAN Viewer)', body: [
    'WATCH ON OTHER DEVICES is off by default. Enable it, save, and restart, then open its pairing link on a laptop, tablet, or second TV. The viewer receives schedule data and opaque media ids, never host filesystem paths.',
    'NOTE: Each paired viewer is an independent read-only instance of the channel lineup and can tune locally without changing the main box.',
    'There\'s also an early Android TV app included in this project for a proper big-screen version of the same viewer, if you\'re comfortable building it yourself.',
  ] },
  { group: 'SECTION 6 — AUDIO & SYSTEM', title: '6.4 The Party Page (Guest Bulletin & Jukebox)', body: [
    'When the PARTY channel (see SECTION 7) is enabled and RerunTV restarted, it shows a pairing QR code for the guest page. Guests need no account, but must use that host-issued link before posting or controlling party features.',
    'From that page, a guest can: post a photo or short video to the screen, send a text-to-speech announcement, play a sound effect, join a trivia round, submit a caption contest entry, vote for what plays next, check in on the guest wall, and — if the jukebox is turned on — add or vote to skip a song.',
    'TIP: The QR code shows right on screen whenever the PARTY channel is idle, so guests can just scan it — no need to read a URL out loud over the music.',
    'NOTE: Anything posted from the party page only lasts for that session — it\'s not saved permanently, and clears out the next time the box restarts.',
  ] },
  { group: 'SECTION 6 — AUDIO & SYSTEM', title: '6.5 The Android Companion App and Connected Devices', body: [
    'There\'s also a separate Android app (different from the browser remote above) with quick-tap favorite channels you set up yourself, plus the same core remote controls — a faster option if you\'re often using just one hand.',
    'CONNECTED DEVICES shows every remote, viewer, and party guest currently active on your network. NOTE: A device drops off this list about 30 seconds after it stops checking in — think of it as "who\'s active right now," not a permanent list.',
  ] },
  { group: 'SECTION 6 — AUDIO & SYSTEM', title: '6.6 Backing Up Your Settings', body: [
    'CAUTION: Your settings are backed up automatically on a rotating basis, and you can also click "snapshot now" any time for a manual backup. If something ever goes wrong, click "RESTORE" next to any backup to roll back to it — and if that wasn\'t what you wanted, Ctrl+Z undoes even that (see SECTION 8).',
    'TIP: Give an important backup a LABEL (like "before reorganizing cartoons") and PIN it so automatic rotation never removes it. PREVIEW shows channel, title-count, schedule, and box-setting differences before you restore.',
  ] },
  { group: 'SECTION 6 — AUDIO & SYSTEM', title: '6.7 Opt-In Library Synchronization', body: [
    'LIBRARY SYNC is off by default. When enabled, it checks only the folders already linked to your channels, either after startup or at your chosen interval, and adds new titles automatically.',
    'Likely renames preserve your title, tags, and other metadata only when the match is unambiguous. Missing titles are reported but kept by default; automatic removal is a separate warned option you must explicitly enable.',
  ] },
  { group: 'SECTION 7 — SPECIAL & VIRTUAL CHANNELS', title: '7.1 The Built-In Channels', body: [
    'Alongside your own channels, the box comes with a few special built-in ones — a program guide, a community bulletin board, a weather channel, a party channel, and more. Each one is its own plugin, and you can turn any of them on or off from the PLUGINS tab, even the ones that come on by default.',
    'CH1 PREVIEW GUIDE is a scrolling program guide, like an old cable listings channel. CH2 PUBLIC ACCESS shows rotating community bulletin slides.',
    'CH0 AUX/VIDEO IN acts like a "line in" — it can even capture a window or app running on this same computer (like a karaoke app). CH3 WEATHER shows current conditions for your area.',
    'CH94 PARTY (see SECTION 6.4) is the interactive guest channel with photos, trivia, voting, and more.',
    'A few higher channel numbers (51, 88, and 94–99) are used for fun extras — a fake late-night channel, a game channel, shopping-channel parodies, a music visualizer, a pay-per-view screen, and a teletext channel. Each is its own plugin too, and any of them will automatically step aside if you already have a real channel using that number.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.1 Undo, Redo, the Command Palette, and Keyboard Shortcuts', body: [
    'Made a mistake? Press Ctrl+Z to undo your last change, and Ctrl+Shift+Z (or Ctrl+Y) to redo it. There are also UNDO/REDO buttons at the bottom of the screen — they gray out automatically when there\'s nothing to undo or redo.',
    'NOTE: Regular watching — changing the channel, adjusting volume, switching picture mode — doesn\'t count as a "setting" and won\'t show up in this undo history.',
    'Press Ctrl+K, or the COMMANDS button, to open a searchable list of everything you can do on this screen — jump to a tab, add a channel, run a diagnostic, export your settings, and more, all without hunting through menus.',
    'TIP: You can also get around this whole screen with just the keyboard. Arrow keys move between tabs and list rows, Enter selects, Delete removes, and Ctrl+F jumps straight to the search box.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.2 Searching the Guide and Reminders', body: [
    'Type at least two letters in the full guide search to find matching program titles, descriptions, or tags across the next seven days. Choose a result to jump the guide to it.',
    'SET REMINDER creates a local reminder. When the viewing clock reaches the program, a toast offers TUNE NOW or DISMISS; reminders follow the time-machine clock just like the schedule itself.',
  ] },
  { group: 'SECTION 9 — THE PLUGINS TAB', title: '9.1 Installing, Turning On/Off, and Removing Plugins', body: [
    'A lot of what this box can do — every special channel from SECTION 7, the remote control, weather and show-info lookups, even audio streaming features that need extra processing behind the scenes — comes from individual PLUGINS, listed on the PLUGINS tab. Some come built in and turned on by default; you can add more yourself.',
    'STEP 1: To add one, either click "INSTALL FROM ZIP…" and pick the file, or drop its folder into the plugins folder (click "OPEN PLUGINS FOLDER" to find it) and click "RESCAN".',
    'Use the checkbox next to each plugin to turn it on or off, then click "SAVE CHANGES". Like most changes on this tab, turning a plugin on/off or adding a new one only takes effect after you restart the app.',
    'NOTE: To remove a plugin you installed yourself, delete its folder from the plugins folder ("OPEN PLUGINS FOLDER") and click RESCAN. Plugins that came built in are different — if a future app update removes one, it cleans up after itself automatically the next time you restart. You don\'t need to do anything.',
  ] },
  { group: 'SECTION 9 — THE PLUGINS TAB', title: '9.2 What a Plugin Is Allowed to Do', body: [
    'Some plugins need extra permissions — to talk to the internet, open another program, or run their own little web page. Each plugin lists exactly which of these it needs and why, right in the PLUGINS tab. The first time you use a plugin like this (or after an update adds a new permission), you\'ll see a prompt to approve it before it can run.',
    'CAUTION: Only install plugins from sources you trust. Approving a permission limits what a plugin is allowed to do — it doesn\'t guarantee the plugin only does good things with the access you give it.',
    'Many plugins also run in their own separate, walled-off space instead of sharing the app\'s own — similar to how each tab in a web browser runs separately. That way, if one plugin crashes or misbehaves, it can\'t take the rest of the box down with it, and it\'s genuinely limited by your computer to only what it asked permission for.',
  ] },
  { group: 'SECTION 9 — THE PLUGINS TAB', title: '9.3 Developer Diagnostics and Support Bundles', body: [
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

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
      S.config.updates = S.config.updates || {};
      S.config.updates.strategy = updateModeSelect.value;
      saveConfigDebounced();
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
    body.innerHTML = (r.body || 'No description.').split('\n').map((line) => escapeHtml(line)).join('<br>');
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
    Array.from(hintBarEl.children).forEach((span) => {
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

const SEARCH_ACTIONS = [
  ['channels', null, '#add-channel-btn', 'Add channel'],
  ['channels', null, '#library-search-toggle-btn', 'Search media library'],
  ['channels', null, '#now-next-toggle-btn', 'Open Now and Next dashboard'],
  ['channels', null, '#bulk-select-toggle-btn', 'Select and edit multiple channels'],
  ['channels', null, '#health-check-btn', 'Check channel health'],
  ['plugins', null, '#plugins-install-zip-btn', 'Install plugin from ZIP'],
  ['perf', null, '#box-status-check-btn', 'Run health check'],
  ['help', 'updates', '#check-updates-btn', 'Check for software updates'],
];

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

function allSearchEntries() {
  const panels = searchableUnits().map(searchEntryForPanel).filter((entry) => entry.tab);
  const actions = SEARCH_ACTIONS.map(([tab, subtab, selector, title]) => {
    const target = document.querySelector(selector);
    const topButton = document.querySelector(`.setup-tab-btn[data-tab="${tab}"]`);
    return target && {
      tab, subtab, target, title,
      path: `${cleanSearchText(topButton && topButton.textContent)} › ${title}`,
      preview: 'Action', haystack: `${title} ${cleanSearchText(target.title)}`.toLowerCase(),
    };
  }).filter(Boolean);
  return [...actions, ...panels];
}

function navigateToSearchEntry(entry) {
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
    entry.target.classList.remove('search-target-flash');
    void entry.target.offsetWidth;
    entry.target.classList.add('search-target-flash');
    setTimeout(() => entry.target.classList.remove('search-target-flash'), 1200);
  });
}

function renderSettingsSearch() {
  const q = setupSearchEl.value.trim().toLowerCase();
  setupSearchResultsEl.innerHTML = '';
  if (!q) { closeSettingsSearch(); return; }
  const words = q.split(/\s+/).filter(Boolean);
  const matches = allSearchEntries().filter((entry) => words.every((word) => entry.haystack.includes(word))).slice(0, 30);
  setupSearchEmptyEl.classList.toggle('hidden', matches.length > 0);
  setupSearchResultsEl.classList.toggle('hidden', matches.length === 0);
  setupSearchEl.setAttribute('aria-expanded', String(matches.length > 0));
  matches.forEach((entry, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `setup-search-result-${index}`;
    button.className = `setup-search-result${index === 0 ? ' active' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === 0));
    const pathEl = document.createElement('span');
    pathEl.className = 'setup-search-result-path';
    pathEl.textContent = entry.path;
    const preview = document.createElement('span');
    preview.className = 'setup-search-result-preview';
    preview.textContent = entry.preview || 'Open this setting';
    button.append(pathEl, preview);
    button.addEventListener('click', () => navigateToSearchEntry(entry));
    setupSearchResultsEl.appendChild(button);
  });
  if (matches.length) setupSearchEl.setAttribute('aria-activedescendant', 'setup-search-result-0');
  else setupSearchEl.removeAttribute('aria-activedescendant');
}

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

// The navigation needs an opaque theme surface only while it is actually
// pinned over scrolling content. Keeping that surface active at scrollTop=0
// cuts a large solid rectangle through themes whose setup page is a gradient.
const setupNavEl = setupScreen.querySelector('.setup-nav');
function syncSetupNavStickySurface() {
  if (!setupNavEl) return;
  const stickyTop = parseFloat(getComputedStyle(setupNavEl).top) || 0;
  const scrollPaddingTop = parseFloat(getComputedStyle(setupScreen).paddingTop) || 0;
  const stuckEdge = setupScreen.getBoundingClientRect().top + scrollPaddingTop + stickyTop;
  const isStuck = setupScreen.scrollTop > 0 && setupNavEl.getBoundingClientRect().top <= stuckEdge + 1;
  setupNavEl.classList.toggle('is-stuck', isStuck);
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
  S.config.display.guideGenreStyles = {
    ...(S.config.display.guideGenreStyles || {}),
    [themeId]: next,
  };
  saveConfigDebounced();
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
setupScreen.addEventListener('scroll', syncSetupNavStickySurface, { passive: true });
window.addEventListener('resize', syncSetupNavStickySurface);
syncSetupNavStickySurface();

// ---------- Virtual Channels: collapsible cards + local filter ----------
// This sub-tab is one full-width .panel per system-level setting that hasn't
// moved to a plugin's own SETTINGS panel (currently just the parental-lock
// PIN — a couple of others used to live here too, before they became
// plugins), stacked with no grouping, easily the longest unbroken scroll in
// setup. Collapsing to just
// the header row by
// default, plus a local filter that auto-expands matches, turns that into
// a scannable list instead of a scroll marathon. Scoped entirely to this
// sub-tab (see the [data-subtab-panel="virtual"] CSS) so it doesn't change
// how .panel behaves anywhere else in setup.
function virtualChannelPanels() {
  return Array.from(document.querySelectorAll('[data-subtab-panel="virtual"] .panel'));
}

// Runs once at module load (these panels are static HTML, never rebuilt),
// so a user's expand/collapse choices persist for the rest of the session
// instead of resetting every time renderSettingsPanels() re-syncs values.
virtualChannelPanels().forEach((p) => p.classList.add('collapsed'));

virtualChannelPanels().forEach((p) => {
  const toggle = p.querySelector('.panel-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', (e) => {
    // Let checkbox/button/input/select clicks inside the header do their
    // own thing (enable/disable the channel) without also flipping collapse.
    if (e.target.closest('input, button, select, a')) return;
    p.classList.toggle('collapsed');
  });
});

if (virtualExpandAllBtn) {
  virtualExpandAllBtn.addEventListener('click', () => {
    virtualChannelPanels().forEach((p) => p.classList.remove('collapsed'));
  });
}
if (virtualCollapseAllBtn) {
  virtualCollapseAllBtn.addEventListener('click', () => {
    virtualChannelPanels().forEach((p) => p.classList.add('collapsed'));
  });
}
if (virtualFilterInputEl) {
  virtualFilterInputEl.addEventListener('input', () => {
    const q = virtualFilterInputEl.value.trim().toLowerCase();
    virtualChannelPanels().forEach((p) => {
      if (!q) { p.classList.remove('filtered-out'); return; }
      const matches = p.textContent.toLowerCase().includes(q);
      p.classList.toggle('filtered-out', !matches);
      if (matches) p.classList.remove('collapsed');
    });
  });
}

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
  if (!S.config.network) S.config.network = { viewerEnabled: false, remoteEnabled: false };
  S.config.network.viewerEnabled = viewerEnabledEl.checked;
  saveConfigDebounced();
  viewerUrlStatusEl.textContent = `${viewerEnabledEl.checked ? 'Viewer access will start' : 'Viewer access will stop'} after RerunTV restarts.`;
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
      label.textContent = `${SERVER_LABELS[d.server] || d.server.toUpperCase()} — ${d.ip}`;
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

crtScanlinesSlider.addEventListener('input', () => {
  S.config.crtIntensity.scanlines = parseInt(crtScanlinesSlider.value, 10);
  applyCrtState();
  saveConfigDebounced();
});
crtVignetteSlider.addEventListener('input', () => {
  S.config.crtIntensity.vignette = parseInt(crtVignetteSlider.value, 10);
  applyCrtState();
  saveConfigDebounced();
});
crtGrainSlider.addEventListener('input', () => {
  S.config.crtIntensity.grain = parseInt(crtGrainSlider.value, 10);
  applyCrtState();
  saveConfigDebounced();
});
crtFlickerSlider.addEventListener('input', () => {
  S.config.crtIntensity.flicker = parseInt(crtFlickerSlider.value, 10);
  applyCrtState();
  saveConfigDebounced();
});
crtCurvatureSlider.addEventListener('input', () => {
  S.config.crtIntensity.curvature = parseInt(crtCurvatureSlider.value, 10);
  applyCrtState();
  saveConfigDebounced();
});
crtBurninSlider.addEventListener('input', () => {
  S.config.crtIntensity.burnIn = parseInt(crtBurninSlider.value, 10);
  refreshLogoBugGhost();
  saveConfigDebounced();
});
clock24El.addEventListener('change', () => {
  S.config.display.clock24 = clock24El.checked;
  saveConfigDebounced();
});
hintBarEnabledEl.addEventListener('change', () => {
  S.config.display.hintBar = hintBarEnabledEl.checked;
  applyHintBarState();
  saveConfigDebounced();
});
hintBarCompactEl.addEventListener('change', () => {
  S.config.display.hintBarCompact = hintBarCompactEl.checked;
  applyHintBarState();
  saveConfigDebounced();
});
adVolumeSlider.addEventListener('input', () => {
  S.config.adVolume = parseInt(adVolumeSlider.value, 10) / 100;
  applyVolume();
  saveConfigDebounced();
});
contentVolumeSlider.addEventListener('input', () => {
  S.config.contentVolume = parseInt(contentVolumeSlider.value, 10) / 100;
  applyVolume();
  saveConfigDebounced();
});
guideSlotsSelect.addEventListener('change', () => {
  S.config.display.guideSlots = parseInt(guideSlotsSelect.value, 10) || 3;
  saveConfigDebounced();
});
pictureModeSelect.addEventListener('change', () => {
  S.config.pictureMode = pictureModeSelect.value;
  applyPictureMode();
  saveConfigDebounced();
});
aspectModeSelect.addEventListener('change', () => {
  S.config.aspectMode = aspectModeSelect.value;
  applyAspectMode();
  if (player.videoWidth && player.videoHeight) applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  saveConfigDebounced();
});
movieModeEnabledEl.addEventListener('change', () => {
  S.config.display.movieMode = movieModeEnabledEl.checked;
  if (player.videoWidth && player.videoHeight) applyTvBezel(player.videoWidth, player.videoHeight, getChannel(S.currentNumber));
  runCoreHooks('theme-audio-refresh');
  saveConfigDebounced();
});
displayModeAspectSelect.addEventListener('change', () => {
  S.config.displayMode.aspect = displayModeAspectSelect.value;
  applyDisplayMode();
  saveConfigDebounced();
});
displayModeWindowSelect.addEventListener('change', () => {
  S.config.displayMode.windowMode = displayModeWindowSelect.value;
  applyDisplayMode();
  saveConfigDebounced();
});
displayModeResolutionSelect.addEventListener('change', () => {
  S.config.displayMode.resolution = displayModeResolutionSelect.value;
  applyDisplayMode();
  saveConfigDebounced();
});
displayModeAutoPrioritySelect.addEventListener('change', () => {
  S.config.displayMode.autoPriority = displayModeAutoPrioritySelect.value;
  applyDisplayMode();
  saveConfigDebounced();
});
crtOverlayWholeScreenEnabledEl.addEventListener('change', () => {
  S.config.crtIntensity.overlayScope = crtOverlayWholeScreenEnabledEl.checked ? 'wholeScreen' : 'video';
  applyCrtState();
  saveConfigDebounced();
});
bootPowerAnimEnabledEl.addEventListener('change', () => {
  S.config.display.bootPowerOnAnim = bootPowerAnimEnabledEl.checked;
  saveConfigDebounced();
});
guideOpenCloseAnimEnabledEl.addEventListener('change', () => {
  S.config.display.guideOpenCloseAnim = guideOpenCloseAnimEnabledEl.checked;
  refreshDependentControls();
  saveConfigDebounced();
});
guideAnimSpeedSlider.addEventListener('input', () => {
  S.config.display.guideOpenCloseAnimMs = parseInt(guideAnimSpeedSlider.value, 10);
  saveConfigDebounced();
});
hintBarSlideEnabledEl.addEventListener('change', () => {
  S.config.display.hintBarSlide = hintBarSlideEnabledEl.checked;
  hintBarShowDurationEl.disabled = !hintBarSlideEnabledEl.checked;
  hintBarHideDurationEl.disabled = !hintBarSlideEnabledEl.checked;
  applyHintBarState();
  saveConfigDebounced();
});
hintBarShowDurationEl.addEventListener('input', () => {
  S.config.display.hintBarShowDuration = parseInt(hintBarShowDurationEl.value, 10);
  hintBarShowDurationValEl.textContent = `${S.config.display.hintBarShowDuration}ms`;
  applyHintBarState();
  saveConfigDebounced();
});
hintBarHideDurationEl.addEventListener('input', () => {
  S.config.display.hintBarHideDuration = parseInt(hintBarHideDurationEl.value, 10);
  hintBarHideDurationValEl.textContent = `${S.config.display.hintBarHideDuration}ms`;
  applyHintBarState();
  saveConfigDebounced();
});
noSignalTitleInput.addEventListener('input', () => {
  S.config.display.noSignalTitle = noSignalTitleInput.value.slice(0, 48);
  saveConfigDebounced();
});
noSignalMessageInput.addEventListener('input', () => {
  S.config.display.noSignalMessage = noSignalMessageInput.value.slice(0, 120);
  saveConfigDebounced();
});
noSignalCopyReset.addEventListener('click', () => {
  S.config.display.noSignalTitle = '';
  S.config.display.noSignalMessage = '';
  noSignalTitleInput.value = '';
  noSignalMessageInput.value = '';
  saveConfigDebounced();
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
  S.config.theme = themeSelect.value;
  applyTheme();
  renderThemeBrowser();
  renderGuideGenreSettings();
  saveConfigDebounced();
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
  S.config.timeMachine.enabled = timeMachineEnabledEl.checked;
  if (!S.config.timeMachine.enabled && S.timeMachineOn) exitTimeMachine({ toLive: true });
  saveConfigDebounced();
});
upNextEnabledEl.addEventListener('change', () => {
  S.config.upNext.enabled = upNextEnabledEl.checked;
  saveConfigDebounced();
});
detailsEnabledEl.addEventListener('change', () => {
  S.config.details.enabled = detailsEnabledEl.checked;
  saveConfigDebounced();
});
stationIdEnabledEl.addEventListener('change', () => {
  S.config.stationId.enabled = stationIdEnabledEl.checked;
  saveConfigDebounced();
});
stationIdIntervalEl.addEventListener('change', () => {
  S.config.stationId.intervalMinutes = parsePositiveInt(stationIdIntervalEl.value, 15);
  saveConfigDebounced();
});
staticEnabledEl.addEventListener('change', () => {
  S.config.staticEffect.enabled = staticEnabledEl.checked;
  refreshDependentControls();
  saveConfigDebounced();
});
staticIntensitySlider.addEventListener('input', () => {
  S.config.staticEffect.intensity = parseInt(staticIntensitySlider.value, 10);
  saveConfigDebounced();
});
if (staticDurationSlider) {
  staticDurationSlider.addEventListener('input', () => {
    const ms = parseInt(staticDurationSlider.value, 10);
    S.config.staticEffect.durationMs = ms;
    if (staticDurationVal) staticDurationVal.textContent = ms === 0 ? '0ms (INSTANT)' : `${ms}ms`;
    saveConfigDebounced();
  });
}
triviaEnabledEl.addEventListener('change', () => {
  S.config.trivia.enabled = triviaEnabledEl.checked;
  saveConfigDebounced();
});
triviaIntervalEl.addEventListener('change', () => {
  S.config.trivia.intervalMinutes = parsePositiveInt(triviaIntervalEl.value, 20);
  saveConfigDebounced();
});

if (pinLockEnabledEl) pinLockEnabledEl.addEventListener('change', () => { if (!S.config.pinLock) S.config.pinLock = {}; S.config.pinLock.enabled = pinLockEnabledEl.checked; saveConfigDebounced(); });
if (pinCodeInputEl) pinCodeInputEl.addEventListener('input', () => { if (!S.config.pinLock) S.config.pinLock = {}; S.config.pinLock.code = pinCodeInputEl.value.trim() || '1234'; saveConfigDebounced(); });
if (pinCancelBtn) pinCancelBtn.addEventListener('click', hidePinLockScreen);

initFlowBuilder();


