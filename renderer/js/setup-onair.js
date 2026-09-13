// SCHEDULE > ON AIR — the week a channel will actually broadcast, drawn as
// one strip per day: every program, every break pod, and the stretches the
// channel is signed off, coloured by whichever source (a block or the default
// lineup) produced them. Clicking a program explains why it airs.
//
// Read-only on purpose. Blocks, calendar overrides, presets, flows and
// cadence each have their own editor, and until now nothing showed what they
// add up to except AIR CHECK, one instant at a time. This view is that same
// question asked for a whole week, so it adds no resolution math of its own:
// every entry comes from getChannelSchedule / breakEntriesInWindow /
// isWithinBroadcastHours / resolveActiveCommercials — the functions live
// playback and the guide already use. "Now" is viewNow(), so it follows the
// time machine like everything else.
import { showTvScreen } from './app.js';
import { breakEntriesInWindow, effectiveContentTags } from './interstitials.js';
import { GUIDE_BREAK_LABELS } from './guide.js';
import { tuneToChannel } from './playback-core.js';
import { getChannelSchedule, isWithinBroadcastHours, resolveActiveCommercials, resolveActiveSource } from './schedule.js';
import { reasonForCommercials } from './setup-aircheck.js';
import { MONTHS, S, WEEKDAYS, viewNow } from './state.js';
import { formatClock, formatDuration, formatHourLabel, getDisplayTitle } from './util.js';

// The guide's break labels are period copy (a commercial pod reads PAID
// PROGRAMMING, the way a real listings grid showed it); a setup screen
// explaining a schedule should just say what it is.
const BREAK_LABEL_OVERRIDES = { commercial: 'AD BREAK', adBreakIn: 'AD BREAK', adBreakOut: 'AD BREAK' };
function breakLabel(type) {
  return BREAK_LABEL_OVERRIDES[type] || GUIDE_BREAK_LABELS[type] || String(type).toUpperCase();
}

const ZOOM_LEVELS = [
  { label: 'DAY', pxPerHour: 60 },
  { label: 'PRIME', pxPerHour: 140 },
  { label: 'DETAIL', pxPerHour: 320 },
];

// Per-day results, keyed on the config generation so any edit anywhere
// (CLAUDE.md's config-mutation rule) invalidates them without this module
// having to know what changed. Bounded: a week is 7 entries per channel, and
// paging back and forth through a few weeks shouldn't grow without limit.
const dayCache = new Map();
const DAY_CACHE_MAX = 64;

// Local midnight of `ms`'s day, via Date setters rather than ms arithmetic so
// a DST day is 23 or 25 hours long, exactly as the schedule resolvers see it.
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function addDays(dayMs, n) {
  const d = new Date(dayMs);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
function startOfWeek(ms) {
  const day = startOfDay(ms);
  return addDays(day, -new Date(day).getDay());
}

function offAirRanges(ch, dayStart, dayEnd) {
  const bh = ch.broadcastHours;
  if (!bh || !bh.enabled) return [];
  const ranges = [];
  for (let h = 0; h < 24; h++) {
    const hourStart = new Date(dayStart); hourStart.setHours(h, 0, 0, 0);
    const start = hourStart.getTime();
    if (start >= dayEnd) break;
    const end = Math.min(new Date(dayStart).setHours(h + 1, 0, 0, 0), dayEnd);
    if (isWithinBroadcastHours(ch, start + 60000)) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.end === start) last.end = end; else ranges.push({ start, end });
  }
  return ranges;
}

function computeDay(ch, dayStart) {
  const key = `${ch.number}|${dayStart}|${S.configGeneration}`;
  if (dayCache.has(key)) return dayCache.get(key);
  const dayEnd = addDays(dayStart, 1);
  const began = performance.now();
  const offAir = offAirRanges(ch, dayStart, dayEnd);
  const programs = getChannelSchedule(ch, dayStart, dayEnd);
  let breaks = [];
  try {
    breaks = breakEntriesInWindow(ch, dayStart, dayEnd);
  } catch (e) {
    // A break resolver throwing must not take the whole view down with it —
    // programs are still worth showing without their break markers.
    console.warn('[on-air] break scan failed', e);
  }
  const result = { dayStart, dayEnd, programs, breaks, offAir, ms: performance.now() - began };
  if (dayCache.size >= DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value);
  dayCache.set(key, result);
  return result;
}

