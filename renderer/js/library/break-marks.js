// Finding the fades to black in shows (main/media/breakdetect.js, through the
// host-only libraryCall 'detectBreakMarks') and saving them on every playlist
// entry for the file as `breakMarks: [{ at, strength }]`. An empty list means
// "looked, found none", so a file is never decoded twice. What the marks do
// to the schedule is interstitials.js midSlots (and fit.js's spread breaks on
// a fitted channel), behind PROGRAMMING › CADENCE & PRESETS › "Line up mid-show
// breaks with fades".
//
// The same read finds where the end credits start, saved as `creditsFound:
// { at, leadS, density }` (null = looked, found none). The end-credits
// speedup and Fit to time slots start there instead of at a lead time
// (core/util.js foundCreditsLead), behind "Speed up credits from where they
// start".
import { resolveActiveCommercials } from '../core/schedule.js';
import { fitConfigFor } from '../core/fit.js';
import { localPathOf } from './local-metadata.js';
import { shareFileFields } from './file-copies.js';

/** Whether a channel's current cadence puts breaks inside shows, not only between them. */
export function hasMidShowBreaks(ch, atMs) {
  try {
    // A fitted channel's breaks are its slot plan's; 'spread' puts some inside each program.
    const fit = fitConfigFor(ch);
    if (fit) return fit.breakPlacement === 'spread';
    const cc = resolveActiveCommercials(ch, atMs).commercials;
    if (!cc || cc.enabled === false || ch.adsEnabled === false) return false;
    return cc.timing === 'everyNMinutes' || cc.timing === 'breakpoints' || (cc.timing === 'flow' && !!cc.hasMid);
  } catch (e) {
    return false;
  }
}

/** Whether a channel speeds up end credits (its END CREDITS panel, or its fit to time slots). */
export function speedsUpCredits(ch) {
  if (ch && ch.creditsSpeedup && ch.creditsSpeedup.enabled) return true;
  const fit = fitConfigFor(ch);
  return !!(fit && fit.creditsApplies !== 'never');
}

/** Local playlist entries in `channels` not yet searched for fades and credits, one per path. */
export function filesNeedingMarks(channels) {
  const seen = new Set();
  const out = [];
  channels.forEach((ch) => {
    [ch.files || [], ...(ch.blocks || []).map((b) => b.files || [])].forEach((files) => {
      files.forEach((file) => {
        const done = Array.isArray(file.breakMarks) && file.creditsFound !== undefined;
        if (!localPathOf(file.path) || done || seen.has(file.path)) return;
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
 * -> { checked, withFades, withCredits, unavailable }
 */
export async function findFades(config, files, { onProgress = null, shouldStop = () => false, save = () => {} } = {}) {
  let checked = 0;
  let withFades = 0;
  let withCredits = 0;
  for (let i = 0; i < files.length; i += 1) {
    if (shouldStop()) break;
    const file = files[i];
    if (onProgress) onProgress(i, files.length, file);
    // eslint-disable-next-line no-await-in-loop -- one ffmpeg pass at a time, on purpose
    const response = await window.api.libraryCall('detectBreakMarks', { ref: localPathOf(file.path) });
    if (!response || !response.ok) continue;
    if (!response.result.available) return { checked, withFades, withCredits, unavailable: true };
    if (!Array.isArray(response.result.marks)) continue;
    const credits = response.result.credits || null;
    shareFileFields(config, file, { breakMarks: response.result.marks, creditsFound: credits });
    checked += 1;
    if (response.result.marks.length) withFades += 1;
    if (credits) withCredits += 1;
    save();
  }
  return { checked, withFades, withCredits, unavailable: false };
}
