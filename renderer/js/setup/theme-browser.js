// Theme picker pieces: theme group ordering, the inline theme font settings,
// guide genre colours and the theme browser overlay. Split out of settings.js.
import { applyTheme } from '../display/themes.js';
import { S, dispatch } from '../core/state.js';
import { themePackEntries } from '../plugin/host.js';
import { themeCheckBadge, themeCheckResult } from '../display/theme-check.js';
import { Badge } from '../ui/button.js';
import { DEFAULT_GUIDE_GENRES, defaultGuideGenreColor, guideGenreThemeConfig, normalizeGuideGenre } from '../guide/genres.js';
import { renderThemeFontSettings } from './plugin-settings.js';
import { themeSelect, themeBrowserToggle, themeBrowserCurrentLabel, themeBrowserEl, themeBrowserSearch, themeBrowserClose, themeBrowserGroups, themeBrowserEmpty } from '../core/dom.js';

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
export const THEME_GROUP_ORDER = ['ERA (BY DECADE)', 'REAL CABLE-BOX UI', 'BROADCAST/STUDIO', 'STYLIZED'];

// Surfaces the same THEME TYPOGRAPHY control PLUGINS > [theme] > SETTINGS
// already has (renderThemeFontSettings, setup-plugin-settings.js) right next
// to the theme picker itself — customizing the theme you're looking at
// shouldn't require knowing it's really a plugin under the hood and finding
// its settings panel on a different tab. Re-render on every theme switch
// since the override values shown are per-theme.
export function renderThemeFontSettingsInline() {
  const container = document.getElementById('display-theme-font-settings');
  if (!container) return;
  renderThemeFontSettings(container, S.config.theme || 'digital-2000s');
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

export function renderGuideGenreSettings() {
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

export function renderThemeBrowser() {
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
