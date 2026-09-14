// Keyboard-nav overhaul + undo/redo wiring for the setup screen — kept in
// its own module (rather than folded into setup-settings.js) since it cuts
// across every other setup-*.js module's DOM (tab bars, channel rows,
// interstitial cards) without needing to import their internals: almost
// everything here drives existing buttons via .click() so this file never
// has to duplicate what setup-channels.js/setup-interstitials.js already do
// when a mouse click hits the same element.
import { S, canUndo, canRedo, onHistoryChange, performUndo, performRedo, redoLabel, undoLabel } from './state.js';
import { setupScreen } from './dom.js';
import { renderChannelList } from './setup-channels.js';
import { renderCommercialsPanel, renderStandbyPanel } from './setup-interstitials.js';
import { renderSettingsPanels, resetSetupTabs } from './setup-settings.js';
import { openCommandPalette, closeCommandPalette, isCommandPaletteOpen, setUndoRedoHook } from './setup-command-palette.js';
import { refreshSidebarBadges } from './setup-sidebar.js';
import { enhanceTabs } from './ui/tabs.js';
import { listDetailBehavior } from './ui/list-detail.js';

// Full re-render of every setup-screen panel from S.config — used after
// undo/redo rewinds S.config (in place) under whatever's currently on screen.
// Deliberately the same five calls showSetupScreen (app.js) makes, minus the
// TV-screen teardown/breadcrumb-reset parts of it that only matter when the
// setup screen is first opening, not while it's already open and just had
// its data rewound.
export function refreshSetupScreen() {
  resetSetupTabs();
  renderChannelList();
  renderCommercialsPanel();
  renderStandbyPanel();
  renderSettingsPanels();
}

function setupVisible() {
  return !setupScreen.classList.contains('hidden');
}

// ---------- Undo/redo ----------
const undoBtn = document.getElementById('setup-undo-btn');
const redoBtn = document.getElementById('setup-redo-btn');

