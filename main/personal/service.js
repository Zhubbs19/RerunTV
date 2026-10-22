// Per-profile personal state (docs/design/09, contract C5). Broadcast config
// remains in channels.json; this service owns everything that describes a
// viewer rather than what airs. Electron IPC and the paired LAN control route
// both call this same API.
const crypto = require('crypto');
const fs = require('fs');
const { atomicWriteFileSync } = require('../util/atomic-write');
const path = require('path');

const SCHEMA_VERSION = 1;
const REMOTE_METHODS = new Set(['status', 'listProfiles', 'getProfile', 'createProfile', 'updateProfile', 'verifyProfile', 'deleteProfile', 'command', 'handoff', 'session', 'presence']);
const COLORS = ['#f0b429', '#6fe0f2', '#8b93f5', '#ff6b5b', '#5fd68a', '#e0895f'];

const clone = (value) => JSON.parse(JSON.stringify(value));
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const safeId = (value) => /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || ''));

function atomicJson(file, value, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8' });
}

function defaultState(config = {}, history = []) {
  return {
    favorites: (config.channels || []).filter((channel) => channel.favorite).map((channel) => channel.number),
    hiddenChannels: [], quickJumpSlots: clone(config.quickJumpSlots || {}),
    reminders: clone(config.reminders || []), airChecks: clone(config.airChecks || []),
    recordingRequests: [], recordings: {}, resumePoints: {}, history: clone(history),
    dvrPolicy: { quotaGb: 0, keepEpisodes: 0, deleteWatchedAfterDays: 7, tunerLimit: 0 },
    theme: null, era: null,
  };
}

function normalizeProfile(raw, fallback = {}) {
  const profile = raw && typeof raw === 'object' ? raw : {};
  const state = profile.state && typeof profile.state === 'object' ? profile.state : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    id: safeId(profile.id) ? profile.id : fallback.id,
    name: String(profile.name || fallback.name || 'Profile').slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(profile.color || '') ? profile.color : (fallback.color || COLORS[0]),
    pinHash: typeof profile.pinHash === 'string' ? profile.pinHash : null,
    restriction: ['none', 'kids', 'teen'].includes(profile.restriction) ? profile.restriction : 'none',
    createdAt: Number(profile.createdAt) || fallback.createdAt || Date.now(),
    updatedAt: Number(profile.updatedAt) || fallback.updatedAt || Date.now(),
    revision: Number.isInteger(profile.revision) ? profile.revision : 0,
    state: {
      favorites: Array.isArray(state.favorites) ? state.favorites.filter(Number.isFinite) : [],
      hiddenChannels: Array.isArray(state.hiddenChannels) ? state.hiddenChannels.filter(Number.isFinite) : [],
      quickJumpSlots: state.quickJumpSlots && typeof state.quickJumpSlots === 'object' ? state.quickJumpSlots : {},
      reminders: Array.isArray(state.reminders) ? state.reminders : [],
      airChecks: Array.isArray(state.airChecks) ? state.airChecks : [],
      recordingRequests: Array.isArray(state.recordingRequests) ? state.recordingRequests : [],
      recordings: state.recordings && typeof state.recordings === 'object' ? state.recordings : {},
      resumePoints: state.resumePoints && typeof state.resumePoints === 'object' ? state.resumePoints : {},
      dvrPolicy: {
        quotaGb: Math.max(0, Number(state.dvrPolicy?.quotaGb) || 0),
        keepEpisodes: Math.max(0, Math.floor(Number(state.dvrPolicy?.keepEpisodes) || 0)),
        deleteWatchedAfterDays: Math.max(0, Math.floor(Number(state.dvrPolicy?.deleteWatchedAfterDays) || 7)),
        tunerLimit: Math.max(0, Math.floor(Number(state.dvrPolicy?.tunerLimit) || 0)),
      },
      history: Array.isArray(state.history) ? state.history.slice(-2000) : [],
      theme: typeof state.theme === 'string' ? state.theme : null,
      era: typeof state.era === 'string' ? state.era : null,
    },
  };
}

function publicProfile(profile, includeState = false) {
  const out = { id: profile.id, name: profile.name, color: profile.color, restriction: profile.restriction, hasPin: !!profile.pinHash, revision: profile.revision };
  if (includeState) out.state = clone(profile.state);
  return out;
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  if (pin == null || pin === '') return null;
  if (!/^\d{4}$/.test(String(pin))) throw new Error('A profile PIN must be four digits.');
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}

