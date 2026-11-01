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

// surfaces: [[name, { connected, hidden }]] → the open names, sorted and
// de-duplicated, so the published value only changes when the set does.
export function openSurfaceNames(surfaces) {
  const open = new Set();
  for (const [name, state] of surfaces) {
    if (state && state.connected && !state.hidden) open.add(name);
  }
  return Array.from(open).sort();
}
