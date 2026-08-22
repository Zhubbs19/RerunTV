import { GUIDE_SLOT_MS, S } from './state.js';

export function getDisplayTitle(file) {
  return (file.title && file.title.trim()) ? file.title.trim() : guessCleanTitle(basenameNoExt(file.path));
}

// Most of this library follows "Show - SxxExx - Episode Title" (or just
// "SxxExx - Episode Title (tech tags)") once underscores are read as
// spaces. Strip the season/episode code, keep only the last " - "
// segment (the show name is already shown alongside this text in the
// UI, so a leading "Show Name -" prefix would be redundant), then strip
// trailing parenthetical/bracketed tags like "(1080p BluRay x265 Ghost)".
// Falls back to the untouched basename if nothing recognizable is found.
export function guessCleanTitle(rawBase) {
  let s = rawBase.replace(/_/g, ' ').trim();

  s = s.replace(/\s*-?\s*(?:S\d{2,4}E\d{2,4}|\d{1,2}x\d{2,3})\s*-?\s*/i, ' - ');
  s = s.replace(/^[\s-]+|[\s-]+$/g, '').trim();

  const parts = s.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0) s = parts[parts.length - 1];

  let stripped = s.replace(/\s*[\(\[][^()[\]]*[)\]]\s*$/, '').trim();
  while (stripped && stripped !== s) {
    s = stripped;
    stripped = s.replace(/\s*[\(\[][^()[\]]*[)\]]\s*$/, '').trim();
  }

  return s || rawBase;
}

// A separate, more aggressive cleaner for scene/release-style names that
// `guessCleanTitle` doesn't reach — it only strips a bracket group that's
// the very last thing in the string, so something like
// "Title [Release Sources (Streaming Service) 1 0 WEBDL-1080p][EAC3 2.0][h265]-RCVR"
// defeats it outright (the trailing "-RCVR" release-group tag means the
// string doesn't end on a closing bracket). This one strips bracket groups
// anywhere, then a trailing release-group tag, then loose quality/codec
// tokens that were never bracketed to begin with.
const RELEASE_QUALITY_TOKENS = /\b(?:WEB[\s-]?DL|WEBRip|HDTV|Blu[\s-]?Ray|BDRip|DVDRip|REMUX|HDR10?|10bit|8bit|\d{3,4}p|x264|x265|h\.?264|h\.?265|hevc|AVC|AAC(?:\d(?:\.\d)?)?|EAC3|AC3|DDP?\d?(?:\.\d)?|FLAC|PROPER|REPACK|UNCUT|EXTENDED|LIMITED)\b/gi;

export function stripReleaseTags(rawBase) {
  let s = rawBase.replace(/_/g, ' ').trim();

  // Bracket groups anywhere, repeated (they're often stacked back to back).
  let prev;
  do {
    prev = s;
    s = s.replace(/[\(\[][^()[\]]*[)\]]/g, ' ');
  } while (s !== prev);

  // Trailing "-RCVR" / "-YIFY" / "-RARBG"-style release-group tag.
  s = s.replace(/-[A-Za-z0-9]{2,12}\s*$/, ' ');

  // Loose (non-bracketed) quality/codec tokens.
  s = s.replace(RELEASE_QUALITY_TOKENS, ' ');

  // Stray version-ish digit pairs left behind (e.g. "1 0" from "1.0").
  s = s.replace(/\b\d\s+\d\b/g, ' ');

  s = s.replace(/\s+/g, ' ').replace(/^[\s\-.]+|[\s\-.]+$/g, '').trim();

  return s || rawBase;
}

// A modest, honest keyword list — genre inference from a filename alone is
// inherently fuzzy, so this only matches generic descriptive words a real
// release/folder name plausibly contains, not specific franchise/show
// names (which would mean hardcoding IP-specific guesses into a generic
// tool). Better to suggest nothing than a wrong guess.
const GENRE_KEYWORDS = {
  cartoon: 'cartoon', animated: 'cartoon', animation: 'cartoon', anime: 'anime',
  sitcom: 'sitcom', comedy: 'comedy', drama: 'drama', horror: 'horror', thriller: 'thriller',
  action: 'action', documentary: 'documentary', doc: 'documentary', kids: 'kids', children: 'kids',
  christmas: 'holiday', xmas: 'holiday', holiday: 'holiday', halloween: 'holiday',
  musical: 'musical', music: 'music', sports: 'sports', news: 'news', talk: 'talk',
};

