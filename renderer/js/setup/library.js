// setup › LIBRARY: CATALOGUE, REVIEW and SMART CHANNELS (docs/design/07).
//
// The catalogue lives on the host (main/library/service.js) and is reached
// through window.api.libraryCall — IPC in the Electron window, the control
// route on a paired LAN panel. Everything that decides something is a pure
// module under renderer/js/library/; this file asks, previews and records.
//
// Two rules from the doc shape every flow here:
//   * C6: what airs changes only through channel.rematerialize or the migration
//     patch, and always after a preview a person has seen. Tagging and scanning
//     change the catalogue, never a playlist.
//   * Nothing on disk is moved, renamed or deleted. UPDATE LOCATION rewrites
//     path text for files the person already moved.
import { S, commitConfigPatch, commitInPlace, dispatch, viewNow } from '../core/state.js';
import { freshChannel, parseMediaRef } from '../core/channels.js';
import { channelFilterEl } from '../core/dom.js';
import { diffSchedules, querySchedule } from '../core/schedule-query.js';
import { Badge, Button, EmptyState } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { h } from '../ui/kit-core.js';
import { alertDialog, confirmDialog, promptDialog } from './dialogs.js';
import { beginTask } from './tasks.js';
import { probeDurationForEntry } from './util.js';
import { renderChannelList } from './channels.js';
import { MIGRATION_WINDOW_DAYS, applyMigrationIds, verifyMigrationPlan } from '../library/migration.js';
import { acceptGroup, suggestGroups } from '../library/tagging.js';
import { ORDER_POLICIES, buildWhere, describeWhere, formFromWhere, planChannelFiles, runQuery, validateWhere } from '../library/query.js';
import { airingDiffIgnoringPaths, applyRootMoveInPlace, planRootMove } from '../library/root-move.js';
import { scheduleClockFor } from '../library/sync.js';
import { renderPresetsPanel } from './presets.js';

const DAY_MS = 24 * 3600 * 1000;
const PREVIEW_DAYS = 7;
const ROOT_MOVE_PREVIEW_DAYS = 14;
const KINDS = ['episode', 'movie', 'short', 'commercial', 'bumper', 'music', 'other'];
const ORDER_LABELS = { series: 'Series order', natural: 'By title', shuffle: 'Shuffled (stable)', recent: 'Newest first' };

// What this screen knows about the host's library. Refetched, never patched
// locally: the host is the only writer.
const L = {
  loaded: false,
  status: null,
  index: null,
  scans: {},
  error: null,
  busy: null,        // one long action at a time: 'check' | 'build' | 'scan:<root>' | …
  check: null,       // the migration check: { progress } while running, then { rows, plan, … }
  editing: null,     // the saved-query form: { id, name, order, kind, genre, era, series, text, advanced }
  itemSearch: '',    // CATALOGUE's "find an item" box (§8: single-item editor)
  openGroups: new Set(),
  excluded: new Map(), // group key -> Set of item ids left unticked
  notice: { catalogue: '', review: '', smart: '' },
};

const roots = {
  catalogue: () => document.getElementById('library-catalogue-root'),
  reviewScan: () => document.getElementById('library-review-scan-root'),
  reviewTags: () => document.getElementById('library-review-tags-root'),
  smart: () => document.getElementById('library-smart-root'),
};

// ---------- Host calls ----------

async function call(method, payload = {}) {
  if (!window.api || typeof window.api.libraryCall !== 'function') throw new Error('The media library is not available on this device.');
  const response = await window.api.libraryCall(method, payload);
  if (!response || !response.ok) throw new Error((response && response.error) || 'The library did not answer.');
  return response.result;
}

async function refresh() {
  try {
    L.status = await call('status');
    L.index = L.status.built ? await call('getIndex') : null;
    L.scans = L.status.built ? (await call('lastScan')) || {} : {};
    L.error = null;
  } catch (e) {
    L.error = e.message;
  }
  L.loaded = true;
  renderAll();
}

// Runs one long action, reporting failures in a dialog and never leaving the
// screen stuck busy.
async function run(busy, fn) {
  if (L.busy) return;
  L.busy = busy;
  renderAll();
  try {
    await fn();
  } catch (e) {
    await alertDialog(e.message, { variant: 'error' });
  } finally {
    L.busy = null;
    renderAll();
  }
}

// ---------- Small helpers ----------

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const basename = (ref) => String(ref || '').split(/[\\/]/).pop();
const itemLabel = (item) => (item && (item.title || basename(item.ref))) || 'Unknown item';
const liveItems = () => (L.index ? Object.values(L.index.items).filter((item) => !item.detached) : []);
const smartChannels = () => (S.config.channels || []).filter((ch) => (ch.sources || []).some((s) => s && s.type === 'query'));

