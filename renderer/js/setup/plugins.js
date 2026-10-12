// The PLUGINS tab: custom CSS (a single user stylesheet applied live) and
// the installed-plugins list (see main-plugins.js/plugins.js for the loader
// itself — this module is just the setup-screen UI on top of it).
import {
  customCssChooseBtn, customCssPathEl, customCssRemoveBtn,
  pluginsCategoryTabsEl, pluginsEmptyEl, pluginsFilterEmptyEl, pluginsFilterInputEl, pluginsInstallZipBtn, pluginsListEl,
  pluginsOpenFolderBtn, pluginsRescanBtn, pluginsResultsCountEl, pluginsSaveBtn, pluginsSaveStatusEl,
  pluginsStateFilterEl, pluginsSummaryEl,
} from '../core/dom.js';
import { alertDialog, confirmDialog } from './dialogs.js';
import {
  applyCustomCss,
  getPluginChannelType,
  getPluginSettingsSections,
  reloadPlugin,
} from '../plugin/host.js';
import { S, applyHostUpdate, commitInPlace } from '../core/state.js';
import { renderPluginSettings } from './plugin-settings.js';

// Set right before a renderPluginsList() triggered by an approve/revoke, so
// that row gets a brief highlight flash instead of silently reappearing —
// reuses the same flash keyframe as the schedule's block-row-flash.
let lastCapabilityChangedId = null;

function renderCustomCssRow() {
  const path = S.config.display && S.config.display.customCssPath;
  customCssPathEl.textContent = path || 'NO CUSTOM CSS LOADED';
  customCssPathEl.classList.toggle('is-set', !!path);
  customCssRemoveBtn.classList.toggle('hidden', !path);
}

if (customCssChooseBtn) {
  customCssChooseBtn.addEventListener('click', async () => {
    const path = await window.api.selectCss();
    if (!path) return;
    S.config.display.customCssPath = path;
    renderCustomCssRow();
    applyCustomCss();
    commitInPlace({ type: 'settings.set', path: ['display','customCssPath'], value: path });
  });
}

if (customCssRemoveBtn) {
  customCssRemoveBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({ message: 'Remove the custom stylesheet? The UI reverts to the built-in theme immediately.', danger: false, confirmText: 'REMOVE' }))) return;
    S.config.display.customCssPath = null;
    renderCustomCssRow();
    applyCustomCss();
    commitInPlace({ type: 'settings.set', path: ['display','customCssPath'], value: null }, { label: 'Remove custom stylesheet' });
  });
}

// Plugin count keeps growing (24+ as of 2026-08-17, was a handful when this
// tab was first built) — a flat unsorted list with no way to find a
// specific one or tell installed-but-broken apart from working-but-off
// stopped scaling. Three changes address that without a redesign: (1)
// broken plugins (manifest error or a renderer/main load error) sort to the
// very top, since they're the ones most likely to need attention; (2) a
// live text filter (name/id/description/dependency, same `.filtered-out`
// convention the Virtual Channels sub-tab already uses — see
// setup-settings.js) makes "find the one I'm looking for" a type-ahead
// instead of a scroll; (3) each row now shows its own dependsOn status
// inline (previously nothing surfaced this at all) and dims when disabled, so enabled/disabled/broken/dependent
// are all visible at a glance without expanding anything.
function sortPluginsForDisplay(plugins) {
  return [...plugins].sort((a, b) => {
    const aBroken = a.error || a.loadError ? 0 : 1;
    const bBroken = b.error || b.loadError ? 0 : 1;
    if (aBroken !== bBroken) return aBroken - bBroken;
    return (a.name || a.dir || '').localeCompare(b.name || b.dir || '');
  });
}

// Human-readable line per declared capability, for the approval prompt —
// one line per manifest.json capabilities.ipc/spawn/net/mediaSource/system
// entry, each already carrying its own author-supplied `why`.
function formatCapabilityLines(caps) {
  const lines = [];
  (caps.ipc || []).forEach((e) => lines.push(`Talk to the app internally as "${e.channel}" — ${e.why}`));
  (caps.spawn || []).forEach((e) => lines.push(`Run "${e.bin}" as a separate program — ${e.why}`));
  (caps.net || []).forEach((e) => lines.push(`Open network port ${e.port} — ${e.why}`));
  (caps.mediaSource || []).forEach((e) => lines.push(`Supply channel media as a source named "${e.displayName || e.providerId}" — ${e.why}`));
  (caps.system || []).forEach((e) => lines.push(`Use the system action "${e.action}" — ${e.why}`));
  return lines;
}

// Shows what a plugin's *current* manifest declares and asks the user to
// approve it before it's allowed to activate (see buildCheckedCtx,
// main-plugins.js — an unapproved plugin is skipped at boot the same way a
// disabled one is). Approval is keyed to the exact declared capabilities
// (JSON.stringify of the same normalized shape main-plugins.js computes),
// so a later plugin update that adds a new port/channel/binary re-prompts
// instead of silently inheriting a stale approval.
async function promptCapabilityApproval(p) {
  const lines = formatCapabilityLines(p.capabilities);
  const body = lines.length
    ? lines.map((l) => `• ${l}`).join('\n')
    : '(This plugin declares no special capabilities.)';
  const message = `${p.name} wants to:\n\n${body}\n\nApprove these permissions? You'll need to restart the app afterward for ${p.name} to activate.`;
  const approved = await confirmDialog({ title: 'PLUGIN PERMISSIONS', message, danger: false, confirmText: 'APPROVE' });
  if (!approved) return;
  const signature = JSON.stringify(p.capabilities);
  // The host applies this as a command (main/config-host.js) and hands the
  // same update back, so S.config matches straight away and no later save
  // can revert it — the old hand-mirroring of each field is no longer needed.
  const approval = await window.api.pluginsApproveCapabilities(p.id, signature);
  applyHostUpdate(approval && approval.hostUpdate);
  await alertDialog(`Approved — restart the app to activate ${p.name}.`, { title: 'RESTART NEEDED' });
  lastCapabilityChangedId = p.id;
  renderPluginsList();
}

