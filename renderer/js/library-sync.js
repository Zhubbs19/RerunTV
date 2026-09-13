// Opt-in channel-folder synchronization. All sources use the same list/probe
// contract: local folders happen to be one provider, not a special UI path.
import { refreshSidebarBadges } from './setup-sidebar.js';
import { S, commitConfigPatch, commitInPlace } from './state.js';
import { parseMediaRef } from './channels.js';
import { probeDurationForEntry } from './setup-util.js';
import { confirmDialog } from './setup-dialogs.js';
import { reconcileFolderFiles } from './library-sync-core.js';
let periodicTimer = null;
let syncRunning = false;


function settings() {
  if (!S.config.librarySync) {
    S.config.librarySync = { enabled: false, runAtStartup: true, intervalMinutes: 30, removeMissing: false };
  }
  return S.config.librarySync;
}

async function scanFolder(folder, tracked) {
  const listed = await window.api.scanFolder(folder.source || 'local', folder.ref);
  if (!Array.isArray(listed)) throw new Error('The source returned an invalid folder listing.');
  // The provider contract currently represents an unreachable source as an
  // empty listing. Never interpret that as permission to erase a populated
  // channel; an actually emptied folder is reported for manual review.
  if (!listed.length && tracked.length) throw new Error('Source returned no files; existing titles were left untouched.');
  const knownDurations = new Map(tracked.map((file) => [file.path, file.duration]));
  return Promise.all(listed.map(async (path) => {
    const parsed = parseMediaRef(path);
    const duration = knownDurations.get(path) || await probeDurationForEntry(parsed.source, parsed.ref);
    return { path, source: parsed.source, duration: duration || 180 };
  }));
}

