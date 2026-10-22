// SYSTEM / GUIDE panels: program reminders, viewing history, air checks, PC
// shutdown and config backups. Split out of settings.js.
import { applyConfigDefaults } from '../app.js';
import { applyDisplayWakeLock } from '../playback/power.js';
import { S, dispatch, pushUndoSnapshot } from '../core/state.js';
import { SettingRow, syncSettingDependencies } from '../ui/field.js';
import { PC_SHUTDOWN_DELAY_SEC, pcShutdownAvailable, pcShutdownEnabled, setPcShutdownEnabled, setShutsDownPcWithBox, shutsDownPcWithBox } from '../playback/pc-power.js';
import { getChannel } from '../core/channels.js';
import { confirmDialog } from './dialogs.js';
import { initBackups, renderBackupsList as renderBackupsListFeature } from './backups.js';
import { renderCommercialsPanel, renderStandbyPanel } from './interstitials.js';
import { renderChannelList } from './channels.js';
import { reminderAutoTuneEl, reminderNotifyEl, remindersListEl, remindersClearAllBtn, airChecksListEl, airChecksClearAllBtn, keepDisplayAwakeEl, playbackResyncEnabledEl, viewingHistoryEnabledEl, historyListEl, historyTotalTimeEl, historyRowCountEl, historyTopChannelEl, historyTopTitleEl, historyRefreshBtn, historyClearBtn } from '../core/dom.js';
import { airCheckLabel, airChecks, clearAirChecks, removeAirCheck } from '../library/airchecks.js';
import { clearViewingHistory, formatWatchTime, listViewingHistory, summarizeHistory } from '../playback/history.js';
import { currentProfile, personalCommand } from '../personal/state.js';
import { renderSettingsPanels } from './settings.js';

