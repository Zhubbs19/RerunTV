// The channel banner as a hub (docs/design/01 §6.1). In TV mode OK on live TV
// opens the banner; ◀▶ then browse channels *without* tuning (a real box's
// "preview while you decide"), OK tunes the one shown, and ▼ opens that
// programme's actions — Now, Next, Info, and whatever plugins add through the
// same 'guide-program-actions' hook the guide uses.
//
// Desktop is unchanged: Enter still just flashes the banner.
import { isHiddenForProfile } from '../personal/state.js';
import { getChannel, sortedChannels } from '../core/channels.js';
import { guideOverlay, tvScreen } from '../core/dom.js';
import { showGuideOverlay } from '../guide/guide.js';
import { showDetailsOverlay } from './details.js';
import { tuneToChannel } from '../playback/core.js';
import { getChannelSchedule } from '../core/schedule.js';
import { S, viewNow } from '../core/state.js';
import { formatSlotLabel, getDisplayTitle } from '../core/util.js';
import { runCoreHooks } from '../plugin/host.js';
import { virtualChannelInfo, virtualChannelNumbers, isVirtualChannel } from '../playback/virtual.js';
import { Menu } from '../ui/menu.js';

const IDLE_CLOSE_MS = 12000;

let browsing = null; // the channel number shown while browsing
let openedOn = null; // S.currentNumber when the hub opened; a different one means something else tuned
let idleTimer = null;
let actionsMenu = null; // a kit Menu this module drives (docs/design/04 §3)

/**
 * Something outside the hub (a typed number, a reminder, the guide) tuned while
 * it was open: its browse position is stale, so close it.
 */
function dropIfStale() {
  if (browsing != null && S.currentNumber !== openedOn) closeBannerHub();
}

/**
 * Tests whether the banner hub is open, closing it first if something else tuned meanwhile.
 * @returns {boolean} True while browsing.
 */
export function bannerHubOpen() {
  dropIfStale();
  return browsing != null;
}

/**
 * Tests whether the banner's actions menu is open.
 * @returns {boolean} True while the menu is up.
 */
export function bannerActionsOpen() {
  return !!actionsMenu;
}

/**
 * Every tunable number in order, specials included (doc 11 put them in the
 * guide's list too).
 * @returns {number[]} Visible channel numbers and special channels, ascending.
 */
function browseNumbers() {
  const real = sortedChannels().filter((ch) => !ch.hidden && !isHiddenForProfile(ch.number)).map((ch) => ch.number);
  return [...new Set([...real, ...virtualChannelNumbers()])].sort((a, b) => a - b);
}

/**
 * Restarts the timer that closes the hub after `IDLE_CLOSE_MS` without a press.
 */
function armIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeBannerHub, IDLE_CLOSE_MS);
}

/**
 * Shows the banner for a channel without tuning it and keeps it up while browsing.
 * @param {number} number The channel number to show.
 */
function showFor(number) {
  if (browsing == null) openedOn = S.currentNumber;
  browsing = number;
  const ch = getChannel(number);
  showGuideOverlay(number, ch);
  // showGuideOverlay arms its own short auto-hide; while browsing, the banner
  // stays up until you stop pressing buttons.
  clearTimeout(S.guideHideTimer);
  S.guideHideTimer = null;
  guideOverlay.classList.remove('hidden');
  armIdleClose();
}

/**
 * Opens the banner hub on the current channel.
 */
export function openBannerHub() {
  showFor(S.currentNumber);
}

/**
 * Closes the banner hub and its actions menu and hides the banner.
 */
export function closeBannerHub() {
  closeBannerActions();
  clearTimeout(idleTimer);
  idleTimer = null;
  browsing = null;
  openedOn = null;
  guideOverlay.classList.add('hidden');
}

/**
 * Shows the next or previous channel in the hub without tuning; opens the hub when it is closed.
 * @param {number} direction 1 for the next channel, -1 for the previous one.
 */
export function browseChannel(direction) {
  dropIfStale();
  const numbers = browseNumbers();
  if (!numbers.length) return;
  if (browsing == null) { openBannerHub(); return; }
  const idx = numbers.indexOf(browsing);
  const next = numbers[((idx === -1 ? 0 : idx) + direction + numbers.length) % numbers.length];
  showFor(next);
}

