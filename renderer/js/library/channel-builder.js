// Channel plans and templates (docs/design/08). This module is deliberately
// pure: Electron, the LAN control panel and TV first-run can all use the same
// parser/resolver/compiler and put their own UI around the result.
import { materializeItems, runQuery } from './query.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
let idCounter = 0;
const planId = (prefix) => `${prefix}-${++idCounter}`;

function blankChannel(number) {
  return {
    number, name: '', folders: [], files: [], anchor: null, shuffle: false, icon: null,
    adsEnabled: true, contentTags: [], favorite: false, rating: null, vhsQuality: false,
    logoBugProfiles: null, volume: null, broadcastHours: { enabled: false, startHour: 6, endHour: 0 },
    quickAccess: false, dynamicOverlays: null, tickerLayout: null, tickerContent: null,
  };
}

function blankBlock(type) {
  return { id: planId('blk'), name: '', priority: type === 'dateRange' ? 10 : 0, mode: 'loop', folder: null, files: [], anchor: null, commercials: null, dayOverrides: {}, finale: null, theme: null };
}

export const BUILTIN_TEMPLATES = Object.freeze([
  { templateVersion: 1, id: 'saturday-morning', name: 'Saturday Morning Cartoons', slots: { cartoons: { label: 'Cartoons', match: { 'facets.genre': ['cartoon', 'animation'] }, min: 4 } }, channel: { name: 'Saturday Morning' }, programming: [{ block: { days: [6], hours: [7, 11], play: { slot: 'cartoons' } } }] },
  { templateVersion: 1, id: 'primetime-sitcoms', name: 'Primetime Sitcoms', slots: { sitcoms: { label: 'Sitcoms', match: { 'facets.genre': ['sitcom', 'comedy'], kind: 'episode' }, min: 4 } }, channel: { name: 'Prime Time' }, programming: [{ block: { days: WEEKDAYS, hours: [20, 23], play: { slot: 'sitcoms' } } }] },
  { templateVersion: 1, id: 'movie-night', name: 'Friday Movie Night', slots: { movies: { label: 'Movies', match: { kind: 'movie' }, min: 1 } }, channel: { name: 'Movie Night' }, programming: [{ block: { days: [5], hours: [20, 24], play: { slot: 'movies' } } }] },
  { templateVersion: 1, id: 'christmas-countdown', name: 'Christmas Countdown', slots: { christmas: { label: 'Christmas programs', match: { text: 'christmas' }, min: 4 } }, channel: { name: 'Christmas Countdown' }, programming: [{ block: { dateRange: [12, 1, 12, 25], play: { slot: 'christmas' } } }] },
  { templateVersion: 1, id: 'late-night', name: 'Late Night', slots: { late: { label: 'Late-night shows', match: { any: [{ 'facets.genre': 'talk' }, { 'facets.genre': 'comedy' }] }, min: 2 } }, channel: { name: 'Late Night' }, programming: [{ block: { days: [1, 2, 3, 4, 5, 6, 0], hours: [23, 2], play: { slot: 'late' } } }] },
  { templateVersion: 1, id: 'marathon', name: 'Series Marathon', slots: { series: { label: 'A series', match: { kind: 'episode' }, min: 4 } }, channel: { name: 'Marathon' }, programming: [] },
]);

export function validateTemplate(template) {
  if (!template || template.templateVersion !== 1) throw new Error('This template version is not supported.');
  if (!template.id || !template.name || !template.slots || !template.channel) throw new Error('The template is missing required fields.');
  Object.entries(template.slots).forEach(([id, slot]) => {
    if (!id || !slot || !slot.label || !slot.match || typeof slot.match !== 'object') throw new Error(`Slot "${id}" is invalid.`);
  });
  (template.programming || []).forEach(({ block }) => {
    if (!block || !block.play || !template.slots[block.play.slot]) throw new Error('A programming block refers to an unknown slot.');
  });
  return template;
}

function parseHour(raw, meridiem) {
  let hour = Number(raw);
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return hour;
}

function phraseMatch(phrase) {
  const lower = phrase.toLowerCase();
  const where = {};
  if (/cartoon|animation/.test(lower)) where['facets.genre'] = ['cartoon', 'animation'];
  else if (/sitcom|comedy/.test(lower)) where['facets.genre'] = ['sitcom', 'comedy'];
  else if (/movie|film/.test(lower)) where.kind = 'movie';
  else where.text = phrase.trim();
  const era = lower.match(/\b(?:(19|20)\d0s|\d{2}s)\b/);
  if (era) where['facets.era'] = era[0].length === 3 ? `${Number(era[0].slice(0, 2)) >= 30 ? '19' : '20'}${era[0]}` : era[0];
  return where;
}

