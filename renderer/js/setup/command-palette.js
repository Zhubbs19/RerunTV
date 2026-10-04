// Actions for the setup screen's one search (docs/design/03 §6). There used to
// be a separate Ctrl+K palette overlay next to the header's settings search;
// both now live in the header search, and this file only supplies the ACTIONS
// group and opens that search.
//
// Actions deliberately drive existing buttons via .click() rather than
// importing each module's internal handlers — every action below already has
// a real, working control wired up elsewhere (setup-channels.js,
// setup-interstitials.js, setup-settings.js), so reusing it means this file
// can't drift out of sync with what those buttons actually do.
import { canUndo, canRedo, performUndo, performRedo, redoLabel, undoLabel } from '../core/state.js';

// Set by setup-keyboard.js after undo/redo runs, so undo/redo chosen from the
// search still re-renders the setup screen the same way the toolbar buttons
// do — an injected callback instead of importing setup-keyboard.js, which
// imports this file.
let onUndoRedo = () => {};
export function setUndoRedoHook(fn) { onUndoRedo = fn; }

function click(id) {
  return () => { const el = document.getElementById(id); if (el) el.click(); };
}

// Clicks a top-level tab, then (if given) a sub-tab button within it.
function goToTab(tabId, subtabBtn) {
  return () => {
    const tabBtn = document.querySelector(`.setup-tab-btn[data-tab="${tabId}"]`);
    if (tabBtn) tabBtn.click();
    if (subtabBtn) subtabBtn.click();
  };
}

// { label, hint, run, disabled?, keywords? } — hint names where it happens.
export function searchActions() {
  const actions = [
    { label: 'Add channel', hint: 'CHANNELS', run: click('add-channel-btn') },
    { label: 'Check channel health', hint: 'CHANNELS', run: click('health-check-btn'), keywords: 'missing files broken' },
    { label: 'Search the media library', hint: 'CHANNELS', run: click('library-search-toggle-btn'), keywords: 'find episode file' },
    { label: 'Show what’s on now and next', hint: 'CHANNELS', run: click('now-next-toggle-btn'), keywords: 'dashboard now next' },
    { label: 'Select all channels', hint: 'CTRL+A IN THE LIST', run: () => window.dispatchEvent(new CustomEvent('reruntv:select-all-channels')), keywords: 'bulk multiple several' },
    { label: 'Rescan all folders', hint: 'CHANNELS', run: click('rescan-all-btn'), keywords: 'refresh scan' },
    { label: 'Add an ad pool entry', hint: 'PROGRAMMING', run: click('interstitials-add-entry-btn'), keywords: 'commercial bumper interstitial' },
    { label: 'Add an ad pool folder', hint: 'PROGRAMMING', run: click('interstitials-add-folder-btn'), keywords: 'commercial bumper interstitial' },
    { label: 'Add an ad preset', hint: 'PROGRAMMING', run: click('presets-add-btn') },
    { label: 'Install a plugin from ZIP', hint: 'PLUG-INS', run: click('plugins-install-zip-btn') },
    { label: 'Run a health check', hint: 'SYSTEM', run: click('box-status-check-btn') },
    { label: 'Check for updates', hint: 'SYSTEM', run: click('check-updates-btn'), keywords: 'upgrade version' },
    { label: 'Snapshot the config now', hint: 'SYSTEM', run: click('backups-snapshot-now-btn'), keywords: 'backup' },
    { label: 'Export config…', hint: 'SYSTEM', run: click('config-export-btn'), keywords: 'backup save file' },
    { label: 'Import config…', hint: 'SYSTEM', run: click('config-import-btn'), keywords: 'restore load file' },
    { label: 'Export settings only…', hint: 'SYSTEM', run: click('settings-export-btn'), keywords: 'look controls options no channels second machine' },
    { label: 'Import settings only…', hint: 'SYSTEM', run: click('settings-import-btn'), keywords: 'look controls options no channels second machine' },
    { label: 'Import a channel…', hint: 'SYSTEM', run: click('channel-import-btn') },
    { label: 'Restore channels from disk', hint: 'SYSTEM', run: click('config-restore-auto-btn'), keywords: 'recover reload' },
    { label: 'Start watching', hint: 'CTRL+ENTER', run: click('done-btn'), keywords: 'watch tv exit done' },
    {
      label: undoLabel() ? `Undo: ${undoLabel()}` : 'Undo', hint: 'CTRL+Z', disabled: !canUndo(),
      run: () => { if (performUndo()) onUndoRedo(); },
    },
    {
      label: redoLabel() ? `Redo: ${redoLabel()}` : 'Redo', hint: 'CTRL+SHIFT+Z', disabled: !canRedo(),
      run: () => { if (performRedo()) onUndoRedo(); },
    },
  ];
  // Every section and sub-tab, built from the DOM so a new one is findable
  // without editing this file.
  document.querySelectorAll('.setup-tab-panel').forEach((panel) => {
    const tabId = panel.dataset.tabPanel;
    const tabBtn = document.querySelector(`.setup-tab-btn[data-tab="${tabId}"]`);
    if (!tabBtn) return;
    actions.push({ label: `Go to ${tabBtn.textContent.trim()}`, hint: 'SECTION', run: goToTab(tabId) });
    panel.querySelectorAll('.setup-subtab-btn').forEach((subBtn) => {
      actions.push({ label: `Go to ${tabBtn.textContent.trim()} › ${subBtn.textContent.trim()}`, hint: 'SECTION', run: goToTab(tabId, subBtn) });
    });
  });
  return actions;
}

// Ctrl+K and the status bar's SEARCH button: focus the header search, which
// lists actions until something is typed (setup-settings.js).
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent('reruntv:open-setup-search'));
}

// Kept for setup-keyboard.js: there is no separate overlay any more.
export function isCommandPaletteOpen() {
  return false;
}
export function closeCommandPalette() {}

document.getElementById('setup-command-palette-btn')?.addEventListener('click', openCommandPalette);
