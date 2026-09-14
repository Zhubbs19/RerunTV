// AUDIO & SYSTEM backup list, labeling, restore, deletion, and snapshots.
import { backupsListEl, backupsRefreshBtn, backupsSnapshotNowBtn } from './dom.js';
import { alertDialog, confirmDialog, promptDialog } from './setup-dialogs.js';
import { emptyState } from './setup-util.js';
import { MenuButton } from './ui/menu.js';

let justSnapshotted = false;
let restoreHandler = null;

function formatBackupTimestamp(mtimeMs) {
  const d = new Date(mtimeMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatRelativeTime(mtimeMs) {
  const seconds = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
  if (seconds < 60) return 'JUST NOW';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} MIN AGO`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} HR${hours === 1 ? '' : 'S'} AGO`;
  const days = Math.round(hours / 24);
  return `${days} DAY${days === 1 ? '' : 'S'} AGO`;
}

const BACKUP_REASON_LABELS = {
  automatic: 'AUTO-SAVE',
  manual: 'MANUAL',
  'session-start': 'SESSION START',
  'before-restore': 'BEFORE RESTORE',
  'before-update': 'BEFORE UPDATE',
};

function metricLine(label, current, snapshot) {
  const delta = snapshot - current;
  const change = delta === 0 ? 'NO CHANGE' : `${delta > 0 ? '+' : ''}${delta}`;
  return `${label}: ${current} NOW → ${snapshot} IN SNAPSHOT (${change})`;
}

// List + detail (docs/design/03 §5.3): snapshots on the left, the selected
// one's differences from the current config and its actions on the right.
let selectedBackupFile = null;
let previewToken = 0;

function previewLines(preview) {
  const diff = preview.diff;
  const changed = diff.addedChannels.length || diff.removedChannels.length || diff.renamedChannels.length
    || diff.fileCountChanges.length || diff.scheduleChanges.length || diff.settingsChanges.length;
  return [
    metricLine('CHANNELS', preview.current.channels, preview.snapshot.channels),
    metricLine('MEDIA FILES', preview.current.files, preview.snapshot.files),
    metricLine('PROGRAM BLOCKS', preview.current.blocks, preview.snapshot.blocks),
    ...(diff.addedChannels.length ? [`ADDED IN SNAPSHOT: ${diff.addedChannels.map((entry) => `CH ${entry.number} ${entry.name}`).join(', ')}`] : []),
    ...(diff.removedChannels.length ? [`REMOVED IN SNAPSHOT: ${diff.removedChannels.map((entry) => `CH ${entry.number} ${entry.name}`).join(', ')}`] : []),
    ...diff.renamedChannels.map((entry) => `RENAMED: CH ${entry.number} “${entry.from}” → “${entry.to}”`),
    ...diff.fileCountChanges.map((entry) => `MEDIA: CH ${entry.number} ${entry.current} → ${entry.snapshot} files`),
    ...(diff.scheduleChanges.length ? [`SCHEDULE CHANGES: ${diff.scheduleChanges.map((entry) => `CH ${entry.number}`).join(', ')}`] : []),
    ...(diff.settingsChanges.length ? [`SETTINGS/PLUGINS CHANGED: ${diff.settingsChanges.join(', ')}`] : []),
    ...(changed ? [] : ['NO CONFIGURATION DIFFERENCES FOUND.']),
  ];
}

function button(label, onClick, className = 'btn') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// A snapshot's actions, shared by its detail pane and its list row's ⋯ menu.
async function restoreBackupFile(backup) {
  if (!(await confirmDialog({ message: `Restore the snapshot from ${formatBackupTimestamp(backup.mtimeMs)}? This replaces everything currently loaded — a snapshot of the current state is taken first, so this itself can be undone.`, danger: false, confirmText: 'RESTORE' }))) return;
  try { if (restoreHandler) restoreHandler(await window.api.restoreBackup(backup.file)); }
  catch (error) { alertDialog(`Restore failed: ${error.message}`, { variant: 'error' }); }
}

async function labelBackupFile(backup) {
  const next = await promptDialog({ title: 'BACKUP LABEL', message: 'Label this backup — blank to clear:', defaultValue: backup.label || '' });
  if (next === null) return;
  try { await window.api.setBackupLabel(backup.file, next); renderBackupsList(); }
  catch (error) { alertDialog(`Couldn't save that label: ${error.message}`, { variant: 'error' }); }
}

async function pinBackupFile(backup) {
  try { await window.api.setBackupPinned(backup.file, !backup.pinned); renderBackupsList(); }
  catch (error) { alertDialog(`Couldn't update that snapshot: ${error.message}`, { variant: 'error' }); }
}

async function deleteBackupFile(backup) {
  if (!(await confirmDialog(`Permanently delete the snapshot from ${formatBackupTimestamp(backup.mtimeMs)}? This can't be undone — it only removes this one backup file, not your live config.`))) return;
  try {
    await window.api.deleteBackup(backup.file);
    if (selectedBackupFile === backup.file) selectedBackupFile = null;
    renderBackupsList();
  } catch (error) { alertDialog(`Delete failed: ${error.message}`, { variant: 'error' }); }
}

function renderBackupDetail(backup) {
  const detailEl = document.getElementById('backups-detail');
  if (!detailEl) return;
  detailEl.innerHTML = '';
  if (!backup) return;
  const card = document.createElement('div');
  card.className = 'backup-detail';

  const heading = document.createElement('div');
  heading.className = 'backup-row-time';
  heading.textContent = formatRelativeTime(backup.mtimeMs);
  if (backup.pinned) heading.prepend('★ ');
  const reason = document.createElement('span');
  reason.className = `backup-reason-tag backup-reason-${backup.reason || 'automatic'}`;
  reason.textContent = BACKUP_REASON_LABELS[backup.reason] || 'AUTO-SAVE';
  heading.appendChild(reason);
  const detailLine = document.createElement('div');
  detailLine.className = 'backup-row-detail';
  detailLine.textContent = `${formatBackupTimestamp(backup.mtimeMs)} · ${Math.max(1, Math.round(backup.size / 1024))} KB${backup.label ? ` · ${backup.label}` : ''}`;

  const actions = document.createElement('div');
  actions.className = 'block-row backup-detail-actions';
  actions.append(
    button('RESTORE', () => restoreBackupFile(backup), 'btn btn-primary'),
    button(backup.label ? 'RELABEL' : '+ LABEL', () => labelBackupFile(backup)),
    button(backup.pinned ? 'UNPIN' : 'PIN', () => pinBackupFile(backup)),
    button('DELETE', () => deleteBackupFile(backup), 'btn remove-btn'),
  );

  const previewEl = document.createElement('div');
  previewEl.className = 'backup-preview';
  previewEl.setAttribute('aria-live', 'polite');
  previewEl.textContent = 'COMPARING WITH YOUR CURRENT CONFIG…';
  card.append(heading, detailLine, actions, previewEl);
  detailEl.appendChild(card);

  // What restoring would change, shown right away (was a PREVIEW dialog).
  const token = ++previewToken;
  window.api.previewBackup(backup.file).then((preview) => {
    if (token !== previewToken) return;
    previewEl.innerHTML = '';
    previewLines(preview).forEach((line) => {
      const lineEl = document.createElement('div');
      lineEl.textContent = line;
      previewEl.appendChild(lineEl);
    });
  }).catch((error) => {
    if (token === previewToken) previewEl.textContent = `Couldn't compare that snapshot: ${error.message}`;
  });
}

export function renderBackupsList() {
  window.api.listBackups().then((backups) => {
    backupsListEl.innerHTML = '';
    if (!backups || !backups.length) {
      backupsListEl.appendChild(emptyState('No backups yet. One is taken automatically each time RerunTV starts.',
        { label: '+ SNAPSHOT NOW', run: () => backupsSnapshotNowBtn.click() }));
      renderBackupDetail(null);
      return;
    }
    if (justSnapshotted || !backups.some((backup) => backup.file === selectedBackupFile)) selectedBackupFile = backups[0].file;
    backups.forEach((backup, index) => {
      const selected = backup.file === selectedBackupFile;
      const row = document.createElement('div');
      row.className = `block-row backup-list-item${selected ? ' selected' : ''}`;
      row.dataset.backupFile = backup.file;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
      if (justSnapshotted && index === 0) row.classList.add('reveal');
      const label = document.createElement('div');
      label.className = 'backup-row-info';
      const timestamp = document.createElement('div');
      timestamp.className = 'backup-row-time';
      timestamp.textContent = formatRelativeTime(backup.mtimeMs);
      if (backup.pinned) timestamp.prepend('★ ');
      const reason = document.createElement('span');
      reason.className = `backup-reason-tag backup-reason-${backup.reason || 'automatic'}`;
      reason.textContent = BACKUP_REASON_LABELS[backup.reason] || 'AUTO-SAVE';
      timestamp.appendChild(reason);
      label.appendChild(timestamp);
      const detail = document.createElement('div');
      detail.className = 'backup-row-detail';
      detail.textContent = `${formatBackupTimestamp(backup.mtimeMs)} · ${Math.max(1, Math.round(backup.size / 1024))} KB`;
      label.appendChild(detail);
      if (backup.label) {
        const tag = document.createElement('span');
        tag.className = 'backup-label-tag';
        tag.textContent = backup.label;
        label.appendChild(tag);
      }
      row.appendChild(label);
      row.dataset.rowMenu = '';
      row.appendChild(MenuButton({
        label: `Actions for the snapshot from ${formatBackupTimestamp(backup.mtimeMs)}`,
        groups: [
          [{ label: 'Restore…', run: () => restoreBackupFile(backup) }],
          [
            { label: backup.label ? 'Relabel…' : 'Add label…', run: () => labelBackupFile(backup) },
            { label: backup.pinned ? 'Unpin' : 'Pin', run: () => pinBackupFile(backup) },
          ],
          [{ label: 'Delete snapshot…', run: () => deleteBackupFile(backup), danger: true }],
        ],
      }).button);
      row.addEventListener('click', (event) => {
        if (event.target.closest('.row-menu-btn')) return;
        selectedBackupFile = backup.file;
        backupsListEl.querySelectorAll('.backup-list-item').forEach((item) => {
          const on = item.dataset.backupFile === backup.file;
          item.classList.toggle('selected', on);
          item.setAttribute('aria-selected', String(on));
          item.tabIndex = on ? 0 : -1;
        });
        renderBackupDetail(backup);
      });
      row.addEventListener('keydown', (event) => {
        const items = Array.from(backupsListEl.querySelectorAll('.backup-list-item'));
        const at = items.indexOf(row);
        const target = event.key === 'ArrowDown' ? items[at + 1] : event.key === 'ArrowUp' ? items[at - 1] : null;
        if (!target) return;
        event.preventDefault();
        target.click();
        target.focus();
      });
      backupsListEl.appendChild(row);
      if (selected) renderBackupDetail(backup);
    });
    justSnapshotted = false;
  });
}

export function initBackups(onRestore) {
  restoreHandler = onRestore;
  backupsRefreshBtn.addEventListener('click', renderBackupsList);
  backupsSnapshotNowBtn.addEventListener('click', async () => {
    backupsSnapshotNowBtn.disabled = true;
    try {
      const file = await window.api.createBackupNow();
      if (!file) { alertDialog('Nothing to snapshot yet — there\'s no config on disk (a fresh install before the first save).'); return; }
      const label = await promptDialog({ title: 'SNAPSHOT CREATED', message: 'Label this snapshot (optional):' });
      if (label && label.trim()) await window.api.setBackupLabel(file, label);
      justSnapshotted = true;
      renderBackupsList();
    } catch (error) {
      alertDialog(`Snapshot failed: ${error.message}`, { variant: 'error' });
    } finally {
      backupsSnapshotNowBtn.disabled = false;
    }
  });
}
