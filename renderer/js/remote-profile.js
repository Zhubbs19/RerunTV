// This device's remote profile (docs/design/01 §5.2): which buttons it has
// actually delivered, and learn-mode overrides for buttons the automatic
// mapping gets wrong. Per client — localStorage, never channels.json — so the
// living-room box and a laptop each know their own remote.
//
// Pure apart from the storage adapter it's handed, so node:test covers it.
import { REMOTE_KEYS } from './remote-input.js';

export const PROFILE_STORAGE_KEY = 'reruntv.remoteProfile';
export const PROFILE_VERSION = 1;

function emptyProfile() {
  return { version: PROFILE_VERSION, seen: {}, overrides: {} };
}

// storage: { getItem(key), setItem(key, value) } — window.localStorage or a fake.
export function createRemoteProfile(storage) {
  let data = emptyProfile();
  try {
    const raw = storage && storage.getItem(PROFILE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.version === PROFILE_VERSION) {
      data = { ...emptyProfile(), ...parsed, seen: { ...(parsed.seen || {}) }, overrides: { ...(parsed.overrides || {}) } };
    }
  } catch (e) { /* unreadable: start fresh */ }

  const save = () => {
    try { if (storage) storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
  };

  return {
    // Records a delivered RemoteKey. Returns true the first time it's seen.
    note(remoteKey) {
      if (!REMOTE_KEYS.includes(remoteKey)) return false;
      const first = !data.seen[remoteKey];
      data.seen[remoteKey] = (data.seen[remoteKey] || 0) + 1;
      if (first) save();
      return first;
    },
    has(remoteKey) {
      return !!data.seen[remoteKey];
    },
    seenKeys() {
      return Object.keys(data.seen).filter((k) => REMOTE_KEYS.includes(k));
    },
    // Learn mode: this physical button (rawKeyId) means that RemoteKey.
    setOverride(rawId, remoteKey) {
      if (!rawId || !REMOTE_KEYS.includes(remoteKey)) return false;
      data.overrides[rawId] = remoteKey;
      save();
      return true;
    },
    removeOverride(rawId) {
      delete data.overrides[rawId];
      save();
    },
    overrideFor(rawId) {
      return (rawId && data.overrides[rawId]) || null;
    },
    overrides() {
      return { ...data.overrides };
    },
    resetOverrides() {
      data.overrides = {};
      save();
    },
    reset() {
      data = emptyProfile();
      save();
    },
    toJSON() {
      return JSON.parse(JSON.stringify(data));
    },
  };
}
