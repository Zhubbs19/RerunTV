// Channel presets (templates) and the plans they compile to (docs/design/08).
// This module is deliberately pure: Electron, the LAN control panel and TV
// first-run can all use the same parser/resolver/compiler and put their own UI
// around the result.
//
// A preset names no paths and no media. Its slots are matched against the
// person's own library (07), and compiling binds them to a fully materialized
// channel — ordinary `files`, ordinary schedule blocks, ordinary ad-pool
// entries — so nothing on the playback path knows presets exist.
//
// Format, `templateVersion: 1` (every field after `channel` is optional):
//   {
//     id, name, description?,
//     slots: { <id>: { label, match: <where>, min?, optional?, order? } },
//     channel: { name, rating?, shuffle?, adsEnabled?, identity?, trackCard? },
//     programming: [ { block: { days, hours, play: { slot } } }
//                  | { block: { dateRange: [m, d, m, d], play: { slot } } } ],
//       // [] or absent: the slots loop 24/7 with no blocks
//     breaks: { pool: { slot }, contentTag? }   // this slot's files become ad-pool
//       // entries aimed at the channel through a content tag, so a Christmas
//       // channel airs only Christmas ads
//   }
import { materializeItems, runQuery } from './query.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
let idCounter = 0;
const planId = (prefix) => `${prefix}-${++idCounter}`;

function blankChannel(number) {
  return {
    number, name: '', folders: [], files: [], anchor: null, shuffle: false, icon: null,
    adsEnabled: true, contentTags: [], favorite: false, rating: null, vhsQuality: false,
    logoBugProfiles: null, volume: null, broadcastHours: { enabled: false, startHour: 6, endHour: 0 },
    quickAccess: false, dynamicOverlays: null, tickerLayout: null, tickerContent: null, trackCard: null,
  };
}

function blankBlock(type) {
  return { id: planId('blk'), name: '', priority: type === 'dateRange' ? 10 : 0, mode: 'loop', folder: null, files: [], anchor: null, commercials: null, dayOverrides: {}, finale: null, theme: null };
}

// The channel fields a preset may set. Anything else in `channel` is dropped
// at compile time, so a preset file can't smuggle in paths or a lineup.
const CHANNEL_FIELDS = ['name', 'rating', 'shuffle', 'adsEnabled', 'identity', 'trackCard', 'icon', 'vhsQuality'];

