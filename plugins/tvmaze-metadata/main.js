// TVmaze lookups for the TITLES tab's TVMAZE button. No account or key: the
// public API is free for non-commercial use, rate-limited to about 20 calls
// per 10 seconds per address, and its data is CC BY-SA (credited in this
// plugin's settings and description). Only ever called on an explicit
// button press, never in the background. Searches are cached briefly; a
// show's whole episode list is one call, cached for a week, so matching a
// box set costs one search and one list.
const API = 'https://api.tvmaze.com';
const DAY_MS = 24 * 60 * 60 * 1000;

// The fields a match can use, from TVmaze's show object. `summary` stays
// HTML here; the renderer turns it into text (ctx.titleMatch.plainSummary).
function showFrom(show) {
  const network = show.network || show.webChannel || null;
  const schedule = show.schedule && (show.schedule.time || (show.schedule.days || []).length)
    ? { days: show.schedule.days || [], time: show.schedule.time || '' }
    : null;
  return {
    id: show.id,
    name: show.name,
    mediaType: 'tv',
    year: (show.premiered || '').slice(0, 4),
    premiered: show.premiered || null,
    network: network ? network.name : null,
    country: network && network.country ? network.country.code : null,
    schedule,
    summary: show.summary || '',
    imageUrl: show.image ? show.image.medium || show.image.original || null : null,
    url: show.url || null,
  };
}

function episodeFrom(ep) {
  return {
    id: ep.id,
    season: ep.season,
    number: ep.number,
    name: ep.name || null,
    airdate: ep.airdate || null,
    airtime: ep.airtime || null,
    summary: ep.summary || '',
  };
}

function activate(ctx) {
  const { ipcMain, fetchJsonCached } = ctx;
  const get = (key, url, ttl) => fetchJsonCached(key, url, { headers: { Accept: 'application/json' } }, ttl);

  //   opts: { query } -> { results: [show…] } in TVmaze's own order
  ipcMain.handle('tvmaze:search', async (event, opts) => {
    const query = opts && typeof opts.query === 'string' ? opts.query.trim() : '';
    if (!query) return { results: [] };
    try {
      const data = await get(`tvmaze:search:${query.toLowerCase()}`, `${API}/search/shows?q=${encodeURIComponent(query)}`, 15 * 60 * 1000);
      return { results: (Array.isArray(data) ? data : []).filter((r) => r && r.show).slice(0, 8).map((r) => showFrom(r.show)) };
    } catch (err) {
      return { results: [], error: err.message };
    }
  });

  //   opts: { showId } -> { episodes: [episode…] }, specials included
  ipcMain.handle('tvmaze:episodes', async (event, opts) => {
    const showId = opts && Number(opts.showId);
    if (!Number.isInteger(showId) || showId <= 0) return { episodes: [] };
    try {
      const data = await get(`tvmaze:episodes:${showId}`, `${API}/shows/${showId}/episodes?specials=1`, 7 * DAY_MS);
      return { episodes: (Array.isArray(data) ? data : []).map(episodeFrom) };
    } catch (err) {
      return { episodes: [], error: err.message };
    }
  });
}

module.exports = { activate, __test: { showFrom, episodeFrom } };