function summaryText(result) {
  const parts = [];
  if (result.added) parts.push(`${result.added} added`);
  if (result.renamed) parts.push(`${result.renamed} renamed`);
  if (result.removed) parts.push(`${result.removed} removed`);
  if (result.missing) parts.push(`${result.missing} missing (kept)`);
  if (result.errors) parts.push(`${result.errors} source warning${result.errors === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'No library changes found';
}

function renderResults(rows) {
  const root = document.getElementById('library-sync-results');
  if (!root) return;
  root.innerHTML = '';
  // Warnings first, then folders that changed, then the quiet ones — a single
  // source warning was otherwise buried somewhere in a long column of "No
  // library changes found" rows. Stable sort keeps lineup order within each.
  const rank = (row) => (row.error ? 0 : (row.added || row.renamed || row.removed || row.missing) ? 1 : 2);
  [...rows].sort((a, b) => rank(a) - rank(b)).forEach((row) => {
    const item = document.createElement('div');
    item.className = 'title-row';
    const label = document.createElement('div');
    label.className = 'title-row-main';
    label.textContent = `CH ${row.channel} · ${row.folder}`;
    const detail = document.createElement('span');
    detail.className = row.error ? 'panel-status text-error' : 'panel-status';
    detail.textContent = row.error || summaryText(row);
    item.append(label, detail);
    root.appendChild(item);
  });
}

export async function runLibrarySync({ reason = 'manual' } = {}) {
  if (syncRunning || window.__isViewer) return null;
  syncRunning = true;
  const status = document.getElementById('library-sync-status');
  if (status) status.textContent = 'CHECKING LINKED FOLDERS…';
  const prefs = settings();
  const totals = { added: 0, renamed: 0, removed: 0, missing: 0, errors: 0 };
  const rows = [];
  let contentChanged = false;
  try {
    for (const channel of S.config.channels || []) {
      for (const folder of channel.folders || []) {
        const tracked = (channel.files || []).filter((file) => file.folder === folder.id);
        try {
          const scanned = await scanFolder(folder, tracked);
          const result = reconcileFolderFiles(channel.files || [], scanned, folder.id, !!prefs.removeMissing);
          const row = {
            channel: channel.number,
            folder: folder.label || folder.ref,
            added: result.added.length,
            renamed: result.renames.length,
            removed: prefs.removeMissing ? result.missing.length : 0,
            missing: prefs.removeMissing ? 0 : result.missing.length,
          };
          Object.keys(totals).forEach((key) => { if (row[key]) totals[key] += row[key]; });
          if (row.added || row.renamed || row.removed) {
            channel.files = result.files;
            contentChanged = true;
          }
          rows.push(row);
        } catch (error) {
          totals.errors++;
          rows.push({ channel: channel.number, folder: folder.label || folder.ref, error: error.message });
        }
      }
    }
    prefs.lastRunAt = new Date().toISOString(); // real wall-clock audit timestamp, not schedule time
    prefs.lastReason = reason;
    prefs.lastSummary = totals;
    commitConfigPatch('Library sync', { delay: 100, skipUndo: !contentChanged });
    if (status) status.textContent = `${summaryText(totals).toUpperCase()} · ${new Date(prefs.lastRunAt).toLocaleString()}`;
    renderResults(rows);
    refreshSidebarBadges();
    return { ...totals, rows };
  } finally {
    syncRunning = false;
  }
}

export function renderLibrarySyncSettings() {
  const prefs = settings();
  const enabled = document.getElementById('library-sync-enabled');
  const startup = document.getElementById('library-sync-startup');
  const remove = document.getElementById('library-sync-remove-missing');
  const interval = document.getElementById('library-sync-interval');
  const status = document.getElementById('library-sync-status');
  if (enabled) enabled.checked = !!prefs.enabled;
  if (startup) startup.checked = prefs.runAtStartup !== false;
  if (remove) remove.checked = !!prefs.removeMissing;
  if (interval) interval.value = prefs.intervalMinutes || 30;
  if (status) status.textContent = prefs.lastRunAt
    ? `${summaryText(prefs.lastSummary || {}).toUpperCase()} · ${new Date(prefs.lastRunAt).toLocaleString()}`
    : (prefs.enabled ? 'READY — NO SYNC HAS RUN YET.' : 'SYNC IS OFF.');
}

function schedulePeriodicSync() {
  clearInterval(periodicTimer);
  periodicTimer = null;
  const prefs = settings();
  if (!prefs.enabled || window.__isViewer) return;
  const minutes = Math.max(5, Math.min(1440, Number(prefs.intervalMinutes) || 30));
  periodicTimer = setInterval(() => runLibrarySync({ reason: 'periodic' }), minutes * 60 * 1000);
}

export function initLibrarySync() {
  renderLibrarySyncSettings();
  schedulePeriodicSync();
  const prefs = settings();
  if (prefs.enabled && prefs.runAtStartup !== false) {
    // Do not hold the first usable window behind a potentially slow network
    // provider. Startup sync begins once initial rendering has settled.
    setTimeout(() => runLibrarySync({ reason: 'startup' }), 1500);
  }
}

const enabledEl = document.getElementById('library-sync-enabled');
const startupEl = document.getElementById('library-sync-startup');
const removeEl = document.getElementById('library-sync-remove-missing');
const intervalEl = document.getElementById('library-sync-interval');
const nowEl = document.getElementById('library-sync-now-btn');
enabledEl?.addEventListener('change', () => {
  settings().enabled = enabledEl.checked;
  commitInPlace({ type: 'settings.set', path: ['librarySync','enabled'], value: settings().enabled });
  schedulePeriodicSync();
  renderLibrarySyncSettings();
});
startupEl?.addEventListener('change', () => { settings().runAtStartup = startupEl.checked; commitInPlace({ type: 'settings.set', path: ['librarySync','runAtStartup'], value: settings().runAtStartup }); });
removeEl?.addEventListener('change', async () => {
  if (removeEl.checked) {
    const approved = await confirmDialog({
      title: 'REMOVE MISSING TITLES AUTOMATICALLY?',
      message: 'When a linked source stops reporting a file, future syncs will remove it from the channel. Source outages are guarded, and backups remain available, but the playlist edit is automatic.',
      danger: true,
      confirmText: 'ENABLE REMOVAL',
    });
    if (!approved) { removeEl.checked = false; return; }
  }
  settings().removeMissing = removeEl.checked;
  commitInPlace({ type: 'settings.set', path: ['librarySync','removeMissing'], value: settings().removeMissing });
});
intervalEl?.addEventListener('change', () => {
  settings().intervalMinutes = Math.max(5, Math.min(1440, Number(intervalEl.value) || 30));
  intervalEl.value = settings().intervalMinutes;
  commitInPlace({ type: 'settings.set', path: ['librarySync','intervalMinutes'], value: settings().intervalMinutes });
  schedulePeriodicSync();
});
nowEl?.addEventListener('click', () => runLibrarySync({ reason: 'manual' }));
document.querySelector('[data-subtab="librarysync"]')?.addEventListener('click', renderLibrarySyncSettings);
