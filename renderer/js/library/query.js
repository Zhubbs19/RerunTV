// Saved queries and smart channels (docs/design/07 §6, contract C6).
//
// A query is plain JSON — `{ kind: 'episode', 'facets.genre': 'sitcom' }` — so
// it can be saved in the library, sent over the LAN and put in a template (08).
// Evaluating one is pure, and turning its results into a channel playlist is
// pure too. What airs changes only when a caller takes the planned playlist
// through `channel.rematerialize`, with the schedule preview in front of it.
//
// The playlist this produces is exactly the shape a folder channel has always
// had — `{ path, duration, … }` in order — plus an `item` id. Schedule math
// reads `ch.files` and nothing else (C6), so a smart channel needs no new code
// anywhere on the playback path.
import { hashString, mulberry32 } from '../core/util.js';
import { reanchorForPlaylistChange } from './reanchor.js';

// ---------- Evaluating a `where` ----------
//
//   { field: value }                  equal, or "contains" for an array field
//   { field: [a, b] }                 any of
//   { field: { eq, ne, in, contains, any, all, gte, lte, gt, lt, exists } }
//   { text: 'christmas' }             title, series, tags or ref contain it
//   { any: [where, where] }           either
//   { not: where }                    negation
//
// Field names are dotted paths into an item: `facets.genre`, `series.name`.
// String comparisons ignore case. Decades ("1990s") compare correctly as text.

function readPath(item, dotted) {
  return String(dotted).split('.').reduce((node, key) => (node == null ? undefined : node[key]), item);
}

function norm(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function compare(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y), undefined, { numeric: true });
}

function valueMatches(actual, expected) {
  if (Array.isArray(actual)) return actual.some((one) => valueMatches(one, expected));
  if (Array.isArray(expected)) return expected.some((one) => valueMatches(actual, one));
  if (actual == null) return expected == null;
  return norm(actual) === norm(expected);
}

function operatorMatches(actual, ops) {
  return Object.entries(ops).every(([op, expected]) => {
    switch (op) {
      case 'eq': return valueMatches(actual, expected);
      case 'ne': return !valueMatches(actual, expected);
      case 'in': return valueMatches(actual, Array.isArray(expected) ? expected : [expected]);
      case 'any': return (Array.isArray(expected) ? expected : [expected]).some((one) => valueMatches(actual, one));
      case 'all': return (Array.isArray(expected) ? expected : [expected]).every((one) => valueMatches(actual, one));
      case 'contains': {
        const needle = String(expected).toLowerCase();
        const hay = Array.isArray(actual) ? actual : [actual];
        return hay.some((one) => one != null && String(one).toLowerCase().includes(needle));
      }
      case 'exists': return expected ? actual != null && actual !== '' && !(Array.isArray(actual) && !actual.length) : actual == null;
      case 'gte': return actual != null && compare(actual, expected) >= 0;
      case 'lte': return actual != null && compare(actual, expected) <= 0;
      case 'gt': return actual != null && compare(actual, expected) > 0;
      case 'lt': return actual != null && compare(actual, expected) < 0;
      default: throw new Error(`Unknown query operator "${op}"`);
    }
  });
}

export function matchesWhere(item, where) {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'any') return (expected || []).some((clause) => matchesWhere(item, clause));
    if (key === 'not') return !matchesWhere(item, expected);
    if (key === 'text') {
      const needle = String(expected || '').toLowerCase();
      if (!needle) return true;
      const hay = [item.title, item.series && item.series.name, item.ref, ...(item.tags || [])];
      return hay.some((one) => one && String(one).toLowerCase().includes(needle));
    }
    const actual = readPath(item, key);
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) return operatorMatches(actual, expected);
    return valueMatches(actual, expected);
  });
}

// Throws a user-facing error for a query that could never be evaluated, so a
// bad saved query is caught when it is saved, not when a channel is rebuilt.
export function validateWhere(where) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) throw new Error('A query needs at least one condition.');
  matchesWhere({}, where); // unknown operators throw here
  return true;
}

// The simple form the setup screen edits — one value per field — to and from a
// `where`. A saved query the form cannot represent (hand-written operators,
// `any`, `not`) is reported as `advanced` so the editor does not flatten it.
const FORM_FIELDS = { kind: 'kind', genre: 'facets.genre', era: 'facets.era', series: 'series.name' };

export function buildWhere(form = {}) {
  const where = {};
  Object.entries(FORM_FIELDS).forEach(([name, key]) => {
    const value = String(form[name] || '').trim();
    if (value) where[key] = value;
  });
  const text = String(form.text || '').trim();
  if (text) where.text = text;
  return where;
}

export function formFromWhere(where = {}) {
  const form = { kind: '', genre: '', era: '', series: '', text: '', advanced: false };
  Object.entries(where || {}).forEach(([key, value]) => {
    const name = Object.keys(FORM_FIELDS).find((field) => FORM_FIELDS[field] === key);
    if (key === 'text' && typeof value === 'string') form.text = value;
    else if (name && typeof value === 'string') form[name] = value;
    else form.advanced = true;
  });
  return form;
}

// "episode · genre sitcom · era 1990s · contains “christmas”"
export function describeWhere(where = {}) {
  const labels = { kind: '', 'facets.genre': 'genre', 'facets.era': 'era', 'series.name': 'series' };
  return Object.entries(where || {}).map(([key, value]) => {
    if (key === 'text') return `contains “${value}”`;
    const shown = typeof value === 'string' ? value : JSON.stringify(value);
    const label = key in labels ? labels[key] : key;
    return label ? `${label} ${shown}` : shown;
  }).join(' · ') || 'everything';
}

