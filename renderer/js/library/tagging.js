// Auto-tagging suggestions for the library (docs/design/07 §5).
//
// Local-first and offline: everything here reads the item's own ref, duration
// and whatever metadata it already carries. Nothing is fetched. An opt-in
// metadata plugin's results (TMDB today) count only when they are already on
// the item, with `plugin` provenance.
//
// Pure. It produces SUGGESTIONS, never writes, and it is organised around the
// doc's review goal — "tagging 1,000 new episodes by series takes < 10 review
// actions" — so the unit of output is a GROUP: one series, or one folder for
// things that aren't a series, with the fields every item in it agrees on.
// Accepting a group is one action.
//
// Two rules keep a person in charge:
//   * A field somebody set by hand, or accepted before, is never suggested
//     again for that item (provenance `user` / `user-accepted`).
//   * Accepting a suggestion changes the CATALOGUE. What airs changes only when
//     a channel is rematerialized, which has its own schedule preview (§3, C6).
import { guessCleanTitle, stripReleaseTags, suggestFacetsFromPath } from '../core/util.js';

// Library containers that are never a series name themselves.
const CONTAINER_NAMES = /^(tv ?shows?|shows|series|television|movies?( master)?|films?|media( center)?|videos?|library|downloads?|archive|yt archive|misc(ellaneous)?)$/i;
const SEASON_DIR = /^(s(eason)?[ ._-]?\d{1,4}|specials?|extras?|disc ?\d+)$/i;
// A folder that gathers unrelated things (a collection) is not a series, even
// when it sits exactly where a series folder would.
const COLLECTION_DIR = /\b(movies?|films?|collection|specials|compilations?|misc(ellaneous)?|cartoons|commercials|bumpers|shorts|sports|music videos)\b/i;
// Sports recordings are neither episodes nor movies, whatever their length.
const SPORTS = /\b(football|basketball|baseball|hockey|soccer|ncaa[fb]?|nfl|nba|mlb|nhl|super bowl|bowl game)\b|\bvs\.?(?=\s)/i;

// Episode codes, most specific first. The library uses a season-as-year
// convention for old cartoons (S1940E05), so a four-digit "season" is a year.
// Bounded by "not a letter or digit" rather than \b: an underscore is a word
// character, so \b never matches in "Classic_Cartoons_-_S1953E05".
const EPISODE_PATTERNS = [
  /(?<![a-z0-9])s(\d{1,4})[ ._-]?e(\d{1,3})(?![0-9])/i,
  /(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i,
];

// Duration bands, in seconds. Coarse on purpose: they are one signal among
// several, and the review step shows the reason for every suggestion.
function kindFromDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds <= 60) return 'commercial';
  if (seconds <= 16 * 60) return 'short';
  if (seconds <= 70 * 60) return 'episode';
  if (seconds >= 75 * 60) return 'movie';
  return null; // 70-75 minutes: a long episode or a short film — don't guess
}

// Path segments, for local refs and provider refs alike
// (mediasource:<provider>:<folder>/<file>).
function segmentsOf(ref) {
  const text = String(ref || '');
  const body = text.startsWith('mediasource:') ? text.split(':').slice(2).join(':') : text;
  return body.split(/[\\/]+/).filter(Boolean);
}

function cleanName(segment) {
  return segment.replace(/[._]+/g, ' ').replace(/\s*\((19|20)\d\d\)\s*$/, '').replace(/\s+/g, ' ').trim();
}

function yearIn(text) {
  const match = String(text).match(/(?:^|[^\d])((?:19[2-9]|20[0-3])\d)(?:[^\d]|$)/);
  return match ? Number(match[1]) : null;
}

/**
 * Everything the path alone says about one item: series, season, episode,
 * year, kind and genre/era facets, each with the reason it was inferred.
 */