function sourceKey(ch, block) {
  return block ? block.id : `default-${ch.number}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatDayHeading(dayMs) {
  const d = new Date(dayMs);
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// opts.colorFor(key)  — the same per-source colour TIMELINE/CALENDAR use
// opts.blockLabel(b)  — blockPickerLabel, so a block reads the same everywhere
// opts.onEditBlock(b) — jump to that block in the BLOCKS view
export function buildOnAirPanel(ch, panelEl, opts = {}) {
  panelEl.innerHTML = '';
  const colorFor = opts.colorFor || (() => '#5163b8');
  const blockLabel = opts.blockLabel || ((b) => b.name || b.id);

  let weekStart = startOfWeek(viewNow());
  let zoom = ZOOM_LEVELS[1];
  let renderToken = 0;
  let selected = null;

  const toolbar = el('div', 'onair-toolbar');
  const prevBtn = el('button', 'btn', '◄ PREV WEEK');
  const todayBtn = el('button', 'btn', 'THIS WEEK');
  const nextBtn = el('button', 'btn', 'NEXT WEEK ►');
  const weekLabel = el('span', 'onair-week-label');
  const zoomGroup = el('span', 'onair-zoom');
  zoomGroup.setAttribute('role', 'group');
  zoomGroup.setAttribute('aria-label', 'Zoom');
  const zoomBtns = ZOOM_LEVELS.map((level) => {
    const b = el('button', 'btn', level.label);
    b.addEventListener('click', () => { zoom = level; render({ keepScroll: true }); });
    zoomGroup.appendChild(b);
    return b;
  });
  [prevBtn, todayBtn, nextBtn].forEach((b) => { b.type = 'button'; });
  toolbar.append(prevBtn, todayBtn, nextBtn, weekLabel, zoomGroup);

  const intro = el('div', 'onair-intro',
    'What this channel actually broadcasts — every show, ad break and sign-off, after blocks, calendar days, presets and flows are all applied. Click a program to see why it airs.');

  const scroller = el('div', 'onair-scroller');
  scroller.tabIndex = -1;
  const grid = el('div', 'onair-grid');
  scroller.appendChild(grid);

  const legend = el('div', 'onair-legend');
  const detail = el('div', 'onair-detail');
  detail.setAttribute('aria-live', 'polite');
  const status = el('div', 'onair-status');

  panelEl.append(intro, toolbar, scroller, legend, status, detail);

  prevBtn.addEventListener('click', () => { weekStart = addDays(weekStart, -7); render(); });
  nextBtn.addEventListener('click', () => { weekStart = addDays(weekStart, 7); render(); });
  todayBtn.addEventListener('click', () => { weekStart = startOfWeek(viewNow()); render({ scrollToNow: true }); });

  function xFor(dayStart, ms) {
    return ((ms - dayStart) / 3600000) * zoom.pxPerHour;
  }

  function renderHourHeader() {
    const header = el('div', 'onair-row onair-hours');
    header.appendChild(el('div', 'onair-day-label onair-corner'));
    const track = el('div', 'onair-track');
    track.style.width = `${24 * zoom.pxPerHour}px`;
    const step = zoom.pxPerHour >= 140 ? 1 : 3;
    for (let h = 0; h < 24; h += step) {
      const tick = el('span', 'onair-hour-tick', formatHourLabel(h));
      tick.style.left = `${h * zoom.pxPerHour}px`;
      track.appendChild(tick);
    }
    header.appendChild(track);
    return header;
  }

  function showDetail(entry, day) {
    selected = { start: entry.start, dayStart: day.dayStart };
    grid.querySelectorAll('.onair-program.selected').forEach((n) => n.classList.remove('selected'));
    grid.querySelector(`.onair-program[data-start="${entry.start}"]`)?.classList.add('selected');

    const mid = entry.start + Math.max(1, (entry.end - entry.start) / 2);
    const source = resolveActiveSource(ch, mid);
    const commercials = resolveActiveCommercials(ch, mid, effectiveContentTags(ch, entry.file));
    const breaksInside = day.breaks.filter((b) => b.end > entry.start && b.start < entry.end);

    detail.innerHTML = '';
    detail.appendChild(el('div', 'onair-detail-title', getDisplayTitle(entry.file)));
    const startD = new Date(entry.start);
    detail.appendChild(el('div', 'onair-detail-when',
      `${formatDayHeading(entry.start)} · ${formatClock(startD)}–${formatClock(new Date(entry.end))} · ${formatDuration((entry.end - entry.start) / 1000)}`));

    const facts = el('div', 'onair-facts');
    const fact = (label, value, why) => {
      const row = el('div', 'onair-fact');
      row.append(el('strong', null, label), el('span', null, value), el('small', null, why));
      facts.appendChild(row);
    };
    fact('SOURCE', source.block ? blockLabel(source.block) : 'DEFAULT LINEUP',
      source.block ? 'The highest-priority block matching this time.' : 'No block with content matches this time, so the channel\'s own folders play.');
    const timing = commercials.commercials && commercials.commercials.timing;
    fact('AD POLICY', timing ? String(timing).toUpperCase() : 'NO ADS', reasonForCommercials(commercials));
    fact('BREAKS', breaksInside.length ? `${breaksInside.length} during this program` : 'NONE',
      breaksInside.length
        ? breaksInside.map((b) => `${formatClock(new Date(b.start))} ${breakLabel(b.breakType)}`).join(' · ')
        : (timing && !day.breaks.length
          ? 'An ad policy applies, but no break airs anywhere on this day — usually nothing in the Bumper & Ad Pool is eligible for this channel.'
          : 'No break window resolves inside this program.'));
    fact('FILE', (entry.file && entry.file.path) || '—', '');
    detail.appendChild(facts);

    const actions = el('div', 'onair-detail-actions');
    const previewBtn = el('button', 'btn btn-primary', 'WATCH FROM HERE ▶');
    previewBtn.type = 'button';
    previewBtn.addEventListener('click', async () => {
      // Same "preview at an instant" route AIR CHECK's FORCE ON TV takes:
      // shift the viewing clock to the program's start, then tune. Date.now()
      // is the deliberate real-time reference the offset is measured from.
      S.timeOffsetMs = Math.max(entry.start, day.dayStart) - Date.now();
      S.setupPreviewActive = true;
      showTvScreen();
      await tuneToChannel(ch.number);
    });
    actions.appendChild(previewBtn);
    if (source.block && opts.onEditBlock) {
      const editBtn = el('button', 'btn', 'EDIT THIS BLOCK');
      editBtn.type = 'button';
      editBtn.addEventListener('click', () => opts.onEditBlock(source.block));
      actions.appendChild(editBtn);
    }
    detail.appendChild(actions);
  }

  function renderDayRow(day, rowEl) {
    const track = rowEl.querySelector('.onair-track');
    track.innerHTML = '';
    const now = viewNow();

    day.offAir.forEach((r) => {
      const block = el('div', 'onair-offair', 'SIGNED OFF');
      block.style.left = `${xFor(day.dayStart, r.start)}px`;
      block.style.width = `${xFor(day.dayStart, r.end) - xFor(day.dayStart, r.start)}px`;
      track.appendChild(block);
    });

    day.programs.forEach((entry) => {
      if (day.offAir.some((r) => entry.start >= r.start && entry.end <= r.end)) return;
      const left = xFor(day.dayStart, Math.max(entry.start, day.dayStart));
      const width = Math.max(2, xFor(day.dayStart, Math.min(entry.end, day.dayEnd)) - left);
      const btn = el('button', 'onair-program');
      btn.type = 'button';
      btn.dataset.start = String(entry.start);
      btn.style.left = `${left}px`;
      btn.style.width = `${width}px`;
      const key = sourceKey(ch, entry.block);
      btn.style.setProperty('--onair-source', colorFor(key));
      if (entry.end <= now) btn.classList.add('past');
      if (selected && selected.start === entry.start) btn.classList.add('selected');
      const title = getDisplayTitle(entry.file);
      btn.title = `${formatClock(new Date(entry.start))} ${title}`;
      btn.setAttribute('aria-label', `${formatDayHeading(entry.start)} ${formatClock(new Date(entry.start))}, ${title}`);
      btn.appendChild(el('span', 'onair-program-label', title));
      btn.addEventListener('click', () => showDetail(entry, day));
      track.appendChild(btn);
    });

    day.breaks.forEach((b) => {
      const mark = el('div', `onair-break onair-break-${b.breakType}`);
      mark.style.left = `${xFor(day.dayStart, b.start)}px`;
      mark.style.width = `${Math.max(2, xFor(day.dayStart, b.end) - xFor(day.dayStart, b.start))}px`;
      mark.title = `${formatClock(new Date(b.start))} ${breakLabel(b.breakType)}`;
      track.appendChild(mark);
    });

    if (now >= day.dayStart && now < day.dayEnd) {
      const line = el('div', 'onair-now');
      line.style.left = `${xFor(day.dayStart, now)}px`;
      track.appendChild(line);
      rowEl.classList.add('today');
    }
    rowEl.classList.remove('loading');
  }

  function renderLegend(days) {
    legend.innerHTML = '';
    const seen = new Map();
    days.forEach((day) => day.programs.forEach((p) => {
      const key = sourceKey(ch, p.block);
      if (!seen.has(key)) seen.set(key, p.block ? blockLabel(p.block) : 'DEFAULT LINEUP');
    }));
    seen.forEach((label, key) => {
      const item = el('span', 'onair-legend-item');
      const sw = el('span', 'onair-legend-swatch');
      sw.style.background = colorFor(key);
      item.append(sw, document.createTextNode(label));
      legend.appendChild(item);
    });
    const breakItem = el('span', 'onair-legend-item');
    breakItem.append(el('span', 'onair-legend-swatch onair-legend-break'), document.createTextNode('AD BREAK / BUMPER'));
    legend.appendChild(breakItem);
  }

  function render({ scrollToNow = false, keepScroll = false } = {}) {
    const token = ++renderToken;
    const scrollLeft = scroller.scrollLeft;
    zoomBtns.forEach((b, i) => {
      const on = ZOOM_LEVELS[i] === zoom;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const weekEnd = addDays(weekStart, 6);
    weekLabel.textContent = `${formatDayHeading(weekStart)} – ${formatDayHeading(weekEnd)}`;
    grid.innerHTML = '';
    grid.appendChild(renderHourHeader());
    detail.innerHTML = '';

    const rows = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(weekStart, i);
      const row = el('div', 'onair-row loading');
      row.appendChild(el('div', 'onair-day-label', formatDayHeading(dayStart)));
      const track = el('div', 'onair-track');
      track.style.width = `${24 * zoom.pxPerHour}px`;
      row.appendChild(track);
      grid.appendChild(row);
      rows.push({ dayStart, row });
    }
    if (keepScroll) scroller.scrollLeft = scrollLeft;

    // One day per frame, so a heavy channel fills in row by row instead of
    // freezing the setup screen for the whole week at once.
    const days = [];
    let totalMs = 0;
    const step = (i) => {
      if (token !== renderToken) return;
      if (i >= rows.length) {
        renderLegend(days);
        status.textContent = `Resolved ${days.reduce((n, d) => n + d.programs.length, 0)} programs and ${days.reduce((n, d) => n + d.breaks.length, 0)} breaks in ${Math.round(totalMs)} ms.`;
        return;
      }
      const day = computeDay(ch, rows[i].dayStart);
      totalMs += day.ms;
      days.push(day);
      renderDayRow(day, rows[i].row);
      if (scrollToNow && viewNow() >= day.dayStart && viewNow() < day.dayEnd) {
        scroller.scrollLeft = Math.max(0, xFor(day.dayStart, viewNow()) - scroller.clientWidth / 3);
      }
      requestAnimationFrame(() => step(i + 1));
    };
    status.textContent = 'RESOLVING THE WEEK…';
    requestAnimationFrame(() => step(0));
  }

  if (!(ch.files && ch.files.length) && !(ch.blocks || []).some((b) => b.files && b.files.length)) {
    panelEl.innerHTML = '';
    panelEl.appendChild(el('div', 'titles-empty', 'NOTHING AIRS YET — ADD A FOLDER ON THE FOLDERS TAB OR A BLOCK ON THE BLOCKS VIEW.'));
    return;
  }
  render({ scrollToNow: true });
}
