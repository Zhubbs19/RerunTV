// The channel banner as a hub (docs/design/01 §6.1). In TV mode OK on live TV
// opens the banner; ◀▶ then browse channels *without* tuning (a real box's
// "preview while you decide"), OK tunes the one shown, and ▼ opens that
// programme's actions — Now, Next, Info, and whatever plugins add through the
// same 'guide-program-actions' hook the guide uses.
//
// Desktop is unchanged: Enter still just flashes the banner.
import { getChannel, sortedChannels } from './channels.js';
import { guideOverlay, tvScreen } from './dom.js';
import { showGuideOverlay } from './guide.js';
import { showDetailsOverlay } from './details.js';
import { tuneToChannel } from './playback-core.js';
import { getChannelSchedule } from './schedule.js';
import { S, viewNow } from './state.js';
import { formatSlotLabel, getDisplayTitle } from './util.js';
import { runCoreHooks } from './plugins.js';
import { virtualChannelInfo, virtualChannelNumbers, isVirtualChannel } from './virtual.js';

const IDLE_CLOSE_MS = 12000;

let browsing = null; // the channel number shown while browsing
let idleTimer = null;
let actionsEl = null;
let actionsIdx = 0;
let actionItems = [];

export function bannerHubOpen() {
  return browsing != null;
}

export function bannerActionsOpen() {
  return !!actionsEl;
}

// Every tunable number in order, specials included (doc 11 put them in the
// guide's list too).
function browseNumbers() {
  const real = sortedChannels().filter((ch) => !ch.hidden).map((ch) => ch.number);
  return [...new Set([...real, ...virtualChannelNumbers()])].sort((a, b) => a - b);
}

function armIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeBannerHub, IDLE_CLOSE_MS);
}

function showFor(number) {
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

export function openBannerHub() {
  showFor(S.currentNumber);
}

export function closeBannerHub() {
  closeBannerActions();
  clearTimeout(idleTimer);
  idleTimer = null;
  browsing = null;
  guideOverlay.classList.add('hidden');
}

export function browseChannel(direction) {
  const numbers = browseNumbers();
  if (!numbers.length) return;
  if (browsing == null) { openBannerHub(); return; }
  const idx = numbers.indexOf(browsing);
  const next = numbers[((idx === -1 ? 0 : idx) + direction + numbers.length) % numbers.length];
  showFor(next);
}

export function tuneBrowsed() {
  const number = browsing;
  closeBannerHub();
  if (number != null && number !== S.currentNumber) tuneToChannel(number);
  else if (number != null) showGuideOverlay(number, getChannel(number));
}

// ---------- Now / Next / actions ----------

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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function closeBannerActions() {
  if (actionsEl) { actionsEl.remove(); actionsEl = null; }
  actionItems = [];
  actionsIdx = 0;
}

function highlightAction() {
  if (!actionsEl) return;
  Array.from(actionsEl.querySelectorAll('.guide-run-item')).forEach((item, i) => {
    item.classList.toggle('active', i === actionsIdx);
    item.setAttribute('aria-selected', i === actionsIdx ? 'true' : 'false');
  });
}

export function openBannerActions() {
  if (browsing == null || actionsEl) return;
  const number = browsing;
  const { now, next, specialText, ch } = nowAndNext(number);
  actionItems = [];
  if (now && ch) {
    actionItems.push({ label: `INFO · ${getDisplayTitle(now.file)}`, run: () => showDetailsOverlay(now.file, { channelNumber: ch.number, channelName: ch.name, airTime: `${formatSlotLabel(now.start)} – ${formatSlotLabel(now.end)}` }) });
    const extra = [];
    runCoreHooks('guide-program-actions', { channel: ch, entry: now, actions: extra });
    extra.filter((a) => a && a.label && typeof a.run === 'function')
      .forEach((a) => actionItems.push({ label: String(a.label).toUpperCase(), run: () => a.run() }));
  }
  actionItems.push({ label: `WATCH CH ${number}`, run: () => tuneBrowsed() });

  actionsEl = el('div', 'guide-run-list banner-actions');
  actionsEl.setAttribute('role', 'listbox');
  const heading = now
    ? `${getDisplayTitle(now.file)} · NEXT ${next ? getDisplayTitle(next.file) : '—'}`
    : (specialText || `CH ${number}`);
  actionsEl.appendChild(el('div', 'guide-run-heading', heading));
  actionItems.forEach((item, i) => {
    const button = el('button', 'guide-run-item');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.tabIndex = -1;
    button.appendChild(el('span', 'guide-run-title', item.label));
    button.addEventListener('click', () => runBannerAction(i));
    actionsEl.appendChild(button);
  });
  (tvScreen.querySelector('.crt') || tvScreen).appendChild(actionsEl);
  actionsIdx = 0;
  highlightAction();
  armIdleClose();
}

function runBannerAction(i) {
  const item = actionItems[i];
  closeBannerActions();
  closeBannerHub();
  if (item && item.run) item.run();
}

// ---------- Keys (routed from tv-input's 'banner' context) ----------

export function bannerKey(action) {
  armIdleClose();
  if (actionsEl) {
    if (action === 'up') { actionsIdx = Math.max(0, actionsIdx - 1); highlightAction(); return true; }
    if (action === 'down') { actionsIdx = Math.min(actionItems.length - 1, actionsIdx + 1); highlightAction(); return true; }
    if (action === 'ok') { runBannerAction(actionsIdx); return true; }
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
