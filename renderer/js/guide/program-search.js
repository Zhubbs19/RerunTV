import { querySchedule } from '../core/schedule-query.js';
import { getDisplayTitle } from '../core/util.js';

function searchableText(file) {
  return [file && getDisplayTitle(file), file && file.description, ...((file && file.tags) || [])]
    .filter(Boolean).join(' ').toLocaleLowerCase();
}

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
