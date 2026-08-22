// Virtual CH 0 (AUX/Video In) — lets a window/app running on the same
// machine (KaraFun, PiKaraoke, any other app) show up as a "channel", the
// same way a real cable box's AUX input shows whatever's plugged into it.
// This is just the source-listing IPC; the actual capture (getUserMedia +
// setting it as the shared <video> element's srcObject) happens entirely
// in the renderer (renderer.js) since desktopCapturer only enumerates
// sources — it doesn't do the capture itself.
//
// Phase 2 isolated plugin (manifest.json "isolated": true) — runs in its own
// forked process (main-plugin-isolation.js). ctx.desktopCapturer.getSources()
// is an RPC call there, not the real Electron API directly — the host side
// already returns the final {id, name, thumbnailDataUrl} shape (a NativeImage
// like `s.thumbnail` can't cross the process boundary, so the host maps it to
// a plain dataURL string before replying), so there's nothing left for this
// plugin to map itself. See PLUGIN_DEVELOPMENT.md's "Isolated plugins"
// section for the full ctx surface this gets instead of the same-process one.
function activate(ctx) {
  const { ipcMain, desktopCapturer } = ctx;

  ipcMain.handle('desktop:listSources', async () => desktopCapturer.getSources({
    types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 },
  }));
}

// Called by core (registerFallbackHandlers, main-plugins.js) instead of
// activate() when this plugin is disabled/missing.
function registerFallback(ipcMain) {
  ipcMain.handle('desktop:listSources', async () => []);
}

module.exports = { activate, registerFallback };
