// Editable timeline, the pure half (docs/design/02 §4). A gesture on SCHEDULE >
// ON AIR becomes a list of commands here; setup-onair.js previews them with
// proposeEdit/diffSchedules and dispatches them as one undo step. No DOM, and
// nothing here reads the clock for schedule purposes: every instant comes in
// as an argument from the view, which reads viewNow().
//
// Everything is written against the existing data model — blocks, their day
// overrides, broadcast hours, presets and file tags. A timeline edit never
// invents a new kind of layer (that question is step 3, §5).
import { cloneJson } from '../core/commands.js';
import { hourInRange, matchesTrigger, mdKey, resolveActiveSource } from '../core/schedule.js';
import { addDays, explainLayers } from '../core/schedule-query.js';
import { S } from '../core/state.js';

// Local wall-clock hour `h` of the day starting at dayStart. setHours, not ms
// arithmetic, so a DST day's hours land where the resolvers put them.
export function hourAt(dayStart, h) {
  const d = new Date(dayStart);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
}

export function randomTimelineBlockId() {
  return `blk-${Math.random().toString(36).slice(2, 10)}`;
}

function hasContent(block) {
  return !!(block && block.files && block.files.length);
}

function hasHours(trigger) {
  return trigger && trigger.startHour != null && trigger.endHour != null && trigger.startHour !== trigger.endHour;
}

// Whether a block's hours are something the timeline can drag: a time block,
// or a date-range block narrowed to hours. A date range that runs all day has
// no hour edges.
export function blockHasHourEdges(block) {
  if (!block || !block.trigger) return false;
  if (block.trigger.type === 'dateRange') return hasHours(block.trigger);
  return hasHours(block.trigger);
}

// The lane drawn above one day's programs: which block owns each hour, merged
// into spans. The owner is the block playback would use (resolveActiveSource),
// or, where only a block with no content matches, that block flagged empty so
// "exists but won't air" stays visible. Stretches with no owner are the
// default lineup and aren't listed.
//
// Returns [{ block, start, end, empty, startEdge, endEdge }] where startEdge /
// endEdge say that edge of the span is the block's own start/end hour (and so
// draggable), not just where a higher block covers it or the day ends.
export function blockSpansForDay(ch, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const spans = [];
  for (let h = 0; h < 25; h++) {
    const start = hourAt(dayStart, h);
    if (start >= dayEnd) break;
    const next = Math.min(hourAt(dayStart, h + 1), dayEnd);
    if (next <= start) continue; // the skipped hour of a spring-forward day
    let block = resolveActiveSource(ch, start).block;
    let empty = false;
    if (!block) {
      block = (ch.blocks || []).find((b) => !hasContent(b) && matchesTrigger(start, b)) || null;
      empty = !!block;
    }
    const last = spans[spans.length - 1];
    if (last && last.block === block && last.end === start) {
      last.end = next;
      continue;
    }
    if (block) spans.push({ block, start, end: next, empty });
  }
  spans.forEach((span) => {
    const t = span.block.trigger;
    const edges = blockHasHourEdges(span.block);
    span.startEdge = edges && new Date(span.start).getHours() === t.startHour;
    span.endEdge = edges && (span.end === dayEnd ? t.endHour === 0 : new Date(span.end).getHours() === t.endHour);
  });
  return spans;
}

// ---------- Creating a block from a dragged span ----------

// Priority a new standing block needs to win its hours on that weekday: one
// above every time block that could air there. Date-range blocks (holiday
// specials, default priority 10) are left above it on purpose — a new weekly
// slot shouldn't bury next December's takeover.
export function priorityToWin(ch, weekday, startHour, endHour) {
  const probe = { startHour, endHour };
  const overlapping = (ch.blocks || []).filter((b) => {
    const t = b.trigger;
    if (!t || t.type !== 'dayOfWeek') return false;
    if (t.days && t.days.length && !t.days.includes(weekday)) return false;
    for (let h = 0; h < 24; h++) if (hourInRange(h, probe) && hourInRange(h, t)) return true;
    return false;
  });
  if (!overlapping.length) return 0;
  return Math.max(...overlapping.map((b) => b.priority || 0)) + 1;
}

