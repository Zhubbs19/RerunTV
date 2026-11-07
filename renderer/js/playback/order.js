// File-ordering helpers for channel lineups: natural title order, folder order, a seeded
// shuffle, and which file a looping order is on at a given time.
import { hashString, mulberry32 } from '../core/util.js';

// Case-insensitive collator that sorts embedded numbers numerically ("Ep 2" before "Ep 10").
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Returns a copy of the files sorted by title (or path) in natural order.
 * @param {Array<object>} files Channel file entries.
 * @returns {Array<object>} A new sorted array.
 */
export function naturalFileOrder(files) {
  return files.slice().sort((a, b) => naturalCollator.compare(a.title || a.path || '', b.title || b.path || ''));
}

/**
 * Returns a copy of the files sorted by their folder's position in `folders`, then by path.
 * Files whose folder is not listed sort last.
 * @param {Array<object>} files Channel file entries with a `folder` id.
 * @param {Array<string|object>} folders Folder ids, or folder objects with an `id`, in display order.
 * @returns {Array<object>} A new sorted array.
 */
export function folderFileOrder(files, folders) {
  const rank = new Map((folders || []).map((folder, index) => [typeof folder === 'string' ? folder : folder.id, index]));
  return files.slice().sort((a, b) =>
    (rank.get(a.folder) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.folder) ?? Number.MAX_SAFE_INTEGER) ||
    naturalCollator.compare(a.path || '', b.path || ''));
}

/**
 * Returns a copy of the files shuffled deterministically from a seed (Fisher-Yates).
 * @param {Array<object>} files Channel file entries.
 * @param {*} seed Any value; it is stringified and hashed. Falsy uses a fixed default.
 * @returns {Array<object>} A new shuffled array; the same seed always gives the same order.
 */
export function seededFileOrder(files, seed) {
  const out = files.slice();
  const random = mulberry32(hashString(String(seed || 'reruntv')));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Finds the file that would be airing at `atMs` if the files had looped since `anchor`.
 * @param {Array<object>} files Ordered file entries with `duration` in seconds.
 * @param {number} anchor Loop start time in epoch milliseconds.
 * @param {number} atMs The moment to look up, in epoch milliseconds.
 * @returns {?object} The file airing then, or null with no files, anchor or total duration.
 */
export function fileAtOrder(files, anchor, atMs) {
  const total = files.reduce((sum, file) => sum + Math.max(0, file.duration || 0), 0);
  if (!files.length || !anchor || !total) return null;
  const elapsed = ((((atMs - anchor) / 1000) % total) + total) % total;
  let cursor = 0;
  for (const file of files) {
    if (elapsed < cursor + (file.duration || 0)) return file;
    cursor += file.duration || 0;
  }
  return files[0];
}