export const BUILTIN_TEMPLATES = Object.freeze([
  {
    templateVersion: 1, id: 'music-videos', name: 'Music Videos',
    description: 'Music videos around the clock, with the artist and song on screen as each one starts and ends.',
    slots: {
      videos: { label: 'Music videos', match: { kind: 'music' }, min: 10, order: 'shuffle' },
      ads: { label: 'Ads and bumpers for the breaks', match: { kind: ['commercial', 'bumper'], any: [{ 'facets.genre': 'music' }, { tags: 'music' }, { text: 'music' }] }, optional: true },
    },
    channel: { name: 'Music Videos', shuffle: true, trackCard: { enabled: true, atStart: true, atEnd: true, seconds: 8 } },
    programming: [],
    breaks: { pool: { slot: 'ads' }, contentTag: 'music-videos' },
  },
  {
    templateVersion: 1, id: 'christmas-tv', name: 'Christmas TV',
    description: 'Only Christmas movies, specials and episodes, all day, with Christmas ads in the breaks.',
    slots: {
      programs: { label: 'Christmas movies and shows', match: { kind: ['movie', 'episode', 'short'], any: [{ tags: 'christmas' }, { text: 'christmas' }, { text: 'xmas' }] }, min: 4 },
      ads: { label: 'Christmas ads', match: { kind: ['commercial', 'bumper'], any: [{ tags: 'christmas' }, { text: 'christmas' }, { text: 'xmas' }] }, optional: true },
    },
    channel: { name: 'Christmas TV' },
    programming: [],
    breaks: { pool: { slot: 'ads' }, contentTag: 'christmas' },
  },
  { templateVersion: 1, id: 'saturday-morning', name: 'Saturday Morning Cartoons', slots: { cartoons: { label: 'Cartoons', match: { 'facets.genre': ['cartoon', 'animation'] }, min: 4 } }, channel: { name: 'Saturday Morning' }, programming: [{ block: { days: [6], hours: [7, 11], play: { slot: 'cartoons' } } }] },
  { templateVersion: 1, id: 'primetime-sitcoms', name: 'Primetime Sitcoms', slots: { sitcoms: { label: 'Sitcoms', match: { 'facets.genre': ['sitcom', 'comedy'], kind: 'episode' }, min: 4 } }, channel: { name: 'Prime Time' }, programming: [{ block: { days: WEEKDAYS, hours: [20, 23], play: { slot: 'sitcoms' } } }] },
  { templateVersion: 1, id: 'movie-night', name: 'Friday Movie Night', slots: { movies: { label: 'Movies', match: { kind: 'movie' }, min: 1 } }, channel: { name: 'Movie Night' }, programming: [{ block: { days: [5], hours: [20, 24], play: { slot: 'movies' } } }] },
  { templateVersion: 1, id: 'christmas-countdown', name: 'Christmas Countdown', slots: { christmas: { label: 'Christmas programs', match: { text: 'christmas' }, min: 4 } }, channel: { name: 'Christmas Countdown' }, programming: [{ block: { dateRange: [12, 1, 12, 25], play: { slot: 'christmas' } } }] },
  { templateVersion: 1, id: 'late-night', name: 'Late Night', slots: { late: { label: 'Late-night shows', match: { any: [{ 'facets.genre': 'talk' }, { 'facets.genre': 'comedy' }] }, min: 2 } }, channel: { name: 'Late Night' }, programming: [{ block: { days: EVERY_DAY, hours: [23, 2], play: { slot: 'late' } } }] },
  { templateVersion: 1, id: 'marathon', name: 'Series Marathon', slots: { series: { label: 'A series', match: { kind: 'episode' }, min: 4 } }, channel: { name: 'Marathon' }, programming: [] },
]);

// docs/design/08 §3.2: "Plugin-provided template registration remains an
// extension point rather than part of the v1 core contract" — the extension
// point itself (validated the same way a saved/imported template file is).
const pluginTemplates = new Map();

export function registerTemplate(template) {
  validateTemplate(template);
  pluginTemplates.set(template.id, template);
}

export function listTemplates() {
  return [...BUILTIN_TEMPLATES, ...pluginTemplates.values()];
}

// Where a preset came from, for the PRESETS screen: built-ins and plugin
// presets are read-only (CUSTOMIZE copies one), saved presets are editable.
export function templateSource(template) {
  if (BUILTIN_TEMPLATES.some((entry) => entry.id === template.id)) return 'builtin';
  if (pluginTemplates.has(template.id)) return 'plugin';
  return 'saved';
}