// Whether config still says what it said when a plan was made. The generation
// is the cheap test; when it moved, the content decides, because background
// writes that change nothing a schedule reads — a library sync's bookkeeping
// on its 30-minute timer, the last channel tuned — bump it too, and must not
// throw away minutes of checking.
const WATCH_STATE = new Set(['librarySync', 'lastChannel', 'muted', 'volume', 'pictureMode', 'aspectMode']);
function configSignature() {
  return JSON.stringify(S.config, (key, value) => (WATCH_STATE.has(key) ? undefined : value));
}
function configGuard() {
  let generation = S.configGeneration;
  const signature = configSignature();
  return {
    changed() {
      if (S.configGeneration === generation) return false;
      if (configSignature() !== signature) return true;
      generation = S.configGeneration;
      return false;
    },
  };
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

function programTitle(entry) {
  if (!entry || !entry.file) return 'nothing';
  return `“${entry.file.title || basename(entry.file.path)}”`;
}

function programAt(channel, atMs) {
  return querySchedule(channel, atMs, atMs + 1, { breaks: false, offAir: false }).programs[0] || null;
}

function playlistKey(files) {
  return JSON.stringify((files || []).map((file) => [file.item || file.path, Math.round((file.duration || 0) * 1000)]));
}

// Durations are read by the renderer (a <video> element or the provider's
// probe) and sent back. An unreadable file stays without one rather than
// getting a guess: smart channels skip it until it can be read.
async function probeDurations(itemIds, task) {
  if (!itemIds || !itemIds.length) return { read: 0, failed: 0 };
  const index = await call('getIndex');
  const updates = [];
  for (let i = 0; i < itemIds.length; i += 1) {
    const item = index.items[itemIds[i]];
    if (!item) continue;
    task.update(`READING DURATIONS ${i + 1} / ${itemIds.length}…`);
    const { source, ref } = parseMediaRef(item.ref);
    // eslint-disable-next-line no-await-in-loop
    const duration = await probeDurationForEntry(source, ref, { fallback: null });
    if (Number.isFinite(duration) && duration > 0) updates.push({ id: item.id, fields: { duration } });
  }
  if (updates.length) await call('applyItemUpdates', { updates });
  return { read: updates.length, failed: itemIds.length - updates.length };
}

// ---------- CATALOGUE: building the library ----------

async function checkChannels({ replace = false } = {}) {
  await run('check', async () => {
    const task = beginTask('CHECKING CHANNELS FOR THE LIBRARY…');
    const guard = configGuard();
    L.check = { progress: 'Planning…', replace };
    renderCatalogue();
    try {
      const original = JSON.parse(JSON.stringify(S.config));
      const plan = await call('planMigration', { config: original });
      const fromMs = viewNow();
      const { verdicts, rows } = await verifyMigrationPlan(plan, {
        fromMs,
        isStale: () => guard.changed(),
        onProgress: ({ channel, index, count, day, days }) => {
          const text = `Checking CH ${channel} (${index + 1} of ${count}) · day ${day + 1} of ${days}…`;
          L.check.progress = text;
          task.update(text.toUpperCase());
          const el = document.getElementById('library-check-progress');
          if (el) el.textContent = text;
        },
      });
      L.check = { rows, verdicts, plan, original, guard, fromMs, replace };
    } catch (e) {
      L.check = null;
      throw e;
    } finally {
      task.end();
    }
  });
}

async function buildLibrary() {
  await run('build', async () => {
    const check = L.check;
    if (!check || !check.plan) return;
    if (check.guard.changed()) {
      L.check = null;
      throw new Error('Channels changed after they were checked. Check them again.');
    }
    const task = beginTask('BUILDING THE MEDIA LIBRARY…');
    try {
      const final = await call('finalizeMigration', { original: check.original, plan: check.plan, verdicts: check.verdicts });
      if (!final.accepted.length) throw new Error('No channel can join the library without changing what it airs.');
      // The library first: if saving it fails, nothing in config refers to it.
      await call('commitMigration', { index: final.index, replace: !!check.replace });
      // Paths are re-checked here, all or nothing, so a change that landed
      // during the save cannot receive ids for the wrong files.
      applyMigrationIds(S.config, final.config, final.accepted);
      commitConfigPatch('Build media library');
      const skipped = final.rejected.length ? ` ${plural(final.rejected.length, 'channel')} stayed as they were.` : '';
      L.notice.catalogue = `Built from ${plural(final.accepted.length, 'channel')}: ${plural(Object.keys(final.index.items).length, 'item')} in ${plural(final.index.roots.length, 'location')}. Nothing that airs changed.${skipped}`;
      L.check = null;
    } finally {
      task.end();
    }
    await refresh();
  });
}

function renderCheck(root) {
  const check = L.check;
  if (!check) return;
  if (!check.rows) {
    root.appendChild(h('p', { id: 'library-check-progress', className: 'panel-status', text: check.progress, attrs: { role: 'status', 'aria-live': 'polite' } }));
    return;
  }
  const accepted = check.rows.filter((row) => row.identical);
  root.appendChild(table(['CH', 'Name', 'Files', `Next ${MIGRATION_WINDOW_DAYS} days`], check.rows.map((row) => h('tr', {},
    cell(String(row.number)),
    cell(row.name || '—'),
    cell(row.files.toLocaleString(), 'num'),
    cell(row.identical
      ? 'Airs identically'
      : `Would change from ${new Date(row.firstChange).toLocaleString()} — stays as it is`, row.identical ? 'text-success' : 'text-warning'),
  ))));
  const actions = h('div', { className: 'library-actions' });
  if (accepted.length) {
    actions.appendChild(Button({
      label: `BUILD LIBRARY (${plural(accepted.length, 'CHANNEL')})`, variant: 'primary', disabled: !!L.busy,
      onPress: buildLibrary,
    }));
  }
  actions.appendChild(Button({ label: 'CHECK AGAIN', disabled: !!L.busy, onPress: () => checkChannels({ replace: check.replace }) }));
  root.appendChild(actions);
  if (!accepted.length) root.appendChild(note('No channel can join without changing what it airs, so nothing will be built.', 'warning'));
}

// ---------- CATALOGUE: roots ----------

async function scanRoot(rootEntry) {
  await run(`scan:${rootEntry.id}`, async () => {
    const label = basename(rootEntry.ref) || rootEntry.ref;
    const task = beginTask(`SCANNING ${label.toUpperCase()}…`);
    const poll = setInterval(() => {
      call('status').then((status) => {
        if (status.scanning && status.scanning.total) task.update(`SCANNING ${label.toUpperCase()} · ${status.scanning.done} / ${status.scanning.total}`);
      }).catch(() => {});
    }, 700);
    let summary;
    try {
      summary = await call('scanRoot', { rootId: rootEntry.id });
      clearInterval(poll);
      const durations = await probeDurations(summary.needsDuration, task);
      const parts = [`${label}: ${summary.text}.`];
      if (durations.failed) parts.push(`${plural(durations.failed, 'new file')} could not be read and won’t air until they can.`);
      const waiting = summary.review.ambiguous.length + summary.review.replaced.length;
      if (waiting) parts.push(`${plural(waiting, 'file')} waiting in REVIEW.`);
      const rebuilt = await rebuildSmartChannelsUnattended();
      if (rebuilt && rebuilt.rebuilt.length) parts.push(`Rebuilt CH ${rebuilt.rebuilt.join(', ')}.`);
      if (rebuilt && rebuilt.waiting.length) parts.push(`CH ${rebuilt.waiting.join(', ')} would change what’s on now — rebuild in SMART CHANNELS.`);
      L.notice.catalogue = parts.join(' ');
    } finally {
      clearInterval(poll);
      task.end();
    }
    await refresh();
  });
}

async function updateLocation(rootEntry) {
  await run(`move:${rootEntry.id}`, async () => {
    const from = await promptDialog({
      title: 'UPDATE LOCATION',
      message: 'Moved these files yourself? Enter where they used to be — the part of the path that changed. RerunTV does not move anything on disk.',
      defaultValue: rootEntry.ref,
    });
    if (!from) return;
    const to = await promptDialog({
      title: 'UPDATE LOCATION',
      message: `And where are they now? Every channel folder, playlist entry and library item under ${from} will point there instead.`,
      defaultValue: from,
    });
    if (!to || to === from) return;

    const guard = configGuard();
    const plan = planRootMove(S.config, L.index, { from, to });
    const { counts } = plan;
    if (!counts.folders && !counts.files && !counts.items) throw new Error(`Nothing in your channels or library is under ${from}.`);

    const task = beginTask('CHECKING THE MOVE…');
    const changed = [];
    try {
      const fromMs = viewNow();
      const toMs = fromMs + ROOT_MOVE_PREVIEW_DAYS * DAY_MS;
      for (let i = 0; i < (S.config.channels || []).length; i += 1) {
        const live = S.config.channels[i];
        const planned = plan.config.channels[i];
        if (JSON.stringify(live.files) === JSON.stringify(planned.files) && JSON.stringify(live.blocks) === JSON.stringify(planned.blocks)) continue;
        task.update(`CHECKING CH ${live.number}…`);
        if (!airingDiffIgnoringPaths(live, planned, fromMs, toMs).identical) changed.push(live.number);
        // eslint-disable-next-line no-await-in-loop
        await yieldToUi();
      }
    } finally {
      task.end();
    }
    // A path rewrite cannot change what airs. If it would, something else is
    // going on, and applying it anyway is not a decision to make in a dialog.
    if (changed.length) throw new Error(`This would change what CH ${changed.join(', ')} airs, so nothing was updated.`);

    const [exists] = await window.api.checkPathsExist([{ source: 'local', ref: to }]);
    const ok = await confirmDialog({
      title: 'UPDATE LOCATION?',
      message: `${plural(counts.files, 'playlist entry', 'playlist entries')} on ${plural(counts.channels, 'channel')}, ${plural(counts.folders, 'folder')} and ${plural(counts.items, 'library item')} will point to ${to}. `
        + `Checked over the next ${ROOT_MOVE_PREVIEW_DAYS} days: the same programmes air at the same times.`
        + (exists ? '' : ` ${to} can’t be reached right now — channels will show missing files until it can.`),
      danger: !exists,
      confirmText: 'UPDATE LOCATION',
    });
    if (!ok) return;
    if (guard.changed()) throw new Error('Channels changed while you were deciding. Nothing was updated; try again.');
    if (plan.index) await call('moveRoot', { index: plan.index });
    applyRootMoveInPlace(S.config, { from, to });
    commitConfigPatch('Move library location');
    renderChannelList();
    L.notice.catalogue = `Moved ${from} to ${to}. Scan the location to confirm the files are there.`;
    await refresh();
  });
}

function renderRoots(root) {
  const counts = new Map();
  liveItems().forEach((item) => counts.set(item.root, (counts.get(item.root) || 0) + 1));
  const rows = L.status.roots.map((entry) => {
    const scan = L.scans[entry.id];
    const actions = h('div', { className: 'library-row-actions' },
      Button({ label: 'SCAN', disabled: !!L.busy, onPress: () => scanRoot(entry), attrs: { 'aria-label': `Scan ${entry.ref}` } }));
    if (entry.kind !== 'provider') {
      actions.appendChild(Button({ label: 'UPDATE LOCATION…', variant: 'quiet', disabled: !!L.busy, onPress: () => updateLocation(entry), attrs: { 'aria-label': `Update location of ${entry.ref}` } }));
    }
    actions.appendChild(Button({ label: 'FORGET…', variant: 'quiet', disabled: !!L.busy, onPress: () => removeRootEntry(entry), attrs: { 'aria-label': `Forget ${entry.ref}` } }));
    const busyHere = L.busy === `scan:${entry.id}`;
    return h('tr', {},
      cell(h('span', { className: 'library-ref', text: entry.label || entry.ref, attrs: { title: entry.ref } })),
      cell((counts.get(entry.id) || 0).toLocaleString(), 'num'),
      cell(busyHere ? 'Scanning…' : scan ? `${new Date(scan.at).toLocaleString()} — ${scan.text}` : 'Not scanned yet'),
      cell(actions));
  });
  root.appendChild(table(['Location', 'Items', 'Last scan', ''], rows));
}

// docs/design/07 §8: "no UI yet to remove a root or an item". Items are left
// behind on purpose (store.removeRoot's own comment) — a root is often
// removed because a drive is temporarily unplugged, and dropping every item
// would throw away tags and review decisions attached to them.
async function removeRootEntry(entry) {
  const count = liveItems().filter((item) => item.root === entry.id).length;
  const ok = await confirmDialog({
    message: `Forget "${entry.label || entry.ref}"? ${count ? `${plural(count, 'item')} stay in the library without a location — reconnect and rescan later, or remove them one at a time from the item search below.` : 'It has no catalogued items.'}`,
    danger: true, confirmText: 'FORGET LOCATION',
  });
  if (!ok) return;
  await run(`remove-root:${entry.id}`, async () => {
    await call('removeRoot', { id: entry.id });
    L.notice.catalogue = `Forgot ${entry.label || entry.ref}.`;
    await refresh();
  });
}

// The single-item editor (doc §8): title, kind, series, genre/era facets,
// rating and tags. Saved fields get `provenance: 'user'`, so no later
// automatic tagging pass ever overwrites a hand edit (§5's own rule).
function itemEditorBody(item) {
  const titleInput = h('input', { type: 'text', className: 'title-row-input', value: item.title || '' });
  const kindSelect = h('select', {}, ...(item.kind && !KINDS.includes(item.kind) ? [item.kind] : []).concat(KINDS).map((k) => h('option', { value: k, text: k, selected: item.kind === k })));
  const seriesNameInput = h('input', { type: 'text', className: 'title-row-input', value: (item.series && item.series.name) || '' });
  const seasonInput = h('input', { type: 'number', min: '0', value: (item.series && item.series.season != null) ? String(item.series.season) : '' });
  const episodeInput = h('input', { type: 'number', min: '0', value: (item.series && item.series.episode != null) ? String(item.series.episode) : '' });
  const genreInput = h('input', { type: 'text', className: 'title-row-input', value: fieldValue((item.facets && item.facets.genre) || []) });
  const eraInput = h('input', { type: 'text', className: 'title-row-input', value: fieldValue((item.facets && item.facets.era) || []) });
  const ratingInput = h('input', { type: 'text', className: 'title-row-input', value: item.rating || '' });
  const tagsInput = h('input', { type: 'text', className: 'title-row-input', value: fieldValue(item.tags || []) });
  // Music videos: what the artist / song card shows (playback/track-card.js).
  const artistInput = h('input', { type: 'text', className: 'title-row-input', value: item.artist || '' });
  const albumInput = h('input', { type: 'text', className: 'title-row-input', value: item.album || '' });
  const row = (label, input) => h('label', { className: 'library-editor-row' }, h('span', { className: 'library-editor-row-label', text: label }), input);
  const body = h('div', { className: 'library-editor-form' },
    row('Title', titleInput), row('Kind', kindSelect),
    row('Series name', seriesNameInput), row('Season', seasonInput), row('Episode', episodeInput),
    row('Artist (music videos)', artistInput), row('Album', albumInput),
    row('Genre (comma-separated)', genreInput), row('Era (comma-separated)', eraInput),
    row('Rating', ratingInput), row('Tags (comma-separated)', tagsInput));
  return {
    body,
    read: () => {
      const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);
      const fields = {
        title: titleInput.value.trim(),
        kind: kindSelect.value,
        rating: ratingInput.value.trim(),
        tags: list(tagsInput.value),
        artist: artistInput.value.trim(),
        album: albumInput.value.trim(),
        facets: { ...(item.facets || {}), genre: list(genreInput.value), era: list(eraInput.value) },
        provenance: { ...(item.provenance || {}), title: 'user', kind: 'user', genre: 'user', era: 'user', rating: 'user', tags: 'user', artist: 'user', album: 'user' },
      };
      const seriesName = seriesNameInput.value.trim();
      if (seriesName) {
        fields.series = { ...(item.series || {}), name: seriesName };
        if (seasonInput.value !== '') fields.series.season = Number(seasonInput.value);
        if (episodeInput.value !== '') fields.series.episode = Number(episodeInput.value);
        fields.provenance.series = 'user';
      } else if (item.series) {
        // Blank series name clears the series instead of silently keeping the old one.
        fields.series = null;
        fields.provenance.series = 'user';
      }
      return fields;
    },
  };
}

