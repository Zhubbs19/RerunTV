// Small helpers shared across the renderer: display titles and filename cleanup, clock and
// duration formatting, ids, seeded randomness, and a few one-line utilities. Check here before
// writing a new one-off helper.
import { guideSlotMs, S } from './state.js';

/**
 * The title to show for a file: its curated `title`, else a cleaned-up guess from the filename.
 * @param {object} file A channel file entry ({ path, title?, ... }).
 * @returns {string} The display title.
 */
export function getDisplayTitle(file) {
  if (file.title && file.title.trim()) return file.title.trim();
  return stripReleaseTags(guessCleanTitle(basenameNoExt(file.path)));
}

/**
 * The series a file belongs to: its library series name, else the part of a
 * "Show - S01E02 - Title" filename before the episode code. null when neither
 * says (a movie, a bumper, a bare episode title).
 * @param {?object} file A channel file entry.
 * @returns {?string} The series name, or null.
 */
export function guessSeriesName(file) {
  if (!file) return null;
  const named = file.series && file.series.name && String(file.series.name).trim();
  if (named) return named;
  const base = basenameNoExt(file.path || '').replace(/[._]+/g, ' ');
  const match = base.match(/^(.*?)\s*-?\s*(?:S\d{2,4}E\d{2,4}|\b\d{1,2}x\d{2,3})\b/i);
  const show = match && match[1].replace(/[\s-]+$/, '').trim();
  return show || null;
}

/**
 * Most of this library follows "Show - SxxExx - Episode Title" (or just
 * "SxxExx - Episode Title (tech tags)") once underscores are read as
 * spaces. Strip the season/episode code, keep only the last " - "
 * segment (the show name is already shown alongside this text in the
 * UI, so a leading "Show Name -" prefix would be redundant), then strip
 * trailing parenthetical/bracketed tags like "(1080p BluRay x265 Ghost)".
 * Falls back to the untouched basename if nothing recognizable is found.
 * @param {string} rawBase A filename without its extension.
 * @returns {string} The cleaned title.
 */
export function guessCleanTitle(rawBase) {
  // Dots are the dominant separator in archive/release filenames; treating
  // them as punctuation produced guide labels such as
  // "Email.Surveillance...2CH..." even after codec tags were removed.
  let s = rawBase.replace(/[._]+/g, ' ').trim();

  s = s.replace(/\s*-?\s*(?:S\d{2,4}E\d{2,4}|\d{1,2}x\d{2,3})\s*-?\s*/i, ' - ');
  s = s.replace(/^[\s-]+|[\s-]+$/g, '').trim();

  const parts = s.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0) s = parts[parts.length - 1];

  let stripped = s.replace(/\s*[([][^()[\]]*[)\]]\s*$/, '').trim();
  while (stripped && stripped !== s) {
    s = stripped;
    stripped = s.replace(/\s*[([][^()[\]]*[)\]]\s*$/, '').trim();
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
const RELEASE_QUALITY_TOKENS = /\b(?:WEB[\s-]?DL|WEBRip|HDTV|Blu[\s-]?Ray|BDRip|DVDRip|REMUX|HDR10?|10bit|8bit|\d{3,4}p|x264|x265|h\.?264|h\.?265|hevc|AVC|AAC(?:\d(?:\.\d)?)?|EAC3|AC3|DDP?\d?(?:\.\d)?|\d(?:\.\d)?CH|FLAC|PROPER|REPACK|UNCUT|EXTENDED|LIMITED)\b/gi;

/**
 * Strips release-name noise (bracket groups, a trailing release-group tag, quality and codec
 * tokens) from a filename; see the comment above `RELEASE_QUALITY_TOKENS`.
 * @param {string} rawBase A filename without its extension.
 * @returns {string} The cleaned text, or `rawBase` when nothing is left.
 */
export function stripReleaseTags(rawBase) {
  let s = rawBase.replace(/[._]+/g, ' ').trim();

  // Bracket groups anywhere, repeated (they're often stacked back to back).
  let prev;
  do {
    prev = s;
    s = s.replace(/[([][^()[\]]*[)\]]/g, ' ');
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

/**
 * Health-check signal, not an automatic rewrite: explicit user/plugin
 * titles are authoritative. Only fallback filenames with strong release-
 * name signals are flagged so a normal untitled file such as "Pilot.mkv"
 * does not turn into noise in the diagnostics panel.
 * @param {?object} file A channel file entry.
 * @returns {boolean} True when the file has no title and its filename looks like a release name.
 */
export function titleNeedsMetadata(file) {
  if (!file || (typeof file.title === 'string' && file.title.trim())) return false;
  const base = basenameNoExt(file.path || '');
  const separatorCount = (base.match(/[._]/g) || []).length;
  return separatorCount >= 3
    || /\b(?:WEB[ ._-]?DL|WEBRip|Blu[ ._-]?Ray|REMUX|\d{3,4}p|x26[45]|h[ .]?26[45]|HEVC|EAC3|DDP?\d?|\d(?:\.\d)?CH)\b/i.test(base)
    || /\[[^\]]+\]|\([^)]*(?:codec|source|release|stream)[^)]*\)/i.test(base);
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
  christmas: 'holiday', xmas: 'holiday', holiday: 'holiday', halloween: 'holiday', thanksgiving: 'holiday',
  musical: 'musical', music: 'music', concert: 'music', sports: 'sports', news: 'news', talk: 'talk',
  'sci-fi': 'sci-fi', scifi: 'sci-fi', 'science fiction': 'sci-fi', western: 'western', westerns: 'western',
  fantasy: 'fantasy', romance: 'romance', crime: 'crime', mystery: 'mystery', adventure: 'adventure',
  family: 'family', 'game show': 'game-show', 'game shows': 'game-show', reality: 'reality', soap: 'soap',
  soaps: 'soap', variety: 'variety', wrestling: 'sports', noir: 'noir',
};

