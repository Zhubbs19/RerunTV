// A channel's schedule CALENDAR as the box reports it (GET /api/calendar,
// plugins/companion-app/control-routes.js), and the pure helpers the
// CALENDAR and BLOCK screens use. No React Native imports, so node tests
// cover it.

export interface DateRangeTrigger {
  type: 'dateRange';
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
  startRule?: 'thanksgiving';
  startHour?: number;
  endHour?: number;
  days?: number[];
}

export interface WeeklyTrigger {
  type: 'dayOfWeek';
  startHour: number;
  endHour: number;
  days: number[];
}

export type Trigger = DateRangeTrigger | WeeklyTrigger;

export interface DayOverride {
  file: string | null;
  title: string;
  unlockTime: string;
  skip: boolean;
  note: string;
}

export interface CalendarBlock {
  id: string;
  name: string;
  trigger: Trigger | null;
  priority: number;
  mode: 'loop' | 'daily' | 'weekly';
  folder: string | null;
  fileCount: number;
  files: { path: string; title: string }[];
  dayOverrides: Record<string, DayOverride>;
}

export interface CalendarDay {
  day: number;
  key: string;
  weekday: number;
  label: string;
  color: string | null;
  blockId: string | null;
  overlaps: { id: string; label: string }[];
  emptyBlocks: { id: string; label: string }[];
  isDaily: boolean;
  override: DayOverride | null;
  atNoon: string | null;
}

export interface CalendarMonth {
  year: number;
  month: number;
  today: { year: number; month: number; day: number };
  days: CalendarDay[];
  labels: Record<string, string>;
  colors: Record<string, string>;
  scans: Record<string, { state: 'scanning' | 'done' | 'failed'; text: string }>;
}

export interface CalendarView {
  channel: { number: number; name: string };
  revision: number;
  blocks: CalendarBlock[];
  /** Null on a box with no screen running: blocks are still editable. */
  month: CalendarMonth | null;
}

export type CalendarOp =
  | { op: 'create'; fields: BlockFields & { trigger: Trigger } }
  | { op: 'update'; id: string; fields: BlockFields }
  | { op: 'remove'; id: string }
  | { op: 'overrideDay'; id: string; key: string; override: DayOverride | null };

export interface BlockFields {
  name?: string;
  trigger?: Trigger;
  priority?: number;
  mode?: 'loop' | 'daily' | 'weekly';
}

export const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Checks a reply looks like a calendar view.
 * @param value The parsed reply.
 * @returns True when it has a channel, a revision and a block list.
 */
export function isCalendarView(value: unknown): value is CalendarView {
  const v = value as CalendarView | null;
  return !!v && typeof v === 'object' && !!v.channel && Number.isInteger(v.revision) && Array.isArray(v.blocks);
}

/**
 * The weeks of a month for a Sunday-first grid.
 * @param year The year.
 * @param month The month, 1–12.
 * @returns Rows of seven cells: a day number, or null for a cell outside the month.
 */
