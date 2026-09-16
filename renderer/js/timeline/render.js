// Timeline marks shared by every screen that draws a channel's time line:
// SCHEDULE > ON AIR (setup-onair.js), the guide grid (guide.js) and the time
// machine's scrubber (timemachine.js) — docs/design/11 §3.2, so all three read
// as the same timeline. Placement is pure; the element factories only build a
// node, and each screen positions it in its own unit (px on ON AIR's zoomable
// day, % in the guide and scrubber).

// Period copy for break types (a commercial pod reads PAID PROGRAMMING, the
// way a real listings grid showed it). ON AIR overrides a few with plainer
// words; the scrubber and guide use these.
export const BREAK_LABELS = {
  commercial: 'PAID PROGRAMMING', adBreakIn: 'PAID PROGRAMMING', adBreakOut: 'PAID PROGRAMMING',
  channelId: 'STATION ID', trivia: 'LOCAL PROGRAMMING', upNext: 'UP NEXT', promo: 'PROMO',
  signOff: 'SIGN-OFF', signOn: 'SIGN-ON', premiereJingle: 'SPECIAL PRESENTATION', localAvail: 'LOCAL AVAIL',
};

// [start, end) cut to [from, to), or null when nothing of it is inside.
export function clampSpan(start, end, from, to) {
  const s = Math.max(start, from);
  const e = Math.min(end, to);
  return e > s ? { start: s, end: e } : null;
}

// Left and width as percentages of [from, to). minWidthPct keeps a very short
// span visible (a 20 s bumper in a 3 h window would otherwise be 0.2%).
export function spanPercent(start, end, from, to, { minWidthPct = 0 } = {}) {
  const span = clampSpan(start, end, from, to);
  if (!span) return null;
  const total = to - from;
  return {
    left: ((span.start - from) / total) * 100,
    width: Math.max(((span.end - span.start) / total) * 100, minWidthPct),
  };
}

// The time at a fraction (0..1) across [from, to) — for pointer input on a
// strip, clamped to its ends.
export function timeAtFraction(fraction, from, to) {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return from + f * (to - from);
}

// Class names for a break mark. Colours live in guide.css under .tl-break-*,
// one palette for every timeline.
export function breakMarkClass(type) {
  return `tl-break tl-break-${type || 'commercial'}`;
}

// A break pod as a thin band (the element; the caller positions it).
export function breakMarkEl(brk, { className = '', label = null } = {}) {
  const el = document.createElement('div');
  el.className = `${breakMarkClass(brk.breakType)}${className ? ` ${className}` : ''}`;
  el.title = label || BREAK_LABELS[brk.breakType] || String(brk.breakType || 'BREAK').toUpperCase();
  el.dataset.start = String(brk.start);
  el.dataset.end = String(brk.end);
  return el;
}
