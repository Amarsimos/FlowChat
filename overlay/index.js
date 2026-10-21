const { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut, dialog } = require('electron');
const path = require('path');

let inputWindow;
let mainWindow;

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  dialog.showErrorBox('左上を見て！', 'もう作業中ですよ！');
  app.quit();
  process.exit(0);
}

// Handle second instance activation
app.on('second-instance', () => {
  if (inputWindow && !inputWindow.isDestroyed()) {
    if (inputWindow.isMinimized()) inputWindow.restore();
    inputWindow.focus();
  }
});

// Register IPC handlers first to avoid race conditions with window initialization
ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((display, index) => {
    const isPrimary = display.id === screen.getPrimaryDisplay().id;
    return {
      id: display.id,
      label: `Display ${index + 1} (${display.bounds.width}x${display.bounds.height})${isPrimary ? ' - Primary' : ''}`,
      bounds: display.bounds
    };
  });
});

ipcMain.on('submit-url', (event, { url, displayId }) => {
  const displays = screen.getAllDisplays();
  let selectedDisplay;

  if (displayId) {
    selectedDisplay = displays.find(d => d.id === displayId);
  }
  if (!selectedDisplay) {
    selectedDisplay = screen.getPrimaryDisplay();
  }

  createMainWindow(url, selectedDisplay);

  if (inputWindow) {
    inputWindow.close();
  }
});

function createInputWindow() {
  inputWindow = new BrowserWindow({
    width: 480,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'FlowChatSystem',
    autoHideMenuBar: true, // Hide menu bar on Windows/Linux
    icon: path.join(__dirname, 'icon.png'), // Set window taskbar icon
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  // Completely remove the menu for the input window
  inputWindow.setMenu(null);

  inputWindow.loadFile(path.join(__dirname, 'input.html'));

  inputWindow.on('closed', () => {
    inputWindow = null;
    // If the main window hasn't been created yet, quit the app
    if (!mainWindow) {
      app.quit();
    }
  });
}

function createMainWindow(targetUrl, selectedDisplay) {
  const { x, y, width, height } = selectedDisplay.bounds;

  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    x: x,
    y: y,
    frame: false, // Borderless/frameless
    transparent: true, // Transparent background
    alwaysOnTop: true, // Permanently always-on-top
    focusable: false, // Non-focusable to ensure clicks and keys pass to background
    resizable: false,
    hasShadow: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'), // Set window taskbar icon
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // Completely remove the menu for the main window
  mainWindow.setMenu(null);

  // Use the highest 'screen-saver' level to ensure it stays on top of standard windows and taskbars
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // Periodically re-enforce always-on-top status to prevent other windows from taking precedence
  const alwaysOnTopInterval = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    } else {
      clearInterval(alwaysOnTopInterval);
    }
  }, 1000);

  // Enable mouse click-through but forward events to the page for hover effects
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Load the URL provided by the setup window
  mainWindow.loadURL(targetUrl);

  // Inject CSS and DOM element on page load (did-finish-load)
  mainWindow.webContents.on('did-finish-load', () => {
    const css = `
      html, body {
        background: transparent !important;
        background-color: transparent !important;
        overflow: hidden !important;
      }
      /* Hide all scrollbars globally */
      ::-webkit-scrollbar {
        display: none !important;
      }
      /* Floating status indicator label in top-left */
      #flowchat-status-indicator {
        position: fixed !important;
        top: 16px !important;
        left: 16px !important;
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Display', Roboto, sans-serif !important;
        color: #cdd6f4 !important;
        background-color: rgba(30, 30, 46, 0.75) !important;
        padding: 8px 14px !important;
        border-radius: 8px !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        z-index: 99999999 !important;
        pointer-events: auto !important; /* Enable hover detection while window forwards mouse events */
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3) !important;
        backdrop-filter: blur(8px) !important;
        user-select: none !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 4px !important;
        align-items: flex-start !important;
        transition: opacity 0.3s ease-in-out !important;
        animation: fadeOutSlowly 5s forwards !important;
      }
      #flowchat-status-indicator:hover {
        opacity: 1 !important;
        animation: none !important; /* Stop/reset animation on hover */
      }
      .flowchat-main-text {
        font-size: 14px !important;
        font-weight: 600 !important;
      }
      .flowchat-sub-text {
        font-size: 11px !important;
        color: #a6adc8 !important;
        font-weight: 400 !important;
      }
      @keyframes fadeOutSlowly {
        0% { opacity: 1; }
        80% { opacity: 1; }
        100% { opacity: 0.15; }
      }
    `;
    mainWindow.webContents.insertCSS(css);

    // Inject status text and shortcut hint DOM
    const js = `
      if (!document.getElementById('flowchat-status-indicator')) {
        const indicator = document.createElement('div');
        indicator.id = 'flowchat-status-indicator';

        const mainText = document.createElement('span');
        mainText.className = 'flowchat-main-text';
        mainText.innerText = '👍FlowChat絶賛作業中';

        const subText = document.createElement('span');
        subText.className = 'flowchat-sub-text';
        subText.innerText = 'Ctrl+Alt+Qで終了';

        indicator.appendChild(mainText);
        indicator.appendChild(subText);
        document.body.appendChild(indicator);
      }
    `;
    mainWindow.webContents.executeJavaScript(js);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// Enable GPU Hardware Acceleration (dramatically improves startup speed and window creation time)
// app.disableHardwareAcceleration(); // Disabled line removed

// Prevent default menu bar creation
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createInputWindow();

  // Register a global shortcut to quit the app (Ctrl + Alt + Q)
  globalShortcut.register('CommandOrControl+Alt+Q', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createInputWindow();
    }
  });
});

app.on('will-quit', () => {
  // Unregister all global shortcuts to clean up resources
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
