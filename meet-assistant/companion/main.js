// Окно подсказок Meet Assistant.
// Окно включает защиту контента (setContentProtection): Windows и macOS не отдают его
// в захват экрана, поэтому на демонстрации в Мите (и в записи) его не видно — видишь только ты.
// Расширение Chrome подключается к локальному WebSocket и присылает сюда подсказки.
const { app, BrowserWindow, screen, ipcMain, globalShortcut } = require("electron");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const PORT = 47823;
let win = null;
const clients = new Set();

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: 460,
    height: 600,
    x: workArea.x + workArea.width - 480,
    y: workArea.y + 20,
    minWidth: 300,
    minHeight: 160,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    title: "Meet Assistant",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setContentProtection(true); // ← невидимо для демонстрации экрана и скриншотов
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile("index.html");
  win.webContents.on("did-finish-load", sendStatus);
  win.on("closed", () => (win = null));
}

function sendStatus() {
  win?.webContents.send("status", { connected: clients.size > 0 });
}

function startServer() {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
    // Принимаем подключения только от расширений Chrome, а не от обычных сайтов.
    verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("chrome-extension://"),
  });
  wss.on("connection", (ws) => {
    clients.add(ws);
    sendStatus();
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === "ping") return;
      win?.webContents.send("hint", msg);
    });
    ws.on("close", () => { clients.delete(ws); sendStatus(); });
  });
  wss.on("error", (err) => {
    console.error("WebSocket server error:", err.message);
    win?.webContents.send("hint", {
      type: "fatal",
      text: `Не удалось открыть порт ${PORT}: ${err.message}. Возможно, окно уже запущено.`,
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => { win?.show(); win?.focus(); });
  app.whenReady().then(() => {
    createWindow();
    startServer();
    // Ctrl/Cmd+Shift+H — спрятать/показать окно.
    globalShortcut.register("CommandOrControl+Shift+H", () => {
      if (!win) return;
      win.isVisible() ? win.hide() : win.showInactive();
    });
  });
  ipcMain.on("quit", () => app.quit());
  ipcMain.on("minimize", () => win?.minimize());
  ipcMain.on("opacity", (_e, v) => win?.setOpacity(Math.min(1, Math.max(0.3, Number(v) || 1))));
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