// Undo-approval counterpart — clears the stored signature so the plugin
// falls back to needing a fresh approval (same inactive treatment as never
// approving it, or as disabling it) until approved again.
async function revokeCapabilityApproval(p) {
  const ok = await confirmDialog({
    title: 'REVOKE PLUGIN PERMISSIONS',
    message: `Revoke ${p.name}'s approved permissions? It will stop activating (same as disabling it) until permissions are approved again. You'll need to restart the app for this to take effect.`,
    danger: false,
    confirmText: 'REVOKE',
  });
  if (!ok) return;
  const revoked = await window.api.pluginsRevokeCapabilities(p.id);
  applyHostUpdate(revoked && revoked.hostUpdate);
  await alertDialog(`Revoked — restart the app for ${p.name} to stop activating.`, { title: 'RESTART NEEDED' });
  lastCapabilityChangedId = p.id;
  renderPluginsList();
}

// Permanently deletes a plugin's own folder — genuinely destructive (no undo
// short of reinstalling), hence its own danger-styled confirm dialog
// distinct from the plain disable-toggle's confirm. Refused server-side for
// a bundled plugin (main-plugins.js's uninstallPlugin) since it would just
// reappear on the next boot; the button itself is already hidden for those
// (see the p.bundled check in renderPluginsList) so this only ever fires for
// a genuinely removable third-party install.
function uninstallButton(p) {
  const uninstallBtn = document.createElement('button');
  uninstallBtn.type = 'button';
  uninstallBtn.className = 'btn btn-danger';
  uninstallBtn.textContent = 'FULLY UNINSTALL';
  uninstallBtn.addEventListener('click', () => confirmUninstallPlugin(p));
  return uninstallBtn;
}

// Staged enable/disable changes live at module scope so a re-render (RESCAN, a
// capability approval, an install) does not silently drop checkbox changes the
// user has not saved yet. Cleared when saved; pruned of plugins that vanished.
const pendingPluginChanges = new Map();

async function confirmUninstallPlugin(p) {
  p = { ...p, name: p.name || p.dir, id: p.id || p.dir }; // a plugin that failed to load has no id/name, only its folder
  const ok = await confirmDialog({
    title: 'UNINSTALL PLUGIN',
    message: `Permanently delete ${p.name} from disk? This removes its files entirely — not just disables it — and can't be undone. You'll need to restart the app afterward.`,
    danger: true,
    confirmText: 'UNINSTALL',
  });
  if (!ok) return;
  const result = await window.api.pluginsUninstall(p.id);
  if (!result || !result.success) {
    await alertDialog((result && result.error) || `Couldn't uninstall ${p.name}.`, { variant: 'error', title: 'COULD NOT UNINSTALL' });
    return;
  }
  applyHostUpdate(result.hostUpdate);
  await alertDialog(`${p.name} uninstalled — restart the app for this to fully take effect.`, { title: 'RESTART NEEDED' });
  renderPluginsList();
}

// Whether a plugin's manifest declares anything requiring approval at all —
// mirrors main-plugins.js's loadMainPlugins() hasAnyCapability check exactly
// (same four arrays, same truthiness test) so this stays in lockstep with
// what actually gates activation there.
function hasAnyCapability(caps) {
  return !!(caps && (caps.ipc.length || caps.spawn.length || caps.net.length || caps.mediaSource.length
    || (caps.system && caps.system.length)));
}

// Recomputes approval state fresh from S.config on every render, rather than
// trusting p.needsApproval (a one-time snapshot loadMainPlugins() took at
// app boot, main.js's pluginsNeedingApproval) — that snapshot only updates
// on restart, so relying on it left the REVIEW & APPROVE button visibly
// stuck showing right after a user had just approved (or revoked) in this
// same session, even though S.config already reflects the change. Actual
// activation still genuinely needs a restart either way; this only affects
// what the row displays right now.
function permissionState(p) {
  if (!hasAnyCapability(p.capabilities)) return 'none';
  const signature = JSON.stringify(p.capabilities);
  const approved = S.config.plugins.approvedCapabilities || {};
  return approved[p.id] === signature ? 'approved' : 'needs-approval';
}

function updateSummary(plugins) {
  if (!pluginsSummaryEl) return;
  if (!plugins.length) { pluginsSummaryEl.textContent = ''; return; }
  const disabledIds = S.config.plugins.disabled || [];
  const errorCount = plugins.filter((p) => p.error || p.loadError).length;
  const attentionCount = plugins.filter(needsAttention).length;
  const enabledCount = plugins.filter((p) => !p.error && !disabledIds.includes(p.id)).length;
  const bits = [`${enabledCount} of ${plugins.length} enabled`];
  if (errorCount) bits.push(`${errorCount} with errors`);
  else if (attentionCount) bits.push(`${attentionCount} need attention`);
  pluginsSummaryEl.textContent = bits.join(' · ').toUpperCase();
}

