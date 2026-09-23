// Native OS startup registration: RerunTV's browser-based server mode, or the
// full window (a PC driving a TV, where the box should just be on after the
// PC boots — screen-placement.js puts it back on the TV). This deliberately
// registers the installed executable itself instead of a batch file, so login
// starts without a console window and Windows can expose the entry in
// Settings / Task Manager's Startup Apps list.
//
// The two are separate named Run entries but only one is ever on: both would
// launch at sign-in and the loser would just hit the single-instance lock.
// The window runs the same LAN servers, so it covers what the server did.

const { app } = require('electron');

const STARTUP_ARGS = Object.freeze(['--server', '--login-startup']);
const STARTUP_NAME = 'RerunTV Server';
const WINDOW_STARTUP_ARGS = Object.freeze(['--login-startup']);
const WINDOW_STARTUP_NAME = 'RerunTV';

const ENTRIES = Object.freeze({
  server: { name: STARTUP_NAME, args: STARTUP_ARGS },
  window: { name: WINDOW_STARTUP_NAME, args: WINDOW_STARTUP_ARGS },
});

function startupOptions(entry = ENTRIES.server) {
  return {
    path: process.execPath,
    args: [...entry.args],
  };
}

function sameWindowsPath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

function statusFromLoginSettings(settings, targetPath = process.execPath, name = STARTUP_NAME) {
  // Electron 43.4.0 writes the complete Run value correctly, including
  // --server/--login-startup, but its Windows readback currently reports an
  // empty launchItems[].args array and therefore openAtLogin:false. Identify
  // our uniquely named entry directly instead of trusting that broken args
  // comparison; item.enabled still reflects Windows StartupApproved state.
  const launchItem = Array.isArray(settings.launchItems)
    ? settings.launchItems.find((item) => (
      item.name === name && sameWindowsPath(item.path, targetPath)
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

function getStartupStatus(entry) {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, reason: 'windows-only' };
  }
  if (!app.isPackaged) {
    return { supported: false, enabled: false, reason: 'installed-build-only' };
  }

  const options = startupOptions(entry);
  const settings = app.getLoginItemSettings(options);
  const status = statusFromLoginSettings(settings, options.path, entry.name);
  return {
    supported: true,
    ...status,
  };
}

function setStartupEnabled(entry, enabled) {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return getStartupStatus(entry);
  }
  if (enabled) {
    const other = entry === ENTRIES.server ? ENTRIES.window : ENTRIES.server;
    if (getStartupStatus(other).enabled) {
      app.setLoginItemSettings({ ...startupOptions(other), name: other.name, openAtLogin: false });
    }
  }
  app.setLoginItemSettings({
    ...startupOptions(entry),
    name: entry.name,
    openAtLogin: !!enabled,
    ...(enabled ? { enabled: true } : {}),
  });
  return getStartupStatus(entry);
}

const getStartupServerStatus = () => getStartupStatus(ENTRIES.server);
const setStartupServerEnabled = (enabled) => setStartupEnabled(ENTRIES.server, enabled);
const getStartupWindowStatus = () => getStartupStatus(ENTRIES.window);
const setStartupWindowEnabled = (enabled) => setStartupEnabled(ENTRIES.window, enabled);

function handleSet(setter, getter) {
  return async (event, enabled) => {
    try {
      return setter(enabled);
    } catch (error) {
      return {
        ...getter(),
        error: error && error.message ? error.message : String(error),
      };
    }
  };
}

function registerStartupServerIpc(ipcMain) {
  ipcMain.handle('startupServer:getStatus', async () => getStartupServerStatus());
  ipcMain.handle('startupServer:setEnabled', handleSet(setStartupServerEnabled, getStartupServerStatus));
  ipcMain.handle('startupWindow:getStatus', async () => getStartupWindowStatus());
  ipcMain.handle('startupWindow:setEnabled', handleSet(setStartupWindowEnabled, getStartupWindowStatus));
}

module.exports = {
  STARTUP_ARGS,
  WINDOW_STARTUP_ARGS,
  getStartupServerStatus,
  getStartupWindowStatus,
  registerStartupServerIpc,
  statusFromLoginSettings,
};
