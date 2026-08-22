// Settings panel for the ffmpeg-transcode plugin — this build resolves
// ffmpeg from PATH by default rather than bundling it (see main.js's
// activate()), so a way to point at a specific binary is useful. Registered
// via window.RCBPlugins.registerSettingsPanel rather than hardcoded into
// core index.html, so core stays identical to any build that resolves
// ffmpeg differently (e.g. one that bundles it and never needed this panel
// at all).
const { S } = window.RCBPlugins.ctx;
if (!S.config.ffmpeg) S.config.ffmpeg = { ffmpegPath: null };

window.RCBPlugins.registerSettingsPanel('ffmpeg-transcode', {
  render(container, ctx) {
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
});
