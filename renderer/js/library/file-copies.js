// One media file can sit in several playlists at once: two channels, a
// channel and one of its schedule blocks, a "running behind" duplicate. Each
// is its own playlist entry, so details saved on one entry (a TMDB match, a
// description) used to stay on that channel only. These helpers find every
// entry for a path and carry details across, without touching anything that
// decides what airs (path, duration, order).
//
// Pure: they read and write the config objects they are given. Callers record
// the change (commitConfigPatch) and, where a library item is involved, tell
// the host.

// Details that describe the media itself rather than its place in a playlist.
// Facts about the media itself — a catalogue match, the fades found in it —
// so every copy takes them.
const MATCH_FIELDS = new Set(['tmdb', 'tvmaze', 'breakMarks']);

export const SHARED_FILE_FIELDS = ['title', 'description', 'rating', 'tmdb', 'tvmaze', 'series', 'poster', 'breakMarks'];

function hasValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Every playlist entry for one path: channel files and schedule-block files. */
export function fileCopies(config, path) {
  const out = [];
  if (!config || !path) return out;
  (config.channels || []).forEach((channel) => {
    [channel.files || [], ...(channel.blocks || []).map((block) => block.files || [])].forEach((files) => {
      files.forEach((file) => { if (file && file.path === path) out.push(file); });
    });
  });
  return out;
}

/**
 * Writes `fields` on `source` and on every other entry for the same path.
 * Another copy keeps a title, description or rating of its own: it is
 * replaced only when it is empty or still the same value `source` had before
 * this change. A match itself (`tmdb`, `tvmaze`) always follows. Returns the
 * entries that changed.
 */
export function shareFileFields(config, source, fields) {
  const before = clone({ ...source });
  const copies = fileCopies(config, source.path);
  if (!copies.includes(source)) copies.push(source);
  const changed = [];
  copies.forEach((copy) => {
    let touched = false;
    Object.keys(fields).forEach((key) => {
      const value = fields[key];
      if (copy !== source && !MATCH_FIELDS.has(key) && hasValue(copy[key]) && JSON.stringify(copy[key]) !== JSON.stringify(before[key])) return;
      if (JSON.stringify(copy[key]) === JSON.stringify(value)) return;
      if (value === undefined) delete copy[key]; else copy[key] = clone(value);
      touched = true;
    });
    if (touched) changed.push(copy);
  });
  return changed;
}

// Fills `file`'s empty shared fields from the first donor that has each one.
function fillFrom(file, donors) {
  let touched = false;
  SHARED_FILE_FIELDS.forEach((key) => {
    if (hasValue(file[key])) return;
    const donor = donors.find((copy) => hasValue(copy[key]));
    if (!donor) return;
    file[key] = clone(donor[key]);
    touched = true;
  });
  return touched;
}

/**
 * Gives each new entry the details another entry for the same path already
 * has, filling empty fields only. `fresh` entries never count as a source.
 * Returns how many entries gained something.
 */
export function inheritFromCopies(config, fresh) {
  const skip = new Set(fresh);
  let filled = 0;
  fresh.forEach((file) => {
    const donors = fileCopies(config, file.path).filter((copy) => !skip.has(copy));
    if (donors.length && fillFrom(file, donors)) filled += 1;
  });
  return filled;
}

/**
 * The whole lineup at once: every entry gets the details its other copies
 * have, empty fields only (matches made before they were shared). Returns how
 * many entries gained something.
 */
export function shareAcrossCopies(config) {
  const byPath = new Map();
  (config && config.channels || []).forEach((channel) => {
    [channel.files || [], ...(channel.blocks || []).map((block) => block.files || [])].forEach((files) => {
      files.forEach((file) => {
        if (!file || !file.path) return;
        if (!byPath.has(file.path)) byPath.set(file.path, []);
        byPath.get(file.path).push(file);
      });
    });
  });
  let filled = 0;
  byPath.forEach((copies) => {
    if (copies.length < 2) return;
    // Donors are judged as they were before this pass, so a value never
    // hops through an entry that only just received it.
    const before = copies.map((copy) => clone(copy));
    copies.forEach((copy, i) => {
      if (fillFrom(copy, before.filter((_, j) => j !== i))) filled += 1;
    });
  });
  return filled;
}
