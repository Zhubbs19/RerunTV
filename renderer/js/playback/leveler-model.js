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

/**
 * Gain that moves a file measured at `lufs` to the target, clamped so one bad
 * measurement can't blast or bury a file.
 * @param {?number} lufs Measured integrated loudness.
 * @param {number} [target=TARGET_LUFS] Loudness to aim for.
 * @param {number} [minGain=MIN_GAIN] Lowest gain allowed.
 * @returns {number} Gain multiplier, 1 when `lufs` is not a finite number.
 */
export function gainForLoudness(lufs, target = TARGET_LUFS, minGain = MIN_GAIN) {
  if (typeof lufs !== 'number' || !Number.isFinite(lufs)) return 1;
  const gain = 10 ** ((target - lufs) / 20);
  return Math.min(MAX_GAIN, Math.max(minGain, gain));
}

/**
 * Read PICTURE & SOUND › SOUND › "Leveler loudness" (audioLevelerTarget).
 * @param {*} value The stored value.
 * @returns {number|null} A target in LUFS clamped to -30..-16, or null for the mode's own.
 */
export function levelerTargetFrom(value) {
  if (value === null || value === undefined || value === '') return null;
  const v = Number(value);
  return Number.isFinite(v) ? Math.min(-16, Math.max(-30, v)) : null;
}

/**
 * The multiplier for `mode` given what is known about the loaded file.
 * @param {string} mode 'off', 'on' or 'consistent'.
 * @param {boolean} measured False while the lookup is still pending.
 * @param {number|null} lufs The file's loudness, or null for a file with no measurable audio.
 * @param {number|null} [target=null] A loudness target that replaces the mode's own.
 * @returns {number} The gain to apply.
 */
export function levelerGainFor(mode, measured, lufs, target = null) {
  const settings = MODE_SETTINGS[mode];
  if (!settings) return 1;
  if (!measured) return settings.pendingGain;
  return gainForLoudness(lufs, target == null ? settings.target : target, settings.minGain);
}

/**
 * The duration (seconds) to measure the loaded file with, or null to wait
 * for the next event. At loadstart the element doesn't know its duration yet
 * (player.duration is NaN), so the lineup's own figure for the file is used;
 * a file the lineup doesn't list waits for loadedmetadata, because a
 * measurement with no duration samples only the file's start and is cached
 * that way.
 * @param {string} eventType The media event that fired (`loadstart`, `loadedmetadata`, ...).
 * @param {number} playerDuration The element's `duration` (NaN until metadata loads).
 * @param {number} lineupDuration The lineup's recorded duration for the file, or 0.
 * @returns {?number} Seconds to measure with, 0 for unknown, or null to wait.
 */
export function measureDurationAt(eventType, playerDuration, lineupDuration) {
  if (Number.isFinite(playerDuration) && playerDuration > 0) return playerDuration;
  if (lineupDuration > 0) return lineupDuration;
  return eventType === 'loadstart' ? null : 0;
}

/**
 * The local path inside an app://media?p=… URL; null for anything else
 * (a plugin-served stream on loopback http, a data: URL, nothing loaded).
 * @param {string} url The player's current source URL.
 * @returns {?string} The decoded local path, or null.
 */
export function mediaPathFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('app://media')) return null;
  try {
    const p = new URL(url).searchParams.get('p');
    return p && !p.startsWith('mediasource:') ? p : null;
  } catch (e) {
    return null;
  }
}

/**
 * Every local file the lineup can play: channel and block files plus the
 * bumper/commercial pool (the same set the channel health check walks).
 * @param {object} config The whole config (`S.config`).
 * @returns {Array<object>} Unique `{ path, duration }` entries, duration in seconds.
 */
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
