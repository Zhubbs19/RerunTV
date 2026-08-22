// Main-process half of the starter plugin — optional; delete this file (and
// "main" from manifest.json) if your plugin is pure renderer UI with
// nothing that needs Node/Electron access.
//
// This demonstrates: registering an IPC handler your renderer.js can call,
// reading a value out of ctx, and cleaning up on quit. See
// PLUGIN_DEVELOPMENT.md's "main-process side" section for the full ctx
// contract (ipcMain/app/shell/desktopCapturer/pluginDir/services/...).
function activate(ctx) {
  const { ipcMain } = ctx;

  // Pick a channel name namespaced to your plugin id so it can't collide
  // with core or another plugin's IPC channels.
  ipcMain.handle('starter-plugin:ping', async (event, opts) => {
    return { pong: true, receivedAt: Date.now(), youSent: opts };
  });

  // If you spawn a child process, open a server socket, or hold any other
  // resource that should be released on app exit, do it here — this fires
  // on graceful quit (not a force-kill, which no plugin gets a chance to
  // react to).
  ctx.app.on('before-quit', () => {
    // e.g. serverProc && serverProc.kill();
  });
}

module.exports = { activate };
