// SCHEDULE + CALENDAR — a channel's ch.blocks[] can each be triggered by a
// time-of-day/day-of-week window OR a fixed calendar date range (a holiday
// special, a "25 days of Christmas"-style takeover), and a date-range block
// can additionally run in daily/weekly "advent calendar" mode instead of
// just looping its folder. Highest-priority matching block wins on overlap.
// A block can also override just its ads (via its ADS button) without
// touching content — leave its folder unset to use one purely for ad
// scheduling.
//
// buildSchedulePanel (a flat list editor) and buildCalendarPanel (a month
// grid preview) are two views onto the exact same ch.blocks[] data — they
// used to be registered as two separate channel-EDIT tabs, which is what
// caused the "day override drops the NOTE field" bug (two independent
// row-editor implementations for the same data drifting apart). They're
// now unified behind one exported entry point, buildUnifiedSchedulePanel,
// which renders a single SCHEDULE tab with a BLOCKS/CALENDAR view toggle
// instead of two separate tabs — see [[retro-cable-box-code-ux-audit]].
import { freshBlock, freshBroadcastHours } from './channels.js';
import { scanProgressEl } from './dom.js';
import { buildCommercialsPanel, buildTitlesPanel } from './setup-panels.js';
import { parsePositiveInt, probeDuration, toggleLazyPanel } from './setup-util.js';
import {
  computeSourcePosition, matchesTrigger, matchingBlocks, mdKey, resolveActiveCommercials, resolveActiveSource,
} from './schedule.js';
import { MONTHS, BADGE_COLORS, S, WEEKDAYS, saveConfigDebounced } from './state.js';
import { confirmDialog } from './setup-dialogs.js';
import { basenameNoExt, formatHourLabel, getDisplayTitle, shuffleArray } from './util.js';

// Short human label for a block — the block's own name if the user gave it
// one, otherwise a description of its trigger. Used by the calendar detail
// panel, the schedule list's own rows (implicitly, via block.name), and the
// interstitials pool's blockAffinity picker (setup-interstitials.js).
export function blockPickerLabel(block) {
  if (block.name && block.name.trim()) return block.name.trim();
  const t = block.trigger;
  if (t.type === 'dateRange') {
    let label = `DATE RANGE ${t.startMonth}/${t.startDay}–${t.endMonth}/${t.endDay}`;
    // Optional hour/day narrowing on top of the date range (see
    // matchesDateRangeNarrowing in schedule.js) — surface it in the label so
    // "6-10pm only" or "Fridays only" isn't invisible once named blank.
    if (t.startHour != null && t.endHour != null) {
      label += `, ${String(t.startHour).padStart(2, '0')}:00–${String(t.endHour).padStart(2, '0')}:00`;
    }
    if (t.days && t.days.length) {
      label += ` ${t.days.map((d) => WEEKDAYS[d].slice(0, 2)).join('')}`;
    }
    return label;
  }
  const days = t.days && t.days.length
    ? t.days.map((d) => WEEKDAYS[d].slice(0, 2)).join('')
    : 'DAILY';
  return `TIME BLOCK ${String(t.startHour).padStart(2, '0')}:00–${String(t.endHour).padStart(2, '0')}:00 ${days}`;
}

// Deterministic color per source (a block, or a channel's own default
// folder) — same hashing approach as channels.js's badgeColor, scoped here
// so the grid can group days by color at a glance instead of relying on
// squeezed-in text alone, and so the legend and the day-detail swatch stay
// visually consistent with each other.
function calendarSourceColor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return BADGE_COLORS[hash % BADGE_COLORS.length];
}

// A block matches its trigger but has never been pointed at a folder (or its
// folder scan came back empty) — matchingBlocks (schedule.js) filters these
// out silently everywhere (calendar, guide, playback), so this is the
// setup-side signal that surfaces "this block exists but won't ever air"
// instead of it just quietly never showing up.
function blockHasContent(block) {
  return !!(block.files && block.files.length);
}