/**
 * Guesses genre/era/content-type facets purely from a file's own path
 * (filename + parent folders) — no file content is read. Each field is
 * only populated when a reasonably confident signal was found; the caller
 * (setup-panels.js's "SUGGEST FACETS" bulk action) only fills in a facet
 * that's currently empty, so this is always a suggestion layered under
 * whatever the user has already set by hand or via a previous suggestion,
 * never a silent overwrite.
 * @param {string} fullPath The file's full path.
 * @returns {{genre: string[], era: ?string, contentType: ?string}} The suggested facets; empty or
 *   null where nothing was found.
 */
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

/**
 * Formats an hour of the day as "15:00" or "3 PM", per the 24-hour clock setting.
 * @param {number} h The hour, 0-23.
 * @returns {string} The label.
 */
export function formatHourLabel(h) {
  if (S.config.display && S.config.display.clock24) return `${String(h).padStart(2, '0')}:00`;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr} ${ampm}`;
}

/**
 * Formats a time as "15:04" or "3:04 PM", per the 24-hour clock setting.
 * @param {Date} d The time.
 * @returns {string} The clock text.
 */
export function formatClock(d) {
  const h = d.getHours(), m = d.getMinutes();
  if (S.config.display && S.config.display.clock24) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Formats a signed time offset as "+1:02:03" or a minus sign and "4:05".
 * @param {number} ms The offset, in ms.
 * @returns {string} The offset text.
 */
export function formatOffset(ms) {
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Formats a duration as "1:02:03" or "4:05".
 * @param {number} seconds The duration in seconds; negative or missing counts as 0.
 * @returns {string} The duration text.
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Reimplemented inline as JSON.parse(JSON.stringify(...)) in several
 * call sites before this existed — config objects (channels, blocks,
 * packages) are plain JSON-shaped data, so this is a fine deep clone for
 * them specifically (no Date/Map/Set/function values to lose).
 * @param {*} value A JSON-safe value.
 * @returns {*} The copy.
 */
export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Safe for element text and for quoted attribute values (quotes escaped too).
 * @param {*} str The text; null or undefined gives an empty string.
 * @returns {string} The escaped text.
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The last path segment without its extension (and without a ".ia.<ext>" suffix).
 * @param {string} filePath A path, either slash style.
 * @returns {string} The bare name.
 */
export function basenameNoExt(filePath) {
  const base = filePath.split(/[\\/]/).pop() || filePath;
  // Some remote-media plugins' own transcode pipelines name derivatives
  // "<name>.ia.<ext>" — a file downloaded locally via a "save to a local
  // folder" action keeps that name, so a plain single-extension strip left
  // titles reading "<name>.ia" once the file was no longer plugin-sourced.
  const withoutIaSuffix = base.replace(/\.ia\.[a-z0-9]+$/i, '');
  if (withoutIaSuffix !== base) return withoutIaSuffix;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Rounds an instant down to the start of its guide column.
 * @param {number} ms An instant, in ms.
 * @returns {number} The slot start, in ms.
 */
export function floorToSlot(ms) {
  return Math.floor(ms / guideSlotMs()) * guideSlotMs();
}

/**
 * Formats a guide column's start as "15:30" or "3:30p", per the 24-hour clock setting.
 * @param {number} ms The slot start, in ms.
 * @returns {string} The label.
 */
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

/**
 * Seconds before a file's end where its credits were found to start
 * (file.creditsFound, from FIND FADES / FIND ACT BREAKS), or null when none
 * were found or PROGRAMMING › CADENCE & PRESETS › "Speed up credits from
 * where they start" is off. Callers put it in place of a channel's default
 * lead time; a lead typed for the file itself still wins over it.
 * @param {object} file A channel file entry ({ path, title?, ... }).
 * @param {object} config The app config; reads `commercials.useFoundCredits`.
 * @returns {?number} The lead in seconds, or null.
 */
export function foundCreditsLead(file, config) {
  if (config && config.commercials && config.commercials.useFoundCredits === false) return null;
  const found = file && file.creditsFound;
  return found && Number(found.leadS) > 0 ? Number(found.leadS) : null;
}

/**
 * A feature config block (static-effect, test-pattern, ...) is "on" unless
 * it exists and explicitly says otherwise — no config at all still means
 * enabled (the feature's own default), same as a config block that exists
 * but never set `enabled` at all.
 * @param {?object} config The feature's config block.
 * @returns {boolean} False only when `enabled` is explicitly false.
 */
export function isEnabledByDefault(config) {
  return !config || config.enabled !== false;
}

/**
 * A numeric setting, or null when it is unset, blank or not a number. Plain
 * Number() reads null and '' as 0, which a clamp would turn into a real value
 * (a cleared field in the phone Settings editor became a 10% volume ceiling).
 * @param {*} value The stored setting.
 * @returns {?number} The number, or null.
 */
export function settingNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fisher-Yates, in place.
 * @param {Array<*>} arr The array to shuffle.
 */
export function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Zero-pads a number to two digits.
 * @param {number} n The number.
 * @returns {string} The padded string.
 */
export function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * "1 title" / "1,204 titles".
 * @param {number} n The count.
 * @param {string} one The singular noun.
 * @param {string} [many] The plural noun; defaults to `one` plus "s".
 * @returns {string} The count and noun.
 */
export function plural(n, one, many = `${one}s`) {
  return `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * Last path segment, either slash style.
 * @param {?string} ref A path or media ref.
 * @returns {string} The last segment.
 */