export function refreshUndoRedoButtons() {
  if (undoBtn) {
    undoBtn.disabled = !canUndo();
    const label = undoLabel();
    undoBtn.title = label ? `Undo: ${label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  }
  if (redoBtn) {
    redoBtn.disabled = !canRedo();
    const label = redoLabel();
    redoBtn.title = label ? `Redo: ${label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
  }
}

function doUndo() {
  if (performUndo()) { refreshSetupScreen(); refreshUndoRedoButtons(); }
}
function doRedo() {
  if (performRedo()) { refreshSetupScreen(); refreshUndoRedoButtons(); }
}

if (undoBtn) undoBtn.addEventListener('click', doUndo);
if (redoBtn) redoBtn.addEventListener('click', doRedo);
setUndoRedoHook(() => { refreshSetupScreen(); refreshUndoRedoButtons(); });

// state.js reports every history change (an edit, a settled burst, a
// dispatched command, undo/redo), so the buttons and their "Undo: …" labels
// update the moment it happens. The slow poll stays as a backstop only.
onHistoryChange(() => { if (setupVisible()) { refreshUndoRedoButtons(); refreshSidebarBadges(); } });
setInterval(() => { if (setupVisible()) refreshUndoRedoButtons(); }, 2000);
refreshUndoRedoButtons();

// ---------- Global setup-screen shortcuts ----------
const setupSearchEl = document.getElementById('setup-search');

window.addEventListener('keydown', (e) => {
  if (!setupVisible()) return;

  if (isCommandPaletteOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
    return; // the palette's own input handles everything else while open
  }

  const ctrlOrCmd = e.ctrlKey || e.metaKey;

  if (ctrlOrCmd && e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('done-btn')?.click();
    return;
  }

  if (ctrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
    return;
  }
  if (ctrlOrCmd && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo(); else doUndo();
    return;
  }
  if (ctrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    doRedo();
    return;
  }
  if (ctrlOrCmd && e.key.toLowerCase() === 'f') {
    // Typing into an input/textarea should still work normally (native
    // Ctrl+F browser find is already disabled app-wide in this Electron
    // shell) — only steal it when focus isn't already inside a text field,
    // so it always means "jump to the settings search box", not "select
    // all the text I was about to overwrite".
    if (setupSearchEl && document.activeElement !== setupSearchEl) {
      e.preventDefault();
      setupSearchEl.focus();
      setupSearchEl.select();
    }
    return;
  }
  if (e.key === 'Escape' && document.activeElement && document.activeElement !== document.body) {
    // No modal/palette is open at this point (both handled above/elsewhere)
    // — a bare Escape just backs focus out of whatever field/row it's in,
    // consistent with every other Escape handler in this app being "close
    // the thing on top" rather than a browser-native no-op.
    document.activeElement.blur();
  }
});

// ---------- Tab-bar keyboard nav (ARIA "tabs" pattern) ----------
// The kit's Tabs behaviour (ui/tabs.js) on the static bars: only the active tab
// is a Tab stop; Left/Right (Up/Down on the vertical sidebar) Home End move
// *and* activate. Other code moves .active with plain click handlers
// (setup-settings.js), which the bar re-syncs from.
function controlledPanelForTab(bar, btn) {
  if (btn.dataset.tab) return document.querySelector(`.setup-tab-panel[data-tab-panel="${btn.dataset.tab}"]`);
  if (btn.dataset.subtab) return bar.parentElement.querySelector(`:scope > .setup-subtab-panel[data-subtab-panel="${btn.dataset.subtab}"]`);
  return null;
}

const sidebarTabs = document.getElementById('setup-tabs');
enhanceTabs(sidebarTabs, { tabSelector: '.setup-tab-btn', panelFor: (btn) => controlledPanelForTab(sidebarTabs, btn) });
document.querySelectorAll('.setup-subtabs').forEach((bar) => enhanceTabs(bar, { tabSelector: '.setup-subtab-btn', panelFor: (btn) => controlledPanelForTab(bar, btn) }));

const CONTROL_LABELS = new Map([
  ['rating-select', 'Content rating'],
  ['aspect-select', 'Video aspect ratio'],
  ['resolution-select', 'Resolution override'],
  ['display-aspect-select', 'Display aspect override'],
]);

function nearbyControlLabel(control) {
  for (const className of control.classList) {
    if (CONTROL_LABELS.has(className)) return CONTROL_LABELS.get(className);
  }
  if (control.title) return control.title;
  if (control.placeholder) return control.placeholder.replace(/[….]+$/g, '').trim();
  const pluginRow = control.closest('.plugin-row');
  if (pluginRow && control.type === 'checkbox') {
    const pluginName = pluginRow.querySelector('.plugin-row-name')?.childNodes[0]?.textContent.trim();
    if (pluginName) return `Enable ${pluginName}`;
  }
  const parent = control.closest('.panel-interval, .flow-meta-field, .flow-step-field, .flow-field, .field, .block-row');
  if (!parent) return '';
  const explicit = parent.querySelector(':scope > .flow-label, :scope > label, :scope > .block-label');
  if (explicit && !explicit.contains(control)) return explicit.textContent.replace(/\s+/g, ' ').trim();
  return Array.from(parent.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function syncSetupControlNames(root = setupScreen) {
  const controls = [];
  if (root.matches && root.matches('input, select, textarea')) controls.push(root);
  if (root.querySelectorAll) controls.push(...root.querySelectorAll('input, select, textarea'));
  controls.forEach((control) => {
    if (control.type === 'hidden' || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return;
    if (control.closest('label') || (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`))) return;
    const label = nearbyControlLabel(control);
    if (label) control.setAttribute('aria-label', label);
  });
}

syncSetupControlNames();
new MutationObserver((mutations) => {
  mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) syncSetupControlNames(node);
  }));
}).observe(setupScreen, { childList: true, subtree: true });

// ---------- List roving-tabindex nav (channel rows / interstitial cards) ----------
// Up/Down/Home/End move focus between rows, Enter/Space activates the row's
// primary action (its EDIT button / summary bar — whatever activateSelector
// picks out), Delete triggers its remove button if it has one. A
// MutationObserver (rather than re-wiring after each render) means this
// keeps working no matter which module re-renders the list or when, since
// renderChannelList/renderInterstitialsList tear down and rebuild their
// rows from scratch on essentially every edit.
function enableRovingList(containerEl, rowSelector, activateSelector, deleteSelector) {
  if (!containerEl) return;

  function makeFocusable() {
    containerEl.querySelectorAll(rowSelector).forEach((row) => {
      if (!row.hasAttribute('tabindex')) row.tabIndex = 0;
    });
  }
  makeFocusable();
  new MutationObserver(makeFocusable).observe(containerEl, { childList: true });

  containerEl.addEventListener('keydown', (e) => {
    // Only steer focus when the row itself is focused — a nested input,
    // select, or button handles its own keys normally (typing, native
    // button activation on Enter/Space), never hijacked by list nav.
    if (e.target !== document.activeElement || !e.target.matches || !e.target.matches(rowSelector)) return;
    const rows = Array.from(containerEl.querySelectorAll(rowSelector));
    const idx = rows.indexOf(e.target);
    if (idx === -1) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); (rows[idx + 1] || rows[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (rows[idx - 1] || rows[rows.length - 1]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); rows[0] && rows[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); rows[rows.length - 1] && rows[rows.length - 1].focus(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const target = activateSelector ? e.target.querySelector(activateSelector) : e.target;
      if (target) target.click();
    } else if (e.key === 'Delete' && deleteSelector) {
      const target = e.target.querySelector(deleteSelector);
      if (target) { e.preventDefault(); target.click(); }
    }
  });
}

// ---------- Section jumps, J/K and Esc (docs/design/03 §7) ----------
// G then a letter opens a section. The letter lives on the sidebar button as
// data-go-key so the tooltip and this map can't disagree.
const GO_KEYS = { channels: 'c', programming: 'p', library: 'l', display: 's', guide: 'g', household: 'h', audio: 'y', plugins: 'u', help: '?' };
document.querySelectorAll('#setup-tabs .setup-tab-btn').forEach((btn) => {
  const key = GO_KEYS[btn.dataset.tab];
  if (!key) return;
  btn.dataset.goKey = key;
  btn.title = `${btn.textContent.trim()} (G then ${key.toUpperCase()})`;
});

// A list beside a detail pane (ui/list-detail.js): the wrappers, lists and
// details are marked data-ui-list-detail/-list/-detail in index.html; these
// are each collection's rows, and which one is selected.
const ROWS = '.channel-list-item, .interstitial-card-summary, .flow-list-item, .backup-list-item, .plugin-row';
const SELECTED_ROW = '.channel-list-item.selected, .interstitial-card.selected .interstitial-card-summary, .flow-list-item.selected, .backup-list-item.selected, .plugin-entry.selected .plugin-row';
const listDetail = listDetailBehavior({ rows: ROWS, selectedRow: SELECTED_ROW });
// Narrow windows (docs/design/03 §4): below 900 px a list + detail page shows
// the list, and choosing a row swaps to that row's editor with a Back button.
listDetail.install(setupScreen);

let goPendingUntil = 0;
window.addEventListener('keydown', (e) => {
  if (!setupVisible() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const active = document.activeElement;
  if (document.querySelector('.confirm-dialog')) return;

  // Esc inside a detail pane goes back to the selected row of its list.
  if (listDetail.handleEscape(e)) return;
  if (listDetail.isTypingTarget(active)) return;

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (goPendingUntil > Date.now()) { // UI gesture timing, not schedule time
    goPendingUntil = 0;
    const btn = document.querySelector(`#setup-tabs .setup-tab-btn[data-go-key="${CSS.escape(key)}"]`);
    if (btn) {
      e.preventDefault();
      btn.click();
      btn.focus();
    }
    return;
  }
  if (key === 'g' && !e.shiftKey) {
    goPendingUntil = Date.now() + 1500;
    return;
  }

  // J/K are ▼/▲ in a list. Enter on the row that is already selected opens it:
  // focus lands on the first control of its detail pane. Enter on any other row
  // selects it as before.
  listDetail.handleListKey(e, key);
}, true);

enableRovingList(document.getElementById('channel-list'), '.channel-row', '.edit-btn', '.remove-btn');
enableRovingList(document.getElementById('interstitials-list'), '.interstitial-card', '.interstitial-card-summary', '.remove-btn');