export function analyzeRef(ref, duration) {
  const segments = segmentsOf(ref);
  const file = segments[segments.length - 1] || '';
  const dirs = segments.slice(0, -1);
  const reasons = {};
  const out = {};

  for (const pattern of EPISODE_PATTERNS) {
    const match = file.match(pattern);
    if (!match) continue;
    const season = Number(match[1]);
    out.episode = Number(match[2]);
    if (season >= 1900) {
      out.year = season;
      reasons.year = `season code ${match[0]} is a year`;
    } else {
      out.season = season;
    }
    reasons.episode = `episode code ${match[0]}`;
    break;
  }

  // Series from the folder structure. When a library container sits above
  // the file ("TV Shows"), the series is the folder directly under it — so a
  // show's "First 100" sub-folder is not mistaken for the show. Without a
  // container, it is the nearest folder that is not a season folder.
  const isProvider = String(ref).startsWith('mediasource:');
  if (!isProvider) {
    let container = -1;
    dirs.forEach((name, i) => { if (CONTAINER_NAMES.test(cleanName(name))) container = i; });
    const candidates = container >= 0 ? dirs.slice(container + 1, container + 2) : dirs.slice().reverse();
    for (const name of candidates) {
      if (SEASON_DIR.test(name.trim())) continue;
      if (COLLECTION_DIR.test(name) || CONTAINER_NAMES.test(cleanName(name))) break;
      out.seriesFolder = name;
      break;
    }
  }

  if (out.year == null) {
    const fromFile = yearIn(file);
    const fromFolder = out.seriesFolder ? yearIn(out.seriesFolder) : null;
    if (fromFile) { out.year = fromFile; reasons.year = `year ${fromFile} in the filename`; }
    else if (fromFolder) { out.year = fromFolder; reasons.year = `year ${fromFolder} in the folder name`; }
  }

  const durationKind = kindFromDuration(duration);
  const pathFacets = suggestFacetsFromPath(String(ref));
  if (durationKind === 'commercial') {
    out.kind = 'commercial';
    reasons.kind = 'a minute or shorter';
  } else if (out.episode != null && durationKind !== 'movie') {
    out.kind = durationKind === 'short' ? 'short' : 'episode';
    reasons.kind = `${reasons.episode}, ${Math.round(duration / 60)} min`;
  } else if (durationKind === 'movie') {
    out.kind = 'movie';
    reasons.kind = `${Math.round(duration / 60)} min`;
  } else if (durationKind === 'short') {
    out.kind = 'short';
    reasons.kind = `${Math.round(duration / 60)} min`;
  } else if (durationKind === 'episode') {
    // A half-hour file in a "movies" folder is a special, not a movie.
    out.kind = 'episode';
    reasons.kind = `${Math.round(duration / 60)} min`;
  }

  // Sports: a genre and a kind of their own. Gated on length — a game is long,
  // and a seven-minute cartoon called "Baseball Bugs" is not a sports recording.
  const sports = Number(duration) >= 30 * 60 && SPORTS.test(segments.join(' ').replace(/[._]+/g, ' '));
  if (sports && out.kind !== 'commercial') {
    out.kind = 'other';
    reasons.kind = 'a sports recording';
  }

  // The filename prefix before an episode code ("Classic_Cartoons_-_S1953E05",
  // "Puppy Pals S03E52") names the series too. It is the only source for a
  // provider ref, whose folder is an opaque id such as an archive.org item.
  let prefix = null;
  for (const pattern of EPISODE_PATTERNS) {
    const match = file.match(pattern);
    if (!match) continue;
    if (match.index > 1) {
      const candidate = cleanName(file.slice(0, match.index).replace(/[\s._-]+$/, ''));
      if (candidate.length >= 2) prefix = candidate;
    }
    break;
  }
  if (out.kind === 'episode' || out.kind === 'short') {
    if (out.seriesFolder) {
      out.series = cleanName(out.seriesFolder);
      reasons.series = `folder "${out.seriesFolder}"`;
    } else if (prefix) {
      out.series = prefix;
      reasons.series = `filename "${prefix} …"`;
    }
  }

  const genre = sports ? [...new Set(['sports', ...pathFacets.genre])] : pathFacets.genre;
  if (genre.length) {
    out.genre = genre;
    reasons.genre = sports ? 'a sports recording' : `"${genre.join(', ')}" in the path`;
  }
  const era = out.year ? `${Math.floor(out.year / 10) * 10}s` : pathFacets.era;
  if (era) {
    out.era = era;
    reasons.era = reasons.year || 'a year in the path';
  }

  const base = file.replace(/\.[^.]+$/, '');
  const title = stripReleaseTags(guessCleanTitle(base));
  // "Blues_Clues_S03E52" cleans to the series name, which is not a title.
  if (title && !(out.series && title.toLowerCase() === out.series.toLowerCase())) {
    out.title = title;
    reasons.title = 'cleaned filename';
  }

  return { ...out, reasons };
}

function isLocked(item, field) {
  const provenance = item.provenance && item.provenance[field];
  return provenance === 'user' || provenance === 'user-accepted';
}

function hasValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

// The fields a group can suggest, and how to read an item's current value.
const FIELDS = {
  kind: { read: (item) => item.kind },
  series: { read: (item) => item.series && item.series.name },
  genre: { read: (item) => item.facets && item.facets.genre },
  era: { read: (item) => item.facets && item.facets.era },
};

