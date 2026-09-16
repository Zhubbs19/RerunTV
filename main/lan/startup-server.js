// Native OS startup registration for RerunTV's browser-based server mode.
// This deliberately registers the installed executable itself instead of a
// batch file, so login starts without a console window and Windows can expose
// the entry in Settings / Task Manager's Startup Apps list.

const { app } = require('electron');

const STARTUP_ARGS = Object.freeze(['--server', '--login-startup']);
const STARTUP_NAME = 'RerunTV Server';

function startupOptions() {
  return {
    path: process.execPath,
    args: [...STARTUP_ARGS],
  };
}

function sameWindowsPath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

function statusFromLoginSettings(settings, targetPath = process.execPath) {
  // Electron 43.4.0 writes the complete Run value correctly, including
  // --server/--login-startup, but its Windows readback currently reports an
  // empty launchItems[].args array and therefore openAtLogin:false. Identify
  // our uniquely named entry directly instead of trusting that broken args
  // comparison; item.enabled still reflects Windows StartupApproved state.
  const launchItem = Array.isArray(settings.launchItems)
    ? settings.launchItems.find((item) => (
      item.name === STARTUP_NAME && sameWindowsPath(item.path, targetPath)
    ))
    : null;
  if (launchItem) {
    return { enabled: true, launchAllowed: launchItem.enabled !== false };
  }
  return {
    enabled: !!settings.openAtLogin,
    launchAllowed: settings.executableWillLaunchAtLogin !== false,
  };
}

function getStartupServerStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, reason: 'windows-only' };
  }
  if (!app.isPackaged) {
    return { supported: false, enabled: false, reason: 'installed-build-only' };
  }

  const options = startupOptions();
  const settings = app.getLoginItemSettings(options);
  const status = statusFromLoginSettings(settings, options.path);
  return {
    supported: true,
    ...status,
  };
}

function setStartupServerEnabled(enabled) {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return getStartupServerStatus();
  }

  app.setLoginItemSettings({
    ...startupOptions(),
    name: STARTUP_NAME,
    openAtLogin: !!enabled,
    ...(enabled ? { enabled: true } : {}),
  });
  return getStartupServerStatus();
}

function registerStartupServerIpc(ipcMain) {
  ipcMain.handle('startupServer:getStatus', async () => getStartupServerStatus());
  ipcMain.handle('startupServer:setEnabled', async (event, enabled) => {
    try {
      return setStartupServerEnabled(enabled);
    } catch (error) {
      return {
        ...getStartupServerStatus(),
        error: error && error.message ? error.message : String(error),
      };
    }
  });
}

module.exports = {
  STARTUP_ARGS,
  getStartupServerStatus,
  registerStartupServerIpc,
  statusFromLoginSettings,
};
