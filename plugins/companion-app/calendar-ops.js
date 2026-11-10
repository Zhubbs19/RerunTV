// ---------- Companion calendar: phone edits -> config commands ----------
// The phone edits a channel's schedule CALENDAR (its ch.blocks[], see
// renderer/js/setup/schedule.js) by sending small operations, never raw
// config commands. This file checks each one and turns it into the named
// command the box's own BLOCKS and CALENDAR editors already record
// (renderer/js/core/commands.js: block.create, block.remove,
// block.overrideDay, item.set on the `blocks` collection), so a phone edit is
// the same edit a person at the box would make. main.js hands the result to
// the config host as a remote client batch (configHost.applyCommands), which
// also runs commands.js's own validation and the remote deny-lists.
//
// Pure: no fs, no Electron, so tests/companion-control.test.js covers it.

const MODES = ['loop', 'daily', 'weekly'];
// Block fields a phone may set with `update`. folder/files come only from
// POST /api/calendar/folder, which scans the folder on the box first.
const UPDATE_FIELDS = ['name', 'trigger', 'priority', 'mode'];

/**
 * Tests for a whole number in a range.
 * @param {*} n The value.
 * @param {number} min The smallest allowed value.
 * @param {number} max The largest allowed value.
 * @returns {boolean} True when `n` is an integer from `min` to `max`.
 */
