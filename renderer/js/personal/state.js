// Renderer-side profile state (docs/design/09, contract C5). The host owns
// the files; this module keeps only the currently selected profile in memory
// and sends revision-checked personal commands.
import { S, getClientId } from '../core/state.js';

const DEVICE_KEY = 'reruntv.profileId';
const listeners = new Set();
let beforeSharedSession = null;
let presenceTimer = null;

async function call(method, payload = {}) {
  if (!window.api || typeof window.api.personalCall !== 'function') throw new Error('Profiles are not available on this device.');
  const response = await window.api.personalCall(method, payload);
  if (!response || !response.ok) throw new Error((response && response.error) || 'The profile store did not answer.');
  return response.result;
}

function notify() { listeners.forEach((fn) => fn(S.personalProfile)); }

function clientLabel() {
  if (window.AndroidRemoteBridge) return 'Android TV';
  if (!window.__isViewer) return 'RerunTV host';
  return /mobile|android/i.test(navigator.userAgent) ? 'Mobile browser' : 'LAN viewer';
}

export async function refreshPersonalClients() {
  S.personalClients = await call('presence', {
    action: 'register', clientId: getClientId(), label: clientLabel(), profileId: S.personalProfile?.id,
  });
  return S.personalClients;
}

export async function initPersonalState() {
  try {
    const profiles = await call('listProfiles');
    S.personalProfiles = profiles;
    let selected;
    if (window.__isViewer) {
      selected = await call('getProfile');
    } else {
      const saved = localStorage.getItem(DEVICE_KEY);
      const summary = profiles.find((profile) => profile.id === saved) || profiles[0];
      selected = summary ? await call('getProfile', { id: summary.id }) : null;
    }
    if (selected) {
      S.personalProfile = selected;
      localStorage.setItem(DEVICE_KEY, selected.id);
      S.quickJumpSlots = { ...(S.personalProfile.state.quickJumpSlots || {}) };
    }
    await refreshPersonalClients();
    if (!presenceTimer) presenceTimer = setInterval(() => refreshPersonalClients().catch(() => {}), 15000);
    window.api.onPersonalChanged?.((event) => {
      if (!S.personalProfile || event.profileId !== S.personalProfile.id) return;
      refreshPersonalState().catch(() => {});
    });
    window.api.onClientHandoff?.((event) => {
      if (!event || event.targetClientId !== getClientId()) return;
      S.timeOffsetMs = Number(event.timeOffsetMs) || 0;
      import('../playback/core.js').then(({ tuneToChannel }) => {
        if (event.recording?.tapeId) {
          tuneToChannel(101);
          setTimeout(() => import('../plugin/host.js').then(({ getRendererService }) => {
            getRendererService('tape-deck')?.play?.(event.recording.tapeId, event.recording.positionMs || 0);
          }), 250);
        } else tuneToChannel(event.channel);
      });
    });
    window.api.onSharedSessionChanged?.((session) => {
      if (!session || !Array.isArray(session.members)) return;
      if (!session.members.includes(getClientId())) {
        if (S.sharedSession?.id === session.id) S.sharedSession = null;
        notify();
        return;
      }
      S.sharedSession = session;
      if (Math.abs(S.timeOffsetMs - (Number(session.timeOffsetMs) || 0)) > 250) S.timeOffsetMs = Number(session.timeOffsetMs) || 0;
      if (Number.isFinite(session.channel) && session.channel !== S.currentNumber) import('../playback/core.js').then(({ tuneToChannel }) => tuneToChannel(session.channel, { sharedSync: true }));
    });
  } catch (e) {
    console.warn('[profiles] unavailable:', e.message);
  }
  notify();
  return S.personalProfile;
}

export async function refreshPersonalState() {
  if (!S.personalProfile) return null;
  S.personalProfile = await call('getProfile', { id: S.personalProfile.id });
  S.quickJumpSlots = { ...(S.personalProfile.state.quickJumpSlots || {}) };
  notify();
  return S.personalProfile;
}

