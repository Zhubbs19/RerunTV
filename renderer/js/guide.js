import { showSetupScreen } from './app.js';
import { toggleCrt } from './power.js';
import { playConfiguredSound, sfxGuideToggle } from './audio.js';
import { buildChannelBadge, channelColor, filteredChannels, formatChannelNumber, getChannel, guideSlots, sortedChannels } from './channels.js';
import {
  crtContainer, giChannelEl, giNumberEl, giTimeEl, giTitleEl, guideBarFillEl, guideDateRangeEl, guideGrid,
  guideGridlinesEl, guideLogoEl, guideMuteEl, guideNameEl, guideNowEl, guideNowLineEl, guideNumberEl, guideOverlay,
  guideRowsEl, guideSearchEl, guideTimeHeaderEl, player,
} from './dom.js';
import { showDetailsOverlay } from './details.js';
import { tuneToChannel } from './playback-core.js';
import { breakEntriesInWindow } from './interstitials.js';
import { computeLivePosition, getChannelSchedule } from './schedule.js';
import { GUIDE_SLOT_MS, MONTHS, S, WEEKDAYS, viewNow, commitInPlace } from './state.js';
import { searchUpcomingPrograms } from './program-search.js';
import { guideGenreStyleForFile } from './guide-genres.js';
import { updateTimeShiftBadge } from './timemachine.js';
import {
  autoHideAfter, escapeHtml, floorToSlot, formatSlotLabel, getDisplayTitle,
} from './util.js';
import { virtualChannelInfo, virtualChannelNumbers } from './virtual.js';
import {
  cellIndexAt, channelCallLetters, abbreviateChannelName, guideRows, mergeMicroPrograms, moveSelection, rowScrollTop, selectedIndex,
} from './guide-model.js';
import { BREAK_LABELS, breakMarkEl, spanPercent } from './timeline-render.js';
import { effectiveThemeId } from './broadcast-identity.js';
import { getThemePack, runCoreHooks } from './plugins.js';

// The channel's icon (or a colored number badge, matching the logo bug's own
// fallback) shown next to the name on the "now watching" surf card.
function updateGuideLogo(ch) {
  guideLogoEl.innerHTML = '';
  guideLogoEl.style.background = '';
  if (!ch) {
    guideLogoEl.classList.add('hidden');
    return;
  }
  if (ch.icon) {
    const img = document.createElement('img');
    img.alt = '';
    window.api.toFileUrl(ch.icon).then((url) => { img.src = url; });
    guideLogoEl.appendChild(img);
  } else {
    guideLogoEl.style.background = channelColor(ch);
    guideLogoEl.textContent = String(ch.number);
  }
  guideLogoEl.classList.remove('hidden');
}

export function showGuideOverlay(number, ch) {
  guideNumberEl.textContent = formatChannelNumber(number);
  if (!ch) {
    guideNameEl.textContent = S.config.display?.noSignalTitle?.trim() || 'NO SIGNAL';
    guideNowEl.textContent = '';
    guideBarFillEl.style.width = '0%';
  } else {
    guideNameEl.textContent = ch.name || 'UNTITLED CHANNEL';
    updateGuideNowPlaying(ch);
  }
  updateGuideLogo(ch);
  guideMuteEl.classList.toggle('hidden', !player.muted);
  guideOverlay.classList.remove('hidden');
  playConfiguredSound('card', number);
  const cardDuration = S.config.display?.guideCardDuration ?? 4000;
  S.guideHideTimer = autoHideAfter(S.guideHideTimer, cardDuration, () => guideOverlay.classList.add('hidden'));
}

