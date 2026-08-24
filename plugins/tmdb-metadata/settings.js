window.RCBPlugins.registerPluginSettings('tmdb-metadata', {
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
  }],
});

