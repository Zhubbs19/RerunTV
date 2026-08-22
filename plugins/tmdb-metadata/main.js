// TMDB metadata lookup (TITLES tab "MATCH TMDB") — migrated out of core main.js.
// Only ever called on explicit user action from the TITLES tab (no
// background polling), and results are cached on disk (ctx.fetchJsonCached)
// since the same title is often re-searched while editing a channel. Search
// results are cached briefer than a specific movie/show's details, since a
// title search is more likely to be refined/retried.
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

function activate(ctx) {
  const { ipcMain, fetchJsonCached } = ctx;

  ipcMain.handle('tmdb:search', async (event, opts) => {
    const apiKey = opts && opts.apiKey;
    const query = opts && opts.query && opts.query.trim();
    if (!apiKey) return { results: [], error: 'No TMDB API key set (DISPLAY & SYSTEM → TMDB METADATA).' };
    if (!query) return { results: [] };
    try {
      const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&include_adult=false`;
      const data = await fetchJsonCached(
        `tmdb:search:${query.toLowerCase()}`,
        url,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
        15 * 60 * 1000,
      );
      const results = (data.results || [])
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .slice(0, 6)
        .map((r) => ({
          id: r.id,
          mediaType: r.media_type,
          title: r.title || r.name,
          year: (r.release_date || r.first_air_date || '').slice(0, 4),
          overview: r.overview || '',
          posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
        }));
      return { results };
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

// Called by core (registerFallbackHandlers, main-plugins.js) instead of
// activate() when this plugin is disabled/missing — registers safe stubs
// for the channels the renderer side calls unconditionally, so those calls
// resolve with an empty/explanatory result instead of rejecting with a raw
// "no handler registered" error.
function registerFallback(ipcMain) {
  ipcMain.handle('tmdb:search', async () => ({ results: [], error: 'The TMDB Metadata plugin is disabled or missing (PLUGINS tab).' }));
  ipcMain.handle('tmdb:getCredits', async () => ({ cast: [] }));
}

module.exports = { activate, registerFallback };
