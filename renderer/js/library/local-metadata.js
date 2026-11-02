// Details from the files themselves (docs/design/07 §5 step 2): .nfo sidecars
// and container tags, read on the host by main/library/local-metadata.js.
//
// Two uses share this module:
//   * a channel's playlist entries (TITLES' READ NFO & TAGS, folder sync's new
//     files, LIBRARY SYNC's FILL IN ALL CHANNELS): `fileFieldsFromLocal` turns
//     a reading into the empty fields it may fill on one entry;
//   * library items: the reading is kept on the item as `local` evidence, and
//     tagging.js offers it in REVIEW like any other suggestion.
//
// Nothing here overwrites a value somebody set. A field is filled only when
// it is empty, so running it twice, or after a TMDB match, changes nothing.
//
// DOM-free and free of core/state.js, so it is tested directly; callers pass
// the config the settings live in.

// What one host call may carry (main/library/service.js MAX_METADATA_REFS).
// Files are sent a folder at a time where they fit: the host drops a tag
// title that several files of one call share, as a collection's name.
const BATCH = 200;

// LIBRARY SYNC › DETAILS FROM YOUR FILES.
export function localMetadataPrefs(config) {
  const prefs = (config && config.librarySync) || {};
  return { fillDetails: !!prefs.fillDetails, readTags: prefs.readTags !== false };
}

// A playlist path the host can read sidecars beside: a plain local file, not
// a mediasource: ref (core/channels.js parseMediaRef's other case).
export function localPathOf(path) {
  return typeof path === 'string' && path && !path.startsWith('mediasource:') ? path : null;
}

function folderOf(ref) {
  return String(ref).replace(/[\\/][^\\/]*$/, '');
}

// Batches of refs, each folder kept whole when it fits in one.
export function batchByFolder(refs, size = BATCH) {
  const byFolder = new Map();
  refs.forEach((ref) => {
    const key = folderOf(ref).toLowerCase();
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(ref);
  });
  const batches = [];
  let current = [];
  byFolder.forEach((group) => {
    for (let i = 0; i < group.length; i += size) {
      const part = group.slice(i, i + size);
      if (current.length && current.length + part.length > size) { batches.push(current); current = []; }
      current.push(...part);
    }
  });
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Reads .nfo files and (unless turned off) container tags for local refs.
 * -> { results: { [ref]: { fields, sources, kind? } | null }, tagsAvailable }
 */
export async function readLocalMetadata(refs, { tags = true, onProgress = null } = {}) {
  const unique = [...new Set(refs.filter(Boolean))];
  const results = {};
  let tagsAvailable = false;
  if (!unique.length) return { results, tagsAvailable };
  if (!window.api || typeof window.api.libraryCall !== 'function') throw new Error('Reading file details is only possible on the host.');
  let done = 0;
  for (const batch of batchByFolder(unique)) {
    // eslint-disable-next-line no-await-in-loop
    const response = await window.api.libraryCall('readLocalMetadata', { refs: batch, nfo: true, tags });
    if (!response || !response.ok) throw new Error((response && response.error) || 'The host did not answer.');
    Object.assign(results, response.result.results || {});
    if (response.result.tagsAvailable) tagsAvailable = true;
    done += batch.length;
    if (onProgress) onProgress(done, unique.length);
  }
  return { results, tagsAvailable };
}

function empty(value) {
  return value == null || (typeof value === 'string' && !value.trim());
}

/**
 * The fields a reading may fill on one playlist entry: episode title,
 * description, rating and series — each only when the entry has none.
 * A rating of 'NONE' is a choice and counts as set. Returns null when there
 * is nothing to fill.
 */
export function fileFieldsFromLocal(file, reading) {
  if (!file || !reading || !reading.fields) return null;
  const f = reading.fields;
  const out = {};
  if (f.title && empty(file.title)) out.title = f.title;
  if (f.description && empty(file.description)) out.description = f.description;
  if (f.rating && empty(file.rating)) out.rating = f.rating;
  if (f.series && !(file.series && !empty(file.series.name))) {
    out.series = { name: f.series, season: f.season ?? null, episode: f.episode ?? null };
  }
  return Object.keys(out).length ? out : null;
}

/** "3 titles, 2 descriptions and 1 rating" for a set of filled field lists. */
export function describeFilled(fieldLists) {
  const counts = { title: 0, description: 0, rating: 0, series: 0 };
  fieldLists.forEach((fields) => Object.keys(fields).forEach((key) => { if (key in counts) counts[key] += 1; }));
  const words = { title: ['title', 'titles'], description: ['description', 'descriptions'], rating: ['rating', 'ratings'], series: ['series name', 'series names'] };
  const parts = Object.keys(counts).filter((key) => counts[key]).map((key) => `${counts[key]} ${words[key][counts[key] === 1 ? 0 : 1]}`);
  if (parts.length <= 1) return parts[0] || 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Fills empty details on playlist entries in place, from one host reading.
 * For new entries that aren't in config yet (folder sync), and for whole-config
 * passes the caller records as one patch. Returns the field lists it applied.
 */
export async function fillFilesInPlace(files, opts = {}) {
  const targets = files.filter((file) => localPathOf(file.path));
  if (!targets.length) return [];
  const { results } = await readLocalMetadata(targets.map((file) => localPathOf(file.path)), opts);
  const applied = [];
  targets.forEach((file) => {
    const fields = fileFieldsFromLocal(file, results[localPathOf(file.path)]);
    if (!fields) return;
    Object.assign(file, fields);
    applied.push(fields);
  });
  return applied;
}
