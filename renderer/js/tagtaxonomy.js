// Tag Taxonomy data layer — PROGRAMMING > TAG TAXONOMY. Two related but
// separate jobs: (1) usage reporting — every place a free-text tag string
// can live, box-wide, so a real library's drift ("scifi" vs "sci-fi") is
// visible; (2) rename/remove-everywhere, since there was previously no way
// to fix that drift without hand-editing every file/entry that used the
// stale spelling. S.config.tagTaxonomy itself (the curated per-category
// vocabulary list) is just a plain array the UI reads/writes directly —
// no engine needed for that half.
import { S } from './state.js';

function normalize(t) { return String(t || '').trim().toLowerCase(); }

// contentType (per-file facet, per-day-part-slot) is deliberately excluded
// everywhere below — it's a fixed 5-value enum edited via <select>, not a
// free-text tag a user could have mistyped two different ways.
function allTagFields(ch) {
  const fields = [];
  const addFileFields = (f) => {
    fields.push({ get: () => f.tags, set: (v) => { f.tags = v; } });
    if (f.facets) {
      fields.push({ get: () => f.facets.genre, set: (v) => { f.facets.genre = v; } });
      fields.push({ get: () => f.facets.mood, set: (v) => { f.facets.mood = v; } });
      fields.push({
        get: () => (f.facets.era ? [f.facets.era] : []),
        set: (v) => { f.facets.era = v.length ? v[0] : null; },
      });
    }
  };
  (ch.files || []).forEach(addFileFields);
  (ch.blocks || []).forEach((b) => (b.files || []).forEach(addFileFields));
  return fields;
}

// One {get,set} pair per array-of-tags location, box-wide. `set` receives
// the already-deduped replacement array; callers just assign it back.
function collectAllTagFields() {
  const fields = [];
  (S.config.channels || []).forEach((ch) => fields.push(...allTagFields(ch)));
  ((S.config.interstitials && S.config.interstitials.pool) || []).forEach((e) => {
    fields.push({ get: () => e.contentTags, set: (v) => { e.contentTags = v; } });
  });
  ((S.config.interstitials && S.config.interstitials.presets) || []).forEach((p) => {
    fields.push({ get: () => p.contentTags, set: (v) => { p.contentTags = v; } });
  });
  (S.config.curationProfiles || []).forEach((profile) => {
    fields.push({ get: () => profile.themeSeeds.genre, set: (v) => { profile.themeSeeds.genre = v; } });
    fields.push({ get: () => profile.themeSeeds.era, set: (v) => { profile.themeSeeds.era = v; } });
    fields.push({ get: () => profile.themeSeeds.mood, set: (v) => { profile.themeSeeds.mood = v; } });
    fields.push({ get: () => profile.themeSeeds.contentType, set: (v) => { profile.themeSeeds.contentType = v; } });
    fields.push({ get: () => profile.bumperStyleTags, set: (v) => { profile.bumperStyleTags = v; } });
    if (Array.isArray(profile.contentPoolScope.tags)) {
      fields.push({
        get: () => profile.contentPoolScope.tags,
        set: (v) => { profile.contentPoolScope.tags = v.length ? v : 'any'; },
      });
    }
    (profile.dayPartTemplate || []).forEach((slot) => {
      fields.push({ get: () => slot.genre, set: (v) => { slot.genre = v; } });
    });
  });
  const tx = S.config.tagTaxonomy;
  if (tx) {
    fields.push({ get: () => tx.genres, set: (v) => { tx.genres = v; } });
    fields.push({ get: () => tx.eras, set: (v) => { tx.eras = v; } });
    fields.push({ get: () => tx.moods, set: (v) => { tx.moods = v; } });
  }
  return fields;
}

// Every distinct tag in use anywhere, with a usage count and which
// taxonomy categories (if any) already list it. Sorted by usage descending
// so the tags most worth cleaning up (or promoting into the taxonomy)
// surface first.
export function collectTagUsage() {
  const counts = new Map();
  collectAllTagFields().forEach((field) => {
    (field.get() || []).forEach((t) => {
      const n = normalize(t);
      if (!n) return;
      counts.set(n, (counts.get(n) || 0) + 1);
    });
  });
  const tx = S.config.tagTaxonomy || { genres: [], eras: [], moods: [] };
  const inCategory = (t, list) => list.includes(t);
  return Array.from(counts.entries())
    .map(([tag, count]) => ({
      tag, count,
      categories: ['genres', 'eras', 'moods'].filter((cat) => inCategory(tag, tx[cat])),
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Renames a tag everywhere it appears — every file's tags/facets, every
// interstitial pool entry and ad preset's contentTags, every curation
// profile's theme seeds/pool scope/bumper tags/day-part slots, and the
// taxonomy's own category lists. Renaming to an existing tag merges the
// two (the target array is deduped, never gets two copies). Facets are
// updated directly (not just re-derived via mirrorFacetsIntoTags) so a
// later unrelated facet edit can't resurrect the old spelling by re-
// mirroring a stale facets array into tags.
export function renameTagEverywhere(oldTag, newTag) {
  const from = normalize(oldTag);
  const to = normalize(newTag);
  if (!from || !to || from === to) return 0;
  let touched = 0;
  collectAllTagFields().forEach((field) => {
    const arr = field.get();
    if (!Array.isArray(arr) || !arr.includes(from)) return;
    const out = arr.filter((t) => t !== from);
    if (!out.includes(to)) out.push(to);
    field.set(out);
    touched += 1;
  });
  return touched;
}

// Removes a tag everywhere it appears — no replacement, just gone. Used
// for cleaning up a genuinely unwanted/mistaken tag rather than fixing a
// misspelling (renameTagEverywhere is for that).
export function removeTagEverywhere(tag) {
  const target = normalize(tag);
  if (!target) return 0;
  let touched = 0;
  collectAllTagFields().forEach((field) => {
    const arr = field.get();
    if (!Array.isArray(arr) || !arr.includes(target)) return;
    field.set(arr.filter((t) => t !== target));
    touched += 1;
  });
  return touched;
}
