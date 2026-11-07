// Preload for the update-progress popup window: exposes `window.updateProgress`
// with listeners for the progress state and theme colours the updater sends.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateProgress', {
  onState: (callback) => ipcRenderer.on('update-progress:state', (_event, state) => callback(state)),
  onTheme: (callback) => ipcRenderer.on('update-progress:theme', (_event, colors) => callback(colors)),
});
