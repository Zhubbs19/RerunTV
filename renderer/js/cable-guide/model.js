// Pure rules for the cable-guide UI (renderer/css/cable-guide.css):
// which layout a theme turns on, where the live-video box sits, how the
// header clock reads, and which overlay surfaces count as open. No DOM, so
// tests/cable-guide.test.js imports it directly.

import { creditSentences, programDetails } from '../library/program-details.js';

export const CABLE_GUIDE_UI = 'cable-guide';
export const LEGACY_UI = 'legacy';

/**
 * Picks the on-screen layout a theme pack turns on.
 * @param {?object} pack The registered theme pack.
 * @returns {string} `CABLE_GUIDE_UI` when the pack sets `ui: 'cable-guide'`, otherwise `LEGACY_UI`.
 */
export function uiModeForPack(pack) {
  return pack && pack.ui === CABLE_GUIDE_UI ? CABLE_GUIDE_UI : LEGACY_UI;
}

/**
 * The theme id to paint with: the channel's identity theme on the legacy
 * layout (today's behaviour), the box skin on the cable-guide layout, whose
 * CSS reads tokens only the two skins define.
 * @param {object} opts The current choice.
 * @param {string} opts.uiMode The on-screen layout.
 * @param {string} opts.boxThemeId The box theme id.
 * @param {?string} opts.channelThemeId The tuned channel's identity theme id.
 * @returns {?string} The theme id to paint.
 */
export function paintedThemeId({ uiMode, boxThemeId, channelThemeId }) {
  return uiMode === CABLE_GUIDE_UI ? boxThemeId : channelThemeId;
}

// The cable-guide screens are laid out on a grid `units` wide: 60 in TV mode
// (1 unit = 16px at 960 wide), denser on a desktop window (cable-guide.css's
// --grid-units). The live-video box hangs from the top-right corner of the
// header: 20.5 × 11.5 units, 1.75 units in from the right. Classic insets it
// from the top and frames it, so it is a little shorter.
export const GRID_UNITS = 60;

/**
 * Places the live-video box in a screen of the given size.
 * @param {number} width Screen width in pixels.
 * @param {number} height Screen height in pixels.
 * @param {string} [guideLayout='hd'] 'hd' or 'classic'.
 * @param {number} [units=GRID_UNITS] Grid units across the screen.
 * @returns {?object} `{ left, top, width, height }` in pixels, or null for an empty size.
 */