// { name, files, folder } come from the source picker. `anchorMs` is when the
// content starts counting; the view passes Date.now(), the same real-time
// anchor the BLOCKS folder picker records (CLAUDE.md: anchors are one of the
// deliberate Date.now() exceptions).
// `id` lets a preview and the final edit build the same block (its id seeds ad picks).
export function createBlockCommand(ch, { dayStart, startHour, endHour, name, files, folder = null, anchorMs, id = randomTimelineBlockId() }) {
  const weekday = new Date(dayStart).getDay();
  const block = {
    id,
    name: name || '',
    trigger: { type: 'dayOfWeek', startHour, endHour: endHour % 24, days: [weekday] },
    priority: priorityToWin(ch, weekday, startHour, endHour % 24),
    mode: 'loop',
    folder,
    files: cloneJson(files || []),
    anchor: anchorMs,
    commercials: null,
    dayOverrides: {},
    finale: null,
    theme: null,
  };
  return { type: 'block.create', channel: ch.number, block };
}

// ---------- Dragging a span's edges and chip ----------

// The hours a block would have with one edge moved to `hour` (0–24). Returns
// null when that would leave it empty or covering the whole day by accident.
export function resizedHours(block, edge, hour) {
  const t = block.trigger;
  const h = ((Math.round(hour) % 24) + 24) % 24;
  const startHour = edge === 'start' ? h : t.startHour;
  const endHour = edge === 'end' ? h : t.endHour;
  if (startHour === endHour) return null;
  return { startHour, endHour };
}

export function resizeCommand(ch, block, edge, hour) {
  const hours = resizedHours(block, edge, hour);
  if (!hours) return null;
  if (hours.startHour === block.trigger.startHour && hours.endHour === block.trigger.endHour) return null;
  return { type: 'block.setHours', channel: ch.number, id: block.id, ...hours };
}

// A block's colour chip dropped on another day's row: add that weekday. Only a
// block that already names its days can gain one (an every-day block already
// airs there, and a plain date range has no weekdays to add to).
export function copyToWeekdayCommand(ch, block, weekday) {
  const days = block.trigger && block.trigger.days;
  if (!days || !days.length || days.includes(weekday)) return null;
  return { type: 'block.setDays', channel: ch.number, id: block.id, days: [...days, weekday] };
}

export function removeWeekdayCommand(ch, block, weekday) {
  const t = block.trigger;
  const days = t.days && t.days.length ? t.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(weekday) || days.length === 1) return null;
  return { type: 'block.setDays', channel: ch.number, id: block.id, days: days.filter((d) => d !== weekday) };
}

// ---------- One airing: "Only this day", "Replace with…" ----------

// The hours an exception for a program needs: the hour it starts in, through
// the hour it ends in (triggers are whole hours), kept inside its own day.
export function programHours(program, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const start = Math.max(program.start, dayStart);
  const end = Math.min(program.end, dayEnd);
  const startHour = new Date(start).getHours();
  const endDate = new Date(end);
  let endHour = endDate.getHours() + (endDate.getMinutes() || endDate.getSeconds() || endDate.getMilliseconds() ? 1 : 0);
  if (end >= dayEnd) endHour = 0;
  return { startHour, endHour: endHour % 24 };
}

function topPriorityAt(ch, atMs) {
  return Math.max(10, ...(ch.blocks || []).filter((b) => matchesTrigger(atMs, b)).map((b) => b.priority || 0));
}

// A date-range block covering one date and the program's hours, above
// everything that matches there, so the edit reaches only that airing's slot.
// `source` is { name, files, folder, anchorMs } for a replacement, or omitted
// for "Only this day", which copies what airs now (files and anchor alike, so
// nothing changes until the copy is edited).
export function exceptionBlockCommand(ch, program, dayStart, source = null, id = randomTimelineBlockId()) {
  const at = Math.max(program.start, dayStart) + 1;
  const live = resolveActiveSource(ch, at);
  const { startHour, endHour } = programHours(program, dayStart);
  const d = new Date(dayStart);
  const label = `${d.getMonth() + 1}/${d.getDate()}`;
  const fromBlock = live.block;
  const block = {
    id,
    name: source ? `${source.name || 'Replacement'} (${label})` : `${(fromBlock && fromBlock.name) || ch.name || `CH ${ch.number}`} (${label} only)`,
    trigger: {
      type: 'dateRange', startMonth: d.getMonth() + 1, startDay: d.getDate(), endMonth: d.getMonth() + 1, endDay: d.getDate(),
      startHour, endHour, days: [],
    },
    priority: topPriorityAt(ch, at) + 1,
    mode: 'loop',
    folder: source ? (source.folder || null) : ((fromBlock && fromBlock.folder) || null),
    files: cloneJson(source ? source.files : live.files),
    // A replacement starts from its first file at the top of the slot; a copy
    // keeps the live anchor so it resolves to exactly what airs now.
    anchor: source ? (source.anchorMs != null ? source.anchorMs : hourAt(dayStart, startHour)) : live.anchor,
    commercials: fromBlock && fromBlock.commercials ? cloneJson(fromBlock.commercials) : null,
    dayOverrides: {},
    finale: null,
    theme: fromBlock && fromBlock.theme ? cloneJson(fromBlock.theme) : null,
  };
  return { type: 'block.create', channel: ch.number, block };
}

