const { app, BrowserWindow, screen, ipcMain, Menu, Tray, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const QUIT_SHORTCUT = 'CommandOrControl+Alt+Q';
const QR_SHORTCUT = 'CommandOrControl+Alt+C';
const RETRY_DELAY_MS = 5000;
const POST_URL = 'https://t-hasegawa-fu.github.io/FlowChat/PostPageStamp.html';
const QR_LARGE_DURATION_MS = 3 * 60 * 1000;

let inputWindow;
let tray;
// Overlay windows, keyed by display id ('all' mode) or 'single' (one window that follows the chosen display)
const overlays = new Map();
let overlayUrl = null;
// Display chosen in settings: 'all', 'auto' (external display if present, else primary) or a display id
let displaySetting = 'all';
let overlaysHidden = false;
let qrTimer = null;
let qrDataUrlPromise = null;
let qrVisible = false;

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  dialog.showErrorBox('FlowChatSystem', 'FlowChatSystem はすでに起動しています。\nタスクトレイのアイコンから操作できます。');
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

// ---- Settings persistence (last URL / display) ----
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

function findDisplay(displayId) {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  if (displayId === 'auto') {
    // PowerPoint switches duplicate mode to extend mode and shows the slideshow on the external display
    return displays.find(d => d.id !== primary.id) || primary;
  }
  return displays.find(d => d.id === displayId) || primary;
}

function overlayWindows() {
  return [...overlays.values()].filter(win => !win.isDestroyed());
}

// Register IPC handlers first to avoid race conditions with window initialization
ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((display, index) => {
    const isPrimary = display.id === screen.getPrimaryDisplay().id;
    return {
      id: display.id,
      label: `モニター ${index + 1} (${display.bounds.width}x${display.bounds.height})${isPrimary ? ' - メイン' : ''}`,
      bounds: display.bounds
    };
  });
});

ipcMain.handle('get-settings', () => loadSettings());

ipcMain.on('overlay-clickable', (event, clickable) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(!clickable, { forward: true });
  }
});

ipcMain.on('toggle-qr', () => toggleQr());

ipcMain.on('submit-url', (event, { url, displayId }) => {
  saveSettings({ url, displayId });
  startOverlays(url, displayId);

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
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    }
  });

  // Completely remove the menu for the input window
  inputWindow.setMenu(null);

  inputWindow.loadFile(path.join(__dirname, 'input.html'));

  inputWindow.on('closed', () => {
    inputWindow = null;
    // If no overlay is running (setup was cancelled), quit the app
    if (overlayWindows().length === 0) {
      app.quit();
    }
  });
}

// Open the setup window again, replacing the running overlays
function reopenSettings() {
  if (inputWindow && !inputWindow.isDestroyed()) {
    inputWindow.focus();
    return;
  }
  createInputWindow();
  stopOverlays();
}

function startOverlays(url, displayId) {
  stopOverlays();
  overlayUrl = url;
  displaySetting = displayId ?? 'all';
  syncOverlays();
  showQrForStartup();
}

function stopOverlays() {
  overlayUrl = null;
  clearTimeout(qrTimer);
  overlayWindows().forEach(win => win.close());
  overlays.clear();
  updateTrayMenu();
}

// Create / move / close overlay windows so they match the current display layout
function syncOverlays() {
  if (!overlayUrl) return;

  const targets = new Map();
  if (displaySetting === 'all') {
    screen.getAllDisplays().forEach(d => targets.set(d.id, d));
  } else {
    targets.set('single', findDisplay(displaySetting));
  }

  for (const [key, win] of overlays) {
    if (!targets.has(key) || win.isDestroyed()) {
      if (!win.isDestroyed()) win.close();
      overlays.delete(key);
    }
  }
  for (const [key, display] of targets) {
    const win = overlays.get(key);
    if (win) {
      fitToBounds(win, display.bounds);
    } else {
      overlays.set(key, createOverlayWindow(overlayUrl, display.bounds));
    }
  }
  updateTrayMenu();
}

function fitToBounds(win, bounds) {
  // Set twice: moving between displays with different scale factors can leave the first size wrong
  win.setBounds(bounds);
  win.setBounds(bounds);
}

// Display events can fire while Windows is still reconfiguring (e.g. duplicate -> extend), so sync again shortly after
function onDisplaysChanged() {
  syncOverlays();
  setTimeout(syncOverlays, 1000);
}

function scheduleRetry(win) {
  clearTimeout(win.retryTimer);
  setTrayStatus('再接続中...');
  win.retryTimer = setTimeout(() => {
    if (!win.isDestroyed()) win.webContents.reload();
  }, RETRY_DELAY_MS);
}

