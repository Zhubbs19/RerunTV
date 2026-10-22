// NOAA/NWS active weather alerts + forecast (real EAS trigger) — migrated
// out of core main.js. api.weather.gov is free, keyless, but does require an
// identifying User-Agent per their usage policy. Polled from the renderer
// (eas.js) on its own timer — this handler just does the fetch+cache;
// nothing here decides whether/when to interrupt playback.
const HEADERS = { 'User-Agent': 'RerunTV (https://github.com/Zhubbs19/RerunTV)', Accept: 'application/geo+json' };

function activate(ctx) {
  const { ipcMain, fetchJsonCached } = ctx;

  ipcMain.handle('noaa:getActiveAlerts', async (event, opts) => {
    const lat = opts && opts.lat;
    const lon = opts && opts.lon;
    if (lat == null || lon == null) return { alerts: [], error: 'No latitude/longitude set (DISPLAY & SYSTEM → EAS).' };
    try {
      const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
      const data = await fetchJsonCached(`noaa:alerts:${lat},${lon}`, url, { headers: HEADERS }, 4 * 60 * 1000);
      const alerts = (data.features || []).map((f) => ({
        id: f.id,
        event: f.properties.event,
        headline: f.properties.headline,
        description: f.properties.description,
        severity: f.properties.severity,
        effective: f.properties.effective,
        expires: f.properties.expires,
      }));
      return { alerts };
    } catch (err) {
      return { alerts: [], error: err.message };
    }
  });

  // api.weather.gov's forecast is a two-step lookup: /points/{lat},{lon}
  // first resolves to a forecast URL tied to that location's NWS
  // office/grid cell (this basically never changes for a fixed lat/lon,
  // hence the long TTL), then that URL is fetched for the actual day/night
  // forecast periods (which do change through the day, hence the much
  // shorter TTL on that one).
  // relativeLocation (a nearby named place NWS resolves the lat/lon to,
  // e.g. "Kansas City, MO") comes from the same /points lookup the
  // forecast URL does — bundled into this same handler rather than a
  // separate IPC round-trip since the weather channel needs both together
  // anyway, and /points is already cached for a week (it's tied to the
  // NWS grid cell, not the moment-to-moment forecast).
  ipcMain.handle('noaa:getForecast', async (event, opts) => {
    const lat = opts && opts.lat;
    const lon = opts && opts.lon;
    if (lat == null || lon == null) return { periods: [], location: null, error: 'No latitude/longitude set (DISPLAY & SYSTEM → EAS).' };
    try {
      const points = await fetchJsonCached(`noaa:points:${lat},${lon}`, `https://api.weather.gov/points/${lat},${lon}`, { headers: HEADERS }, 7 * 24 * 60 * 60 * 1000);
      const forecastUrl = points.properties && points.properties.forecast;
      if (!forecastUrl) throw new Error('No forecast available for this location');
      const rel = points.properties && points.properties.relativeLocation && points.properties.relativeLocation.properties;
      const location = rel && rel.city ? { city: rel.city, state: rel.state } : null;
      const data = await fetchJsonCached(`noaa:forecast:${lat},${lon}`, forecastUrl, { headers: HEADERS }, 30 * 60 * 1000);
      return { periods: (data.properties && data.properties.periods) || [], location };
    } catch (err) {
      return { periods: [], location: null, error: err.message };
    }
  });
}

module.exports = { activate };
