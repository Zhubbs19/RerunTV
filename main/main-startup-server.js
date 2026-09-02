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

function getStartupServerStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, reason: 'windows-only' };
  }
  if (!app.isPackaged) {
    return { supported: false, enabled: false, reason: 'installed-build-only' };
  }

  const options = startupOptions();
  const settings = app.getLoginItemSettings(options);
  return {
    supported: true,
    enabled: !!settings.openAtLogin,
    launchAllowed: settings.executableWillLaunchAtLogin !== false,
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

module.exports = { STARTUP_ARGS, getStartupServerStatus, registerStartupServerIpc };