export function validateTemplate(template) {
  if (!template || template.templateVersion !== 1) throw new Error('This template version is not supported.');
  if (!template.id || !template.name || !template.slots || !template.channel) throw new Error('The template is missing required fields.');
  if (typeof template.channel !== 'object') throw new Error('The template is missing required fields.');
  Object.entries(template.slots).forEach(([id, slot]) => {
    if (!id || !slot || !slot.label || !slot.match || typeof slot.match !== 'object') throw new Error(`Slot "${id}" is invalid.`);
  });
  (template.programming || []).forEach(({ block } = {}) => {
    if (!block || !block.play || !template.slots[block.play.slot]) throw new Error('A programming block refers to an unknown slot.');
    if (!block.dateRange && !(Array.isArray(block.days) && Array.isArray(block.hours) && block.hours.length === 2)) {
      throw new Error('A programming block needs days and hours, or a date range.');
    }
  });
  if (template.breaks && template.breaks.pool) {
    if (!template.slots[template.breaks.pool.slot]) throw new Error('The breaks pool refers to an unknown slot.');
  }
  if (!Object.keys(template.slots).length) throw new Error('A preset needs at least one slot.');
  if (template.channel.trackCard != null && typeof template.channel.trackCard !== 'object') throw new Error('trackCard must be an object.');
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
  else if (/music video|music/.test(lower)) where.kind = 'music';
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
    const days = word.startsWith('week') ? WEEKDAYS : word.startsWith('saturday') ? [6] : word.startsWith('sunday') ? [0] : EVERY_DAY;
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

// A preset's break slot is fed to the box-wide ad pool as ordinary entries,
// each aimed at this channel by a content tag the channel carries
// (`effectiveContentTags`, core/interstitials.js). Nothing else on the box
// matches that tag, so these ads play only here, and a second channel built
// from the same preset reuses them rather than adding duplicates.
function poolEntriesFor(resolved, channel, { existingPool = [], newId }) {
  const breaks = resolved.template.breaks;
  if (!breaks || !breaks.pool || !resolved.slots[breaks.pool.slot]) return { entries: [], contentTag: null };
  const slot = resolved.slots[breaks.pool.slot];
  const contentTag = String(breaks.contentTag || `preset-${resolved.template.id}`).toLowerCase();
  const known = new Set(existingPool
    .filter((entry) => entry && entry.file && Array.isArray(entry.contentTags) && entry.contentTags.includes(contentTag))
    .map((entry) => entry.file.path));
  const entries = [];
  slot.files.forEach((file, index) => {
    if (known.has(file.path)) return;
    known.add(file.path);
    const type = file.kind === 'bumper' ? 'bumper' : 'commercial';
    entries.push({
      id: newId ? newId() : `preset-${resolved.template.id}-${channel.number}-${index + 1}`,
      type, channelAffinity: 'any', blockAffinity: null, weight: 1,
      file: { path: file.path, source: file.source || 'local', duration: file.duration, ...(file.title ? { title: file.title } : {}) },
      text: null, contentTags: [contentTag],
    });
  });
  return { entries, contentTag };
}

// The slots that actually loop on the channel: every slot a programming
// block plays, or, with no programming, every slot but the breaks pool.
function contentSlotIds(resolved) {
  const programming = resolved.template.programming || [];
  if (programming.length) return [...new Set(programming.map(({ block }) => block.play.slot))];
  const poolSlot = resolved.template.breaks && resolved.template.breaks.pool && resolved.template.breaks.pool.slot;
  return Object.keys(resolved.slots).filter((id) => id !== poolSlot);
}

/**
 * Everything applying a preset produces: the channel, and any ad-pool entries
 * its breaks slot adds. `existingPool` lets a re-apply skip files already in
 * the pool under this preset's tag. Pure; the caller dispatches.
 */
export function compilePreset(resolved, { number, atMs, existingPool = [], newId = null }) {
  if (!resolved || !resolved.ready) throw new Error('Fill every required slot before applying this preset.');
  const template = resolved.template;
  const channel = blankChannel(number);
  CHANNEL_FIELDS.forEach((field) => {
    if (template.channel[field] !== undefined) channel[field] = JSON.parse(JSON.stringify(template.channel[field]));
  });
  channel.number = number;
  channel.anchor = atMs;
  if (channel.trackCard) channel.trackCard = normalizeTrackCard(channel.trackCard);

  const seen = new Set();
  channel.files = [];
  contentSlotIds(resolved).forEach((id) => resolved.slots[id].files.forEach((file) => {
    const key = file.item || file.path;
    if (!seen.has(key)) { seen.add(key); channel.files.push(file); }
  }));

  channel.blocks = (template.programming || []).map(({ block }) => {
    const out = blankBlock(block.dateRange ? 'dateRange' : 'dayOfWeek');
    out.name = resolved.slots[block.play.slot].spec.label;
    out.files = resolved.slots[block.play.slot].files;
    out.anchor = atMs;
    out.trigger = block.dateRange
      ? { type: 'dateRange', startMonth: block.dateRange[0], startDay: block.dateRange[1], endMonth: block.dateRange[2], endDay: block.dateRange[3] }
      : { type: 'dayOfWeek', days: block.days, startHour: block.hours[0], endHour: block.hours[1] % 24 };
    return out;
  });

  const { entries, contentTag } = poolEntriesFor(resolved, channel, { existingPool, newId });
  if (contentTag) {
    channel.contentTags = [...new Set([...(channel.contentTags || []), contentTag])];
    if (template.channel.adsEnabled === undefined) channel.adsEnabled = true;
  }
  return { channel, poolEntries: entries, contentTag };
}

// The channel alone — what the first version of this module returned.
export function compileTemplate(resolved, opts) {
  return compilePreset(resolved, opts).channel;
}

// A channel's per-track card ("artist / song" lower third): null is off.
export function normalizeTrackCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false) return null;
  const seconds = Number(raw.seconds);
  return {
    enabled: true,
    atStart: raw.atStart !== false,
    atEnd: raw.atEnd !== false,
    seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(60, Math.max(2, Math.round(seconds))) : 8,
  };
}