// Published offline grammar: "<content> Saturday mornings 7 to 11" and
// "<content> weeknights 8 to 10". Clauses may be separated with commas.
export function describeChannel(text) {
  const clauses = String(text || '').split(/\s*,\s*/).filter(Boolean);
  if (!clauses.length) throw new Error('Describe at least one programming block.');
  const slots = {};
  const programming = [];
  clauses.forEach((clause, index) => {
    const schedule = clause.match(/\b(weeknights?|weekdays?|saturdays?|sundays?|daily|every day)(?:\s+mornings?|\s+evenings?)?\s+(\d{1,2})(?:\s*(am|pm))?\s*(?:to|-|–)\s*(\d{1,2})(?:\s*(am|pm))?/i);
    if (!schedule) throw new Error(`Could not read the schedule in “${clause}”. Try “cartoons Saturdays 7 am to 11 am”.`);
    const content = clause.slice(0, schedule.index).trim();
    if (!content) throw new Error(`Add content before the schedule in “${clause}”.`);
    const key = `slot${index + 1}`;
    const word = schedule[1].toLowerCase();
    const days = word.startsWith('week') ? WEEKDAYS : word.startsWith('saturday') ? [6] : word.startsWith('sunday') ? [0] : [0, 1, 2, 3, 4, 5, 6];
    let start = parseHour(schedule[2], schedule[3] && schedule[3].toLowerCase());
    let end = parseHour(schedule[4], schedule[5] && schedule[5].toLowerCase());
    if (!schedule[3] && !schedule[5] && /evening|night|prime time/i.test(schedule[0])) { if (start < 12) start += 12; if (end <= 12) end += 12; }
    slots[key] = { label: content, match: phraseMatch(content), min: 1 };
    programming.push({ block: { days, hours: [start, end], play: { slot: key } } });
  });
  return validateTemplate({ templateVersion: 1, id: 'described-channel', name: 'Described channel', slots, channel: { name: 'My Channel' }, programming });
}

export function resolveTemplate(template, library) {
  validateTemplate(template);
  const items = Object.values((library && library.items) || {}).filter((item) => !item.detached);
  const slots = {};
  Object.entries(template.slots).forEach(([id, spec]) => {
    const matched = runQuery(items, spec.match);
    const materialized = materializeItems(matched, { order: spec.order || 'series', seed: `${template.id}|${id}` });
    slots[id] = { spec, matched, files: materialized.files, skipped: materialized.skipped, hours: materialized.files.reduce((n, file) => n + file.duration, 0) / 3600 };
  });
  const missing = Object.entries(slots).filter(([, result]) => !result.spec.optional && result.files.length < (result.spec.min || 1)).map(([id]) => id);
  return { template, slots, missing, ready: missing.length === 0 };
}

export function compileTemplate(resolved, { number, atMs }) {
  if (!resolved || !resolved.ready) throw new Error('Fill every required slot before applying this template.');
  const channel = { ...blankChannel(number), ...resolved.template.channel, number, anchor: atMs };
  const seen = new Set();
  channel.files = [];
  Object.values(resolved.slots).forEach((slot) => slot.files.forEach((file) => {
    const key = file.item || file.path;
    if (!seen.has(key)) { seen.add(key); channel.files.push(file); }
  }));
  channel.blocks = (resolved.template.programming || []).map(({ block }) => {
    const out = blankBlock(block.dateRange ? 'dateRange' : 'dayOfWeek');
    out.name = resolved.slots[block.play.slot].spec.label;
    out.files = resolved.slots[block.play.slot].files;
    out.anchor = atMs;
    out.trigger = block.dateRange
      ? { type: 'dateRange', startMonth: block.dateRange[0], startDay: block.dateRange[1], endMonth: block.dateRange[2], endDay: block.dateRange[3] }
      : { type: 'dayOfWeek', days: block.days, startHour: block.hours[0], endHour: block.hours[1] % 24 };
    return out;
  });
  return channel;
}

export function templateFromChannel(channel, { id = 'saved-channel', name = channel.name || 'Saved channel' } = {}) {
  const slots = {};
  const programming = (channel.blocks || []).map((block, index) => {
    const key = `slot${index + 1}`;
    const tags = [...new Set((block.files || []).flatMap((file) => file.tags || []))];
    slots[key] = { label: block.name || `Block ${index + 1}`, match: tags.length ? { tags } : { text: block.name || channel.name || '' }, min: 1 };
    const trigger = block.trigger || {};
    return { block: trigger.type === 'dateRange'
      ? { dateRange: [trigger.startMonth, trigger.startDay, trigger.endMonth, trigger.endDay], play: { slot: key } }
      : { days: trigger.days || [], hours: [trigger.startHour, trigger.endHour], play: { slot: key } } };
  });
  return validateTemplate({ templateVersion: 1, id, name, slots, channel: { name: channel.name, rating: channel.rating, identity: channel.identity }, programming });
}