// Blocks whose trigger matches atMs but which have no folder/content, so
// they're invisible to matchingBlocks/resolveActiveSource (playback, guide)
// even during their own trigger window — used by CALENDAR/TIMELINE to flag
// "this block exists here but won't air" instead of silently showing DEFAULT.
function matchingBlocksIncludingEmpty(ch, atMs) {
  return (ch.blocks || []).filter((b) => matchesTrigger(atMs, b) && !blockHasContent(b));
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${alpha})`;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

// Shared per-row editor for one dayOverrides[key] entry — used by both
// buildSchedulePanel's flat "DAY OVERRIDES" list and buildCalendarPanel's
// per-day inline editor, so a day edited from either view exposes every
// field (previously only the SCHEDULE-tab version rendered `note`, silently
// dropping it when a day was edited from CALENDAR instead).
function renderDayOverrideRow(block, ov, { className, onRemove, onChange } = {}) {
  const row = document.createElement('div');
  row.className = className || 'block-row';

  const fileSel = document.createElement('select');
  fileSel.className = 'block-hour-select';
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = 'AUTO';
  fileSel.appendChild(autoOpt);
  (block.files || []).forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f.path;
    opt.textContent = basenameNoExt(f.path);
    fileSel.appendChild(opt);
  });
  fileSel.value = ov.file || '';
  fileSel.addEventListener('change', () => {
    ov.file = fileSel.value || null;
    if (onChange) onChange();
    saveConfigDebounced();
  });
  row.appendChild(fileSel);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'block-text-input';
  titleInput.placeholder = 'TITLE OVERRIDE';
  titleInput.value = ov.title || '';
  titleInput.addEventListener('input', () => {
    ov.title = titleInput.value;
    saveConfigDebounced();
  });
  row.appendChild(titleInput);

  const unlockInput = document.createElement('input');
  unlockInput.type = 'text';
  unlockInput.placeholder = 'HH:MM';
  unlockInput.className = 'block-text-input block-unlock-input';
  unlockInput.value = ov.unlockTime || '';
  unlockInput.addEventListener('change', () => {
    const v = unlockInput.value.trim();
    ov.unlockTime = /^\d{1,2}:\d{2}$/.test(v) ? v : '';
    unlockInput.value = ov.unlockTime;
    saveConfigDebounced();
  });
  row.appendChild(unlockInput);

  const skipLabel = document.createElement('label');
  skipLabel.className = 'shuffle-toggle';
  const skipCheckbox = document.createElement('input');
  skipCheckbox.type = 'checkbox';
  skipCheckbox.checked = !!ov.skip;
  skipCheckbox.addEventListener('change', () => {
    ov.skip = skipCheckbox.checked;
    if (onChange) onChange();
    saveConfigDebounced();
  });
  skipLabel.appendChild(skipCheckbox);
  skipLabel.appendChild(document.createTextNode('SKIP'));
  row.appendChild(skipLabel);

  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.className = 'block-text-input';
  noteInput.placeholder = 'NOTE (SETUP ONLY)';
  noteInput.value = ov.note || '';
  noteInput.addEventListener('input', () => {
    ov.note = noteInput.value;
    saveConfigDebounced();
  });
  row.appendChild(noteInput);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn remove-btn';
  removeBtn.textContent = 'REMOVE';
  removeBtn.addEventListener('click', () => {
    onRemove();
    saveConfigDebounced();
  });
  row.appendChild(removeBtn);

  return row;
}

// A month grid showing which block (or the default folder) is airing on
// each day, for whichever channels are passed in — parameterized by "which
// channels' blocks to render" (defaulted to a single channel by the
// unified panel below) rather than hardcoded to one, so a future
// cross-channel overview is "feed this more channels", not a second
// calendar built from scratch. Blocks on different channels never conflict
// with each other (each channel resolves independently), so a day cell
// only ever flags an overlap warning between blocks *within* the same
// channel.
// opts.onEditBlock(block), if given, is called when the user wants to jump
// from a day's preview straight into that block's full editor — the caller
// (buildUnifiedSchedulePanel) owns switching back to the BLOCKS view and
// knows how to scroll/highlight the right block row there.
export function buildCalendarPanel(channels, panelEl, opts) {
  opts = opts || {};
  panelEl.innerHTML = '';

  const viewDate = new Date();
  viewDate.setDate(1);
  viewDate.setHours(12, 0, 0, 0);
  let selectedDayMs = null;

  const nav = document.createElement('div');
  nav.className = 'calendar-nav';
  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn';
  prevBtn.textContent = '‹ PREV';
  const monthLabel = document.createElement('span');
  monthLabel.className = 'calendar-month-label';
  const todayBtn = document.createElement('button');
  todayBtn.className = 'btn';
  todayBtn.textContent = 'TODAY';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn';
  nextBtn.textContent = 'NEXT ›';
  nav.appendChild(prevBtn);
  nav.appendChild(monthLabel);
  nav.appendChild(todayBtn);
  nav.appendChild(nextBtn);
  panelEl.appendChild(nav);

  const quietNotice = document.createElement('div');
  quietNotice.className = 'calendar-quiet-notice hidden';
  quietNotice.textContent = 'NOTHING SCHEDULED THIS MONTH — DEFAULT PROGRAMMING ALL MONTH';
  panelEl.appendChild(quietNotice);

  const gridWrap = document.createElement('div');
  gridWrap.className = 'calendar-grid-wrap';
  panelEl.appendChild(gridWrap);

  const headerRow = document.createElement('div');
  headerRow.className = 'calendar-grid calendar-header-row';
  WEEKDAYS.forEach((wd) => {
    const cell = document.createElement('div');
    cell.className = 'calendar-weekday';
    cell.textContent = wd.slice(0, 3);
    headerRow.appendChild(cell);
  });
  gridWrap.appendChild(headerRow);

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  gridWrap.appendChild(grid);

  const legend = document.createElement('div');
  legend.className = 'calendar-legend';
  panelEl.appendChild(legend);

  const detail = document.createElement('div');
  detail.className = 'calendar-detail hidden';
  panelEl.appendChild(detail);

  // Everything the grid, the legend, and the click-to-preview detail panel
  // all need to know about a single channel on a single day, computed once
  // per (channel, day) pair from the same pure resolveActiveSource/
  // matchingBlocks functions live playback and the guide already use — a
  // calendar day is never more than a snapshot of "what would air right now
  // if it were this moment," so there's no separate day-preview data model.
  function cellInfoFor(ch, dayMs) {
    const source = resolveActiveSource(ch, dayMs);
    const matches = matchingBlocks(ch, dayMs);
    const emptyMatches = matchingBlocksIncludingEmpty(ch, dayMs);
    const label = source.block ? blockPickerLabel(source.block) : (ch.files.length ? 'DEFAULT' : 'NO CONTENT');
    const colorKey = source.block ? source.block.id : `default-${ch.number}`;
    const color = (source.block || ch.files.length) ? calendarSourceColor(colorKey) : null;
    const conflict = matches.length > 1;
    const isDaily = source.block && (source.block.mode === 'daily' || source.block.mode === 'weekly');
    return { ch, source, matches, emptyMatches, label, color, conflict, isDaily };
  }

  // Cheap read-only scan (no DOM) — whether any day in (year, month) has a
  // real block airing or an empty-but-matching block, used both to
  // de-emphasize the current month's grid when it's all DEFAULT and to put
  // a "there's something over here" dot on PREV/NEXT so a user isn't
  // scrolling blind past a bunch of empty months.
  function monthHasContent(year, month) {
    const days = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const dayMs = new Date(year, month, day, 12, 0, 0, 0).getTime();
      for (let i = 0; i < channels.length; i++) {
        const info = cellInfoFor(channels[i], dayMs);
        if (info.source.block || info.emptyMatches.length) return true;
      }
    }
    return false;
  }

  function renderLegend(seenEntries) {
    legend.innerHTML = '';
    const seen = new Map();
    seenEntries.forEach((e) => { if (e.color && !seen.has(e.label)) seen.set(e.label, e.color); });
    seen.forEach((color, label) => {
      const item = document.createElement('div');
      item.className = 'calendar-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'calendar-legend-swatch';
      swatch.style.background = color;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(label));
      legend.appendChild(item);
    });
  }

  // Compact inline editor for one day's dayOverrides[mdKey] entry on a
  // daily/weekly-mode block — the same fields buildSchedulePanel's own
  // "DAY OVERRIDES" list edits, just scoped to the single day already
  // selected here so it doesn't require switching views to hunt the
  // matching row in a flat list.
  function renderOverrideEditor(ch, block, dayMs, container) {
    container.innerHTML = '';
    const key = mdKey(dayMs);
    if (!block.dayOverrides) block.dayOverrides = {};
    const existing = block.dayOverrides[key];

    if (!existing) {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn';
      addBtn.textContent = '+ OVERRIDE THIS DAY';
      addBtn.addEventListener('click', () => {
        block.dayOverrides[key] = { file: null, title: '', unlockTime: '', skip: false, note: '' };
        renderOverrideEditor(ch, block, dayMs, container);
        renderDetail(dayMs);
      });
      container.appendChild(addBtn);
      return;
    }

    const row = renderDayOverrideRow(block, existing, {
      className: 'calendar-override-row',
      onRemove: () => { delete block.dayOverrides[key]; renderDetail(dayMs); },
      onChange: () => renderDetail(dayMs),
    });
    container.appendChild(row);
  }

  function renderDetail(dayMs) {
    detail.innerHTML = '';
    detail.classList.remove('hidden');
    const d = new Date(dayMs);

    const header = document.createElement('div');
    header.className = 'calendar-detail-header';
    header.textContent = `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    detail.appendChild(header);

    channels.forEach((ch) => {
      const info = cellInfoFor(ch, dayMs);
      const section = document.createElement('div');
      section.className = 'calendar-detail-channel';

      if (channels.length > 1) {
        const chLabel = document.createElement('div');
        chLabel.className = 'calendar-detail-ch-label';
        chLabel.textContent = `CH ${ch.number}${ch.name ? ' — ' + ch.name : ''}`;
        section.appendChild(chLabel);
      }

      const sourceLine = document.createElement('div');
      sourceLine.className = 'calendar-detail-line';
      if (info.color) {
        const swatch = document.createElement('span');
        swatch.className = 'calendar-legend-swatch';
        swatch.style.background = info.color;
        sourceLine.appendChild(swatch);
      }
      sourceLine.appendChild(document.createTextNode(`AIRING: ${info.label}`));
      if (info.source.block) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn calendar-inline-btn';
        editBtn.textContent = 'EDIT BLOCK';
        editBtn.addEventListener('click', () => opts.onEditBlock && opts.onEditBlock(info.source.block));
        sourceLine.appendChild(editBtn);
      }
      section.appendChild(sourceLine);

      const pos = computeSourcePosition(info.source, dayMs);
      if (pos && pos.file) {
        const posLine = document.createElement('div');
        posLine.className = 'calendar-detail-line calendar-detail-sub';
        posLine.textContent = `AT NOON: ${getDisplayTitle(pos.file)}`;
        section.appendChild(posLine);
      }

      if (info.conflict) {
        const conflictLine = document.createElement('div');
        conflictLine.className = 'calendar-detail-line calendar-detail-conflict';
        conflictLine.textContent = `OVERLAPS ${info.matches.length - 1} OTHER BLOCK${info.matches.length > 2 ? 'S' : ''}: ` +
          info.matches.map((b) => blockPickerLabel(b)).join(' vs. ') + ' — highest priority wins';
        section.appendChild(conflictLine);
      }

      if (info.emptyMatches.length) {
        const warnLine = document.createElement('div');
        warnLine.className = 'calendar-detail-line calendar-detail-conflict';
        warnLine.textContent = `NO FOLDER SET, WON'T AIR: ${info.emptyMatches.map((b) => blockPickerLabel(b)).join(', ')}`;
        section.appendChild(warnLine);
      }

      const commercials = resolveActiveCommercials(ch, dayMs).commercials;
      const adsLine = document.createElement('div');
      adsLine.className = 'calendar-detail-line calendar-detail-sub';
      adsLine.textContent = (commercials && commercials.enabled === false)
        ? 'ADS: OFF'
        : `ADS: EVERY ${(commercials && commercials.intervalMinutes) || S.config.commercials.intervalMinutes || 10} MIN`;
      section.appendChild(adsLine);

      if (info.isDaily) {
        const overrideWrap = document.createElement('div');
        overrideWrap.className = 'calendar-override-wrap';
        renderOverrideEditor(ch, info.source.block, dayMs, overrideWrap);
        section.appendChild(overrideWrap);
      } else if (!info.source.block) {
        const addBlockBtn = document.createElement('button');
        addBlockBtn.className = 'btn calendar-inline-btn';
        addBlockBtn.textContent = '+ ADD BLOCK STARTING HERE';
        addBlockBtn.title = 'Creates a one-day date-range block on this channel, then opens it for editing (folder, end date, etc).';
        addBlockBtn.addEventListener('click', () => {
          const block = freshBlock('dateRange');
          block.trigger.startMonth = d.getMonth() + 1;
          block.trigger.startDay = d.getDate();
          block.trigger.endMonth = d.getMonth() + 1;
          block.trigger.endDay = d.getDate();
          if (!ch.blocks) ch.blocks = [];
          ch.blocks.push(block);
          if (opts.onEditBlock) opts.onEditBlock(block);
          else render();
        });
        section.appendChild(addBlockBtn);
      }

      detail.appendChild(section);
    });
  }

  function render() {
    monthLabel.textContent = `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
    grid.innerHTML = '';

    const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1, 12, 0, 0, 0);
    const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
    const leadingBlanks = firstOfMonth.getDay();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === viewDate.getFullYear() && today.getMonth() === viewDate.getMonth();
    const monthEntries = [];

    for (let i = 0; i < leadingBlanks; i++) {
      const blank = document.createElement('div');
      blank.className = 'calendar-day calendar-day-blank';
      grid.appendChild(blank);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dayMs = new Date(viewDate.getFullYear(), viewDate.getMonth(), day, 12, 0, 0, 0).getTime();
      const dow = new Date(dayMs).getDay();
      const cell = document.createElement('div');
      cell.className = 'calendar-day';
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      if (dow === 0 || dow === 6) cell.classList.add('calendar-day-weekend');
      if (isCurrentMonth && today.getDate() === day) cell.classList.add('calendar-day-today');
      if (selectedDayMs === dayMs) cell.classList.add('calendar-day-selected');

      const num = document.createElement('div');
      num.className = 'calendar-day-num';
      num.textContent = String(day);
      cell.appendChild(num);

      const entries = channels.map((ch) => cellInfoFor(ch, dayMs));
      monthEntries.push(...entries);
      if (entries.some((e) => e.conflict)) cell.classList.add('calendar-day-conflict');
      if (entries.some((e) => e.emptyMatches.length)) cell.classList.add('calendar-day-empty-block');
      // Single-channel calendars (the common case) tint the whole cell by
      // the airing source's color so the grid reads at a glance — multiple
      // channels can't share one tint, so they fall back to per-label
      // left-border strips instead (still handled in the label loop below).
      if (channels.length === 1 && entries[0].color) {
        // backgroundColor, not the `background` shorthand — the shorthand
        // resets background-image too, which would silently wipe out the
        // .calendar-day-empty-block stripe pattern applied via the CSS class.
        cell.style.backgroundColor = hexToRgba(entries[0].color, dow === 0 || dow === 6 ? 0.22 : 0.16);
        cell.style.borderColor = hexToRgba(entries[0].color, 0.5);
      }
      cell.title = entries.map((e) => {
        let t = e.conflict
          ? `${e.label} (overlaps ${e.matches.length - 1} other block${e.matches.length > 2 ? 's' : ''} — click for details)`
          : e.label;
        if (e.emptyMatches.length) t += ` [${e.emptyMatches.length} block${e.emptyMatches.length > 1 ? 's' : ''} matching but no folder set — won't air]`;
        return t;
      }).join('\n') + '\n\nClick for a full day preview.';

      entries.forEach((e) => {
        const label = document.createElement('div');
        label.className = 'calendar-day-label' + (e.conflict ? ' calendar-day-label-conflict' : '');
        if (channels.length > 1 && e.color) label.style.borderLeftColor = e.color;
        label.textContent = channels.length > 1 ? `${e.ch.number}: ${e.label}` : e.label;
        cell.appendChild(label);
      });

      const selectDay = () => {
        selectedDayMs = dayMs;
        Array.from(grid.children).forEach((c) => c.classList.remove('calendar-day-selected'));
        cell.classList.add('calendar-day-selected');
        renderDetail(dayMs);
      };
      cell.addEventListener('click', selectDay);
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDay(); }
      });

      grid.appendChild(cell);
    }

    const monthHasAnything = monthEntries.some((e) => e.source.block || e.emptyMatches.length);
    quietNotice.classList.toggle('hidden', monthHasAnything);
    gridWrap.classList.toggle('calendar-grid-wrap-quiet', !monthHasAnything);

    const prevDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
    const nextDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
    prevBtn.classList.toggle('calendar-nav-has-content', monthHasContent(prevDate.getFullYear(), prevDate.getMonth()));
    nextBtn.classList.toggle('calendar-nav-has-content', monthHasContent(nextDate.getFullYear(), nextDate.getMonth()));

    renderLegend(monthEntries);
    if (selectedDayMs != null) {
      const d = new Date(selectedDayMs);
      if (d.getFullYear() === viewDate.getFullYear() && d.getMonth() === viewDate.getMonth()) {
        renderDetail(selectedDayMs);
      } else {
        detail.classList.add('hidden');
      }
    }
  }

  prevBtn.addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() - 1); render(); });
  nextBtn.addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() + 1); render(); });
  todayBtn.addEventListener('click', () => {
    const now = new Date();
    viewDate.setFullYear(now.getFullYear(), now.getMonth(), 1);
    render();
  });

  render();
}

