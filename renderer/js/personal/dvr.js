// Expands personal DVR rules against the pure schedule (docs/design/09 §4).
// Data only: the tape-deck service performs capture, while this planner is
// shared by UI previews and the background scheduler.
import { querySchedule } from '../core/schedule-query.js';
import { getDisplayTitle } from '../core/util.js';

export const DVR_WINDOW_DAYS = 14;

function seriesKey(file) { return (file.series && (file.series.id || file.series.name)) || file.item || null; }
function airingKey(channel, entry) { return `${channel.number}|${entry.start}|${entry.end}|${entry.file.item || entry.file.path}`; }

export function expandRecordingRequests(requests, channels, from, to = from + DVR_WINDOW_DAYS * 86400000) {
  const airings = [];
  const seen = new Set();
  (requests || []).filter((request) => request && request.enabled !== false).forEach((request) => {
    const channel = (channels || []).find((entry) => entry.number === request.channel);
    if (!channel) return;
    const programs = querySchedule(channel, from, to, { breaks: request.breaks !== 'program', offAir: false }).programs;
    programs.forEach((entry) => {
      if (Number.isFinite(request.createdAt) && entry.end <= request.createdAt) return;
      let matches = false;
      if (request.type === 'airing') matches = entry.start === request.start && entry.end === request.end;
      else if (request.type === 'series') matches = seriesKey(entry.file) === request.seriesId;
      else if (request.type === 'slot') {
        const wanted = new Date(request.start); const actual = new Date(entry.start);
        matches = wanted.getDay() === actual.getDay() && wanted.getHours() === actual.getHours();
      } else if (request.type === 'keyword') matches = getDisplayTitle(entry.file).toLowerCase().includes(String(request.keyword || '').toLowerCase());
      if (!matches) return;
      const key = airingKey(channel, entry);
      if (seen.has(key)) return;
      seen.add(key);
      airings.push({ key, requestId: request.id, channel: channel.number, start: entry.start, end: entry.end, title: getDisplayTitle(entry.file), breaks: request.breaks || 'as-aired' });
    });
  });
  return airings.sort((a, b) => a.start - b.start || a.channel - b.channel);
}

export function recordingConflicts(airings, tunerLimit = 0) {
  if (!Number.isInteger(tunerLimit) || tunerLimit < 1) return [];
  return (airings || []).filter((airing, index, all) => {
    const simultaneous = all.filter((other) => other.start < airing.end && other.end > airing.start);
    return simultaneous.length > tunerLimit && simultaneous.slice(tunerLimit).includes(airing);
  });
}
