// The PLUGINS tab: custom CSS (a single user stylesheet applied live) and
// the installed-plugins list (see main-plugins.js/plugins.js for the loader
// itself — this module is just the setup-screen UI on top of it).
import {
  customCssChooseBtn, customCssPathEl, customCssRemoveBtn,
  pluginsCategoryTabsEl, pluginsEmptyEl, pluginsFilterEmptyEl, pluginsFilterInputEl, pluginsInstallZipBtn, pluginsListEl,
  pluginsOpenFolderBtn, pluginsRescanBtn, pluginsResultsCountEl, pluginsSaveBtn, pluginsSaveStatusEl,
  pluginsStateFilterEl, pluginsSummaryEl,
} from './dom.js';
import { alertDialog, confirmDialog } from './setup-dialogs.js';
import {
  applyCustomCss,
  getPluginChannelType,
  getPluginSettingsSections,
  reloadPlugin,
} from './plugins.js';
import { S, saveConfigDebounced } from './state.js';
import { renderPluginSettings } from './setup-plugin-settings.js';

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
    saveConfigDebounced();
  });
}

if (customCssRemoveBtn) {
  customCssRemoveBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({ message: 'Remove the custom stylesheet? The UI reverts to the built-in theme immediately.', danger: false, confirmText: 'REMOVE' }))) return;
    S.config.display.customCssPath = null;
    renderCustomCssRow();
    applyCustomCss();
    saveConfigDebounced();
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
// inline (previously nothing surfaced this at all — see
// [[retro_cable_box_plugin_settings_relocation_and_eas_news_split]]'s "still
// open" note) and dims when disabled, so enabled/disabled/broken/dependent
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
// one line per manifest.json capabilities.ipc/spawn/net/mediaSource entry,
// each already carrying its own author-supplied `why`.
function formatCapabilityLines(caps) {
  const lines = [];
  (caps.ipc || []).forEach((e) => lines.push(`Talk to the app internally as "${e.channel}" — ${e.why}`));
  (caps.spawn || []).forEach((e) => lines.push(`Run "${e.bin}" as a separate program — ${e.why}`));
  (caps.net || []).forEach((e) => lines.push(`Open network port ${e.port} — ${e.why}`));
  (caps.mediaSource || []).forEach((e) => lines.push(`Supply channel media as a source named "${e.displayName || e.providerId}" — ${e.why}`));
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
  await window.api.pluginsApproveCapabilities(p.id, signature);
  // The IPC handler above writes straight to disk from its own fresh
  // loadConfig() — S.config here is a separate in-memory copy the renderer
  // has held since boot (or since the last load/save), so it still lacks
  // this entry. Without mirroring it here too, the next unrelated
  // saveConfigDebounced() (any other settings edit) would overwrite the
  // disk write with this stale copy, silently reverting the approval and
  // leaving the button stuck showing even after a restart.
  if (!S.config.plugins) S.config.plugins = { disabled: [] };
  if (!S.config.plugins.approvedCapabilities) S.config.plugins.approvedCapabilities = {};
  S.config.plugins.approvedCapabilities[p.id] = signature;
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
  await window.api.pluginsRevokeCapabilities(p.id);
  // Same stale-S.config concern as promptCapabilityApproval above — mirror
  // the removal locally so an unrelated later autosave can't resurrect the
  // signature this IPC call just deleted on disk.
  if (S.config.plugins.approvedCapabilities) delete S.config.plugins.approvedCapabilities[p.id];
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
async function confirmUninstallPlugin(p) {
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
  const disabled = S.config.plugins.disabled || [];
  const idx = disabled.indexOf(p.id);
  if (idx !== -1) disabled.splice(idx, 1);
  if (S.config.plugins.approvedCapabilities) delete S.config.plugins.approvedCapabilities[p.id];
  await alertDialog(`${p.name} uninstalled — restart the app for this to fully take effect.`, { title: 'RESTART NEEDED' });
  renderPluginsList();
}

// Whether a plugin's manifest declares anything requiring approval at all —
// mirrors main-plugins.js's loadMainPlugins() hasAnyCapability check exactly
// (same four arrays, same truthiness test) so this stays in lockstep with
// what actually gates activation there.
function hasAnyCapability(caps) {
  return !!(caps && (caps.ipc.length || caps.spawn.length || caps.net.length || caps.mediaSource.length));
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

let currentPluginsForAttention = [];

// Which plugin rows have been manually expanded this session — persists
// across a renderPluginsList() rebuild (RESCAN, a checkbox toggle, an
// approve/revoke) the same way openChannelEditTabs (setup-channels.js)
// remembers an open channel-edit tab across re-renders, so expanding a row
// to read its description isn't undone by the very next unrelated click.
// Session-only (not saved to config) — this is pure UI state, not a
// setting.
const expandedPluginIds = new Set();

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
  const pendingChanges = new Map();

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
    if (lastCapabilityChangedId === p.id) row.classList.add('block-row-flash');

    if (!p.error) {
      const originalEnabled = !disabledIdsAtRender.includes(p.id);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'shuffle-toggle';
      checkbox.checked = originalEnabled;
      row.dataset.enabled = String(originalEnabled);
      row.classList.toggle('is-disabled', !checkbox.checked);
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
      const status = document.createElement('span');
      status.className = `plugin-row-status${attention ? ' needs-attention' : (disabledIdsAtRender.includes(p.id) ? ' is-off' : '')}`;
      status.textContent = attention ? 'ATTENTION' : (disabledIdsAtRender.includes(p.id) ? 'OFF' : 'ENABLED');
      nameLine.appendChild(status);
      row.dataset.attention = String(attention);
    }

    // The description/integrity/permission/capability/dependency block below
    // is collapsed by default — with 50+ plugins installed, always rendering
    // every row's full paragraph made this tab mostly scrolling. A row that
    // needs attention (an error, an unapproved permission/integrity change,
    // a broken dependency) or one the user has already expanded this session
    // (expandedPluginIds above) stays open instead — the two cases where
    // collapsing would actually hide something worth seeing right away.
    let detailsExpanded = !p.error && (attention || expandedPluginIds.has(p.id));
    let detailsToggleBtn = null;
    if (!p.error) {
      detailsToggleBtn = document.createElement('button');
      detailsToggleBtn.type = 'button';
      detailsToggleBtn.className = 'btn btn-small plugin-row-details-toggle';
      nameLine.appendChild(detailsToggleBtn);
    }
    info.appendChild(nameLine);

    const detailsTarget = p.error ? info : document.createElement('div');
    if (!p.error) detailsTarget.className = 'plugin-row-details';

    if (p.error) {
      const err = document.createElement('div');
      err.className = 'plugin-row-error';
      err.textContent = p.error;
      info.appendChild(err);
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
        detailsTarget.appendChild(integrity);
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
        // A bundled plugin can't actually be uninstalled — it just reappears
        // (still disabled) on the next boot — see isBundledPluginId(),
        // main-plugins.js. Only offer the button where it can mean something.
        if (!p.bundled) {
          const uninstallBtn = document.createElement('button');
          uninstallBtn.type = 'button';
          uninstallBtn.className = 'btn btn-danger';
          uninstallBtn.textContent = 'FULLY UNINSTALL';
          uninstallBtn.addEventListener('click', () => confirmUninstallPlugin(p));
          permActions.appendChild(uninstallBtn);
        }
        detailsTarget.appendChild(permActions);
      }
      const kinds = document.createElement('div');
      kinds.className = 'plugin-row-kinds';
      if (p.style) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'CSS'; kinds.appendChild(k); }
      if (p.renderer) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'UI — FULL RENDERER ACCESS'; kinds.appendChild(k); }
      if (p.settings) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'SETTINGS'; kinds.appendChild(k); }
      if (p.main) { const k = document.createElement('span'); k.className = 'plugin-row-kind'; k.textContent = 'SYSTEM'; kinds.appendChild(k); }
      if (kinds.children.length) detailsTarget.appendChild(kinds);

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
      info.appendChild(detailsTarget);
    }

    row.appendChild(info);

    if (detailsToggleBtn) {
      const setExpanded = (expanded) => {
        detailsExpanded = expanded;
        detailsTarget.classList.toggle('collapsed', !expanded);
        detailsToggleBtn.textContent = expanded ? 'DETAILS ▾' : '+ DETAILS';
        detailsToggleBtn.setAttribute('aria-expanded', String(expanded));
      };
      setExpanded(detailsExpanded);
      detailsToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (detailsExpanded) expandedPluginIds.delete(p.id); else expandedPluginIds.add(p.id);
        setExpanded(!detailsExpanded);
      });
    }

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
      row.appendChild(reloadBtn);
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
    // Precomputed lowercase haystack for the filter input below — cheaper
    // than re-reading entry.textContent (which also picks up SETTINGS
    // panel contents once expanded) on every keystroke.
    entry.dataset.search = [p.name, p.id, p.dir, p.description, ...(p.dependsOn || [])].filter(Boolean).join(' ').toLowerCase();
    entry.dataset.category = effectiveCategory(p);
    entry.dataset.attention = needsAttention(p) ? 'true' : 'false';
    entry.dataset.enabled = p.error ? 'false' : String(!disabledIdsAtRender.includes(p.id));
    entry.appendChild(row);

    if (hasSettings) {
      const settingsBtn = document.createElement('button');
      settingsBtn.type = 'button';
      settingsBtn.className = 'btn plugin-settings-toggle-btn';
      settingsBtn.textContent = 'SETTINGS';
      settingsBtn.setAttribute('aria-expanded', 'false');
      row.appendChild(settingsBtn);

      const settingsPanel = document.createElement('div');
      settingsPanel.className = 'plugin-settings-panel hidden panel';
      settingsPanel.id = `plugin-settings-${p.id}`;
      settingsBtn.setAttribute('aria-controls', settingsPanel.id);
      entry.appendChild(settingsPanel);

      settingsBtn.addEventListener('click', () => {
        const willShow = settingsPanel.classList.contains('hidden');
        settingsPanel.classList.toggle('hidden', !willShow);
        settingsBtn.classList.toggle('active', willShow);
        settingsBtn.setAttribute('aria-expanded', String(willShow));
        if (willShow) {
          // Rebuild from current config on every expansion so changes made
          // elsewhere while collapsed are always reflected.
          renderPluginSettings(settingsPanel, p, channelDefinition, settingsSections);
          settingsPanel.classList.remove('panel-reveal');
          void settingsPanel.offsetWidth;
          settingsPanel.classList.add('panel-reveal');
        }
      });
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
    await window.api.pluginsSetEnabled(id, enabled);
  }
  if (!S.config.plugins.disabled) S.config.plugins.disabled = [];
  pendingChanges.forEach((enabled, id) => {
    const idx = S.config.plugins.disabled.indexOf(id);
    if (enabled && idx !== -1) S.config.plugins.disabled.splice(idx, 1);
    if (!enabled && idx === -1) S.config.plugins.disabled.push(id);
  });
  const savedCount = pendingChanges.size;
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
  renderPluginsList();
}

window.addEventListener('rcb:plugins-loaded', () => {
  const panel = document.querySelector('[data-tab-panel="plugins"]');
  if (panel && !panel.classList.contains('hidden')) renderPluginsList();
});
