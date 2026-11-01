// Pure rules for the cable-guide UI (renderer/css/cable-guide.css):
// which layout a theme turns on, where the live-video box sits, how the
// header clock reads, and which overlay surfaces count as open. No DOM, so
// tests/cable-guide.test.js imports it directly.

export const CABLE_GUIDE_UI = 'cable-guide';
export const LEGACY_UI = 'legacy';

export function uiModeForPack(pack) {
  return pack && pack.ui === CABLE_GUIDE_UI ? CABLE_GUIDE_UI : LEGACY_UI;
}

// The theme id to paint with: the channel's identity theme on the legacy
// layout (today's behaviour), the box skin on the cable-guide layout, whose
// CSS reads tokens only the two skins define.
export function paintedThemeId({ uiMode, boxThemeId, channelThemeId }) {
  return uiMode === CABLE_GUIDE_UI ? boxThemeId : channelThemeId;
}

// The cable-guide screens are laid out on a 60-unit-wide grid (1 unit = 16px
// at 960 wide). The live-video box hangs from the top-right corner of the
// header: 20.5 × 11.5 units, 1.75 units in from the right. Classic insets it
// from the top and frames it, so it is a little shorter.
export const GRID_UNITS = 60;

export function pictureBoxRect(width, height, guideLayout = 'hd') {
  if (!(width > 0) || !(height > 0)) return null;
  const unit = width / GRID_UNITS;
  const classic = guideLayout === 'classic';
  const w = 20.5 * unit;
  const h = (classic ? 9.8 : 11.5) * unit;
  return {
    left: Math.round(width - (1.75 + 20.5) * unit),
    top: Math.round((classic ? 0.9 : 0) * unit),
    width: Math.round(w),
    height: Math.round(Math.min(h, height)),
  };
}

// The listings page draws its own picture-box hole on #guide-grid, which can
// be bigger than the .crt screen (EXTEND GUIDE TO FULL SCREEN) and sits
// outside #display-frame's simulated-resolution scale. gridRect/crtRect are
// on-screen rects; crtLocalWidth is the .crt's own unscaled width. Returns the
// hole in grid pixels and the same box in .crt's local pixels, which is where
// #player is positioned — so the picture always lands in the hole.
export function listingsPictureBox(gridRect, crtRect, crtLocalWidth, guideLayout = 'hd') {
  const hole = pictureBoxRect(gridRect && gridRect.width, gridRect && gridRect.height, guideLayout);
  if (!hole || !crtRect || !(crtRect.width > 0)) return null;
  const scale = crtLocalWidth > 0 ? crtRect.width / crtLocalWidth : 1;
  return {
    hole,
    picture: {
      left: Math.round((gridRect.left + hole.left - crtRect.left) / scale),
      top: Math.round((gridRect.top + hole.top - crtRect.top) / scale),
      width: Math.round(hole.width / scale),
      height: Math.round(hole.height / scale),
    },
  };
}

export function sameRect(a, b) {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

// "8:01pm" / "20:01" — the guide's own short clock, not formatClock's "8:01 PM".
export function guideClock(date, clock24 = false) {
  const h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  if (clock24) return `${String(h).padStart(2, '0')}:${m}`;
  return `${h % 12 || 12}:${m}${h >= 12 ? 'pm' : 'am'}`;
}

// Program info's action tiles. A plugin action may name its own icon
// (guide-program-actions hook, `icon`); otherwise the label picks one, and
// anything unknown gets a text tile.
export const ACTION_ICONS = Object.freeze(['back', 'play', 'start', 'info', 'record', 'series', 'remind', 'list', 'day-back', 'day-ahead', 'menu', 'favorite', 'lock', 'mark']);

const LABEL_ICONS = [
  [/^watch from start|^start over/i, 'start'],
  [/^tune|^watch\b/i, 'play'],
  [/^info\b|^details/i, 'info'],
  [/^record series/i, 'series'],
  [/^record|^tape/i, 'record'],
  [/^remind|^reminder/i, 'remind'],
  [/^open list/i, 'list'],
  [/−\s*24|-\s*24/, 'day-back'],
  [/\+\s*24/, 'day-ahead'],
  [/^tv menu|^menu/i, 'menu'],
  [/favou?rite/i, 'favorite'],
  [/lock/i, 'lock'],
  [/air ?check|^mark/i, 'mark'],
];

export function actionIcon(label, explicit) {
  if (explicit && ACTION_ICONS.includes(explicit)) return explicit;
  const text = String(label || '');
  const hit = LABEL_ICONS.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

// "RECORD SERIES" → "Record series": the one line under the tiles.
export function actionMeaning(label) {
  const text = String(label || '').trim();
  if (!text) return '';
  const lower = text.toLowerCase().replace(/\btv\b/g, 'TV');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Left/right across the tiles, stopping at the ends.
export function stepTile(index, count, direction) {
  if (!(count > 0)) return -1;
  return Math.max(0, Math.min(count - 1, index + direction));
}

// The guide's compact time range: "12-1p", "3:30-4p", "8-10p", "11:30p-12:30a";
// "20:00-21:30" on a 24-hour box. Minutes only when they aren't :00, and the
// am/pm once at the end unless the range crosses it.
export function guideRange(start, end, clock24 = false) {
  const part = (d, withSuffix) => {
    const h = d.getHours();
    const m = d.getMinutes();
    if (clock24) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const hour = h % 12 || 12;
    const mins = m ? `:${String(m).padStart(2, '0')}` : '';
    return `${hour}${mins}${withSuffix ? (h >= 12 ? 'p' : 'a') : ''}`;
  };
  const crosses = (start.getHours() >= 12) !== (end.getHours() >= 12);
  return `${part(start, clock24 || crosses)}-${part(end, true)}`;
}

// "Today" while the grid shows the viewing day, else the weekday.
export function guideDayLabel(windowStart, now) {
  const a = new Date(windowStart);
  const b = new Date(now);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()) return 'Today';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][a.getDay()];
}

// surfaces: [[name, { connected, hidden }]] → the open names, sorted and
// de-duplicated, so the published value only changes when the set does.
export function openSurfaceNames(surfaces) {
  const open = new Set();
  for (const [name, state] of surfaces) {
    if (state && state.connected && !state.hidden) open.add(name);
  }
  return Array.from(open).sort();
}