// Category is an optional manifest field (see PLUGIN_DEVELOPMENT.md) — a
// pure grouping hint for this UI, nothing behavioral keys off it. Anything
// missing/unrecognized (including every third-party plugin that predates
// this field, or just never sets it) falls into 'other' rather than being
// dropped or erroring. 'theme' split out from 'onscreen' once the theme+
// border pack migration alone accounted for close to a third of all
// installed plugins (9 of 33) — otherwise-identical rows (no SETTINGS
// button, no dependsOn) that just buried the rest of ON-SCREEN in scroll.
const CATEGORY_LABELS = {
  channel: 'CHANNELS', theme: 'THEMES', onscreen: 'ON-SCREEN', system: 'SYSTEM', other: 'OTHER',
};
const CATEGORY_ORDER = ['channel', 'theme', 'onscreen', 'system', 'other'];
function effectiveCategory(p) {
  return CATEGORY_LABELS[p.category] ? p.category : 'other';
}

function needsAttention(p) {
  if (p.error || p.loadError || p.needsIntegrityApproval) return true;
  if (!p.error && permissionState(p) === 'needs-approval') return true;
  return (p.dependsOn || []).some((depId) => {
    const allPlugins = currentPluginsForAttention;
    const dependency = allPlugins.find((other) => other.id === depId);
    return !dependency || dependency.error || (S.config.plugins.disabled || []).includes(depId);
  });
}

// Splits needsAttention's reasons into "actually broken" (an error, a
// tampered/unapproved integrity change, a missing/disabled dependency) vs.
// "just hasn't had its permissions approved yet" — a routine one-time step
// every plugin with any capability goes through, including every built-in
// one RerunTV ships and maintains itself. A brand-new install can otherwise
// show a dozen identical red ATTENTION badges before anything is actually
// wrong, which reads as "half this app is broken" rather than "review these
// once." Reserve ATTENTION's urgency for the reasons that actually warrant
// it; this one gets its own calmer badge.
function isOnlyUnapprovedPermissions(p) {
  if (p.error || p.loadError || p.needsIntegrityApproval) return false;
  if (permissionState(p) !== 'needs-approval') return false;
  return !(p.dependsOn || []).some((depId) => {
    const allPlugins = currentPluginsForAttention;
    const dependency = allPlugins.find((other) => other.id === depId);
    return !dependency || dependency.error || (S.config.plugins.disabled || []).includes(depId);
  });
}

let currentPluginsForAttention = [];

// The plugin whose details and settings fill the detail pane. Kept across
// renderPluginsList() rebuilds (RESCAN, approve/revoke, a save) so the pane
// doesn't jump back to the top of the list. Session-only UI state.
let selectedPluginId = null;

// One line for the plugin list (docs/design/03 §5.5): the manifest's summary,
// else the description's first sentence, capped. The full description stays
// in the detail pane.
export function pluginSummary(p) {
  const source = (p.summary || p.description || '').trim();
  if (!source) return '';
  const first = p.summary ? source : source.split(/(?<=[.!?])\s+(?=[A-Z])|\s+—\s+/)[0];
  return first.length > 110 ? `${first.slice(0, 107).trimEnd()}…` : first;
}

function pluginEntries() {
  return Array.from(pluginsListEl.querySelectorAll('.plugin-entry'));
}

// Shows one entry's detail element in the pane and marks its row selected.
// The detail is built once per render and parked on the entry, so moving the
// selection never loses a half-edited settings field in another plugin.
function selectPluginEntry(entry, { focus = false } = {}) {
  const detailEl = document.getElementById('plugins-detail');
  selectedPluginId = entry ? entry.dataset.pluginId : null;
  pluginEntries().forEach((item) => {
    const on = item === entry;
    item.classList.toggle('selected', on);
    const row = item.querySelector('.plugin-row');
    row.setAttribute('aria-selected', String(on));
    row.tabIndex = on ? 0 : -1;
  });
  if (!detailEl) return;
  detailEl.replaceChildren();
  if (!entry) return;
  detailEl.appendChild(entry.pluginDetail);
  if (entry.showPluginSettings) entry.showPluginSettings();
  if (focus) entry.querySelector('.plugin-row').focus();
}

function ensureVisibleSelection() {
  const visible = pluginEntries().filter((entry) => !entry.classList.contains('filtered-out'));
  const current = visible.find((entry) => entry.dataset.pluginId === selectedPluginId);
  const already = document.getElementById('plugins-detail')?.firstChild;
  if (current && already === current.pluginDetail) return;
  selectPluginEntry(current || visible[0] || null);
}

pluginsListEl?.addEventListener('keydown', (event) => {
  if (!event.target.classList?.contains('plugin-row')) return;
  const rows = pluginEntries().filter((entry) => !entry.classList.contains('filtered-out'));
  const index = rows.findIndex((entry) => entry.dataset.pluginId === selectedPluginId);
  let target = null;
  if (event.key === 'ArrowDown') target = rows[index + 1];
  else if (event.key === 'ArrowUp') target = rows[index - 1];
  else if (event.key === 'Home') target = rows[0];
  else if (event.key === 'End') target = rows[rows.length - 1];
  else if (event.key === ' ' || event.key === 'Enter') {
    const checkbox = event.target.querySelector('input[type=checkbox]');
    if (checkbox && event.key === ' ') { event.preventDefault(); checkbox.click(); }
    return;
  }
  if (!target) return;
  event.preventDefault();
  selectPluginEntry(target, { focus: true });
});

