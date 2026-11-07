// Program search for the guide: finds upcoming airings across the lineup
// whose title, description or tags match what was typed.

import { querySchedule } from '../core/schedule-query.js';
import { getDisplayTitle } from '../core/util.js';

/**
 * Builds the lower-cased text a program search matches against.
 * @param {?object} file The channel file.
 * @returns {string} Title, description and tags joined.
 */
function searchableText(file) {
  return [file && getDisplayTitle(file), file && file.description, ...((file && file.tags) || [])]
    .filter(Boolean).join(' ').toLocaleLowerCase();
}

/**
 * Tells whether any file a channel could air matches the query.
 * Lets a search skip expanding the schedule of a channel that can't match.
 * @param {object} channel The channel config.
 * @param {string} query The lower-cased query.
 * @returns {boolean} True when some file or block title contains the query.
 */
function channelCouldMatch(channel, query) {
  const files = [...(channel.files || [])];
  (channel.blocks || []).forEach((block) => {
    files.push(...(block.files || []));
    Object.values(block.dayOverrides || {}).forEach((override) => {
      if (override && override.title) files.push({ title: override.title });
    });
  });
  return files.some((file) => searchableText(file).includes(query));
}

/**
 * Finds upcoming airings whose title, description or tags contain the query.
 * @param {Array<object>} channels Channel configs to search.
 * @param {string} query The search text; under 2 characters returns nothing.
 * @param {number} fromMs Start of the search window, epoch ms.
 * @param {object} [opts] Options.
 * @param {number} [opts.horizonMs] How far ahead to search; defaults to seven days.
 * @param {number} [opts.limit=80] The most results returned.
 * @returns {Array<object>} `{ channel, entry, title }` sorted by start time, then channel number.
 */
export function searchUpcomingPrograms(channels, query, fromMs, { horizonMs = 7 * 86400000, limit = 80 } = {}) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (q.length < 2) return [];
  const endMs = fromMs + horizonMs;
  const results = [];
  const seen = new Set();
  for (const channel of channels) {
    // Seven days of a short-form channel can be thousands of schedule rows.
    // Skip schedule expansion entirely when none of its possible source
    // files can match the query.
    if (!channelCouldMatch(channel, q)) continue;
    // Cached per day (schedule-query.js), so the next keystroke's search over
    // the same seven days reuses them instead of re-expanding every channel.
    const schedule = querySchedule(channel, fromMs, endMs, { breaks: false, offAir: false }).programs;
    for (const entry of schedule) {
      const title = getDisplayTitle(entry.file);
      const haystack = searchableText(entry.file);
      if (!haystack.includes(q)) continue;
      const key = `${channel.number}|${entry.start}|${entry.file && entry.file.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ channel, entry, title });
    }
  }
  return results.sort((a, b) => a.entry.start - b.entry.start || a.channel.number - b.channel.number).slice(0, limit);
}
