// Expands the selected profile's requests over a rolling 14-day window and
// hands one unprocessed airing at a time to the existing tape-deck recorder.
import { S, viewNow } from '../core/state.js';
import { getChannel } from '../core/channels.js';
import { getRendererService } from '../plugin/host.js';
import { personalCall } from './state.js';
import { DVR_WINDOW_DAYS, expandRecordingRequests, recordingConflicts } from './dvr.js';

const TICK_MS = 30000;
let timer = null;
let running = false;
const pendingJobs = new Map();

async function commandFor(profileId, command) {
  let profile = await personalCall('getProfile', { id: profileId });
  let result = await personalCall('command', { profileId, baseRevision: profile.revision, command });
  if (!result.ok) {
    profile = result.profile || await personalCall('getProfile', { id: profileId });
    result = await personalCall('command', { profileId, baseRevision: profile.revision, command });
  }
  if (!result.ok) throw new Error('The profile changed while updating its recording.');
  return result.profile;
}

async function updateResumePoints(deck) {
  const playing = typeof deck.nowPlaying === 'function' ? deck.nowPlaying() : null;
  if (!playing?.tapeId || !Number.isFinite(playing.positionMs)) return;
  const profiles = await personalCall('listProfiles');
  for (const summary of profiles) {
    const profile = await personalCall('getProfile', { id: summary.id });
    const ownsTape = Object.values(profile.state.recordings || {}).some((recording) => recording.tapeId === playing.tapeId);
    if (!ownsTape) continue;
    const previous = profile.state.resumePoints?.[`tape:${playing.tapeId}`];
    if (previous && Math.abs(previous.positionMs - playing.positionMs) < 5000 && previous.watched === (playing.durationMs > 0 && playing.positionMs >= playing.durationMs * 0.9)) continue;
    await commandFor(profile.id, {
      type: 'resume.set', key: `tape:${playing.tapeId}`, positionMs: playing.positionMs,
      durationMs: playing.durationMs, watched: playing.durationMs > 0 && playing.positionMs >= playing.durationMs * 0.9,
    });
  }
}

async function enforceRetention(profile, tapes, deck) {
  const policy = profile.state.dvrPolicy || {};
  const tapeById = new Map(tapes.map((tape) => [tape.id, tape]));
  const rows = Object.entries(profile.state.recordings || {})
    .filter(([, recording]) => recording.status === 'ready' && recording.tapeId && tapeById.has(recording.tapeId))
    .map(([key, recording]) => ({ key, recording, tape: tapeById.get(recording.tapeId) }));
  const removeKeys = new Set();
  // Retention is filesystem housekeeping against real elapsed days, so it
  // intentionally does not move when the viewer uses the time machine.
  const watchedCutoff = Date.now() - Math.max(0, Number(policy.deleteWatchedAfterDays) || 0) * 86400000;
  if (Number(policy.deleteWatchedAfterDays) > 0) rows.forEach((row) => {
    const resume = profile.state.resumePoints?.[`tape:${row.recording.tapeId}`];
    if (resume?.watched && resume.updatedAt <= watchedCutoff) removeKeys.add(row.key);
  });
  if (Number(policy.keepEpisodes) > 0) {
    const byRequest = new Map();
    rows.forEach((row) => {
      if (!row.recording.requestId) return;
      if (!byRequest.has(row.recording.requestId)) byRequest.set(row.recording.requestId, []);
      byRequest.get(row.recording.requestId).push(row);
    });
    byRequest.forEach((group) => group.sort((a, b) => b.recording.start - a.recording.start)
      .slice(Number(policy.keepEpisodes)).forEach((row) => removeKeys.add(row.key)));
  }
  const quotaBytes = Math.max(0, Number(policy.quotaGb) || 0) * 1024 ** 3;
  if (quotaBytes > 0) {
    let total = rows.reduce((sum, row) => sum + (Number(row.tape.bytes) || 0), 0);
    rows.slice().sort((a, b) => {
      const aw = profile.state.resumePoints?.[`tape:${a.recording.tapeId}`]?.watched ? 0 : 1;
      const bw = profile.state.resumePoints?.[`tape:${b.recording.tapeId}`]?.watched ? 0 : 1;
      return aw - bw || a.recording.start - b.recording.start;
    }).forEach((row) => {
      if (total <= quotaBytes) return;
      removeKeys.add(row.key);
      total -= Number(row.tape.bytes) || 0;
    });
  }
  for (const key of removeKeys) {
    const recording = profile.state.recordings[key];
    if (recording?.tapeId) await deck.delete(recording.tapeId);
    profile = await commandFor(profile.id, { type: 'recording.remove', key });
  }
  return profile;
}

