// Module-scoped rather than registered inside render(): render() re-runs
// every time this section is redrawn (e.g. switching PLUGINS sub-tabs and
// back), and ipcRenderer.on has no dedup — registering there would stack a
// new listener on every redraw. currentInstallStatus is repointed at
// whichever status <span> is live now; a stale one (redrawn away) is simply
// never targeted again.
let currentInstallStatus = null;
function formatMb(bytes) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
window.api.onFfmpegInstallProgress((data) => {
  if (!currentInstallStatus) return;
  if (data.phase === 'downloading') {
    currentInstallStatus.textContent = data.totalBytes
      ? `Downloading… ${formatMb(data.receivedBytes)} / ${formatMb(data.totalBytes)}`
      : `Downloading… ${formatMb(data.receivedBytes)}`;
  } else if (data.phase === 'extracting') {
    currentInstallStatus.textContent = 'Extracting…';
  }
});

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
        <div class="panel-interval">
          <button type="button" id="ffmpeg-plugin-install" class="btn">INSTALL FFMPEG…</button>
        </div>
        <span class="panel-status" id="ffmpeg-plugin-install-status"></span>
        <span class="panel-status">Used to fix videos with incompatible codecs and to grab caption-contest thumbnails. This build doesn't bundle ffmpeg — install it yourself and it'll be found on your system PATH automatically, or point at a specific binary here, or use INSTALL FFMPEG above to download a copy just for RerunTV (no admin rights needed on Windows/macOS). Takes effect on next restart.</span>
      </div>
    `;

    const pathEl = container.querySelector('#ffmpeg-plugin-path-input');
    const browseBtn = container.querySelector('#ffmpeg-plugin-path-browse');
    const resetBtn = container.querySelector('#ffmpeg-plugin-path-reset');
    const installBtn = container.querySelector('#ffmpeg-plugin-install');
    const installStatus = container.querySelector('#ffmpeg-plugin-install-status');
    currentInstallStatus = installStatus;

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

    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      installStatus.textContent = 'Checking your system…';
      try {
        const info = await window.api.ffmpegInstallCheck();
        if (info.method === 'command') {
          installStatus.textContent = `Automatic download isn't available on Linux. Run this in a terminal, then restart RerunTV: ${info.command}`;
          return;
        }
        if (info.method === 'unsupported') {
          installStatus.textContent = `Automatic download isn't available for ${info.label}. Install ffmpeg yourself and it'll be found on PATH, or point BROWSE… at it.`;
          return;
        }
        installStatus.textContent = `Downloading ffmpeg for ${info.label}…`;
        const result = await window.api.ffmpegInstall();
        if (result.error) {
          installStatus.textContent = `Install failed: ${result.error}`;
          return;
        }
        cfg.ffmpegPath = result.path;
        pathEl.value = result.path;
        ctx.saveConfigDebounced();
        installStatus.textContent = 'Installed. Restart RerunTV to start using it.';
      } catch (e) {
        installStatus.textContent = `Install failed: ${e.message}`;
      } finally {
        installBtn.disabled = false;
      }
    });
    },
  }],
});