async function promptIntegrityApproval(p) {
  const changed = p.integrityStatus === 'modified';
  const message = `${p.name}'s files are ${changed ? 'different from the last trusted install' : 'not from a recorded ZIP install'}.\n\nRenderer JavaScript and CSS run inside RerunTV's UI and can read or change anything visible there. Main-process isolation does not sandbox renderer code.\n\nCurrent SHA-256: ${p.integrityHash}\n\nOnly trust this exact version if you know where it came from.`;
  const approved = await confirmDialog({
    title: changed ? 'PLUGIN FILES CHANGED' : 'TRUST PLUGIN FILES',
    message,
    danger: true,
    confirmText: 'TRUST THIS VERSION',
  });
  if (!approved) return;
  await window.api.pluginsApproveIntegrity(p.id, p.integrityHash);
  await alertDialog(`This exact version of ${p.name} is trusted. Restart RerunTV to load it.`, { title: 'RESTART NEEDED' });
  lastCapabilityChangedId = p.id;
  renderPluginsList();
}

let activeCategory = null;
let pluginsRender = Promise.resolve();

// Opens Plug-ins on one plugin (from the setup search), clearing any filter
// that would hide it, and scrolls to one of its settings sections if given.
export async function openPluginFromSearch(pluginId, sectionId = null) {
  selectedPluginId = pluginId;
  activeCategory = 'all';
  if (pluginsFilterInputEl) pluginsFilterInputEl.value = '';
  if (pluginsStateFilterEl) pluginsStateFilterEl.value = 'all';
  document.querySelector('.setup-tab-btn[data-tab="plugins"]')?.click();
  document.querySelector('[data-tab-panel="plugins"] .setup-subtab-btn[data-subtab="installed"]')?.click();
  await pluginsRender;
  const entry = pluginEntries().find((item) => item.dataset.pluginId === pluginId);
  if (!entry) return;
  selectPluginEntry(entry);
  const target = (sectionId && entry.pluginDetail.querySelector(`.plugin-settings-section[data-section-id="${CSS.escape(sectionId)}"]`)) || entry.pluginDetail;
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('search-target-flash');
    void target.offsetWidth;
    target.classList.add('search-target-flash');
    setTimeout(() => target.classList.remove('search-target-flash'), 1200);
  });
  entry.querySelector('.plugin-row')?.focus({ preventScroll: true });
}

function renderCategoryTabs(plugins) {
  if (!pluginsCategoryTabsEl) return;
  const counts = {};
  plugins.forEach((p) => {
    const cat = effectiveCategory(p);
    counts[cat] = (counts[cat] || 0) + 1;
  });
  const present = CATEGORY_ORDER.filter((cat) => counts[cat] > 0);
  currentPluginsForAttention = plugins;
  const attentionCount = plugins.filter(needsAttention).length;
  // Tabs aren't worth showing at all for a small/single-category install —
  // only third-party-heavy or fully-loaded setups actually benefit from
  // the split.
  if (present.length < 2 && !attentionCount) { pluginsCategoryTabsEl.innerHTML = ''; activeCategory = 'all'; return; }
  if (activeCategory == null) activeCategory = attentionCount ? 'attention' : 'all';
  if (activeCategory !== 'all' && activeCategory !== 'attention' && !present.includes(activeCategory)) activeCategory = 'all';
  if (activeCategory === 'attention' && !attentionCount) activeCategory = 'all';

  pluginsCategoryTabsEl.innerHTML = '';
  const makeTab = (key, label, count) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'setup-subtab-btn' + (activeCategory === key ? ' active' : '');
    btn.innerHTML = `${label} <span class="setup-subtab-btn-count">${count}</span>`;
    btn.addEventListener('click', () => {
      activeCategory = key;
      Array.from(pluginsCategoryTabsEl.children).forEach((b) => b.classList.toggle('active', b === btn));
      applyPluginsFilter();
    });
    pluginsCategoryTabsEl.appendChild(btn);
  };
  makeTab('all', 'ALL', plugins.length);
  if (attentionCount) makeTab('attention', 'NEEDS ATTENTION', attentionCount);
  present.forEach((cat) => makeTab(cat, CATEGORY_LABELS[cat], counts[cat]));
}

// Counts plugins needing attention for the sidebar badge (setup-sidebar.js)
// without building the list.
export async function reportPluginAttention() {
  try {
    const plugins = await window.api.pluginsList();
    currentPluginsForAttention = plugins;
    window.dispatchEvent(new CustomEvent('reruntv:plugin-attention', { detail: { count: plugins.filter(needsAttention).length } }));
  } catch (e) { /* the badge just stays as it was */ }
}

