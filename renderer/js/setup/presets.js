// setup › LIBRARY › PRESETS: channel presets and the preset creator
// (docs/design/08). A preset describes a whole channel by intent — slots
// matched against the library, when each airs, what fills the breaks, what
// shows on screen — with no paths. This file lists them, builds channels from
// them, and edits the person's own; the engine is renderer/js/library/
// channel-builder.js and stays DOM-free.
//
// Saved presets live in the library index on the host (`presets`), beside the
// saved queries, so a paired control panel sees the same list. Built-in and
// plugin presets are read-only here: CUSTOMIZE copies one into a saved preset.
import { S, dispatch, viewNow } from '../core/state.js';
import { nextChannelNumber } from '../core/channels.js';
import { channelFilterEl } from '../core/dom.js';
import { randomInterstitialId } from '../core/util.js';
import { Badge, Button, EmptyState } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { h } from '../ui/kit-core.js';
import { alertDialog, confirmDialog, promptDialog } from './dialogs.js';
import { renderChannelList } from './channels.js';
import {
  blankTemplate, compilePreset, listTemplates, normalizeTrackCard, resolveTemplate, slugify, templateFromChannel, templateSource, validateTemplate,
} from '../library/channel-builder.js';
import { ORDER_POLICIES, describeWhere, runQuery, validateWhere } from '../library/query.js';

const KINDS = ['episode', 'movie', 'short', 'commercial', 'bumper', 'music', 'other'];
const ORDER_LABELS = { series: 'Series order', natural: 'By title', shuffle: 'Shuffled (stable)', recent: 'Newest first' };
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SOURCE_LABELS = { builtin: 'Built in', plugin: 'Plugin', saved: 'Yours' };

// What this screen knows about the host's library. Refetched, never patched
// locally: the host is the only writer (same rule as setup/library.js).
const P = {
  loaded: false,
  built: false,
  index: null,
  error: null,
  busy: null,
  editing: null,   // the creator's working copy, see editorFromTemplate()
  notice: '',
};

const root = () => document.getElementById('library-presets-root');

// ---------- Host calls ----------

async function call(method, payload = {}) {
  if (!window.api || typeof window.api.libraryCall !== 'function') throw new Error('The media library is not available on this device.');
  const response = await window.api.libraryCall(method, payload);
  if (!response || !response.ok) throw new Error((response && response.error) || 'The library did not answer.');
  return response.result;
}

async function refresh() {
  try {
    const status = await call('status');
    P.built = !!status.built;
    P.index = P.built ? await call('getIndex') : null;
    P.error = null;
  } catch (e) {
    P.error = e.message;
  }
  P.loaded = true;
  render();
}

async function run(busy, fn) {
  if (P.busy) return;
  P.busy = busy;
  render();
  try {
    await fn();
  } catch (e) {
    await alertDialog(e.message, { variant: 'error' });
  } finally {
    P.busy = null;
    render();
  }
}

// ---------- Small helpers ----------

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const liveItems = () => (P.index ? Object.values(P.index.items || {}).filter((item) => !item.detached) : []);
const savedPresets = () => (P.index && P.index.presets ? Object.values(P.index.presets) : []);

function note(text, tone = '') {
  return h('p', { className: `panel-status library-note${tone ? ` text-${tone}` : ''}`, text, attrs: { role: 'status' } });
}

function table(headers, rows) {
  return h('table', { className: 'library-table' },
    h('thead', {}, h('tr', {}, headers.map((label) => h('th', { text: label, attrs: { scope: 'col' } })))),
    h('tbody', {}, rows));
}

function cell(content, className = '') {
  return h('td', { className }, content);
}

function allPresets() {
  const saved = savedPresets();
  const savedIds = new Set(saved.map((preset) => preset.id));
  // A saved preset with a built-in's id (CUSTOMIZE keeps the id when asked
  // to) replaces the built-in in the list rather than appearing twice.
  return [...listTemplates().filter((template) => !savedIds.has(template.id)), ...saved]
    .map((template) => ({ template, source: savedIds.has(template.id) ? 'saved' : templateSource(template) }));
}

