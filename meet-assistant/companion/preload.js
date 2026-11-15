const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onHint: (cb) => ipcRenderer.on("hint", (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
  quit: () => ipcRenderer.send("quit"),
  screenshot: () => ipcRenderer.send("screenshot"),
  draw: (key) => ipcRenderer.send("draw", key),
  minimize: () => ipcRenderer.send("minimize"),
  setOpacity: (v) => ipcRenderer.send("opacity", v),
});
