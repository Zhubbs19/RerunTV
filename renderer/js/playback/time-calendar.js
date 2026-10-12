// The time machine's calendar: pick any date and time and jump there. Opened with
// D on live TV, from the TV menu (TIME MACHINE › PICK A DATE…), and from a
// channel's PREVIEW in setup. Days that have a dateRange block on this channel
// carry a dot (a December countdown, a Thanksgiving weekend…), and the footer
// says what would be airing at the chosen moment, so you can see where you are
// jumping before you go.
//
// Keys (desktop): arrows move a day / week, PageUp/PageDown a month (with Shift a
// year), Home goes to today, [ ] change the hour, 1-7 pick a time of day, Enter
// goes, Esc closes. In TV mode the D-pad moves focus by position instead, and OK
// presses the focused day or button (ui/dialog.js's ModalSurface).
import { ModalSurface } from '../ui/dialog.js';
import { h, isTvMode } from '../ui/kit-core.js';
import { getChannel } from '../core/channels.js';
import { computeSourcePosition, dateBlocksOn, resolveActiveSource } from '../core/schedule.js';
import { MONTHS, S, WEEKDAYS, viewNow } from '../core/state.js';
import { getDisplayTitle } from '../core/util.js';
import {
  TIME_PRESETS, dateFromMs, dateTimeToMs, hourLabel, monthGrid, sameDate, shiftDays, shiftMonths, shiftYears,
} from '../timeline/calendar-grid.js';
import { timeMachineAvailable, timeMachineGoTo } from './timemachine.js';

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

let surface = null;

export function isTimeCalendarOpen() {
  return !!surface && surface.isOpen();
}

