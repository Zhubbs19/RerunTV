// TVmaze Episodes: a TVMAZE button on every TITLES row (and TVMAZE FOR
// SELECTED in the bulk bar) that fills in a TV episode's title, synopsis and
// series name, and records its original air date, air time and network.
// No key needed. How a file is read (season and episode, what to search
// for, the year in its name) is core's ctx.titleMatch, shared with TMDB.
const { ipc, titleMatch } = window.RCBPlugins.ctx;
const { episodeOf, searchQueryFor, splitYear, rankByYear, plainSummary } = titleMatch;

const PLUGIN_ID = 'tvmaze-metadata';
const HOST_ONLY = 'TVmaze lookups only run on the host device.';
/**
 * Tells whether a value is a non-blank string.
 * @param {*} value The value to test.
 * @returns {boolean} True for a string with non-space text.
 */
const hasText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The year comes out of the query (TVmaze finds nothing with it left in) and
 * ranks the shows instead: the 1990 revival over the 1960 original.
 * @param {string} query The search text, usually from the file name.
 * @returns {Promise<object>} `{ results, error? }` with shows ranked by year; never rejects.
 */
async function searchShows(query) {
  if (!ipc.available()) return { results: [], error: HOST_ONLY };
  const { title, year } = splitYear(query);
  try {
    let response = await ipc.invoke(PLUGIN_ID, 'tvmaze:search', { query: title });
    if (!(response.results || []).length && title !== query) response = await ipc.invoke(PLUGIN_ID, 'tvmaze:search', { query });
    return { results: rankByYear(response.results || [], year), error: response.error };
  } catch (e) {
    return { results: [], error: e.message };
  }
}

// One episode list per show for this session, on top of main.js's cache.
const episodeLists = new Map();
/**
 * Fetches a show's episode list once per session.
 * @param {number} showId The TVmaze show id.
 * @returns {Promise<Array<object>>} The show's episodes, or an empty list on failure.
 */
async function episodesOf(showId) {
  if (!episodeLists.has(showId)) {
    episodeLists.set(showId, ipc.invoke(PLUGIN_ID, 'tvmaze:episodes', { showId })
      .then((r) => r.episodes || [])
      .catch(() => []));
  }
  return episodeLists.get(showId);
}

/**
 * MATCHING (settings.js). Both default on; read fresh at each match.
 * @returns {{episodeTitles: boolean, seriesNames: boolean}} The matching preferences.
 */
function matchPrefs() {
  const settings = window.RCBPlugins.ctx.settings;
  const saved = (settings && typeof settings.getPluginSettings === 'function' && settings.getPluginSettings(PLUGIN_ID)) || {};
  return { episodeTitles: saved.episodeTitles !== false, seriesNames: saved.seriesNames !== false };
}

/**
 * The fields one match writes on a file: the episode's synopsis (or the
 * show's), an empty title from the episode, an empty series from the show,
 * and `tvmaze` — where and when it first aired.
 * @param {object} file The channel file entry being matched.
 * @param {object} show The chosen show, as built by main.js's `showFrom`.
 * @param {?object} episode The matching episode, or null for a show-level match.
 * @param {object} prefs The matching preferences from `matchPrefs()`.
 * @param {object} [options] Write options.
 * @param {boolean} [options.overwriteDescription=false] Replace an existing description.
 * @returns {object} The fields to write on the file.
 */
export function fieldsFromShow(file, show, episode, prefs, { overwriteDescription = false } = {}) {
  const tvmaze = { showId: show.id, show: show.name, network: show.network || null, country: show.country || null };
  if (show.schedule) tvmaze.schedule = show.schedule;
  if (show.imageUrl) tvmaze.imageUrl = show.imageUrl;
  if (episode) {
    Object.assign(tvmaze, { episodeId: episode.id, season: episode.season, number: episode.number, airdate: episode.airdate, airtime: episode.airtime });
  } else if (show.premiered) {
    tvmaze.airdate = show.premiered;
  }
  const fields = { tvmaze };
  const description = plainSummary(episode && episode.summary) || plainSummary(show.summary);
  if (description && (overwriteDescription || !hasText(file.description))) fields.description = description;
  if (episode && prefs.episodeTitles && hasText(episode.name) && !hasText(file.title)) fields.title = episode.name;
  if (prefs.seriesNames && !(file.series && hasText(file.series.name))) {
    fields.series = { name: show.name, season: episode ? episode.season : null, episode: episode ? episode.number : null };
  }
  return fields;
}

/**
 * Finds the episode a file's season and episode code points at.
 * @param {Array<object>} episodes The show's episode list.
 * @param {object} file The channel file entry.
 * @returns {?object} The matching episode, or null.
 */
export function findEpisode(episodes, file) {
  const code = episodeOf(file);
  if (!code) return null;
  return episodes.find((e) => e.season === code.season && e.number === code.episode) || null;
}

/**
 * A file a bulk match should look up: an episode with no description yet, or
 * only its show's description from an earlier show-level match.
 * @param {object} file The channel file entry.
 * @returns {boolean} True when the file should be looked up.
 */
export function needsMatch(file) {
  if (!episodeOf(file)) return false;
  if (!hasText(file.description)) return true;
  return !!(file.tmdb && file.tmdb.mediaType === 'tv' && !file.tmdb.episode && !(file.tvmaze && file.tvmaze.episodeId));
}

