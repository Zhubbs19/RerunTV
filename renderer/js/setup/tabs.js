// The setup screen shell: tab bar, simple/advanced view, breadcrumb + session
// resume and sub-tabs. Split out of settings.js.
import { S } from '../core/state.js';
import { installSettingDependencies } from '../ui/field.js';
import { refreshHouseholdPanel } from './household.js';
import { renderChannelList } from './channels.js';
import { renderBoxStatus } from './channels-diagnostics.js';
import { setupScreen, setupSearchEl, setupSearchResultsEl, setupSearchEmptyEl, setupBreadcrumbEl } from '../core/dom.js';
import { startPerfMonitor, stopPerfMonitor } from '../core/perf.js';
import { renderPluginsTab, reportPluginAttention } from './plugins.js';
import { refreshMissingFileBadge, refreshSidebarBadges } from './sidebar.js';
import { renderPluginDiagnostics } from '../plugin/diagnostics.js';
import { renderHelpTab } from './help.js';

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
export let settingsView = 'advanced';
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
export function setSettingsView(view, persist = true) {
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

export function isSimpleSearchTarget(target) {
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

export function closeSettingsSearch() {
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
  setupBreadcrumbEl.textContent = '';
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      setupBreadcrumbEl.appendChild(sep);
    }
    if (i === parts.length - 1) {
      const current = document.createElement('span');
      current.className = 'crumb-current';
      current.textContent = p;
      setupBreadcrumbEl.appendChild(current);
    } else {
      setupBreadcrumbEl.appendChild(document.createTextNode(p));
    }
  });
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
  refreshMissingFileBadge();
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

// The header shows a separating shadow once the page under it has scrolled.
const setupNavEl = setupScreen.querySelector('.setup-nav');
function syncSetupNavStickySurface() {
  if (!setupNavEl || !setupContentEl) return;
  setupNavEl.classList.toggle('is-stuck', setupContentEl.scrollTop > 0);
}
setupContentEl?.addEventListener('scroll', syncSetupNavStickySurface, { passive: true });
window.addEventListener('resize', syncSetupNavStickySurface);
syncSetupNavStickySurface();
