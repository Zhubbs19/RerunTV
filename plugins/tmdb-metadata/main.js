// TMDB metadata lookup (TITLES tab "MATCH TMDB") — migrated out of core main.js.
// Only ever called on explicit user action from the TITLES tab (no
// background polling), and results are cached on disk (ctx.fetchJsonCached)
// since the same title is often re-searched while editing a channel. Search
// results are cached briefer than a specific movie/show's details, since a
// title search is more likely to be refined/retried.
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

// Patterns for a year at the start, in a trailing bracket group, or at the end of a file name.
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
 * @param {?string} query The file name or title to search for.
 * @returns {{title: string, year: ?number}} The query without its year, and the year if one was found.
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

/**
 * The result from the named year first, then a year either side (a TV
 * special's TMDB date is often its first broadcast, a film's its premiere).
 * Among equals, the kind the file looks like (`prefer`: 'movie' for a
 * feature-length file, 'tv' for an episode) comes first; otherwise TMDB's
 * own order.
 * @param {Array<object>} results Search results, each with `year` and `mediaType`.
 * @param {?number} year The year taken from the query.
 * @param {?string} [prefer=null] The media type to favour, 'movie' or 'tv'.
 * @returns {Array<object>} The results in ranked order.
 */
function rankByYear(results, year, prefer = null) {
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

/**
 * Registers the plugin's IPC handlers: `tmdb:search` and `tmdb:getCredits`.
 * @param {object} ctx The plugin's main-process ctx (`ipcMain`, `fetchJsonCached`).
 */
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
      const prefer = opts.prefer === 'movie' || opts.prefer === 'tv' ? opts.prefer : null;
      return { results: rankByYear(results, year, prefer).slice(0, 6) };
    } catch (err) {
      return { results: [], error: err.message };
    }
  });

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const getJson = (key, path, apiKey) => fetchJsonCached(
    key,
    `https://api.themoviedb.org/3/${path}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
    WEEK_MS,
  );

  // Everything a match needs after the search, in as few requests as TMDB
  // allows: the title's cast and US rating in one call (append_to_response),
  // and, given a season and episode, that episode from its whole season (one
  // cached call per season, so matching a box set costs a call per season).
  // Kept on the tmdb:getCredits channel, which already answers { cast }: a
  // new channel would change the plugin's approval and ask the user again.
  //   opts: { apiKey, id, mediaType, season?, episode? }
  //   ->    { cast, rating, episode: { season, number, name, overview, airDate } | null }
  ipcMain.handle('tmdb:getCredits', async (event, opts) => {
    const apiKey = opts && opts.apiKey;
    const { id, mediaType, season, episode } = opts || {};
    if (!apiKey || !id || !mediaType) return { cast: [] };
    const out = { cast: [], rating: null, episode: null };
    try {
      const extra = mediaType === 'tv' ? 'credits,content_ratings' : 'credits,release_dates';
      const data = await getJson(`tmdb:title:${mediaType}:${id}`, `${mediaType}/${id}?append_to_response=${extra}`, apiKey);
      out.cast = ((data.credits && data.credits.cast) || []).slice(0, 5).map((c) => c.name);
      out.rating = usRating(mediaType, data);
    } catch (err) {
      return { cast: [] };
    }
    if (mediaType === 'tv' && Number.isInteger(season) && Number.isInteger(episode)) {
      try {
        const data = await getJson(`tmdb:season:${id}:${season}`, `tv/${id}/season/${season}`, apiKey);
        out.episode = episodeFrom(data, season, episode);
      } catch (err) { /* an unknown season leaves the show-level match */ }
    }
    return out;
  });
}

// The box's ratings are the US TV ones. A film's certification maps to the
// TV rating a network would have aired it under; anything else stays unset.
const TV_RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
const FILM_TO_TV = { G: 'TV-G', PG: 'TV-PG', 'PG-13': 'TV-14', R: 'TV-MA', 'NC-17': 'TV-MA' };

/**
 * Picks the US TV rating from a TMDB details response.
 * A show uses its US content rating; a film's US certification is mapped to a TV rating.
 * @param {string} mediaType 'tv' or 'movie'.
 * @param {object} data The TMDB details response with ratings appended.
 * @returns {?string} A TV rating such as 'TV-PG', or null when there is none.
 */
function usRating(mediaType, data) {
  if (mediaType === 'tv') {
    const us = ((data.content_ratings && data.content_ratings.results) || []).find((r) => r.iso_3166_1 === 'US');
    const value = us && String(us.rating || '').toUpperCase().replace(/^TV(?!-)/, 'TV-').replace(/-(FV|D|L|S|V)+$/, '');
    return TV_RATINGS.includes(value) ? value : null;
  }
  const us = ((data.release_dates && data.release_dates.results) || []).find((r) => r.iso_3166_1 === 'US');
  // Theatrical (3) first, then any other release that carries a certification.
  const dates = ((us && us.release_dates) || []).slice().sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1));
  const cert = dates.map((d) => String(d.certification || '').trim().toUpperCase()).find(Boolean);
  return (cert && FILM_TO_TV[cert]) || null;
}

/**
 * Picks one episode out of a TMDB season response.
 * @param {?object} seasonData The TMDB season response.
 * @param {number} season The season number.
 * @param {number} number The episode number within the season.
 * @returns {?object} The episode's season, number, name, overview and air date, or null if not found.
 */
function episodeFrom(seasonData, season, number) {
  const ep = ((seasonData && seasonData.episodes) || []).find((e) => e.episode_number === number);
  if (!ep) return null;
  return {
    season,
    number,
    name: ep.name || null,
    overview: ep.overview || null,
    airDate: ep.air_date || null,
  };
}

module.exports = { activate, __test: { splitYear, rankByYear, usRating, episodeFrom } };