/**
 * Closes the hub and tunes to the channel it was showing, or re-shows the banner when that is the current channel.
 */
export function tuneBrowsed() {
  dropIfStale();
  const number = browsing;
  closeBannerHub();
  if (number != null && number !== S.currentNumber) tuneToChannel(number);
  else if (number != null) showGuideOverlay(number, getChannel(number));
}

// ---------- Now / Next / actions ----------

/**
 * Finds what is on now and next on a channel from `viewNow()`, or a special channel's text.
 * @param {number} number The channel number.
 * @returns {object} `{ now, next, specialText, ch }`; `now` and `next` are schedule entries or null.
 */
function nowAndNext(number) {
  if (isVirtualChannel(number)) {
    const info = virtualChannelInfo(number);
    return { now: null, next: null, specialText: info.nowText || info.name };
  }
  const ch = getChannel(number);
  if (!ch) return { now: null, next: null, specialText: '' };
  const from = viewNow();
  const entries = getChannelSchedule(ch, from, from + 6 * 3600000).filter((e) => e.end > from);
  return { now: entries[0] || null, next: entries[1] || null, specialText: '', ch };
}

/**
 * Closes the banner's actions menu if it is open.
 */
export function closeBannerActions() {
  if (!actionsMenu) return;
  const menu = actionsMenu;
  actionsMenu = null;
  menu.close();
}

/**
 * Opens the actions menu for the channel the hub shows: INFO, plugin actions for the current programme, and WATCH.
 */
export function openBannerActions() {
  dropIfStale();
  if (browsing == null || actionsMenu) return;
  const number = browsing;
  const { now, next, specialText, ch } = nowAndNext(number);
  const actionItems = [];
  if (now && ch) {
    actionItems.push({ label: `INFO · ${getDisplayTitle(now.file)}`, run: () => showDetailsOverlay(now.file, { channelNumber: ch.number, channelName: ch.name, airTime: `${formatSlotLabel(now.start)} – ${formatSlotLabel(now.end)}` }) });
    const extra = [];
    runCoreHooks('guide-program-actions', { channel: ch, entry: now, actions: extra });
    extra.filter((a) => a && a.label && typeof a.run === 'function')
      .forEach((a) => actionItems.push({ label: String(a.label).toUpperCase(), run: () => a.run() }));
  }
  actionItems.push({ label: `WATCH CH ${number}`, run: () => tuneBrowsed() });

  const heading = now
    ? `${getDisplayTitle(now.file)} · NEXT ${next ? getDisplayTitle(next.file) : '—'}`
    : (specialText || `CH ${number}`);
  // Running an action closes the hub too, then runs it.
  const items = actionItems.map((item) => ({ label: item.label, run: () => { closeBannerHub(); item.run(); } }));
  const menu = Menu({
    heading,
    groups: [items],
    focus: false,
    classes: { root: 'guide-run-list', item: 'guide-run-item', heading: 'guide-run-heading', rule: 'guide-run-rule' },
    className: 'banner-actions',
    onClose: () => { if (actionsMenu === menu) actionsMenu = null; },
  });
  actionsMenu = menu;
  // Its spot above the channel banner is CSS (.banner-actions), not placement.
  menu.open({ container: tvScreen.querySelector('.crt') || tvScreen, place: false });
  armIdleClose();
}

// ---------- Keys (routed from tv-input's 'banner' context) ----------

/**
 * Handles a remote action while the banner hub has focus: browse, tune, open or drive the actions menu, or close.
 * @param {string} action The remote action, e.g. `left`, `ok`, `back`.
 * @returns {boolean} True when the action was handled.
 */
export function bannerKey(action) {
  armIdleClose();
  if (actionsMenu) {
    if (action === 'up' || action === 'down' || action === 'ok') return actionsMenu.key(action);
    if (action === 'back' || action === 'left' || action === 'right') { closeBannerActions(); return true; }
    return false;
  }
  if (action === 'left') { browseChannel(-1); return true; }
  if (action === 'right') { browseChannel(1); return true; }
  if (action === 'ok') { tuneBrowsed(); return true; }
  if (action === 'down') { openBannerActions(); return true; }
  if (action === 'back' || action === 'up') { closeBannerHub(); return true; }
  return false;
}
