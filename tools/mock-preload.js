// 预览专用 preload：把主进程里的 mock 数据挂到 petAPI.getStats
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petAPI', {
  getStats: () => ipcRenderer.invoke('mock-get-stats'),
});
