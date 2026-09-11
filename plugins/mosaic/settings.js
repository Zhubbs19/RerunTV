// Settings for CH 100. Kept out of renderer.js so the channel's render
// lifecycle and its settings panel don't have to share a file, same split
// every other first-party plugin uses.
window.RCBPlugins.registerPluginSettings('mosaic', {
  schemaVersion: 1,
  defaults: {
    tilesPerPage: 9,
    pageSeconds: 20,
    refreshSeconds: 15,
    showTitles: true,
  },
  validate(values) {
    const errors = [];
    if (!(values.tilesPerPage >= 4 && values.tilesPerPage <= 16)) errors.push('tilesPerPage must be 4-16');
    if (!(values.pageSeconds >= 5 && values.pageSeconds <= 120)) errors.push('pageSeconds must be 5-120');
    if (!(values.refreshSeconds >= 5 && values.refreshSeconds <= 300)) errors.push('refreshSeconds must be 5-300');
    return errors;
  },
  sections: [{
    id: 'general',
    render(container, ctx) {
      const cfg = ctx.settings.getPluginSettings('mosaic') || {};
      container.innerHTML = `
        <span class="panel-status">CH 100 shows what is airing on every other channel as a grid of still frames, paging through the lineup. Frames are paused, not played, so a full page costs a fraction of what a wall of live pictures would.</span>
        <div class="panel-interval">
          TILES PER PAGE <input type="number" min="4" max="16" data-el="tiles" style="width:70px">
        </div>
        <div class="panel-interval">
          SECONDS PER PAGE <input type="number" min="5" max="120" data-el="page" style="width:70px">
        </div>
        <div class="panel-interval">
          REFRESH FRAMES EVERY <input type="number" min="5" max="300" data-el="refresh" style="width:70px"> SEC
        </div>
        <label class="shuffle-toggle">
          <input type="checkbox" data-el="titles">SHOW PROGRAM TITLES UNDER EACH TILE
        </label>
        <span class="panel-status">A higher tile count and a faster refresh both cost more decoding. If the page stutters on a large lineup, lower the tile count first — it matters more than the refresh rate.</span>
      `;
      const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
      const tilesEl = q('tiles');
      const pageEl = q('page');
      const refreshEl = q('refresh');
      const titlesEl = q('titles');

      tilesEl.value = cfg.tilesPerPage != null ? cfg.tilesPerPage : 9;
      pageEl.value = cfg.pageSeconds != null ? cfg.pageSeconds : 20;
      refreshEl.value = cfg.refreshSeconds != null ? cfg.refreshSeconds : 15;
      titlesEl.checked = cfg.showTitles !== false;

      // Clamped on the way in rather than trusted: a number input accepts
      // anything typed, min/max only style it.
      const clamp = (value, min, max, fallback) => {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
      };

      tilesEl.addEventListener('change', () => {
        const value = clamp(tilesEl.value, 4, 16, 9);
        tilesEl.value = value;
        ctx.settings.updatePluginSettings('mosaic', { tilesPerPage: value });
      });
      pageEl.addEventListener('change', () => {
        const value = clamp(pageEl.value, 5, 120, 20);
        pageEl.value = value;
        ctx.settings.updatePluginSettings('mosaic', { pageSeconds: value });
      });
      refreshEl.addEventListener('change', () => {
        const value = clamp(refreshEl.value, 5, 300, 15);
        refreshEl.value = value;
        ctx.settings.updatePluginSettings('mosaic', { refreshSeconds: value });
      });
      titlesEl.addEventListener('change', () => {
        ctx.settings.updatePluginSettings('mosaic', { showTitles: titlesEl.checked });
      });
    },
  }],
});
