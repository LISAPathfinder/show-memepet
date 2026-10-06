// 临时预览：用 Electron 窗口加载 stats.html，注入 mock 数据并截图（轻量替代浏览器截图）
// 用法: electron tools/preview-stats.js <输出png>
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.argv[2] || path.join(__dirname, 'stats-preview.png');
const days = (n, base) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() - (n - 1 - i) * 86400000);
    // 前 3 天为 0（贴近真实数据的未安装期），之后带波动
    const total = i < 3 ? 0 : Math.round(base * (0.5 + Math.sin(i * 1.7) * 0.3 + Math.random() * 0.35));
    return { date: d.toISOString().slice(0, 10), total };
  });

const MOCK = {
  today: 18342,
  last7: 96410,
  all: 1284902,
  mouseToday: { left: 5123, right: 902, middle: 87 },
  top10: [
    { key: 'Space', count: 3201 },
    { key: 'E', count: 2450 },
    { key: 'Backspace', count: 1988 },
    { key: 'Ctrl', count: 1420 },
    { key: 'A', count: 1330 },
    { key: 'N', count: 1180 },
    { key: 'I', count: 1021 },
    { key: 'Shift', count: 906 },
  ],
  last14: days(14, 13000),
  gamepadToday: [],
  gamepadStatus: 'none',
};

app.whenReady().then(async () => {
  if (process.argv[3] === '--dark') nativeTheme.themeSource = 'dark';
  ipcMain.handle('mock-get-stats', () => MOCK);
  const win = new BrowserWindow({
    width: 520,
    height: 640,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'stats.html'));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('saved: ' + OUT);
  app.exit(0);
});
