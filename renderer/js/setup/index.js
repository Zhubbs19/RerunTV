// Entry point for the setup/settings screen. The actual implementation
// lives across several sibling modules (split out of a single 2200+ line
// file — see [[retro-cable-box-code-ux-audit]]):
//   setup-util.js          shared helpers (toggleLazyPanel, parsePositiveInt, probeDuration)
//   setup-overlay-position-editor.js accessible live dynamic-overlay placement screen
//   setup-panels.js        per-channel EDIT-tab panels: TITLES, FOLDERS, ADS, LOGO, THEME
//   setup-schedule.js      the unified SCHEDULE tab (BLOCKS list + CALENDAR month view)
//   setup-channels.js      the CHANNELS tab: channel list, bulk actions, folder scanning
//   setup-interstitials.js the PROGRAMMING tab: interstitials pool, standby
//   setup-autocurate.js    PROGRAMMING > AUTO-CURATE: curation profile wizard
//   curation-scheduler.js  background auto-run for 'scheduled' curation profiles
//   setup-tagtaxonomy.js   PROGRAMMING > TAG TAXONOMY: vocabulary + rename/remove tool
//   setup-settings.js      DISPLAY/AUDIO tabs, the setup-tab bar, cross-tab search
//   setup-command-palette.js the Ctrl+K command palette
//   setup-keyboard.js      undo/redo + full keyboard-nav overhaul (tab bars, list rows)
//   setup-dragdrop.js      OS-level drag-and-drop of files from Explorer
// Each of those modules registers its own DOM event listeners at import
// time, so importing them here for their side effects is what actually
// wires up the settings screen — this file just re-exports the handful of
// functions app.js and channels.js need to call into from outside.
import './panels.js';
import './schedule.js';
import './interstitials.js';
import './autocurate.js';
import '../library/curation-scheduler.js';
import './tagtaxonomy-ui.js';
import './aircheck.js';
import '../library/sync.js';
import '../plugin/diagnostics.js';
import './settings.js';
import './channels.js';
import './command-palette.js';
import './keyboard.js';
import './dragdrop.js';

export { renderChannelList } from './channels.js';
export { renderCommercialsPanel, renderPreemptionWindowsEditor, renderStandbyPanel } from './interstitials.js';
export { renderSettingsPanels, resetSetupTabs } from './settings.js';