export function monthGrid(year: number, month: number): (number | null)[][] {
  const first = new Date(year, month - 1, 1).getDay();
  const days = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

/**
 * The month before or after.
 * @param year The year.
 * @param month The month, 1–12.
 * @param delta Months to move (negative is back).
 * @returns The new `{ year, month }`.
 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12 + 12) % 12 + 1 };
}

/**
 * The MM-DD key the box uses for a day's override.
 * @param month The month, 1–12.
 * @param day The day of the month.
 * @returns e.g. "12-05".
 */
export function dayKey(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * An hour as the box writes it.
 * @param hour 0–23.
 * @returns e.g. "08:00".
 */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * Weekdays as two-letter names.
 * @param days 0 = Sunday.
 * @returns e.g. "MO WE FR", or "EVERY DAY" for none or all.
 */
export function daysLabel(days: number[] | undefined): string {
  const list = [...new Set(days ?? [])].sort((a, b) => a - b);
  if (!list.length || list.length === 7) return 'EVERY DAY';
  return list.map((d) => WEEKDAYS[d].slice(0, 2)).join(' ');
}

/**
 * A block's trigger in words, the way the box's calendar names an unnamed block.
 * @param trigger The trigger.
 * @returns The description.
 */
export function describeTrigger(trigger: Trigger | null): string {
  if (!trigger) return 'NO TRIGGER';
  if (trigger.type === 'dateRange') {
    const start = trigger.startRule === 'thanksgiving' ? 'THANKSGIVING' : `${trigger.startMonth}/${trigger.startDay}`;
    let text = `${start}–${trigger.endMonth}/${trigger.endDay}`;
    if (trigger.startHour != null && trigger.endHour != null) text += `, ${hourLabel(trigger.startHour)}–${hourLabel(trigger.endHour)}`;
    if (trigger.days && trigger.days.length) text += `, ${daysLabel(trigger.days)}`;
    return text;
  }
  return `${hourLabel(trigger.startHour)}–${hourLabel(trigger.endHour)}, ${daysLabel(trigger.days)}`;
}

/**
 * A block's name, or its trigger when it has none.
 * @param block The block.
 * @returns The label.
 */
export function blockTitle(block: Pick<CalendarBlock, 'name' | 'trigger'>): string {
  return block.name.trim() ? block.name.trim().toUpperCase() : describeTrigger(block.trigger);
}

/**
 * A one-day date-range trigger, for + ADD BLOCK on a calendar day.
 * @param month The month, 1–12.
 * @param day The day.
 * @returns The trigger.
 */
export function oneDayTrigger(month: number, day: number): DateRangeTrigger {
  return { type: 'dateRange', startMonth: month, startDay: day, endMonth: month, endDay: day };
}

/**
 * A weekly trigger for + NEW WEEKLY BLOCK (8 PM to 11 PM, every day).
 * @returns The trigger.
 */
export function defaultWeeklyTrigger(): WeeklyTrigger {
  return { type: 'dayOfWeek', startHour: 20, endHour: 23, days: [] };
}

/**
 * An empty day override, the same fields the box's own editor starts with.
 * @returns The override.
 */
export function blankOverride(): DayOverride {
  return { file: null, title: '', unlockTime: '', skip: false, note: '' };
}

/**
 * Switches a trigger between a date range and a weekly time, keeping what carries over.
 * @param trigger The current trigger.
 * @param type The kind wanted.
 * @param today Used for a new date range's dates.
 * @returns The new trigger.
 */
export function convertTrigger(trigger: Trigger | null, type: Trigger['type'], today: { month: number; day: number }): Trigger {
  if (trigger && trigger.type === type) return trigger;
  if (type === 'dayOfWeek') {
    const hours = trigger && trigger.startHour != null && trigger.endHour != null ? { startHour: trigger.startHour, endHour: trigger.endHour } : { startHour: 20, endHour: 23 };
    return { type: 'dayOfWeek', ...hours, days: trigger?.days ?? [] };
  }
  return oneDayTrigger(today.month, today.day);
}

/**
 * Clamps a day of the month to what a month can have (Feb 30 becomes Feb 29).
 * The box reads Feb 29 in a non-leap year the same way it always has.
 * @param month The month, 1–12.
 * @param day The day.
 * @returns The day, 1 to the month's longest length.
 */
export function clampDay(month: number, day: number): number {
  const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
  return Math.min(longest, Math.max(1, day));
}

/**
 * Steps a value round a range, wrapping (hours 23 → 0, months 12 → 1).
 * @param value The current value.
 * @param delta The step.
 * @param min The smallest value.
 * @param max The largest value.
 * @returns The new value.
 */
export function wrapStep(value: number, delta: number, min: number, max: number): number {
  const span = max - min + 1;
  return ((value - min + delta) % span + span) % span + min;
}

/**
 * The fields of an edited block that differ from the saved one, for an `update` op.
 * @param saved The block as the box has it.
 * @param draft The edited copy.
 * @returns Only the changed editable fields.
 */
export function changedFields(saved: CalendarBlock, draft: CalendarBlock): BlockFields {
  const out: BlockFields = {};
  if (draft.name !== saved.name) out.name = draft.name;
  if (draft.priority !== saved.priority) out.priority = draft.priority;
  if (draft.mode !== saved.mode) out.mode = draft.mode;
  if (draft.trigger && JSON.stringify(draft.trigger) !== JSON.stringify(saved.trigger)) out.trigger = draft.trigger;
  return out;
}