export async function renderPluginsList() {
  if (!pluginsListEl) return;
  let plugins;
  try {
    plugins = await window.api.pluginsList();
  } catch (e) {
    pluginsListEl.innerHTML = '';
    pluginsEmptyEl.textContent = `COULDN'T LIST PLUGINS: ${e.message}`;
    pluginsEmptyEl.classList.remove('hidden');
    if (pluginsSummaryEl) pluginsSummaryEl.textContent = '';
    return;
  }
  pluginsListEl.innerHTML = '';
  currentPluginsForAttention = plugins;
  window.dispatchEvent(new CustomEvent('reruntv:plugin-attention', { detail: { count: plugins.filter(needsAttention).length } }));
  pluginsEmptyEl.classList.toggle('hidden', plugins.length > 0);
  updateSummary(plugins);
  renderCategoryTabs(plugins);
  const disabledIdsAtRender = S.config.plugins.disabled || [];

  // Checkbox changes stage into this Map (id -> desired enabled) instead of
  // writing through to disk immediately — was previously one IPC call +
  // one themed alert per single click, both real friction with 24+ plugins
  // to review. Scoped to this render's closure (not module state) since the
  // whole list is rebuilt from scratch on every renderPluginsList() call
  // anyway (RESCAN, install, or a completed save) — a fresh Map each time
  // is exactly "no unsaved changes yet" for that fresh render.
  const pendingChanges = pendingPluginChanges;
  const knownIds = new Set(plugins.filter((x) => !x.error).map((x) => x.id));
  [...pendingChanges.keys()].forEach((id) => { if (!knownIds.has(id)) pendingChanges.delete(id); });

  function updateSaveUi() {
    if (!pluginsSaveBtn) return;
    const count = pendingChanges.size;
    const wasHidden = pluginsSaveBtn.classList.contains('hidden');
    pluginsSaveBtn.classList.toggle('hidden', count === 0);
    pluginsSaveBtn.textContent = count ? `SAVE CHANGES (${count})` : 'SAVE CHANGES';
    if (wasHidden && count > 0) {
      pluginsSaveBtn.classList.remove('btn-appear');
      void pluginsSaveBtn.offsetWidth;
      pluginsSaveBtn.classList.add('btn-appear');
    }
  }

  sortPluginsForDisplay(plugins).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'plugin-row' + (p.error || p.loadError ? ' has-error' : '');
    row.setAttribute('role', 'option');
    row.tabIndex = -1;
    const detail = document.createElement('div');
    detail.className = 'plugin-detail panel';
    if (lastCapabilityChangedId === p.id) row.classList.add('block-row-flash');

    if (!p.error) {
      const originalEnabled = !disabledIdsAtRender.includes(p.id);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'shuffle-toggle';
      if (pendingChanges.has(p.id) && pendingChanges.get(p.id) === originalEnabled) pendingChanges.delete(p.id); // saved elsewhere meanwhile
      checkbox.checked = pendingChanges.has(p.id) ? pendingChanges.get(p.id) : originalEnabled;
      row.dataset.enabled = String(checkbox.checked);
      row.classList.toggle('is-disabled', !checkbox.checked);
      row.classList.toggle('pending-change', pendingChanges.has(p.id));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked === originalEnabled) pendingChanges.delete(p.id);
        else pendingChanges.set(p.id, checkbox.checked);
        row.classList.toggle('is-disabled', !checkbox.checked);
        row.dataset.enabled = String(checkbox.checked);
        row.classList.toggle('pending-change', pendingChanges.has(p.id));
        entry.dataset.enabled = String(checkbox.checked);
        const status = row.querySelector('.plugin-row-status');
        if (status && row.dataset.attention !== 'true') {
          status.textContent = checkbox.checked ? 'ENABLED' : 'OFF';
          status.classList.toggle('is-off', !checkbox.checked);
        }
        if (pluginsSaveStatusEl) pluginsSaveStatusEl.textContent = '';
        updateSaveUi();
        applyPluginsFilter();
      });
      row.appendChild(checkbox);
    }

    const info = document.createElement('div');
    info.className = 'plugin-row-info';

    const nameLine = document.createElement('div');
    nameLine.className = 'plugin-row-name-line';
    const name = document.createElement('div');
    name.className = 'plugin-row-name';
    if (p.error) {
      name.textContent = p.dir;
    } else {
      name.textContent = p.name;
      const version = document.createElement('span');
      version.className = 'plugin-row-version';
      version.textContent = `v${p.version}`;
      name.appendChild(version);
    }
    nameLine.appendChild(name);
    let attention = false;
    if (!p.error) {
      attention = needsAttention(p);
      const onlyUnapproved = attention && isOnlyUnapprovedPermissions(p);
      const effectivelyOff = pendingChanges.has(p.id) ? !pendingChanges.get(p.id) : disabledIdsAtRender.includes(p.id);
      const status = document.createElement('span');
      status.className = `plugin-row-status${onlyUnapproved ? ' needs-approval' : (attention ? ' needs-attention' : (effectivelyOff ? ' is-off' : ''))}`;
      status.textContent = onlyUnapproved ? 'NEEDS APPROVAL' : (attention ? 'ATTENTION' : (effectivelyOff ? 'OFF' : 'ENABLED'));
      nameLine.appendChild(status);
      row.dataset.attention = String(attention);
    }

    // The row stays one line (name, version, status); everything else —
    // description, integrity, permissions, dependencies, actions, settings —
    // is the detail pane's, shown for the selected plugin only.
    info.appendChild(nameLine);
    const detailHeading = nameLine.cloneNode(true);
    detailHeading.classList.add('plugin-detail-heading');
    detail.appendChild(detailHeading);
    const summaryText = p.error ? '' : pluginSummary(p);
    if (summaryText) {
      const summaryEl = document.createElement('div');
      summaryEl.className = 'plugin-row-summary';
      summaryEl.textContent = summaryText;
      summaryEl.title = p.description || summaryText;
      info.appendChild(summaryEl);
    }

    const detailsTarget = document.createElement('div');
    detailsTarget.className = 'plugin-row-details';
    // Developer-facing facts (how it was verified, which entry points it has,
    // its id and folder) sit behind a Details disclosure (docs/design/03 §5.5).
    const devDetails = document.createElement('details');
    devDetails.className = 'plugin-dev-details';
    const devSummary = document.createElement('summary');
    devSummary.textContent = 'DETAILS';
    const devBody = document.createElement('div');
    devBody.className = 'plugin-dev-details-body';
    devDetails.append(devSummary, devBody);
    if (!p.error) {
      const idLine = document.createElement('div');
      idLine.className = 'plugin-row-approved';
      idLine.textContent = `ID ${p.id} · FOLDER ${p.dir} · VERSION ${p.version}`;
      devBody.appendChild(idLine);
    }

    if (p.error) {
      const err = document.createElement('div');
      err.className = 'plugin-row-error';
      err.textContent = p.error;
      detail.appendChild(err);
      if (!p.bundled) detail.appendChild(uninstallButton(p));
    } else {
      if (p.description) {
        const desc = document.createElement('div');
        desc.className = 'plugin-row-desc';
        desc.textContent = p.description;
        detailsTarget.appendChild(desc);
      }
      if (p.loadError) {
        const err = document.createElement('div');
        err.className = 'plugin-row-error';
        err.textContent = `Failed to load: ${p.loadError}`;
        detailsTarget.appendChild(err);
      }
      if (p.needsIntegrityApproval) {
        const notice = document.createElement('div');
        notice.className = 'plugin-row-error';
        notice.textContent = p.integrityStatus === 'modified'
          ? 'Plugin files changed after installation. UI, CSS, and system code are blocked.'
          : 'Plugin origin is unverified. UI, CSS, and system code are blocked.';
        detailsTarget.appendChild(notice);
        const trustBtn = document.createElement('button');
        trustBtn.type = 'button';
        trustBtn.className = 'btn btn-danger';
        trustBtn.textContent = 'REVIEW & TRUST THIS VERSION';
        trustBtn.addEventListener('click', () => promptIntegrityApproval(p));
        detailsTarget.appendChild(trustBtn);
      } else {
        const integrity = document.createElement('div');
        integrity.className = 'plugin-row-approved';
        integrity.textContent = p.integrityStatus === 'bundled'
          ? 'Built in by RerunTV.'
          : p.bundled
            ? 'Locally modified built-in files match the trusted SHA-256 record.'
            : 'Installed files match the trusted SHA-256 record.';
        devBody.appendChild(integrity);
      }
      // Declared capabilities.ipc/spawn/net that don't match what's in
      // config.plugins.approvedCapabilities yet (a first install, or an
      // update that added a new one) — the plugin stays inactive (same
      // safe-fallback treatment as disabled, see registerFallbackHandlers)
      // until approved here, then needs a restart like any other
      // enable/install change already does. See permissionState() above for
      // why this is recomputed locally rather than read off p.needsApproval.
      const permState = permissionState(p);
      if (permState === 'needs-approval') {
        const notice = document.createElement('div');
        notice.className = 'plugin-row-error';
        notice.textContent = 'Needs permission approval before it can activate.';
        detailsTarget.appendChild(notice);
        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'btn btn-primary';
        approveBtn.textContent = 'REVIEW & APPROVE PERMISSIONS';
        approveBtn.addEventListener('click', () => promptCapabilityApproval(p));
        detailsTarget.appendChild(approveBtn);
      } else if (permState === 'approved') {
        const notice = document.createElement('div');
        notice.className = 'plugin-row-approved';
        notice.textContent = 'Permissions approved.';
        detailsTarget.appendChild(notice);
        const permActions = document.createElement('div');
        permActions.className = 'plugin-row-perm-actions';
        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'btn';
        revokeBtn.textContent = 'REVOKE PERMISSIONS';
        revokeBtn.addEventListener('click', () => revokeCapabilityApproval(p));
        permActions.appendChild(revokeBtn);
        detailsTarget.appendChild(permActions);
      }
      // A bundled plugin can't actually be uninstalled — it just reappears
      // (still disabled) on the next boot — see isBundledPluginId(),
      // main-plugins.js. Any other plugin can be removed, whatever its permission
      // state (including one with nothing to approve, or one that failed to load).
      if (!p.bundled) {
        const removeActions = document.createElement('div');
        removeActions.className = 'plugin-row-perm-actions';
        removeActions.appendChild(uninstallButton(p));
        detailsTarget.appendChild(removeActions);
      }
      const kinds = document.createElement('div');
      kinds.className = 'plugin-row-kinds';
      if (p.style) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'CSS'; kinds.appendChild(k); }
      if (p.renderer) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'UI — FULL RENDERER ACCESS'; kinds.appendChild(k); }
      if (p.settings) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'SETTINGS'; kinds.appendChild(k); }
      if (p.main) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'SYSTEM'; kinds.appendChild(k); }
      if (kinds.children.length) devBody.appendChild(kinds);

      // Surfaces manifest `dependsOn` right on the row — previously only
      // enforced (via the disable-confirm above), never actually shown, so
      // there was no way to tell a plugin needed another one just by
      // looking at the list. Per-dependency status: green/plain if the
      // dependency is installed+enabled, red if it's missing, errored, or
      // itself disabled — the exact conditions that leave this plugin
      // silently degraded.
      if (p.dependsOn && p.dependsOn.length) {
        const deps = document.createElement('div');
        deps.className = 'plugin-row-deps';
        deps.textContent = 'REQUIRES: ';
        p.dependsOn.forEach((depId, i) => {
          if (i > 0) deps.appendChild(document.createTextNode(', '));
          const dep = plugins.find((other) => other.id === depId);
          const depDisabled = dep && (S.config.plugins.disabled || []).includes(depId);
          const ok = dep && !dep.error && !depDisabled;
          const span = document.createElement('span');
          span.className = ok ? 'plugin-row-dep-ok' : 'plugin-row-dep-missing';
          span.textContent = dep ? dep.name : depId;
          if (!ok) {
            if (!dep) span.title = 'Not installed';
            else if (depDisabled) span.title = 'Currently disabled';
            else span.title = 'Failed to load';
          }
          deps.appendChild(span);
        });
        detailsTarget.appendChild(deps);
      }
      detailsTarget.appendChild(devDetails);
      detail.appendChild(detailsTarget);
    }

    row.appendChild(info);

    // Live reload — re-fetches this plugin's style/renderer/settings from
    // disk and re-registers them without an app restart (see
    // reloadPlugin(), plugins.js, for exactly what it does and doesn't
    // clean up). Only offered where it can mean something: a plugin with no
    // style/renderer/settings entry point has nothing for it to reload, and
    // one that's disabled/errored/unapproved isn't active in this window to
    // begin with. A plugin whose only entry point is main.js (SYSTEM) still
    // needs a real restart to pick up changes — that limitation is called
    // out in the button's own title tooltip rather than hiding the button,
    // since most plugins with a main.js also have at least a style/renderer.
    if (!p.error && !p.needsIntegrityApproval && permissionState(p) !== 'needs-approval'
      && !disabledIdsAtRender.includes(p.id) && (p.style || p.renderer || p.settings)) {
      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'btn plugin-reload-btn';
      reloadBtn.textContent = 'RELOAD';
      reloadBtn.title = 'Reload this plugin’s style/UI/settings live, no restart needed. Changes to its main.js (SYSTEM) code still need a full restart.';
      reloadBtn.addEventListener('click', async () => {
        reloadBtn.disabled = true;
        const prevLabel = reloadBtn.textContent;
        reloadBtn.textContent = 'RELOADING…';
        const result = await reloadPlugin(p.id);
        reloadBtn.disabled = false;
        reloadBtn.textContent = prevLabel;
        if (!result.ok) {
          alertDialog(`Failed to reload ${p.name}:\n\n${result.error}`, { variant: 'error', title: 'RELOAD FAILED' });
        }
      });
      const reloadRow = document.createElement('div');
      reloadRow.className = 'plugin-row-perm-actions';
      reloadRow.appendChild(reloadBtn);
      detail.appendChild(reloadRow);
    }

    // Settings are composed from core-provided sections (currently channel
    // display overrides) plus any sections the plugin registered itself.
    // Legacy registerSettingsPanel definitions are exposed as one custom
    // section by getPluginSettingsSections, preserving existing plugins.
    const channelDefinition = !p.error ? getPluginChannelType(p.id) : null;
    const settingsSections = !p.error ? getPluginSettingsSections(p.id) : [];
    const hasSettings = !!channelDefinition || p.category === 'theme' || settingsSections.length > 0;
    const entry = document.createElement('div');
    entry.className = 'plugin-entry';
    entry.dataset.pluginId = p.id || p.dir;
    entry.pluginDetail = detail;
    row.addEventListener('click', (event) => {
      if (event.target.closest('input, button')) return;
      selectPluginEntry(entry);
    });
    // Precomputed lowercase haystack for the filter input below — cheaper
    // than re-reading entry.textContent (which also picks up SETTINGS
    // panel contents once expanded) on every keystroke.
    entry.dataset.search = [p.name, p.id, p.dir, p.description, ...(p.dependsOn || [])].filter(Boolean).join(' ').toLowerCase();
    entry.dataset.category = effectiveCategory(p);
    entry.dataset.attention = needsAttention(p) ? 'true' : 'false';
    entry.dataset.enabled = p.error ? 'false' : String(pendingChanges.has(p.id) ? pendingChanges.get(p.id) : !disabledIdsAtRender.includes(p.id));
    entry.appendChild(row);

    if (hasSettings) {
      const settingsHeading = document.createElement('div');
      settingsHeading.className = 'plugin-detail-section-title';
      settingsHeading.textContent = 'SETTINGS';
      const settingsPanel = document.createElement('div');
      settingsPanel.className = 'plugin-settings-panel';
      settingsPanel.id = `plugin-settings-${p.id}`;
      detail.append(settingsHeading, settingsPanel);
      // Rebuilt from current config each time the plugin is selected, so
      // changes made elsewhere in the meantime are always reflected.
      entry.showPluginSettings = () => renderPluginSettings(settingsPanel, p, channelDefinition, settingsSections);
    }

    pluginsListEl.appendChild(entry);
  });
  lastCapabilityChangedId = null;

  updateSaveUi();
  // Reassigned (not addEventListener) each render so a prior render's
  // closure over `plugins`/`pendingChanges` can't linger and fire stale —
  // this button element is static HTML, reused across every render.
  if (pluginsSaveBtn) pluginsSaveBtn.onclick = () => commitPendingPluginChanges(plugins, pendingChanges);

  applyPluginsFilter();
}

