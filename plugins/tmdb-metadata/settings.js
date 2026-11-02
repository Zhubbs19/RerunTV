window.RCBPlugins.registerPluginSettings('tmdb-metadata', {
  // The API key stays in its older top-level home (config.tmdb.apiKey); the
  // matching switches below are this plugin's own settings.
  schemaVersion: 1,
  defaults: { episodeDetails: true, fillRatings: true },
  sections: [{
    id: 'general',
  render(container, ctx) {
    const cfg = ctx.S.config.tmdb;
    container.innerHTML = `
      <label class="panel-toggle">TMDB METADATA</label>
      <div class="panel-body">
        <div class="panel-interval">
          API KEY (READ ACCESS TOKEN)
          <input type="password" id="tmdb-plugin-api-key" class="title-row-input" placeholder="paste your TMDB API read access token">
        </div>
        <span class="panel-status">Free at themoviedb.org/settings/api. Used by the MATCH button on each channel's TITLES tab to fill in synopsis/poster/cast from a real title search — nothing is fetched automatically.</span>
      </div>
    `;
    const keyEl = container.querySelector('#tmdb-plugin-api-key');
    keyEl.value = cfg.apiKey || '';
    keyEl.addEventListener('change', () => {
      cfg.apiKey = keyEl.value.trim() || null;
      ctx.saveConfigDebounced();
    });
    },
  }, {
    id: 'matching',
    label: 'MATCHING',
    fields: [
      {
        key: 'episodeDetails',
        type: 'toggle',
        label: 'Use episode details',
        synonyms: 'season episode title synopsis air date',
        help: 'When a file has a season and episode (S02E01 in its name, or from its details), a TV match fills in that episode’s title, description and air date instead of the show’s.',
      },
      {
        key: 'fillRatings',
        type: 'toggle',
        label: 'Fill in ratings',
        synonyms: 'tv rating certification parental',
        help: 'A match sets the file’s TV rating from TMDB’s US rating when it has none. Film ratings become the TV rating they air under.',
      },
    ],
  }],
});
