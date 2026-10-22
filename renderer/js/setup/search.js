// Global settings and action search (the setup screen search box). Split out
// of settings.js.
import { S, viewNow } from '../core/state.js';
import { settingRowControl, settingRowSearchText } from '../ui/field.js';
import { searchActions } from './command-palette.js';
import { searchUpcomingPrograms } from '../guide/program-search.js';
import { formatChannelNumber } from '../core/channels.js';
import { getPluginSearchEntries } from '../plugin/host.js';
import { renderChannelList } from './channels.js';
import { setupSearchEl, setupSearchResultsEl, setupSearchEmptyEl } from '../core/dom.js';
import { openPluginFromSearch } from './plugins.js';
import { closeSettingsSearch, settingsView, isSimpleSearchTarget, setSettingsView } from './tabs.js';
import { renderSettingsPanels } from './settings.js';

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