// A weekly "broadcast clock" — the standard TV/radio scheduling
// visualization (a template showing the hourly format graphically, so gaps
// and overlaps are visible instead of read off numbers). This is the
// counterpart CALENDAR never had: CALENDAR resolves one winner per *day*
// (right for dateRange blocks), but a dayOfWeek block's hour range had no
// visual at all before this — you could only read it as text in a block
// row. TIMELINE is the coarse "build the standing weekly lineup" layer;
// CALENDAR stays the fine-tuning layer (holiday takeovers, day overrides)
// on top of it.
//
// Sampled the same way CALENDAR samples a day: resolveActiveSource(ch, atMs)
// at a representative instant per hour, across the current real-world week —
// a pure function of time, no new resolution math (matches
// [[retro-cable-box-architecture-constraints]]'s deterministic-scheduling
// pattern). A dateRange block will show as a flat colored week if it's
// currently active, which is a real, correct answer — just not this view's
// primary use case (that's what CALENDAR is for).
export function buildTimelinePanel(ch, panelEl, opts) {
  opts = opts || {};
  panelEl.innerHTML = '';

  const hint = document.createElement('div');
  hint.className = 'titles-empty';
  hint.textContent = 'YOUR STANDING WEEKLY LINEUP. BUILD THE DAYPART STRUCTURE HERE, THEN USE CALENDAR TO FINE-TUNE SPECIFIC DATES.';
  panelEl.appendChild(hint);

  const wrap = document.createElement('div');
  wrap.className = 'timeline-grid-wrap';
  panelEl.appendChild(wrap);

  const grid = document.createElement('div');
  grid.className = 'timeline-grid';
  wrap.appendChild(grid);

  // Start-of-week (Sunday) for the current real-world week — the timeline
  // always shows "this week" since a dayOfWeek block's shape doesn't change
  // week to week (that's the whole point of it being a standing lineup).
  const now = new Date();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay(), 12, 0, 0, 0);

  // Corner spacer + hour header.
  const corner = document.createElement('div');
  corner.className = 'timeline-corner';
  grid.appendChild(corner);
  for (let h = 0; h < 24; h++) {
    const hd = document.createElement('div');
    hd.className = 'timeline-hour-label';
    hd.textContent = h % 3 === 0 ? formatHourLabel(h).replace(':00', '') : '';
    grid.appendChild(hd);
  }

  const legend = document.createElement('div');
  legend.className = 'calendar-legend';

  const seenLabels = new Map();

  WEEKDAYS.forEach((wd, dayIdx) => {
    const dayLabel = document.createElement('div');
    dayLabel.className = 'timeline-day-label';
    dayLabel.textContent = wd.slice(0, 3);
    grid.appendChild(dayLabel);

    for (let h = 0; h < 24; h++) {
      const cellMs = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + dayIdx, h, 30, 0, 0).getTime();
      const source = resolveActiveSource(ch, cellMs);
      const emptyMatches = matchingBlocksIncludingEmpty(ch, cellMs);
      const label = source.block ? blockPickerLabel(source.block) : (ch.files.length ? 'DEFAULT' : 'NO CONTENT');
      const colorKey = source.block ? source.block.id : `default-${ch.number}`;
      const color = (source.block || ch.files.length) ? calendarSourceColor(colorKey) : null;

      const cell = document.createElement('div');
      cell.className = 'timeline-cell';
      if (color) cell.style.background = hexToRgba(color, 0.5);
      if (emptyMatches.length) cell.classList.add('timeline-cell-empty-block');
      cell.title = emptyMatches.length
        ? `${label} [${emptyMatches.length} block matching but no folder set — won't air]`
        : label;

      if (source.block) {
        cell.classList.add('timeline-cell-clickable');
        cell.tabIndex = 0;
        cell.setAttribute('role', 'button');
        const block = source.block;
        cell.addEventListener('click', () => opts.onEditBlock && opts.onEditBlock(block));
        cell.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onEditBlock && opts.onEditBlock(block); }
        });
      }

      if (color && !seenLabels.has(label)) seenLabels.set(label, color);
      grid.appendChild(cell);
    }
  });

  seenLabels.forEach((color, label) => {
    const item = document.createElement('div');
    item.className = 'calendar-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'calendar-legend-swatch';
    swatch.style.background = color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  });
  panelEl.appendChild(legend);
}

