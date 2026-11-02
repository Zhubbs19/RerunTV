// This plugin's own config namespace, seeded here (not by core) — see
// PLUGIN_DEVELOPMENT.md. window.RCBPlugins.ctx is set before any
// plugin renderer.js is imported (plugins.js's loadPlugins()), so this is
// safe to read at module top level, before this plugin's own render() has
// ever been called.
const { S: tmdbS, ipc } = window.RCBPlugins.ctx;
if (!tmdbS.config.tmdb) tmdbS.config.tmdb = { apiKey: null };

// Lookups reach this plugin's own main.js over the generic plugin bridge, which
// answers with the manifest's fallbackIpc while the plugin is off. A LAN viewer
// has no bridge, so it gets the same "host only" answer the old preload gave.
const PLUGIN_ID = 'tmdb-metadata';
const HOST_ONLY = 'TMDB lookups only run on the host device.';
const NO_KEY = 'Add an API key first: PLUGINS › TMDB Metadata › SETTINGS.';
async function tmdbSearch(opts) {
  if (!ipc.available()) return { results: [], error: HOST_ONLY };
  try { return await ipc.invoke(PLUGIN_ID, 'tmdb:search', opts); } catch (e) { return { results: [], error: e.message }; }
}
// Cast, the US rating and, given a season and episode, that episode (main.js).
async function tmdbGetDetails(opts) {
  if (!ipc.available()) return { cast: [] };
  try { return await ipc.invoke(PLUGIN_ID, 'tmdb:getCredits', opts); } catch (e) { return { cast: [] }; }
}

// MATCHING (settings.js). Both default on; read fresh at each match.
function matchPrefs() {
  const settings = window.RCBPlugins.ctx.settings;
  const saved = (settings && typeof settings.getPluginSettings === 'function' && settings.getPluginSettings(PLUGIN_ID)) || {};
  return { episodeDetails: saved.episodeDetails !== false, fillRatings: saved.fillRatings !== false };
}

// The actual per-title match button/flow — via registerTitleRowAction
// (plugins.js), so core's TITLES-tab row renderer (setup-panels.js) never
// needs to know this plugin exists. Used to be built directly into core;
// moved here so core stays plugin-agnostic (the one thing every plugin has
// in common is that core doesn't know which ones are installed).
//
// How a file is read (its season and episode, what to search for, film or
// show) is core's ctx.titleMatch (v11), shared with every metadata plugin.
const { episodeOf, searchQueryFor, preferredKind } = window.RCBPlugins.ctx.titleMatch;
const hasText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The fields one match writes on a file. The episode's own title,
 * description and air date when TMDB has that episode; otherwise the
 * title's overview. A title and a rating are only filled where the file has
 * none; the description only when `overwriteDescription` (or it is empty).
 */
export function fieldsFromMatch(file, match, details, prefs, { overwriteDescription = false } = {}) {
  const tmdb = { id: match.id, mediaType: match.mediaType, posterUrl: match.posterUrl };
  if (details && Array.isArray(details.cast) && details.cast.length) tmdb.cast = details.cast;
  const episode = prefs.episodeDetails && details && details.episode;
  if (episode) tmdb.episode = { season: episode.season, number: episode.number, name: episode.name, airDate: episode.airDate };
  const fields = { tmdb };
  const description = (episode && episode.overview) || match.overview;
  if (description && (overwriteDescription || !hasText(file.description))) fields.description = description;
  if (episode && episode.name && !hasText(file.title)) fields.title = episode.name;
  if (prefs.fillRatings && details && details.rating && !hasText(file.rating)) fields.rating = details.rating;
  return fields;
}

// A file a bulk match should look up: no description yet, or a show-level
// match from before episode details existed, which an episode can improve on.
export function needsMatch(file, prefs) {
  if (!hasText(file.description)) return true;
  return !!(prefs.episodeDetails && file.tmdb && file.tmdb.mediaType === 'tv' && !file.tmdb.episode && episodeOf(file));
}

function detailsOpts(apiKey, match, file, prefs) {
  const opts = { apiKey, id: match.id, mediaType: match.mediaType };
  const episode = prefs.episodeDetails && match.mediaType === 'tv' ? episodeOf(file) : null;
  if (episode) Object.assign(opts, episode);
  return opts;
}

// A match describes the media, not one playlist entry. ctx.shareFileFields
// (core's TITLES row ctx) writes it on every channel and schedule block that
// plays the same file, and on its library item; an older app without it
// keeps the match on this entry only.
function saveMatch(ctx, file, fields, opts) {
  if (typeof ctx.shareFileFields === 'function') {
    ctx.shareFileFields(file, fields, opts);
    return;
  }
  Object.assign(file, fields);
  if (!opts || opts.commit !== false) ctx.saveConfigDebounced();
}

