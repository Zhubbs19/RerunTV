// The time machine's calendar: pick any date and time and jump there. Opened with
// D on live TV, from the TV menu (TIME MACHINE › PICK A DATE…), and from a
// channel's PREVIEW in setup. Days that have a dateRange block on this channel
// carry a dot (a December countdown, a Thanksgiving weekend…).
//
// It fills most of the screen: the month and the time on the left, and on the
// right that day's whole schedule for a channel (‹ › steps through channels
// when it was opened from live TV), with special programming named at the top
// and tagged on its rows. Picking a row sets the time to that program's start,
// so you can see exactly where you are jumping before you go.
//
// Keys (desktop): arrows move a day / week, PageUp/PageDown a month (with Shift a
// year), Home goes to today, [ ] change the hour, 1-7 pick a time of day, Enter
// goes, Esc closes. In TV mode the D-pad moves focus by position instead, and OK
// presses the focused day or button (ui/dialog.js's ModalSurface).
import { ModalSurface } from '../ui/dialog.js';
import { h, isTvMode } from '../ui/kit-core.js';
import { formatChannelNumber, getChannel, sortedChannels } from '../core/channels.js';
import { computeSourcePosition, dateBlocksOn, getChannelSchedule, resolveActiveSource } from '../core/schedule.js';
import { MONTHS, S, WEEKDAYS, viewNow } from '../core/state.js';
import { formatSlotLabel, getDisplayTitle, guessSeriesName } from '../core/util.js';
import { channelCallLetters, mergeMicroPrograms, runSeriesName } from '../guide/model.js';
import {
  TIME_PRESETS, dateFromMs, dateTimeToMs, hourLabel, monthGrid, sameDate, shiftDays, shiftMonths, shiftYears,
} from '../timeline/calendar-grid.js';
import { timeMachineAvailable, timeMachineGoTo } from './timemachine.js';
import { wholeRows } from '../cable-guide/page.js';
import { currentUiMode } from '../cable-guide/mode.js';
import { CABLE_GUIDE_UI } from '../cable-guide/model.js';

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

let surface = null;
// The day list's whole-row fit on the cable-guide layout (page.js wholeRows);
// the list is rebuilt on every step, so the previous fit is stopped first.
let stopDayRows = () => {};

export function isTimeCalendarOpen() {
  return !!surface && surface.isOpen();
}

export function closeTimeCalendar() {
  stopDayRows();
  if (surface) surface.close();
  surface = null;
}

function airingAt(ch, ms) {
  try {
    const source = resolveActiveSource(ch, ms);
    const pos = computeSourcePosition(source, ms, { ignoreContentLost: true });
    if (!pos) return { title: '—', block: source && source.block ? source.block.name : '' };
    return { title: getDisplayTitle(pos.file), block: source.block ? source.block.name : '' };
  } catch (e) {
    return { title: '—', block: '' };
  }
}

// One day of a channel's schedule as rows: programs, with runs of shorts
// merged the way the guide merges them, so a day of videos stays readable.
const DAY_MS = 24 * 3600000;
const SHORT_MS = 5 * 60000;
function dayRows(ch, date) {
  const start = new Date(date.year, date.month, date.day).getTime();
  const end = new Date(date.year, date.month, date.day + 1).getTime();
  // A wide window: entries are clipped to the one asked for, and a program
  // that began the evening before should show its real start.
  const entries = getChannelSchedule(ch, start - DAY_MS / 4, end).filter((e) => e.end > start);
  return mergeMicroPrograms(entries, SHORT_MS).map((cell) => {
    if (cell.kind === 'run') {
      const series = runSeriesName(cell.items, guessSeriesName);
      return { start: cell.start, end: cell.end, title: `${series || 'Shorts & bumpers'} (${cell.items.length})`, block: null, special: false };
    }
    const block = cell.entry.block || null;
    const special = !!(block && block.trigger && block.trigger.type === 'dateRange');
    return { start: cell.start, end: cell.end, title: getDisplayTitle(cell.entry.file), block, special };
  });
}

function blockName(block) {
  return (block && block.name && block.name.trim()) || 'Special programming';
}