export function pictureBoxRect(width, height, guideLayout = 'hd', units = GRID_UNITS) {
  if (!(width > 0) || !(height > 0)) return null;
  const unit = width / (units > 0 ? units : GRID_UNITS);
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

/**
 * The listings page draws its own picture-box hole on #guide-grid, which can
 * be bigger than the .crt screen (EXTEND GUIDE TO FULL SCREEN) and sits
 * outside #display-frame's simulated-resolution scale. gridRect/crtRect are
 * on-screen rects; crtLocalWidth is the .crt's own unscaled width. Returns the
 * hole in grid pixels and the same box in .crt's local pixels, which is where
 * #player is positioned — so the picture always lands in the hole.
 * @param {?DOMRect} gridRect The guide grid's on-screen rect.
 * @param {?DOMRect} crtRect The `.crt` element's on-screen rect.
 * @param {number} crtLocalWidth The `.crt` element's unscaled width.
 * @param {string} [guideLayout='hd'] 'hd' or 'classic'.
 * @param {number} [units=GRID_UNITS] Grid units across the screen.
 * @returns {?{hole: object, picture: object}} The two rects, or null when either size is missing.
 */
export function listingsPictureBox(gridRect, crtRect, crtLocalWidth, guideLayout = 'hd', units = GRID_UNITS) {
  const hole = pictureBoxRect(gridRect && gridRect.width, gridRect && gridRect.height, guideLayout, units);
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

/**
 * Where the logo bug goes while the picture sits in the picture box: the
 * spot it holds on the full screen (its left/top in the screen's px) mapped
 * onto the box, scaled with it. One scale for both axes so the logo keeps its
 * shape.
 * @param {?object} bug The bug's spot on the full screen (`left`, `top`, in px).
 * @param {?object} box The picture box (`left`, `top`, `width`, `height`, in px).
 * @param {number} screenW The screen's width in px.
 * @param {number} screenH The screen's height in px.
 * @returns {?{x: number, y: number, scale: number}} The translate that moves the bug there (its
 *   scale origin is its own top-left) and that scale, or null when there's nothing to map.
 */
export function bugInPictureBox(bug, box, screenW, screenH) {
  if (!bug || !box || !(screenW > 0) || !(screenH > 0)) return null;
  const kx = box.width / screenW;
  const ky = box.height / screenH;
  return {
    x: box.left + bug.left * kx - bug.left,
    y: box.top + bug.top * ky - bug.top,
    scale: Math.min(kx, ky),
  };
}

/**
 * Compares two rects by position and size.
 * @param {?object} a A rect, or null.
 * @param {?object} b A rect, or null.
 * @returns {boolean} True when both match, or both are missing.
 */
export function sameRect(a, b) {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * "8:01pm" / "20:01" — the guide's own short clock, not formatClock's "8:01 PM".
 * `short` gives the Mini Guide's "8:01p".
 * @param {Date} date The time to show.
 * @param {boolean} [clock24=false] Use a 24-hour clock.
 * @param {boolean} [short=false] Drop the trailing 'm'.
 * @returns {string} The clock text.
 */
export function guideClock(date, clock24 = false, short = false) {
  const h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  if (clock24) return `${String(h).padStart(2, '0')}:${m}`;
  return `${h % 12 || 12}:${m}${h >= 12 ? 'p' : 'a'}${short ? '' : 'm'}`;
}

// Program info's action tiles. A plugin action may name its own icon
// (guide-program-actions hook, `icon`); otherwise the label picks one, and
// anything unknown gets a text tile.
export const ACTION_ICONS = Object.freeze(['back', 'play', 'start', 'info', 'record', 'series', 'remind', 'list', 'day-back', 'day-ahead', 'menu', 'favorite', 'lock', 'mark']);

// Label patterns, in order, and the icon the first match picks.
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

/**
 * Picks the icon for a program action tile.
 * @param {string} label The action's label.
 * @param {?string} explicit An icon the action names itself.
 * @returns {?string} An `ACTION_ICONS` name, or null for a text tile.
 */
export function actionIcon(label, explicit) {
  if (explicit && ACTION_ICONS.includes(explicit)) return explicit;
  const text = String(label || '');
  const hit = LABEL_ICONS.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

/**
 * "RECORD SERIES" → "Record series": the one line under the tiles.
 * @param {string} label The action's label.
 * @returns {string} The label in sentence case.
 */
export function actionMeaning(label) {
  const text = String(label || '').trim();
  if (!text) return '';
  const lower = text.toLowerCase().replace(/\btv\b/g, 'TV');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Program info's text the way the real boxes ran it: the episode in quotes,
 * then the description, then the credits a metadata source found —
 *   "The First Day", The staff meets the new boss. Starring A, B and C.
 *   First aired September 20, 2005 on A Network.
 * Sources are merged by library/program-details.js. `credits` is the
 * display.programInfoCredits setting (on unless switched off).
 * @param {string} description The file's own description.
 * @param {?object} file The file entry, read for series, episode and credits.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.credits=true] Add the credit sentences.
 * @returns {string} The program info text.
 */
export function programDescription(description, file, { credits = true } = {}) {
  const details = programDetails(file);
  let text = String(description || '').trim();
  if (details.episodeTitle && details.seriesName) {
    const quoted = `"${details.episodeTitle}"`;
    text = text ? `${quoted}, ${text}` : `${quoted}.`;
  }
  const closing = credits ? creditSentences(details) : '';
  if (!closing) return text;
  const lead = text && !/[.!?…)"”]$/.test(text) ? `${text}.` : text;
  return `${lead ? `${lead} ` : ''}${closing}`;
}

/**
 * The page title: the series when one is known (the episode goes in quotes
 * in the description, as above), otherwise the program's own title.
 * @param {?object} file The file entry.
 * @param {string} fallback The program's own title.
 * @returns {string} The page title.
 */
export function programHeading(file, fallback) {
  return programDetails(file).seriesName || fallback;
}

/**
 * Left/right across the tiles, stopping at the ends.
 * @param {number} index The focused tile.
 * @param {number} count The number of tiles.
 * @param {number} direction -1 for left, 1 for right.
 * @returns {number} The new index, or -1 when there are no tiles.
 */
export function stepTile(index, count, direction) {
  if (!(count > 0)) return -1;
  return Math.max(0, Math.min(count - 1, index + direction));
}

/**
 * The guide's compact time range: "12-1p", "3:30-4p", "8-10p", "11:30p-12:30a";
 * "20:00-21:30" on a 24-hour box. Minutes only when they aren't :00, and the
 * am/pm once at the end unless the range crosses it.
 * @param {Date} start The start time.
 * @param {Date} end The end time.
 * @param {boolean} [clock24=false] Use a 24-hour clock.
 * @returns {string} The range text.
 */
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

/**
 * "Today" while the grid shows the viewing day, else the weekday.
 * @param {number} windowStart The grid window's start, epoch milliseconds.
 * @param {number} now The viewing time, epoch milliseconds.
 * @returns {string} 'Today' or a weekday name.
 */
export function guideDayLabel(windowStart, now) {
  const a = new Date(windowStart);
  const b = new Date(now);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()) return 'Today';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][a.getDay()];
}

/**
 * The short airing date a result list prints beside a title: "Today", a
 * three-letter day within the coming week, then the month and day.
 * @param {number} start The airing's start, epoch milliseconds.
 * @param {number} now The viewing time, epoch milliseconds.
 * @returns {string} 'Today', a three-letter day, or `M/D`.
 */
export function guideShortDay(start, now) {
  const label = guideDayLabel(start, now);
  if (label === 'Today') return label;
  const a = new Date(start);
  const b = new Date(now);
  const weekOut = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 7);
  if (a < weekOut) return label.slice(0, 3);
  return `${a.getMonth() + 1}/${a.getDate()}`;
}

// ---------- Menus ----------
// Menu labels are written in caps for the legacy menu; the cable-guide
// menus show them in title case ("LAST CH" → "Last CH", "CHANNELS ›" →
// "Channels"). Abbreviations and symbols keep their case.
const KEEP_CASE = new Set(['CH', 'TV', 'PC', 'CRT', 'DVR', 'PIN', 'ID', 'OK', 'HD', 'SD', 'SAP', 'VOL', 'AM', 'PM', 'LAN', 'QR', 'CSS', 'DVD', 'URL', 'IP', 'CC', 'FX',
  'VHS', 'UHF', 'VHF', 'HDMI', 'CEC', 'EAS', 'OSD', 'ZIP', 'JSON', 'CSV', 'MP', 'MKV', 'USB', 'UI', 'API', 'NTSC', 'PAL']);
const LOWER_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * Turns an all-caps menu label into the cable-guide menus' title case.
 * Drops a trailing submenu arrow; listed abbreviations stay in caps and short joining words go lower case.
 * @param {string} label The legacy menu label.
 * @returns {string} The label in title case.
 */
export function menuLabel(label) {
  const text = String(label || '').replace(/\s*›\s*$/, '').trim();
  let first = true;
  return text.replace(/[A-Za-z][A-Za-z'’]*/g, (word, at) => {
    const upper = word.toUpperCase();
    // A word straight after a separator starts a new phrase ("CH 6 · The…").
    if (/[·›:—(]\s*$/.test(text.slice(0, at))) first = true;
    let out;
    // A decade: "1970S" → "1970s".
    if (upper === 'S' && /\d$/.test(text.slice(0, at))) out = 's';
    else if (KEEP_CASE.has(upper)) out = upper;
    else if (!first && LOWER_WORDS.has(word.toLowerCase())) out = word.toLowerCase();
    else out = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    first = false;
    return out;
  });
}

// The Main Menu grid: two columns of five, filled down each column, a page at
// a time ("More Choices"). Settings pages are one column of five rows.
export const MENU_ROWS = 5;
export const MENU_PAGE = MENU_ROWS * 2;

/**
 * Works out which page of a menu an item is on.
 * @param {number} index The item index.
 * @param {string} layout 'rows' for a settings page, otherwise the two-column grid.
 * @returns {number} The zero-based page number.
 */
export function menuPageOf(index, layout) {
  return Math.floor(index / (layout === 'rows' ? MENU_ROWS : MENU_PAGE));
}

/**
 * One arrow press on a menu page. layout is 'grid' (two columns, paged),
 * 'rows' (settings, one column, paged by five) or a number (a fixed
 * row-major grid that many columns wide, like the number pad). Returns the
 * new index, or `edge: 'left' | 'right'` when the press runs off the side.
 * @param {number} index The focused item.
 * @param {number} count The number of items.
 * @param {string} key The arrow key name, such as 'ArrowDown'.
 * @param {string|number} [layout='grid'] 'grid', 'rows' or a column count.
 * @returns {{index: number, edge: ?string}} The new index and the edge run off, if any.
 */
export function menuMove(index, count, key, layout = 'grid') {
  if (!(count > 0)) return { index: -1, edge: null };
  const stay = { index, edge: null };
  if (typeof layout === 'number') {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -layout, ArrowDown: layout }[key];
    if (step == null) return stay;
    const next = index + step;
    if (key === 'ArrowLeft' && index % layout === 0) return { index, edge: 'left' };
    return next >= 0 && next < count ? { index: next, edge: null } : stay;
  }
  if (layout === 'rows') {
    if (key === 'ArrowDown') return { index: Math.min(count - 1, index + 1), edge: null };
    if (key === 'ArrowUp') return { index: Math.max(0, index - 1), edge: null };
    if (key === 'ArrowLeft') return { index, edge: 'left' };
    if (key === 'ArrowRight') return { index, edge: 'right' };
    return stay;
  }
  const page = Math.floor(index / MENU_PAGE);
  const local = index % MENU_PAGE;
  const col = Math.floor(local / MENU_ROWS);
  const row = local % MENU_ROWS;
  const pageStart = page * MENU_PAGE;
  const pageEnd = Math.min(count, pageStart + MENU_PAGE);
  if (key === 'ArrowDown') {
    if (row < MENU_ROWS - 1 && index + 1 < pageEnd && Math.floor(((index + 1) % MENU_PAGE) / MENU_ROWS) === col) return { index: index + 1, edge: null };
    const nextStart = pageStart + MENU_PAGE;
    if (nextStart < count) return { index: Math.min(count - 1, nextStart + col * MENU_ROWS), edge: null };
    return stay;
  }
  if (key === 'ArrowUp') {
    if (row > 0) return { index: index - 1, edge: null };
    if (page > 0) return { index: (page - 1) * MENU_PAGE + col * MENU_ROWS + MENU_ROWS - 1, edge: null };
    return stay;
  }
  if (key === 'ArrowRight') {
    if (col === 0 && pageStart + MENU_ROWS < pageEnd) return { index: Math.min(index + MENU_ROWS, pageEnd - 1), edge: null };
    return { index, edge: 'right' };
  }
  if (key === 'ArrowLeft') {
    if (col === 1) return { index: index - MENU_ROWS, edge: null };
    return { index, edge: 'left' };
  }
  return stay;
}

/**
 * Listings by Channel: what OK does with a program.
 * @param {object} entry The schedule entry (`start`, `end`).
 * @param {number} now The viewing time, epoch milliseconds.
 * @param {boolean} timeMachineOn Whether the time machine is enabled.
 * @param {boolean} reminded Whether a reminder is set for this entry.
 * @returns {string} 'watch', 'rewind', 'none', 'remind' or 'unremind'.
 */
export function byChannelAction(entry, now, timeMachineOn, reminded) {
  if (entry.start <= now && entry.end > now) return 'watch';
  if (entry.end <= now) return timeMachineOn ? 'rewind' : 'none';
  return reminded ? 'unremind' : 'remind';
}

/**
 * surfaces: [[name, { connected, hidden }]] → the open names, sorted and
 * de-duplicated, so the published value only changes when the set does.
 * @param {Array<Array>} surfaces `[name, { connected, hidden }]` pairs.
 * @returns {string[]} The open surface names.
 */
export function openSurfaceNames(surfaces) {
  const open = new Set();
  for (const [name, state] of surfaces) {
    if (state && state.connected && !state.hidden) open.add(name);
  }
  return Array.from(open).sort();
}

/**
 * Search results as one row per show (the cable-guide Search page): airings
 * that share a title, in the order of each show's first airing. Each group
 * keeps its airings in time order.
 * @param {Array<object>} results The search results, in time order.
 * @returns {Array<{title: string, results: Array<object>}>} One group per title.
 */
export function groupResultsByTitle(results) {
  const groups = new Map();
  for (const result of results) {
    const key = String(result.title || '').trim().toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { title: result.title, results: [] });
    groups.get(key).results.push(result);
  }
  return Array.from(groups.values());
}