window.RCBPlugins.registerTitleRowAction('tmdb-metadata', {
  renderBulkAction(container, ctx) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'MATCH FOR SELECTED';
    container.appendChild(btn);
    btn.addEventListener('click', async () => {
      const files = Array.from(ctx.getSelectedFiles());
      if (!files.length) return;
      const apiKey = ctx.S.config.tmdb.apiKey;
      if (!apiKey) {
        window.alertDialog(NO_KEY);
        return;
      }
      if (!(await window.confirmDialog(`Look up matches for ${files.length} selected file(s)? The top result for each is applied automatically (no per-file confirmation). Files that already have a description are skipped, unless an episode can replace its show's description.`, { danger: false, confirmText: 'MATCH' }))) return;

      const prefs = matchPrefs();
      btn.disabled = true;
      let matched = 0;
      let episodes = 0;
      let skipped = 0;
      let noResult = 0;
      // One search per show or title, not per file: a season of episodes is
      // one search. Paced (250ms between searches) to stay well under the
      // API's rate limit; episode lookups are one cached call per season.
      const searches = new Map();
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        btn.textContent = `MATCHING… (${i + 1}/${files.length})`;
        if (!needsMatch(file, prefs)) { skipped += 1; continue; } // eslint-disable-line no-continue
        const query = searchQueryFor(file);
        try {
          const key = `${preferredKind(file) || ''}:${query.toLowerCase()}`;
          if (!searches.has(key)) {
            if (searches.size) await new Promise((r) => { setTimeout(r, 250); }); // eslint-disable-line no-await-in-loop
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see pacing note above
            const { results, error } = await tmdbSearch({ apiKey, query, prefer: preferredKind(file) });
            searches.set(key, error ? [] : results || []);
          }
          const top = searches.get(key)[0];
          if (!top) { noResult += 1; continue; } // eslint-disable-line no-continue
          // eslint-disable-next-line no-await-in-loop
          const details = await tmdbGetDetails(detailsOpts(apiKey, top, file, prefs));
          const fields = fieldsFromMatch(file, top, details, prefs, { overwriteDescription: true });
          saveMatch(ctx, file, fields, { commit: false });
          matched += 1;
          if (fields.tmdb.episode) episodes += 1;
        } catch (e) { noResult += 1; }
      }
      btn.disabled = false;
      btn.textContent = 'MATCH FOR SELECTED';
      ctx.rerender();
      if (typeof ctx.commitSharedFileFields === 'function') ctx.commitSharedFileFields('TMDB match for selected');
      else ctx.saveConfigDebounced();
      const episodeNote = episodes ? ` (${episodes} with their own episode details)` : '';
      window.alertDialog(`Bulk match done — ${matched} matched${episodeNote}, ${skipped} skipped (already had a description), ${noResult} had no result.`);
    });
  },

  renderRowCell(container, file, ctx) {
    container.classList.add('title-row-plugin-cell');

    const poster = document.createElement('img');
    poster.className = 'title-row-plugin-poster' + (file.tmdb && file.tmdb.posterUrl ? '' : ' hidden');
    if (file.tmdb && file.tmdb.posterUrl) poster.src = file.tmdb.posterUrl;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = file.tmdb ? 'RE-MATCH' : 'MATCH';

    const results = document.createElement('div');
    results.className = 'title-row-plugin-search-results hidden';

    async function applyMatch(match) {
      const overwrite = !hasText(file.description) ||
        (await window.confirmDialog({ message: 'Overwrite this file\'s existing description?', danger: false, confirmText: 'OVERWRITE' }));
      if (match.posterUrl) {
        poster.src = match.posterUrl;
        poster.classList.remove('hidden');
      }
      btn.textContent = 'RE-MATCH';
      results.classList.add('hidden');
      // Cast, rating and the episode arrive with the match, so the whole
      // match is one undo step.
      const prefs = matchPrefs();
      const details = await tmdbGetDetails(detailsOpts(ctx.S.config.tmdb.apiKey, match, file, prefs));
      const fields = fieldsFromMatch(file, match, details, prefs, { overwriteDescription: overwrite });
      if (!overwrite) delete fields.description;
      if (fields.description && ctx.descInput) {
        ctx.descInput.value = fields.description;
        ctx.descInput.classList.remove('hidden');
        if (ctx.descToggleBtn) ctx.descToggleBtn.textContent = 'DESCRIPTION ▾';
      }
      saveMatch(ctx, file, fields, { label: 'TMDB match' });
      if (fields.title || fields.rating) ctx.rerender();
    }

    btn.addEventListener('click', async () => {
      if (!ctx.S.config.tmdb.apiKey) {
        window.alertDialog(NO_KEY);
        return;
      }
      btn.disabled = true;
      btn.textContent = 'SEARCHING…';
      const query = searchQueryFor(file);
      const { results: matches, error } = await tmdbSearch({ apiKey: ctx.S.config.tmdb.apiKey, query, prefer: preferredKind(file) });
      btn.disabled = false;
      btn.textContent = file.tmdb ? 'RE-MATCH' : 'MATCH';
      if (error) { window.alertDialog(error, { variant: 'error' }); return; }
      if (!matches.length) { window.alertDialog(`No results for "${query}".`); return; }

      results.innerHTML = '';
      matches.forEach((match) => {
        const item = document.createElement('div');
        item.className = 'title-row-plugin-search-result';
        if (match.posterUrl) {
          const thumb = document.createElement('img');
          thumb.src = match.posterUrl;
          item.appendChild(thumb);
        }
        const label = document.createElement('span');
        label.textContent = `${match.title}${match.year ? ` (${match.year})` : ''} — ${match.mediaType.toUpperCase()}`;
        item.appendChild(label);
        item.addEventListener('click', () => applyMatch(match));
        results.appendChild(item);
      });
      results.classList.remove('hidden');
    });

    container.appendChild(poster);
    container.appendChild(btn);
    container.appendChild(results);
  },
});