// The match a set of files has in common, for a preset made from a channel
// that was built by hand: the tags every file shares, else a kind they all
// share, else the block or channel name as a text search.
function matchFromFiles(files, fallbackText) {
  const list = files || [];
  const tagSets = list.map((file) => new Set(file.tags || []));
  const commonTags = tagSets.length
    ? [...tagSets[0]].filter((tag) => tagSets.every((set) => set.has(tag)))
    : [];
  if (commonTags.length) return { tags: commonTags };
  const kinds = new Set(list.map((file) => file.kind).filter(Boolean));
  if (list.length && kinds.size === 1) return { kind: [...kinds][0] };
  return { text: fallbackText || '' };
}

export function templateFromChannel(channel, { id = 'saved-channel', name = channel.name || 'Saved channel' } = {}) {
  const slots = {};
  const blocks = channel.blocks || [];
  const programming = blocks.map((block, index) => {
    const key = `slot${index + 1}`;
    slots[key] = { label: block.name || `Block ${index + 1}`, match: matchFromFiles(block.files, block.name || channel.name || ''), min: 1 };
    const trigger = block.trigger || {};
    return { block: trigger.type === 'dateRange'
      ? { dateRange: [trigger.startMonth, trigger.startDay, trigger.endMonth, trigger.endDay], play: { slot: key } }
      : { days: trigger.days || [], hours: [trigger.startHour, trigger.endHour], play: { slot: key } } };
  });
  // A channel with no blocks loops its files 24/7: one slot, no programming.
  if (!blocks.length) {
    slots.loop = { label: channel.name || 'Programs', match: matchFromFiles(channel.files, channel.name || ''), min: 1 };
  }
  const out = {
    templateVersion: 1, id, name, slots,
    channel: { name: channel.name, rating: channel.rating, identity: channel.identity, shuffle: !!channel.shuffle, adsEnabled: channel.adsEnabled !== false },
    programming,
  };
  if (channel.trackCard) out.channel.trackCard = normalizeTrackCard(channel.trackCard);
  const tag = (channel.contentTags || [])[0];
  if (tag) {
    // The channel's own content tag names the ads aimed at it; the preset
    // asks for ads carrying that tag so a rebuild elsewhere finds the same set.
    slots.ads = { label: 'Ads for the breaks', match: { kind: ['commercial', 'bumper'], any: [{ tags: tag }, { text: tag }] }, optional: true };
    out.breaks = { pool: { slot: 'ads' }, contentTag: tag };
  }
  Object.keys(out.channel).forEach((key) => { if (out.channel[key] === undefined) delete out.channel[key]; });
  return validateTemplate(out);
}

// A fresh, editable preset for the creator: one 24/7 slot, nothing matched yet.
export function blankTemplate({ id, name = 'New preset' } = {}) {
  return {
    templateVersion: 1, id: id || `preset-${Date.now().toString(36)}`, name, description: '',
    slots: { programs: { label: 'Programs', match: {}, min: 1 } },
    channel: { name, adsEnabled: true },
    programming: [],
  };
}

// An id a saved preset can use, from its name.
export function slugify(text, fallback = 'preset') {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}

export const __test = { poolEntriesFor, contentSlotIds, matchFromFiles };
