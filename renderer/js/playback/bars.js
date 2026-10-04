// "Remove baked-in black bars" (DISPLAY › Picture, config.display.removeBakedBars):
// content with letterbox/pillarbox bars burned into the video gets its picture
// framed without them, so a widescreen film fills the screen the way it would
// on a real channel and the logo bug isn't left sitting on a bar.
//
// The page can't see pixels (media is served from app://media, another origin),
// so each local file is checked once by ffmpeg in main (main/media/cropdetect.js,
// cached) and the box is applied by applyTvBezel (power.js) via
// currentBakedCrop(). Same shape as the volume leveler (leveler.js).
//
// Host window only: the LAN viewer's shim has no getCrop.

import { player } from '../core/dom.js';
import { S } from '../core/state.js';
import { lineupMediaItems, mediaPathFromUrl } from './leveler-model.js';
import { refreshPictureArea } from './power.js';

const SWEEP_START_DELAY_MS = 30 * 1000;
// path -> { x, y, w, h } as fractions of the frame, or null for "no bars".
const known = new Map();
let installed = false;
let sweepStarted = false;

export function bakedBarsEnabled() {
  return !!(S.config && S.config.display && S.config.display.removeBakedBars);
}

function loadedPath() {
  return mediaPathFromUrl(player.currentSrc || player.src);
}

// The picture box for the file in the player right now, or null when the
// option is off, the file has no bars, or it hasn't been checked yet (it plays
// as it always did until the answer lands, then re-frames).
export function currentBakedCrop() {
  if (!bakedBarsEnabled()) return null;
  const filePath = loadedPath();
  return (filePath && known.get(filePath)) || null;
}

function onLoadedMetadata() {
  if (!bakedBarsEnabled()) return;
  const filePath = loadedPath();
  if (!filePath || known.has(filePath)) return;
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  Promise.resolve(window.api.getCrop(filePath, duration)).then((crop) => {
    known.set(filePath, crop || null);
    // Still the same file and it has bars: re-frame without them now.
    if (crop && loadedPath() === filePath) refreshPictureArea();
  }).catch(() => {});
}

// Applies config.display.removeBakedBars. Safe to call any time, as often as needed.
export function applyBakedBars() {
  const api = window.api;
  if (!api || typeof api.getCrop !== 'function') return;
  if (!installed) {
    installed = true;
    player.addEventListener('loadedmetadata', onLoadedMetadata);
  }
  if (!bakedBarsEnabled()) {
    if (sweepStarted) api.cancelCropPrefetch().catch(() => {});
    sweepStarted = false;
  } else {
    if (!sweepStarted) {
      sweepStarted = true;
      // Check the rest of the lineup in the background, so later files are
      // framed correctly from their first frame. Held back while the app is
      // still starting up (boot, plugins, the first tune) so it doesn't
      // compete with them for the disk and CPU.
      setTimeout(() => {
        if (sweepStarted && bakedBarsEnabled()) api.prefetchCrops(lineupMediaItems(S.config)).catch(() => {});
      }, SWEEP_START_DELAY_MS);
    }
    if (player.currentSrc) onLoadedMetadata();
  }
  refreshPictureArea();
}