function isInt(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * Checks a weekday list (0 = Sunday).
 * @param {*} days The value.
 * @returns {?number[]} The sorted, de-duplicated days, or null when invalid.
 */
function cleanDays(days) {
  if (days == null) return [];
  if (!Array.isArray(days) || days.some((d) => !isInt(d, 0, 6))) return null;
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Checks a block trigger and rebuilds it from only the fields it may have.
 * @param {*} trigger The trigger the phone sent.
 * @returns {object} `{ trigger }` when valid, or `{ error }`.
 */
function cleanTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return { error: 'A trigger is required.' };
  const days = cleanDays(trigger.days);
  if (!days) return { error: 'Days must be weekdays 0–6.' };
  if (trigger.type === 'dayOfWeek') {
    if (!isInt(trigger.startHour, 0, 23) || !isInt(trigger.endHour, 0, 23)) return { error: 'Hours must be 0–23.' };
    return { trigger: { type: 'dayOfWeek', startHour: trigger.startHour, endHour: trigger.endHour, days } };
  }
  if (trigger.type === 'dateRange') {
    const { startMonth, startDay, endMonth, endDay } = trigger;
    if (!isInt(startMonth, 1, 12) || !isInt(endMonth, 1, 12) || !isInt(startDay, 1, 31) || !isInt(endDay, 1, 31)) {
      return { error: 'Dates need a month 1–12 and a day 1–31.' };
    }
    const out = { type: 'dateRange', startMonth, startDay, endMonth, endDay };
    if (trigger.startRule === 'thanksgiving') out.startRule = 'thanksgiving';
    // Optional narrowing inside the range (6–10 PM only, Fridays only).
    const hasHours = trigger.startHour != null || trigger.endHour != null;
    if (hasHours) {
      if (!isInt(trigger.startHour, 0, 23) || !isInt(trigger.endHour, 0, 23)) return { error: 'Hours must be 0–23.' };
      out.startHour = trigger.startHour;
      out.endHour = trigger.endHour;
    }
    if (days.length) out.days = days;
    return { trigger: out };
  }
  return { error: 'A trigger is a date range or a weekly time.' };
}

/**
 * Checks the editable block fields (name, trigger, priority, mode).
 * @param {object} fields The fields the phone sent.
 * @returns {object} `{ fields }` with the cleaned fields, or `{ error }`.
 */
function cleanFields(fields) {
  if (!fields || typeof fields !== 'object') return { error: 'Fields are required.' };
  const out = {};
  for (const key of Object.keys(fields)) {
    if (!UPDATE_FIELDS.includes(key)) return { error: `"${key}" can't be changed from the phone.` };
  }
  if ('name' in fields) {
    if (typeof fields.name !== 'string' || fields.name.length > 80) return { error: 'A name is up to 80 characters.' };
    out.name = fields.name.trim();
  }
  if ('priority' in fields) {
    if (!isInt(fields.priority, -100, 100)) return { error: 'Priority is a whole number from -100 to 100.' };
    out.priority = fields.priority;
  }
  if ('mode' in fields) {
    if (!MODES.includes(fields.mode)) return { error: 'Mode is loop, daily or weekly.' };
    out.mode = fields.mode;
  }
  if ('trigger' in fields) {
    const checked = cleanTrigger(fields.trigger);
    if (checked.error) return checked;
    out.trigger = checked.trigger;
  }
  return { fields: out };
}

/**
 * Checks one dayOverrides entry (a daily/weekly block's per-day edit).
 * @param {*} override The override the phone sent, or null to clear the day.
 * @param {string[]} filePaths The block's file paths; `file` must be one of them.
 * @returns {object} `{ override }` (null clears), or `{ error }`.
 */
function cleanOverride(override, filePaths) {
  if (override === null) return { override: null };
  if (!override || typeof override !== 'object') return { error: 'An override object or null is required.' };
  const file = override.file == null || override.file === '' ? null : override.file;
  if (file !== null && !filePaths.includes(file)) return { error: "That file isn't in this block." };
  const unlockTime = typeof override.unlockTime === 'string' ? override.unlockTime.trim() : '';
  if (unlockTime && !/^\d{1,2}:\d{2}$/.test(unlockTime)) return { error: 'Unlock time is HH:MM.' };
  const text = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
  return { override: { file, title: text(override.title), unlockTime, skip: !!override.skip, note: text(override.note) } };
}

/**
 * A new block in the same shape as core's freshBlock (renderer/js/core/channels.js).
 * @param {object} fields Cleaned fields; `trigger` is required.
 * @param {string} id The new block's id.
 * @returns {object} The block.
 */
function newBlock(fields, id) {
  const dateRange = fields.trigger.type === 'dateRange';
  return {
    id, name: fields.name || '', trigger: fields.trigger,
    priority: fields.priority != null ? fields.priority : (dateRange ? 10 : 0),
    mode: fields.mode || 'loop',
    folder: null, files: [], anchor: null, commercials: null, dayOverrides: {}, finale: null, theme: null,
  };
}

/**
 * A fresh block id, the same `blk-` form core uses.
 * @returns {string} The id.
 */
function randomBlockId() {
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turns the phone's calendar operations into config commands for one channel.
 * Each op is one of:
 * - `{ op: 'create', fields }` (fields must include a trigger),
 * - `{ op: 'update', id, fields }`,
 * - `{ op: 'remove', id }`,
 * - `{ op: 'overrideDay', id, key: 'MM-DD', override }` (override null clears the day).
 * @param {object} config The current config (read for the channel's blocks).
 * @param {number} channelNumber The channel being edited.
 * @param {Array<object>} ops The operations.
 * @param {object} [opts={}] Options.
 * @param {() => string} [opts.makeId] Makes a new block id (tests pass a fixed one).
 * @returns {object} `{ commands, created }` (`created` lists new block ids), or `{ error, status }`.
 */
function calendarCommands(config, channelNumber, ops, { makeId = randomBlockId } = {}) {
  const ch = (config && Array.isArray(config.channels) ? config.channels : []).find((c) => c && c.number === channelNumber);
  if (!ch) return { error: 'No channel has that number.', status: 404 };
  if (!Array.isArray(ops) || !ops.length || ops.length > 20) return { error: 'Send 1 to 20 operations.', status: 400 };
  const blocks = Array.isArray(ch.blocks) ? ch.blocks : [];
  const created = [];
  const commands = [];
  const findBlock = (id) => blocks.find((b) => b && b.id === id) || null;
  for (const op of ops) {
    if (!op || typeof op !== 'object') return { error: 'Each operation is an object.', status: 400 };
    if (op.op === 'create') {
      const checked = cleanFields(op.fields);
      if (checked.error) return { error: checked.error, status: 400 };
      if (!checked.fields.trigger) return { error: 'A new block needs a trigger.', status: 400 };
      const block = newBlock(checked.fields, makeId());
      created.push(block.id);
      commands.push({ type: 'block.create', channel: ch.number, block });
      continue;
    }
    const block = typeof op.id === 'string' ? findBlock(op.id) : null;
    if (!block) return { error: 'That block is no longer on this channel. Refresh and try again.', status: 409 };
    if (op.op === 'update') {
      const checked = cleanFields(op.fields);
      if (checked.error) return { error: checked.error, status: 400 };
      if (!Object.keys(checked.fields).length) return { error: 'Nothing to change.', status: 400 };
      commands.push({ type: 'item.set', collection: 'blocks', channel: ch.number, id: block.id, fields: checked.fields });
    } else if (op.op === 'remove') {
      commands.push({ type: 'block.remove', channel: ch.number, id: block.id });
    } else if (op.op === 'overrideDay') {
      if (typeof op.key !== 'string' || !/^\d{2}-\d{2}$/.test(op.key)) return { error: 'A day is an MM-DD key.', status: 400 };
      const checked = cleanOverride(op.override, (block.files || []).map((f) => f && f.path).filter(Boolean));
      if (checked.error) return { error: checked.error, status: 400 };
      commands.push({ type: 'block.overrideDay', channel: ch.number, id: block.id, key: op.key, override: checked.override });
    } else {
      return { error: `Unknown operation "${op.op}".`, status: 400 };
    }
  }
  return { commands, created };
}

/**
 * The phone's view of a channel's blocks: every editable field, with the file
 * list cut down to path and title (a day override picks one of them).
 * @param {object} ch The channel config.
 * @returns {Array<object>} One entry per block.
 */
function blocksForPhone(ch) {
  return (Array.isArray(ch.blocks) ? ch.blocks : []).filter(Boolean).map((b) => ({
    id: b.id,
    name: b.name || '',
    trigger: b.trigger || null,
    priority: Number.isFinite(b.priority) ? b.priority : 0,
    mode: b.mode || 'loop',
    folder: b.folder || null,
    fileCount: Array.isArray(b.files) ? b.files.length : 0,
    files: (Array.isArray(b.files) ? b.files : []).slice(0, 500).map((f) => ({
      path: f.path,
      title: f.title || String(f.path || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, ''),
    })),
    dayOverrides: b.dayOverrides && typeof b.dayOverrides === 'object' ? b.dayOverrides : {},
  }));
}

module.exports = { calendarCommands, blocksForPhone, cleanTrigger };
