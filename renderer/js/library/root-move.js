// Moving a library root (docs/design/07 §8: "moving J:\Media Center to another
// drive and updating the root relinks every channel with no schedule change").
//
// A person moved the files and is telling us where they went, so this is an
// explicit, authoritative rewrite of a path prefix — not a guess from
// fingerprints. It rewrites three places together: the library's roots and
// items, and every channel folder and playlist entry under the old prefix.
//
// Pure. The caller previews it with airingDiffIgnoringPaths() — diffSchedules
// keys programmes by path, which is precisely what this changes, so the honest
// question is "does the same content air at the same times", keyed by library
// item instead.
import { querySchedule } from '../core/schedule-query.js';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// Windows paths (a drive letter or UNC share) compare case-insensitively, the
// way the filesystem does; anything else stays exact.
function isWindowsPath(text) {
  return /^[a-z]:[\\/]/i.test(text) || text.startsWith('\\\\');
}

function foldFor(prefix) {
  return isWindowsPath(prefix) ? (t) => t.toLowerCase() : (t) => t;
}

const endsWithSep = (text) => /[\\/]$/.test(text);

// A prefix match only at a path boundary: moving `J:\Media` must not also
// rewrite `J:\Media Center`.
export function underPrefix(ref, prefix) {
  const text = String(ref || '');
  if (!prefix || !text) return false;
  const fold = foldFor(prefix);
  const t = fold(text);
  const p = fold(prefix);
  if (t === p) return true;
  if (endsWithSep(prefix)) return t.startsWith(p);
  return t.startsWith(`${p}\\`) || t.startsWith(`${p}/`);
}

// Swaps the `from` prefix for `to`, keeping exactly one separator between the
// new prefix and the rest, whichever of the two was written with a trailing one.
export function rewritePrefix(ref, from, to) {
  if (!underPrefix(ref, from)) return ref;
  const rest = String(ref).slice(from.length);
  if (!rest) return to;
  if (endsWithSep(from)) {
    // `rest` starts at the first path segment: `to` must supply the separator.
    if (endsWithSep(to)) return `${to}${rest}`;
    const sep = to.includes('\\') && !to.includes('/') ? '\\' : '/';
    return `${to}${sep}${rest}`;
  }
  // `rest` starts with its own separator: don't double up on `to`'s.
  return endsWithSep(to) ? `${to}${rest.slice(1)}` : `${to}${rest}`;
}

function checkMove(from, to) {
  if (!from || !to) throw new Error('A root move needs both the old and the new location.');
  if (from === to) throw new Error('The new location is the same as the old one.');
  if (/^mediasource:/.test(from) || /^mediasource:/.test(to)) {
    throw new Error('Provider roots are not moved by path — change the provider’s own settings instead.');
  }
}

// Rewrites channel folder refs and playlist paths under `from`, in place, and
// counts what it touched. Shared by the plan (on a copy) and the apply (on the
// live config) so the preview and the write cannot disagree.
function rewriteChannelPaths(config, from, to, counts) {
  (config.channels || []).forEach((channel) => {
    let touched = false;
    (channel.folders || []).forEach((folder) => {
      if (folder && underPrefix(folder.ref, from)) { folder.ref = rewritePrefix(folder.ref, from, to); counts.folders += 1; touched = true; }
    });
    const lists = [channel.files || [], ...(channel.blocks || []).map((block) => block.files || [])];
    lists.forEach((files) => files.forEach((file) => {
      if (file && underPrefix(file.path, from)) { file.path = rewritePrefix(file.path, from, to); counts.files += 1; touched = true; }
    }));
    if (touched) counts.channels += 1;
  });
}

/**
 * Plans the move. Returns { config, index, counts } — copies, never the inputs.
 * `index` may be null when the library has not been built; channels still move.
 */
export function planRootMove(config, index, { from, to }) {
  checkMove(from, to);
  const nextConfig = cloneJson(config);
  const counts = { channels: 0, folders: 0, files: 0, roots: 0, items: 0 };
  rewriteChannelPaths(nextConfig, from, to, counts);

  let nextIndex = null;
  if (index) {
    nextIndex = cloneJson(index);
    (nextIndex.roots || []).forEach((root) => {
      if (underPrefix(root.ref, from)) { root.ref = rewritePrefix(root.ref, from, to); counts.roots += 1; }
    });
    Object.values(nextIndex.items || {}).forEach((item) => {
      if (underPrefix(item.ref, from)) {
        item.ref = rewritePrefix(item.ref, from, to);
        // The bytes did not change, but the old stat belongs to the old disk.
        // Keep the head hash (content evidence) and force a re-read of the stat.
        if (item.fingerprint) item.fingerprint = { ...item.fingerprint, mtime: null };
        counts.items += 1;
      }
    });
  }
  return { config: nextConfig, index: nextIndex, counts };
}

/**
 * The same rewrite as planRootMove, applied to the live config in place (the
 * caller records it with commitConfigPatch). Returns the counts.
 */
export function applyRootMoveInPlace(config, { from, to }) {
  checkMove(from, to);
  const counts = { channels: 0, folders: 0, files: 0, roots: 0, items: 0 };
  rewriteChannelPaths(config, from, to, counts);
  return counts;
}

/**
 * Whether two versions of a channel air the same content at the same times,
 * keyed by library item where there is one and by filename otherwise — never by
 * the full path, which is what a root move changes. Returns
 * { identical, changed, programs }.
 */
export function airingDiffIgnoringPaths(before, after, fromMs, toMs) {
  const key = (entry) => {
    const file = entry.file || {};
    const identity = file.item || String(file.path || '').split(/[\\/]/).pop();
    return `${Math.round(entry.start)}|${Math.round(entry.end)}|${identity}`;
  };
  // Breaks are left out: a root move rewrites content paths, and break
  // resolution reads box-wide programming, not these channel paths.
  const a = querySchedule(before, fromMs, toMs, { breaks: false, offAir: true }).programs.map(key);
  const b = querySchedule(after, fromMs, toMs, { breaks: false, offAir: true }).programs.map(key);
  const setA = new Set(a);
  const setB = new Set(b);
  const changed = [...a.filter((k) => !setB.has(k)), ...b.filter((k) => !setA.has(k))];
  return { identical: changed.length === 0 && a.length === b.length, changed: changed.slice(0, 20), programs: a.length };
}
