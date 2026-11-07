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

// The two login entries: the browser-based server mode and the full window.
const ENTRIES = Object.freeze({
  server: { name: STARTUP_NAME, args: STARTUP_ARGS },
  window: { name: WINDOW_STARTUP_NAME, args: WINDOW_STARTUP_ARGS },
});

/**
 * Login-item options for an entry: this executable plus the entry's arguments.
 * @param {object} [entry=ENTRIES.server] An entry from `ENTRIES`.
 * @returns {object} `{ path, args }`.
 */
function startupOptions(entry = ENTRIES.server) {
  return {
    path: process.execPath,
    args: [...entry.args],
  };
}

/**
 * Case-insensitive path comparison, as Windows paths are.
 * @param {*} left One path.
 * @param {*} right The other path.
 * @returns {boolean} True when both are strings that match ignoring case.
 */
function sameWindowsPath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

/**
 * Reads whether a named login entry is registered and allowed to launch.
 * @param {object} settings The result of `app.getLoginItemSettings`.
 * @param {string} [targetPath=process.execPath] The executable the entry should point at.
 * @param {string} [name=STARTUP_NAME] The entry's registered name.
 * @returns {object} `{ enabled, launchAllowed }`.
 */
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

/**
 * Startup registration status of one entry; unsupported outside a packaged Windows build.
 * @param {object} entry An entry from `ENTRIES`.
 * @returns {object} `{ supported, enabled, launchAllowed?, reason? }`.
 */
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

/**
 * Turns one login entry on or off. Turning one on turns the other off, since only one may be on.
 * @param {object} entry An entry from `ENTRIES`.
 * @param {boolean} enabled Whether it should launch at sign-in.
 * @returns {object} The entry's status afterwards.
 */
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

/**
 * Whether server mode launches at sign-in.
 * @returns {object} Startup status of the server-mode entry.
 */
const getStartupServerStatus = () => getStartupStatus(ENTRIES.server);
/**
 * Turns the server-mode login entry on or off.
 * @param {boolean} enabled Whether server mode should launch at sign-in.
 * @returns {object} The server-mode entry's status afterwards.
 */
const setStartupServerEnabled = (enabled) => setStartupEnabled(ENTRIES.server, enabled);
/**
 * Whether the full window launches at sign-in.
 * @returns {object} Startup status of the full-window entry.
 */
const getStartupWindowStatus = () => getStartupStatus(ENTRIES.window);
/**
 * Turns the full-window login entry on or off.
 * @param {boolean} enabled Whether the window should launch at sign-in.
 * @returns {object} The full-window entry's status afterwards.
 */
const setStartupWindowEnabled = (enabled) => setStartupEnabled(ENTRIES.window, enabled);

/**
 * Wraps a setter as an IPC handler that returns the current status plus `error` instead of throwing.
 * @param {Function} setter Takes `enabled` and returns the new status.
 * @param {Function} getter Returns the current status.
 * @returns {Function} The IPC handler.
 */
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

/**
 * Registers the `startupServer:*` and `startupWindow:*` IPC handlers.
 * @param {Electron.IpcMain} ipcMain Electron's IPC main object.
 */
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