// One line per slot: "Music videos: 212 ready (14.3 hr)" or "needs 10 more".
function slotRows(resolved) {
  return Object.entries(resolved.slots).map(([id, slot]) => {
    const need = slot.spec.optional ? 0 : (slot.spec.min || 1);
    const short = slot.files.length < need;
    return {
      id, short,
      text: `${slot.spec.label}: ${short ? `${slot.files.length} of ${need} needed` : `${plural(slot.files.length, 'program')} · ${slot.hours.toFixed(1)} hr`}`
        + (slot.skipped.length ? ` · ${slot.skipped.length} without a length yet` : '')
        + (slot.spec.optional && !slot.files.length ? ' (optional)' : ''),
    };
  });
}

// ---------- Building a channel from a preset ----------

/**
 * Resolve a preset against the library, preview, and apply it as one channel
 * plus any ad-pool entries its breaks slot adds. Shared with CHANNELS ›
 * + ADD CHANNEL › FROM TEMPLATE and DESCRIBE IT (setup/channels.js).
 */
export async function applyPreset(template) {
  let library;
  try {
    library = await call('getIndex');
  } catch (e) {
    await alertDialog('Build the media catalogue in LIBRARY first, then try this again.', { title: 'LIBRARY NEEDED' });
    return false;
  }
  const resolved = resolveTemplate(template, library);
  const rows = slotRows(resolved).map((row) => `${row.short ? 'NEEDS CONTENT' : 'READY'} · ${row.text}`);
  if (!resolved.ready) {
    await alertDialog(`${rows.join('\n')}\n\nTag or scan more content in LIBRARY, then try again.`, { title: 'PRESET NEEDS CONTENT' });
    return false;
  }
  const existingPool = (S.config.interstitials && S.config.interstitials.pool) || [];
  const { channel, poolEntries, contentTag } = compilePreset(resolved, {
    number: nextChannelNumber(), atMs: viewNow(), existingPool, newId: randomInterstitialId,
  });
  const extras = [];
  extras.push(`${channel.blocks.length ? plural(channel.blocks.length, 'scheduled block') : 'Loops 24/7'} · ${plural(channel.files.length, 'unique program')}.`);
  if (contentTag) {
    extras.push(poolEntries.length
      ? `Adds ${plural(poolEntries.length, 'ad')} to the pool, aimed at this channel by the tag “${contentTag}”.`
      : `Its breaks use ads already tagged “${contentTag}” in the pool.`);
  }
  if (channel.trackCard) extras.push('Shows the artist and song as each video starts and ends.');
  const apply = await confirmDialog({
    title: `PREVIEW CH ${channel.number} — ${channel.name || template.name}`,
    message: `${rows.join('\n')}\n\n${extras.join(' ')} Apply is one undo step.`,
    danger: false, confirmText: 'APPLY CHANNEL', cancelText: 'ADJUST',
  });
  if (!apply) return false;
  // One undo step for the channel and its ads together.
  const coalesce = `preset-apply:${channel.number}:${Date.now()}`;
  const label = `Add CH ${channel.number} from the ${template.name} preset`;
  dispatch({ type: 'channel.insert', channel }, { label, coalesce });
  poolEntries.forEach((entry) => dispatch({ type: 'item.insert', collection: 'pool', item: entry }, { label, coalesce }));
  S.setupSelectedChannel = channel.number;
  S.setupFilterQuery = '';
  if (channelFilterEl) channelFilterEl.value = '';
  renderChannelList();
  P.notice = `Added CH ${channel.number} “${channel.name || template.name}”.`;
  return true;
}

// ---------- The creator's working copy ----------
//
// The form edits a flat copy and converts back to a template on save, so a
// half-typed slot never has to be a valid `where`.

const SLOT_FIELDS = { kind: 'kind', genre: 'facets.genre', era: 'facets.era', series: 'series.name', tags: 'tags', text: 'text' };