export async function switchProfile(id, { pin = null } = {}) {
  const current = S.personalProfile;
  let next;
  if (window.__isViewer) {
    next = await call('selectProfile', { id, pin });
  } else {
    if (current && current.id !== id && current.restriction !== 'none' && current.hasPin) {
      if (!(await call('verifyProfile', { id: current.id, pin }))) throw new Error('The current profile PIN is incorrect.');
    }
    next = await call('getProfile', { id });
  }
  S.personalProfile = next;
  localStorage.setItem(DEVICE_KEY, id);
  S.quickJumpSlots = { ...(next.state.quickJumpSlots || {}) };
  notify();
  refreshPersonalClients().catch(() => {});
  import('../display/themes.js').then(({ applyTheme }) => applyTheme()).catch(() => {});
  return next;
}

export async function personalCommand(command) {
  if (!S.personalProfile) throw new Error('Choose a profile first.');
  const result = await call('command', { profileId: S.personalProfile.id, baseRevision: S.personalProfile.revision, command });
  if (!result.ok) {
    if (result.profile) S.personalProfile = result.profile;
    notify();
    throw new Error('This profile changed on another device. Its latest state has been loaded.');
  }
  S.personalProfile = result.profile;
  notify();
  return result.profile;
}

export function currentProfile() { return S.personalProfile || null; }
export function profiles() { return S.personalProfiles || []; }
export function isFavorite(channelNumber) {
  if (!S.personalProfile) return !!S.config.channels.find((channel) => channel.number === channelNumber)?.favorite;
  return S.personalProfile.state.favorites.includes(channelNumber);
}
export function isHiddenForProfile(channelNumber) {
  const profile = S.personalProfile;
  if (!profile) return false;
  if (profile.state.hiddenChannels.includes(channelNumber)) return true;
  const rating = S.config.channels.find((channel) => channel.number === channelNumber)?.rating || '';
  if (profile.restriction === 'kids') return !['', 'TV-Y', 'TV-Y7', 'TV-G', 'G'].includes(rating);
  if (profile.restriction === 'teen') return ['TV-MA', 'NC-17', 'R'].includes(rating);
  return false;
}
export const toggleFavorite = (channelNumber) => personalCommand({ type: 'favorite.toggle', channel: channelNumber });
export const setFavorite = (channelNumber, value) => personalCommand({ type: 'favorite.set', channel: channelNumber, value });
export function syncSharedTune(channel) {
  const session = S.sharedSession;
  if (!session || session.leader !== getClientId()) return;
  call('session', { action: 'tune', id: session.id, clientId: getClientId(), channel, timeOffsetMs: S.timeOffsetMs }).then((next) => { S.sharedSession = next; }).catch(() => {});
}
export async function startSharedSession() {
  if (!Number.isFinite(S.currentNumber)) throw new Error('Tune to a channel before starting a shared session.');
  beforeSharedSession = { channel: S.currentNumber, timeOffsetMs: S.timeOffsetMs };
  S.sharedSession = await call('session', {
    action: 'start', clientId: getClientId(), channel: S.currentNumber, timeOffsetMs: S.timeOffsetMs,
  });
  notify();
  return S.sharedSession;
}
export async function joinSharedSession(id) {
  beforeSharedSession = { channel: S.currentNumber, timeOffsetMs: S.timeOffsetMs };
  S.sharedSession = await call('session', { action: 'join', id, clientId: getClientId() });
  if (Math.abs(S.timeOffsetMs - (Number(S.sharedSession.timeOffsetMs) || 0)) > 250) S.timeOffsetMs = Number(S.sharedSession.timeOffsetMs) || 0;
  if (Number.isFinite(S.sharedSession.channel)) {
    const { tuneToChannel } = await import('../playback/core.js');
    tuneToChannel(S.sharedSession.channel, { sharedSync: true });
  }
  notify();
  return S.sharedSession;
}
export async function leaveSharedSession() {
  const session = S.sharedSession;
  if (session) await call('session', { action: 'leave', id: session.id, clientId: getClientId() });
  S.sharedSession = null;
  if (beforeSharedSession && Number.isFinite(beforeSharedSession.channel)) {
    S.timeOffsetMs = beforeSharedSession.timeOffsetMs;
    const { tuneToChannel } = await import('../playback/core.js');
    tuneToChannel(beforeSharedSession.channel, { sharedSync: true });
  }
  beforeSharedSession = null;
  notify();
}
export async function handoffTo(targetClientId, recording = null) {
  if (!Number.isFinite(S.currentNumber)) throw new Error('Tune to a channel before handing it off.');
  return call('handoff', {
    targetClientId, channel: S.currentNumber, timeOffsetMs: S.timeOffsetMs, recording,
  });
}
export function onPersonalStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export { call as personalCall };