async function tick() {
  if (running || window.__isViewer) return;
  const deck = getRendererService('tape-deck');
  if (!deck || typeof deck.record !== 'function') return;
  await updateResumePoints(deck);
  // Real clock on purpose (background-tick exception to viewNow()): a recording is
  // an appointment with the actual broadcast, whatever the time machine shows.
  const from = Date.now() - 24 * 3600000; // captures an airing already in progress
  running = true;
  try {
    const summaries = await personalCall('listProfiles');
    const tapeResult = typeof deck.list === 'function' ? await deck.list() : { tapes: [] };
    const tapes = tapeResult?.tapes || [];
    const status = typeof deck.status === 'function' ? deck.status() : null;
    const liveJobIds = new Set([status?.active?.id, ...(status?.queued || []).map((job) => job.id)].filter(Boolean));
    for (const summary of summaries) {
      let profile = await personalCall('getProfile', { id: summary.id });
      profile = await enforceRetention(profile, tapes, deck);
      const stranded = Object.entries(profile.state.recordings || {}).find(([, recording]) => recording.status === 'queued' && !liveJobIds.has(recording.jobId));
      if (stranded) {
        const [key, recording] = stranded;
        const tape = tapes.find((entry) => entry.id === recording.jobId);
        profile = await commandFor(profile.id, tape
          ? { type: 'recording.complete', key, tapeId: tape.id, title: recording.title, channel: recording.channel, start: recording.start, end: recording.end }
          : { type: 'recording.forget', key });
      }
      const airings = expandRecordingRequests(profile.state.recordingRequests, S.config.channels, from, from + DVR_WINDOW_DAYS * 86400000);
      const airing = airings.find((entry) => !profile.state.recordings[entry.key]);
      if (!airing) continue;
      const channel = getChannel(airing.channel);
      if (!channel) continue;
      let result;
      try { result = await deck.record({ channel, startMs: airing.start, endMs: airing.end, title: airing.title, breaks: airing.breaks }); }
      catch (e) { result = { error: e.message }; }
      const details = { key: airing.key, requestId: airing.requestId, title: airing.title, channel: airing.channel, start: airing.start, end: airing.end };
      const conflicts = recordingConflicts(airings, profile.state.dvrPolicy?.tunerLimit || 0);
      if (conflicts.some((entry) => entry.key === airing.key)) {
        await commandFor(profile.id, { type: 'recording.complete', ...details, error: 'Simulated tuner conflict.' });
        break;
      }
      if (result?.error || !result?.id) {
        await commandFor(profile.id, { type: 'recording.complete', ...details, error: result?.error || 'Recorder did not return a job id.' });
      } else {
        pendingJobs.set(result.id, { profileId: profile.id, ...details });
        await commandFor(profile.id, { type: 'recording.queued', ...details, jobId: result.id });
      }
      break;
    }
  } finally { running = false; }
}

export function initDvrScheduler() {
  if (timer || window.__isViewer) return;
  window.api.onTapesDone?.((result) => {
    const pending = result?.id ? pendingJobs.get(result.id) : null;
    if (!pending) return;
    pendingJobs.delete(result.id);
    commandFor(pending.profileId, {
      type: 'recording.complete', ...pending,
      tapeId: result.tape?.id || null, error: result.error || (result.cancelled ? 'Recording cancelled.' : null),
    }).catch((e) => console.warn('[dvr] could not finish recording state:', e.message));
  });
  const run = () => tick().catch((e) => console.warn('[dvr] scheduler:', e.message));
  run();
  timer = setInterval(run, TICK_MS);
}
