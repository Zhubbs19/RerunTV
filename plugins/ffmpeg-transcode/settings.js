window.RCBPlugins.registerPluginSettings('ffmpeg-transcode', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.ffmpeg) ctx.S.config.ffmpeg = { ffmpegPath: null };
    const cfg = ctx.S.config.ffmpeg;
    container.innerHTML = `
      <label class="panel-toggle">FFMPEG</label>
      <div class="panel-body">
        <div class="panel-interval">
          FFMPEG PATH
          <input type="text" id="ffmpeg-plugin-path-input" class="title-row-input" placeholder="ffmpeg (SYSTEM PATH)" readonly>
          <button type="button" id="ffmpeg-plugin-path-browse" class="btn">BROWSE…</button>
          <button type="button" id="ffmpeg-plugin-path-reset" class="btn">USE SYSTEM PATH</button>
        </div>
        <span class="panel-status">Used to fix videos with incompatible codecs and to grab caption-contest thumbnails. This build doesn't bundle ffmpeg — install it yourself and it'll be found on your system PATH automatically, or point at a specific binary here. Takes effect on next restart.</span>
      </div>
    `;

    const pathEl = container.querySelector('#ffmpeg-plugin-path-input');
    const browseBtn = container.querySelector('#ffmpeg-plugin-path-browse');
    const resetBtn = container.querySelector('#ffmpeg-plugin-path-reset');

    pathEl.value = cfg.ffmpegPath || '';

    browseBtn.addEventListener('click', async () => {
      const path = await ctx.selectExecutable();
      if (!path) return;
      cfg.ffmpegPath = path;
      pathEl.value = path;
      ctx.saveConfigDebounced();
    });
    resetBtn.addEventListener('click', () => {
      cfg.ffmpegPath = null;
      pathEl.value = '';
      ctx.saveConfigDebounced();
    });
    },
  }],
});