export function basename(ref) {
  return String(ref || '').split(/[\\/]/).pop();
}

/**
 * Limits a value to [low, high].
 * @param {number} value The value.
 * @param {number} low The minimum.
 * @param {number} high The maximum.
 * @returns {number} The clamped value.
 */
export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Trailing-edge debounce: runs fn once, ms after the last call.
 * @param {Function} fn The function to run.
 * @param {number} ms The quiet period, in ms.
 * @returns {Function} The debounced wrapper; it passes along the last call's arguments.
 */
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/**
 * datetime-local's value format is always "YYYY-MM-DDTHH:mm" in the input's
 * own local time, regardless of locale — building it by hand (rather than
 * via toISOString, which is UTC) keeps the picker's default showing the
 * machine's actual current local time.
 * @param {Date} d The time.
 * @returns {string} The "YYYY-MM-DDTHH:mm" value.
 */
export function toDatetimeLocalValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Short, unique-enough-for-this-app id: <prefix>-<time>-<random>. Not
 * collision-proof (no uniqueness check against existing ids), same as
 * every call site that hand-rolled this before it lived here — fine for
 * UI-scoped ids (blocks, profiles, daypart slots, interstitial pool
 * entries) that are never compared across app installs.
 * @param {string} prefix The id prefix, e.g. "block".
 * @returns {string} The id.
 */
export function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A fresh id for an interstitial pool entry (`int-...`).
 * @returns {string} The id.
 */
export function randomInterstitialId() {
  return randomId('int');
}

/**
 * Cancels `prevTimer` (harmless if it's null/already fired) and arms a fresh
 * setTimeout(fn, ms) in its place — returns the new timer id, which the
 * caller stores back wherever it keeps it (an S.xxxTimer field, or a local
 * closure variable). Shared shape behind the "auto-hide an overlay/banner
 * after N ms, restarting the clock on every re-trigger" idiom that recurs
 * across guide.js/virtual.js (guide overlay), playback.js (up-next banner,
 * rating bug), power.js (volume indicator), curation-scheduler.js (the fun
 * toast) and touch-controls.js (the LAN-viewer control bar) — fn is left
 * fully caller-supplied (usually a classList add/remove) rather than this
 * helper trying to guess which, so it fits all of them without a mode flag.
 * @param {?number} prevTimer The previous timer id, if any.
 * @param {number} ms The delay, in ms.
 * @param {Function} fn What to run when it fires.
 * @returns {number} The new timer id.
 */
export function autoHideAfter(prevTimer, ms, fn) {
  clearTimeout(prevTimer);
  return setTimeout(fn, ms);
}

/**
 * A small deterministic 32-bit string hash, used to seed `mulberry32`.
 * @param {string} str The text.
 * @returns {number} The unsigned 32-bit hash.
 */
export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * mulberry32 — small, fast, deterministic PRNG from a 32-bit seed.
 * @param {number} seed The seed.
 * @returns {() => number} A generator returning floats in [0, 1).
 */
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

/**
 * GitHub release notes are markdown; the panels showing them are plain text, so strip the markup
 * (headings, links, bold, bullets) rather than show it raw.
 * @param {?string} markdown The release notes.
 * @returns {string} Plain text (at most 6000 characters), or a stock line when there are none.
 */
export function readableReleaseNotes(markdown) {
  const text = String(markdown || '').trim();
  if (!text) {
    return 'RerunTV was updated successfully. Your channels and settings are ready exactly where you left them.';
  }
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 6000);
}