export function runQuery(items, where) {
  return items.filter((item) => matchesWhere(item, where));
}

// ---------- Ordering ----------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function titleKey(item) {
  return item.title || String(item.ref || '').split(/[\\/]/).pop() || '';
}

export const ORDER_POLICIES = {
  // Series, then season and episode, then title — how a box set runs.
  series: (items) => items.slice().sort((a, b) =>
    collator.compare((a.series && a.series.name) || '', (b.series && b.series.name) || '')
    || ((a.series && a.series.season) ?? 0) - ((b.series && b.series.season) ?? 0)
    || ((a.series && a.series.episode) ?? 0) - ((b.series && b.series.episode) ?? 0)
    || collator.compare(titleKey(a), titleKey(b))),
  // Plain natural order by title, the same as a folder channel's.
  natural: (items) => items.slice().sort((a, b) => collator.compare(titleKey(a), titleKey(b))),
  // Stable across rebuilds for the same seed, so rebuilding a shuffled channel
  // with no new items produces the same order and moves nothing.
  shuffle: (items, seed) => {
    const out = items.slice().sort((a, b) => collator.compare(a.id, b.id));
    const random = mulberry32(hashString(String(seed || 'reruntv')));
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  },
  // Newest additions to the library first.
  recent: (items) => items.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || collator.compare(a.id, b.id)),
};

// ---------- Materializing ----------

// Metadata copied onto each playlist entry so every existing reader of
// `ch.files[i].title` / `.tags` keeps working (the doc's one-release dual-read).
const DUAL_READ_FIELDS = ['title', 'tags', 'facets', 'description', 'tmdb', 'rating', 'advisory', 'advisoryCues', 'hasCC', 'hasSAP', 'hasStereo', 'creditsLeadS', 'kind', 'artist', 'album'];

function sourceOf(ref) {
  const match = /^mediasource:([^:]+):/.exec(String(ref || ''));
  return match ? match[1] : 'local';
}

export function materializeItems(items, { order = 'series', seed = null } = {}) {
  const policy = ORDER_POLICIES[order] || ORDER_POLICIES.series;
  const playable = [];
  const skipped = [];
  items.forEach((item) => {
    // A file with no known duration cannot be scheduled: the loop's total
    // would be wrong for every file after it. It is reported, not guessed.
    if (Number.isFinite(item.duration) && item.duration > 0) playable.push(item);
    else skipped.push({ item: item.id, ref: item.ref, reason: 'no duration yet — scan the root first' });
  });
  const files = policy(playable, seed).map((item) => {
    const entry = { path: item.ref, duration: item.duration, source: sourceOf(item.ref), item: item.id };
    DUAL_READ_FIELDS.forEach((field) => {
      if (item[field] !== undefined && item[field] !== null) entry[field] = JSON.parse(JSON.stringify(item[field]));
    });
    return entry;
  });
  return { files, skipped };
}

/**
 * The playlist a channel's library sources would produce right now, and the
 * anchor that keeps what is on the air. Pure.
 *
 * channel.sources: [{ type: 'query', query: '<id>', order?, seed? }]
 * Files that came from a folder (they carry `folder`) are kept first, in their
 * current order — folder sync owns those, and a rebuild must not reorder them.
 * Query results follow, de-duplicated against the folder files by item.
 */
export function planChannelFiles(channel, library, { atMs }) {
  const itemsById = library.items || {};
  const allItems = Object.values(itemsById);
  const before = channel.files || [];
  const folderFiles = before.filter((file) => file.folder != null);
  const seen = new Set(folderFiles.map((file) => file.item).filter(Boolean));
  const queryFiles = [];
  const skipped = [];
  const perSource = [];

  (channel.sources || []).forEach((source) => {
    if (!source || source.type !== 'query') return;
    const saved = library.queries && library.queries[source.query];
    if (!saved) {
      perSource.push({ query: source.query, error: 'saved query not found' });
      return;
    }
    const matched = runQuery(allItems, saved.where).filter((item) => !seen.has(item.id));
    matched.forEach((item) => seen.add(item.id));
    const result = materializeItems(matched, { order: source.order || saved.order || 'series', seed: source.seed || `${channel.number}|${source.query}` });
    queryFiles.push(...result.files);
    skipped.push(...result.skipped);
    perSource.push({ query: source.query, name: saved.name, matched: matched.length, files: result.files.length });
  });

  const nextFiles = [...folderFiles, ...queryFiles];
  const beforeKeys = new Set(before.map((file) => file.item || file.path));
  const afterKeys = new Set(nextFiles.map((file) => file.item || file.path));
  const summary = {
    before: before.length,
    after: nextFiles.length,
    added: [...afterKeys].filter((key) => !beforeKeys.has(key)).length,
    removed: [...beforeKeys].filter((key) => !afterKeys.has(key)).length,
    sources: perSource,
    skipped,
  };

  let anchor = channel.anchor;
  let reanchor = null;
  if (!before.length || !channel.anchor) {
    // A channel with nothing on the air yet starts its loop now — real time,
    // the same as a folder channel's first scan (CLAUDE.md's anchor exception).
    anchor = channel.anchor || atMs;
    reanchor = { ok: true, fresh: true };
  } else if (nextFiles.length) {
    reanchor = reanchorForPlaylistChange({ files: before, nextFiles, anchor: channel.anchor, atMs });
    if (reanchor.ok) anchor = reanchor.anchor;
  }
  return { files: nextFiles, anchor, reanchor, summary };
}