async function openItemEditor(item) {
  const { body, read } = itemEditorBody(item);
  const saved = await Dialog({
    title: 'EDIT ITEM',
    message: basename(item.ref),
    kind: 'prompt',
    body,
    dismissValue: null,
    actions: [{ label: 'CANCEL', value: null }, { label: 'SAVE', variant: 'primary', value: true }],
  }).result;
  if (!saved) return;
  const fields = read();
  await run(`edit-item:${item.id}`, async () => {
    await call('applyItemUpdates', { updates: [{ id: item.id, fields }] });
    L.notice.catalogue = `Updated ${itemLabel(item)}.`;
    await refresh();
  });
}

async function removeItemEntry(item) {
  const ok = await confirmDialog({
    message: `Remove "${itemLabel(item)}" from the library? Its tags and review history are lost. A channel that has already used it keeps playing it exactly as it does now — this only removes it as a future candidate for smart channels and tagging.`,
    danger: true, confirmText: 'REMOVE',
  });
  if (!ok) return;
  await run(`remove-item:${item.id}`, async () => {
    await call('removeItem', { id: item.id });
    L.notice.catalogue = `Removed ${itemLabel(item)}.`;
    await refresh();
  });
}

function renderItemSearch(root) {
  const wrap = h('div', { className: 'library-item-search' });
  const resultsEl = h('div', { className: 'library-item-search-results' });
  const input = h('input', {
    type: 'search', className: 'title-row-input', placeholder: 'FIND AN ITEM BY TITLE OR FILENAME…', value: L.itemSearch,
  });
  input.addEventListener('input', () => { L.itemSearch = input.value; renderItemSearchResults(resultsEl); });
  wrap.append(h('label', { className: 'library-editor-row' }, h('span', { className: 'library-editor-row-label', text: 'Edit or remove an item' }), input), resultsEl);
  root.appendChild(wrap);
  renderItemSearchResults(resultsEl);
}

