// Lining breaks up with the fades to black a file was found to have
// (file.breakMarks, from main/media/breakdetect.js). Pure apart from reading
// the switch: PROGRAMMING › CADENCE & PRESETS › "Line up mid-show breaks with
// fades". The marks are part of config, so anything built on these stays a
// pure function of (channel, timestamp). interstitials.js midSlots is the
// caller for a channel's own cadence.

// Two breaks closer than this aren't two act breaks.
const MIN_SNAPPED_GAP_MS = 60000;

/**
 * How far a break may move to reach a fade, in ms; 0 while the switch is off.
 * @param {object} config The app config; reads `config.commercials`.
 * @returns {number} The snap window in ms (minutes capped at 15, default 3).
 */
export function fadeSnapWindowMs(config) {
  const c = (config && config.commercials) || {};
  if (!c.snapToFades) return 0;
  const minutes = Number(c.snapWindowMinutes);
  return (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 15) : 3) * 60000;
}

/**
 * A file's fades as [{ atMs, strength }] ascending, `scale` times their
 * position in the file (a slot stretched or squeezed in the schedule), or
 * null when it has none.
 * @param {object} file A channel file entry; reads `file.breakMarks`.
 * @param {number} [scale=1] Factor applied to each fade position.
 * @returns {?Array<{atMs: number, strength: number}>} The fades, or null.
 */
export function fadesOf(file, scale = 1) {
  const marks = file && Array.isArray(file.breakMarks) ? file.breakMarks : null;
  if (!marks || !marks.length) return null;
  return marks
    .filter((m) => m && Number.isFinite(m.at))
    .map((m) => ({ atMs: m.at * 1000 * scale, strength: Number(m.strength) || 0 }))
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * Moves raw slot offsets (ms into the file, ascending) to the best unused
 * fade within `windowMs`: nearest wins, a stronger fade can win from a
 * little further away. Slots stay in order; a slot left behind by its
 * predecessor's move (no room before the next one) is dropped (null).
 * marks: [{ atMs, strength }] ascending.
 * @param {number[]} rawOffsets Slot offsets in ms into the file, ascending.
 * @param {Array<{atMs: number, strength: number}>} marks The fades, ascending.
 * @param {number} windowMs How far a slot may move, in ms.
 * @returns {Array<?number>} The snapped offsets, null for a dropped slot.
 */
export function snapOffsetsToFades(rawOffsets, marks, windowMs) {
  const used = new Set();
  let floor = -Infinity;
  return rawOffsets.map((offset) => {
    let best = -1;
    let bestCost = Infinity;
    marks.forEach((mark, i) => {
      if (used.has(i) || mark.atMs <= floor + MIN_SNAPPED_GAP_MS) return;
      const distance = Math.abs(mark.atMs - offset);
      if (distance > windowMs) return;
      const cost = distance / windowMs - 0.35 * (mark.strength || 0);
      if (cost < bestCost) { bestCost = cost; best = i; }
    });
    let at = offset;
    if (best >= 0) { used.add(best); at = marks[best].atMs; }
    if (at <= floor + MIN_SNAPPED_GAP_MS && floor > -Infinity) return null;
    floor = at;
    return at;
  });
}