// Applies every staged checkbox change in one pass: one dependency-conflict
// warning (if any newly-disabled plugin has a dependent that will still be
// enabled afterward) instead of one per checkbox, then one write per
// changed id and a single re-render — replacing the old per-toggle
// "Enabling/Disabling X takes effect..." dialog, which was real friction
// once there were 24+ plugins to review at once.
async function commitPendingPluginChanges(plugins, pendingChanges) {
  if (!pendingChanges.size) return;
  const disabledIdsNow = S.config.plugins.disabled || [];
  const finalEnabled = (id) => (pendingChanges.has(id) ? pendingChanges.get(id) : !disabledIdsNow.includes(id));
  const newlyDisabledIds = [...pendingChanges].filter(([, enabled]) => !enabled).map(([id]) => id);

  if (newlyDisabledIds.length) {
    const dependents = plugins.filter((other) => !other.error && finalEnabled(other.id)
      && (other.dependsOn || []).some((dep) => newlyDisabledIds.includes(dep)));
    if (dependents.length) {
      const depNames = newlyDisabledIds.map((id) => (plugins.find((p) => p.id === id) || {}).name || id).join(', ');
      const names = dependents.map((d) => d.name).join(', ');
      const verb = dependents.length > 1 ? 'use' : 'uses';
      const ok = await confirmDialog({
        title: 'AFFECTS OTHER PLUGINS',
        message: `${names} ${verb} ${depNames} and may stop working correctly without ${newlyDisabledIds.length > 1 ? 'them' : 'it'}. Save these changes anyway?`,
        danger: true,
        confirmText: 'SAVE ANYWAY',
      });
      if (!ok) return;
    }
  }

  for (const [id, enabled] of pendingChanges) {
    // eslint-disable-next-line no-await-in-loop
    const changed = await window.api.pluginsSetEnabled(id, enabled);
    applyHostUpdate(changed && changed.hostUpdate);
  }
  const savedCount = pendingChanges.size;
  pendingChanges.clear();
  await renderPluginsList();
  // Set after the re-render (which rebuilds the list but never touches this
  // status element) rather than before it, so the message is what's
  // actually left on screen instead of being visible for one frame and
  // then immediately overwritten.
  if (pluginsSaveStatusEl) pluginsSaveStatusEl.textContent = `SAVED ${savedCount} CHANGE${savedCount > 1 ? 'S' : ''} — RESTART TO APPLY`;
}