function renderItemSearchResults(container) {
  container.replaceChildren();
  const term = (L.itemSearch || '').trim().toLowerCase();
  if (!term) return;
  const matches = liveItems().filter((item) => itemLabel(item).toLowerCase().includes(term) || basename(item.ref).toLowerCase().includes(term)).slice(0, 25);
  if (!matches.length) { container.appendChild(note('No items match.')); return; }
  const rows = matches.map((item) => h('tr', {},
    cell(h('span', { text: itemLabel(item), attrs: { title: item.ref } })),
    cell(fieldValue(item.tags || [])),
    cell(h('div', { className: 'library-row-actions' },
      Button({ label: 'EDIT…', variant: 'quiet', onPress: () => openItemEditor(item) }),
      Button({ label: 'REMOVE', variant: 'quiet', onPress: () => removeItemEntry(item) })))));
  container.appendChild(table(['Item', 'Tags', ''], rows));
  if (matches.length === 25) container.appendChild(note('Showing the first 25 matches — narrow the search for more.'));
}

function renderCatalogue() {
  const root = roots.catalogue();
  if (!root) return;
  root.replaceChildren();
  if (!L.loaded) { root.appendChild(note('Loading the library…')); return; }
  if (L.error) { root.appendChild(note(L.error, 'error')); return; }
  if (L.notice.catalogue) root.appendChild(note(L.notice.catalogue));
  if (L.status.loadError) root.appendChild(note(`The library file could not be read (${L.status.loadError}). Its contents were kept beside it and a fresh library was started.`, 'warning'));

  if (!L.status.built) {
    root.appendChild(h('p', { className: 'panel-status', text: 'The library catalogues each file your channels use once, so series, tags and saved queries are shared by every channel that plays it. Building it only adds a library id to each playlist entry — paths, lengths, order and what airs stay exactly the same.' }));
    root.appendChild(h('p', { className: 'panel-status', text: `Each channel is checked over the next ${MIGRATION_WINDOW_DAYS} days first, ad breaks included. A channel whose schedule would change in any way is left out as it is.` }));
    if (!L.check) {
      root.appendChild(h('div', { className: 'library-actions' },
        Button({ label: 'CHECK MY CHANNELS', variant: 'primary', disabled: !!L.busy, onPress: () => checkChannels() })));
    }
    renderCheck(root);
    return;
  }

  const { stats } = L.status;
  const detached = L.index ? Object.values(L.index.items).length - liveItems().length : 0;
  root.appendChild(h('div', { className: 'library-stats' },
    Badge({ text: plural(stats.items - detached, 'item') }),
    Badge({ text: plural(stats.roots, 'location') }),
    Badge({ text: plural(stats.queries, 'saved query', 'saved queries') }),
    L.status.orphaned ? Badge({ text: `${plural(L.status.orphaned, 'item')} without a location`, tone: 'warning' }) : null));

  // A library with no channel linked to it: the last build saved the library
  // but did not reach config (or it was undone). Offer to build again.
  const linked = (S.config.channels || []).some((ch) => (ch.files || []).some((file) => file.item));
  if (!linked && !L.check) {
    root.appendChild(note('No channel is linked to this library — the last build did not finish, or it was undone. Building again replaces the library’s items; tags accepted since would be lost.', 'warning'));
    root.appendChild(h('div', { className: 'library-actions' },
      Button({ label: 'CHECK MY CHANNELS AGAIN', disabled: !!L.busy, onPress: () => checkChannels({ replace: true }) })));
  }
  renderCheck(root);
  root.appendChild(h('p', { className: 'panel-status', text: 'A scan reads one location: new files are catalogued, moved files are followed, and anything it can’t be sure about waits in REVIEW. Missing files are reported, never removed.' }));
  renderRoots(root);
  renderItemSearch(root);
}

