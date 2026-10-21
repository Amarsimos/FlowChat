const { contextBridge, ipcRenderer } = require('electron');

// API for the UI injected into the overlay page (QR button / QR panel)
contextBridge.exposeInMainWorld('flowchatOverlay', {
  // Temporarily disable click-through while the cursor is over an interactive element
  setClickable: (clickable) => ipcRenderer.send('overlay-clickable', clickable),
  toggleQr: () => ipcRenderer.send('toggle-qr'),
});