export function updateGuideNowPlaying(ch) {
  const pos = computeLivePosition(ch);
  if (!pos) return;
  const file = pos.file;
  guideNowEl.textContent = `NOW: ${getDisplayTitle(file)}`;
  const pct = (pos.offset / file.duration) * 100;
  guideBarFillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

setInterval(() => {
  if (!guideOverlay.classList.contains('hidden')) {
    const ch = getChannel(S.currentNumber);
    if (ch) updateGuideNowPlaying(ch);
  }
}, 1000);

// Guards the deferred close cleanup below against a rapid re-open/re-close
// landing while its setTimeout is still pending — without this, a stale
// close callback firing after a fresh open would yank 'hidden' back onto a
// guide the user just reopened.
let guideAnimToken = 0;
let guidePreviouslyFocused = null;
const programResultsEl = document.getElementById('guide-program-results');
const reminderToastEl = document.getElementById('program-reminder-toast');
const reminderCopyEl = document.getElementById('program-reminder-copy');
const reminderTuneBtn = document.getElementById('program-reminder-tune');
const reminderDismissBtn = document.getElementById('program-reminder-dismiss');
const notifiedReminders = new Set();
let activeReminder = null;
let programSearchTimer = null;

function hideProgramResults() {
  programResultsEl?.classList.add('hidden');
  if (programResultsEl) programResultsEl.innerHTML = '';
}

function jumpToProgramResult(result) {
  S.guideFilterQuery = '';
  guideSearchEl.value = '';
  S.guideSelNumber = result.channel.number;
  S.guideSelTime = result.entry.start + 1;
  S.guideWindowStart = floorToSlot(result.entry.start);
  hideProgramResults();
  renderGuideGrid();
}

function addProgramReminder(result) {
  if (!Array.isArray(S.config.reminders)) S.config.reminders = [];
  const duplicate = S.config.reminders.some((reminder) => reminder.channelNumber === result.channel.number && reminder.start === result.entry.start && reminder.path === result.entry.file.path);
  if (duplicate) return;
  S.config.reminders.push({
    id: `reminder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    channelNumber: result.channel.number, channelName: result.channel.name || '',
    title: result.title, path: result.entry.file.path,
    start: result.entry.start, end: result.entry.end,
  });
  commitInPlace({ type: 'settings.set', path: ['reminders'], value: S.config.reminders }, { label: 'Add reminder' });
}

function renderProgramResults(query) {
  if (!programResultsEl || query.trim().length < 2) { hideProgramResults(); return; }
  // Excludes ch.hidden directly rather than reusing filteredChannels() (that
  // would also apply S.guideFilterQuery, an unrelated filter, to this
  // separate program-title search) — a hidden channel shouldn't be
  // discoverable/tunable-to from search results either.
  const results = searchUpcomingPrograms(sortedChannels().filter((c) => !c.hidden), query, viewNow());
  programResultsEl.innerHTML = '';
  programResultsEl.classList.remove('hidden');
  const heading = document.createElement('div');
  heading.className = 'guide-program-results-heading';
  heading.textContent = results.length ? `${results.length} UPCOMING MATCH${results.length === 1 ? '' : 'ES'} · NEXT 7 DAYS` : 'NO UPCOMING PROGRAM MATCHES · NEXT 7 DAYS';
  programResultsEl.appendChild(heading);
  results.slice(0, 30).forEach((result) => {
    const row = document.createElement('div');
    row.className = 'guide-program-result';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'guide-program-result-copy';
    copy.innerHTML = `<strong>${escapeHtml(result.title)}</strong><span>CH ${formatChannelNumber(result.channel.number)} · ${escapeHtml(result.channel.name || 'UNNAMED')} · ${new Date(result.entry.start).toLocaleString()}</span>`;
    copy.addEventListener('click', () => jumpToProgramResult(result));
    const remind = document.createElement('button');
    remind.type = 'button';
    remind.className = 'btn';
    const exists = (S.config.reminders || []).some((entry) => entry.channelNumber === result.channel.number && entry.start === result.entry.start && entry.path === result.entry.file.path);
    remind.textContent = exists ? 'REMINDER SET' : 'REMIND ME';
    remind.disabled = exists;
    remind.addEventListener('click', () => { addProgramReminder(result); remind.textContent = 'REMINDER SET'; remind.disabled = true; });
    row.append(copy, remind);
    programResultsEl.appendChild(row);
  });
}

guideSearchEl.addEventListener('input', () => {
  clearTimeout(programSearchTimer);
  programSearchTimer = setTimeout(() => renderProgramResults(guideSearchEl.value), 160);
});

function removeReminder(id) {
  S.config.reminders = (S.config.reminders || []).filter((reminder) => reminder.id !== id);
  notifiedReminders.delete(id);
  commitInPlace({ type: 'settings.set', path: ['reminders'], value: S.config.reminders }, { label: 'Remove reminder' });
}

function dismissActiveReminder() {
  if (activeReminder) removeReminder(activeReminder.id);
  activeReminder = null;
  reminderToastEl?.classList.add('hidden');
}

function checkProgramReminders() {
  const now = viewNow();
  let changed = false;
  S.config.reminders = (S.config.reminders || []).filter((reminder) => {
    if (now > reminder.end + 5 * 60000) { changed = true; return false; }
    return true;
  });
  if (changed) if (changed) commitInPlace({ type: 'settings.set', path: ['reminders'], value: S.config.reminders }, { skipUndo: true });
  if (activeReminder) return;
  const leadMs = (S.config.reminderLeadMinutes || 1) * 60000;
  const due = (S.config.reminders || []).find((reminder) => !notifiedReminders.has(reminder.id) && now >= reminder.start - leadMs && now <= reminder.end);
  if (!due) return;
  activeReminder = due;
  notifiedReminders.add(due.id);
  const where = `CH ${due.channelNumber}${due.channelName ? ` · ${due.channelName}` : ''}`;
  reminderCopyEl.textContent = `${due.title} starts ${formatSlotLabel(due.start)} on ${where}.`;
  // Auto-tune makes TUNE NOW meaningless — hide it rather than leave a
  // button that re-tunes to the channel already on screen.
  const autoTune = !!S.config.reminderAutoTune;
  if (reminderTuneBtn) reminderTuneBtn.classList.toggle('hidden', autoTune);
  reminderToastEl.classList.remove('hidden');
  if (autoTune) tuneToChannel(due.channelNumber);
  // The toast is the primary delivery; this is the fallback for the case the
  // app is explicitly designed for — still broadcasting behind whatever the
  // user is actually working in, where nothing on the TV screen is visible.
  // Main refuses it outright if the window turns out to be focused after
  // all, so a stale document.hasFocus() here can't produce a duplicate.
  if (S.config.reminderNotify !== false && !document.hasFocus() && window.api?.showSystemNotification) {
    Promise.resolve(window.api.showSystemNotification({
      title: autoTune ? 'NOW TUNED' : 'PROGRAM REMINDER',
      body: `${due.title} — ${formatSlotLabel(due.start)} on ${where}`,
    })).catch(() => {});
  }
}

reminderTuneBtn?.addEventListener('click', () => {
  if (!activeReminder) return;
  tuneToChannel(activeReminder.channelNumber);
  dismissActiveReminder();
});
reminderDismissBtn?.addEventListener('click', dismissActiveReminder);
setInterval(checkProgramReminders, 15000);

function guideAnimEnabled() {
  return !!(S.config.display && S.config.display.guideOpenCloseAnim)
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Full-page guide mode (see guide.css's .guide-full rules) shrinks the live
// #player into a top-right preview box by default — an anachronistic look
// for a theme predating picture-in-picture. Once the user explicitly sets
// DISPLAY > GUIDE LIVE PREVIEW themselves, that choice always wins over
// whatever the active theme pack prefers (same "explicit user choice beats
// theme default" pattern as getPluginChannelDisplaySettings's INHERIT
// semantics, plugins.js) — hasOwnProperty, not a truthiness check, is what
// lets an explicit `false` be distinguished from "never set".
function guideLivePreviewEnabled() {
  const display = S.config.display || {};
  if (Object.prototype.hasOwnProperty.call(display, 'guideLivePreview')) return !!display.guideLivePreview;
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber, S.isSetupOpen));
  return !(pack && pack.guidePreviewDefault === false);
}

export function openGuideGrid() {
  if (sortedChannels().length === 0) return;
  if (guideGrid.classList.contains('hidden')) guidePreviouslyFocused = document.activeElement;
  sfxGuideToggle(true);
  clearTimeout(S.guideHideTimer);
  S.guideHideTimer = null;
  guideOverlay.classList.add('hidden');
  S.guideFilterQuery = '';
  guideSearchEl.value = '';
  const now = viewNow();
  S.guideWindowStart = floorToSlot(now);
  S.guideSelTime = now;
  // selectedIndex() falls back to the first row if the current channel
  // isn't listed (hidden, or a special that isn't enabled any more).
  S.guideSelNumber = S.currentNumber;
  guideAnimToken += 1;
  crtContainer.classList.add('guide-active');
  const animated = guideAnimEnabled();
  crtContainer.classList.toggle('guide-anim-enabled', animated);
  guideGrid.classList.remove('hidden', 'guide-grid-visible');
  if (animated) {
    const ms = (S.config.display && S.config.display.guideOpenCloseAnimMs) || 180;
    guideGrid.style.setProperty('--guide-anim-ms', `${ms}ms`);
    // Deferred by a double requestAnimationFrame rather than added in the
    // same tick — required whenever an animated overlay sits over #player,
    // so the browser actually commits the opacity:0/translated starting
    // state as its own frame before the transition to guide-grid-visible
    // begins, instead of the two states landing in the same paint.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        guideGrid.classList.add('guide-grid-visible');
      });
    });
  }
  applyGuideDockMode();
  // renderGuideGrid() rebuilds the full channel/schedule grid — with a
  // large channel list this is expensive enough to block the main thread
  // for a while, so it's still deferred at least one task out so the video
  // gets to paint a frame first either way. That's *not* enough on its own
  // when the open/close animation is on, though: measured via the
  // project's rAF frame-timing sampling technique (~40+ deltas via CDP
  // during real playback), overlapping this rebuild with the entrance
  // transition produced real dropped frames (spikes up to ~90ms) even
  // though the transition itself only ever touches opacity/transform —
  // animating .guide-grid's own opacity while its children are
  // simultaneously being torn down and rebuilt forces Chromium back onto
  // the main thread to recompute the transitioning subtree on every
  // mutation, defeating the "compositor-only" property choice. So when
  // animated, the rebuild instead waits until the entrance transition has
  // actually finished (an empty panel fades in, then populates) rather
  // than overlapping the two — re-measured flat at ~7ms either way after
  // this change. Off (the default), this is unchanged from before: an
  // immediate setTimeout(0).
  if (animated) {
    const ms = (S.config.display && S.config.display.guideOpenCloseAnimMs) || 180;
    setTimeout(renderGuideGrid, ms + 40);
  } else {
    setTimeout(renderGuideGrid, 0);
  }
  clearInterval(S.guideTickTimer);
  S.guideTickTimer = setInterval(renderGuideGrid, 30000);
  // Focus the guide surface so opening the guide starts in grid-navigation
  // mode. Search is an explicit secondary action: `/` (or normal Tab
  // navigation) moves into its input. Focusing guideSearchEl here made the
  // same G keypress that opened the guide immediately look like search mode.
  requestAnimationFrame(() => guideGrid.focus({ preventScroll: true }));
}

export function closeGuideGrid() {
  closeRunList();
  if (guideGrid.classList.contains('hidden')) return;
  sfxGuideToggle(false);
  clearInterval(S.guideTickTimer);
  hideProgramResults();
  S.guideTickTimer = null;
  guideAnimToken += 1;
  const token = guideAnimToken;
  const finish = () => {
    guideGrid.classList.add('hidden');
    crtContainer.classList.remove('guide-active', 'guide-docked', 'guide-full', 'guide-anim-enabled');
    if (guidePreviouslyFocused && guidePreviouslyFocused.isConnected && guidePreviouslyFocused.getClientRects().length && guidePreviouslyFocused.focus) {
      guidePreviouslyFocused.focus({ preventScroll: true });
    } else if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    guidePreviouslyFocused = null;
  };
  if (crtContainer.classList.contains('guide-anim-enabled') && guideAnimEnabled()) {
    const ms = (S.config.display && S.config.display.guideOpenCloseAnimMs) || 180;
    guideGrid.classList.remove('guide-grid-visible');
    setTimeout(() => { if (token === guideAnimToken) finish(); }, ms + 40);
  } else {
    finish();
  }
}

// Docked (default): the grid hugs the bottom of the screen and the live
// picture keeps playing full-size above it. Full: the grid covers the whole
// screen and the picture shrinks into a preview box — see guide.css.
export function applyGuideDockMode() {
  const dockedClass = S.guideDocked ? 'docked' : 'full';
  const undockedClass = S.guideDocked ? 'full' : 'docked';
  guideGrid.classList.remove(undockedClass);
  guideGrid.classList.add(dockedClass);
  crtContainer.classList.remove(`guide-${undockedClass}`);
  crtContainer.classList.add(`guide-${dockedClass}`);
  crtContainer.classList.toggle('guide-preview-hidden', !guideLivePreviewEnabled());
  fitDockedGuideHeight();
}

export function toggleGuideDockMode() {
  S.guideDocked = !S.guideDocked;
  applyGuideDockMode();
  positionNowLine(S.guideWindowStart + GUIDE_SLOT_MS * guideSlots());
}

export function toggleGuideShowBreaks() {
  S.guideShowBreaks = !S.guideShowBreaks;
  renderGuideGrid();
}

// How many real-channel rows to render per pass once the initial
// visible-rows batch is done — small enough that each pass stays cheap.
// Break copy now lives with the other shared timeline marks
// (timeline-render.js); kept under this name for ON AIR and plugins.
export const GUIDE_BREAK_LABELS = BREAK_LABELS;

const GUIDE_ROW_CHUNK_SIZE = 12;

// Below this many channels, rendering the whole list synchronously is cheap
// enough that lazy-filling would only add a new visible artifact (rows
// popping in over several frames while the panel is still sliding open)
// with no actual perf benefit — the original freeze only showed up around
// 70+ channels. A typical real channel list (a dozen or so) should still
// render in one shot, exactly like before this fix, so the slide-open
// animation's row count is stable the whole time it's playing.
const GUIDE_LAZY_FILL_THRESHOLD = 30;

// .guide-entry is a flex container, and text-overflow only applies to a block
// container's own inline content — so a title too wide for its slot was hard-
// clipped mid-word ("Bosko the Doughbo") instead of ellipsized. Putting the
// text in its own block child gives the ellipsis something to act on, and
// block.textContent still reads back the same string for anything that wants it.
function setEntryLabel(block, text) {
  const label = document.createElement('span');
  label.className = 'guide-entry-label';
  label.textContent = text;
  block.appendChild(label);
  block.title = text;
}

// DISPLAY > Guide > Channel names: the full name (wrapping to two lines) or
// abbreviated call letters, like a period box's channel rail.
function abbreviatedNames() {
  return !!(S.config.display && S.config.display.guideChannelNames === 'short');
}

function railName(ch) {
  if (!abbreviatedNames()) return ch.name || 'UNTITLED';
  return channelCallLetters(ch) || ch.name || 'UNTITLED';
}

function mergeShortsEnabled() {
  return !(S.config.display && S.config.display.guideMergeShorts === false);
}

// Width below which guide.css hides a cell's label (@container max-width:
// 52px), as a duration in the current window — so a run of entries merges
// exactly when their cells would otherwise have been label-less slivers.
const LABEL_MIN_PX = 52;
function microProgramMs() {
  if (!mergeShortsEnabled()) return 0;
  const windowMs = GUIDE_SLOT_MS * guideSlots();
  // The header's first column is the channel rail; before the first render
  // fills it in, a rendered rail cell (or the rail's ceiling) stands in.
  const railEl = guideTimeHeaderEl.firstElementChild || guideRowsEl.querySelector('.guide-row-chan');
  const width = guideTimeHeaderEl.clientWidth || guideRowsEl.clientWidth;
  const railPx = railEl ? railEl.offsetWidth : Math.min(170, width * 0.22);
  const trackPx = width - railPx;
  const ms = trackPx > 0 ? (windowMs * LABEL_MIN_PX) / trackPx : windowMs * 0.03;
  // Rounded so a few pixels of resize don't change the render signature.
  return Math.round(ms / 10000) * 10000;
}

// A channel's cells for a range: programs, with runs of shorts merged.
function guideCells(ch, from, to, minMs = microProgramMs()) {
  return mergeMicroPrograms(getChannelSchedule(ch, from, to), minMs);
}

function runLabel(cell) {
  return `SHORTS & BUMPERS (${cell.items.length})`;
}

// ---------- Shorts & bumpers list ----------
// OK/click on a merged cell opens its entries as a small list; ▲▼ move, OK
// tunes one (from its start with the time machine on), Back closes.
let runList = null; // { ch, cell, idx, el }

function closeRunList() {
  if (!runList) return;
  runList.el.remove();
  runList = null;
}

function highlightRunItem() {
  if (!runList) return;
  Array.from(runList.el.querySelectorAll('.guide-run-item')).forEach((item, i) => {
    const active = i === runList.idx;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) item.scrollIntoView({ block: 'nearest' });
  });
}

function tuneRunItem(i) {
  if (!runList) return;
  const { ch, cell } = runList;
  const entry = cell.items[i];
  closeRunList();
  if (!entry) return;
  S.guideSelNumber = ch.number;
  S.guideSelTime = entry.start + 1;
  jumpToGuideEntry(ch, entry);
  closeGuideGrid();
}

function openRunList(ch, cell, anchorEl) {
  closeRunList();
  const el = document.createElement('div');
  el.className = 'guide-run-list';
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', `${runLabel(cell)} on CH ${formatChannelNumber(ch.number)}`);
  const heading = document.createElement('div');
  heading.className = 'guide-run-heading';
  heading.textContent = `${runLabel(cell)} · ${formatSlotLabel(cell.start)} – ${formatSlotLabel(cell.end)}`;
  el.appendChild(heading);
  const now = viewNow();
  cell.items.forEach((entry, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'guide-run-item' + (entry.end <= now ? ' past' : '');
    item.setAttribute('role', 'option');
    item.tabIndex = -1;
    const time = document.createElement('span');
    time.className = 'guide-run-time';
    time.textContent = formatSlotLabel(entry.start);
    const title = document.createElement('span');
    title.className = 'guide-run-title';
    title.textContent = getDisplayTitle(entry.file);
    item.append(time, title);
    item.addEventListener('click', () => tuneRunItem(i));
    item.addEventListener('mousemove', () => { if (runList && runList.idx !== i) { runList.idx = i; highlightRunItem(); } });
    el.appendChild(item);
  });
  guideGrid.appendChild(el);
  const at = cellIndexAt(cell.items.map((entry) => ({ start: entry.start, end: entry.end })), Math.max(now, cell.start));
  runList = { ch, cell, idx: at === -1 ? 0 : at, el };
  // Beside the cell: above it when there's room, else below; kept inside the grid.
  const grid = guideGrid.getBoundingClientRect();
  const anchor = anchorEl && anchorEl.isConnected ? anchorEl.getBoundingClientRect() : grid;
  const box = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.left - grid.left, grid.width - box.width - 8));
  const above = anchor.top - grid.top - box.height - 4;
  const top = above >= 8 ? above : Math.min(anchor.bottom - grid.top + 4, grid.height - box.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  highlightRunItem();
}

function handleRunListKey(e) {
  switch (e.key) {
    case 'ArrowUp': runList.idx = Math.max(0, runList.idx - 1); highlightRunItem(); break;
    case 'ArrowDown': runList.idx = Math.min(runList.cell.items.length - 1, runList.idx + 1); highlightRunItem(); break;
    case 'Enter': tuneRunItem(runList.idx); break;
    default: closeRunList(); break;
  }
}

function buildChannelRow(ch, windowEnd, selRef, minMs = microProgramMs()) {
  const cells = guideCells(ch, S.guideWindowStart, windowEnd, minMs);
  const row = document.createElement('div');
  row.className = 'guide-row' + (ch.number === S.guideSelNumber ? ' active-row' : '');

  const chanCell = document.createElement('div');
  chanCell.className = 'guide-row-chan';
  // Addressable by channel number so anything that wants to decorate a row
  // later can find it again without re-rendering the grid — the 30s tick
  // deliberately doesn't rebuild rows (see the render-signature fast path
  // below), so a marker that only appeared at build time would lag behind
  // whatever it is reporting.
  chanCell.dataset.channelNumber = String(ch.number);
  const chanText = document.createElement('div');
  chanText.className = 'grc-text';
  chanText.innerHTML = `<span class="grc-num">CH ${formatChannelNumber(ch.number)}</span><span class="grc-name">${escapeHtml(railName(ch))}</span>`;
  if (abbreviatedNames()) chanText.title = ch.name || '';
  chanCell.appendChild(buildChannelBadge(ch, { small: true, editable: false }));
  chanCell.appendChild(chanText);
  // Generic decoration point: core knows nothing about who listens or what
  // they add, only that a row for this channel now exists.
  runCoreHooks('guide-channel-cell', { channel: ch, cell: chanCell });

  const track = document.createElement('div');
  track.className = 'guide-row-track';

  cells.forEach((cell) => {
    const pos = spanPercent(cell.start, cell.end, S.guideWindowStart, windowEnd, { minWidthPct: 2 });
    if (!pos) return;
    const isSel = ch.number === S.guideSelNumber && S.guideSelTime >= cell.start && S.guideSelTime < cell.end;
    if (isSel) selRef.info = { ch, entry: cell.entry || null, cell };

    const block = document.createElement('div');
    block.className = 'guide-entry' + (cell.kind === 'run' ? ' guide-entry-run' : '') + (isSel ? ' sel' : '') +
      (cell.end <= viewNow() ? ' past' : '');
    block.style.left = pos.left + '%';
    block.style.width = pos.width + '%';
    // Read back by refreshPastClasses() below on the fast-path re-render —
    // lets the "past" dimming keep advancing on the 30s tick without
    // needing to rebuild this block (or recompute the schedule) at all.
    block.dataset.end = String(cell.end);

    if (cell.kind === 'run') {
      setEntryLabel(block, runLabel(cell));
      block.title = cell.items.slice(0, 8).map((entry) => `${formatSlotLabel(entry.start)} ${getDisplayTitle(entry.file)}`).join('\n')
        + (cell.items.length > 8 ? `\n+${cell.items.length - 8} more` : '');
      block.addEventListener('click', () => {
        S.guideSelNumber = ch.number;
        S.guideSelTime = cell.start + 1;
        renderGuideGrid();
        const selected = guideRowsEl.querySelector('.guide-row.active-row .guide-entry.sel');
        openRunList(ch, cell, selected || block);
      });
      track.appendChild(block);
      return;
    }

    const { entry } = cell;
    const genreStyle = guideGenreStyleForFile(entry.file, S.config, document.documentElement.dataset.theme);
    if (genreStyle) {
      block.classList.add('guide-entry-genre');
      block.dataset.genre = genreStyle.key;
      block.style.setProperty('--guide-genre-bg', genreStyle.background);
      block.style.setProperty('--guide-genre-fg', genreStyle.foreground);
    }
    // Opt-in only — an entry.block with no theme.accent (the overwhelming
    // default) leaves .guide-entry's own CSS untouched, same look as before
    // block theming existed. See applyBlockTheme (power.js) for the
    // corresponding live-playback treatment.
    if (entry.block && entry.block.theme && entry.block.theme.accent) {
      block.style.borderLeftColor = entry.block.theme.accent;
      block.classList.add('guide-entry-themed');
    }
    setEntryLabel(block, getDisplayTitle(entry.file));
    block.addEventListener('click', () => {
      S.guideSelNumber = ch.number;
      S.guideSelTime = entry.start + 1;
      jumpToGuideEntry(ch, entry);
      closeGuideGrid();
    });
    track.appendChild(block);
  });

  // Break pods (B / TV menu toggle) as a thin band along the bottom of the
  // track, the same marks SCHEDULE > ON AIR draws (timeline-render.js) —
  // breaks overlay content time rather than carving out their own slot
  // (interstitials.js), so a band under the program reads right where the old
  // full-height hatched blocks covered the program they interrupt.
  if (S.guideShowBreaks) {
    track.classList.add('has-breaks');
    breakEntriesInWindow(ch, S.guideWindowStart, windowEnd).forEach((brk) => {
      const pos = spanPercent(brk.start, brk.end, S.guideWindowStart, windowEnd, { minWidthPct: 0.4 });
      if (!pos) return;
      const mark = breakMarkEl(brk, { className: 'guide-break' });
      mark.title = `${formatSlotLabel(brk.start)} ${GUIDE_BREAK_LABELS[brk.breakType] || 'PAID PROGRAMMING'}`;
      mark.style.left = pos.left + '%';
      mark.style.width = pos.width + '%';
      mark.addEventListener('click', (event) => {
        event.stopPropagation();
        S.guideSelNumber = ch.number;
        S.guideSelTime = brk.start + 1;
        jumpToGuideEntry(ch, brk);
        closeGuideGrid();
      });
      track.appendChild(mark);
    });
  }

  row.appendChild(chanCell);
  row.appendChild(track);
  return row;
}

// A special (plugin/virtual) channel: one full-width cell with the plugin's
// own "what's on" line, since it has no schedule to lay out. A normal row
// otherwise — selectable, tuned with Enter/OK (docs/design/11 §2.1).
function buildSpecialRow(row) {
  const { number, info } = row;
  const rowEl = document.createElement('div');
  rowEl.className = 'guide-row guide-row-special' + (number === S.guideSelNumber ? ' active-row' : '');

  const chanCell = document.createElement('div');
  chanCell.className = 'guide-row-chan';
  chanCell.dataset.channelNumber = String(number);
  chanCell.appendChild(buildChannelBadge({ number, name: info.name, icon: null }, { small: true, editable: false }));
  const chanText = document.createElement('div');
  chanText.className = 'grc-text';
  chanText.innerHTML = `<span class="grc-num">CH ${formatChannelNumber(number)}</span><span class="grc-name">${escapeHtml(abbreviatedNames() ? (abbreviateChannelName(info.name) || info.name) : info.name)}</span>`;
  chanCell.appendChild(chanText);
  runCoreHooks('guide-channel-cell', { channel: { number, name: info.name }, cell: chanCell });

  const track = document.createElement('div');
  track.className = 'guide-row-track';
  const block = document.createElement('div');
  block.className = 'guide-entry guide-entry-special' + (number === S.guideSelNumber ? ' sel' : '');
  block.style.left = '0%';
  block.style.width = '100%';
  // Re-read on the fast-path tick (refreshSpecialCells) — a plugin's nowText
  // can change with its own state while the grid itself stays put.
  block.dataset.specialNumber = String(number);
  setEntryLabel(block, info.nowText || info.name);
  block.addEventListener('click', () => {
    S.guideSelNumber = number;
    tuneToChannel(number);
    closeGuideGrid();
  });
  track.appendChild(block);

  rowEl.appendChild(chanCell);
  rowEl.appendChild(track);
  return rowEl;
}

function renderRowRange(rows, windowEnd, startIdx, endIdx, selRef, minMs) {
  for (let rowIdx = startIdx; rowIdx < endIdx; rowIdx++) {
    const row = rows[rowIdx];
    guideRowsEl.appendChild(row.kind === 'special' ? buildSpecialRow(row) : buildChannelRow(row.ch, windowEnd, selRef, minMs));
  }
}

function specialsAtTop() {
  return !!(S.config.display && S.config.display.guideSpecialsAtTop);
}

// Every row the grid shows right now, specials included, in display order.
export function currentGuideRows() {
  const specials = virtualChannelNumbers().map((number) => virtualChannelInfo(number));
  return guideRows(filteredChannels(), specials, { specialsAtTop: specialsAtTop(), query: S.guideFilterQuery });
}

function selectedRow(rows = currentGuideRows()) {
  const idx = selectedIndex(rows, S.guideSelNumber);
  return idx === -1 ? null : rows[idx];
}

// Renders channels [nextIdx, list.length) a chunk at a time via setTimeout(0)
// passes instead of all at once — each channel's getChannelSchedule() call
// is real work (recomputes that channel's schedule for the visible window),
// and with 70+ channels doing it all synchronously on open is what caused
// the guide-open freeze (see [[retro-cable-box-code-ux-audit]] /
// [[retro-cable-box-architecture-constraints]]). renderGen guards against a
// stale chunked pass (from a render that's since been superseded by a newer
// renderGuideGrid() call — filter change, tick refresh, dock toggle)
// continuing to append rows into a grid that's moved on.
function scheduleRemainingRows(rows, windowEnd, nextIdx, selRef, renderGen, minMs) {
  if (renderGen !== S.guideRenderGen) return;
  const endIdx = Math.min(rows.length, nextIdx + GUIDE_ROW_CHUNK_SIZE);
  renderRowRange(rows, windowEnd, nextIdx, endIdx, selRef, minMs);
  if (endIdx < rows.length) {
    setTimeout(() => scheduleRemainingRows(rows, windowEnd, endIdx, selRef, renderGen, minMs), 0);
  } else {
    // Rows added after the initial positionNowLine() call grow the rows
    // container's scroll height — re-run it so the now-line stretches
    // down through every channel, not just the ones rendered synchronously.
    positionNowLine(windowEnd);
  }
}

// Signature of everything that affects what the grid's DOM should contain.
// Real time isn't part of it — for a fixed (config, window, filter, slot
// count, selection) combo the set of schedule blocks is deterministic, so
// time passing on its own never needs a rebuild, only a moved live-line and
// updated past-dimming (see refreshPastClasses/positionNowLine below).
let lastGuideRenderSig = null;

// The row numbers are part of it: a plugin channel appearing or the specials
// switching sides changes which rows exist without touching configGeneration.
function guideRenderSignature(rows, windowEnd, minMs) {
  return [
    S.configGeneration, S.guideWindowStart, windowEnd, S.guideFilterQuery,
    S.guideDocked, S.guideShowBreaks, guideSlots(), rows.map((r) => r.number).join(','), S.guideSelNumber, S.guideSelTime,
    minMs,
  ].join('|');
}

function refreshSpecialCells(rows) {
  guideRowsEl.querySelectorAll('.guide-entry[data-special-number]').forEach((el) => {
    const row = rows.find((r) => r.kind === 'special' && String(r.number) === el.dataset.specialNumber);
    const label = el.querySelector('.guide-entry-label');
    if (!row || !label) return;
    const text = row.info.nowText || row.info.name;
    if (label.textContent !== text) { label.textContent = text; el.title = text; }
  });
}

// Docked height (docs/design/11 §2.2): the strip holds its chrome (info line,
// time header, hints) plus --guide-docked-rows whole rows. .guide-grid is a
// CSS size container, so it can't size itself to content — this measures the
// chrome and hands guide.css a height (--guide-docked-h), which CSS still
// keeps between 46% and 75% of the screen. The chrome doesn't depend on the
// strip's height, so one pass settles.
function fitDockedGuideHeight() {
  if (!S.guideDocked || guideGrid.classList.contains('hidden')) return;
  const rowEls = Array.from(guideRowsEl.children).filter((el) => el.classList.contains('guide-row'));
  const gridStyle = getComputedStyle(guideGrid);
  const rowsStyle = getComputedStyle(guideRowsEl);
  const rows = parseFloat(gridStyle.getPropertyValue('--guide-docked-rows')) || 5;
  const minRow = parseFloat(gridStyle.getPropertyValue('--guide-row-height')) || 52;
  // The tallest rendered row, so a wrapped name or title doesn't cost a row.
  const rowH = rowEls.slice(0, 40).reduce((max, el) => Math.max(max, el.offsetHeight), minRow);
  const gap = parseFloat(rowsStyle.rowGap) || 0;
  const chrome = guideGrid.offsetHeight - guideRowsEl.clientHeight;
  const target = Math.ceil(chrome + rows * (rowH + gap) + (parseFloat(rowsStyle.paddingTop) || 0) + 1);
  const current = parseFloat(guideGrid.style.getPropertyValue('--guide-docked-h')) || 0;
  if (Math.abs(current - target) > 1) guideGrid.style.setProperty('--guide-docked-h', `${target}px`);
}

let guideResizeFrame = 0;
window.addEventListener('resize', () => {
  if (guideGrid.classList.contains('hidden')) return;
  cancelAnimationFrame(guideResizeFrame);
  guideResizeFrame = requestAnimationFrame(() => {
    closeRunList();
    renderGuideGrid(); // fast path unless the shorts threshold moved
    fitDockedGuideHeight();
    const idx = selectedIndex(currentGuideRows(), S.guideSelNumber);
    if (idx >= 0) scrollSelectedRowIntoView(idx);
    positionNowLine(S.guideWindowStart + GUIDE_SLOT_MS * guideSlots());
  });
});

// Scroll the rows container so the selected row is whole on screen, with a
// row of margin docked and centred on the full page (guide-model.js).
function scrollSelectedRowIntoView(selIdx) {
  const rowEls = Array.from(guideRowsEl.children).filter((el) => el.classList.contains('guide-row'));
  if (!rowEls[selIdx]) return;
  const top = rowScrollTop({
    rows: rowEls.map((el) => ({ top: el.offsetTop, height: el.offsetHeight })),
    selIdx,
    viewportH: guideRowsEl.clientHeight,
    scrollTop: guideRowsEl.scrollTop,
    contentH: guideRowsEl.scrollHeight,
    mode: S.guideDocked ? 'docked' : 'full',
  });
  if (top !== guideRowsEl.scrollTop) guideRowsEl.scrollTop = top;
}

// Companion to the block.dataset.end stamped in buildChannelRow — moves the
// "already aired" dimming forward on the fast-path re-render without
// touching anything else in the (unchanged) grid.
function refreshPastClasses() {
  const now = viewNow();
  guideRowsEl.querySelectorAll('.guide-entry[data-end]').forEach((el) => {
    el.classList.toggle('past', Number(el.dataset.end) <= now);
  });
}

export function renderGuideGrid() {
  if (sortedChannels().length === 0) { closeGuideGrid(); return; }
  const rows = currentGuideRows();
  if (rows.length === 0) {
    guideTimeHeaderEl.innerHTML = '';
    guideRowsEl.innerHTML = '';
    guideRowsEl.appendChild(guideGridlinesEl);
    guideRowsEl.appendChild(guideNowLineEl);
    guideNowLineEl.classList.add('hidden');
    giNumberEl.textContent = '--';
    giChannelEl.textContent = 'NO MATCHES';
    giTitleEl.textContent = '—';
    giTimeEl.textContent = '';
    lastGuideRenderSig = null;
    return;
  }
  const selIdx = selectedIndex(rows, S.guideSelNumber);
  S.guideSelNumber = rows[selIdx].number;
  const windowEnd = S.guideWindowStart + GUIDE_SLOT_MS * guideSlots();

  // Measured once per render: the shorts threshold is a pixel width (see
  // microProgramMs), and reading layout per row while appending rows would
  // force a layout for every one.
  const minMs = microProgramMs();
  const sig = guideRenderSignature(rows, windowEnd, minMs);
  if (sig === lastGuideRenderSig && guideRowsEl.children.length > 0) {
    positionNowLine(windowEnd);
    refreshPastClasses();
    refreshSpecialCells(rows);
    return;
  }
  lastGuideRenderSig = sig;
  const renderGen = ++S.guideRenderGen;

  // Same column token the rows use (guide.css), so a theme or a narrow window
  // that resizes the channel rail doesn't slide every time label off its slot.
  guideTimeHeaderEl.style.gridTemplateColumns = `var(--guide-chan-col, 170px) repeat(${guideSlots()}, 1fr)`;
  guideTimeHeaderEl.innerHTML = '<div></div>' + Array.from(
    { length: guideSlots() },
    (_, i) => `<div class="guide-th-slot">${formatSlotLabel(S.guideWindowStart + i * GUIDE_SLOT_MS)}</div>`
  ).join('');

  // Gridline spacing tracks the configurable slot count.
  guideRowsEl.style.setProperty('--guide-slot-w', `${100 / guideSlots()}%`);

  const winDate = new Date(S.guideWindowStart);
  guideDateRangeEl.textContent =
    `${WEEKDAYS[winDate.getDay()].slice(0, 3)} ${MONTHS[winDate.getMonth()]} ${winDate.getDate()}  ` +
    `${formatSlotLabel(S.guideWindowStart)} – ${formatSlotLabel(windowEnd)}`;

  const previousScrollTop = guideRowsEl.scrollTop;
  guideRowsEl.innerHTML = '';
  guideRowsEl.appendChild(guideGridlinesEl);
  guideRowsEl.appendChild(guideNowLineEl);

  const selRef = { info: null };

  // Visible-first, but only for lists actually big enough to need it (see
  // GUIDE_LAZY_FILL_THRESHOLD) — render enough rows to cover the current
  // viewport synchronously, padded out past the selected row (plus its
  // margin row) so it's guaranteed available for the scroll and info-panel
  // update right below. The rest of a large lineup (70+) is filled in
  // afterward via scheduleRemainingRows so a single open doesn't block the
  // main thread computing every channel's schedule at once. Special rows are
  // cheap (no schedule), but count toward the batch like any other row.
  const initialCount = rows.length <= GUIDE_LAZY_FILL_THRESHOLD
    ? rows.length
    : Math.min(rows.length, Math.max(selIdx + 2, S.guideDocked ? 7 : 24));
  renderRowRange(rows, windowEnd, 0, initialCount, selRef, minMs);

  // Rebuilding the rows resets the scroll position; start from where it was
  // so a one-row move only scrolls as far as it has to.
  fitDockedGuideHeight();
  guideRowsEl.scrollTop = previousScrollTop;
  scrollSelectedRowIntoView(selIdx);

  positionNowLine(windowEnd);
  updateGuideInfoPanel(rows[selIdx], selRef.info);

  if (initialCount < rows.length) {
    setTimeout(() => scheduleRemainingRows(rows, windowEnd, initialCount, selRef, renderGen, minMs), 0);
  }
}

// With the time machine on, picking a program in the guide shifts the
// viewing clock so that program starts from its beginning — the whole
// point of the mode. Without it, this is a plain tune-in as before.
export function jumpToGuideEntry(ch, entry) {
  if (S.config.timeMachine && S.config.timeMachine.enabled && entry) {
    S.timeOffsetMs += entry.start - viewNow();
    updateTimeShiftBadge();
  }
  tuneToChannel(ch.number);
}

export function positionNowLine(windowEnd) {
  const trackEl = guideRowsEl.querySelector('.guide-row-track');
  const now = viewNow();
  if (!trackEl || now < S.guideWindowStart || now > windowEnd) {
    guideNowLineEl.classList.add('hidden');
    return;
  }
  const pct = (now - S.guideWindowStart) / (windowEnd - S.guideWindowStart);
  guideNowLineEl.style.left = `${trackEl.offsetLeft + pct * trackEl.offsetWidth}px`;
  // top/bottom: 0 alone sizes against guide-rows' own (visible) box height,
  // not its scrollable content — with 70+ channels that leaves the line
  // stopping partway down the list. Pin an explicit height to the full
  // scrollable content so it runs the whole length of the guide.
  guideNowLineEl.style.height = `${guideRowsEl.scrollHeight}px`;
  guideNowLineEl.classList.remove('hidden');
}

// row: a guideRows() entry (guide-model.js).
export function updateGuideInfoPanel(row, selectedInfo) {
  if (!row) return;
  const ch = row.kind === 'special' ? { number: row.number, name: row.info.name } : row.ch;
  giNumberEl.textContent = formatChannelNumber(ch.number);
  giChannelEl.textContent = ch.name || 'UNTITLED CHANNEL';
  if (row.kind === 'special') {
    giTitleEl.textContent = row.info.nowText || row.info.name;
    giTimeEl.textContent = '';
  } else if (selectedInfo && selectedInfo.cell && selectedInfo.cell.kind === 'run') {
    giTitleEl.textContent = runLabel(selectedInfo.cell);
    giTimeEl.textContent = `${formatSlotLabel(selectedInfo.cell.start)} – ${formatSlotLabel(selectedInfo.cell.end)}`;
  } else if (selectedInfo && selectedInfo.entry) {
    giTitleEl.textContent = getDisplayTitle(selectedInfo.entry.file);
    giTimeEl.textContent = `${formatSlotLabel(selectedInfo.entry.start)} – ${formatSlotLabel(selectedInfo.entry.end)}`;
  } else {
    giTitleEl.textContent = '—';
    giTimeEl.textContent = '';
  }
  // Restart the crossfade on every update: remove the class, force a
  // reflow read, then re-add it — plain re-adding an already-present class
  // is a no-op and wouldn't replay the animation.
  giTitleEl.classList.remove('gi-update');
  giTimeEl.classList.remove('gi-update');
  void giTitleEl.offsetWidth;
  giTitleEl.classList.add('gi-update');
  giTimeEl.classList.add('gi-update');
}

export function moveGuideSelectionRow(direction) {
  const rows = currentGuideRows();
  if (rows.length === 0) return;
  S.guideSelNumber = moveSelection(rows, S.guideSelNumber, direction);
  renderGuideGrid();
}

// A screenful at a time (CH± on a remote). Stops at the ends rather than
// wrapping, the way a remote's CH key pages a list.
export function pageGuideSelection(direction, step) {
  const rows = currentGuideRows();
  if (rows.length === 0) return;
  S.guideSelNumber = moveSelection(rows, S.guideSelNumber, direction * Math.max(1, step), { wrap: false });
  renderGuideGrid();
}

// Move selection to the previous/next show on the current row. Won't move
// earlier than the show airing right now — a live guide can't rewind.
export function moveGuideSelectionTime(direction) {
  const row = selectedRow();
  // A special row is one full-width cell: there's no other program to move to.
  if (!row || row.kind !== 'channel') return;
  const { ch } = row;
  const now = viewNow();
  // The time machine turns the guide into a two-way browser; without it
  // the guide stays live-only and can't scroll into the past.
  const canRewind = !!(S.config.timeMachine && S.config.timeMachine.enabled);
  const rangeStart = floorToSlot(now) - (canRewind ? GUIDE_SLOT_MS * 8 : 0);
  const rangeEnd = S.guideWindowStart + GUIDE_SLOT_MS * (guideSlots() + 6);
  // Cells, not raw entries: a merged run of shorts is one step.
  const schedule = guideCells(ch, rangeStart, rangeEnd);
  if (schedule.length === 0) return;

  let idx = schedule.findIndex((en) => S.guideSelTime >= en.start && S.guideSelTime < en.end);
  if (idx === -1) idx = 0;
  const nowIdx = canRewind ? 0 : Math.max(schedule.findIndex((en) => now >= en.start && now < en.end), 0);
  const newIdx = idx + direction;
  if (newIdx < nowIdx || newIdx >= schedule.length) return;

  const target = schedule[newIdx];
  S.guideSelTime = target.start + 1;

  const windowEnd = S.guideWindowStart + GUIDE_SLOT_MS * guideSlots();
  if (target.start < S.guideWindowStart) {
    S.guideWindowStart = canRewind
      ? floorToSlot(target.start)
      : Math.max(floorToSlot(now), floorToSlot(target.start));
  } else if (target.end > windowEnd) {
    S.guideWindowStart = floorToSlot(target.start);
  }
  renderGuideGrid();
}

// The I key while the guide is open — details for whichever program is
// currently highlighted (same schedule lookup the Enter case below already
// does to tune into it), rather than whatever's live-playing on the
// underlying channel. A silent no-op if nothing's selected (e.g. an empty
// channel), matching showDetailsForCurrentChannel's own no-op behavior.
function showDetailsForGuideSelection() {
  if (!S.config.details || S.config.details.enabled === false) return;
  const row = selectedRow();
  if (!row || row.kind !== 'channel') return;
  const { ch } = row;
  const cells = guideCells(ch, S.guideWindowStart, S.guideWindowStart + GUIDE_SLOT_MS * (guideSlots() + 6));
  const cell = cells[cellIndexAt(cells, S.guideSelTime)];
  const entry = cell && cell.kind === 'program' ? cell.entry : null;
  if (!entry) return;
  showDetailsOverlay(entry.file, {
    channelNumber: ch.number,
    channelName: ch.name,
    airTime: `${formatSlotLabel(entry.start)} – ${formatSlotLabel(entry.end)}`,
  });
}

export function handleGuideGridKey(e) {
  // While the filter box has focus, only intercept Escape — everything
  // else (letters, digits, arrows for cursor movement) is normal typing.
  if (document.activeElement === guideSearchEl) {
    if (e.key === 'Tab') {
      e.preventDefault();
      guideSearchEl.focus();
    } else if (e.key === 'Escape') {
      if (guideSearchEl.value) {
        guideSearchEl.value = '';
        S.guideFilterQuery = '';
        guideSearchEl.blur();
        renderGuideGrid();
      } else {
        guideSearchEl.blur();
        closeGuideGrid();
      }
      e.preventDefault();
    } else if (e.key === 'Enter') {
      guideSearchEl.blur();
      e.preventDefault();
    }
    return;
  }

  // The shorts & bumpers list is modal while open.
  if (runList) {
    handleRunListKey(e);
    e.preventDefault();
    return;
  }

  if (e.key === '/') {
    guideSearchEl.focus();
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case 'ArrowUp': moveGuideSelectionRow(-1); break;
    case 'ArrowDown': moveGuideSelectionRow(1); break;
    case 'ArrowLeft': moveGuideSelectionTime(-1); break;
    case 'ArrowRight': moveGuideSelectionTime(1); break;
    case 'Enter': {
      const row = selectedRow();
      const selCh = row && row.kind === 'channel' ? row.ch : null;
      if (row && row.kind === 'special') {
        tuneToChannel(row.number);
      } else if (selCh) {
        const cells = guideCells(selCh, S.guideWindowStart, S.guideWindowStart + GUIDE_SLOT_MS * (guideSlots() + 6));
        const selCell = cells[cellIndexAt(cells, S.guideSelTime)];
        if (selCell && selCell.kind === 'run') {
          openRunList(selCh, selCell, guideRowsEl.querySelector('.guide-row.active-row .guide-entry.sel'));
          break;
        }
        jumpToGuideEntry(selCh, selCell ? selCell.entry : undefined);
      }
      closeGuideGrid();
      break;
    }
    case 'Escape':
    case 'g':
    case 'G':
      closeGuideGrid();
      break;
    case 'd':
    case 'D':
      toggleGuideDockMode();
      break;
    case 'b':
    case 'B':
      toggleGuideShowBreaks();
      break;
    case 'i':
    case 'I':
      showDetailsForGuideSelection();
      break;
    case 's':
    case 'S':
      closeGuideGrid();
      showSetupScreen();
      break;
    case 'c':
    case 'C':
      // Same shortcut as on the TV screen — CRT effects toggle should
      // work regardless of whether the guide is open, so you don't have
      // to close the guide just to flip the effect on or off.
      toggleCrt();
      break;
    default:
      return;
  }
  e.preventDefault();
}
