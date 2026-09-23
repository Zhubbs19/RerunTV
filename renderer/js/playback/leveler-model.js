// Pure helpers for the volume leveler (leveler.js), kept DOM-free so
// tests/leveler.test.js can load them.

export const LEVELER_MODES = ['off', 'on'];
// Roughly where broadcast TV sits (EBU R128 is -23, ATSC A/85 -24).
export const TARGET_LUFS = -24;
const MIN_GAIN = 0.25;
const MAX_GAIN = 2.5;

// Gain that moves a file measured at `lufs` to the target, clamped so one bad
// measurement can't blast or bury a file.
export function gainForLoudness(lufs, target = TARGET_LUFS) {
  if (typeof lufs !== 'number' || !Number.isFinite(lufs)) return 1;
  const gain = 10 ** ((target - lufs) / 20);
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
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
