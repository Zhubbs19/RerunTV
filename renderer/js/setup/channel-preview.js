// Schedule/time calculations for CHANNELS-tab previews. The modal/controller
// stays in setup-channels.js; these helpers own the time-machine preview rules.
import { isWithinBroadcastHours, matchesTrigger } from '../core/schedule.js';
import { nextBreakBoundary, resolveBreakAt } from '../core/interstitials.js';
import { pad2 } from '../core/util.js';

export function formatPreviewBannerTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function nextBlockActiveMs(block, fromMs) {
  const HOUR_MS = 3600000;
  let t = fromMs;
  for (let i = 0; i < 24 * 400; i++) {
    if (matchesTrigger(t, block)) return t;
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    t = d.getTime() + HOUR_MS;
  }
  return null;
}

export function nextBreakStartMs(ch, fromMs) {
  let t = fromMs;
  for (let i = 0; i < 50; i++) {
    const boundary = nextBreakBoundary(ch, t);
    if (!Number.isFinite(boundary)) return null;
    if (resolveBreakAt(ch, boundary)) return boundary;
    t = boundary + 1;
  }
  return null;
}

export function randomPreviewMs(ch, fromMs) {
  const WEEK_MS = 7 * 24 * 3600000;
  for (let i = 0; i < 20; i++) {
    const candidate = fromMs + Math.random() * WEEK_MS;
    if (!ch.broadcastHours || !ch.broadcastHours.enabled || isWithinBroadcastHours(ch, candidate)) return candidate;
  }
  return fromMs + Math.random() * 24 * 3600000;
}
