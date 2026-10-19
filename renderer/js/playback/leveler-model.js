// Pure helpers for the volume leveler (leveler.js), kept DOM-free so
// tests/leveler.test.js can load them.

export const LEVELER_MODES = ['off', 'on', 'consistent'];
// Roughly where broadcast TV sits (EBU R128 is -23, ATSC A/85 -24).
export const TARGET_LUFS = -24;
const MIN_GAIN = 0.25;
const MAX_GAIN = 2.5;

// 'consistent' aims lower so nearly every file is brought down to it rather
// than some being raised: player.volume tops out at 1, so a quiet file can't
// be lifted at a high master volume, and that is where 'on' stops matching.
// Louder-than-normal ads get a deeper cut, and a file still being measured
// plays at PENDING_GAIN instead of full so a loud ad can't blast for the
// second or so before its loudness arrives.
const MODE_SETTINGS = {
  on: { target: TARGET_LUFS, minGain: MIN_GAIN, pendingGain: 1 },
  consistent: { target: -30, minGain: 0.08, pendingGain: 0.5 },
};

// Gain that moves a file measured at `lufs` to the target, clamped so one bad
// measurement can't blast or bury a file.
export function gainForLoudness(lufs, target = TARGET_LUFS, minGain = MIN_GAIN) {
  if (typeof lufs !== 'number' || !Number.isFinite(lufs)) return 1;
  const gain = 10 ** ((target - lufs) / 20);
  return Math.min(MAX_GAIN, Math.max(minGain, gain));
}

// The multiplier for `mode` given what is known about the loaded file:
// `measured` is false while the lookup is still pending, and `lufs` is null
// for a file that has no measurable audio.
export function levelerGainFor(mode, measured, lufs) {
  const settings = MODE_SETTINGS[mode];
  if (!settings) return 1;
  if (!measured) return settings.pendingGain;
  return gainForLoudness(lufs, settings.target, settings.minGain);
}

// The duration (seconds) to measure the loaded file with, or null to wait
// for the next event. At loadstart the element doesn't know its duration yet
// (player.duration is NaN), so the lineup's own figure for the file is used;
// a file the lineup doesn't list waits for loadedmetadata, because a
// measurement with no duration samples only the file's start and is cached
// that way.
export function measureDurationAt(eventType, playerDuration, lineupDuration) {
  if (Number.isFinite(playerDuration) && playerDuration > 0) return playerDuration;
  if (lineupDuration > 0) return lineupDuration;
  return eventType === 'loadstart' ? null : 0;
}

// The local path inside an app://media?p=… URL; null for anything else
// (a plugin-served stream on loopback http, a data: URL, nothing loaded).
export function mediaPathFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('app://media')) return null;
  try {
    const p = new URL(url).searchParams.get('p');
    return p && !p.startsWith('mediasource:') ? p : null;
  } catch (e) {
    return null;
  }
}

// Every local file the lineup can play: channel and block files plus the
// bumper/commercial pool (the same set the channel health check walks).
export function lineupMediaItems(config) {
  const items = new Map();
  const add = (f) => {
    if (f && typeof f.path === 'string' && !f.path.startsWith('mediasource:') && !items.has(f.path)) {
      items.set(f.path, { path: f.path, duration: Number(f.duration) || 0 });
    }
  };
  ((config && config.channels) || []).forEach((ch) => {
    (ch.files || []).forEach(add);
    (ch.blocks || []).forEach((b) => (b.files || []).forEach(add));
  });
  ((config && config.interstitials && config.interstitials.pool) || []).forEach((e) => add(e.file || e.bgFile));
  return [...items.values()];
}