function verifyPin(pin, encoded) {
  if (!encoded) return true;
  const [salt, expected] = encoded.split(':');
  if (!salt || !expected || !/^\d{4}$/.test(String(pin || ''))) return false;
  const actual = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function createPersonalService({ dir, getConfig = () => ({}), legacyHistoryFile = null, now = () => Date.now(), publish = null }) {
  const indexFile = path.join(dir, 'index.json');
  const profileFile = (id) => path.join(dir, `${id}.json`);
  let index = null;
  const sessions = new Map();
  const clients = new Map();

  // Only a genuinely absent index means "first run". Anything else that stops it
  // loading (unreadable, unparseable, wrong shape) must not fall through to
  // migrateEveryone(), which would write a fresh index over the household's real
  // profiles: keep a copy for recovery and refuse instead.
  function readIndex() {
    if (index) return index;
    let loaded = null;
    let problem = null;
    try {
      loaded = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (!loaded || !Array.isArray(loaded.profiles)) problem = new Error('unexpected contents');
    } catch (e) {
      if (e.code !== 'ENOENT') problem = e;
    }
    if (problem) {
      try { fs.copyFileSync(indexFile, `${indexFile}.corrupt-${now()}`); } catch (e) { /* unreadable even to copy */ }
      throw new Error(`The profile index could not be read (${problem.message}). A copy was kept next to it; nothing was changed.`);
    }
    index = loaded || { schemaVersion: SCHEMA_VERSION, profiles: [], activeProfileId: null, migratedAt: null };
    if (!index.profiles.length) migrateEveryone();
    return index;
  }

  // Wrong-PIN limiter: a four-digit PIN is only 10^4 guesses, so after 5 wrong
  // tries on one profile it refuses for a minute (per profile, in memory).
  const PIN_MAX_WRONG = 5;
  const PIN_WINDOW_MS = 60 * 1000;
  const pinFailures = new Map(); // profile id -> { count, start }
  function checkProfilePin(profile, pin) {
    if (!profile.pinHash) return true;
    const t = now();
    const entry = pinFailures.get(profile.id);
    if (entry && t - entry.start < PIN_WINDOW_MS && entry.count >= PIN_MAX_WRONG) {
      throw new Error('Too many wrong PIN attempts. Try again in a minute.');
    }
    if (verifyPin(pin, profile.pinHash)) { pinFailures.delete(profile.id); return true; }
    const fresh = entry && t - entry.start < PIN_WINDOW_MS ? entry : { count: 0, start: t };
    fresh.count += 1;
    pinFailures.set(profile.id, fresh);
    return false;
  }

  function saveIndex() { atomicJson(indexFile, index, now); }

  function readProfile(id) {
    if (!safeId(id)) throw new Error('Invalid profile id.');
    const summary = readIndex().profiles.find((entry) => entry.id === id);
    if (!summary) throw new Error('Profile not found.');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(profileFile(id), 'utf8'));
    } catch (e) {
      // The summary has no pinHash, so substituting it for an unreadable file
      // would silently drop the profile's PIN. Only a missing file of an
      // unprotected profile may fall back to it; everything else fails closed.
      if (e.code === 'ENOENT' && !summary.hasPin) raw = summary;
      else throw new Error('That profile could not be read, so the action was refused.');
    }
    return normalizeProfile(raw, summary);
  }

  function saveProfile(profile) {
    profile.updatedAt = now();
    profile.revision += 1;
    atomicJson(profileFile(profile.id), profile, now);
    const i = readIndex().profiles.findIndex((entry) => entry.id === profile.id);
    const summary = publicProfile(profile);
    if (i === -1) index.profiles.push(summary); else index.profiles[i] = summary;
    saveIndex();
    if (publish) publish('personal:changed', { profileId: profile.id, revision: profile.revision });
    return publicProfile(profile, true);
  }

  function migrateEveryone() {
    let history = [];
    if (legacyHistoryFile) {
      try { history = JSON.parse(fs.readFileSync(legacyHistoryFile, 'utf8')).entries || []; } catch (e) { history = []; }
    }
    const createdAt = now();
    const profile = normalizeProfile({ id: 'everyone', name: 'Everyone', color: COLORS[0], createdAt, state: defaultState(getConfig(), history) }, { id: 'everyone', name: 'Everyone', createdAt });
    atomicJson(profileFile(profile.id), profile, now);
    index = { schemaVersion: SCHEMA_VERSION, profiles: [publicProfile(profile)], activeProfileId: profile.id, migratedAt: createdAt };
    saveIndex();
  }

  function createProfile(payload = {}) {
    const current = readIndex();
    if (current.profiles.length >= 12) throw new Error('This household already has 12 profiles.');
    const id = newId('profile');
    const profile = normalizeProfile({ id, name: payload.name, color: payload.color || COLORS[current.profiles.length % COLORS.length], restriction: payload.restriction, pinHash: hashPin(payload.pin), createdAt: now(), state: defaultState() }, { id, name: 'Profile', createdAt: now() });
    return saveProfile(profile);
  }

  function updateProfile(payload = {}) {
    const profile = readProfile(payload.id);
    if (!checkProfilePin(profile, payload.currentPin)) throw new Error('The current profile PIN is incorrect.');
    if (payload.name != null) profile.name = String(payload.name).trim().slice(0, 40) || profile.name;
    if (/^#[0-9a-f]{6}$/i.test(payload.color || '')) profile.color = payload.color;
    if (['none', 'kids', 'teen'].includes(payload.restriction)) profile.restriction = payload.restriction;
    if (Object.prototype.hasOwnProperty.call(payload, 'pin')) profile.pinHash = hashPin(payload.pin);
    return saveProfile(profile);
  }

  function command(payload = {}) {
    const profile = readProfile(payload.profileId);
    if (Number.isInteger(payload.baseRevision) && payload.baseRevision !== profile.revision) return { ok: false, reason: 'stale', profile: publicProfile(profile, true) };
    const cmd = payload.command || {};
    if (cmd.type === 'favorite.toggle' || cmd.type === 'favorite.set') {
      const set = new Set(profile.state.favorites);
      const enabled = cmd.type === 'favorite.set' ? !!cmd.value : !set.has(cmd.channel);
      if (enabled) set.add(cmd.channel); else set.delete(cmd.channel);
      profile.state.favorites = [...set];
    } else if (cmd.type === 'state.set') {
      const allowed = new Set(['hiddenChannels', 'quickJumpSlots', 'reminders', 'airChecks', 'history', 'theme', 'era', 'dvrPolicy']);
      if (!allowed.has(cmd.key)) throw new Error('That personal setting cannot be changed here.');
      profile.state[cmd.key] = clone(cmd.value);
    } else if (cmd.type === 'recording.request') {
      const request = { id: newId('rec'), type: cmd.requestType || 'airing', channel: cmd.channel, start: cmd.start, end: cmd.end, seriesId: cmd.seriesId || null, keyword: cmd.keyword || null, breaks: cmd.breaks === 'program' ? 'program' : 'as-aired', createdAt: now(), enabled: true };
      if (!Number.isFinite(request.channel) || !Number.isFinite(request.start) || !Number.isFinite(request.end) || request.end <= request.start) throw new Error('A recording request needs a channel and valid time range.');
      profile.state.recordingRequests.push(request);
    } else if (cmd.type === 'recording.cancel') {
      profile.state.recordingRequests = profile.state.recordingRequests.filter((entry) => entry.id !== cmd.id);
    } else if (cmd.type === 'recording.complete') {
      if (!cmd.key) throw new Error('A completed recording needs an airing key.');
      profile.state.recordings[String(cmd.key).slice(0, 300)] = {
        ...(profile.state.recordings[String(cmd.key).slice(0, 300)] || {}),
        status: cmd.error ? 'error' : 'ready', tapeId: cmd.tapeId || null,
        error: cmd.error || null, title: cmd.title || null, channel: cmd.channel,
        start: cmd.start, end: cmd.end, requestId: cmd.requestId || null, completedAt: now(),
      };
    } else if (cmd.type === 'recording.queued') {
      if (!cmd.key || !cmd.jobId) throw new Error('A queued recording needs an airing key and job id.');
      profile.state.recordings[String(cmd.key).slice(0, 300)] = {
        status: 'queued', jobId: String(cmd.jobId).slice(0, 160), tapeId: null,
        title: cmd.title || null, channel: cmd.channel, start: cmd.start, end: cmd.end,
        requestId: cmd.requestId || null, queuedAt: now(),
      };
    } else if (cmd.type === 'recording.forget') {
      if (!cmd.key) throw new Error('A recording key is required.');
      delete profile.state.recordings[String(cmd.key).slice(0, 300)];
    } else if (cmd.type === 'recording.remove') {
      if (!cmd.key) throw new Error('A recording key is required.');
      const key = String(cmd.key).slice(0, 300);
      const existing = profile.state.recordings[key];
      if (existing?.tapeId) delete profile.state.resumePoints[`tape:${existing.tapeId}`];
      delete profile.state.recordings[key];
    } else if (cmd.type === 'resume.set') {
      if (!cmd.key || !Number.isFinite(cmd.positionMs)) throw new Error('A resume point needs a key and position.');
      profile.state.resumePoints[String(cmd.key).slice(0, 200)] = {
        positionMs: Math.max(0, cmd.positionMs), durationMs: Math.max(0, Number(cmd.durationMs) || 0),
        watched: !!cmd.watched, updatedAt: now(),
      };
    } else if (cmd.type === 'history.append') {
      profile.state.history.push({ ...clone(cmd.entry || {}), at: Number(cmd.entry && cmd.entry.at) || now() });
      profile.state.history = profile.state.history.slice(-2000);
    } else throw new Error('Unknown personal command.');
    return { ok: true, profile: saveProfile(profile) };
  }

  function session(payload = {}) {
    const action = payload.action;
    if (action === 'start') {
      const id = newId('watch');
      const value = { id, leader: payload.clientId, members: [payload.clientId], channel: payload.channel, timeOffsetMs: payload.timeOffsetMs || 0, leaderClock: now(), createdAt: now() };
      sessions.set(id, value); if (publish) publish('session:changed', value); return clone(value);
    }
    const value = sessions.get(payload.id);
    if (!value) throw new Error('Shared session not found.');
    if (action === 'join') { if (!value.members.includes(payload.clientId)) value.members.push(payload.clientId); }
    else if (action === 'leave') { value.members = value.members.filter((id) => id !== payload.clientId); if (!value.members.length) sessions.delete(value.id); }
    else if (action === 'tune') { if (payload.clientId !== value.leader) throw new Error('Only the session leader can tune everyone.'); value.channel = payload.channel; value.timeOffsetMs = payload.timeOffsetMs || 0; value.leaderClock = now(); }
    else if (action !== 'get') throw new Error('Unknown session action.');
    if (publish) publish('session:changed', value); return clone(value);
  }

  function presence(payload = {}) {
    const cutoff = now() - 60000;
    clients.forEach((client, id) => { if (client.lastSeen < cutoff) clients.delete(id); });
    if (payload.action === 'register') {
      if (!payload.clientId) throw new Error('A client id is required.');
      const client = {
        id: String(payload.clientId).slice(0, 64),
        label: String(payload.label || 'RerunTV screen').slice(0, 60),
        profileId: safeId(payload.profileId) ? payload.profileId : null,
        lastSeen: now(),
      };
      clients.set(client.id, client);
    } else if (payload.action !== 'list') throw new Error('Unknown presence action.');
    return [...clients.values()].map(clone);
  }

  const api = {
    status: () => ({ schemaVersion: SCHEMA_VERSION, activeProfileId: readIndex().activeProfileId, count: readIndex().profiles.length }),
    listProfiles: () => clone(readIndex().profiles),
    getProfile: ({ id } = {}) => publicProfile(readProfile(id || readIndex().activeProfileId), true),
    createProfile,
    updateProfile,
    verifyProfile({ id, pin } = {}) { return checkProfilePin(readProfile(id), pin); },
    deleteProfile({ id, pin } = {}) { const current = readIndex(); if (id === 'everyone') throw new Error('The Everyone profile cannot be deleted.'); const profile = readProfile(id); if (!checkProfilePin(profile, pin)) throw new Error('The profile PIN is incorrect.'); current.profiles = current.profiles.filter((entry) => entry.id !== id); if (current.activeProfileId === id) current.activeProfileId = 'everyone'; try { fs.unlinkSync(profileFile(id)); } catch (e) {} saveIndex(); return true; },
    command,
    handoff(payload = {}) {
      if (!payload.targetClientId || !Number.isFinite(payload.channel) || !Number.isFinite(payload.timeOffsetMs)) throw new Error('A handoff needs a target client, channel and clock offset.');
      const event = { targetClientId: String(payload.targetClientId).slice(0, 64), channel: payload.channel, timeOffsetMs: payload.timeOffsetMs, recording: payload.recording || null, sentAt: now() };
      if (publish) publish('client:handoff', event);
      return event;
    },
    session,
    presence,
  };

  async function call(method, payload = {}, { remote = false } = {}) {
    if (!Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`Unknown personal method "${method}".`);
    if (remote && !REMOTE_METHODS.has(method)) throw new Error('That profile action can only be done on the host.');
    return api[method](payload || {});
  }
  return { call, api, REMOTE_METHODS, verifyPin };
}

function registerPersonalIpc(ipcMain, { getService }) {
  ipcMain.handle('personal:call', async (event, method, payload) => {
    try { return { ok: true, result: await getService().call(method, payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { createPersonalService, registerPersonalIpc, normalizeProfile, defaultState, verifyPin, SCHEMA_VERSION, REMOTE_METHODS };
