// Generic Electron file/folder picker wrappers used across several setup
// screens (channel folder, channel icon, background audio, an executable for
// a plugin, a custom CSS theme file) — no module-specific logic of their own,
// just dialog.showOpenDialog with a filter, kept together since they're the
// one cohesive group of ipcMain handlers left with genuinely no natural home
// among the other main-*.js modules.
const { dialog } = require('electron');
const { getMainWindow } = require('../config/window-ref');

function registerDialogIpc(ipcMain) {
  ipcMain.handle('dialog:selectFolder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:selectImage', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:selectAudio', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // `{ multiple: true }` returns an array of paths ([] on cancel) — used by a
  // channel's ADD FILES. Without it, the original single path (null on cancel).
  ipcMain.handle('dialog:selectVideo', async (_event, opts) => {
    const multiple = !!(opts && opts.multiple);
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'mpg', 'mpeg'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return multiple ? [] : null;
    return multiple ? result.filePaths : result.filePaths[0];
  });

  ipcMain.handle('dialog:selectExecutable', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'Programs', extensions: ['exe'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:selectCss', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'Stylesheets', extensions: ['css'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}

module.exports = { registerDialogIpc };