// On a daily/weekly date-range block the native "this day only" is its own
// day override: pin one of the block's files for that date.
export function pinFileOverrideCommand(ch, block, dayMs, filePath) {
  const key = mdKey(dayMs);
  const current = (block.dayOverrides && block.dayOverrides[key]) || { file: null, title: '', unlockTime: '', skip: false, note: '' };
  return { type: 'block.overrideDay', channel: ch.number, id: block.id, key, override: { ...current, file: filePath } };
}

export function isDailyBlock(block) {
  return !!(block && block.trigger && block.trigger.type === 'dateRange' && (block.mode === 'daily' || block.mode === 'weekly'));
}

// ---------- Breaks ----------

export const NO_BREAKS_TAG = 'no-breaks';
const NO_BREAKS_PRESET_ID = 'preset-no-breaks';

// Where the file object for an airing lives, for file.set: the channel's own
// pool or the block that aired it.
function fileAddress(ch, program) {
  const owner = program.block && (program.block.files || []).some((f) => f.path === program.file.path) ? program.block : null;
  const pool = owner ? owner.files : (ch.files || []);
  const file = pool.find((f) => f.path === program.file.path);
  return file ? { block: owner ? owner.id : undefined, file } : null;
}

function isPluginOwned(item) {
  return !!(item && (item.pluginId || item.ownerPlugin));
}

export function pluginOwner(item) {
  return item ? (item.pluginId || item.ownerPlugin || null) : null;
}

// "No ad breaks in this show": the file gets a no-breaks tag, and a preset for
// that tag places no breaks. Presets are consulted before a block's or the
// channel's cadence but after flows, so where a flow decides this show's
// breaks the timeline says so instead of pretending.
// Returns { commands, label } or { disabled: reason }.
export function noBreaksCommands(ch, program, atMs) {
  const address = fileAddress(ch, program);
  if (!address) return { disabled: 'This airing has no file entry to tag.' };
  const tags = address.file.tags || [];
  const { layers } = explainLayers(ch, atMs);
  const flow = layers.find((l) => l.kind === 'flow' && l.role === 'wins');
  if (tags.includes(NO_BREAKS_TAG)) {
    return {
      label: 'Allow ad breaks in this show',
      commands: [{ type: 'file.set', channel: ch.number, block: address.block, file: program.file.path, fields: { tags: tags.filter((t) => t !== NO_BREAKS_TAG) } }],
    };
  }
  if (ch.adsEnabled === false) return { disabled: 'Ads are off for this whole channel.' };
  if (flow) return { disabled: `The flow "${flow.item.name || flow.item.id}" decides this show's breaks. Edit it under PROGRAMMING › FLOWS.` };
  const commands = [{ type: 'file.set', channel: ch.number, block: address.block, file: program.file.path, fields: { tags: [...tags, NO_BREAKS_TAG] } }];
  const presets = (S.config.interstitials && S.config.interstitials.presets) || [];
  const existing = presets.find((p) => p.id === NO_BREAKS_PRESET_ID);
  if (!existing) {
    // First in the list: presets are matched top-down, and this one should
    // beat any broader preset the show also matches.
    commands.push({
      type: 'item.insert', collection: 'presets', index: 0,
      item: { id: NO_BREAKS_PRESET_ID, name: 'No ad breaks', enabled: true, channels: [], contentTags: [NO_BREAKS_TAG], timing: 'breakpoints', breakpoints: [], podMin: 1, podMax: 1 },
    });
  } else if (existing.enabled === false) {
    commands.push({ type: 'item.set', collection: 'presets', id: NO_BREAKS_PRESET_ID, fields: { enabled: true } });
  }
  return { label: 'No ad breaks in this show', commands };
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'show';
}

