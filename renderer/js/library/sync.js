// Opt-in channel-folder synchronization. All sources use the same list/probe
// contract: local folders happen to be one provider, not a special UI path.
import { refreshSidebarBadges } from '../setup/sidebar.js';
import { beginTask } from '../setup/tasks.js';
import { S, commitConfigPatch, commitInPlace, viewNow } from '../core/state.js';
import { parseMediaRef } from '../core/channels.js';
import { probeDurationForEntry } from '../setup/util.js';
import { confirmDialog } from '../setup/dialogs.js';
import { reconcileFolderFiles } from './sync-core.js';
import { applyPlaylistPreservingAir } from './reanchor.js';
import { describeFilled, fileFieldsFromLocal, fillFilesInPlace, localMetadataPrefs, localPathOf, readLocalMetadata } from './local-metadata.js';
import { inheritFromCopies, shareAcrossCopies } from './file-copies.js';
const SYNC_PROBE_CONCURRENCY = 4;
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
  // Probe at most a few files at a time: provider probes are plain IPC and
  // would otherwise all fire at once on a big folder. An unreadable file keeps
  // a null duration; reconcileFolderFiles leaves it out rather than guessing.
  const out = new Array(listed.length);
  let next = 0;
  const worker = async () => {
    while (next < listed.length) {
      const i = next++;
      const path = listed[i];
      const parsed = parseMediaRef(path);
      const duration = knownDurations.get(path) || await probeDurationForEntry(parsed.source, parsed.ref);
      out[i] = { path, source: parsed.source, duration: duration > 0 ? duration : null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_PROBE_CONCURRENCY, listed.length) }, worker));
  return out;
}

// Changing a channel's playlist changes what airs unless its anchor moves with
// it (docs/design/07 §3): even a pure append changes the loop's length and can
// cut away from the programme on screen. Evaluated at viewNow() — the clock the
// schedule reads — and, for the tuned channel, with the break-drift
// compensation playback applies.
export function scheduleClockFor(channel) {
  const atMs = viewNow();
  return S.currentNumber === channel.number ? atMs - (S.contentLostMs || 0) : atMs;
}