// ---------- REVIEW: scan decisions ----------

async function resolveReview(rootId, decision) {
  await run('review', async () => {
    const task = beginTask('SAVING REVIEW DECISION…');
    try {
      const result = await call('resolveReview', { rootId, ...decision });
      await probeDurations(result.needsDuration, task);
      L.notice.review = result.remaining ? `${plural(result.remaining, 'file')} still waiting for this location.` : 'Nothing left to review for this location.';
    } finally {
      task.end();
    }
    await refresh();
  });
}

function renderScanReview() {
  const root = roots.reviewScan();
  if (!root) return;
  root.replaceChildren();
  if (!L.loaded) return;
  if (L.error) { root.appendChild(note(L.error, 'error')); return; }
  if (!L.status.built) { root.appendChild(EmptyState({ message: 'Build the library in CATALOGUE first.' })); return; }
  if (L.notice.review) root.appendChild(note(L.notice.review));

  let waiting = 0;
  Object.entries(L.scans).forEach(([rootId, report]) => {
    if (!report || !report.review) return;
    const where = basename(report.ref) || report.ref;
    report.review.ambiguous.forEach((entry) => {
      waiting += 1;
      const card = h('div', { className: 'library-card' },
        h('div', { className: 'library-card-title', text: basename(entry.ref) }),
        h('p', { className: 'panel-status', text: `In ${where}. Its content matches more than one catalogued item, so it wasn’t linked to any. Which is it?` }));
      const actions = h('div', { className: 'library-actions' });
      entry.items.forEach((itemId) => {
        const item = L.index.items[itemId];
        actions.appendChild(Button({
          label: `IT’S ${itemLabel(item).toUpperCase()}`, disabled: !!L.busy,
          title: item ? item.ref : itemId,
          onPress: () => resolveReview(rootId, { kind: 'ambiguous', ref: entry.ref, itemId }),
        }));
      });
      card.appendChild(actions);
      root.appendChild(card);
    });
    report.review.replaced.forEach((entry) => {
      waiting += 1;
      const item = L.index.items[entry.item];
      root.appendChild(h('div', { className: 'library-card' },
        h('div', { className: 'library-card-title', text: basename(entry.ref) }),
        h('p', { className: 'panel-status', text: `In ${where}. The file at this path is different from the one catalogued as ${itemLabel(item)}. Is it the same programme (a re-encode or a better copy) or something else?` }),
        h('div', { className: 'library-actions' },
          Button({ label: 'SAME PROGRAMME — KEEP ITS DETAILS', disabled: !!L.busy, onPress: () => resolveReview(rootId, { kind: 'replaced', itemId: entry.item, keep: true }) }),
          Button({ label: 'SOMETHING ELSE — CATALOGUE AS NEW', variant: 'quiet', disabled: !!L.busy, onPress: () => resolveReview(rootId, { kind: 'replaced', itemId: entry.item, keep: false }) }))));
    });
    if (report.missing && report.missing.length) {
      root.appendChild(note(`${plural(report.missing.length, 'catalogued file')} weren’t found in ${where} on the last scan. They are kept — an unplugged drive looks the same as a deleted folder.`));
    }
  });
  if (!waiting) root.prepend(EmptyState({ message: 'Nothing is waiting. A scan puts a file here when it can’t tell for sure what changed.' }));
}

// ---------- REVIEW: tag suggestions ----------

async function applyGroup(group) {
  await run(`tags:${group.key}`, async () => {
    const exclude = [...(L.excluded.get(group.key) || [])];
    const updates = acceptGroup(group, L.index.items, { exclude });
    if (!updates.length) throw new Error('Every item in this group is excluded or already has these details.');
    await call('applyItemUpdates', { updates });
    L.excluded.delete(group.key);
    L.openGroups.delete(group.key);
    L.notice.review = `Tagged ${plural(updates.length, 'item')} in ${group.label}.`;
    await refresh();
  });
}

