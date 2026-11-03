// Finding the fades to black in shows (main/media/breakdetect.js, through the
// host-only libraryCall 'detectBreakMarks') and saving them on every playlist
// entry for the file as `breakMarks: [{ at, strength }]`. An empty list means
// "looked, found none", so a file is never decoded twice. What the marks do
// to the schedule is interstitials.js midSlots, behind PROGRAMMING › CADENCE & PRESETS ›
// "Line up mid-show breaks with fades".
import { resolveActiveCommercials } from '../core/schedule.js';
import { localPathOf } from './local-metadata.js';
import { shareFileFields } from './file-copies.js';

/** Whether a channel's current cadence puts breaks inside shows, not only between them. */
export function hasMidShowBreaks(ch, atMs) {
  try {
    const cc = resolveActiveCommercials(ch, atMs).commercials;
    if (!cc || cc.enabled === false || ch.adsEnabled === false) return false;
    return cc.timing === 'everyNMinutes' || cc.timing === 'breakpoints' || (cc.timing === 'flow' && !!cc.hasMid);
  } catch (e) {
    return false;
  }
}

/** Local playlist entries in `channels` that haven't been searched for fades yet, one per path. */
export function filesNeedingMarks(channels) {
  const seen = new Set();
  const out = [];
  channels.forEach((ch) => {
    [ch.files || [], ...(ch.blocks || []).map((b) => b.files || [])].forEach((files) => {
      files.forEach((file) => {
        if (!localPathOf(file.path) || Array.isArray(file.breakMarks) || seen.has(file.path)) return;
        seen.add(file.path);
        out.push(file);
      });
    });
  });
  return out;
}

/**
 * Looks for fades in each file, one at a time, saving each result on every
 * copy of the file as soon as it arrives (so stopping keeps what was found).
 * `save()` records the config change; it is called after each file.
 * -> { checked, withFades, unavailable }
 */
export async function findFades(config, files, { onProgress = null, shouldStop = () => false, save = () => {} } = {}) {
  let checked = 0;
  let withFades = 0;
  for (let i = 0; i < files.length; i += 1) {
    if (shouldStop()) break;
    const file = files[i];
    if (onProgress) onProgress(i, files.length, file);
    // eslint-disable-next-line no-await-in-loop -- one ffmpeg pass at a time, on purpose
    const response = await window.api.libraryCall('detectBreakMarks', { ref: localPathOf(file.path) });
    if (!response || !response.ok) continue;
    if (!response.result.available) return { checked, withFades, unavailable: true };
    if (!Array.isArray(response.result.marks)) continue;
    shareFileFields(config, file, { breakMarks: response.result.marks });
    checked += 1;
    if (response.result.marks.length) withFades += 1;
    save();
  }
  return { checked, withFades, unavailable: false };
}