function createOverlayWindow(targetUrl, bounds) {
  const { x, y, width, height } = bounds;
  const targetOrigin = new URL(targetUrl).origin;

  const win = new BrowserWindow({
    width: width,
    height: height,
    x: x,
    y: y,
    show: !overlaysHidden,
    frame: false, // Borderless/frameless
    transparent: true, // Transparent background
    alwaysOnTop: true, // Permanently always-on-top
    focusable: false, // Non-focusable to ensure clicks and keys pass to background
    resizable: false,
    enableLargerThanScreen: true, // Don't clamp to the work area (taskbar) or the primary display size
    hasShadow: false,
    skipTaskbar: true, // Controlled from the tray icon instead
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'), // Set window taskbar icon
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    }
  });

  // Completely remove the menu for the overlay window
  win.setMenu(null);

  // The constructor size can still be clamped on displays other than the primary one, so apply it again
  fitToBounds(win, bounds);

  // Use the highest 'screen-saver' level to ensure it stays on top of standard windows and taskbars
  win.setAlwaysOnTop(true, 'screen-saver');

  // Periodically re-enforce always-on-top status to prevent other windows from taking precedence
  const alwaysOnTopInterval = setInterval(() => {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      clearInterval(alwaysOnTopInterval);
    }
  }, 1000);

  // Enable mouse click-through but forward events to the page for hover effects
  win.setIgnoreMouseEvents(true, { forward: true });

  // Block popups and navigation away from the target site
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== targetOrigin) event.preventDefault();
  });

  // Recover from network errors and renderer crashes
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 (ERR_ABORTED) happens on normal reloads/navigations
    if (isMainFrame && errorCode !== -3) scheduleRetry(win);
  });
  win.webContents.on('render-process-gone', () => scheduleRetry(win));

  // Load the URL provided by the setup window
  win.loadURL(targetUrl);

  // Inject CSS and DOM element on page load (did-finish-load)
  win.webContents.on('did-finish-load', () => {
    setTrayStatus('表示中');
    injectOverlayUi(win);
    win.webContents.insertCSS(QR_CSS);
    // New or reloaded windows follow the current QR state
    applyQr(win, qrVisible);
  });

  win.on('closed', () => {
    clearInterval(alwaysOnTopInterval);
    clearTimeout(win.retryTimer);
    updateTrayMenu();
  });

  return win;
}

function injectOverlayUi(win) {
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
    .flowchat-qr-button {
      margin-top: 4px !important;
      padding: 4px 10px !important;
      font-size: 12px !important;
      font-family: inherit !important;
      color: #1e1e2e !important;
      background: #cdd6f4 !important;
      border: none !important;
      border-radius: 6px !important;
      cursor: pointer !important;
    }
    .flowchat-qr-button:hover {
      background: #ffffff !important;
    }
    @keyframes fadeOutSlowly {
      0% { opacity: 1; }
      80% { opacity: 1; }
      100% { opacity: 0.15; }
    }
  `;
  win.webContents.insertCSS(css);

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

      const qrButton = document.createElement('button');
      qrButton.className = 'flowchat-qr-button';
      qrButton.innerText = '📱 投稿用QRコード (Ctrl+Alt+C)';
      qrButton.addEventListener('mouseenter', () => window.flowchatOverlay.setClickable(true));
      qrButton.addEventListener('mouseleave', () => window.flowchatOverlay.setClickable(false));
      qrButton.addEventListener('click', () => window.flowchatOverlay.toggleQr());

      indicator.appendChild(mainText);
      indicator.appendChild(subText);
      indicator.appendChild(qrButton);
      document.body.appendChild(indicator);
    }
  `;
  win.webContents.executeJavaScript(js);
}

// ---- QR code for the post page (shown at startup, then toggled by shortcut / button / tray) ----
const QR_CSS = `
  #flowchat-qr {
    position: fixed !important;
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: min(40vh, 40vw) !important;
    padding: 24px !important;
    z-index: 99999998 !important;
    flex-direction: column !important;
    align-items: center !important;
    gap: 8px !important;
    background: #ffffff !important;
    border-radius: 12px !important;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35) !important;
    font-family: 'Segoe UI', 'Yu Gothic UI', 'Meiryo', sans-serif !important;
    color: #1e1e2e !important;
    cursor: pointer !important;
    pointer-events: auto !important;
  }
  #flowchat-qr.flowchat-qr-visible { display: flex !important; }
  #flowchat-qr.flowchat-qr-hidden { display: none !important; }
  #flowchat-qr img { display: block !important; width: 100% !important; height: auto !important; }
  #flowchat-qr .flowchat-qr-title { font-size: 22px !important; font-weight: 700 !important; text-align: center !important; }
  #flowchat-qr .flowchat-qr-sub { font-size: 16px !important; color: #45475a !important; }
  #flowchat-qr .flowchat-qr-hint { font-size: 12px !important; color: #6c7086 !important; }
`;

