// Volume leveler (PICTURE & SOUND › VOLUME, config.audioLeveler): evens out
// the jumps between loud and quiet files, shows and commercials, which read
// much worse from across a room. Each local file's loudness is measured once
// by ffmpeg in main (main/media/loudness.js, cached), and applyVolume
// (power.js) scales the player toward a common target by levelerGain().
//
// Not a Web Audio compressor: media comes from app://media, another origin
// than this page, so a MediaElementSource on #player outputs silence (found
// live while building this). That also means no in-file squeezing of loud
// scenes, only file-to-file matching.
//
// A quiet file can only be raised as far as the volume has headroom: at 100%
// master there's nothing above to raise into, so it stays as it was. The
// 'consistent' mode sidesteps that by aiming lower, so files are brought
// down to the level rather than up to it (see leveler-model.js).
//
// Host window only (the viewer shim has no getLoudness). The math is in
// leveler-model.js.

import { player } from '../core/dom.js';
import { S } from '../core/state.js';
import { applyVolume } from './power.js';
import { LEVELER_MODES, levelerGainFor, lineupMediaItems, mediaPathFromUrl } from './leveler-model.js';

export { LEVELER_MODES };

const known = new Map();
const pending = new Set();
let currentPath = null;
let installed = false;
let sweepStarted = false;
const SWEEP_START_DELAY_MS = 30 * 1000;

export function currentLevelerMode() {
  const mode = S.config && S.config.audioLeveler;
  return LEVELER_MODES.includes(mode) ? mode : 'off';
}

// Multiplier applyVolume applies to #player for the file it has loaded.
export function levelerGain() {
  const mode = currentLevelerMode();
  if (mode === 'off' || !currentPath) return 1;
  return levelerGainFor(mode, known.has(currentPath), known.get(currentPath));
}

// Runs at loadstart, as soon as the source is known, and again at
// loadedmetadata (when the duration is): the lookup starts before the first
// sound, and the second pass only adds the duration for a first measurement.
function onLoadedMetadata() {
  const filePath = mediaPathFromUrl(player.currentSrc || player.src);
  currentPath = filePath;
  applyVolume();
  if (!filePath || currentLevelerMode() === 'off' || known.has(filePath) || pending.has(filePath)) return;
  pending.add(filePath);
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  Promise.resolve(window.api.getLoudness(filePath, duration)).then((lufs) => {
    pending.delete(filePath);
    known.set(filePath, lufs);
    // Still the same file: bring it to level now (a first-time measurement
    // lands a second or two after it starts).
    if (currentPath === filePath) applyVolume();
  }).catch(() => { pending.delete(filePath); });
}

// Applies config.audioLeveler. Safe to call any time, as often as needed.
export function applyLeveler() {
  const api = window.api;
  if (!api || typeof api.getLoudness !== 'function') return;
  if (!installed) {
    installed = true;
    player.addEventListener('loadstart', onLoadedMetadata);
    player.addEventListener('loadedmetadata', onLoadedMetadata);
  }
  if (currentLevelerMode() === 'off') {
    if (sweepStarted) api.cancelLoudnessPrefetch().catch(() => {});
    sweepStarted = false;
  } else {
    if (!sweepStarted) {
      sweepStarted = true;
      // Measure the rest of the lineup in the background, so later files
      // start at the right level instead of settling a moment in.
      // Held back while the app is still starting up, so the sweep doesn't
      // compete with boot, plugin loading and the first tune.
      setTimeout(() => {
        if (sweepStarted && currentLevelerMode() !== 'off') api.prefetchLoudness(lineupMediaItems(S.config)).catch(() => {});
      }, SWEEP_START_DELAY_MS);
    }
    if (player.currentSrc) onLoadedMetadata();
  }
  applyVolume();
}