function roundPercent(p) {
  return Math.round(p * 10) / 10;
}

// "Add break here" at `atMs` inside a program. Edits the layer that decides the
// show's breaks (§4.2): a set-points preset gains a point; a show on a timed
// cadence gets its own set-points preset (tagged to that file) with this one
// point, which the preview shows replacing the timed breaks. Flows and
// plugin-owned presets are explained, not edited.
// Returns { commands, label } or { disabled: reason }.
export function addBreakHereCommands(ch, program, atMs, displayTitle) {
  const address = fileAddress(ch, program);
  if (!address) return { disabled: 'This airing has no file entry to attach a break to.' };
  if (ch.adsEnabled === false) return { disabled: 'Ads are off for this whole channel.' };
  const percent = roundPercent(((atMs - program.start) / Math.max(1, program.end - program.start)) * 100);
  if (percent <= 1 || percent >= 99) return { disabled: 'Too close to the start or end of the show; breaks there already come between programs.' };
  const { layers } = explainLayers(ch, atMs);
  const winner = layers.find((l) => l.group === 'breaks' && l.role === 'wins');
  if (winner.kind === 'flow') return { disabled: `The flow "${winner.item.name || winner.item.id}" decides this show's breaks. Edit its mid-show cadence under PROGRAMMING › FLOWS.` };
  if (winner.kind === 'preset' && isPluginOwned(winner.item)) return { disabled: `This show's breaks come from a preset owned by the ${pluginOwner(winner.item)} plugin.` };
  if (winner.kind === 'preset' && winner.item.timing === 'breakpoints') {
    const points = [...new Set([...(winner.item.breakpoints || []), percent])].sort((a, b) => a - b);
    return {
      label: `Add a break at ${percent}% to preset "${winner.item.name || winner.item.id}"`,
      commands: [{ type: 'item.set', collection: 'presets', id: winner.item.id, fields: { breakpoints: points } }],
    };
  }
  const tag = `breaks-${slug(displayTitle || program.file.path)}`;
  const tags = address.file.tags || [];
  const presets = (S.config.interstitials && S.config.interstitials.presets) || [];
  const presetId = `preset-${tag}`;
  const existing = presets.find((p) => p.id === presetId);
  const commands = [];
  if (!tags.includes(tag)) commands.push({ type: 'file.set', channel: ch.number, block: address.block, file: program.file.path, fields: { tags: [...tags, tag] } });
  if (existing) {
    commands.push({ type: 'item.set', collection: 'presets', id: presetId, fields: { breakpoints: [...new Set([...(existing.breakpoints || []), percent])].sort((a, b) => a - b), enabled: true } });
  } else {
    const inherited = winner.item && winner.item.podMin ? winner.item : (S.config.commercials || {});
    commands.push({
      type: 'item.insert', collection: 'presets', index: 0,
      item: {
        id: presetId, name: `${displayTitle || 'Show'} breaks`, enabled: true, channels: [ch.number], contentTags: [tag],
        timing: 'breakpoints', breakpoints: [percent], podMin: inherited.podMin || 1, podMax: inherited.podMax || inherited.podMin || 2,
      },
    });
  }
  return { label: `Add a break at ${percent}% of ${displayTitle || 'this show'}`, commands };
}

// ---------- Layer order ----------

// Priorities that put `ordered` (blocks, highest first) in that order, changing
// as few as possible: walking up from the bottom, a block keeps its priority if
// it already beats the one below, otherwise it becomes one more. Ties would be
// broken by array position, which a drag in the list doesn't express, so the
// order is made strict.
export function reorderCommands(ch, ordered) {
  const commands = [];
  let floor = -Infinity;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const block = ordered[i];
    const current = block.priority || 0;
    const next = current > floor ? current : floor + 1;
    if (next !== current) commands.push({ type: 'block.setPriority', channel: ch.number, id: block.id, priority: next });
    floor = next;
  }
  return commands;
}

// ---------- Guardrails (§4.4) ----------

function dateRangeDays(t) {
  const year = 2001; // not a leap year; a range's length is only a threshold here
  const start = new Date(year, t.startMonth - 1, t.startDay).getTime();
  let end = new Date(year, t.endMonth - 1, t.endDay).getTime();
  if (end < start) end = new Date(year + 1, t.endMonth - 1, t.endDay).getTime();
  return Math.round((end - start) / 86400000) + 1;
}