/**
 * A match describes the media, not one playlist entry: written on every copy
 * through core's ctx.shareFileFields (TITLES row ctx).
 * @param {object} ctx The TITLES row ctx.
 * @param {object} file The channel file entry.
 * @param {object} fields The fields to write.
 * @param {object} [opts] Write options; `commit: false` skips the save.
 */
function saveMatch(ctx, file, fields, opts) {
  if (typeof ctx.shareFileFields === 'function') {
    ctx.shareFileFields(file, fields, opts);
    return;
  }
  Object.assign(file, fields);
  if (!opts || opts.commit !== false) ctx.saveConfigDebounced();
}

window.RCBPlugins.registerTitleRowAction(PLUGIN_ID, {
  renderBulkAction(container, ctx) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'TVMAZE FOR SELECTED';
    container.appendChild(btn);
    btn.addEventListener('click', async () => {
      const files = Array.from(ctx.getSelectedFiles());
      if (!files.length) return;
      const episodesSelected = files.filter((f) => episodeOf(f));
      if (!episodesSelected.length) {
        window.alertDialog('None of the selected files has a season and episode (like S02E01 in its name). TVmaze only covers TV episodes; use TVMAZE on a single row to look up a special by name.');
        return;
      }
      if (!(await window.confirmDialog(`Look up ${episodesSelected.length} episode(s) on TVmaze? Each show's top result is used automatically. Episodes that already have a description of their own are skipped.`, { danger: false, confirmText: 'LOOK UP' }))) return;

      const prefs = matchPrefs();
      btn.disabled = true;
      let matched = 0;
      let skipped = files.length - episodesSelected.length;
      let noResult = 0;
      // One search per show, paced 400 ms apart: TVmaze allows about 20
      // calls per 10 seconds, and each new show also costs an episode list.
      const shows = new Map();
      for (let i = 0; i < episodesSelected.length; i += 1) {
        const file = episodesSelected[i];
        btn.textContent = `LOOKING UP… (${i + 1}/${episodesSelected.length})`;
        if (!needsMatch(file)) { skipped += 1; continue; } // eslint-disable-line no-continue
        const query = searchQueryFor(file);
        const key = query.toLowerCase();
        if (!shows.has(key)) {
          if (shows.size) await new Promise((r) => { setTimeout(r, 400); }); // eslint-disable-line no-await-in-loop
          // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see pacing note above
          const { results } = await searchShows(query);
          shows.set(key, results[0] || null);
        }
        const show = shows.get(key);
        if (!show) { noResult += 1; continue; } // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const episode = findEpisode(await episodesOf(show.id), file);
        if (!episode) { noResult += 1; continue; } // eslint-disable-line no-continue
        saveMatch(ctx, file, fieldsFromShow(file, show, episode, prefs, { overwriteDescription: true }), { commit: false });
        matched += 1;
      }
      btn.disabled = false;
      btn.textContent = 'TVMAZE FOR SELECTED';
      ctx.rerender();
      if (typeof ctx.commitSharedFileFields === 'function') ctx.commitSharedFileFields('TVmaze lookup for selected');
      else ctx.saveConfigDebounced();
      window.alertDialog(`TVmaze lookup done — ${matched} matched, ${skipped} skipped, ${noResult} not found.`);
    });
  },

  renderRowCell(container, file, ctx) {
    container.classList.add('title-row-plugin-cell');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    const label = () => (file.tvmaze ? 'TVMAZE ✓' : 'TVMAZE');
    btn.textContent = label();
    btn.title = 'Fill in this episode’s title and synopsis, and record when and where it first aired, from TVmaze.';
    const results = document.createElement('div');
    results.className = 'title-row-plugin-search-results hidden';

    async function apply(show) {
      results.classList.add('hidden');
      const episode = findEpisode(await episodesOf(show.id), file);
      if (episodeOf(file) && !episode) {
        window.alertDialog(`${show.name} on TVmaze has no season ${episodeOf(file).season}, episode ${episodeOf(file).episode}. The show’s own details were used instead.`);
      }
      const overwrite = !hasText(file.description) ||
        (await window.confirmDialog({ message: 'Replace this file\'s existing description?', danger: false, confirmText: 'REPLACE' }));
      const fields = fieldsFromShow(file, show, episode, matchPrefs(), { overwriteDescription: overwrite });
      if (!overwrite) delete fields.description;
      if (fields.description && ctx.descInput) {
        ctx.descInput.value = fields.description;
        ctx.descInput.classList.remove('hidden');
        if (ctx.descToggleBtn) ctx.descToggleBtn.textContent = 'DESCRIPTION ▾';
      }
      saveMatch(ctx, file, fields, { label: 'TVmaze lookup' });
      btn.textContent = label();
      if (fields.title || fields.series) ctx.rerender();
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'SEARCHING…';
      const query = searchQueryFor(file);
      const { results: shows, error } = await searchShows(query);
      btn.disabled = false;
      btn.textContent = label();
      if (error && !shows.length) { window.alertDialog(error, { variant: 'error' }); return; }
      if (!shows.length) { window.alertDialog(`TVmaze has no show called "${query}".`); return; }
      results.innerHTML = '';
      shows.slice(0, 6).forEach((show) => {
        const item = document.createElement('div');
        item.className = 'title-row-plugin-search-result';
        const text = document.createElement('span');
        text.textContent = `${show.name}${show.year ? ` (${show.year})` : ''}${show.network ? ` — ${show.network}` : ''}`;
        item.appendChild(text);
        item.addEventListener('click', () => apply(show));
        results.appendChild(item);
      });
      results.classList.remove('hidden');
    });

    container.appendChild(btn);
    container.appendChild(results);
  },
});
