const { contextBridge, ipcRenderer } = require('electron');

// Minimal API exposed to input.html (no Node access in the renderer)
contextBridge.exposeInMainWorld('overlayApi', {
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  submit: (url, displayId) => ipcRenderer.send('submit-url', { url, displayId }),
});