function clockLabel(hour, minute) {
  if (!minute) return hourLabel(hour);
  const h12 = hour % 12 || 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function dayLabel(date) {
  const wd = WEEKDAYS[new Date(date.year, date.month, date.day).getDay()].slice(0, 3);
  return `${wd} ${MONTHS[date.month]} ${date.day}, ${date.year}`;
}

// openTimeCalendar({ channel, startMs, label, onGo, needsTimeMachine })
//   channel           the channel whose blocks and schedule to show (default: the tuned one)
//   startMs           the moment to start on (default: the viewed time)
//   onGo(ms, label)   what GO does (default: jump the time machine there)
//   needsTimeMachine  false for setup's PREVIEW, which does not need the time machine switched on
export function openTimeCalendar(options = {}) {
  if (isTimeCalendarOpen()) { closeTimeCalendar(); return; }
  const ch = options.channel || getChannel(S.currentNumber);
  // From live TV the day view can look at any channel; setup's PREVIEW is about one.
  const canSwitch = !options.channel;
  let viewCh = ch;
  const needsTimeMachine = options.needsTimeMachine !== false;
  const usable = !!ch && (!needsTimeMachine || S.timeMachineOn || timeMachineAvailable());
  const startMs = Number.isFinite(options.startMs) ? options.startMs : viewNow();
  const onGo = options.onGo || ((ms, label) => timeMachineGoTo(ms, label, { play: true }));

  let cursor = dateFromMs(startMs);
  let hour = new Date(startMs).getHours();
  let minute = 0;
  // A picked program's exact start (programs rarely start on the minute);
  // anything else that moves the day or time drops it.
  let exactMs = null;
  const setHour = (h) => { hour = h; minute = 0; exactMs = null; };
  const chosenMs = () => (exactMs != null ? exactMs : dateTimeToMs(cursor, hour, minute));
  const realToday = dateFromMs(Date.now()); // the wall-clock "today" marker, not the viewed time

  surface = ModalSurface({ className: 'time-calendar', label: 'Time machine calendar', onCancel: closeTimeCalendar });
  const root = surface.el;
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeTimeCalendar(); });

  function go() {
    if (!usable) { closeTimeCalendar(); return; }
    const ms = chosenMs();
    const label = `${dayLabel(cursor)} ${clockLabel(hour, minute)}`;
    const target = viewCh;
    closeTimeCalendar();
    onGo(ms, label);
    // Looking at another channel's day and going there tunes to it too.
    if (canSwitch && target && ch && target.number !== ch.number) {
      import('./core.js').then((core) => core.tuneToChannel(target.number)).catch(() => {});
    }
  }

  function stepChannel(delta) {
    const list = sortedChannels();
    if (!list.length || !viewCh) return;
    const at = list.findIndex((c) => c.number === viewCh.number);
    viewCh = list[(at + delta + list.length) % list.length];
    render(true);
  }

  // The right column: the chosen day on one channel, start to end.
  function dayView() {
    const view = h('div', { className: 'time-calendar-dayview' });
    const name = `${formatChannelNumber(viewCh.number)} ${channelCallLetters(viewCh) || viewCh.name || ''}`.trim();
    view.appendChild(h('div', { className: 'time-calendar-chan' },
      canSwitch ? h('button', { className: 'btn time-calendar-nav', text: '‹', attrs: { 'aria-label': 'previous channel' }, dataset: { focusKey: 'ch-prev' }, on: { click: () => stepChannel(-1) } }) : null,
      h('div', { className: 'time-calendar-chan-name' },
        h('span', { text: name }),
        h('span', { className: 'time-calendar-chan-day', text: dayLabel(cursor) })),
      canSwitch ? h('button', { className: 'btn time-calendar-nav', text: '›', attrs: { 'aria-label': 'next channel' }, dataset: { focusKey: 'ch-next' }, on: { click: () => stepChannel(1) } }) : null));

    const noon = new Date(cursor.year, cursor.month, cursor.day, 12).getTime();
    const specials = dateBlocksOn(viewCh, noon);
    if (specials.length) {
      view.appendChild(h('div', { className: 'time-calendar-special', text: `SPECIAL PROGRAMMING: ${specials.map(blockName).join(' · ')}` }));
    }

    const at = chosenMs();
    const list = h('div', { className: 'time-calendar-programs', attrs: { role: 'list' } });
    const rows = dayRows(viewCh, cursor);
    if (!rows.length) list.appendChild(h('div', { className: 'time-calendar-empty', text: 'Nothing scheduled on this day.' }));
    rows.forEach((row) => {
      const current = at >= row.start && at < row.end;
      const classes = ['time-calendar-program'];
      if (current) classes.push('is-current');
      if (row.special) classes.push('is-special');
      list.appendChild(h('button', {
        className: classes.join(' '),
        dataset: { focusKey: `p-${row.start}` },
        attrs: { role: 'listitem', 'aria-current': current ? 'true' : 'false' },
        on: {
          click: () => {
            const d = new Date(row.start);
            cursor = dateFromMs(row.start);
            hour = d.getHours();
            minute = d.getMinutes();
            exactMs = row.start;
            render(true);
          },
          dblclick: go,
        },
      },
      h('span', { className: 'time-calendar-program-time', text: formatSlotLabel(row.start) }),
      h('span', { className: 'time-calendar-program-title', text: row.title }),
      row.block ? h('span', { className: 'time-calendar-program-tag', text: blockName(row.block) }) : null));
    });
    view.appendChild(list);
    stopDayRows();
    stopDayRows = wholeRows(list, () => currentUiMode() === CABLE_GUIDE_UI);
    return view;
  }

  function setCursor(date) {
    cursor = date;
    exactMs = null;
    render(true);
  }

  function render(keepFocus) {
    const focusKey = keepFocus && document.activeElement && root.contains(document.activeElement)
      ? document.activeElement.dataset.focusKey : null;
    root.textContent = '';
    const box = h('div', { className: 'time-calendar-box' });
    box.appendChild(h('div', { className: 'time-calendar-title', text: options.title || 'TIME MACHINE · GO TO A DATE' }));
    // The left column: month and time. Then the day view on the right.
    const pick = h('div', { className: 'time-calendar-pick' });

    if (!usable) {
      box.appendChild(h('div', { className: 'time-calendar-note', text: ch ? 'TURN ON THE TIME MACHINE IN BOX SETTINGS TO USE THE CALENDAR.' : 'TUNE A CHANNEL FIRST.' }));
      box.appendChild(h('div', { className: 'time-calendar-actions' }, h('button', { className: 'btn time-calendar-btn', text: 'CLOSE', on: { click: closeTimeCalendar } })));
      root.appendChild(box);
      return;
    }

    // Month and year navigation.
    const nav = (label, key, fn) => h('button', { className: 'btn time-calendar-nav', text: label, attrs: { 'aria-label': key }, dataset: { focusKey: `nav-${key}` }, on: { click: fn } });
    pick.appendChild(h('div', { className: 'time-calendar-head' },
      nav('«', 'previous year', () => setCursor(shiftYears(cursor, -1))),
      nav('‹', 'previous month', () => setCursor(shiftMonths(cursor, -1))),
      h('div', { className: 'time-calendar-month', text: `${MONTH_NAMES[cursor.month]} ${cursor.year}` }),
      nav('›', 'next month', () => setCursor(shiftMonths(cursor, 1))),
      nav('»', 'next year', () => setCursor(shiftYears(cursor, 1))),
      h('button', { className: 'btn time-calendar-nav time-calendar-today', text: 'TODAY', dataset: { focusKey: 'today' }, on: { click: () => setCursor(realToday) } })));

    const weekdays = h('div', { className: 'time-calendar-weekdays' });
    WEEKDAYS.forEach((w) => weekdays.appendChild(h('div', { text: w.slice(0, 2) })));
    pick.appendChild(weekdays);

    const viewed = dateFromMs(viewNow());
    const grid = h('div', { className: 'time-calendar-grid', attrs: { role: 'grid' } });
    monthGrid(cursor.year, cursor.month).forEach((week) => week.forEach((cell) => {
      const noon = new Date(cell.year, cell.month, cell.day, 12).getTime();
      const marked = dateBlocksOn(viewCh, noon).length > 0;
      const classes = ['time-calendar-day'];
      if (!cell.inMonth) classes.push('is-outside');
      if (marked) classes.push('has-block');
      if (sameDate(cell, realToday)) classes.push('is-today');
      if (sameDate(cell, viewed)) classes.push('is-viewed');
      if (sameDate(cell, cursor)) classes.push('is-selected');
      const key = `d-${cell.year}-${cell.month}-${cell.day}`;
      grid.appendChild(h('button', {
        className: classes.join(' '),
        text: String(cell.day),
        dataset: { focusKey: key },
        attrs: { 'aria-label': dayLabel(cell) + (marked ? ', has a scheduled block' : ''), 'aria-pressed': sameDate(cell, cursor) ? 'true' : 'false', tabindex: sameDate(cell, cursor) ? '0' : '-1' },
        on: { click: () => setCursor({ year: cell.year, month: cell.month, day: cell.day }), dblclick: go },
      }));
    }));
    pick.appendChild(grid);

    // Time of day.
    const times = h('div', { className: 'time-calendar-times' });
    TIME_PRESETS.forEach((p, i) => times.appendChild(h('button', {
      className: `btn time-calendar-time${hour === p.hour ? ' is-selected' : ''}`, text: p.label, attrs: { title: `Press ${i + 1}` }, dataset: { focusKey: `t-${p.hour}` },
      on: { click: () => { setHour(p.hour); render(true); } },
    })));
    pick.appendChild(times);
    pick.appendChild(h('div', { className: 'time-calendar-hour' },
      h('button', { className: 'btn time-calendar-nav', text: '−1 H', dataset: { focusKey: 'hour-down' }, on: { click: () => { setHour((hour + 23) % 24); render(true); } } }),
      h('div', { className: 'time-calendar-hour-label', text: clockLabel(hour, minute) }),
      h('button', { className: 'btn time-calendar-nav', text: '+1 H', dataset: { focusKey: 'hour-up' }, on: { click: () => { setHour((hour + 1) % 24); render(true); } } })));
    box.appendChild(pick);
    box.appendChild(dayView());

    // What is there.
    const ms = chosenMs();
    const airing = airingAt(viewCh, ms);
    box.appendChild(h('div', { className: 'time-calendar-info' },
      h('div', { className: 'time-calendar-when', text: `${dayLabel(cursor)} · ${clockLabel(hour, minute)} · CH ${formatChannelNumber(viewCh.number)}` }),
      h('div', { className: 'time-calendar-airing', text: `AIRING: ${airing.title}${airing.block ? `  (${airing.block})` : ''}` })));

    box.appendChild(h('div', { className: 'time-calendar-actions' },
      h('button', { className: 'btn time-calendar-btn time-calendar-go', text: options.goText || 'GO', dataset: { focusKey: 'go' }, on: { click: go } }),
      h('button', { className: 'btn time-calendar-btn', text: 'CANCEL', dataset: { focusKey: 'cancel' }, on: { click: closeTimeCalendar } })));
    box.appendChild(h('div', { className: 'time-calendar-hint', text: `← → ↑ ↓ DAY   PAGE UP/DOWN MONTH   [ ] HOUR${canSwitch ? '   , . CHANNEL' : ''}   HOME TODAY   ENTER GO` }));
    root.appendChild(box);

    const current = root.querySelector('.time-calendar-program.is-current');
    if (current) current.scrollIntoView({ block: 'center' });
    const target = (focusKey && root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)) || root.querySelector('.time-calendar-day.is-selected');
    if (target && keepFocus) target.focus({ preventScroll: true });
  }

  root.addEventListener('keydown', (e) => {
    const tv = isTvMode();
    const consume = () => { e.preventDefault(); e.stopPropagation(); };
    // On a desktop every key stays inside the calendar while it is open. In TV
    // mode the D-pad, OK and Back must still reach the remote router
    // (tv/input.js moves focus by position), so only the keys used here are taken.
    if (!tv) e.stopPropagation();
    if (e.key === 'Escape') { consume(); closeTimeCalendar(); return; }
    if (!usable) return;
    // Enter goes from a day or a time button too (picking and going in one keystroke);
    // on a navigation or action button it presses that button as usual.
    const onButton = e.target && e.target.tagName === 'BUTTON'
      && (e.target.classList.contains('time-calendar-nav') || e.target.classList.contains('time-calendar-btn'));
    if (e.key === 'Enter' && !onButton && !tv) { consume(); go(); return; }
    if (e.key === 'PageUp') { consume(); setCursor(e.shiftKey ? shiftYears(cursor, -1) : shiftMonths(cursor, -1)); return; }
    if (e.key === 'PageDown') { consume(); setCursor(e.shiftKey ? shiftYears(cursor, 1) : shiftMonths(cursor, 1)); return; }
    if (e.key === 'Home') { consume(); setCursor(realToday); return; }
    if (e.key === '[') { consume(); setHour((hour + 23) % 24); render(true); return; }
    if (e.key === ']') { consume(); setHour((hour + 1) % 24); render(true); return; }
    if (canSwitch && (e.key === ',' || e.key === '.')) { consume(); stepChannel(e.key === ',' ? -1 : 1); return; }
    if (e.key >= '1' && e.key <= String(TIME_PRESETS.length)) { consume(); setHour(TIME_PRESETS[Number(e.key) - 1].hour); render(true); return; }
    if (tv) return; // the D-pad moves focus by position there
    // In the day's list ▲▼ move between programs.
    const row = e.target && e.target.closest && e.target.closest('.time-calendar-program');
    if (row && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      consume();
      const next = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
      if (next) next.focus();
      return;
    }
    if (row && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) { consume(); setCursor(shiftDays(cursor, step)); }
  });

  render(false);
  surface.open({ initialFocus: false });
  // Only now does the list have a height to scroll the chosen program into.
  const current = root.querySelector('.time-calendar-program.is-current');
  if (current) current.scrollIntoView({ block: 'center' });
  const selected = root.querySelector('.time-calendar-day.is-selected') || root.querySelector('button');
  if (selected) selected.focus({ preventScroll: true });
}
