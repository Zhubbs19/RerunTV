// Viewing history — the renderer half of main-history.js.
//
// One row per programme that actually reached the screen, written as it
// starts rather than as it ends: the box has no "finished watching" event to
// hang a row off (a channel change, a power-off, or simply closing the app
// all end a programme silently), and a row that only exists for things
// watched to completion would miss most of what a person actually saw.
//
// Recorded on the host only. The LAN viewer's api surface deliberately omits
// these methods (api-contract.js) — the log describes what this box played,
// and a viewer writing into it would conflate two different screens.
import { S, viewNow } from '../core/state.js';
import { getDisplayTitle } from '../core/util.js';

export function recordViewing(ch, file) {
  if (!window.api || typeof window.api.historyAppend !== 'function') return;
  if (!ch || !file) return;
  Promise.resolve(window.api.historyAppend({
    // Both clocks: `at` is when this was really watched, which is what a
    // "last week" readout needs, while `viewAt` is where it sat in the
    // simulated schedule, which is what makes a row from a time-shifted
    // session intelligible rather than looking like a clock error.
    at: Date.now(),
    viewAt: viewNow(),
    channelNumber: ch.number,
    channelName: ch.name || '',
    title: getDisplayTitle(file),
    path: file.path || '',
    durationS: Number(file.duration) || 0,
  })).catch(() => {});
}

export function listViewingHistory(limit) {
  if (!window.api || typeof window.api.historyList !== 'function') return Promise.resolve([]);
  return Promise.resolve(window.api.historyList(limit)).catch(() => []);
}

export function clearViewingHistory() {
  if (!window.api || typeof window.api.historyClear !== 'function') return Promise.resolve(false);
  return Promise.resolve(window.api.historyClear()).catch(() => false);
}

// Watch time is an estimate, and honestly so: the log knows when a programme
// started and how long the file runs, not when the viewer wandered off. The
// gap to the next row is the better signal where there is one — it caps a
// programme's contribution at however long the box actually stayed on it —
// with the file's own duration as the fallback for the most recent row and
// for any row followed by a long idle gap.
const MAX_UNCAPPED_GAP_MS = 6 * 60 * 60 * 1000;

export function summarizeHistory(entries) {
  const rows = (entries || []).slice().sort((a, b) => a.at - b.at);
  const byChannel = new Map();
  const byTitle = new Map();
  let totalMs = 0;
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    const gap = next ? next.at - row.at : Infinity;
    const fileMs = (row.durationS || 0) * 1000;
    const watched = (gap < MAX_UNCAPPED_GAP_MS) ? Math.min(gap, fileMs || gap) : fileMs;
    if (!Number.isFinite(watched) || watched <= 0) return;
    totalMs += watched;
    const channelKey = `${row.channelNumber}`;
    const channel = byChannel.get(channelKey) || { number: row.channelNumber, name: row.channelName, ms: 0, plays: 0 };
    channel.ms += watched;
    channel.plays += 1;
    if (row.channelName) channel.name = row.channelName;
    byChannel.set(channelKey, channel);
    const title = byTitle.get(row.title) || { title: row.title, ms: 0, plays: 0 };
    title.ms += watched;
    title.plays += 1;
    byTitle.set(row.title, title);
  });
  const desc = (a, b) => b.ms - a.ms;
  return {
    rowCount: rows.length,
    totalMs,
    firstAt: rows.length ? rows[0].at : null,
    channels: Array.from(byChannel.values()).sort(desc),
    titles: Array.from(byTitle.values()).sort(desc),
  };
}

export function formatWatchTime(ms) {
  const totalMinutes = Math.round((ms || 0) / 60000);
  if (totalMinutes < 60) return `${totalMinutes} MIN`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} HR ${minutes} MIN` : `${hours} HR`;
}

// Kept as a function rather than read at import time so a config change
// takes effect without a reload, same as every other setting.
export function historyEnabled() {
  return !S.config.viewingHistory || S.config.viewingHistory.enabled !== false;
}
