// This plugin's own config namespace, seeded here (not by core) — see
// [[retro_cable_box_plugin_system]]. window.RCBPlugins.ctx is set before any
// plugin renderer.js is imported (plugins.js's loadPlugins()), so this is
// safe to read at module top level, before this plugin's own render() has
// ever been called.
const { S: tmdbS } = window.RCBPlugins.ctx;
if (!tmdbS.config.tmdb) tmdbS.config.tmdb = { apiKey: null };

// Settings panel — just an API key field.

// The actual per-title match button/flow — via registerTitleRowAction
// (plugins.js), so core's TITLES-tab row renderer (setup-panels.js) never
// needs to know this plugin exists. Used to be built directly into core;
// moved here so core stays plugin-agnostic (the one thing every plugin has
// in common is that core doesn't know which ones are installed).
function guessCleanTitleFallback(name) {
  // Same rough heuristic core's own guessCleanTitle used to hand this code
  // via a shared util import — this plugin can't import that module
  // directly (different app:// origin), so it re-derives just enough of it:
  // strip a trailing bracket/paren group and file extension.
  return name.replace(/\.[^./\\]+$/, '').replace(/[[(][^\])]*[\])]\s*$/, '').trim();
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
      if (!ctx.S.config.tmdb.apiKey) {
        window.alertDialog('Add an API key first — expand this plugin\'s SETTINGS in the PLUGINS tab.');
        return;
      }
      if (!(await window.confirmDialog(`Look up matches for ${files.length} selected file(s)? The top result for each is applied automatically (no per-file confirmation), skipping any file that already has a description.`, { danger: false, confirmText: 'MATCH' }))) return;

      btn.disabled = true;
      let matched = 0;
      let skipped = 0;
      let noResult = 0;
      // Paced (250ms between requests) to stay well under the API's rate
      // limit and not fire a burst of dozens of simultaneous requests.
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        btn.textContent = `MATCHING… (${i + 1}/${files.length})`;
        if (file.description && file.description.trim()) { skipped += 1; continue; } // eslint-disable-line no-continue
        const query = (file.title || guessCleanTitleFallback((file.path || '').split(/[\\/]/).pop())).trim();
        try {
          // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see pacing note above
          const { results } = await window.api.tmdbSearch({ apiKey: ctx.S.config.tmdb.apiKey, query });
          if (!results || !results.length) { noResult += 1; continue; } // eslint-disable-line no-continue
          const top = results[0];
          file.tmdb = { id: top.id, mediaType: top.mediaType, posterUrl: top.posterUrl };
          if (top.overview) file.description = top.overview;
          matched += 1;
          // eslint-disable-next-line no-await-in-loop
          const { cast } = await window.api.tmdbGetCredits({ apiKey: ctx.S.config.tmdb.apiKey, id: top.id, mediaType: top.mediaType });
          if (cast && cast.length) file.tmdb.cast = cast;
        } catch (e) { noResult += 1; }
        // eslint-disable-next-line no-await-in-loop
        if (i < files.length - 1) await new Promise((r) => { setTimeout(r, 250); });
      }
      btn.disabled = false;
      btn.textContent = 'MATCH FOR SELECTED';
      ctx.rerender();
      ctx.saveConfigDebounced();
      window.alertDialog(`Bulk match done — ${matched} matched, ${skipped} skipped (already had a description), ${noResult} had no result.`);
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
      const overwrite = !file.description || !file.description.trim() ||
        (await window.confirmDialog({ message: 'Overwrite this file\'s existing description?', danger: false, confirmText: 'OVERWRITE' }));
      file.tmdb = { id: match.id, mediaType: match.mediaType, posterUrl: match.posterUrl };
      if (match.posterUrl) {
        poster.src = match.posterUrl;
        poster.classList.remove('hidden');
      }
      if (overwrite && match.overview && ctx.descInput) {
        file.description = match.overview;
        ctx.descInput.value = match.overview;
        ctx.descInput.classList.remove('hidden');
        if (ctx.descToggleBtn) ctx.descToggleBtn.textContent = 'DESCRIPTION ▾';
      }
      btn.textContent = 'RE-MATCH';
      results.classList.add('hidden');
      ctx.saveConfigDebounced();
      window.api.tmdbGetCredits({ apiKey: ctx.S.config.tmdb.apiKey, id: match.id, mediaType: match.mediaType })
        .then(({ cast }) => {
          if (cast && cast.length) { file.tmdb.cast = cast; ctx.saveConfigDebounced(); }
        });
    }

    btn.addEventListener('click', async () => {
      if (!ctx.S.config.tmdb.apiKey) {
        window.alertDialog('Add an API key first — expand this plugin\'s SETTINGS in the PLUGINS tab.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'SEARCHING…';
      const query = (file.title || guessCleanTitleFallback((file.path || '').split(/[\\/]/).pop())).trim();
      const { results: matches, error } = await window.api.tmdbSearch({ apiKey: ctx.S.config.tmdb.apiKey, query });
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