function summaryText(result) {
  const parts = [];
  if (result.added) parts.push(`${result.added} added`);
  if (result.renamed) parts.push(`${result.renamed} renamed`);
  if (result.removed) parts.push(`${result.removed} removed`);
  if (result.missing) parts.push(`${result.missing} missing (kept)`);
  if (result.unprobed) parts.push(`${result.unprobed} unreadable (will retry)`);
  if (result.filled) parts.push(`details filled for ${result.filled}`);
  if (result.errors) parts.push(`${result.errors} source warning${result.errors === 1 ? '' : 's'}`);
  if (result.onAirChanged) parts.push(result.onAirChanged === true ? 'what is on the air changed' : `on-air changed on ${result.onAirChanged} channel${result.onAirChanged === 1 ? '' : 's'}`);
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
  const task = beginTask('SYNCING LIBRARY FOLDERS…');
  const status = document.getElementById('library-sync-status');
  if (status) status.textContent = 'CHECKING LINKED FOLDERS…';
  const prefs = settings();
  const totals = { added: 0, renamed: 0, removed: 0, missing: 0, errors: 0, onAirChanged: 0, unprobed: 0, filled: 0 };
  const { fillDetails, readTags } = localMetadataPrefs(S.config);
  const rows = [];
  let contentChanged = false;
  try {
    for (const channel of S.config.channels || []) {
      for (const folder of channel.folders || []) {
        const tracked = (channel.files || []).filter((file) => file.folder === folder.id);
        task.update(`SYNCING CH ${channel.number}: ${folder.label || folder.ref}…`);
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
            unprobed: result.unprobed.length,
          };
          // A new file that another channel already plays arrives with the
          // details it has there (a TMDB match, a description, a title).
          if (result.added.length) {
            const addedPaths = new Set(result.added.map((file) => file.path));
            row.inherited = inheritFromCopies(S.config, result.files.filter((file) => addedPaths.has(file.path) && file.folder === folder.id));
          }
          // New files arrive with what their .nfo files and tags say, before
          // they join the playlist (LIBRARY SYNC › "Fill in new files' details").
          // A failed read never blocks the sync itself.
          if (fillDetails && result.added.length) {
            const addedPaths = new Set(result.added.map((file) => file.path));
            try {
              row.filled = (await fillFilesInPlace(result.files.filter((file) => addedPaths.has(file.path) && file.folder === folder.id), { tags: readTags })).length;
            } catch (error) {
              console.warn('[library-sync] reading file details failed:', error);
            }
          }
          if (row.added || row.renamed || row.removed) {
            const air = applyPlaylistPreservingAir(channel, result.files, scheduleClockFor(channel));
            if (!air.preserved && air.reason !== 'no-anchor') row.onAirChanged = true;
            contentChanged = true;
          }
          Object.keys(totals).forEach((key) => {
            if (key === 'onAirChanged') { if (row.onAirChanged) totals.onAirChanged += 1; return; }
            if (row[key]) totals[key] += row[key];
          });
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
    // The run's own bookkeeping is a skipUndo command (these fields are host-local
    // watching state: main/config/host.js HOST_LOCAL_FIELDS), recorded first so the
    // content patch below, which is the one undoable step, doesn't carry it.
    commitInPlace([
      { type: 'settings.set', path: ['librarySync', 'lastRunAt'], value: prefs.lastRunAt },
      { type: 'settings.set', path: ['librarySync', 'lastReason'], value: prefs.lastReason },
      { type: 'settings.set', path: ['librarySync', 'lastSummary'], value: prefs.lastSummary },
    ], { delay: 100, skipUndo: true });
    if (contentChanged) commitConfigPatch('Library sync', { delay: 100 });
    if (status) status.textContent = `${summaryText(totals).toUpperCase()} · ${new Date(prefs.lastRunAt).toLocaleString()}`;
    renderResults(rows);
    refreshSidebarBadges();
    return { ...totals, rows };
  } finally {
    syncRunning = false;
    task.end();
  }
}

// Every local playlist entry, in channels and their schedule blocks, that is
// missing a detail a reading could supply.
function filesMissingDetails() {
  const out = [];
  (S.config.channels || []).forEach((channel) => {
    [channel.files || [], ...(channel.blocks || []).map((block) => block.files || [])].forEach((files) => {
      files.forEach((file) => {
        if (!localPathOf(file.path)) return;
        const missing = !(file.title && String(file.title).trim()) || !(file.description && String(file.description).trim())
          || !file.rating || !(file.series && file.series.name);
        if (missing) out.push(file);
      });
    });
  });
  return out;
}

// LIBRARY SYNC › FILL IN ALL CHANNELS NOW: one pass over the whole lineup,
// recorded as a single undoable patch. First every entry takes what its
// other copies already know (a TMDB match made on one channel before matches
// were shared, library/file-copies.js), then the rest are read from disk. Titles, descriptions, ratings and
// series names don't move anything in a schedule, so nothing on the air
// changes; only empty fields are filled.
export async function fillAllChannelDetails() {
  if (syncRunning || window.__isViewer) return null;
  const status = document.getElementById('local-meta-status');
  const shared = shareAcrossCopies(S.config);
  const sharedText = shared ? `SHARED DETAILS WITH ${shared} COP${shared === 1 ? 'Y' : 'IES'} OF FILES ON OTHER CHANNELS. ` : '';
  const files = filesMissingDetails();
  if (!files.length) {
    if (shared) commitConfigPatch('Fill in details from files', { delay: 100 });
    if (status) status.textContent = `${sharedText}EVERY LOCAL FILE ALREADY HAS ITS DETAILS.`;
    return { filled: 0, shared };
  }
  syncRunning = true;
  const button = document.getElementById('local-meta-fill-btn');
  if (button) button.disabled = true;
  const task = beginTask('READING FILE DETAILS…');
  try {
    const { results, tagsAvailable } = await readLocalMetadata(files.map((file) => localPathOf(file.path)), {
      tags: localMetadataPrefs(S.config).readTags,
      onProgress: (done, total) => task.update(`READING FILE DETAILS ${done} / ${total}…`),
    });
    const applied = [];
    files.forEach((file) => {
      const fields = fileFieldsFromLocal(file, results[localPathOf(file.path)]);
      if (!fields) return;
      Object.assign(file, fields);
      applied.push(fields);
    });
    if (applied.length || shared) commitConfigPatch('Fill in details from files', { delay: 100 });
    if (status) {
      status.textContent = sharedText + (applied.length
        ? `FILLED IN ${describeFilled(applied).toUpperCase()} ON ${applied.length} OF ${files.length} FILES.`
        : `NOTHING NEW IN ${files.length} FILES' .NFO FILES${tagsAvailable ? ' OR TAGS' : ''}.`);
    }
    return { filled: applied.length, read: files.length, shared };
  } catch (error) {
    // Details shared between copies above are kept even when reading fails.
    if (shared) commitConfigPatch('Fill in details from files', { delay: 100 });
    if (status) status.textContent = `${sharedText}COULD NOT READ FILE DETAILS: ${error.message}`;
    return null;
  } finally {
    syncRunning = false;
    if (button) button.disabled = false;
    task.end();
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
  const details = localMetadataPrefs(S.config);
  const fill = document.getElementById('local-meta-fill');
  const tags = document.getElementById('local-meta-tags');
  if (fill) fill.checked = details.fillDetails;
  if (tags) tags.checked = details.readTags;
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
  periodicTimer = setInterval(() => { runLibrarySync({ reason: 'periodic' }).catch((e) => console.warn('[library-sync] periodic run failed:', e)); }, minutes * 60 * 1000);
}

export function initLibrarySync() {
  renderLibrarySyncSettings();
  schedulePeriodicSync();
  const prefs = settings();
  if (prefs.enabled && prefs.runAtStartup !== false) {
    // Do not hold the first usable window behind a potentially slow network
    // provider. Startup sync begins once initial rendering has settled.
    setTimeout(() => { runLibrarySync({ reason: 'startup' }).catch((e) => console.warn('[library-sync] startup run failed:', e)); }, 1500);
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
const fillEl = document.getElementById('local-meta-fill');
const tagsEl = document.getElementById('local-meta-tags');
fillEl?.addEventListener('change', () => {
  settings().fillDetails = fillEl.checked;
  commitInPlace({ type: 'settings.set', path: ['librarySync', 'fillDetails'], value: settings().fillDetails });
});
tagsEl?.addEventListener('change', () => {
  settings().readTags = tagsEl.checked;
  commitInPlace({ type: 'settings.set', path: ['librarySync', 'readTags'], value: settings().readTags });
});
document.getElementById('local-meta-fill-btn')?.addEventListener('click', () => fillAllChannelDetails());
document.querySelector('[data-subtab="librarysync"]')?.addEventListener('click', renderLibrarySyncSettings);
