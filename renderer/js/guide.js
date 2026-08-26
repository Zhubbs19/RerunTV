import { showSetupScreen } from './app.js';
import { toggleCrt } from './power.js';
import { playConfiguredSound, sfxGuideToggle } from './audio.js';
import { buildChannelBadge, channelColor, filteredChannels, getChannel, guideSlots, sortedChannels } from './channels.js';
import {
  crtContainer, giChannelEl, giNumberEl, giTimeEl, giTitleEl, guideBarFillEl, guideDateRangeEl, guideGrid,
  guideGridlinesEl, guideLogoEl, guideMuteEl, guideNameEl, guideNowEl, guideNowLineEl, guideNumberEl, guideOverlay,
  guideRowsEl, guideSearchEl, guideTimeHeaderEl, player,
} from './dom.js';
import { showDetailsOverlay } from './details.js';
import { tuneToChannel } from './playback.js';
import { computeLivePosition, getChannelSchedule } from './schedule.js';
import { GUIDE_SLOT_MS, MONTHS, S, WEEKDAYS, saveConfigDebounced, viewNow } from './state.js';
import { searchUpcomingPrograms } from './program-search.js';
import { guideGenreStyleForFile } from './guide-genres.js';
import { updateTimeShiftBadge } from './timemachine.js';
import {
  autoHideAfter, escapeHtml, floorToSlot, formatSlotLabel, getDisplayTitle,
} from './util.js';
import { virtualChannelInfo, virtualChannelNumbers } from './virtual.js';

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
  guideNumberEl.textContent = String(number).padStart(2, '0');
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
  S.guideHideTimer = autoHideAfter(S.guideHideTimer, 4000, () => guideOverlay.classList.add('hidden'));
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
  const list = filteredChannels();
  S.guideSelRowIdx = Math.max(0, list.findIndex((channel) => channel.number === result.channel.number));
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
  saveConfigDebounced();
}

