// Shared mainWindow reference — the LAN servers and any plugin's own
// main-process module all need to reach the same BrowserWindow (webContents.send) that
// main.js owns and re-assigns on createWindow(), but none of them should
// hold their own separate variable that could go stale independently. A
// getter (rather than passing the window instance itself at require-time,
// before it exists) means every module always reads whatever main.js most
// recently set, including staying null in --headless mode.
let mainWindow = null;

/**
 * Records the current main window (or null).
 * @param {?Electron.BrowserWindow} win The window main.js just created, or null.
 */
function setMainWindow(win) { mainWindow = win; }
/**
 * The main window main.js most recently set.
 * @returns {?Electron.BrowserWindow} The current main window, or null (always null in headless mode).
 */
function getMainWindow() { return mainWindow; }

module.exports = { setMainWindow, getMainWindow };
