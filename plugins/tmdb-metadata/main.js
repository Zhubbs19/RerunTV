// TMDB metadata lookup (TITLES tab "MATCH TMDB") — migrated out of core main.js.
// Only ever called on explicit user action from the TITLES tab (no
// background polling), and results are cached on disk (ctx.fetchJsonCached)
// since the same title is often re-searched while editing a channel. Search
// results are cached briefer than a specific movie/show's details, since a
// title search is more likely to be refined/retried.
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

const LEADING_YEAR = /^\(?\s*((?:19|20)\d\d)\s*\)?\s*[.\-–—:]+\s*/;
const TRAILING_GROUP_YEAR = /\s*[([][^)\]]*\b((?:19|20)\d\d)\b[^)\]]*[)\]]\s*$/;
const TRAILING_YEAR = /[\s._-]+((?:19|20)\d\d)$/;

/**
 * A file name's year is not part of the title, and TMDB's search finds
 * nothing with it left in: "Some Special 1964", "Some Film (2004)",
 * "(1995). Some Film", "1977 - Some Film", "An Episode (February 13, 1943)",
 * "Some Special (1965, HD)". The year comes out of the query and ranks the
 * results instead. A title that is only a year ("1917") is left alone, and
 * a "year" past next year is part of the title ("... 2049").
 */
function splitYear(query) {
  let title = String(query || '').trim();
  if (!/\s/.test(title)) title = title.replace(/[._]+/g, ' ');
  let year = null;
  const plausible = (y) => y >= 1900 && y <= new Date().getFullYear() + 1;
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

// The result from the named year first, then a year either side (a TV
// special's TMDB date is often its first broadcast, a film's its premiere),
// otherwise TMDB's own order.
function rankByYear(results, year) {
  if (!year) return results;
  const distance = (r) => {
    const y = Number(r.year);
    if (!y) return 3;
    const d = Math.abs(y - year);
    return d === 0 ? 0 : d === 1 ? 1 : 2;
  };
  return results.map((r, i) => ({ r, i })).sort((a, b) => distance(a.r) - distance(b.r) || a.i - b.i).map(({ r }) => r);
}

function activate(ctx) {
  const { ipcMain, fetchJsonCached } = ctx;

  ipcMain.handle('tmdb:search', async (event, opts) => {
    const apiKey = opts && opts.apiKey;
    const query = opts && opts.query && opts.query.trim();
    if (!apiKey) return { results: [], error: 'No TMDB API key set (PLUGINS › TMDB Metadata › SETTINGS).' };
    if (!query) return { results: [] };
    const search = async (text) => {
      const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(text)}&include_adult=false`;
      const data = await fetchJsonCached(
        `tmdb:search:${text.toLowerCase()}`,
        url,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
        15 * 60 * 1000,
      );
      return (data.results || [])
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .map((r) => ({
          id: r.id,
          mediaType: r.media_type,
          title: r.title || r.name,
          year: (r.release_date || r.first_air_date || '').slice(0, 4),
          overview: r.overview || '',
          posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
        }));
    };
    try {
      const { title, year } = splitYear(query);
      let results = await search(title);
      // A year that really was part of the title ("Outpost: 1999") finds
      // nothing once removed; the name as written gets a second try.
      if (!results.length && title !== query) results = await search(query);
      return { results: rankByYear(results, year).slice(0, 6) };
    } catch (err) {
      return { results: [], error: err.message };
    }
  });

  ipcMain.handle('tmdb:getCredits', async (event, opts) => {
    const apiKey = opts && opts.apiKey;
    const { id, mediaType } = opts || {};
    if (!apiKey || !id || !mediaType) return { cast: [] };
    try {
      const url = `https://api.themoviedb.org/3/${mediaType}/${id}/credits`;
      const data = await fetchJsonCached(
        `tmdb:credits:${mediaType}:${id}`,
        url,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
        7 * 24 * 60 * 60 * 1000,
      );
      const cast = (data.cast || []).slice(0, 5).map((c) => c.name);
      return { cast };
    } catch (err) {
      return { cast: [] };
    }
  });
}

module.exports = { activate, __test: { splitYear, rankByYear } };
