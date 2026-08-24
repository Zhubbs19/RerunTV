const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateProgress', {
  onState: (callback) => ipcRenderer.on('update-progress:state', (_event, state) => callback(state)),
});