export function buildSchedulePanel(ch, panelEl) {
  panelEl.innerHTML = '';

  const hint = document.createElement('div');
  hint.className = 'titles-empty';
  hint.textContent = 'BLOCKS OVERRIDE THE DEFAULT FOLDER WHENEVER THEIR TRIGGER MATCHES. HIGHEST PRIORITY WINS ON OVERLAP. A DATE-RANGE BLOCK CAN ALSO RUN DAILY/WEEKLY INSTEAD OF LOOPING (AN ADVENT-CALENDAR-STYLE COUNTDOWN), OR LIMIT ITSELF TO SPECIFIC HOURS/DAYS WITHIN THE RANGE (E.G. 6-10PM ONLY, OR FRIDAYS ONLY).';
  panelEl.appendChild(hint);

  // Broadcast hours — a whole-channel, block-independent "off the air"
  // window (sign-off card outside these hours instead of any content),
  // separate from blocks/default-folder resolution entirely. See
  // isWithinBroadcastHours/nextBroadcastHoursBoundary (schedule.js).
  if (!ch.broadcastHours) ch.broadcastHours = freshBroadcastHours();
  const broadcastRow = document.createElement('div');
  broadcastRow.className = 'block-card-row';
  const broadcastLabel = document.createElement('label');
  broadcastLabel.className = 'shuffle-toggle';
  const broadcastCheckbox = document.createElement('input');
  broadcastCheckbox.type = 'checkbox';
  broadcastCheckbox.checked = !!ch.broadcastHours.enabled;
  const broadcastHoursWrap = document.createElement('span');
  broadcastCheckbox.addEventListener('change', () => {
    ch.broadcastHours.enabled = broadcastCheckbox.checked;
    renderBroadcastHours();
  });
  broadcastLabel.appendChild(broadcastCheckbox);
  broadcastLabel.appendChild(document.createTextNode('BROADCAST HOURS (SIGN OFF OUTSIDE THIS WINDOW)'));
  broadcastRow.appendChild(broadcastLabel);
  broadcastRow.appendChild(broadcastHoursWrap);
  panelEl.appendChild(broadcastRow);

  function renderBroadcastHours() {
    broadcastHoursWrap.innerHTML = '';
    if (!ch.broadcastHours.enabled) return;
    broadcastHoursWrap.appendChild(hourSelect(ch.broadcastHours.startHour, (v) => { ch.broadcastHours.startHour = v; }));
    const dashEl = document.createElement('span');
    dashEl.className = 'block-dash';
    dashEl.textContent = '→';
    broadcastHoursWrap.appendChild(dashEl);
    broadcastHoursWrap.appendChild(hourSelect(ch.broadcastHours.endHour, (v) => { ch.broadcastHours.endHour = v; }));
  }
  renderBroadcastHours();

  const list = document.createElement('div');
  list.className = 'titles-list';

  // Day-of-week toggle buttons bound directly to `trigger.days` (empty/unset
  // = every day, the shared backward-compatible default). Used both by a
  // dayOfWeek trigger's own day filter and by a dateRange trigger's optional
  // narrowing (see matchesDateRangeNarrowing, schedule.js) — same field,
  // same semantics, just layered on top of a date match in the latter case.
  function buildDaysRow(trigger) {
    const daysRow = document.createElement('div');
    daysRow.className = 'block-days-row';
    if (!trigger.days) trigger.days = [];
    WEEKDAYS.forEach((wd, dayIdx) => {
      const dayBtn = document.createElement('button');
      dayBtn.type = 'button';
      const dayActive = trigger.days.length === 0 || trigger.days.includes(dayIdx);
      dayBtn.className = 'block-day-btn' + (dayActive ? ' active' : '');
      dayBtn.setAttribute('aria-pressed', String(dayActive));
      dayBtn.textContent = wd.slice(0, 2);
      dayBtn.addEventListener('click', () => {
        const allDays = trigger.days.length === 0;
        if (allDays) {
          trigger.days = [dayIdx];
        } else {
          const di = trigger.days.indexOf(dayIdx);
          if (di === -1) trigger.days.push(dayIdx);
          else trigger.days.splice(di, 1);
          if (trigger.days.length === 7) trigger.days = [];
        }
        renderBlocks();
      });
      daysRow.appendChild(dayBtn);
    });
    return daysRow;
  }

  function hourSelect(value, onChange) {
    const sel = document.createElement('select');
    sel.className = 'block-hour-select';
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = formatHourLabel(h);
      sel.appendChild(opt);
    }
    sel.value = String(value);
    sel.addEventListener('change', () => onChange(parseInt(sel.value, 10)));
    return sel;
  }

  function monthDaySelect(month, day, onChange) {
    const wrap = document.createElement('span');
    const monthSel = document.createElement('select');
    monthSel.className = 'block-hour-select';
    MONTHS.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1);
      opt.textContent = m;
      monthSel.appendChild(opt);
    });
    monthSel.value = String(month);
    const daySel = document.createElement('select');
    daySel.className = 'block-hour-select';
    for (let d = 1; d <= 31; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = String(d);
      daySel.appendChild(opt);
    }
    daySel.value = String(day);
    monthSel.addEventListener('change', () => onChange(parseInt(monthSel.value, 10), parseInt(daySel.value, 10)));
    daySel.addEventListener('change', () => onChange(parseInt(monthSel.value, 10), parseInt(daySel.value, 10)));
    wrap.appendChild(monthSel);
    wrap.appendChild(daySel);
    return wrap;
  }

  // Three optional accent colors for one block — accent/accent2/staticTint,
  // see the THEME button's comment above. Left null on any field the user
  // hasn't touched (colorField only initializes block.theme on first edit),
  // so a half-filled theme is a real, supported state, not an error.
  function renderBlockTheme(block, panelEl, btn) {
    panelEl.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'block-card-row';

    function colorField(label, key) {
      const wrap = document.createElement('label');
      wrap.className = 'shuffle-toggle';
      wrap.appendChild(document.createTextNode(label + ' '));
      const input = document.createElement('input');
      input.type = 'color';
      input.value = (block.theme && block.theme[key]) || '#f0b429';
      input.addEventListener('input', () => {
        if (!block.theme) block.theme = {};
        block.theme[key] = input.value;
        btn.textContent = 'THEME ✓';
      });
      wrap.appendChild(input);
      return wrap;
    }

    row.appendChild(colorField('ACCENT', 'accent'));
    row.appendChild(colorField('ACCENT 2', 'accent2'));
    row.appendChild(colorField('STATIC TINT', 'staticTint'));

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn remove-btn';
    clearBtn.textContent = 'CLEAR THEME';
    clearBtn.addEventListener('click', () => {
      block.theme = null;
      btn.textContent = 'THEME';
      renderBlockTheme(block, panelEl, btn);
    });
    row.appendChild(clearBtn);
    panelEl.appendChild(row);
  }

  // Per-date customization within a daily/weekly block — dayOverrides is
  // keyed "MM-DD" rather than an array, so rows are rendered from its keys
  // directly and a date edit renames the key in place.
  function renderDayOverrides(block, container) {
    container.innerHTML = '';
    if (!block.dayOverrides) block.dayOverrides = {};
    Object.keys(block.dayOverrides).sort().forEach((key) => {
      const ov = block.dayOverrides[key];
      const [m, d] = key.split('-').map((n) => parseInt(n, 10));

      const row = renderDayOverrideRow(block, ov, {
        onRemove: () => { delete block.dayOverrides[key]; renderDayOverrides(block, container); },
      });
      row.prepend(monthDaySelect(m, d, (nm, nd) => {
        const newKey = `${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
        if (newKey !== key) { delete block.dayOverrides[key]; block.dayOverrides[newKey] = ov; }
        renderDayOverrides(block, container);
      }));

      container.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+ ADD DAY OVERRIDE';
    addBtn.addEventListener('click', () => {
      let key = '12-01', n = 1;
      while (block.dayOverrides[key] && n <= 31) { key = `12-${String(n).padStart(2, '0')}`; n++; }
      block.dayOverrides[key] = { file: null, title: '', unlockTime: '', skip: false, note: '' };
      renderDayOverrides(block, container);
    });
    container.appendChild(addBtn);
  }

  function renderBlocks() {
    list.innerHTML = '';
    (ch.blocks || []).forEach((block, idx) => {
      const card = document.createElement('div');
      card.className = 'block-card';
      card.dataset.blockId = block.id;
      card.style.borderLeftColor = calendarSourceColor(block.id);

      // ---- Header: color swatch, trigger-type toggle, name, remove ----
      const headerRow = document.createElement('div');
      headerRow.className = 'block-card-row block-card-header';

      const swatch = document.createElement('span');
      swatch.className = 'block-card-swatch';
      swatch.style.background = calendarSourceColor(block.id);
      headerRow.appendChild(swatch);

      // Trigger-type switch replaces the whole trigger (and resets
      // priority/mode to that type's defaults) since the two shapes share
      // no fields — a mid-edit switch is rare enough that a clean reset
      // beats trying to preserve half-relevant state.
      const typeRow = document.createElement('div');
      typeRow.className = 'block-days-row';
      [['dayOfWeek', 'TIME BLOCK'], ['dateRange', 'DATE RANGE']].forEach(([type, label]) => {
        const typeBtn = document.createElement('button');
        typeBtn.type = 'button';
        const typeActive = block.trigger.type === type;
        typeBtn.className = 'block-day-btn block-type-btn' + (typeActive ? ' active' : '');
        typeBtn.setAttribute('aria-pressed', String(typeActive));
        typeBtn.textContent = label;
        typeBtn.addEventListener('click', () => {
          if (block.trigger.type === type) return;
          const fresh = freshBlock(type);
          block.trigger = fresh.trigger;
          block.priority = fresh.priority;
          block.mode = 'loop';
          renderBlocks();
          saveConfigDebounced();
        });
        typeRow.appendChild(typeBtn);
      });
      headerRow.appendChild(typeRow);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'LABEL (E.G. HOLIDAY SPECIAL)';
      nameInput.className = 'block-text-input block-card-name';
      nameInput.value = block.name || '';
      nameInput.addEventListener('input', () => {
        block.name = nameInput.value;
        saveConfigDebounced();
      });
      headerRow.appendChild(nameInput);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn remove-btn block-card-remove';
      removeBtn.textContent = 'REMOVE';
      removeBtn.addEventListener('click', async () => {
        const label = block.name ? `"${block.name}"` : 'this block';
        if (!(await confirmDialog(`Remove ${label}? Its trigger, day overrides, theme, and ad overrides can't be recovered.`))) return;
        ch.blocks.splice(idx, 1);
        renderBlocks();
        saveConfigDebounced();
      });
      headerRow.appendChild(removeBtn);

      card.appendChild(headerRow);

      if (!blockHasContent(block)) {
        card.classList.add('block-card-warning');
        const warning = document.createElement('div');
        warning.className = 'block-card-warning-text';
        warning.textContent = 'NO FOLDER SET — THIS BLOCK WON\'T AIR';
        card.appendChild(warning);
      }

      // ---- Schedule: date-range or hour+day-of-week, plus priority ----
      const scheduleRow = document.createElement('div');
      scheduleRow.className = 'block-card-row';
      const isDateRange = block.trigger.type === 'dateRange';
      const dash = () => { const s = document.createElement('span'); s.className = 'block-dash'; s.textContent = '→'; return s; };

      let narrowRow = null;
      let narrowFieldsRow = null;
      if (isDateRange) {
        scheduleRow.appendChild(monthDaySelect(block.trigger.startMonth, block.trigger.startDay, (m, d) => { block.trigger.startMonth = m; block.trigger.startDay = d; }));
        scheduleRow.appendChild(dash());
        scheduleRow.appendChild(monthDaySelect(block.trigger.endMonth, block.trigger.endDay, (m, d) => { block.trigger.endMonth = m; block.trigger.endDay = d; }));

        // Optional narrowing layered on top of the date match — "25 Days of
        // Christmas, but only 6-10pm" or "every Friday in October" — same
        // trigger.startHour/endHour/days fields a dayOfWeek trigger uses,
        // just optional here (see matchesDateRangeNarrowing, schedule.js).
        // Built here but appended after scheduleRow below (not inline) so
        // it lands in the card in the same order regardless of which
        // branch ran.
        const narrowed = block.trigger.startHour != null && block.trigger.endHour != null;
        narrowRow = document.createElement('div');
        narrowRow.className = 'block-card-row';
        const narrowLabel = document.createElement('label');
        narrowLabel.className = 'shuffle-toggle';
        const narrowCheckbox = document.createElement('input');
        narrowCheckbox.type = 'checkbox';
        narrowCheckbox.checked = narrowed;
        narrowCheckbox.addEventListener('change', () => {
          if (narrowCheckbox.checked) {
            block.trigger.startHour = 18;
            block.trigger.endHour = 22;
            block.trigger.days = block.trigger.days || [];
          } else {
            delete block.trigger.startHour;
            delete block.trigger.endHour;
            delete block.trigger.days;
          }
          renderBlocks();
          saveConfigDebounced();
        });
        narrowLabel.appendChild(narrowCheckbox);
        narrowLabel.appendChild(document.createTextNode('ALSO LIMIT TO SPECIFIC HOURS/DAYS'));
        narrowRow.appendChild(narrowLabel);

        if (narrowed) {
          narrowFieldsRow = document.createElement('div');
          narrowFieldsRow.className = 'block-card-row';
          narrowFieldsRow.appendChild(hourSelect(block.trigger.startHour, (v) => { block.trigger.startHour = v; saveConfigDebounced(); }));
          narrowFieldsRow.appendChild(dash());
          narrowFieldsRow.appendChild(hourSelect(block.trigger.endHour, (v) => { block.trigger.endHour = v; saveConfigDebounced(); }));
          narrowFieldsRow.appendChild(buildDaysRow(block.trigger, () => saveConfigDebounced()));
        }
      } else {
        scheduleRow.appendChild(hourSelect(block.trigger.startHour, (v) => { block.trigger.startHour = v; saveConfigDebounced(); }));
        scheduleRow.appendChild(dash());
        scheduleRow.appendChild(hourSelect(block.trigger.endHour, (v) => { block.trigger.endHour = v; saveConfigDebounced(); }));
        scheduleRow.appendChild(buildDaysRow(block.trigger, () => saveConfigDebounced()));
      }

      const priorityLabel = document.createElement('label');
      priorityLabel.className = 'shuffle-toggle';
      priorityLabel.appendChild(document.createTextNode('PRIORITY '));
      const priorityInput = document.createElement('input');
      priorityInput.type = 'number';
      priorityInput.className = 'block-priority-input';
      priorityInput.value = block.priority || 0;
      priorityInput.addEventListener('change', () => {
        block.priority = parseInt(priorityInput.value, 10) || 0;
        saveConfigDebounced();
      });
      priorityLabel.appendChild(priorityInput);
      scheduleRow.appendChild(priorityLabel);

      card.appendChild(scheduleRow);
      if (narrowRow) card.appendChild(narrowRow);
      if (narrowFieldsRow) card.appendChild(narrowFieldsRow);

      // ---- Mode: dateRange always gets one; dayOfWeek only when exactly
      // one day is selected (a "weekly rotation" needs a single once-a-week
      // occurrence to rotate against — see resolveWeeklyOccurrenceSource in
      // schedule.js). daily/marathon/finale/day-overrides stay
      // dateRange-only — a dayOfWeek block has no calendar "day 1"/"final
      // day" for those to mean anything.
      let dayOverridesPanel = null;
      const singleDayOfWeek = !isDateRange && block.trigger.days && block.trigger.days.length === 1;
      if (isDateRange || singleDayOfWeek) {
        const modeRow = document.createElement('div');
        modeRow.className = 'block-card-row';

        const modeOptions = isDateRange
          ? [['loop', 'LOOP'], ['marathon', 'MARATHON'], ['daily', 'DAILY (ADVENT)'], ['weekly', 'WEEKLY']]
          : [['loop', 'LOOP'], ['weekly', 'WEEKLY ROTATION']];
        const modeSelect = document.createElement('select');
        modeSelect.className = 'block-hour-select';
        modeOptions.forEach(([v, label]) => {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = label;
          modeSelect.appendChild(opt);
        });
        modeSelect.value = modeOptions.some(([v]) => v === block.mode) ? block.mode : 'loop';
        modeSelect.addEventListener('change', () => {
          block.mode = modeSelect.value;
          renderBlocks();
          saveConfigDebounced();
        });
        modeRow.appendChild(modeSelect);

        if (!isDateRange && block.mode === 'weekly') {
          const hint = document.createElement('span');
          hint.className = 'block-count';
          hint.textContent = 'A DIFFERENT FILE FROM THE FOLDER EACH WEEK — E.G. A FRIDAY MOVIE PREMIERE';
          modeRow.appendChild(hint);
        }

        if (isDateRange && (block.mode === 'daily' || block.mode === 'weekly')) {
          const finaleLabel = document.createElement('label');
          finaleLabel.className = 'shuffle-toggle';
          const finaleCheckbox = document.createElement('input');
          finaleCheckbox.type = 'checkbox';
          finaleCheckbox.checked = !!block.finale;
          finaleCheckbox.addEventListener('change', () => {
            block.finale = finaleCheckbox.checked ? { unlockAll: true, mode: 'marathon' } : null;
            saveConfigDebounced();
          });
          finaleLabel.appendChild(finaleCheckbox);
          finaleLabel.appendChild(document.createTextNode('UNLOCK ALL + MARATHON ON FINAL DAY'));
          modeRow.appendChild(finaleLabel);

          const dayOverridesBtn = document.createElement('button');
          dayOverridesBtn.className = 'btn';
          const ovCount = Object.keys(block.dayOverrides || {}).length;
          dayOverridesBtn.textContent = ovCount ? `DAY OVERRIDES (${ovCount})` : 'DAY OVERRIDES';
          dayOverridesPanel = document.createElement('div');
          dayOverridesPanel.className = 'titles-panel hidden';
          dayOverridesBtn.addEventListener('click', () => {
            toggleLazyPanel(dayOverridesPanel, () => renderDayOverrides(block, dayOverridesPanel));
          });
          modeRow.appendChild(dayOverridesBtn);
        }

        card.appendChild(modeRow);
      } else if (block.mode && block.mode !== 'loop') {
        // A dayOfWeek block that had a mode set while narrowed to one day,
        // then broadened back to multiple/zero days — reset so a stale mode
        // doesn't linger with no UI to show or change it. resolveActiveSource
        // already ignores an unrecognized mode safely, this just keeps the
        // stored value honest.
        block.mode = 'loop';
      }

      // ---- Content: folder + ads ----
      const contentRow = document.createElement('div');
      contentRow.className = 'block-card-row';

      const folderBtn = document.createElement('button');
      folderBtn.className = 'btn';
      folderBtn.textContent = block.folder ? 'CHANGE FOLDER' : 'CHOOSE FOLDER';
      folderBtn.addEventListener('click', async () => {
        const folder = await window.api.selectFolder();
        if (!folder) return;
        block.folder = folder;
        block.files = [];
        renderBlocks();

        scanProgressEl.classList.remove('hidden');
        scanProgressEl.textContent = 'SCANNING BLOCK FOLDER…';
        const paths = await window.api.scanFolder(folder);
        const files = [];
        for (let i = 0; i < paths.length; i++) {
          scanProgressEl.textContent = `PROBING BLOCK VIDEO ${i + 1} / ${paths.length}…`;
          const duration = await probeDuration(paths[i]);
          files.push({ path: paths[i], duration });
        }
        if (ch.shuffle) shuffleArray(files);
        block.files = files;
        block.anchor = Date.now();
        scanProgressEl.classList.add('hidden');
        renderBlocks();
        saveConfigDebounced();
      });
      contentRow.appendChild(folderBtn);

      const count = document.createElement('span');
      count.className = 'block-count';
      count.textContent = block.folder ? `${block.files.length} videos` : 'no folder';
      contentRow.appendChild(count);

      const commercialsPanel = document.createElement('div');
      commercialsPanel.className = 'titles-panel hidden';

      const commercialsBtn = document.createElement('button');
      commercialsBtn.className = 'btn';
      commercialsBtn.textContent = block.commercials ? 'ADS ✓' : 'ADS';
      commercialsBtn.addEventListener('click', () => {
        toggleLazyPanel(commercialsPanel, () => {
          buildCommercialsPanel(block, commercialsPanel, {
            allowInherit: true,
            onChange: () => { commercialsBtn.textContent = block.commercials ? 'ADS ✓' : 'ADS'; saveConfigDebounced(); },
          });
        });
      });
      contentRow.appendChild(commercialsBtn);

      // Per-block title/tag/description editing — mirrors the channel-level
      // TITLES tab (setup-panels.js), but scoped to this block's own file
      // pool (block.files), which a channel-wide TITLES tab never touches.
      const titlesPanel = document.createElement('div');
      titlesPanel.className = 'titles-panel hidden';
      const titlesBtn = document.createElement('button');
      titlesBtn.className = 'btn';
      titlesBtn.textContent = 'TITLES';
      titlesBtn.disabled = !block.files || !block.files.length;
      titlesBtn.addEventListener('click', () => {
        toggleLazyPanel(titlesPanel, () => {
          buildTitlesPanel(block, titlesPanel, { folders: block.folder ? [block.folder] : [] });
        });
      });
      contentRow.appendChild(titlesBtn);

      // Optional per-block accent colors — accent/accent2 tint the
      // break-transition UI (station ID bar, up-next bar, the CRT toggle
      // flash) while this block is airing, staticTint colors the
      // channel-change static burst; see applyBlockTheme (power.js) and the
      // guide-grid coloring in buildChannelRow (guide.js). Unset (default)
      // means every one of those looks exactly like it did before this
      // existed — this is purely opt-in per block.
      const themePanel = document.createElement('div');
      themePanel.className = 'titles-panel hidden';
      const themeBtn = document.createElement('button');
      themeBtn.className = 'btn';
      themeBtn.textContent = block.theme ? 'THEME ✓' : 'THEME';
      themeBtn.addEventListener('click', () => {
        toggleLazyPanel(themePanel, () => renderBlockTheme(block, themePanel, themeBtn));
      });
      contentRow.appendChild(themeBtn);

      card.appendChild(contentRow);

      list.appendChild(card);
      list.appendChild(commercialsPanel);
      list.appendChild(titlesPanel);
      list.appendChild(themePanel);
      if (dayOverridesPanel) list.appendChild(dayOverridesPanel);
    });
    if (!ch.blocks || ch.blocks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'titles-empty';
      empty.textContent = 'NO BLOCKS — CHANNEL PLAYS ITS DEFAULT FOLDER ALL DAY';
      list.appendChild(empty);
    }
  }

  // "+ ADD BLOCK" is a small menu: two blank starting points (the original
  // behavior) plus presets modeled directly on real programming blocks
  // (25 Days of Christmas, a Disney-Channel-style weekly movie premiere,
  // Saturday morning cartoons, an AMC-style marathon) — picking one is
  // "point it at a folder," not hand-configuring trigger/mode/dates first.
  const BLOCK_PRESETS = [
    { label: '25 DAYS OF CHRISTMAS', build: () => {
      const b = freshBlock('dateRange');
      b.name = '25 Days of Christmas';
      b.trigger.startMonth = 12; b.trigger.startDay = 1; b.trigger.endMonth = 12; b.trigger.endDay = 25;
      b.mode = 'daily';
      return b;
    } },
    { label: 'WEEKLY MOVIE NIGHT', build: () => {
      const b = freshBlock('dayOfWeek');
      b.name = 'Weekly Movie Night';
      b.trigger.days = [5]; b.trigger.startHour = 20; b.trigger.endHour = 22;
      b.mode = 'weekly';
      return b;
    } },
    { label: 'SATURDAY MORNING CARTOONS', build: () => {
      const b = freshBlock('dayOfWeek');
      b.name = 'Saturday Morning Cartoons';
      b.trigger.days = [6]; b.trigger.startHour = 8; b.trigger.endHour = 12;
      return b;
    } },
    { label: 'WEEKDAY AFTERSCHOOL', build: () => {
      const b = freshBlock('dayOfWeek');
      b.name = 'Weekday Afterschool';
      b.trigger.days = [1, 2, 3, 4, 5]; b.trigger.startHour = 15; b.trigger.endHour = 18;
      return b;
    } },
    { label: 'MOVIE MARATHON', build: () => {
      const b = freshBlock('dateRange');
      b.name = 'Movie Marathon';
      b.mode = 'marathon';
      return b;
    } },
    { label: 'BLANK — TIME BLOCK', build: () => freshBlock('dayOfWeek') },
    { label: 'BLANK — DATE RANGE', build: () => freshBlock('dateRange') },
  ];

  const addWrap = document.createElement('div');
  addWrap.className = 'block-add-menu';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn';
  addBtn.textContent = '+ ADD BLOCK ▾';
  const addMenu = document.createElement('div');
  addMenu.className = 'block-add-menu-list hidden';
  BLOCK_PRESETS.forEach((preset) => {
    const item = document.createElement('button');
    item.className = 'btn block-add-menu-item';
    item.textContent = preset.label;
    item.addEventListener('click', () => {
      if (!ch.blocks) ch.blocks = [];
      ch.blocks.push(preset.build());
      addMenu.classList.add('hidden');
      renderBlocks();
    });
    addMenu.appendChild(item);
  });
  addBtn.addEventListener('click', () => addMenu.classList.toggle('hidden'));
  addWrap.appendChild(addBtn);
  addWrap.appendChild(addMenu);

  renderBlocks();
  panelEl.appendChild(list);
  panelEl.appendChild(addWrap);
}