/**
 * Groups of suggestions over a set of library items. Each group:
 *   { key, label, itemIds, fields: { kind?, series?, genre?, era? }, reasons, perItem }
 * `fields` holds only values every analysed item in the group agrees on (an
 * item with no signal for a field doesn't disagree), and only for items where
 * that field is empty and not locked. `perItem` carries per-item extras that
 * don't generalise — season, episode, a cleaned title — applied only to items
 * whose title is empty.
 */
export function suggestGroups(items) {
  const groups = new Map();

  items.forEach((item) => {
    const analysis = analyzeRef(item.ref, item.duration);
    const key = analysis.series
      ? `series:${analysis.series.toLowerCase()}`
      : `folder:${segmentsOf(item.ref).slice(0, -1).join('/').toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: analysis.series || segmentsOf(item.ref).slice(-2, -1)[0] || 'Unsorted',
        entries: [],
      });
    }
    groups.get(key).entries.push({ item, analysis });
  });

  const result = [];
  groups.forEach((group) => {
    const fields = {};
    const reasons = {};

    Object.keys(FIELDS).forEach((field) => {
      // Only items that still need this field take part.
      const open = group.entries.filter(({ item }) => !isLocked(item, field) && !hasValue(FIELDS[field].read(item)));
      if (!open.length) return;
      const values = open.map(({ analysis }) => analysis[field]).filter(hasValue);
      if (!values.length) return;
      const first = JSON.stringify(values[0]);
      // Unanimous among items that have a signal. A disagreement means the
      // group isn't actually uniform, and a blanket suggestion would be wrong
      // for some of it — those items get nothing for this field, not a guess.
      if (!values.every((value) => JSON.stringify(value) === first)) return;
      // Sibling consistency: one signal is enough to cover siblings with none,
      // but only when most of the group spoke up.
      if (values.length / open.length < 0.5) return;
      fields[field] = values[0];
      const sample = open.find(({ analysis }) => hasValue(analysis[field]));
      reasons[field] = values.length === open.length
        ? sample.analysis.reasons[field]
        : `${sample.analysis.reasons[field]} (${values.length} of ${open.length}; siblings follow)`;
    });

    const perItem = {};
    group.entries.forEach(({ item, analysis }) => {
      const extra = {};
      if (analysis.season != null) extra.season = analysis.season;
      if (analysis.episode != null) extra.episode = analysis.episode;
      if (analysis.title && !hasValue(item.title) && !isLocked(item, 'title')) extra.title = analysis.title;
      if (Object.keys(extra).length) perItem[item.id] = extra;
    });

    if (!Object.keys(fields).length && !Object.keys(perItem).length) return;
    result.push({
      key: group.key,
      label: group.label,
      itemIds: group.entries.map(({ item }) => item.id),
      fields,
      reasons,
      perItem,
    });
  });

  // Biggest groups first: the most review value per action.
  return result.sort((a, b) => b.itemIds.length - a.itemIds.length || a.label.localeCompare(b.label));
}

/**
 * The item updates accepting a group produces, for the items the reviewer left
 * ticked. Every written field is marked `user-accepted`, which is what stops a
 * later automatic pass from suggesting over it.
 */
export function acceptGroup(group, itemsById, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  const updates = [];
  group.itemIds.forEach((id) => {
    if (skip.has(id)) return;
    const item = itemsById[id];
    if (!item) return;
    const fields = {};
    const provenance = { ...(item.provenance || {}) };
    const facets = { ...(item.facets || {}) };
    let facetsChanged = false;

    if (group.fields.kind && !isLocked(item, 'kind') && !hasValue(item.kind)) {
      fields.kind = group.fields.kind;
      provenance.kind = 'user-accepted';
    }
    if (group.fields.series && !isLocked(item, 'series') && !hasValue(item.series && item.series.name)) {
      const extra = group.perItem[id] || {};
      fields.series = { name: group.fields.series, season: extra.season ?? null, episode: extra.episode ?? null };
      provenance.series = 'user-accepted';
    }
    ['genre', 'era'].forEach((field) => {
      if (group.fields[field] && !isLocked(item, field) && !hasValue(facets[field])) {
        facets[field] = group.fields[field];
        provenance[field] = 'user-accepted';
        facetsChanged = true;
      }
    });
    if (facetsChanged) fields.facets = facets;
    const extra = group.perItem[id];
    if (extra && extra.title && !isLocked(item, 'title') && !hasValue(item.title)) {
      fields.title = extra.title;
      provenance.title = 'user-accepted';
    }
    if (!Object.keys(fields).length) return;
    fields.provenance = provenance;
    updates.push({ id, fields });
  });
  return updates;
}

export const __test = { kindFromDuration, segmentsOf, cleanName, yearIn };