export function closeTimeCalendar() {
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
  const needsTimeMachine = options.needsTimeMachine !== false;
  const usable = !!ch && (!needsTimeMachine || S.timeMachineOn || timeMachineAvailable());
  const startMs = Number.isFinite(options.startMs) ? options.startMs : viewNow();
  const onGo = options.onGo || ((ms, label) => timeMachineGoTo(ms, label, { play: true }));

  let cursor = dateFromMs(startMs);
  let hour = new Date(startMs).getHours();
  const realToday = dateFromMs(Date.now()); // the wall-clock "today" marker, not the viewed time

  surface = ModalSurface({ className: 'time-calendar', label: 'Time machine calendar', onCancel: closeTimeCalendar });
  const root = surface.el;
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeTimeCalendar(); });

  function go() {
    if (!usable) { closeTimeCalendar(); return; }
    const ms = dateTimeToMs(cursor, hour, 0);
    const label = `${dayLabel(cursor)} ${hourLabel(hour)}`;
    closeTimeCalendar();
    onGo(ms, label);
  }

  function setCursor(date) {
    cursor = date;
    render(true);
  }

  function render(keepFocus) {
    const focusKey = keepFocus && document.activeElement && root.contains(document.activeElement)
      ? document.activeElement.dataset.focusKey : null;
    root.textContent = '';
    const box = h('div', { className: 'time-calendar-box' });
    box.appendChild(h('div', { className: 'time-calendar-title', text: options.title || 'TIME MACHINE · GO TO A DATE' }));

    if (!usable) {
      box.appendChild(h('div', { className: 'time-calendar-note', text: ch ? 'TURN ON THE TIME MACHINE IN BOX SETTINGS TO USE THE CALENDAR.' : 'TUNE A CHANNEL FIRST.' }));
      box.appendChild(h('div', { className: 'time-calendar-actions' }, h('button', { className: 'btn time-calendar-btn', text: 'CLOSE', on: { click: closeTimeCalendar } })));
      root.appendChild(box);
      return;
    }

    // Month and year navigation.
    const nav = (label, key, fn) => h('button', { className: 'btn time-calendar-nav', text: label, attrs: { 'aria-label': key }, dataset: { focusKey: `nav-${key}` }, on: { click: fn } });
    box.appendChild(h('div', { className: 'time-calendar-head' },
      nav('«', 'previous year', () => setCursor(shiftYears(cursor, -1))),
      nav('‹', 'previous month', () => setCursor(shiftMonths(cursor, -1))),
      h('div', { className: 'time-calendar-month', text: `${MONTH_NAMES[cursor.month]} ${cursor.year}` }),
      nav('›', 'next month', () => setCursor(shiftMonths(cursor, 1))),
      nav('»', 'next year', () => setCursor(shiftYears(cursor, 1))),
      h('button', { className: 'btn time-calendar-nav time-calendar-today', text: 'TODAY', dataset: { focusKey: 'today' }, on: { click: () => setCursor(realToday) } })));

    const weekdays = h('div', { className: 'time-calendar-weekdays' });
    WEEKDAYS.forEach((w) => weekdays.appendChild(h('div', { text: w.slice(0, 2) })));
    box.appendChild(weekdays);

    const viewed = dateFromMs(viewNow());
    const grid = h('div', { className: 'time-calendar-grid', attrs: { role: 'grid' } });
    monthGrid(cursor.year, cursor.month).forEach((week) => week.forEach((cell) => {
      const noon = new Date(cell.year, cell.month, cell.day, 12).getTime();
      const marked = dateBlocksOn(ch, noon).length > 0;
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
    box.appendChild(grid);

    // Time of day.
    const times = h('div', { className: 'time-calendar-times' });
    TIME_PRESETS.forEach((p, i) => times.appendChild(h('button', {
      className: `btn time-calendar-time${hour === p.hour ? ' is-selected' : ''}`, text: p.label, attrs: { title: `Press ${i + 1}` }, dataset: { focusKey: `t-${p.hour}` },
      on: { click: () => { hour = p.hour; render(true); } },
    })));
    box.appendChild(times);
    box.appendChild(h('div', { className: 'time-calendar-hour' },
      h('button', { className: 'btn time-calendar-nav', text: '−1 H', dataset: { focusKey: 'hour-down' }, on: { click: () => { hour = (hour + 23) % 24; render(true); } } }),
      h('div', { className: 'time-calendar-hour-label', text: hourLabel(hour) }),
      h('button', { className: 'btn time-calendar-nav', text: '+1 H', dataset: { focusKey: 'hour-up' }, on: { click: () => { hour = (hour + 1) % 24; render(true); } } })));

    // What is there.
    const ms = dateTimeToMs(cursor, hour, 0);
    const blocks = dateBlocksOn(ch, new Date(cursor.year, cursor.month, cursor.day, 12).getTime());
    const airing = airingAt(ch, ms);
    const info = h('div', { className: 'time-calendar-info' },
      h('div', { className: 'time-calendar-when', text: `${dayLabel(cursor)} · ${hourLabel(hour)}` }),
      h('div', { className: 'time-calendar-airing', text: `AIRING: ${airing.title}` }));
    if (blocks.length) {
      const names = blocks.slice(0, 2).map((b) => (b.name && b.name.trim()) || 'DATE BLOCK');
      info.appendChild(h('div', { className: 'time-calendar-blocks', text: `BLOCK: ${names.join(' · ')}${blocks.length > 2 ? ` +${blocks.length - 2}` : ''}` }));
    }
    box.appendChild(info);

    box.appendChild(h('div', { className: 'time-calendar-actions' },
      h('button', { className: 'btn time-calendar-btn time-calendar-go', text: options.goText || 'GO', dataset: { focusKey: 'go' }, on: { click: go } }),
      h('button', { className: 'btn time-calendar-btn', text: 'CANCEL', dataset: { focusKey: 'cancel' }, on: { click: closeTimeCalendar } })));
    box.appendChild(h('div', { className: 'time-calendar-hint', text: '← → ↑ ↓ DAY   PAGE UP/DOWN MONTH   [ ] HOUR   HOME TODAY   ENTER GO' }));
    root.appendChild(box);

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
    if (e.key === '[') { consume(); hour = (hour + 23) % 24; render(true); return; }
    if (e.key === ']') { consume(); hour = (hour + 1) % 24; render(true); return; }
    if (e.key >= '1' && e.key <= String(TIME_PRESETS.length)) { consume(); hour = TIME_PRESETS[Number(e.key) - 1].hour; render(true); return; }
    if (tv) return; // the D-pad moves focus by position there
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) { consume(); setCursor(shiftDays(cursor, step)); }
  });

  render(false);
  surface.open({ initialFocus: false });
  const selected = root.querySelector('.time-calendar-day.is-selected') || root.querySelector('button');
  if (selected) selected.focus({ preventScroll: true });
}