function renderProgramResults(query) {
  if (!programResultsEl || query.trim().length < 2) { hideProgramResults(); return; }
  const results = searchUpcomingPrograms(sortedChannels(), query, viewNow());
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
    copy.innerHTML = `<strong>${escapeHtml(result.title)}</strong><span>CH ${result.channel.number} · ${escapeHtml(result.channel.name || 'UNNAMED')} · ${new Date(result.entry.start).toLocaleString()}</span>`;
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
  saveConfigDebounced();
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
  if (changed) saveConfigDebounced();
  if (activeReminder) return;
  const due = (S.config.reminders || []).find((reminder) => !notifiedReminders.has(reminder.id) && now >= reminder.start - 60000 && now <= reminder.end);
  if (!due) return;
  activeReminder = due;
  notifiedReminders.add(due.id);
  reminderCopyEl.textContent = `${due.title} starts ${formatSlotLabel(due.start)} on CH ${due.channelNumber}${due.channelName ? ` · ${due.channelName}` : ''}.`;
  reminderToastEl.classList.remove('hidden');
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

export function openGuideGrid() {
  if (sortedChannels().length === 0) return;
  if (guideGrid.classList.contains('hidden')) guidePreviouslyFocused = document.activeElement;
  sfxGuideToggle(true);
  clearTimeout(S.guideHideTimer);
  S.guideHideTimer = null;
  guideOverlay.classList.add('hidden');
  S.guideFilterQuery = '';
  guideSearchEl.value = '';
  const list = filteredChannels();
  const now = viewNow();
  S.guideWindowStart = floorToSlot(now);
  S.guideSelTime = now;
  S.guideSelRowIdx = Math.max(0, list.findIndex((c) => c.number === S.currentNumber));
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
function applyGuideDockMode() {
  const dockedClass = S.guideDocked ? 'docked' : 'full';
  const undockedClass = S.guideDocked ? 'full' : 'docked';
  guideGrid.classList.remove(undockedClass);
  guideGrid.classList.add(dockedClass);
  crtContainer.classList.remove(`guide-${undockedClass}`);
  crtContainer.classList.add(`guide-${dockedClass}`);
}

export function toggleGuideDockMode() {
  S.guideDocked = !S.guideDocked;
  applyGuideDockMode();
  positionNowLine(S.guideWindowStart + GUIDE_SLOT_MS * guideSlots());
}

// How many real-channel rows to render per pass once the initial
// visible-rows batch is done — small enough that each pass stays cheap.
const GUIDE_ROW_CHUNK_SIZE = 12;

// Below this many channels, rendering the whole list synchronously is cheap
// enough that lazy-filling would only add a new visible artifact (rows
// popping in over several frames while the panel is still sliding open)
// with no actual perf benefit — the original freeze only showed up around
// 70+ channels. A typical real channel list (a dozen or so) should still
// render in one shot, exactly like before this fix, so the slide-open
// animation's row count is stable the whole time it's playing.
const GUIDE_LAZY_FILL_THRESHOLD = 30;

function buildChannelRow(ch, rowIdx, windowEnd, selRef) {
  const schedule = getChannelSchedule(ch, S.guideWindowStart, windowEnd);
  const row = document.createElement('div');
  row.className = 'guide-row' + (rowIdx === S.guideSelRowIdx ? ' active-row' : '');

  const chanCell = document.createElement('div');
  chanCell.className = 'guide-row-chan';
  const chanText = document.createElement('div');
  chanText.className = 'grc-text';
  chanText.innerHTML = `<span class="grc-num">CH ${String(ch.number).padStart(2, '0')}</span><span class="grc-name">${escapeHtml(ch.name || 'UNTITLED')}</span>`;
  chanCell.appendChild(buildChannelBadge(ch, { small: true, editable: false }));
  chanCell.appendChild(chanText);

  const track = document.createElement('div');
  track.className = 'guide-row-track';

  schedule.forEach((entry) => {
    const clampedStart = Math.max(entry.start, S.guideWindowStart);
    const clampedEnd = Math.min(entry.end, windowEnd);
    if (clampedEnd <= clampedStart) return;
    const leftPct = ((clampedStart - S.guideWindowStart) / (windowEnd - S.guideWindowStart)) * 100;
    const widthPct = ((clampedEnd - clampedStart) / (windowEnd - S.guideWindowStart)) * 100;
    const isSel = rowIdx === S.guideSelRowIdx && S.guideSelTime >= entry.start && S.guideSelTime < entry.end;
    if (isSel) selRef.info = { ch, entry };

    const block = document.createElement('div');
    block.className = 'guide-entry' + (isSel ? ' sel' : '') +
      (entry.end <= viewNow() ? ' past' : '');
    block.style.left = leftPct + '%';
    block.style.width = Math.max(widthPct, 2) + '%';
    // Read back by refreshPastClasses() below on the fast-path re-render —
    // lets the "past" dimming keep advancing on the 30s tick without
    // needing to rebuild this block (or recompute the schedule) at all.
    block.dataset.end = String(entry.end);
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
    const displayTitle = getDisplayTitle(entry.file);
    block.textContent = displayTitle;
    block.title = displayTitle;
    block.addEventListener('click', () => {
      S.guideSelRowIdx = rowIdx;
      S.guideSelTime = entry.start + 1;
      jumpToGuideEntry(ch, entry);
      closeGuideGrid();
    });
    track.appendChild(block);
  });

  row.appendChild(chanCell);
  row.appendChild(track);
  return row;
}

function renderChannelRowRange(list, windowEnd, startIdx, endIdx, selRef) {
  for (let rowIdx = startIdx; rowIdx < endIdx; rowIdx++) {
    guideRowsEl.appendChild(buildChannelRow(list[rowIdx], rowIdx, windowEnd, selRef));
  }
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
function scheduleRemainingRows(list, windowEnd, nextIdx, selRef, renderGen) {
  if (renderGen !== S.guideRenderGen) return;
  const endIdx = Math.min(list.length, nextIdx + GUIDE_ROW_CHUNK_SIZE);
  renderChannelRowRange(list, windowEnd, nextIdx, endIdx, selRef);
  if (endIdx < list.length) {
    setTimeout(() => scheduleRemainingRows(list, windowEnd, endIdx, selRef, renderGen), 0);
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

function guideRenderSignature(list, windowEnd) {
  return [
    S.configGeneration, S.guideWindowStart, windowEnd, S.guideFilterQuery,
    S.guideDocked, guideSlots(), list.length, S.guideSelRowIdx, S.guideSelTime,
  ].join('|');
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
  const list = filteredChannels();
  if (sortedChannels().length === 0) { closeGuideGrid(); return; }
  if (list.length === 0) {
    guideTimeHeaderEl.innerHTML = '';
    guideRowsEl.innerHTML = '';
    guideRowsEl.appendChild(guideGridlinesEl);
    guideRowsEl.appendChild(guideNowLineEl);
    guideNowLineEl.classList.add('hidden');
    giNumberEl.textContent = '--';
    giChannelEl.textContent = 'NO MATCHES';
    giTitleEl.textContent = '—';
    giTimeEl.textContent = '';
    return;
  }
  S.guideSelRowIdx = Math.min(Math.max(S.guideSelRowIdx, 0), list.length - 1);
  const windowEnd = S.guideWindowStart + GUIDE_SLOT_MS * guideSlots();

  const sig = guideRenderSignature(list, windowEnd);
  if (sig === lastGuideRenderSig && guideRowsEl.children.length > 0) {
    positionNowLine(windowEnd);
    refreshPastClasses();
    return;
  }
  lastGuideRenderSig = sig;
  const renderGen = ++S.guideRenderGen;

  guideTimeHeaderEl.style.gridTemplateColumns = `170px repeat(${guideSlots()}, 1fr)`;
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

  guideRowsEl.innerHTML = '';
  guideRowsEl.appendChild(guideGridlinesEl);
  guideRowsEl.appendChild(guideNowLineEl);

  // Virtual channels get single full-width rows at the top. They sit
  // outside the arrow-key selection model (clickable only) — the guide's
  // selection math stays anchored to real channels. Cheap (no schedule
  // computation), so always rendered synchronously.
  if (!S.guideFilterQuery.trim()) {
    virtualChannelNumbers().forEach((num) => {
      const info = virtualChannelInfo(num);
      const row = document.createElement('div');
      row.className = 'guide-row';

      const chanCell = document.createElement('div');
      chanCell.className = 'guide-row-chan';
      chanCell.appendChild(buildChannelBadge({ number: num, name: info.name, icon: null }, { small: true, editable: false }));
      const chanText = document.createElement('div');
      chanText.className = 'grc-text';
      chanText.innerHTML = `<span class="grc-num">CH ${String(num).padStart(2, '0')}</span><span class="grc-name">${escapeHtml(info.name)}</span>`;
      chanCell.appendChild(chanText);

      const track = document.createElement('div');
      track.className = 'guide-row-track';
      const block = document.createElement('div');
      block.className = 'guide-entry';
      block.style.left = '0%';
      block.style.width = '100%';
      block.textContent = info.nowText;
      block.title = info.nowText;
      block.addEventListener('click', () => {
        tuneToChannel(num);
        closeGuideGrid();
      });
      track.appendChild(block);

      row.appendChild(chanCell);
      row.appendChild(track);
      guideRowsEl.appendChild(row);
    });
  }

  const selRef = { info: null };

  // Visible-first, but only for lists actually big enough to need it (see
  // GUIDE_LAZY_FILL_THRESHOLD) — render enough real-channel rows to cover
  // the current viewport synchronously (docked mode shows ~4 rows, full
  // page more), padded out to at least cover the selected row so it's
  // guaranteed available for the scroll-into-view/info-panel update right
  // below. The rest of a large channel list (70+) is filled in afterward
  // via scheduleRemainingRows so a single open doesn't block the main
  // thread computing every channel's schedule at once.
  const initialCount = list.length <= GUIDE_LAZY_FILL_THRESHOLD
    ? list.length
    : Math.min(list.length, Math.max(S.guideSelRowIdx + 1, S.guideDocked ? 6 : 24));
  renderChannelRowRange(list, windowEnd, 0, initialCount, selRef);

  // +2 for the gridlines and now-line overlays, plus any prepended
  // virtual-channel rows.
  const virtualRowCount = S.guideFilterQuery.trim() ? 0 : virtualChannelNumbers().length;
  const activeRowEl = guideRowsEl.children[S.guideSelRowIdx + 2 + virtualRowCount];
  if (activeRowEl) activeRowEl.scrollIntoView({ block: 'nearest' });

  positionNowLine(windowEnd);
  updateGuideInfoPanel(list[S.guideSelRowIdx], selRef.info);

  if (initialCount < list.length) {
    setTimeout(() => scheduleRemainingRows(list, windowEnd, initialCount, selRef, renderGen), 0);
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

export function updateGuideInfoPanel(ch, selectedInfo) {
  if (!ch) return;
  giNumberEl.textContent = String(ch.number).padStart(2, '0');
  giChannelEl.textContent = ch.name || 'UNTITLED CHANNEL';
  if (selectedInfo) {
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
  const list = filteredChannels();
  if (list.length === 0) return;
  S.guideSelRowIdx = (S.guideSelRowIdx + direction + list.length) % list.length;
  renderGuideGrid();
}

// Move selection to the previous/next show on the current row. Won't move
// earlier than the show airing right now — a live guide can't rewind.
export function moveGuideSelectionTime(direction) {
  const list = filteredChannels();
  const ch = list[S.guideSelRowIdx];
  if (!ch) return;
  const now = viewNow();
  // The time machine turns the guide into a two-way browser; without it
  // the guide stays live-only and can't scroll into the past.
  const canRewind = !!(S.config.timeMachine && S.config.timeMachine.enabled);
  const rangeStart = floorToSlot(now) - (canRewind ? GUIDE_SLOT_MS * 8 : 0);
  const rangeEnd = S.guideWindowStart + GUIDE_SLOT_MS * (guideSlots() + 6);
  const schedule = getChannelSchedule(ch, rangeStart, rangeEnd);
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
  const list = filteredChannels();
  const ch = list[S.guideSelRowIdx];
  if (!ch) return;
  const sched = getChannelSchedule(ch, S.guideWindowStart, S.guideWindowStart + GUIDE_SLOT_MS * (guideSlots() + 6));
  const entry = sched.find((en) => S.guideSelTime >= en.start && S.guideSelTime < en.end);
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

  if (e.key === '/') {
    guideSearchEl.focus();
    e.preventDefault();
    return;
  }

  const list = filteredChannels();
  switch (e.key) {
    case 'ArrowUp': moveGuideSelectionRow(-1); break;
    case 'ArrowDown': moveGuideSelectionRow(1); break;
    case 'ArrowLeft': moveGuideSelectionTime(-1); break;
    case 'ArrowRight': moveGuideSelectionTime(1); break;
    case 'Enter': {
      const selCh = list[S.guideSelRowIdx];
      if (selCh) {
        const sched = getChannelSchedule(selCh, S.guideWindowStart, S.guideWindowStart + GUIDE_SLOT_MS * (guideSlots() + 6));
        const selEntry = sched.find((en) => S.guideSelTime >= en.start && S.guideSelTime < en.end);
        jumpToGuideEntry(selCh, selEntry);
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
