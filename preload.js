const { contextBridge, ipcRenderer, webUtils } = require('electron');

// M5 起追加：双击打开统计面板、右键菜单事件等
// ★ 穿透写入口已摘（1.0.57）：`setIgnoreMouseEvents` 与 `pet:set-ignore-mouse-events` 通道一并删除，
//   WS_EX_TRANSPARENT 只由主进程的 syncPetPassThrough/nativeSetIgnoreMouseEvents 写（§52 单写入者
//   现在是结构性的，不再只是约定）。守卫件 tools/verify-single-writer.js。
contextBridge.exposeInMainWorld('petAPI', {
  onCounter: (callback) => {
    ipcRenderer.on('pet:counter', (_event, data) => callback(data));
  },
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', dx, dy),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  onBubble: (callback) => {
    ipcRenderer.on('pet:show-bubble', (_event, data) => callback(data));
  },
  onState: (callback) => {
    ipcRenderer.on('pet:state', (_event, state) => callback(state));
  },
  // 走过去：active=true 进入 move 状态并按 direction 翻转朝向，active=false 回 idle
  onWalk: (callback) => {
    ipcRenderer.on('pet:walk', (_event, data) => callback(data || {}));
  },
  // 救援热键（Ctrl→Alt→P）：穿透状态万一卡住、点不到齿轮时，由主进程强制恢复可交互并弹菜单
  onForceInteractive: (callback) => {
    ipcRenderer.on('pet:force-interactive', () => callback());
  },
  // 右键置底穿透：渲染端只发请求（穿透/置底由主进程写，与单写入者同一分界）
  peekRequest: () => ipcRenderer.send('pet:peek-request'),
  // 主进程通知 peek 开始/结束：渲染端只做变暗/复原的视觉反馈
  onPeek: (callback) => {
    ipcRenderer.on('pet:peek', (_event, on) => callback(!!on));
  },
  // 真实光标位置：页面重载后没有任何 mousemove，靠它才能算准穿透状态
  getCursor: () => ipcRenderer.invoke('pet:cursor'),
  // 上报「可交互区域」（窗口内坐标）：穿透状态由主进程按它 + 真实光标判定，
  // 渲染端定时器会被页面节流，不能由渲染端兜底
  setInteractiveBox: (box) => ipcRenderer.send('pet:interactive-box', box),
  // 拖拽/玻璃特效期间点名「保持可交互」：指针可能被拖到窗口外，光靠 600ms 保持会中途变穿透
  keepInteractive: (on) => ipcRenderer.send('pet:keep-interactive', !!on),
  // 「正按着鼠标」状态（DOM 的 mousedown/mouseup 可靠；系统钩子**不派发 mouseup**，实测定过）
  pressing: (on) => ipcRenderer.send('pet:pressing', !!on),
  // Ctrl+拖拽缩放（1.0.31 替代 Ctrl+滚轮——与桌面图标缩放手势重合）：1.0.52 固定窗后拖拽中
  // 只动渲染端 transform（无 IPC），松手 scaleEnd 带最终 scale 由主进程钳制+持久化
  scaleEnd: (v) => ipcRenderer.send('pet:scale-end', v),
  // Ctrl 按住状态（1.0.39 缩放手柄显隐）：主进程全局钩子推送，down=按住
  onCtrl: (callback) => {
    ipcRenderer.on('pet:ctrl', (_event, data) => callback(data || {}));
  },
  // 主进程在锁屏解锁/唤醒后点名要求重新上报（渲染端定时器那时可能正被节流）
  onReportBox: (callback) => {
    ipcRenderer.on('pet:report-box', () => callback());
  },
  // 渲染端异常上报：打包版没有控制台，pet.js 顶层抛错会让整页处理器失效且完全静默
  reportClientError: (msg) => ipcRenderer.send('pet:client-error', String(msg)),
  // 主进程存活探测：收到就回一声，不回就会被判定为僵住并重载
  onPing: (callback) => {
    ipcRenderer.on('pet:ping', () => callback());
  },
  pong: () => ipcRenderer.send('pet:pong'),
  // 点击探针：记录点击是否真的到达了渲染端（排查「点不动」用）
  clickProbe: (what) => ipcRenderer.send('pet:click-probe', String(what)),
  // F7 统计面板
  openStats: () => ipcRenderer.send('stats:open'),
  getStats: () => ipcRenderer.invoke('stats:get'),
  // 换皮
  onSkin: (callback) => {
    ipcRenderer.on('pet:skin', (_event, data) => callback(data));
  },
  // 桌宠行为开关（双击开面板等）
  onConfig: (callback) => {
    ipcRenderer.on('pet:config', (_event, cfg) => callback(cfg));
  },
  openSkinPicker: (name) => ipcRenderer.send('skins:open-picker', name),
  getPickerData: (name) => ipcRenderer.invoke('picker:load', name),
  saveSkinMapping: (name, frames) => ipcRenderer.send('picker:save', { name, frames }),
  closePicker: () => ipcRenderer.send('picker:close'),
  // renderer 监听器就绪信号（主进程就绪前推送的会在队列里重放）
  ready: () => ipcRenderer.send('pet:ready'),
  // 拖拽导入：File 对象 → 磁盘路径（Electron 32+ 需经 webUtils 转换）
  getPathForFile: (file) => webUtils.getPathForFile(file),
  dropImport: (paths) => ipcRenderer.send('skins:drop-import', paths),
  // 自绘右键菜单
  getMenuData: () => ipcRenderer.invoke('menu:load'),
  menuAction: (id) => ipcRenderer.send('menu:action', id),
  openMenuAt: (x, y) => ipcRenderer.send('menu:open-at', x, y),
  menuResize: (width, height) => ipcRenderer.send('menu:resize', width, height),
  menuFontSet: (size) => ipcRenderer.send('menu:font-set', size),
  onMenuFont: (callback) => {
    ipcRenderer.on('menu:font', (_event, size) => callback(size));
  },
  // 窗口标题单一真源（票 11-A）：identity.WINDOW_TITLE 经主进程注入，pet.html 不写死 <title>
  getWindowTitle: () => ipcRenderer.invoke('pet:window-title'),
});