function slotFormFromWhere(where = {}) {
  const form = { kind: '', genre: '', era: '', series: '', tags: '', text: '', advanced: false, where };
  Object.entries(where || {}).forEach(([key, value]) => {
    const name = Object.keys(SLOT_FIELDS).find((field) => SLOT_FIELDS[field] === key);
    if (name && (typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string')))) {
      form[name] = Array.isArray(value) ? value.join(', ') : value;
    } else {
      form.advanced = true;
    }
  });
  return form;
}

function listOf(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function slotWhereFromForm(form) {
  if (form.advanced) return form.where;
  const where = {};
  ['kind', 'genre', 'era', 'series', 'tags'].forEach((name) => {
    const values = listOf(form[name]);
    if (values.length === 1) where[SLOT_FIELDS[name]] = values[0];
    else if (values.length > 1) where[SLOT_FIELDS[name]] = values;
  });
  const text = String(form.text || '').trim();
  if (text) where.text = text;
  return where;
}

function editorFromTemplate(template, source) {
  const slots = Object.entries(template.slots).map(([key, spec]) => ({
    key, label: spec.label || key, min: spec.min || 1, optional: !!spec.optional, order: spec.order || 'series',
    ...slotFormFromWhere(spec.match),
  }));
  const programming = (template.programming || []).map(({ block }) => (block.dateRange
    ? { slot: block.play.slot, mode: 'dates', dateRange: [...block.dateRange], days: [], hours: [20, 22] }
    : { slot: block.play.slot, mode: 'weekly', days: [...(block.days || [])], hours: [...block.hours], dateRange: [12, 1, 12, 25] }));
  const breaks = template.breaks && template.breaks.pool ? template.breaks.pool.slot : (template.channel.adsEnabled === false ? 'none' : '');
  const trackCard = normalizeTrackCard(template.channel.trackCard);
  return {
    source,
    id: template.id,
    name: template.name || '',
    description: template.description || '',
    channelName: template.channel.name || '',
    rating: template.channel.rating || '',
    shuffle: !!template.channel.shuffle,
    identity: template.channel.identity || null,
    trackCard: !!trackCard,
    trackSeconds: trackCard ? trackCard.seconds : 8,
    slots,
    programming,
    breaks,
    contentTag: (template.breaks && template.breaks.contentTag) || '',
  };
}

function templateFromEditor(form) {
  const slots = {};
  form.slots.forEach((slot) => {
    const key = slot.key || slugify(slot.label, 'slot');
    const spec = { label: slot.label.trim() || key, match: slotWhereFromForm(slot), min: Math.max(1, Number(slot.min) || 1) };
    if (slot.optional) spec.optional = true;
    if (slot.order && slot.order !== 'series') spec.order = slot.order;
    slots[key] = spec;
    slot.key = key;
  });
  const programming = form.programming.map((row) => ({
    block: row.mode === 'dates'
      ? { dateRange: row.dateRange.map(Number), play: { slot: row.slot } }
      : { days: [...row.days].sort(), hours: [Number(row.hours[0]), Number(row.hours[1])], play: { slot: row.slot } },
  }));
  const channel = { name: form.channelName.trim() || form.name.trim(), shuffle: !!form.shuffle, adsEnabled: form.breaks !== 'none' };
  if (form.rating.trim()) channel.rating = form.rating.trim();
  if (form.identity) channel.identity = form.identity;
  if (form.trackCard) channel.trackCard = normalizeTrackCard({ enabled: true, seconds: form.trackSeconds });
  const out = { templateVersion: 1, id: form.id, name: form.name.trim(), slots, channel, programming };
  if (form.description.trim()) out.description = form.description.trim();
  if (form.breaks && form.breaks !== 'none' && slots[form.breaks]) {
    out.breaks = { pool: { slot: form.breaks }, contentTag: slugify(form.contentTag || form.name, 'preset') };
  }
  return out;
}

// A slot's live match count against the library, for the creator.
function slotCount(slot) {
  const where = slotWhereFromForm(slot);
  if (!Object.keys(where).length) return { empty: true, matched: 0, ready: 0 };
  try {
    validateWhere(where);
    const matched = runQuery(liveItems(), where);
    return { matched: matched.length, ready: matched.filter((item) => item.duration > 0).length };
  } catch (e) {
    return { error: e.message, matched: 0, ready: 0 };
  }
}

// ---------- Actions ----------

function openEditor(template, source) {
  P.editing = editorFromTemplate(template, source);
  render();
  const name = document.getElementById('preset-name');
  if (name) name.focus();
}

function newPreset() {
  openEditor(blankTemplate({ name: 'New preset' }), 'new');
}

// CUSTOMIZE: a copy of a built-in or plugin preset, saved under its own id.
function customize(template) {
  const copy = JSON.parse(JSON.stringify(template));
  copy.id = uniqueId(`${template.id}-mine`);
  copy.name = `${template.name} (mine)`;
  openEditor(copy, 'new');
}

function uniqueId(base) {
  const taken = new Set(allPresets().map(({ template }) => template.id));
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

async function fromChannel() {
  const channels = (S.config.channels || []).filter((ch) => (ch.files || []).length);
  if (!channels.length) { await alertDialog('No channel has any programs yet.', { title: 'NOTHING TO COPY' }); return; }
  const select = h('select', { className: 'block-hour-select', id: 'preset-from-channel' },
    channels.map((ch) => h('option', { value: String(ch.number), text: `CH ${ch.number} ${ch.name || ''}`.trim() })));
  const picked = await Dialog({
    title: 'PRESET FROM A CHANNEL',
    message: 'Copies the channel’s structure — its blocks, ad tag and look — as slots matched by tag or kind. No file paths are kept.',
    body: h('div', { className: 'library-form-field' }, h('label', { text: 'Channel', attrs: { for: 'preset-from-channel' } }), select),
    dismissValue: null,
    actions: [{ label: 'CANCEL', value: null }, { label: 'CONTINUE', variant: 'primary', value: true, isDefault: true }],
  }).result;
  if (!picked) return;
  const ch = channels.find((entry) => String(entry.number) === select.value);
  if (!ch) return;
  const name = ch.name || `Channel ${ch.number}`;
  openEditor(templateFromChannel(ch, { id: uniqueId(slugify(name)), name }), 'new');
}

async function importPreset() {
  await run('import', async () => {
    const imported = await window.api.importConfig();
    if (!imported) return;
    const template = validateTemplate(imported);
    template.id = uniqueId(template.id);
    openEditor(template, 'new');
    P.notice = `Imported “${template.name}”. Check it over, then SAVE.`;
  });
}

async function exportPreset(template) {
  try {
    const filePath = await window.api.exportConfig(template, `${template.id}.rerun-template`);
    if (filePath) P.notice = `Saved to ${filePath}`;
    render();
  } catch (e) {
    await alertDialog(`Export failed: ${e.message}`, { variant: 'error' });
  }
}

async function removePreset(template) {
  const ok = await confirmDialog({ title: 'REMOVE PRESET?', message: `Remove “${template.name}”? Channels already built from it are not touched.`, confirmText: 'REMOVE', danger: true });
  if (!ok) return;
  await run('remove', async () => {
    await call('removePreset', { id: template.id });
    P.notice = `Removed “${template.name}”.`;
    await refresh();
  });
}

async function saveEditing() {
  await run('save', async () => {
    const form = P.editing;
    if (!form.name.trim()) throw new Error('Give the preset a name.');
    if (!form.slots.length) throw new Error('Add at least one slot.');
    form.slots.forEach((slot) => {
      if (!slot.label.trim()) throw new Error('Every slot needs a label.');
      const where = slotWhereFromForm(slot);
      if (!Object.keys(where).length) throw new Error(`“${slot.label}” needs at least one condition.`);
      validateWhere(where);
    });
    form.programming.forEach((row) => {
      if (row.mode === 'weekly' && !row.days.length) throw new Error('A weekly block needs at least one day.');
    });
    if (form.source === 'new' && !form.id) form.id = uniqueId(slugify(form.name));
    const template = validateTemplate(templateFromEditor(form));
    await call('savePreset', { preset: template });
    P.notice = `Saved “${template.name}”.`;
    P.editing = null;
    await refresh();
  });
}

// ---------- Rendering ----------

function field(label, control, { wide = false, help = '' } = {}) {
  return h('div', { className: `library-form-field${wide ? ' preset-field-wide' : ''}` },
    h('label', { text: label, attrs: { for: control.id || null } }), control,
    help ? h('span', { className: 'library-reason', text: help }) : null);
}

function textInput(id, value, onInput, { placeholder = '', list = null, type = 'text', min = null } = {}) {
  const el = h('input', { type, id, value: value == null ? '' : String(value), placeholder, attrs: { list, min } });
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function selectInput(id, value, options, onChange) {
  const el = h('select', { id }, options.map(([v, text]) => h('option', { value: v, text, selected: String(value) === String(v) })));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function checkbox(id, checked, onChange, label) {
  const input = h('input', { type: 'checkbox', id, checked: !!checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { className: 'preset-check' }, input, h('span', { text: label }));
}

function knownValues(read) {
  const values = new Set();
  liveItems().forEach((item) => { const v = read(item); (Array.isArray(v) ? v : [v]).forEach((one) => { if (one) values.add(String(one)); }); });
  return [...values].sort();
}

function datalist(id, values) {
  return h('datalist', { id }, values.map((value) => h('option', { value })));
}

function renderSlotCard(slot, index) {
  const form = P.editing;
  const countEl = h('span', { className: 'library-reason', attrs: { role: 'status' } });
  const updateCount = () => {
    const count = slotCount(slot);
    if (count.error) countEl.textContent = count.error;
    else if (count.empty) countEl.textContent = 'Add a condition to see what matches.';
    else countEl.textContent = `Matches ${plural(count.matched, 'item')}${count.ready < count.matched ? `, ${count.ready.toLocaleString()} ready to air` : ''}.`;
    // The editor's "Ready / Not ready" line depends on every slot's count, so
    // it follows each keystroke here rather than waiting for the next render.
    if (P.updateSummary) P.updateSummary();
  };
  const prefix = `preset-slot-${index}`;
  const conditions = slot.advanced
    ? h('p', { className: 'panel-status', text: `Conditions: ${describeWhere(slot.where)}. This form can’t edit them; the label, order and minimum still can.` })
    : h('div', { className: 'library-form-grid' },
      field('Kind', textInput(`${prefix}-kind`, slot.kind, (v) => { slot.kind = v; updateCount(); }, { placeholder: 'e.g. movie, episode', list: 'preset-known-kinds' }), { help: 'One or more, comma-separated.' }),
      field('Genre', textInput(`${prefix}-genre`, slot.genre, (v) => { slot.genre = v; updateCount(); }, { list: 'preset-known-genres' })),
      field('Era', textInput(`${prefix}-era`, slot.era, (v) => { slot.era = v; updateCount(); }, { placeholder: 'e.g. 1990s', list: 'preset-known-eras' })),
      field('Series', textInput(`${prefix}-series`, slot.series, (v) => { slot.series = v; updateCount(); }, { list: 'preset-known-series' })),
      field('Tags', textInput(`${prefix}-tags`, slot.tags, (v) => { slot.tags = v; updateCount(); }, { placeholder: 'e.g. christmas', list: 'preset-known-tags' })),
      field('Title, series or tag contains', textInput(`${prefix}-text`, slot.text, (v) => { slot.text = v; updateCount(); })));
  const card = h('div', { className: 'library-card preset-slot-card' },
    h('div', { className: 'library-card-title' },
      h('span', { text: `SLOT ${index + 1}` }),
      Badge({ text: slot.optional ? 'OPTIONAL' : 'REQUIRED', tone: slot.optional ? 'default' : 'accent' }),
      h('span', { className: 'preset-grow' }),
      Button({ label: 'REMOVE SLOT', variant: 'quiet', disabled: form.slots.length <= 1, onPress: () => { form.slots.splice(index, 1); form.programming = form.programming.filter((row) => row.slot !== slot.key); if (form.breaks === slot.key) form.breaks = ''; render(); } })),
    h('div', { className: 'library-form-grid' },
      field('Label', textInput(`${prefix}-label`, slot.label, (v) => { slot.label = v; })),
      field('Needs at least', textInput(`${prefix}-min`, slot.min, (v) => { slot.min = Number(v) || 1; updateCount(); }, { type: 'number', min: 1 }), { help: 'Programs that must match before the preset can build.' }),
      field('Order', selectInput(`${prefix}-order`, slot.order, Object.keys(ORDER_POLICIES).map((key) => [key, ORDER_LABELS[key] || key]), (v) => { slot.order = v; })),
      checkbox(`${prefix}-optional`, slot.optional, (v) => { slot.optional = v; render(); }, 'Optional — build even with nothing matched')),
    conditions,
    countEl);
  updateCount();
  return card;
}

function renderProgrammingRow(row, index) {
  const form = P.editing;
  const prefix = `preset-block-${index}`;
  const slotOptions = form.slots.map((slot) => [slot.key, slot.label || slot.key]);
  const hours = Array.from({ length: 24 }, (_, hour) => [String(hour), `${hour}:00`]);
  const ends = Array.from({ length: 24 }, (_, i) => [String(i + 1), `${(i + 1) % 24}:00${i + 1 === 24 ? ' (midnight)' : ''}`]);
  const when = row.mode === 'dates'
    ? h('div', { className: 'preset-dates' },
      ...[['From month', 0, 1, 12], ['day', 1, 1, 31], ['to month', 2, 1, 12], ['day', 3, 1, 31]].map(([label, slotIndex, min, max]) => field(label,
        textInput(`${prefix}-date-${slotIndex}`, row.dateRange[slotIndex], (v) => { row.dateRange[slotIndex] = Math.min(max, Math.max(min, Number(v) || min)); }, { type: 'number', min }))))
    : h('div', { className: 'preset-when' },
      h('div', { className: 'preset-days' }, DAY_LABELS.map((label, day) => checkbox(`${prefix}-day-${day}`, row.days.includes(day), (on) => {
        row.days = on ? [...new Set([...row.days, day])] : row.days.filter((d) => d !== day);
      }, label))),
      field('From', selectInput(`${prefix}-start`, row.hours[0], hours, (v) => { row.hours[0] = Number(v); })),
      field('To', selectInput(`${prefix}-end`, row.hours[1], ends, (v) => { row.hours[1] = Number(v); })));
  return h('div', { className: 'library-card preset-block-card' },
    h('div', { className: 'library-card-title' },
      h('span', { text: `BLOCK ${index + 1}` }),
      h('span', { className: 'preset-grow' }),
      Button({ label: 'REMOVE BLOCK', variant: 'quiet', onPress: () => { form.programming.splice(index, 1); render(); } })),
    h('div', { className: 'library-form-grid' },
      field('Plays', selectInput(`${prefix}-slot`, row.slot, slotOptions, (v) => { row.slot = v; })),
      field('Repeats', selectInput(`${prefix}-mode`, row.mode, [['weekly', 'Every week, on these days'], ['dates', 'Between two dates each year']], (v) => { row.mode = v; render(); }))),
    when);
}

function renderEditor(container) {
  const form = P.editing;
  const summaryEl = h('p', { className: 'panel-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const updateSummary = () => {
    const required = form.slots.filter((slot) => !slot.optional);
    const short = required.filter((slot) => slotCount(slot).ready < (Number(slot.min) || 1));
    summaryEl.textContent = !P.built
      ? 'Build the library in CATALOGUE to see how much of your collection this preset would find.'
      : short.length
        ? `Not ready to build yet: ${short.map((slot) => slot.label || slot.key).join(', ')} ${short.length === 1 ? 'needs' : 'need'} more matching content.`
        : form.programming.length
          ? `Ready. Builds a channel with ${plural(form.programming.length, 'scheduled block')}.`
          : 'Ready. Builds a channel that loops its programs around the clock.';
  };
  P.updateSummary = updateSummary;

  const slotOptions = [['', 'The box-wide ad pool (inherit)'], ['none', 'No ads on this channel'], ...form.slots.map((slot) => [slot.key, `Only ads from “${slot.label || slot.key}”`])];
  const card = h('div', { className: 'library-card library-form preset-editor' },
    h('div', { className: 'library-card-title', text: form.source === 'new' ? 'NEW PRESET' : 'EDIT PRESET' }),
    h('div', { className: 'library-form-grid' },
      field('Preset name', textInput('preset-name', form.name, (v) => { form.name = v; }), { wide: true }),
      field('Channel name', textInput('preset-channel-name', form.channelName, (v) => { form.channelName = v; }, { placeholder: 'Defaults to the preset name' })),
      field('Rating', textInput('preset-rating', form.rating, (v) => { form.rating = v; }, { placeholder: 'e.g. TV-PG' })),
      field('Description', textInput('preset-description', form.description, (v) => { form.description = v; }, { placeholder: 'One line about what this channel is' }), { wide: true })),

    h('h4', { className: 'preset-section', text: 'WHAT IT PLAYS' }),
    h('p', { className: 'panel-status', text: 'Each slot is a search of your library. A preset with no blocks loops every slot around the clock; a block picks one slot for a time of week or a date range.' }),
    ...form.slots.map((slot, index) => renderSlotCard(slot, index)),
    h('div', { className: 'library-actions' },
      Button({ label: 'ADD SLOT', onPress: () => { form.slots.push({ key: uniqueSlotKey(form, 'slot'), label: `Slot ${form.slots.length + 1}`, min: 1, optional: false, order: 'series', ...slotFormFromWhere({}) }); render(); } })),

    h('h4', { className: 'preset-section', text: 'WHEN' }),
    ...(form.programming.length
      ? form.programming.map((row, index) => renderProgrammingRow(row, index))
      : [h('p', { className: 'panel-status', text: 'No blocks: the channel loops 24/7.' })]),
    h('div', { className: 'library-actions' },
      Button({ label: 'ADD BLOCK', onPress: () => { form.programming.push({ slot: form.slots[0].key, mode: 'weekly', days: [1, 2, 3, 4, 5], hours: [20, 22], dateRange: [12, 1, 12, 25] }); render(); } })),

    h('h4', { className: 'preset-section', text: 'BREAKS AND LOOK' }),
    h('div', { className: 'library-form-grid' },
      field('Ads in the breaks', selectInput('preset-breaks', form.breaks, slotOptions, (v) => { form.breaks = v; render(); }),
        { help: 'A slot of ads is added to the pool tagged for this channel only, so a Christmas channel airs only Christmas ads.' }),
      form.breaks && form.breaks !== 'none'
        ? field('Content tag', textInput('preset-content-tag', form.contentTag || slugify(form.name, 'preset'), (v) => { form.contentTag = v; }), { help: 'Ads carrying this tag play here and nowhere else.' })
        : null,
      checkbox('preset-shuffle', form.shuffle, (v) => { form.shuffle = v; }, 'Shuffle the loop order'),
      checkbox('preset-track-card', form.trackCard, (v) => { form.trackCard = v; render(); }, 'Show the artist and song as each video starts and ends'),
      form.trackCard ? field('Card stays for (seconds)', textInput('preset-track-seconds', form.trackSeconds, (v) => { form.trackSeconds = Number(v) || 8; }, { type: 'number', min: 2 })) : null),

    datalist('preset-known-kinds', KINDS),
    datalist('preset-known-genres', knownValues((item) => item.facets && item.facets.genre)),
    datalist('preset-known-eras', knownValues((item) => item.facets && item.facets.era)),
    datalist('preset-known-series', knownValues((item) => item.series && item.series.name)),
    datalist('preset-known-tags', knownValues((item) => item.tags)),
    summaryEl,
    h('div', { className: 'library-actions' },
      Button({ label: 'SAVE PRESET', variant: 'primary', disabled: !!P.busy, onPress: saveEditing }),
      Button({ label: 'BUILD WITHOUT SAVING…', disabled: !!P.busy || !P.built, onPress: async () => {
        try { await applyPreset(validateTemplate(templateFromEditor(form))); render(); } catch (e) { await alertDialog(e.message, { variant: 'error' }); }
      } }),
      Button({ label: 'CANCEL', variant: 'quiet', onPress: () => { P.editing = null; render(); } })));
  updateSummary();
  container.appendChild(card);
}

function uniqueSlotKey(form, base) {
  const taken = new Set(form.slots.map((slot) => slot.key));
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}${n++}`;
  return key;
}

function renderList(container) {
  container.appendChild(h('div', { className: 'library-actions' },
    Button({ label: 'NEW PRESET', variant: 'primary', id: 'library-presets-new-btn', disabled: !!P.busy, onPress: newPreset }),
    Button({ label: 'FROM A CHANNEL…', disabled: !!P.busy, onPress: fromChannel }),
    Button({ label: 'IMPORT FILE…', disabled: !!P.busy, onPress: importPreset })));
  if (!P.built) container.appendChild(note('Build the library in CATALOGUE to see which presets your collection can fill. Presets can still be made and saved now.'));

  const items = liveItems();
  const rows = allPresets().map(({ template, source }) => {
    let readiness = h('span', { className: 'library-reason', text: 'Library not built' });
    if (P.built) {
      try {
        const resolved = resolveTemplate(template, { items: Object.fromEntries(items.map((item) => [item.id, item])) });
        const lines = slotRows(resolved);
        readiness = h('div', {},
          Badge({ text: resolved.ready ? 'READY' : 'NEEDS CONTENT', tone: resolved.ready ? 'success' : 'warning' }),
          ...lines.map((line) => h('div', { className: 'library-reason', text: line.text })));
      } catch (e) {
        readiness = h('span', { className: 'library-reason', text: e.message });
      }
    }
    const programming = template.programming || [];
    const shape = [
      programming.length ? plural(programming.length, 'block') : '24/7 loop',
      template.breaks && template.breaks.pool ? 'own ads' : null,
      template.channel && template.channel.trackCard ? 'artist / song card' : null,
    ].filter(Boolean).join(' · ');
    return h('tr', {},
      cell(h('div', {},
        h('strong', { text: template.name }),
        h('div', { className: 'library-reason', text: template.description || shape }),
        template.description ? h('div', { className: 'library-reason', text: shape }) : null)),
      cell(SOURCE_LABELS[source] || source),
      cell(readiness),
      cell(h('div', { className: 'library-row-actions' },
        Button({ label: 'BUILD CHANNEL…', disabled: !!P.busy || !P.built, onPress: () => run(`build:${template.id}`, () => applyPreset(template)), attrs: { 'aria-label': `Build a channel from ${template.name}` } }),
        source === 'saved'
          ? Button({ label: 'EDIT', variant: 'quiet', disabled: !!P.busy, onPress: () => openEditor(template, 'saved'), attrs: { 'aria-label': `Edit ${template.name}` } })
          : Button({ label: 'CUSTOMIZE', variant: 'quiet', disabled: !!P.busy, onPress: () => customize(template), attrs: { 'aria-label': `Customize ${template.name}` } }),
        Button({ label: 'EXPORT…', variant: 'quiet', disabled: !!P.busy, onPress: () => exportPreset(template), attrs: { 'aria-label': `Export ${template.name}` } }),
        source === 'saved'
          ? Button({ label: 'REMOVE', variant: 'quiet', disabled: !!P.busy, onPress: () => removePreset(template), attrs: { 'aria-label': `Remove ${template.name}` } })
          : null)));
  });
  container.appendChild(table(['Preset', 'Source', 'Your library', ''], rows));
}

function render() {
  const container = root();
  if (!container) return;
  container.replaceChildren();
  if (!P.loaded) { container.appendChild(EmptyState({ message: 'Loading presets…' })); return; }
  if (P.error) container.appendChild(note(P.error, 'error'));
  if (P.notice) container.appendChild(note(P.notice));
  if (P.editing) renderEditor(container);
  else renderList(container);
}

// Called from renderLibraryPanels (setup/library.js) whenever the setup
// screen opens or config is replaced. Draws what it has, then refetches.
export function renderPresetsPanel() {
  render();
  refresh();
}

/** Built-in, plugin and saved presets, for CHANNELS › + ADD CHANNEL. */
export async function listAllPresets() {
  try {
    const status = await call('status');
    if (status.built) {
      const index = await call('getIndex');
      P.index = index;
      P.built = true;
    }
  } catch (e) { /* no library: built-ins only */ }
  return allPresets().map(({ template }) => template);
}

document.querySelector('[data-subtab="librarypresets"]')?.addEventListener('click', () => refresh());
