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
onHistoryChange(() => { if (setupVisible()) refreshUndoRedoButtons(); });
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
// Roving tabindex: only the active tab in each bar is a normal Tab stop;
// Left/Right/Home/End move *and* activate, matching how every native OS
// tab strip behaves. Wired once per bar since the top-level bar and every
// .setup-subtabs bar are static markup (setup.css/index.html), never
// rebuilt — only which button carries .active changes.
let generatedA11yId = 0;
function ensureA11yId(el, prefix) {
  if (!el.id) {
    generatedA11yId += 1;
    el.id = `${prefix}-${generatedA11yId}`;
  }
  return el.id;
}

function controlledPanelForTab(bar, btn) {
  if (btn.dataset.tab) return document.querySelector(`.setup-tab-panel[data-tab-panel="${btn.dataset.tab}"]`);
  if (btn.dataset.subtab) return bar.parentElement.querySelector(`:scope > .setup-subtab-panel[data-subtab-panel="${btn.dataset.subtab}"]`);
  return null;
}

function enableTabBarKeyboardNav(bar, btnSelector) {
  const btns = () => Array.from(bar.querySelectorAll(btnSelector)).filter((btn) => !btn.classList.contains('workspace-hidden'));
  bar.setAttribute('role', 'tablist');
  btns().forEach((btn) => {
    btn.setAttribute('role', 'tab');
    const panel = controlledPanelForTab(bar, btn);
    if (!panel) return;
    const tabId = ensureA11yId(btn, 'setup-tab');
    const panelId = ensureA11yId(panel, 'setup-tabpanel');
    btn.setAttribute('aria-controls', panelId);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabId);
  });

  function syncRovingTabindex() {
    const all = btns();
    const active = all.find((b) => b.classList.contains('active')) || all[0];
    all.forEach((b) => {
      b.setAttribute('aria-selected', String(b === active));
      b.tabIndex = b === active ? 0 : -1;
    });
  }
  syncRovingTabindex();
  // .active moves in response to plain click handlers elsewhere (setup-
  // settings.js) with no shared event to hook — cheapest correct option is
  // re-syncing on every click bubbling through this bar.
  bar.addEventListener('click', syncRovingTabindex);

  bar.addEventListener('keydown', (e) => {
    const all = btns();
    const idx = all.indexOf(document.activeElement);
    if (idx === -1) return;
    let target = null;
    if (e.key === 'ArrowRight') target = all[(idx + 1) % all.length];
    else if (e.key === 'ArrowLeft') target = all[(idx - 1 + all.length) % all.length];
    else if (e.key === 'Home') target = all[0];
    else if (e.key === 'End') target = all[all.length - 1];
    if (!target) return;
    e.preventDefault();
    target.focus();
    target.click();
  });
}

enableTabBarKeyboardNav(document.getElementById('setup-tabs'), '.setup-tab-btn');
document.querySelectorAll('.setup-subtabs').forEach((bar) => enableTabBarKeyboardNav(bar, '.setup-subtab-btn'));

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

enableRovingList(document.getElementById('channel-list'), '.channel-row', '.edit-btn', '.remove-btn');
enableRovingList(document.getElementById('interstitials-list'), '.interstitial-card', '.interstitial-card-summary', '.remove-btn');