function fieldValue(value) {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function renderGroup(group) {
  const excluded = L.excluded.get(group.key) || new Set();
  const count = group.itemIds.length - excluded.size;
  const card = h('div', { className: 'library-card' },
    h('div', { className: 'library-card-title' }, group.label, ' ', Badge({ text: plural(group.itemIds.length, 'item') })));
  const fields = h('dl', { className: 'library-fields' });
  Object.entries(group.fields).forEach(([field, value]) => {
    fields.append(h('dt', { text: field }), h('dd', {}, h('strong', { text: fieldValue(value) }), h('span', { className: 'library-reason', text: ` — ${group.reasons[field]}` })));
  });
  const extras = Object.keys(group.perItem).length;
  if (extras) fields.append(h('dt', { text: 'per item' }), h('dd', { text: `season, episode or a cleaned title for ${plural(extras, 'item')} (only where empty)` }));
  card.appendChild(fields);

  const open = L.openGroups.has(group.key);
  card.appendChild(h('div', { className: 'library-actions' },
    Button({ label: `APPLY TO ${plural(count, 'ITEM')}`, variant: 'primary', disabled: !!L.busy || !count, onPress: () => applyGroup(group) }),
    Button({
      label: open ? 'HIDE ITEMS' : 'CHOOSE ITEMS…', variant: 'quiet', pressed: open,
      onPress: () => { if (open) L.openGroups.delete(group.key); else L.openGroups.add(group.key); renderReviewTags(); },
    })));

  if (open) {
    const list = h('ul', { className: 'library-item-list' });
    group.itemIds.forEach((id) => {
      const item = L.index.items[id];
      const box = h('input', { type: 'checkbox', checked: !excluded.has(id), attrs: { 'aria-label': `Include ${itemLabel(item)}` } });
      box.addEventListener('change', () => {
        const set = L.excluded.get(group.key) || new Set();
        if (box.checked) set.delete(id); else set.add(id);
        L.excluded.set(group.key, set);
        renderReviewTags();
      });
      list.appendChild(h('li', {}, h('label', {}, box, ' ', itemLabel(item), h('span', { className: 'library-reason', text: ` ${basename(item && item.ref)}` })),
        Button({ label: 'EDIT…', variant: 'quiet', onPress: () => openItemEditor(item) })));
    });
    card.appendChild(list);
  }
  return card;
}

function renderReviewTags() {
  const root = roots.reviewTags();
  if (!root) return;
  root.replaceChildren();
  if (!L.loaded || L.error) return;
  if (!L.status.built) { root.appendChild(EmptyState({ message: 'Build the library in CATALOGUE first.' })); return; }
  const groups = suggestGroups(liveItems());
  if (!groups.length) { root.appendChild(EmptyState({ message: 'No suggestions. Every item has the details its path and length can tell.' })); return; }
  const covered = groups.reduce((sum, group) => sum + group.itemIds.length, 0);
  root.appendChild(note(`${plural(groups.length, 'group')} covering ${plural(covered, 'item')}. Each group is one decision; untick items to leave them out.`));
  groups.forEach((group) => root.appendChild(renderGroup(group)));
}

// ---------- SMART CHANNELS ----------

function knownValues(read) {
  const values = new Set();
  liveItems().forEach((item) => {
    const value = read(item);
    (Array.isArray(value) ? value : [value]).forEach((one) => { if (one) values.add(String(one)); });
  });
  return [...values].sort((a, b) => a.localeCompare(b));
}

function datalist(id, values) {
  return h('datalist', { attrs: { id } }, values.map((value) => h('option', { value })));
}

function formCount(form) {
  const where = buildWhere(form);
  if (!Object.keys(where).length) return { matched: 0, ready: 0, empty: true };
  const matched = runQuery(liveItems(), where);
  return { matched: matched.length, ready: matched.filter((item) => item.duration > 0).length };
}

async function saveEditing() {
  await run('query', async () => {
    const form = L.editing;
    if (!form.name.trim()) throw new Error('Give the query a name.');
    const where = form.advanced ? form.where : buildWhere(form);
    validateWhere(where);
    if (!Object.keys(where).length) throw new Error('Add at least one condition.');
    await call('saveQuery', { id: form.id || null, name: form.name, where, order: form.order });
    L.notice.smart = `Saved “${form.name.trim()}”.`;
    L.editing = null;
    await refresh();
  });
}

function renderQueryForm(root) {
  const form = L.editing;
  const countEl = h('p', { className: 'panel-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const updateCount = () => {
    if (form.advanced) { countEl.textContent = `Conditions: ${describeWhere(form.where)}. This form can’t edit them; the name and order can still change.`; return; }
    const { matched, ready, empty } = formCount(form);
    countEl.textContent = empty ? 'Add a condition to see what matches.' : `Matches ${plural(matched, 'item')}${ready < matched ? `, ${ready.toLocaleString()} ready to air` : ''}.`;
  };
  const input = (key, label, { list = null, placeholder = '' } = {}) => {
    const id = `library-query-${key}`;
    const el = h('input', { type: 'text', id, value: form[key] || '', placeholder, disabled: form.advanced && key !== 'name', attrs: { list } });
    el.addEventListener('input', () => { form[key] = el.value; updateCount(); });
    return h('div', { className: 'library-form-field' }, h('label', { text: label, attrs: { for: id } }), el);
  };
  const select = (key, label, options) => {
    const id = `library-query-${key}`;
    const el = h('select', { id, disabled: form.advanced && key !== 'order' }, options.map(([value, text]) => h('option', { value, text, selected: form[key] === value })));
    el.addEventListener('change', () => { form[key] = el.value; updateCount(); });
    return h('div', { className: 'library-form-field' }, h('label', { text: label, attrs: { for: id } }), el);
  };
  const card = h('div', { className: 'library-card library-form' },
    h('div', { className: 'library-card-title', text: form.id ? 'EDIT SAVED QUERY' : 'NEW SAVED QUERY' }),
    h('div', { className: 'library-form-grid' },
      input('name', 'Name', { placeholder: 'e.g. 90s sitcoms' }),
      select('kind', 'Kind', [['', 'Any kind'], ...KINDS.map((kind) => [kind, kind])]),
      input('genre', 'Genre', { list: 'library-known-genres' }),
      input('era', 'Era', { list: 'library-known-eras', placeholder: 'e.g. 1990s' }),
      input('series', 'Series', { list: 'library-known-series' }),
      input('text', 'Title, series or tag contains'),
      select('order', 'Order', Object.keys(ORDER_POLICIES).map((key) => [key, ORDER_LABELS[key] || key]))),
    datalist('library-known-genres', knownValues((item) => item.facets && item.facets.genre)),
    datalist('library-known-eras', knownValues((item) => item.facets && item.facets.era)),
    datalist('library-known-series', knownValues((item) => item.series && item.series.name)),
    countEl,
    h('div', { className: 'library-actions' },
      Button({ label: 'SAVE', variant: 'primary', disabled: !!L.busy, onPress: saveEditing }),
      Button({ label: 'CANCEL', variant: 'quiet', onPress: () => { L.editing = null; renderSmart(); } })));
  updateCount();
  root.appendChild(card);
}

function editQuery(query) {
  const form = formFromWhere(query ? query.where : {});
  L.editing = { ...form, id: query ? query.id : null, name: query ? query.name : '', order: (query && query.order) || 'series', where: query ? query.where : {} };
  renderSmart();
  const name = document.getElementById('library-query-name');
  if (name) name.focus();
}

async function removeQuery(query) {
  const users = smartChannels().filter((ch) => ch.sources.some((s) => s.query === query.id)).map((ch) => ch.number);
  const ok = await confirmDialog({
    title: 'REMOVE SAVED QUERY?',
    message: users.length
      ? `CH ${users.join(', ')} ${users.length === 1 ? 'is' : 'are'} built from “${query.name}”. ${users.length === 1 ? 'It keeps' : 'They keep'} what ${users.length === 1 ? 'it airs' : 'they air'} now, but can’t be rebuilt from this query again.`
      : `“${query.name}” isn’t used by any channel.`,
    confirmText: 'REMOVE',
  });
  if (!ok) return;
  await run('query', async () => {
    await call('removeQuery', { id: query.id });
    L.notice.smart = `Removed “${query.name}”.`;
    await refresh();
  });
}

async function buildChannelFromQuery(query) {
  await run('query', async () => {
    const channel = freshChannel();
    channel.name = query.name;
    channel.sources = [{ type: 'query', query: query.id }];
    // A new channel's loop starts now — real time, the anchor exception in
    // CLAUDE.md, the same as a channel created from a folder.
    const startedAt = Date.now();
    const plan = planChannelFiles(channel, L.index, { atMs: startedAt });
    if (!plan.files.length) {
      throw new Error(plan.summary.skipped.length
        ? `“${query.name}” matches ${plural(plan.summary.skipped.length, 'item')}, but none has a known length yet. Scan their location first.`
        : `“${query.name}” doesn’t match anything yet.`);
    }
    const hours = plan.files.reduce((sum, file) => sum + file.duration, 0) / 3600;
    const ok = await confirmDialog({
      title: 'ADD SMART CHANNEL?',
      message: `CH ${channel.number} “${channel.name}” with ${plural(plan.files.length, 'programme')} (${hours.toFixed(1)} hours a loop), ${ORDER_LABELS[query.order] || ORDER_LABELS.series}.`
        + (plan.summary.skipped.length ? ` ${plural(plan.summary.skipped.length, 'match', 'matches')} with no known length ${plan.summary.skipped.length === 1 ? 'is' : 'are'} left out until scanned.` : ''),
      danger: false,
      confirmText: 'ADD CHANNEL',
    });
    if (!ok) return;
    channel.files = plan.files;
    channel.anchor = startedAt;
    channel.materializedAt = startedAt; // audit timestamp, real time
    dispatch({ type: 'channel.insert', channel }, { label: `Add smart channel ${channel.name}` });
    S.bulkSelectedChannels.clear();
    S.setupSelectedChannel = channel.number;
    S.setupFilterQuery = '';
    if (channelFilterEl) channelFilterEl.value = '';
    renderChannelList();
    L.notice.smart = `Added CH ${channel.number} “${channel.name}”.`;
  });
}

// What a rebuild would do, in the words the confirm dialog and the unattended
// path both use.
function planRebuild(channel, index) {
  const atMs = scheduleClockFor(channel);
  const plan = planChannelFiles(channel, index, { atMs });
  const unchanged = playlistKey(plan.files) === playlistKey(channel.files) && plan.anchor === channel.anchor;
  return { plan, atMs, unchanged };
}

async function rebuildChannel(channel) {
  await run(`rebuild:${channel.number}`, async () => {
    const guard = configGuard();
    const { plan, atMs, unchanged } = planRebuild(channel, L.index);
    const missing = plan.summary.sources.filter((source) => source.error);
    if (missing.length) throw new Error(`CH ${channel.number} uses a saved query that no longer exists, so it can’t be rebuilt.`);
    if (!plan.files.length) throw new Error(`Rebuilding CH ${channel.number} would leave it with nothing to air, so it was left as it is.`);
    if (unchanged) { L.notice.smart = `CH ${channel.number} is already up to date.`; return; }

    const proposed = { ...JSON.parse(JSON.stringify(channel)), files: plan.files, anchor: plan.anchor };
    const fromMs = viewNow();
    const diff = diffSchedules(channel, proposed, fromMs, fromMs + PREVIEW_DAYS * DAY_MS, { breaks: true });
    const nowBefore = programAt(channel, atMs);
    const nowAfter = programAt(proposed, atMs);
    const keeps = plan.reanchor && plan.reanchor.ok;
    const outcome = keeps
      ? `What’s on now stays on: ${programTitle(nowBefore)}.`
      : `What’s on now changes from ${programTitle(nowBefore)} to ${programTitle(nowAfter)}.`;
    const { summary } = plan;
    // Hours of schedule that differ, not a count of airings: a short loop
    // repeats hundreds of times a week, and "1,164 airings change" reads as
    // alarming for a one-episode addition.
    const changedHours = diff.changed.reduce((sum, range) => sum + (range.end - range.start), 0) / 3600000;
    const ahead = diff.identical
      ? 'nothing else changes'
      : `${changedHours >= 10 ? Math.round(changedHours) : changedHours.toFixed(1)} of the ${PREVIEW_DAYS * 24} hours air something different`;
    const ok = await confirmDialog({
      title: `REBUILD CH ${channel.number}?`,
      message: `${plural(summary.added, 'programme')} added, ${summary.removed.toLocaleString()} removed (${summary.before.toLocaleString()} → ${summary.after.toLocaleString()}). ${outcome} `
        + `Over the next ${PREVIEW_DAYS} days ${ahead}.`
        + (summary.skipped.length ? ` ${plural(summary.skipped.length, 'match', 'matches')} with no known length ${summary.skipped.length === 1 ? 'is' : 'are'} left out.` : ''),
      danger: !keeps,
      confirmText: 'REBUILD',
    });
    if (!ok) return;
    if (guard.changed() || !S.config.channels.includes(channel)) throw new Error(`Your channels changed while this was open, so CH ${channel.number} was not rebuilt. Try again.`);
    dispatch({
      type: 'channel.rematerialize', channel: channel.number, files: plan.files, anchor: plan.anchor,
      materializedAt: Date.now(), // audit timestamp, real time
    }, { label: `Rebuild CH ${channel.number} from the library` });
    renderChannelList();
    L.notice.smart = `Rebuilt CH ${channel.number}.`;
  });
}

// After a scan, with the setting on: rebuild only the channels whose rebuild
// keeps what's on now. Everything else is left for a person, with a preview.
export async function rebuildSmartChannelsUnattended() {
  if (!(S.config.librarySync && S.config.librarySync.rebuildSmartChannels)) return null;
  const channels = smartChannels();
  if (!channels.length) return null;
  const index = await call('getIndex');
  const result = { rebuilt: [], waiting: [] };
  channels.forEach((channel) => {
    const { plan, unchanged } = planRebuild(channel, index);
    if (unchanged || !plan.files.length || plan.summary.sources.some((source) => source.error)) return;
    if (!(plan.reanchor && plan.reanchor.ok && !plan.reanchor.fresh)) {
      result.waiting.push(channel.number);
      return;
    }
    dispatch({
      type: 'channel.rematerialize', channel: channel.number, files: plan.files, anchor: plan.anchor, materializedAt: Date.now(),
    }, { label: `Rebuild CH ${channel.number} after a library scan` });
    result.rebuilt.push(channel.number);
  });
  if (result.rebuilt.length) renderChannelList();
  return result;
}

function renderSmart() {
  const root = roots.smart();
  const setting = document.getElementById('library-smart-rebuild');
  if (setting) setting.checked = !!(S.config.librarySync && S.config.librarySync.rebuildSmartChannels);
  if (!root) return;
  root.replaceChildren();
  if (!L.loaded) return;
  if (L.error) { root.appendChild(note(L.error, 'error')); return; }
  if (!L.status.built) { root.appendChild(EmptyState({ message: 'Build the library in CATALOGUE first.' })); return; }
  if (L.notice.smart) root.appendChild(note(L.notice.smart));

  const queries = Object.values(L.index.queries || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (L.editing) renderQueryForm(root);
  else {
    root.appendChild(h('div', { className: 'library-actions' },
      Button({ label: 'NEW SAVED QUERY', variant: 'primary', disabled: !!L.busy, onPress: () => editQuery(null) })));
  }

  if (!queries.length && !L.editing) {
    root.appendChild(EmptyState({ message: 'A saved query picks programmes from the library — every 90s sitcom, every Christmas special — and a smart channel airs them.' }));
  } else if (queries.length) {
    const items = liveItems();
    root.appendChild(table(['Saved query', 'Matches', 'Order', ''], queries.map((query) => {
      let matched = [];
      try { matched = runQuery(items, query.where); } catch (e) { /* shown as 0; saving validates */ }
      const ready = matched.filter((item) => item.duration > 0).length;
      return h('tr', {},
        cell(h('div', {}, h('strong', { text: query.name }), h('div', { className: 'library-reason', text: describeWhere(query.where) }))),
        cell(`${matched.length.toLocaleString()}${ready < matched.length ? ` (${ready.toLocaleString()} ready)` : ''}`, 'num'),
        cell(ORDER_LABELS[query.order] || ORDER_LABELS.series),
        cell(h('div', { className: 'library-row-actions' },
          Button({ label: 'BUILD CHANNEL…', disabled: !!L.busy || !ready, onPress: () => buildChannelFromQuery(query), attrs: { 'aria-label': `Build a channel from ${query.name}` } }),
          Button({ label: 'EDIT', variant: 'quiet', disabled: !!L.busy, onPress: () => editQuery(query), attrs: { 'aria-label': `Edit ${query.name}` } }),
          Button({ label: 'REMOVE', variant: 'quiet', disabled: !!L.busy, onPress: () => removeQuery(query), attrs: { 'aria-label': `Remove ${query.name}` } }))));
    })));
  }

  const channels = smartChannels();
  if (channels.length) {
    root.appendChild(h('p', { className: 'panel-status', text: 'Smart channels keep the playlist they were built with until you rebuild them. A rebuild previews what changes before anything airs differently.' }));
    root.appendChild(table(['Channel', 'Built from', 'Programmes', ''], channels.map((channel) => {
      const names = channel.sources.filter((s) => s.type === 'query').map((s) => (L.index.queries[s.query] ? L.index.queries[s.query].name : 'missing query'));
      return h('tr', {},
        cell(`CH ${channel.number} ${channel.name || ''}`),
        cell(h('div', {}, names.join(', '), channel.materializedAt ? h('div', { className: 'library-reason', text: `built ${new Date(channel.materializedAt).toLocaleString()}` }) : null)),
        cell((channel.files || []).length.toLocaleString(), 'num'),
        cell(Button({ label: 'REBUILD…', disabled: !!L.busy, onPress: () => rebuildChannel(channel), attrs: { 'aria-label': `Rebuild CH ${channel.number}` } })));
    })));
  }
}

// ---------- Wiring ----------

function renderAll() {
  renderCatalogue();
  renderScanReview();
  renderReviewTags();
  renderSmart();
}

// Called from renderSettingsPanels whenever the setup screen opens or config
// is replaced. Draws what it has, then refetches.
export function renderLibraryPanels() {
  renderAll();
  refresh();
  renderPresetsPanel();
}

const rebuildSettingEl = document.getElementById('library-smart-rebuild');
rebuildSettingEl?.addEventListener('change', () => {
  if (!S.config.librarySync) S.config.librarySync = {};
  S.config.librarySync.rebuildSmartChannels = rebuildSettingEl.checked;
  commitInPlace({ type: 'settings.set', path: ['librarySync', 'rebuildSmartChannels'], value: rebuildSettingEl.checked });
});
['librarycatalogue', 'libraryreview', 'librarysmart'].forEach((subtab) => {
  document.querySelector(`[data-subtab="${subtab}"]`)?.addEventListener('click', () => refresh());
});
