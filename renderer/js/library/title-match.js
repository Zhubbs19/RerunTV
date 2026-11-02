// What a file is, for looking it up in an online catalogue: its season and
// episode, the words to search for, whether it looks like a film or a show,
// and the year in its name. Shared by every metadata plugin through
// ctx.titleMatch (plugin/host.js, ctx v11), so TMDB, TVmaze and whatever
// comes next read a file the same way.
//
// Pure: no DOM, no config. Reads a playlist entry ({ path, title, series,
// duration }) and returns plain values.

const hasText = (value) => typeof value === 'string' && value.trim() !== '';
const segments = (filePath) => String(filePath || '').split(/[\\/]+/).filter(Boolean);

// Episode codes, as the library's tagging reads them: S02E01, s2.e1, 2x01.
// A four-digit "season" is the library's season-as-year convention for old
// cartoons (S1953E05), which online catalogues have no seasons for.
const EPISODE_CODES = [
  /(?<![a-z0-9])s(\d{1,4})[ ._-]?e(\d{1,3})(?![0-9])/i,
  /(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i,
];
const SEASON_DIR = /^(s(eason)?[ ._-]?\d{1,4}|specials?)$/i;

function codeIn(name) {
  for (const pattern of EPISODE_CODES) {
    const match = name.match(pattern);
    if (match) return { season: Number(match[1]), episode: Number(match[2]), index: match.index };
  }
  return null;
}

// A file name without its extension and a trailing bracket group of release
// junk ("[1080p]"). A group with a year in it stays, for splitYear.
function cleanName(name) {
  return name.replace(/\.[^./\\]+$/, '').replace(/[[(](?![^\])]*\b(?:19|20)\d\d\b)[^\])]*[\])]\s*$/, '').trim();
}

/** The season and episode a file is, from its series details or its name. */
export function episodeOf(file) {
  const series = file && file.series;
  if (series && Number.isInteger(series.season) && Number.isInteger(series.episode) && series.season < 1900) {
    return { season: series.season, episode: series.episode };
  }
  const code = codeIn(segments(file && file.path).pop() || '');
  return code && code.season < 1900 ? { season: code.season, episode: code.episode } : null;
}

/**
 * What to search for. An episode is searched by its show: the series name it
 * was given, the name before its episode code, or the folder it sits in past
 * any season folder. Anything else by its title or cleaned file name.
 */
export function searchQueryFor(file) {
  const parts = segments(file && file.path);
  const name = parts[parts.length - 1] || '';
  if (episodeOf(file)) {
    if (file.series && hasText(file.series.name)) return file.series.name.trim();
    const code = codeIn(name);
    const before = code ? name.slice(0, code.index).replace(/[._]+/g, ' ').replace(/[\s\-–—]+$/, '').trim() : '';
    if (before.length >= 2) return before;
    const folder = parts.slice(0, -1).reverse().find((dir) => !SEASON_DIR.test(dir.trim()));
    if (folder) return folder.replace(/[._]+/g, ' ').trim();
  }
  return (hasText(file && file.title) ? file.title : cleanName(name)).trim();
}

/** 'tv' for an episode, 'movie' for anything feature length, else null. */
export function preferredKind(file) {
  if (episodeOf(file)) return 'tv';
  return Number(file && file.duration) >= 70 * 60 ? 'movie' : null;
}

const LEADING_YEAR = /^\(?\s*((?:19|20)\d\d)\s*\)?\s*[.\-–—:]+\s*/;
const TRAILING_GROUP_YEAR = /\s*[([][^)\]]*\b((?:19|20)\d\d)\b[^)\]]*[)\]]\s*$/;
const TRAILING_YEAR = /[\s._-]+((?:19|20)\d\d)$/;

/**
 * A name's year is not part of the title, and catalogue searches find nothing
 * with it left in: "Some Special 1964", "Some Film (2004)", "(1995). Some
 * Film", "1977 - Some Film", "An Episode (February 13, 1943)". It comes out
 * of the query to rank the results instead. A title that is only a year
 * ("1917") is left alone, and a "year" past next year is part of the title.
 */
export function splitYear(query, now = new Date()) {
  let title = String(query || '').trim();
  if (!/\s/.test(title)) title = title.replace(/[._]+/g, ' ');
  let year = null;
  const plausible = (y) => y >= 1900 && y <= now.getFullYear() + 1;
  [LEADING_YEAR, TRAILING_GROUP_YEAR, TRAILING_YEAR].forEach((pattern) => {
    const match = title.match(pattern);
    if (!match || !plausible(Number(match[1]))) return;
    const rest = title.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
    if (rest.length < 2) return;
    title = rest;
    if (year == null) year = Number(match[1]);
  });
  return { title, year };
}

/**
 * Results ({ year, mediaType }) from the named year first, then a year either
 * side; among equals the preferred kind; otherwise the catalogue's own order.
 */
export function rankByYear(results, year, prefer = null) {
  if (!year && !prefer) return results;
  const distance = (r) => {
    if (!year) return 0;
    const y = Number(r.year);
    if (!y) return 3;
    const d = Math.abs(y - year);
    return d === 0 ? 0 : d === 1 ? 1 : 2;
  };
  const kind = (r) => (prefer && r.mediaType !== prefer ? 1 : 0);
  return results.map((r, i) => ({ r, i }))
    .sort((a, b) => distance(a.r) - distance(b.r) || kind(a.r) - kind(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** Text from a catalogue's HTML summary ("<p>It <b>begins</b>.</p>"). */
export function plainSummary(html) {
  if (!html) return '';
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>\s*<p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
      }
      return entities[code.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