// What a confirmation has to say before these commands apply, if anything:
//   reanchor   an existing source's file list or anchor changes, so what's on
//              now changes too
//   beyondWeek a date-range block longer than a week is touched, so the
//              week's preview can't show all of it
export function guardrailsFor(config, channelNumber, commands) {
  const ch = (config.channels || []).find((c) => c.number === channelNumber);
  const blocks = (ch && ch.blocks) || [];
  let reanchor = false;
  let beyondWeek = false;
  commands.forEach((cmd) => {
    const fields = cmd.fields || {};
    if ((cmd.type === 'item.set' && cmd.collection === 'blocks') || cmd.type === 'channel.setFields') {
      if ('files' in fields || 'anchor' in fields) reanchor = true;
    }
    const block = cmd.id ? blocks.find((b) => b.id === cmd.id) : (cmd.block || null);
    const t = block && block.trigger;
    if (t && t.type === 'dateRange' && /^block\./.test(cmd.type) && dateRangeDays(t) > 7) beyondWeek = true;
  });
  return { reanchor, beyondWeek, confirm: reanchor || beyondWeek };
}

// ---------- Sources for the picker ----------

function basename(p) {
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

function parentDir(p) {
  const parts = String(p).split(/[\\/]/);
  parts.pop();
  return parts.join('\\');
}

// Content the timeline can point a new block at without scanning anything:
// every folder already in the library (each channel's folders, and the show
// folders under them), and every tag some file carries. Files are copied per
// source, never shared with the channel they came from.
export function librarySources(config) {
  const folders = new Map();
  const tags = new Map();
  (config.channels || []).forEach((ch) => {
    const entries = new Map((ch.folders || []).map((e) => [e.id, e]));
    (ch.files || []).forEach((f) => {
      if (!f || !f.path || !(f.duration > 0)) return;
      const entry = entries.get(f.folder);
      if (entry) {
        const key = `folder:${entry.ref}`;
        if (!folders.has(key)) folders.set(key, { kind: 'folder', key, label: entry.label || basename(entry.ref), folder: entry.source === 'local' ? entry.ref : null, files: new Map() });
        folders.get(key).files.set(f.path, f);
      }
      if (!String(f.path).startsWith('mediasource:')) {
        const dir = parentDir(f.path);
        if (dir && (!entry || dir !== String(entry.ref).replace(/[\\/]+$/, ''))) {
          const key = `folder:${dir}`;
          if (!folders.has(key)) folders.set(key, { kind: 'folder', key, label: basename(dir), folder: dir, files: new Map() });
          folders.get(key).files.set(f.path, f);
        }
      }
      (f.tags || []).forEach((tag) => {
        const key = `tag:${tag}`;
        if (!tags.has(key)) tags.set(key, { kind: 'tag', key, label: `#${tag}`, folder: null, files: new Map() });
        tags.get(key).files.set(f.path, f);
      });
    });
  });
  const finish = (list) => [...list.values()]
    .map((s) => ({ ...s, files: [...s.files.values()].map((f) => ({ path: f.path, duration: f.duration, ...(f.source ? { source: f.source } : {}), ...(f.title ? { title: f.title } : {}), ...(f.tags ? { tags: [...f.tags] } : {}) })) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { folders: finish(folders), tags: finish(tags) };
}

// Programs in a day list whose airing overlaps any changed range, for the
// impact outline.
export function overlapsAny(entry, ranges) {
  return ranges.some((r) => entry.end > r.start && entry.start < r.end);
}

// "Moves 6 programs and 2 breaks" — counts for a diff, programs counted once
// per airing whichever side of the diff they're on. Signed-off hours are
// counted as days whose sign-off changed: programs keep resolving through
// them (ON AIR just doesn't draw them), so they'd otherwise read as no change.
export function diffCounts(diff) {
  const programs = new Set([...diff.added, ...diff.removed].map((e) => Math.round(e.start)));
  const breaks = new Set([...diff.breaksAdded, ...diff.breaksRemoved].map((e) => Math.round(e.start)));
  const signOffDays = new Set((diff.offAirChanged || []).map((r) => new Date(r.start).toDateString()));
  return { programs: programs.size, breaks: breaks.size, signOffDays: signOffDays.size, ranges: diff.changed.length };
}