// ---------- Program reminders (GUIDE & THEME) ----------
// Reminders are created from the guide's program search (guide.js's
// addProgramReminder) and used to be invisible from the moment they were set
// until the moment they fired — no list, no way to cancel one added by
// mistake, no way to check whether one was still pending. They live in
// S.config.reminders and clear themselves a few minutes after their own
// program ends (checkProgramReminders, guide.js), so this is a view of
// pending ones only and needs no expiry logic of its own.
export function renderRemindersPanel() {
  if (reminderAutoTuneEl) reminderAutoTuneEl.checked = !!S.config.reminderAutoTune;
  if (reminderNotifyEl) reminderNotifyEl.checked = S.config.reminderNotify !== false;
  if (!remindersListEl) return;
  const reminders = (currentProfile()?.state.reminders || S.config.reminders || []).slice().sort((a, b) => a.start - b.start);
  if (remindersClearAllBtn) remindersClearAllBtn.disabled = !reminders.length;
  remindersListEl.innerHTML = '';
  if (!reminders.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO REMINDERS SET. OPEN THE GUIDE (G), PRESS /, AND SEARCH FOR A PROGRAM.';
    remindersListEl.appendChild(empty);
    return;
  }
  reminders.forEach((reminder) => {
    const row = document.createElement('div');
    row.className = 'block-row';
    const label = document.createElement('span');
    label.className = 'block-count';
    // The channel name is stored on the reminder itself, but a channel
    // renamed since then should read as its current name — fall back to the
    // stored copy only for a channel that no longer exists at all, so a
    // reminder for a deleted channel still says what it was for.
    const channel = getChannel(reminder.channelNumber);
    const name = (channel && channel.name) || reminder.channelName || 'UNNAMED';
    label.textContent = `${reminder.title} — CH ${reminder.channelNumber} · ${name} · ${new Date(reminder.start).toLocaleString()}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'REMOVE';
    remove.addEventListener('click', () => {
      const next = (currentProfile()?.state.reminders || S.config.reminders || []).filter((entry) => entry.id !== reminder.id);
      if (currentProfile()) personalCommand({ type: 'state.set', key: 'reminders', value: next }).then(renderRemindersPanel);
      else dispatch({ type: 'settings.set', path: ['reminders'], value: next }, { label: 'Remove reminder' });
      renderRemindersPanel();
    });
    row.append(label, remove);
    remindersListEl.appendChild(row);
  });
}

reminderAutoTuneEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['reminderAutoTune'], value: reminderAutoTuneEl.checked });
});

reminderNotifyEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['reminderNotify'], value: reminderNotifyEl.checked });
});

remindersClearAllBtn?.addEventListener('click', async () => {
  const count = (currentProfile()?.state.reminders || S.config.reminders || []).length;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'CLEAR REMINDERS',
    message: `Remove all ${count} pending program reminder${count === 1 ? '' : 's'}?`,
    confirmText: 'CLEAR ALL',
  });
  if (!ok) return;
  if (currentProfile()) await personalCommand({ type: 'state.set', key: 'reminders', value: [] });
  else dispatch({ type: 'settings.set', path: ['reminders'], value: [] }, { label: 'Clear reminders' });
  renderRemindersPanel();
});

// ---------- Viewing history (SYSTEM > DIAGNOSTICS) ----------
// Reads from main-history.js's own file rather than from S.config, so this
// panel is the only thing in the setup screen that does its own async fetch
// on render. Kept to the most recent slice: the log holds thousands of rows
// and this is a "what have I been watching" readout, not an audit trail.
const HISTORY_PANEL_ROWS = 40;

export function renderViewingHistoryPanel() {
  if (viewingHistoryEnabledEl) {
    viewingHistoryEnabledEl.checked = !S.config.viewingHistory || S.config.viewingHistory.enabled !== false;
  }
  if (!historyListEl) return;
  listViewingHistory(500).then((entries) => {
    const summary = summarizeHistory(entries);
    if (historyTotalTimeEl) historyTotalTimeEl.textContent = summary.rowCount ? formatWatchTime(summary.totalMs) : '—';
    if (historyRowCountEl) historyRowCountEl.textContent = summary.rowCount ? String(summary.rowCount) : '—';
    if (historyTopChannelEl) {
      const top = summary.channels[0];
      historyTopChannelEl.textContent = top ? `CH ${top.number}${top.name ? ` ${top.name}` : ''}` : '—';
    }
    if (historyTopTitleEl) {
      const top = summary.titles[0];
      historyTopTitleEl.textContent = top && top.title ? top.title : '—';
    }
    historyListEl.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'titles-empty';
      empty.textContent = 'NOTHING LOGGED YET. WATCH SOMETHING AND COME BACK.';
      historyListEl.appendChild(empty);
      return;
    }
    entries.slice(0, HISTORY_PANEL_ROWS).forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'block-row';
      const label = document.createElement('span');
      label.className = 'block-count';
      const when = new Date(entry.at).toLocaleString();
      const name = entry.channelName ? ` ${entry.channelName}` : '';
      label.textContent = `${when} · CH ${entry.channelNumber}${name} · ${entry.title || 'UNTITLED'}`;
      row.appendChild(label);
      historyListEl.appendChild(row);
    });
  }).catch(() => {});
}

viewingHistoryEnabledEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['viewingHistory', 'enabled'], value: viewingHistoryEnabledEl.checked });
});

historyRefreshBtn?.addEventListener('click', () => renderViewingHistoryPanel());

historyClearBtn?.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'CLEAR VIEWING HISTORY',
    message: 'Delete the whole log of what this box has played? This cannot be undone — the log is not part of your config, so config backups do not contain it.',
    confirmText: 'CLEAR HISTORY',
  });
  if (!ok) return;
  await clearViewingHistory();
  renderViewingHistoryPanel();
});

// ---------- Air checks (SYSTEM > AIR CHECK) ----------
// The TV menu offers the most recent few as one-press recalls; this is the
// full list, and the only place a mark can be deleted. Same shape as the
// reminders list above on purpose — both are "things you marked while
// watching that you may want to undo later".
export function renderAirChecksPanel() {
  if (!airChecksListEl) return;
  const marks = airChecks();
  if (airChecksClearAllBtn) airChecksClearAllBtn.disabled = !marks.length;
  airChecksListEl.innerHTML = '';
  if (!marks.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO AIR CHECKS MARKED. PRESS X WHILE WATCHING TO MARK THE MOMENT.';
    airChecksListEl.appendChild(empty);
    return;
  }
  marks.forEach((mark) => {
    const row = document.createElement('div');
    row.className = 'block-row';
    const label = document.createElement('span');
    label.className = 'block-count';
    const channel = getChannel(mark.channelNumber);
    const name = (channel && channel.name) || mark.channelName || 'UNNAMED';
    label.textContent = `${airCheckLabel(mark)} · ${name} · ${new Date(mark.at).toLocaleDateString()}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'REMOVE';
    remove.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'REMOVE AIR CHECK', message: `Remove "${airCheckLabel(mark)}" from your marked moments?`, confirmText: 'REMOVE', danger: true }))) return;
      removeAirCheck(mark.id);
      renderAirChecksPanel();
    });
    row.append(label, remove);
    airChecksListEl.appendChild(row);
  });
}