// Guesses genre/era/content-type facets purely from a file's own path
// (filename + parent folders) — no file content is read. Each field is
// only populated when a reasonably confident signal was found; the caller
// (setup-panels.js's "SUGGEST FACETS" bulk action) only fills in a facet
// that's currently empty, so this is always a suggestion layered under
// whatever the user has already set by hand or via a previous suggestion,
// never a silent overwrite.
export function suggestFacetsFromPath(fullPath) {
  const haystack = fullPath.toLowerCase();

  const genre = [];
  Object.keys(GENRE_KEYWORDS).forEach((kw) => {
    if (new RegExp(`\\b${kw}\\b`).test(haystack) && !genre.includes(GENRE_KEYWORDS[kw])) genre.push(GENRE_KEYWORDS[kw]);
  });

  // S01E02 / S1985E12 (this library's own convention for old cartoons —
  // season number as release year) / 1x02, or the words "season"/"episode"
  // spelled out, all mean episodic content; an explicit "Movie(s)" folder
  // is the only movie signal confident enough to guess from a path alone.
  let contentType = null;
  if (/s\d{1,4}e\d{1,3}/i.test(haystack) || /\d{1,2}x\d{2,3}/.test(haystack) || /\bseason\b/.test(haystack) || /\bepisode\b/.test(haystack)) {
    contentType = 'show';
  } else if (/\bmovies?\b/.test(haystack)) {
    contentType = 'movie';
  }

  // A plausible release-year window (1930-2029) anywhere in the path,
  // folded to its decade — deliberately excludes anything that reads like
  // a resolution/bitrate token (1080p etc. never matches 19xx/20xx).
  let era = null;
  const yearMatch = fullPath.match(/(19[3-9]\d|20[0-2]\d)/);
  if (yearMatch) era = `${Math.floor(parseInt(yearMatch[1], 10) / 10) * 10}s`;

  return { genre, era, contentType };
}

export function formatHourLabel(h) {
  if (S.config.display && S.config.display.clock24) return `${String(h).padStart(2, '0')}:00`;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr} ${ampm}`;
}

export function formatClock(d) {
  const h = d.getHours(), m = d.getMinutes();
  if (S.config.display && S.config.display.clock24) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function formatOffset(ms) {
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function basenameNoExt(filePath) {
  const base = filePath.split(/[\\/]/).pop() || filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function floorToSlot(ms) {
  return Math.floor(ms / GUIDE_SLOT_MS) * GUIDE_SLOT_MS;
}

export function formatSlotLabel(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  if (S.config.display && S.config.display.clock24) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const ampm = h >= 12 ? 'p' : 'a';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

// Walk one source's (looping) file list forward from segStart, returning
// { file, start, end } entries clipped to segEnd — entries crossing segEnd

export function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function pad2(n) { return String(n).padStart(2, '0'); }

// datetime-local's value format is always "YYYY-MM-DDTHH:mm" in the input's
// own local time, regardless of locale — building it by hand (rather than
// via toISOString, which is UTC) keeps the picker's default showing the
// machine's actual current local time.
export function toDatetimeLocalValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Short, unique-enough-for-this-app id: <prefix>-<time>-<random>. Not
// collision-proof (no uniqueness check against existing ids), same as
// every call site that hand-rolled this before it lived here — fine for
// UI-scoped ids (blocks, profiles, daypart slots, interstitial pool
// entries) that are never compared across app installs.
export function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function randomInterstitialId() {
  return randomId('int');
}

export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// mulberry32 — small, fast, deterministic PRNG from a 32-bit seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A curated title always wins; otherwise fall back to the cleaned-up
// filename, same as before per-file titles existed — except the fallback
// is now a cleaned-up guess (strip season/episode codes and trailing