// Re-applied after every renderPluginsList() (RESCAN, install, enable/
// disable toggle all rebuild the list from scratch) so an in-progress
// filter isn't silently dropped by the next re-render.
function applyPluginsFilter() {
  const q = pluginsFilterInputEl ? pluginsFilterInputEl.value.trim().toLowerCase() : '';
  const state = pluginsStateFilterEl ? pluginsStateFilterEl.value : 'all';
  const entries = Array.from(pluginsListEl.children);
  let visibleCount = 0;
  entries.forEach((entry) => {
    const matchesText = !q || (entry.dataset.search || '').includes(q);
    const matchesCategory = activeCategory === 'all'
      || (activeCategory === 'attention' ? entry.dataset.attention === 'true' : entry.dataset.category === activeCategory);
    const matchesState = state === 'all'
      || (state === 'attention' ? entry.dataset.attention === 'true' : entry.dataset.enabled === String(state === 'enabled'));
    const matches = matchesText && matchesCategory && matchesState;
    entry.classList.toggle('filtered-out', !matches);
    if (matches) visibleCount += 1;
  });
  if (pluginsFilterEmptyEl) pluginsFilterEmptyEl.classList.toggle('hidden', visibleCount > 0 || entries.length === 0);
  ensureVisibleSelection();
  if (pluginsResultsCountEl) {
    pluginsResultsCountEl.textContent = visibleCount === entries.length
      ? ''
      : `${visibleCount} OF ${entries.length} SHOWN`;
  }
}