function getQrDataUrl() {
  if (!qrDataUrlPromise) {
    qrDataUrlPromise = QRCode.toDataURL(POST_URL, { width: 512, margin: 1 });
  }
  return qrDataUrlPromise;
}

async function applyQr(win, visible) {
  if (win.isDestroyed()) return;
  // The hidden panel can't fire mouseleave, so restore click-through here
  if (!visible) win.setIgnoreMouseEvents(true, { forward: true });
  try {
    const dataUrl = await getQrDataUrl();
    await win.webContents.executeJavaScript(`
      (() => {
        let qr = document.getElementById('flowchat-qr');
        if (!qr) {
          qr = document.createElement('div');
          qr.id = 'flowchat-qr';
          const img = document.createElement('img');
          img.src = ${JSON.stringify(dataUrl)};
          const title = document.createElement('span');
          title.className = 'flowchat-qr-title';
          title.innerText = '📱 スマホでコメントしよう！';
          const sub = document.createElement('span');
          sub.className = 'flowchat-qr-sub';
          sub.innerText = 'スタンプだけでも大歓迎 🎉';
          const hint = document.createElement('span');
          hint.className = 'flowchat-qr-hint';
          hint.innerText = 'クリック または Ctrl+Alt+C で閉じる';
          qr.appendChild(img);
          qr.appendChild(title);
          qr.appendChild(sub);
          qr.appendChild(hint);
          qr.addEventListener('mouseenter', () => window.flowchatOverlay.setClickable(true));
          qr.addEventListener('mouseleave', () => window.flowchatOverlay.setClickable(false));
          qr.addEventListener('click', () => window.flowchatOverlay.toggleQr());
          document.body.appendChild(qr);
        }
        qr.className = ${JSON.stringify(visible ? 'flowchat-qr-visible' : 'flowchat-qr-hidden')};
      })();
    `);
  } catch (err) {
    console.error('Failed to update QR code:', err);
  }
}

// QR state is shared: it is shown / hidden on every display at once
function setQrVisible(visible) {
  qrVisible = visible;
  overlayWindows().forEach(win => applyQr(win, visible));
}

function toggleQr() {
  clearTimeout(qrTimer);
  setQrVisible(!qrVisible);
}

function showQrForStartup() {
  clearTimeout(qrTimer);
  setQrVisible(true);
  qrTimer = setTimeout(() => setQrVisible(false), QR_LARGE_DURATION_MS);
}

// ---- Tray icon (main way to control the overlay) ----
function setTrayStatus(status) {
  if (tray) tray.setToolTip(`FlowChatSystem - ${status}`);
}

function updateTrayMenu() {
  if (!tray) return;
  const windows = overlayWindows();
  const hasOverlay = windows.length > 0;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '表示する',
      type: 'checkbox',
      enabled: hasOverlay,
      checked: hasOverlay && !overlaysHidden,
      click: (item) => {
        overlaysHidden = !item.checked;
        overlayWindows().forEach(win => overlaysHidden ? win.hide() : win.showInactive());
      }
    },
    { label: `投稿用QRコードの表示/非表示 (${QR_SHORTCUT.replace('CommandOrControl', 'Ctrl')})`, enabled: hasOverlay, click: toggleQr },
    { label: '再読み込み', enabled: hasOverlay, click: () => overlayWindows().forEach(win => win.webContents.reload()) },
    { label: '設定を変更...', click: reopenSettings },
    { type: 'separator' },
    { label: `終了 (${QUIT_SHORTCUT.replace('CommandOrControl', 'Ctrl')})`, click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  setTrayStatus('起動中');
  tray.on('click', () => tray.popUpContextMenu());
  updateTrayMenu();
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdatesAndNotify().catch(err => console.error('Update check failed:', err));
  } catch (err) {
    console.error('electron-updater unavailable:', err);
  }
}

// Prevent default menu bar creation
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createTray();

  // Start directly with the last used settings; the tray menu can reopen the setup window
  const settings = loadSettings();
  if (settings.url) {
    startOverlays(settings.url, settings.displayId);
  } else {
    createInputWindow();
  }

  // Register a global shortcut to quit the app (Ctrl + Alt + Q)
  if (!globalShortcut.register(QUIT_SHORTCUT, () => app.quit())) {
    console.warn(`Failed to register ${QUIT_SHORTCUT}; use the tray menu to quit.`);
  }
  if (!globalShortcut.register(QR_SHORTCUT, toggleQr)) {
    console.warn(`Failed to register ${QR_SHORTCUT}; use the button or tray menu instead.`);
  }

  // Follow monitor plug / unplug, duplicate <-> extend switches and resolution changes
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  setupAutoUpdate();
});

app.on('will-quit', () => {
  // Unregister all global shortcuts to clean up resources
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep running in the tray: overlays are closed and recreated as displays change.
  // Quitting is done explicitly (tray menu, shortcut, or cancelling the setup window).
});
