// Ctrl+K command palette for the setup screen. Deliberately drives existing
// buttons/inputs via .click()/.focus() rather than importing and calling
// each module's internal handlers directly — every command below already
// has a real, working UI control wired up elsewhere (setup-channels.js,
// setup-interstitials.js, setup-settings.js), so reusing it means this file
// can't drift out of sync with what those buttons actually do.
import { canUndo, canRedo, performUndo, performRedo } from './state.js';

const paletteEl = document.getElementById('command-palette');
const inputEl = document.getElementById('command-palette-input');
const resultsEl = document.getElementById('command-palette-results');

let activeIndex = 0;
let filtered = [];
// Set by setup-keyboard.js after undo/redo runs, so a redo/undo triggered
// from inside the palette itself (its own Undo/Redo entries below) still
// re-renders the setup screen the same way the toolbar buttons do — kept as
// an injected callback instead of importing setup-keyboard.js, which
// imports this file, to avoid a circular import.
let onUndoRedo = () => {};
export function setUndoRedoHook(fn) { onUndoRedo = fn; }

function click(id) {
  return () => { const el = document.getElementById(id); if (el) el.click(); };
}

// Clicks a top-level tab, then (if given) a sub-tab button within it —
// letting a single command jump straight to e.g. PROGRAMMING › Interstitials
// Pool instead of landing on whichever sub-tab was last open there.
function goToTab(tabId, subtabBtn) {
  return () => {
    const tabBtn = document.querySelector(`.setup-tab-btn[data-tab="${tabId}"]`);
    if (tabBtn) tabBtn.click();
    if (subtabBtn) subtabBtn.click();
  };
}

function staticCommands() {
  const cmds = [
    { label: 'Go to CHANNELS', hint: 'TAB', run: goToTab('channels') },
    { label: 'Go to DISPLAY', hint: 'TAB', run: goToTab('display') },
    { label: 'Go to PROGRAMMING', hint: 'TAB', run: goToTab('programming') },
    { label: 'Go to AUDIO & SYSTEM', hint: 'TAB', run: goToTab('audio') },
    { label: 'Go to PERFORMANCE', hint: 'TAB', run: goToTab('perf') },
    { label: 'Go to HELP', hint: 'TAB', run: goToTab('help') },
    { label: 'Add channel', hint: 'CHANNELS', run: click('add-channel-btn') },
    { label: 'Check channel health', hint: 'CHANNELS', run: click('health-check-btn') },
    { label: 'Search channel library', hint: 'CHANNELS', run: click('library-search-toggle-btn') },
    { label: 'Show NOW/NEXT dashboard', hint: 'CHANNELS', run: click('now-next-toggle-btn') },
    { label: 'Select channels (bulk actions)', hint: 'CHANNELS', run: click('bulk-select-toggle-btn') },
    { label: 'Add interstitial pool entry', hint: 'PROGRAMMING', run: click('interstitials-add-entry-btn') },
    { label: 'Add interstitial pool folder', hint: 'PROGRAMMING', run: click('interstitials-add-folder-btn') },
    { label: 'Refresh config backups', hint: 'AUDIO & SYSTEM', run: click('backups-refresh-btn') },
    { label: 'Export config…', hint: 'FILE', run: click('config-export-btn') },
    { label: 'Import config…', hint: 'FILE', run: click('config-import-btn') },
    { label: 'Restore channels from disk', hint: 'FILE', run: click('config-restore-auto-btn') },
    { label: 'Focus settings search', hint: 'CTRL+F', run: () => { const el = document.getElementById('setup-search'); if (el) { el.focus(); el.select(); } } },
    { label: 'Start watching (exit setup)', hint: 'DONE', run: click('done-btn') },
  ];
  cmds.push({
    label: 'Undo', hint: 'CTRL+Z', disabled: !canUndo(),
    run: () => { if (performUndo()) onUndoRedo(); },
  });
  cmds.push({
    label: 'Redo', hint: 'CTRL+SHIFT+Z', disabled: !canRedo(),
    run: () => { if (performRedo()) onUndoRedo(); },
  });
  // Every sub-tab currently in the DOM, labeled "Parent Tab › Sub Tab" —
  // built fresh each time the palette opens rather than hardcoded, so a
  // sub-tab added later (a new .setup-subtabs bar in index.html) shows up
  // here automatically instead of needing this file edited too.
  document.querySelectorAll('.setup-tab-panel').forEach((panel) => {
    const tabId = panel.dataset.tabPanel;
    const tabBtn = document.querySelector(`.setup-tab-btn[data-tab="${tabId}"]`);
    if (!tabBtn) return;
    panel.querySelectorAll('.setup-subtab-btn').forEach((subBtn) => {
      cmds.push({
        label: `Go to ${tabBtn.textContent.trim()} › ${subBtn.textContent.trim()}`,
        hint: 'SUBTAB',
        run: goToTab(tabId, subBtn),
      });
    });
  });
  return cmds;
}

function render() {
  resultsEl.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'command-palette-empty';
    empty.textContent = 'NO MATCHING COMMANDS';
    resultsEl.appendChild(empty);
    return;
  }
  filtered.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = 'command-palette-item' + (i === activeIndex ? ' active' : '');
    item.setAttribute('role', 'option');
    if (cmd.disabled) item.style.opacity = '0.4';
    const label = document.createElement('span');
    label.className = 'command-palette-item-label';
    label.textContent = cmd.label;
    const hint = document.createElement('span');
    hint.className = 'command-palette-item-hint';
    hint.textContent = cmd.hint || '';
    item.appendChild(label);
    item.appendChild(hint);
    item.addEventListener('mousedown', (e) => { e.preventDefault(); runCommand(cmd); });
    item.addEventListener('mousemove', () => { activeIndex = i; render(); });
    resultsEl.appendChild(item);
  });
}

function runCommand(cmd) {
  if (!cmd || cmd.disabled) return;
  closeCommandPalette();
  cmd.run();
}

function applyFilter() {
  const q = inputEl.value.trim().toLowerCase();
  const all = staticCommands();
  filtered = q ? all.filter((c) => c.label.toLowerCase().includes(q) || (c.hint || '').toLowerCase().includes(q)) : all;
  activeIndex = 0;
  render();
}

export function isCommandPaletteOpen() {
  return paletteEl && !paletteEl.classList.contains('hidden');
}

export function openCommandPalette() {
  if (!paletteEl) return;
  paletteEl.classList.remove('hidden');
  inputEl.value = '';
  applyFilter();
  inputEl.focus();
}

export function closeCommandPalette() {
  if (!paletteEl) return;
  paletteEl.classList.add('hidden');
}

if (paletteEl) {
  inputEl.addEventListener('input', applyFilter);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, filtered.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); runCommand(filtered[activeIndex]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
  });
  // Click on the dimmed backdrop closes it, same convention as preview-modal.
  paletteEl.addEventListener('mousedown', (e) => { if (e.target === paletteEl) closeCommandPalette(); });

  const openBtn = document.getElementById('setup-command-palette-btn');
  if (openBtn) openBtn.addEventListener('click', openCommandPalette);
}