airChecksClearAllBtn?.addEventListener('click', async () => {
  const count = airChecks().length;
  if (!count) return;
  const ok = await confirmDialog({
    title: 'CLEAR AIR CHECKS',
    message: `Remove all ${count} marked moment${count === 1 ? '' : 's'}?`,
    confirmText: 'CLEAR ALL',
  });
  if (!ok) return;
  clearAirChecks();
  renderAirChecksPanel();
});

keepDisplayAwakeEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['keepDisplayAwake', 'enabled'], value: keepDisplayAwakeEl.checked });
  // Applied immediately rather than at the next power transition — the
  // setting is only meaningful as a live claim on the OS, so leaving the old
  // one held until the next standby would read as the toggle not working.
  applyDisplayWakeLock();
});

playbackResyncEnabledEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['playbackResync', 'enabled'], value: playbackResyncEnabledEl.checked });
});

// ---------- PC shutdown (SYSTEM › POWER, playback/pc-power.js) ----------
// Two kit rows (ui/field.js) after "Keep the display awake". Host window
// only: a LAN viewer or control client has no window.api.shutdownPc, and the
// rows simply do not exist there.
const pcShutdownEnabledEl = document.createElement('input');
pcShutdownEnabledEl.type = 'checkbox';
pcShutdownEnabledEl.id = 'pc-shutdown-enabled';
const pcShutdownWithBoxEl = document.createElement('input');
pcShutdownWithBoxEl.type = 'checkbox';
pcShutdownWithBoxEl.id = 'pc-shutdown-with-box';
if (keepDisplayAwakeEl && pcShutdownAvailable()) {
  const anchor = keepDisplayAwakeEl.closest('.setting-row');
  const rows = [
    SettingRow({
      key: 'pc-shutdown-enabled',
      label: 'Allow shutting down the PC from RerunTV',
      control: pcShutdownEnabledEl,
      help: `Adds SHUT DOWN PC to the TV menu and to the companion remote. It always counts down ${PC_SHUTDOWN_DELAY_SEC} seconds first, with CANCEL on the screen and on the remote.`,
      synonyms: 'shut down shutdown computer turn off pc machine power windows remote',
    }),
    SettingRow({
      key: 'pc-shutdown-with-box',
      label: 'Shut down the PC when the box is turned off',
      control: pcShutdownWithBoxEl,
      dependsOn: 'pc-shutdown-enabled',
      help: 'Power off (P, the remote’s power button or the TV menu) also shuts the computer down. Auto standby and the screen turning off never do.',
      synonyms: 'shut down computer power key standby off',
    }),
  ];
  rows.forEach((row) => row.setAttribute('data-simple-settings', ''));
  if (anchor) anchor.after(...rows);
  pcShutdownEnabledEl.addEventListener('change', () => {
    setPcShutdownEnabled(pcShutdownEnabledEl.checked);
    syncSettingDependencies(document);
  });
  pcShutdownWithBoxEl.addEventListener('change', () => setShutsDownPcWithBox(pcShutdownWithBoxEl.checked));
}

export function renderPcShutdownRows() {
  pcShutdownEnabledEl.checked = pcShutdownEnabled();
  pcShutdownWithBoxEl.checked = shutsDownPcWithBox();
  syncSettingDependencies(document);
}

// ---------- Config backups (AUDIO & SYSTEM tab) ----------
// See main.js's backupCurrentConfig/listBackups/restoreBackup — rotating,
// rate-limited snapshots of channels.json taken automatically at session
// start and at most every 15 minutes during active editing.
// Set right before a renderBackupsList() triggered by an actual new
// snapshot, so only that row plays a reveal — not every row on a plain
// refresh/tab-switch re-list (listBackups sorts newest-first, so a new
// snapshot is always index 0).
export function renderBackupsList() {
  return renderBackupsListFeature();
}
initBackups((restored) => {
  S.config = applyConfigDefaults(restored);
  pushUndoSnapshot();
  renderChannelList();
  renderCommercialsPanel();
  renderStandbyPanel();
  renderSettingsPanels();
});
