// AUDIO & SYSTEM backup list, labeling, restore, deletion, and snapshots.
import { backupsListEl, backupsRefreshBtn, backupsSnapshotNowBtn } from './dom.js';
import { alertDialog, confirmDialog, promptDialog } from './setup-dialogs.js';

let justSnapshotted = false;
let restoreHandler = null;

function formatBackupTimestamp(mtimeMs) {
  const d = new Date(mtimeMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function renderBackupsList() {
  window.api.listBackups().then((backups) => {
    backupsListEl.innerHTML = '';
    if (!backups || !backups.length) {
      const empty = document.createElement('div');
      empty.className = 'titles-empty';
      empty.textContent = 'NO BACKUPS YET — ONE IS TAKEN AUTOMATICALLY AT THE START OF EACH SESSION.';
      backupsListEl.appendChild(empty);
      return;
    }
    backups.forEach((backup, index) => {
      const row = document.createElement('div');
      row.className = 'block-row';
      if (justSnapshotted && index === 0) row.classList.add('reveal');
      const label = document.createElement('span');
      label.className = 'block-count';
      label.textContent = `${formatBackupTimestamp(backup.mtimeMs)} (${Math.max(1, Math.round(backup.size / 1024))} KB)`;
      if (backup.label) {
        const tag = document.createElement('span');
        tag.className = 'backup-label-tag';
        tag.textContent = backup.label;
        label.appendChild(tag);
      }
      row.appendChild(label);
      const labelBtn = document.createElement('button');
      labelBtn.className = 'btn';
      labelBtn.textContent = backup.label ? 'RELABEL' : '+ LABEL';
      labelBtn.addEventListener('click', async () => {
        const next = await promptDialog({ title: 'BACKUP LABEL', message: 'Label this backup — blank to clear:', defaultValue: backup.label || '' });
        if (next === null) return;
        try { await window.api.setBackupLabel(backup.file, next); renderBackupsList(); }
        catch (error) { alertDialog(`Couldn't save that label: ${error.message}`, { variant: 'error' }); }
      });
      row.appendChild(labelBtn);
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn';
      restoreBtn.textContent = 'RESTORE';
      restoreBtn.addEventListener('click', async () => {
        if (!(await confirmDialog({ message: `Restore the snapshot from ${formatBackupTimestamp(backup.mtimeMs)}? This replaces everything currently loaded — a snapshot of the current state is taken first, so this itself can be undone.`, danger: false, confirmText: 'RESTORE' }))) return;
        try { if (restoreHandler) restoreHandler(await window.api.restoreBackup(backup.file)); }
        catch (error) { alertDialog(`Restore failed: ${error.message}`, { variant: 'error' }); }
      });
      row.appendChild(restoreBtn);
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn remove-btn';
      deleteBtn.textContent = 'DELETE';
      deleteBtn.addEventListener('click', async () => {
        if (!(await confirmDialog(`Permanently delete the snapshot from ${formatBackupTimestamp(backup.mtimeMs)}? This can't be undone — it only removes this one backup file, not your live config.`))) return;
        try { await window.api.deleteBackup(backup.file); renderBackupsList(); }
        catch (error) { alertDialog(`Delete failed: ${error.message}`, { variant: 'error' }); }
      });
      row.appendChild(deleteBtn);
      backupsListEl.appendChild(row);
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