if (pluginsFilterInputEl) {
  pluginsFilterInputEl.addEventListener('input', applyPluginsFilter);
}
if (pluginsStateFilterEl) {
  pluginsStateFilterEl.addEventListener('change', applyPluginsFilter);
}

// Two-step because main.js's plugins:installFromZip only opens the OS file
// picker once per click — if the target plugin id is already installed, the
// handler comes back { alreadyExists: true } instead of overwriting
// silently, and this asks (via the app's own themed dialog, not a raw
// confirm()) before retrying with { zipPath, overwrite: true } against the
// exact same file rather than re-prompting the picker.
async function installFromZip() {
  const result = await window.api.pluginsInstallFromZip({});
  if (result.cancelled) return;
  if (result.alreadyExists) {
    const ok = await confirmDialog({
      title: 'PLUGIN ALREADY INSTALLED',
      message: `"${result.name}" (id "${result.id}") is already installed. Overwrite it with this zip?`,
      danger: true,
      confirmText: 'OVERWRITE',
    });
    if (!ok) return;
    const retry = await window.api.pluginsInstallFromZip({ zipPath: result.zipPath, overwrite: true });
    if (!retry.success) { alertDialog(`Install failed: ${retry.error}`, { title: 'PLUGIN ERROR' }); return; }
    await alertDialog(`Installed "${retry.name}" — restart the app to activate it.`, { title: 'PLUGIN INSTALLED' });
    renderPluginsList();
    return;
  }
  if (!result.success) { alertDialog(`Install failed: ${result.error}`, { title: 'PLUGIN ERROR' }); return; }
  await alertDialog(`Installed "${result.name}" — restart the app to activate it.`, { title: 'PLUGIN INSTALLED' });
  renderPluginsList();
}

if (pluginsInstallZipBtn) {
  pluginsInstallZipBtn.addEventListener('click', installFromZip);
}
if (pluginsOpenFolderBtn) {
  pluginsOpenFolderBtn.addEventListener('click', () => window.api.pluginsOpenFolder());
}
if (pluginsRescanBtn) {
  pluginsRescanBtn.addEventListener('click', () => renderPluginsList());
}

export function renderPluginsTab() {
  renderCustomCssRow();
  pluginsRender = renderPluginsList();
}

window.addEventListener('rcb:plugins-loaded', () => {
  const panel = document.querySelector('[data-tab-panel="plugins"]');
  if (panel && !panel.classList.contains('hidden')) renderPluginsList();
});