// Unified SCHEDULE tab — a TIMELINE/BLOCKS/CALENDAR view toggle over
// buildTimelinePanel/buildSchedulePanel/buildCalendarPanel instead of
// separate channel-EDIT tabs. TIMELINE is first since it's the natural
// starting point (build the standing weekly lineup, then fine-tune specific
// dates in CALENDAR). Jumping from a timeline cell or calendar day into
// "EDIT BLOCK" switches the toggle back to BLOCKS and flashes the matching
// card, mirroring what the old cross-tab jump did.
export function buildUnifiedSchedulePanel(ch, panelEl) {
  panelEl.innerHTML = '';

  const viewToggle = document.createElement('div');
  viewToggle.className = 'edit-tab-bar schedule-view-toggle';
  const timelineBtn = document.createElement('button');
  timelineBtn.className = 'btn edit-tab-btn';
  timelineBtn.textContent = 'TIMELINE';
  timelineBtn.setAttribute('role', 'tab');
  const blocksBtn = document.createElement('button');
  blocksBtn.className = 'btn edit-tab-btn';
  blocksBtn.textContent = 'BLOCKS';
  blocksBtn.setAttribute('role', 'tab');
  const calendarBtn = document.createElement('button');
  calendarBtn.className = 'btn edit-tab-btn';
  calendarBtn.textContent = 'CALENDAR';
  calendarBtn.setAttribute('role', 'tab');
  viewToggle.appendChild(timelineBtn);
  viewToggle.appendChild(blocksBtn);
  viewToggle.appendChild(calendarBtn);

  const body = document.createElement('div');
  panelEl.appendChild(viewToggle);
  panelEl.appendChild(body);

  let activeView = 'timeline';

  function jumpToBlock(block) {
    activeView = 'blocks';
    renderView();
    const target = body.querySelector(`[data-block-id="${block.id}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('block-row-flash');
      setTimeout(() => target.classList.remove('block-row-flash'), 1500);
    }
  }

  function renderView() {
    timelineBtn.classList.toggle('active', activeView === 'timeline');
    blocksBtn.classList.toggle('active', activeView === 'blocks');
    calendarBtn.classList.toggle('active', activeView === 'calendar');
    timelineBtn.setAttribute('aria-selected', String(activeView === 'timeline'));
    blocksBtn.setAttribute('aria-selected', String(activeView === 'blocks'));
    calendarBtn.setAttribute('aria-selected', String(activeView === 'calendar'));
    body.innerHTML = '';
    if (activeView === 'timeline') {
      buildTimelinePanel(ch, body, { onEditBlock: jumpToBlock });
    } else if (activeView === 'blocks') {
      buildSchedulePanel(ch, body);
    } else {
      buildCalendarPanel([ch], body, { onEditBlock: jumpToBlock });
    }
  }

  timelineBtn.addEventListener('click', () => { activeView = 'timeline'; renderView(); });
  blocksBtn.addEventListener('click', () => { activeView = 'blocks'; renderView(); });
  calendarBtn.addEventListener('click', () => { activeView = 'calendar'; renderView(); });

  renderView();
}
