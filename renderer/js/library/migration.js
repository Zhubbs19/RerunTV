// Building the media library from the live lineup, renderer half
// (docs/design/07 §7). main/library/migrate.js plans and finalizes; this
// verifies the plan with the real schedule math and, once the host has saved
// the library, attaches the item ids to the live config.
//
// DOM-free, so tests drive it with a plain S.config.
import { S } from '../core/state.js';
import { diffSchedules } from '../core/schedule-query.js';

export const MIGRATION_WINDOW_DAYS = 60;
const DAY_MS = 24 * 3600 * 1000;

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Checks every channel in a migration plan against the live one with
 * diffSchedules over `days`, breaks included. Box-wide programming for the
 * "before" side is read from S.config, so this must be the config the plan was
 * made from.
 *
 * The window is walked in chunks with a yield between them: 60 days of a
 * 1,300-file channel is seconds of work, and the setup screen has to keep
 * painting its progress line. Chunked diffs are exact — an airing that spans a
 * chunk edge appears, with its real start, on both sides of both chunks.
 *
 * `isStale()` is checked between chunks; when config changed underneath the
 * plan, the check stops with an error rather than verifying the wrong thing.
 *
 * Returns { verdicts, rows }. `verdicts` is what finalizeMigration takes.
 */
export async function verifyMigrationPlan(plan, {
  fromMs, days = MIGRATION_WINDOW_DAYS, chunkDays = 5, onProgress = null, pause = yieldToUi, isStale = () => false,
} = {}) {
  const verdicts = {};
  const rows = [];
  const live = S.config.channels || [];
  for (let c = 0; c < live.length; c += 1) {
    const before = live[c];
    const after = (plan.config.channels || []).find((ch) => ch.number === before.number);
    const row = {
      number: before.number, name: before.name || '', files: (before.files || []).length,
      identical: true, added: 0, removed: 0, breaks: 0, offAir: 0, firstChange: null, ms: 0,
    };
    const started = Date.now();
    if (!after) {
      row.identical = false;
      row.firstChange = fromMs;
    } else {
      for (let day = 0; day < days; day += chunkDays) {
        if (isStale()) throw new Error('Channels changed while they were being checked. Check again.');
        const from = fromMs + day * DAY_MS;
        const to = fromMs + Math.min(days, day + chunkDays) * DAY_MS;
        if (onProgress) onProgress({ channel: before.number, name: row.name, index: c, count: live.length, day, days });
        const diff = diffSchedules(before, after, from, to, { breaks: true, afterConfig: plan.config });
        if (!diff.identical) {
          row.identical = false;
          row.added = diff.added.length;
          row.removed = diff.removed.length;
          row.breaks = diff.breaksAdded.length + diff.breaksRemoved.length;
          row.offAir = diff.offAirChanged.length;
          row.firstChange = diff.changed.length ? diff.changed[0].start : from;
          // One changed chunk is enough to reject the channel.
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await pause();
      }
    }
    row.ms = Date.now() - started;
    verdicts[before.number] = { identical: row.identical };
    rows.push(row);
  }
  return { verdicts, rows };
}

function playlistPairs(live, planned) {
  const pairs = [[live.files || [], planned.files || [], `CH ${live.number}`]];
  (planned.blocks || []).forEach((block) => {
    if (!Array.isArray(block.files) || !block.files.length) return;
    const liveBlock = (live.blocks || []).find((b) => b.id === block.id);
    pairs.push([liveBlock ? liveBlock.files || [] : null, block.files, `CH ${live.number} block ${block.id}`]);
  });
  return pairs;
}

/**
 * Attaches a finalized migration's item ids and fileOverrides to the live
 * config, in place, for the accepted channels only. All or nothing: every
 * playlist is checked against the plan first, and if any path or length
 * differs — config changed after the check — nothing is written.
 *
 * Paths, durations, order and anchors are never written here; only `item`
 * and `fileOverrides`. The caller records the change with commitConfigPatch.
 */
export function applyMigrationIds(config, finalConfig, accepted) {
  const acceptedSet = new Set((accepted || []).map(Number));
  const writes = [];
  (finalConfig.channels || []).forEach((planned) => {
    if (!acceptedSet.has(Number(planned.number))) return;
    const live = (config.channels || []).find((ch) => ch.number === planned.number);
    if (!live) throw new Error(`CH ${planned.number} is no longer in the lineup.`);
    playlistPairs(live, planned).forEach(([liveFiles, plannedFiles, label]) => {
      if (!liveFiles || liveFiles.length !== plannedFiles.length) throw new Error(`${label} changed after it was checked.`);
      plannedFiles.forEach((file, i) => {
        if (liveFiles[i].path !== file.path) throw new Error(`${label} changed after it was checked.`);
        if (file.item) writes.push(() => { liveFiles[i].item = file.item; });
      });
    });
    if (planned.fileOverrides && Object.keys(planned.fileOverrides).length) {
      writes.push(() => { live.fileOverrides = JSON.parse(JSON.stringify(planned.fileOverrides)); });
    }
  });
  writes.forEach((write) => write());
  return { channels: acceptedSet.size, writes: writes.length };
}
