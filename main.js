const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, session, shell, Tray } = require('electron');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const identity = require('./identity');
const koffi = require('koffi');
const { startKeylistener, stopKeylistener } = require('./keylistener');
const { menuLayout } = require('./menu-layout');
const skins = require('./skins');
const gamepadX = require('./gamepad-xinput');
const walk = require('./walk');
const LINES = require('./lines');

// 卡死/崩溃现场日志：打包版没有控制台，出问题时靠这个文件定位。
// 写在自己数据目录里（启动时已验证可写，且用户找得到）；dev 下同时打到 stderr。
// 不用 %TEMP%：实测那里写入会静默失败，而打包版失败就等于完全没有日志。
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(config.DATA_DIR, identity.LOG_NAME), line + '\n');
  } catch {
    // 日志失败不影响主流程
  }
}

// 退出收尾用：计时器句柄统一登记，quitting 用来止住自恢复逻辑与退出流程互相打架
const timers = [];
let quitting = false;
let recovering = false;

// 测试接缝：独立 userData 可与正式实例并行跑（CDP 自动化/多开调试），不影响单实例锁语义
if (process.env.PET_USER_DATA_DIR) {
  app.setPath('userData', process.env.PET_USER_DATA_DIR);
}

// F1 桌宠窗：固定 600×600（= 基准 300 × 缩放上限 2）、透明、无边框、置顶、不进任务栏
const PET_SIZE = { width: 300, height: 300 };
const SCREEN_MARGIN = 20;

// 桌宠整体缩放（1.0.30 引入；1.0.31 Ctrl+拖拽，1.0.39 起 Ctrl 手柄拖动）：1.0.51 前窗口尺寸 =
// 基准 × scale；1.0.52 起窗口固定 600×600、scale 只驱动渲染端 transform（见 PET_WINDOW_SIZE）。
// clamp 上限 2.0（再大形象超出典型工作区高度一半以上，且固定窗尺寸随上限翻倍）、下限 0.5（再小点不中）。
const PET_SCALE_MIN = 0.5;
const PET_SCALE_MAX = 2;

// 桌宠窗固定尺寸（1.0.52）：透明窗每次 setBounds（改尺寸/挪原点）都会让 OS 把陈旧帧先拉伸/
// 错位显示 1~2 帧再回弹——1.0.51 的右下角锚定使每步缩放都挪原点，放大缩小全程抽搐。窗口从此
// 不再随缩放变，缩放 = 纯 CSS transform（#pet-root 钉窗口右下角 + origin 右下），拖拽全程零原生操作。
// 改 PET_SCALE_MAX 时这里必须跟着改（固定窗必须装得下上限缩放）
const PET_WINDOW_SIZE = { width: 600, height: 600 };

function petScale() {
  const v = Number(config.get('petScale'));
  return Number.isFinite(v) ? Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, v)) : 1;
}

// 桌宠窗口尺寸：固定 600×600（1.0.52 起与 petScale 无关）。所有「窗口有多大」语义的地方
// （初始定位/走过去落点换算/建窗）都用它；「桌宠视觉有多大」用 visualSize()
function petSize() {
  return { ...PET_WINDOW_SIZE };
}

// 桌宠视觉尺寸（基准 × scale）：视觉矩形右下角 == 窗口右下角（#pet-root 钉窗口右下角 +
// transform-origin 右下），所以视觉矩形 = 窗口矩形左/上各内收 offset。「桌宠看得见/避让」
// 的判据要用视觉矩形——整窗判据会让桌宠在 scale<2 时永远靠不近屏幕左/上边缘
function visualSize(s) {
  return { width: Math.round(PET_SIZE.width * s), height: Math.round(PET_SIZE.height * s) };
}

// 视觉矩形相对窗口矩形的左/上内收量（右下角对齐）
function petVisualOffset(s) {
  return PET_WINDOW_SIZE.width - Math.round(PET_SIZE.width * s);
}

// 桌宠视觉矩形（屏幕坐标）：origin 是窗口原点
function petVisualRect(origin, s) {
  const off = petVisualOffset(s);
  const size = visualSize(s);
  return { x: origin.x + off, y: origin.y + off, width: size.width, height: size.height };
}

// 桌宠「可见内容」矩形（1.0.64 判据收紧）：300×300 视觉矩形顶部是 ~154px 的气泡预留位
// （说话气泡/💤，平时不可见），按视觉矩形做贴边判据会让脸永远贴不到屏幕上缘。摆放类判据
// （贴边回挪/拖拽钳制/走过去/让开/缩放回挪）改用内容矩形：底边与视觉矩形齐平（脸 110 +
// 底行 ~30 + padding 6 ≈ 146，留 💤 溢出余量取 160），宽度保持全宽（底行计数 pill 是最宽
// 可见物，左右语义不变）。命中/避让/兜底盒仍是视觉矩形口径（layoutMenu/petCovered/
// petFallbackBox 各自已按票校准，不随动）。贴顶说话时气泡被屏幕上缘裁一块，属接受代价。
const PET_CONTENT_HEIGHT = 160;
function contentSize(s) {
  return { width: visualSize(s).width, height: Math.round(PET_CONTENT_HEIGHT * s) };
}
function petContentOffset(s) {
  return {
    x: PET_WINDOW_SIZE.width - contentSize(s).width,
    y: PET_WINDOW_SIZE.height - contentSize(s).height,
  };
}
function petContentRect(origin, s) {
  const off = petContentOffset(s);
  const size = contentSize(s);
  return { x: origin.x + off.x, y: origin.y + off.y, width: size.width, height: size.height };
}

// F5/F8 每日计数存储：内存累计，有变更每 5 秒落盘，退出前强制写
const STORE_VERSION = 1;
let dayRecord = null;
let dirty = false;

// F3 打瞌睡状态
let lastActivity = Date.now();
let isSleeping = false;

// F3 手速触发：3 秒滚动窗口
let keyTimestamps = [];
let lastWowAt = 0;

// F4 久坐提醒计时器（M6 菜单改间隔/开关时经 restartReminder 重排）
let reminderTimer = null;

let petWindow = null;

// 是否以管理员权限运行：bootApp 里 fltmc 探测的结果（异步），经 pushPetConfig 喂给底部指示灯
let isAdmin = false;

// 单实例：重复启动（含计划任务自启与手动启动叠加）时只保留第一只。
// 「以管理员重启」场景：新实例要等 UAC 确认后才起，旧实例收到 second-instance 且正处于
// 提权重启流程时立即让位；新实例侧 400ms 重试抢锁，覆盖旧实例尚未退完的窗口期
let adminRelaunchPending = false;
let lockAcquired = !!app.requestSingleInstanceLock();
// second-instance 最近一拍（含去抖忽略拍）的时间：1.0.71 显隐请求哨兵的去重基准——
// 声明在顶层是因为 bootApp（顶层函数，两个调用点都在抢到锁之后）里的哨兵处理也要读它；
// second-instance 处理器在 if (lockAcquired) 块内，词法上看得见顶层 let。
let lastSecondInstanceAt = 0;

// ---- 开机自启的 argv 标记（1.0.32 起管理员自启不走任务计划，见 setAdminAutostart）----
// 判定逻辑抽在 autostart-elevation.js（纯函数，verify 直接 require 测真函数）
const { AUTOSTART_ARG, ELEVATED_AUTOSTART_ARG, shouldRequestElevationOnBoot } = require('./autostart-elevation');
// Run 键读回/StartupApproved 解析的纯逻辑件（票 11-C 1a / 11-D 1a 抽出）。旧键匹配
// pickLegacyRunEntries 已随票 11-Q 退休（④：自启旧值名清理段撤除），件内只剩活路径三函数。
const { findRunEntry, commandImageBasename, isStartupApprovedEnabled } = require('./autostart-migration');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayFilePath(date) {
  return path.join(config.DATA_DIR, `keys-${date}.json`);
}

function emptyDayRecord(date) {
  return {
    v: STORE_VERSION,
    date,
    total: 0,
    keys: {},
    mouse: { left: 0, right: 0, middle: 0 },
    gamepad: {},
  };
}

function loadDayRecord(date) {
  const file = dayFilePath(date);
  const raw = readTextOrNull(file);
  const rec = parseDayRecord(raw, date);
  if (rec) {
    // 会话开始时的完好快照留一份 .bak：主文件之后若被外部原因写坏，还能自动恢复
    if (raw) writeFileAtomic(file + '.bak', raw);
    return rec;
  }
  // 主文件在但读不出来：绝不当作「今天从零开始」直接覆盖（那等于把当天数据抹掉、
  // 而历史天数的文件不受影响——正是「覆盖安装后当天数据没了、历史还在」的形态）。
  // 先把现场挪到 .bad 保住，再试 .bak 恢复。
  if (raw) {
    try {
      fs.renameSync(file, file + '.bad');
      logLine(`当日计数文件损坏，已备份为 ${path.basename(file)}.bad`);
      pushBubble('统计数据读取异常，已备份原文件', 5000);
    } catch (err) {
      logLine('备份损坏文件失败: ' + err.message);
    }
  }
  const bak = parseDayRecord(readTextOrNull(file + '.bak'), date);
  if (bak) {
    logLine('当日计数已从 .bak 恢复');
    return bak;
  }
  return emptyDayRecord(date);
}

function parseDayRecord(raw, date) {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (rec && rec.v === STORE_VERSION && rec.date === date) {
      rec.keys = rec.keys || {};
      rec.mouse = Object.assign({ left: 0, right: 0, middle: 0 }, rec.mouse);
      rec.gamepad = rec.gamepad || {};
      return rec;
    }
  } catch {
    // 交给调用方决定怎么处理
  }
  return null;
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// 原子写：先写同目录临时文件再 rename。安装程序覆盖安装前会强制结束正在运行的实例，
// 若正巧卡在 writeFileSync 中间，直接写会把 JSON 截断（下次启动就成了「坏文件」）
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// 跨天（或首次启动）切换到当日的记录；当日已有文件则续记
function rollDateIfNeeded() {
  const today = todayStr();
  if (dayRecord && dayRecord.date === today) return;
  dayRecord = loadDayRecord(today);
}

function bumpKey(name) {
  rollDateIfNeeded();
  dayRecord.keys[name] = (dayRecord.keys[name] || 0) + 1;
  dayRecord.total += 1; // total 仅统计击键（§8：脚下 N 与 JSON total 一致）
  dirty = true;
  scheduleCounterPush();
  detectFastTyping();
  checkRescueHotkey(name);
}

// 救援热键：连着按下 Ctrl、Alt、P（顺序不限、中间不能插别的键）→ 强制桌宠恢复可交互并弹出菜单。
// 用途：穿透状态万一卡成「点不到、齿轮也点不开」时，不必去任务管理器结束进程。
// 用「最近三个按键的序列」判定，这样不需要 keyup 事件（钩子只给了 keydown）；正常打字几乎撞不上。
const recentKeys = [];
const isCtrlKey = (k) => k === 'Ctrl' || k === 'CtrlRight';
const isAltKey = (k) => k === 'Alt' || k === 'AltRight';

function checkRescueHotkey(name) {
  recentKeys.push(name);
  if (recentKeys.length > 3) recentKeys.shift();
  if (recentKeys.length < 3 || recentKeys[2] !== 'P') return;
  const mods = [recentKeys[0], recentKeys[1]];
  const oneCtrl = mods.some(isCtrlKey);
  const oneAlt = mods.some(isAltKey);
  if (!oneCtrl || !oneAlt) return;
  recentKeys.length = 0;
  rescuePet();
}

function rescuePet() {
  logLine('救援热键 Ctrl+Alt+P：强制桌宠恢复可交互并弹出菜单');
  if (petPeekActive) endPetPeek('救援热键'); // 让路穿透卡在「点不到」的形态上时，救援也是它的出口
  try {
    if (petWindow && !petWindow.isDestroyed()) {
      // 主进程侧先强制一次并同步记账，再让 renderer 弹菜单
      nativeSetIgnoreMouseEvents(petWindow, false);
      petIgnoreSent = false;
      sendToPet('pet:force-interactive', true);
    }
  } catch (err) {
    logLine('救援失败: ' + err.message);
  }
}

function bumpMouse(which) {
  rollDateIfNeeded();
  dayRecord.mouse[which] += 1;
  dirty = true;
  scheduleCounterPush();
}

// 手柄按键计数（标准映射按钮名由 renderer 上报，仅按"按下"沿计数）
function bumpGamepad(names) {
  rollDateIfNeeded();
  dayRecord.gamepad = dayRecord.gamepad || {};
  for (const name of names) {
    if (typeof name !== 'string') continue;
    dayRecord.gamepad[name] = (dayRecord.gamepad[name] || 0) + 1;
  }
  dirty = true;
  scheduleCounterPush();
}

// 摇杆拨动 → 开心表情。连续拨杆会高频触发，用冷却压到和 happy 自动回 idle 的节奏一致
let lastStickHappyAt = 0;
function stickHappy() {
  const now = Date.now();
  if (now - lastStickHappyAt < 1500) return;
  lastStickHappyAt = now;
  pushState('happy');
}

function flushDayRecord() {
  if (!dayRecord || !dirty) return;
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    const file = dayFilePath(dayRecord.date);
    const json = JSON.stringify(dayRecord);
    writeFileAtomic(file, json);
    dirty = false;
  } catch (err) {
    console.error('[store] 当日计数落盘失败:', err.message);
  }
}

// 悬浮计数推送（F5：节流 200ms）
let counterPushTimer = null;
function scheduleCounterPush() {
  if (counterPushTimer) return;
  counterPushTimer = setTimeout(pushCounter, 200);
}

function counterSnapshot() {
  const m = dayRecord.mouse;
  const g = dayRecord.gamepad || {};
  return {
    keys: dayRecord.total,
    mouse: m.left + m.right + m.middle,
    gamepad: Object.values(g).reduce((s, v) => s + v, 0),
  };
}

// 页面未就绪时 send 会丢消息：renderer 完成监听注册后上报 pet:ready，主进程重放队列
let petReady = false;
let petQueue = [];

function sendToPet(channel, payload) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!petReady) {
    petQueue.push({ channel, payload });
    return;
  }
  petWindow.webContents.send(channel, payload);
}

ipcMain.on('pet:ready', () => {
  petReady = true;
  const queue = petQueue;
  petQueue = [];
  for (const item of queue) sendToPet(item.channel, item.payload);
  // 页面重载（渲染进程崩溃自恢复）后状态回到 idle：还在走就补一次移动状态
  if (walkPlan) sendToPet('pet:walk', { active: true, direction: walkPlan.direction });
});

// 窗口标题单一真源（票 11-A）：pet.html 不写死 <title>，由渲染端启动时经此取
// identity.WINDOW_TITLE（preload 在 sandbox 下不能 require 本地模块，故走 IPC）
ipcMain.handle('pet:window-title', () => identity.WINDOW_TITLE);

function pushCounter() {
  counterPushTimer = null;
  if (!dayRecord) return;
  sendToPet('pet:counter', counterSnapshot());
}

// ---- F3 交互：活动、打瞌睡、说话气泡、手速 ----

// 键盘/鼠标（mousemove 已在 keylistener 节流 1s）都刷新 lastActivity；睡眠中任意活动立刻醒
function onActivity() {
  lastActivity = Date.now();
  if (isSleeping) {
    isSleeping = false;
    pushState('idle');
  }
}

function checkSleep() {
  if (isSleeping) return;
  const sleepAfterMin = config.get('sleepAfterMin');
  if (sleepAfterMin > 0 && Date.now() - lastActivity >= sleepAfterMin * 60000) {
    isSleeping = true;
    pushState('sleep');
  }
}

// 页面未加载完成时 send 会丢消息（启动恢复路径会踩到），挂到加载完成后再发
function sendWhenLoaded(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    });
  } else {
    wc.send(channel, payload);
  }
}

function pushState(state) {
  sendToPet('pet:state', state);
}

function pushBubble(text, durationMs, state) {
  sendToPet('pet:show-bubble', { text, durationMs, state });
}

function randomLine() {
  return LINES[Math.floor(Math.random() * LINES.length)];
}

// F3 说话气泡：随机间隔 5~15 分钟抽一条，显示 4.5s
function scheduleSpeech() {
  setTimeout(() => {
    pushBubble(randomLine(), 4500);
    scheduleSpeech();
  }, (5 + Math.random() * 10) * 60000);
}

// F3 手速触发：3 秒滚动窗口击键 ≥24 且距上次触发 >60s → wow + 气泡
function detectFastTyping() {
  const now = Date.now();
  keyTimestamps.push(now);
  while (keyTimestamps.length && now - keyTimestamps[0] > 3000) keyTimestamps.shift();
  if (keyTimestamps.length >= 24 && now - lastWowAt > 60000) {
    lastWowAt = now;
    keyTimestamps = [];
    pushBubble('手速好快！', 2000, 'wow');
  }
}

// F4 久坐提醒：每 reminderIntervalMin 触发一次，显示 6s；
// 键鼠活动不重置计时器（久坐本就指持续工作）。
// 1.0.53 起同时弹 Windows 系统通知（reminderNotifyWindows，默认开）：桌宠隐藏/被全屏
// 应用遮挡时气泡看不见，toast 是唯一触达途径；点通知把桌宠叫回来
function restartReminder() {
  clearTimeout(reminderTimer);
  const intervalMin = config.get('reminderIntervalMin') || 45;
  reminderTimer = setTimeout(() => {
    if (config.get('reminderEnabled')) {
      pushBubble('起来动一动，喝口水💧', 6000, 'remind');
      if (config.get('reminderNotifyWindows')) sendReminderWindowsNotification();
    }
    restartReminder();
  }, intervalMin * 60000);
}

function sendReminderWindowsNotification() {
  try {
    if (!Notification.isSupported()) {
      logLine('Windows 通知：当前环境不支持（Notification.isSupported=false），只发气泡');
      return;
    }
    const n = new Notification({
      title: identity.PRODUCT_NAME + ' · 久坐提醒',
      body: '起来动一动，喝口水💧（点我显示桌宠）',
    });
    n.on('click', () => {
      if (petHidden) showPet();
    });
    n.on('failed', (_e, error) => logLine(`Windows 通知弹出不成功: ${error || '未知原因'}`));
    n.show();
  } catch (err) {
    logLine(`Windows 通知异常: ${err.message}`);
  }
}

// ---- F6 右键菜单（自绘 HTML 菜单窗口，字号可调）----

let menuWindow = null;
let lastMenuCloseAt = 0; // 菜单最近一次关闭时刻：齿轮 toggle 用它区分「点齿轮导致的 blur 关闭」与「早已关闭」

function buildMenuState() {
  const interval = config.get('reminderIntervalMin');
  const skinName = config.get('skinName') || 'emoji';
  return {
    fontSize: config.get('menuFontSize') || 14,
    items: [
      { id: 'open-stats', label: '打开统计面板' },
      {
        id: 'toggle-dblclick-stats',
        label: '双击桌宠打开统计面板',
        type: 'checkbox',
        checked: !!config.get('dblclickStats'),
      },
      {
        id: 'toggle-walk',
        label: 'Ctrl+三击让桌宠走过来',
        type: 'checkbox',
        checked: !!config.get('walkByTripleClick'),
      },
      {
        id: 'toggle-cursor-flee',
        label: '鼠标停留 5 秒自动让开',
        type: 'checkbox',
        checked: !!config.get('cursorFleeEnabled'),
      },
      { id: 'reset-scale', label: '恢复默认大小' },
      { id: 'hide-pet', label: '隐藏桌宠（只留托盘图标）' },
      { sep: true },
      { id: 'toggle-reminder', label: '久坐提醒', type: 'checkbox', checked: !!config.get('reminderEnabled') },
      {
        id: 'toggle-reminder-notify',
        label: '提醒同时发 Windows 通知',
        type: 'checkbox',
        checked: !!config.get('reminderNotifyWindows'),
      },
      {
        id: 'interval',
        label: '提醒间隔',
        submenu: [30, 45, 60, 90].map((m) => ({
          id: `interval-${m}`,
          label: `${m} 分钟`,
          type: 'radio',
          checked: interval === m,
        })),
      },
      {
        id: 'skins',
        label: '皮肤',
        submenu: [
          { id: 'skin-emoji', label: 'Emoji 默认', type: 'radio', checked: skinName === 'emoji' },
          ...skins.listSkins().map((name) => ({
            id: `skin-${name}`,
            label: name,
            type: 'radio',
            checked: skinName === name,
          })),
          { sep: true },
          { id: 'skin-import', label: '导入表情包（eif/图片/压缩包）…' },
          { id: 'skin-import-folder', label: '导入皮肤文件夹…' },
          { id: 'skin-pick', label: '挑选表情映射…' },
          { id: 'skin-open-dir', label: '打开皮肤目录' },
        ],
      },
      {
        id: 'theme',
        label: '主题',
        submenu: [
          { id: 'theme-light', label: '日间', type: 'radio', checked: (config.get('theme') || 'system') === 'light' },
          { id: 'theme-dark', label: '夜间', type: 'radio', checked: (config.get('theme') || 'system') === 'dark' },
          { id: 'theme-system', label: '跟随系统', type: 'radio', checked: (config.get('theme') || 'system') === 'system' },
        ],
      },
      { sep: true },
      {
        id: 'autostart',
        label: '开机自启',
        // 父项纯导航：点它只展开子菜单（1.0.41），开关职责移交给子菜单三项。
        // 勾选态 = config.autoStart（应用内意图）∧ 任务管理器未禁用（StartupApproved 系统事实，
        // 票 11-F 裁决①：用户在任务管理器禁用 = 意图不自启，UI 必须反映）——被禁用时视同
        // 「关闭」（三项互斥设计不变）。**不读 getLoginItemSettings**：票 11-D 实测该读数与
        // 注册表地面真相可能矛盾；StartupApproved 读数由 bootApp 异步预取进缓存
        // （refreshStartupApprovedState），写键动作回调里同步更新。config 与 Run 键的补齐由
        // 开机意图补齐分支保证（config=true ⟹ 键在位）；禁用状态不被启动流程复活（reg 直写
        // 不碰 StartupApproved，方案 B 的结构性保证，§75）
        submenu: (() => {
          const on = !!config.get('autoStart') && startupApprovedEnabled;
          const admin = !!config.get('autoStartAdmin');
          return [
            { id: 'autostart-off', label: '关闭', type: 'checkbox', checked: !on },
            // 两个模式项勾选以自启已开为前提——自启关着时只勾「关闭」，三项恒互斥
            {
              id: 'autostart-mode-normal',
              label: '普通模式',
              type: 'checkbox',
              checked: on && !admin,
            },
            {
              id: 'autostart-mode-admin',
              label: '管理员模式',
              type: 'checkbox',
              checked: on && admin,
            },
          ];
        })(),
      },
      { id: 'run-as-admin', label: '以管理员身份重启' },
      { sep: true },
      { id: 'quit', label: '退出' },
    ],
  };
}

const menuActions = {
  'open-stats': () => openStatsWindow(),
  'toggle-dblclick-stats': () => {
    config.set('dblclickStats', !config.get('dblclickStats'));
    pushPetConfig();
  },
  'toggle-walk': () => {
    // 纯主进程行为，渲染端不需要知道，改完不必推送配置
    config.set('walkByTripleClick', !config.get('walkByTripleClick'));
    if (!config.get('walkByTripleClick')) stopWalk('菜单关闭');
  },
  'toggle-cursor-flee': () => {
    config.set('cursorFleeEnabled', !config.get('cursorFleeEnabled'));
    cursorOverPetSince = 0;
  },
  'hide-pet': () => hidePet(),
  'reset-scale': () => {
    // 复用缩放管线终点（钳制 + 持久化 + 推送渲染端 transform）。1.0.52 固定窗：缩放不再
    // 挪窗口，位置保持原地——桌宠在屏幕上原地缩回 1.0x，右下角不动
    if (petScale() === 1) {
      pushBubble('桌宠已是默认大小', 4500);
      return;
    }
    applyPetScale(1, true);
    pushBubble('桌宠已恢复默认大小', 4500);
  },
  'toggle-reminder': () => {
    config.set('reminderEnabled', !config.get('reminderEnabled'));
    restartReminder();
  },
  'toggle-reminder-notify': () => {
    config.set('reminderNotifyWindows', !config.get('reminderNotifyWindows'));
  },
  'autostart-off': () => {
    // 已关再点无副作用；勾选态与开关判定都以 config.autoStart 为准（意图真源，见 buildMenuState
    // 注释）——原 getLoginItemSettings 读数在覆盖安装场景有假阴性，用它当判据会吞掉「关闭」点击。
    // 1.0.55 起 Run 键 reg 直写（票 11-F 方案 B），dev 下 writeRunValue/deleteRunValue 有守卫
    if (!config.get('autoStart')) return;
    deleteRunValue((err) => {
      if (err) logLine('开机自启关闭失败（Run 键删除）: ' + err.message);
    });
    // 顺手删 StartupApproved 条目：Run 值没了，残留条目只会让任务管理器数据发陈
    deleteApprovedValue();
    config.set('autoStart', false);
    // 模式位不清：它是「下次开启用哪种模式」的偏好——UAC 只在开机拉起实例时发生，
    // 自启关着时残留 true 无副作用，重开后恢复上次选的模式
    pushBubble('开机自启已关闭', 4500);
    logLine('开机自启关闭（模式偏好保留）');
  },
  'autostart-mode-normal': () => setAutoStartMode(false),
  'autostart-mode-admin': () => setAutoStartMode(true),
  'run-as-admin': () => relaunchAsAdmin(),
  quit: () => app.quit(),
  'skin-import': () => importFileDialog(),
  'skin-import-folder': () => importFolderDialog(),
  // 注意：skin- 开头的固定动作必须登记在 menuActions——runMenuAction 先查表再走 skin- 前缀分支，
  // 漏登记会把 id 当成皮肤名写进配置
  'skin-open-dir': () => {
    // 用菜单列表真正扫描的目录（skins.getSkinRoot）：dev 是项目内 assets/skins，
    // 安装版是 <数据根>\skin\——与 config.SKIN_ROOT 在 dev 下不同，别混用
    const dir = skins.getSkinRoot();
    try {
      fs.mkdirSync(dir, { recursive: true }); // 一次皮肤都没导入过时目录可能还不存在，先建再开
    } catch {
      // 建不出来就交给 openPath 报错
    }
    shell.openPath(dir).then((err) => {
      if (err) pushBubble('打开皮肤目录失败：' + err, 4500);
    });
  },
  'skin-pick': () => {
    const current = config.get('skinName') || 'emoji';
    if (current !== 'emoji' && !skins.resolveSkin(current).dir) {
      pushBubble('请先「导入表情包」或拖图片/压缩包到桌宠', 4500);
      return;
    }
    openPickerWindow(current);
  },
};

function runMenuAction(id) {
  if (menuActions[id]) return menuActions[id]();
  if (id.startsWith('theme-')) {
    const theme = id.slice(6);
    if (['light', 'dark', 'system'].includes(theme)) {
      config.set('theme', theme);
      nativeTheme.themeSource = theme;
    }
    return;
  }
  if (id.startsWith('interval-')) {
    config.set('reminderIntervalMin', Number(id.slice(9)));
    restartReminder();
    return;
  }
  if (id.startsWith('skin-')) {
    const name = id.slice(5);
    config.set('skinName', name);
    pushSkin();
    if (name !== 'emoji' && skins.resolveSkin(name).type !== 'image') {
      pushBubble('该皮肤还没分配图片：点「挑选表情映射…」选图', 4500);
    }
  }
}

function closeMenuWindow() {
  lastMenuCloseAt = Date.now();
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.close();
}

// 以管理员身份重启：唯一的管理员权限路径（管理员运行的游戏里要让键鼠计数，就整体提权运行）。
// 用原生 ShellExecuteW('runas') 提权（与右键「以管理员身份运行」同一机制）——
// 之前的 PowerShell -EncodedCommand 方案在你机器上子进程被安全软件静默拦截（连日志都没写）。
// 旧实例不直接退出：等提权的新实例抢锁触发 second-instance 后让位；UAC 取消时回退普通启动
function relaunchAsAdmin() {
  adminRelaunchPending = true;
  const logFile = path.join(app.getPath('temp'), identity.ADMIN_LOG_NAME);
  const log = (msg) => {
    try {
      fs.appendFileSync(logFile, msg + '\n');
    } catch {
      // 日志失败不影响主流程
    }
  };
  try {
    const shell32 = koffi.load('shell32.dll');
    const ShellExecuteW = shell32.func('ShellExecuteW', 'int', [
      'int64',
      'str16',
      'str16',
      'str16',
      'str16',
      'int32',
    ]);
    // --elevated-autostart：提权产物实例的标记，见到就不再发起提权（防循环弹 UAC）；
    // dev 模式 exe 是 electron.exe，还要带应用路径参数
    const params = app.isPackaged
      ? ELEVATED_AUTOSTART_ARG
      : `${ELEVATED_AUTOSTART_ARG} "${app.getAppPath()}"`;
    log('requested ' + new Date().toLocaleTimeString());
    const code = ShellExecuteW(0, 'runas', process.execPath, params, null, 1);
    if (code > 32) {
      log('OK shell launched');
      pushBubble('正在请求管理员权限，请在 UAC 弹窗中确认', 4500);
      // 兜底：60s 内交接没完成就恢复正常 second-instance 行为
      setTimeout(() => {
        adminRelaunchPending = false;
      }, 60000);
    } else {
      adminRelaunchPending = false;
      // 5=SE_ERR_ACCESSDENIED（UAC 被取消）
      log('FAILED code=' + code);
      pushBubble('管理员重启未完成（代码 ' + code + '，5=取消了 UAC）', 5000);
    }
  } catch (err) {
    adminRelaunchPending = false;
    log('ERROR ' + err.message);
    pushBubble('管理员重启失败：' + err.message, 5000);
  }
}

// ---- 开机自启模式：普通 / 管理员（1.0.38 菜单收敛，提权机制沿袭 1.0.32）----
// 1.0.30/1.0.31 走的是任务计划程序（/sc onlogon /rl highest）——无人值守提权自启的技术上唯一
// 官方正路，但用户明确不想在系统里留计划任务。1.0.32 起改为折衷：普通自启（Run 键）+ 开机拉起
// 的普通实例经 ShellExecuteW('runas') 拉起提权自身，**每次开机弹一次 UAC**；取消则降级为普通
// 权限继续跑（桌宠照常出现）。提权请求复用 relaunchAsAdmin（单实例锁交接 + UAC 取消回退都现成）。
// 1.0.38 菜单从两个平铺 checkbox 收敛为「开机自启 › 普通模式/管理员模式」，config.autoStartAdmin
// 语义随之从「修饰位勾选」细化为「自启模式偏好」：false=普通（默认）、true=管理员，与自启开/关
// 解耦——关着时它只记录下次开启用哪种模式，点模式项即以该模式开启自启。
function setAutoStartMode(admin) {
  // wasOff 以 config.autoStart（意图真源）判定，不读 getLoginItemSettings（11-D 假阴性风险）
  const wasOff = !config.get('autoStart');
  config.set('autoStartAdmin', admin);
  // 点模式项 = 以该模式开启/保持自启：无论此前开没开，Run 键都重写一次——
  // 意图开启时顺带兜底（键被外部误删的场景下点一下模式即补齐）。
  // 1.0.55 起 reg 直写（票 11-F 方案 B）。这是本应用内的**显式启用**动作：若用户此前在
  // 任务管理器禁用过（StartupApproved 有标志），此处清掉它——菜单的「开」覆盖系统层的旧禁用
  // 是语义正确的（与 bootApp 自动路径「不碰禁用」相区分，那是裁决①的另一半）。
  writeRunValue((err) => {
    if (err) logLine('开机自启开启失败（Run 键写入）: ' + err.message);
  });
  deleteApprovedValue();
  startupApprovedEnabled = true; // 写键回调前菜单若先开，按写入后的状态呈现
  config.set('autoStart', true);
  logLine(
    `开机自启：${admin ? '管理员模式（下次开机将请求管理员权限，弹一次 UAC）' : '普通模式'}${
      wasOff ? '（自启此前未开，已一并开启）' : ''
    }`
  );
  pushBubble(
    (admin ? '开机自启：管理员模式（开机将弹一次 UAC）' : '开机自启：普通模式') + (wasOff ? '，已一并开启' : ''),
    4500
  );
}

// 在屏幕 (x,y)（齿轮按钮的屏幕坐标）附近弹出菜单窗口。
// 布局规则：①窗口按内容自适应（渲染端 menu:resize 上报），②矩形不与桌宠重叠，
// ③始终完整落在所在显示器的工作区内（四边钳制，不跑出桌面边框外）。
let menuAnchor = { x: 0, y: 0 }; // 齿轮按钮的屏幕坐标，resize 重排时复用
let menuShowTimer = null;

function layoutMenu(anchorX, anchorY, W, H) {
  const disp = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY }) || screen.getPrimaryDisplay();
  // 避让判据用桌宠视觉矩形而不是整窗：固定窗比视觉大 (600-300s)，按整窗避让会把菜单推离桌宠
  let petB = null;
  if (petWindow && !petWindow.isDestroyed()) {
    const b = petWindow.getBounds();
    petB = petVisualRect({ x: b.x, y: b.y }, petScale());
  }
  // 几何规则在 menu-layout.js（纯函数，可单测）
  return menuLayout({ anchorX, anchorY, W, H, workArea: disp.workArea, petBounds: petB });
}

function openMenuWindow(x, y) {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
  menuAnchor = { x: Number(x) || 0, y: Number(y) || 0 };
  const W = 250;
  const H = 480; // 占位估高：真实尺寸由渲染端 menu:resize 上报后重排
  const pos = layoutMenu(menuAnchor.x, menuAnchor.y, W, H);
  menuWindow = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: W,
    height: H,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  menuWindow.loadFile(path.join(__dirname, 'renderer', 'menu.html'));
  // 不在 ready-to-show 就 show：等渲染端上报真实尺寸重排后再显示，
  // 避免用户看到「先 480 高、再缩到内容高」的跳动；600ms 兜底防渲染端异常时菜单永不出现
  menuShowTimer = setTimeout(() => {
    if (menuWindow && !menuWindow.isDestroyed()) menuWindow.show();
  }, 600);
  menuWindow.on('blur', closeMenuWindow);
  menuWindow.on('closed', () => {
    if (menuShowTimer) { clearTimeout(menuShowTimer); menuShowTimer = null; }
    menuWindow = null;
  });
}

// ---- F2 换皮：皮肤推送、导入（菜单/拖拽）、picker 窗口 ----

function skinPayload() {
  const name = config.get('skinName') || 'emoji';
  if (name === 'emoji') {
    // 内置 emoji 皮肤：帧来自 emoji-skin.json 的字符映射（未映射的状态由 renderer 回退默认）
    return { type: 'emoji', frames: skins.resolveSkin('emoji').frames, name };
  }
  const resolved = skins.resolveSkin(name);
  if (resolved.type === 'image') {
    const frames = {};
    for (const [state, file] of Object.entries(resolved.frames)) {
      frames[state] = pathToFileURL(path.join(resolved.dir, file)).href;
    }
    return { type: 'image', frames, name };
  }
  return { type: 'emoji', frames: {}, name: 'emoji' };
}

function pushSkin() {
  sendToPet('pet:skin', skinPayload());
}

// 桌宠行为开关推送（pet:ready 前推送会排队重放）
function pushPetConfig() {
  // ctrlDown 随快照走：页面重载时主进程不会重发 pet:ctrl（只在状态翻转时推），
  // 渲染端据此恢复手柄显隐（按住 Ctrl 时恰好页面重载的边角）
  sendToPet('pet:config', {
    dblclickStats: !!config.get('dblclickStats'),
    isAdmin,
    petScale: petScale(),
    ctrlDown: petCtrlState.left || petCtrlState.right,
  });
}

// ---- Ctrl 按住状态跟踪（1.0.39 缩放手柄显隐）----
// 全局钩子看得见左右 Ctrl 的按下/抬起，任一按住即算按住。只在状态翻转时推 pet:ctrl
// （keydown 自动重复会连发，靠 sent 去重）；页面未就绪时经 petQueue 重放，顺序即终态。
const petCtrlState = { left: false, right: false, sent: false };

function pushPetCtrlState() {
  const isDown = petCtrlState.left || petCtrlState.right;
  if (isDown === petCtrlState.sent) return;
  petCtrlState.sent = isDown;
  sendToPet('pet:ctrl', { down: isDown });
}

function trackPetCtrl(name, down) {
  if (name === 'Ctrl') petCtrlState.left = down;
  else if (name === 'CtrlRight') petCtrlState.right = down;
  else return;
  pushPetCtrlState();
}

// 真值对账（2026-10-06 用户反馈：没按 Ctrl 手柄也出现，重启才消）：显隐只信钩子推的这条
// 状态，而低级钩子会丢事件——keydown 之后 keyup 恰逢主进程忙/系统输入风暴被丢弃，
// petCtrlState 就永久闩在「按住」，没有任何机制纠正，只能重启。这里每 2s 用
// GetAsyncKeyState(VK_CONTROL) 读系统异步键表真值对账：连续两次不一致才纠正（防瞬时误读
// 造成手柄闪烁）。VK_CONTROL 聚合左右 Ctrl，与显隐「任一按住即算」的语义同口径；
// 它含其他进程合成输入，与计数的一致性不受影响（计数仍走钩子，这里只修显隐漂移）。
let ctrlKeyProbe = null; // 懒建：user32!GetAsyncKeyState，koffi/钩子环境异常时静默放弃对账
let ctrlDriftStreak = 0;

function reconcileCtrlState() {
  if (!ctrlKeyProbe) {
    try {
      ctrlKeyProbe = koffi.load('user32.dll').func('GetAsyncKeyState', 'int16', ['int32']);
    } catch {
      ctrlKeyProbe = null;
      return;
    }
  }
  let real;
  try {
    real = (ctrlKeyProbe(0x11) & 0x8000) !== 0; // 高位 = 当前物理/合成按下
  } catch {
    return;
  }
  const tracked = petCtrlState.left || petCtrlState.right;
  if (real === tracked) {
    ctrlDriftStreak = 0;
    return;
  }
  ctrlDriftStreak += 1;
  if (ctrlDriftStreak < 2) return; // 单次不一致可能是瞬时读数，连续两拍才动
  ctrlDriftStreak = 0;
  if (real) {
    petCtrlState.left = true; // 丢了 keydown（罕见）：记左侧按住，显隐语义等价
  } else {
    petCtrlState.left = false; // 丢了 keyup（用户报的形态）：双侧清零
    petCtrlState.right = false;
  }
  logLine(`Ctrl 状态对账：钩子推断${tracked ? '按住' : '松开'} ≠ 系统真值${real ? '按住' : '松开'}，已按真值纠正（全局钩子丢事件自愈）`);
  pushPetCtrlState();
}

// Windows 上文件/文件夹选择器不能合并（openDirectory 会独占对话框），拆两个入口：
// 文件版（eif/图片/压缩包，可多选）+ 文件夹版；处理都走 runSkinImport 统一管线
async function importFileDialog() {
  const res = await dialog.showOpenDialog(petWindow, {
    title: '导入表情包（eif / 图片 / 压缩包）',
    filters: [
      {
        name: '表情包与图片',
        extensions: ['eif', 'zip', '7z', 'rar', 'cbz', 'cbr', 'tar', 'tgz', 'tar.gz', 'tar.bz2', 'tar.xz', 'png', 'gif', 'jpg', 'jpeg', 'webp', 'avif'],
      },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return;
  runSkinImport(res.filePaths);
}

async function importFolderDialog() {
  const res = await dialog.showOpenDialog(petWindow, {
    title: '导入皮肤文件夹（递归收集里面的图片）',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return;
  runSkinImport(res.filePaths);
}

let pickerWindow = null;

function openPickerWindow(skinName) {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.focus();
    return;
  }
  pickerWindow = new BrowserWindow({
    width: 540,
    height: 680,
    backgroundColor: '#1e1f24',
    title: '挑选表情 · ' + skinName,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  pickerWindow.loadFile(path.join(__dirname, 'renderer', 'skin-picker.html'), {
    query: { skin: skinName },
  });
  pickerWindow.on('closed', () => {
    pickerWindow = null;
  });
}

// ---- 窗口 ----

let statsWindow = null;

// F7 统计面板：520×640 普通窗口，单实例（已开则聚焦）
function openStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.focus();
    return;
  }
  statsWindow = new BrowserWindow({
    width: 520,
    height: 640,
    backgroundColor: '#1e1f24',
    title: '击键统计',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  statsWindow.loadFile(path.join(__dirname, 'renderer', 'stats.html'));
  statsWindow.on('closed', () => {
    statsWindow = null;
  });
}

function petDefaultPosition(workArea) {
  const size = petSize();
  return {
    x: workArea.x + workArea.width - size.width - SCREEN_MARGIN,
    y: workArea.y + workArea.height - size.height - SCREEN_MARGIN,
  };
}

// 位置校验与「走过去」落点都用「目标点所在那块显示器」的工作区：以前只认主屏，
// 把桌宠拖到副屏后重启会被判成「出屏」而弹回主屏右下角
function workAreaNearPoint(p) {
  try {
    return screen.getDisplayNearestPoint(p).workArea;
  } catch {
    return screen.getPrimaryDisplay().workArea;
  }
}

// 票 11-K 真因修正（方案 1，2026-10-05）：「拖出屏自愈」的出屏判据原来零容差——桌宠贴屏边停时
// 窗口悬出即被判出屏、重建后弹回主屏右下角。阈值不能拍常数：实测贴右缘停靠悬出 100~134px
//（拖拽光标先顶到屏幕边缘，悬出量由抓握点几何决定），故阈值取「半幅」——悬出超过半幅
//（大半不可见）才算「大幅出屏」走自愈归位；半幅内视为「贴边」，最小位移钳回屏内。
// 半幅量测基准 1.0.64 起从视觉矩形收紧为内容矩形（顶部气泡预留位不算桌宠本体，脸贴得到上缘）。
// 返回 state：'ok' 完整在屏内 / 'nudge' 贴边可钳 / 'out' 大幅出界。
function petEdgeState(origin, wa) {
  const vis = petContentRect(origin, petScale());
  const ox = Math.max(wa.x - vis.x, vis.x + vis.width - (wa.x + wa.width), 0);
  const oy = Math.max(wa.y - vis.y, vis.y + vis.height - (wa.y + wa.height), 0);
  if (ox <= 0 && oy <= 0) return { state: 'ok' };
  if (ox > vis.width / 2 || oy > vis.height / 2) return { state: 'out', overflow: Math.max(ox, oy) };
  const dx = ox > 0 ? (vis.x < wa.x ? ox : -ox) : 0;
  const dy = oy > 0 ? (vis.y < wa.y ? oy : -oy) : 0;
  return { state: 'nudge', overflow: Math.max(ox, oy), clamped: { x: origin.x + dx, y: origin.y + dy } };
}

// 拖拽屏幕钳制（2026-10-05 用户拍板）：桌宠不允许被移出屏幕——拖拽增量在主进程统一钳制，
// 内容矩形完整钳进「所有显示器工作区」的外包络（跨屏拖拽不受影响；单屏即钳在本屏内）。
// 走过去/让开/缩放回挪/恢复复查各自已有屏内约束，这条管住的是唯一没有边界的一路：用户拖拽。
// 钳的是内容矩形不是整窗：固定窗比内容大得多，按整窗钳会让桌宠贴不到屏幕左/上边缘；
// 1.0.64 从视觉矩形收紧为内容矩形（横向不变——底行 pill 仍齐窗口右缘，纵向脸能贴到上缘）。
function clampPetOriginToWorkArea(origin) {
  try {
    const was = screen.getAllDisplays().map((d) => d.workArea);
    if (!was.length) return origin;
    const s = petScale();
    const off = petContentOffset(s);
    const size = contentSize(s);
    const minX = Math.min(...was.map((w) => w.x));
    const maxX = Math.max(...was.map((w) => w.x + w.width));
    const minY = Math.min(...was.map((w) => w.y));
    const maxY = Math.max(...was.map((w) => w.y + w.height));
    return {
      x: Math.min(Math.max(origin.x, minX - off.x), maxX - size.width - off.x),
      y: Math.min(Math.max(origin.y, minY - off.y), maxY - size.height - off.y),
    };
  } catch {
    return origin;
  }
}

// petPosition 有值且「桌宠内容矩形」落在所在显示器的工作区内才恢复：完整在屏内原样返回，
// 贴边悬出 ≤ 内容半幅最小位移钳回屏内（不归位），大幅出屏才归位主屏右下角（出屏自愈；
// 拖拽已被 clampPetOriginToWorkArea 钳死，出屏只剩拓扑变化：拔屏/分辨率收缩/多屏包络缝隙）。
// 判据是内容矩形而不是整窗（1.0.64 从视觉矩形收紧）：固定窗比内容大得多，整窗判据会把
// 靠近屏幕左/上边缘的合法位置误判成出屏
function resolvePetPosition(deferSelfHeal) {
  const saved = config.get('petPosition') || {};
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
    const wa = workAreaNearPoint(saved);
    const edge = petEdgeState(saved, wa);
    if (edge.state === 'ok') return { x: saved.x, y: saved.y };
    // 判「出屏」的来源：拓扑变化（拔屏/分辨率收缩/多屏包络缝隙——拖拽已被钳制，不再产生出屏；
    // 归位自愈），或解锁/唤醒时显示器枚举竞态（票 11-K：
    // 副屏短暂缺席 → 就近屏找到主屏 → 副屏位置被误判出屏）。deferSelfHeal（仅 unlock/resume
    // 重建路径）走后者：先按保存位置建窗，归位决策推迟到延迟复查（scheduleDeferredPositionCheck），
    // 自愈语义不变、变的只是决策时机。归位不再无声，落日志（C）。
    // 贴边悬出（≤ 视觉半幅，11-K 真因修正）不算拖出屏：非 defer 路径直接钳回屏内落日志；
    // defer 路径仍推迟到复查统一决策（那时枚举已稳定，钳位依据才可靠），由复查执行回挪。
    if (edge.state === 'nudge' && !deferSelfHeal) {
      logLine(`恢复位置贴边悬出 ${edge.overflow}px（≤半幅），回挪至 ${edge.clamped.x},${edge.clamped.y}`);
      return edge.clamped;
    }
    if (deferSelfHeal) {
      scheduleDeferredPositionCheck(saved);
      return { x: saved.x, y: saved.y };
    }
    logLine(`恢复位置判出屏，归位主屏右下角：saved=${saved.x},${saved.y}，就近工作区=${wa.x},${wa.y} ${wa.width}x${wa.height}`);
  }
  return petDefaultPosition(screen.getPrimaryDisplay().workArea);
}

// 票 11-K：解锁/唤醒重建的延迟位置复查。窗口先按保存位置建（显示器缺席时 Windows 会把它钳到
// 现存屏上），等枚举稳定后再决策：保存位置合法 → setPosition 拉回；贴边悬出（≤ 内容半幅，11-K 真因
// 修正；1.0.64 起半幅按内容矩形算）→ 最小位移回挪屏内；大幅出屏（真拔屏）→ 归位默认。三种出口全部落日志。
// 触发两路：display-metrics-changed（枚举恢复，提前）+ 1.5s 超时兜底（事件不来也不死等）。
let deferredPositionCheckTimer = null;
let deferredPositionSaved = null;
function scheduleDeferredPositionCheck(saved) {
  deferredPositionSaved = saved;
  if (deferredPositionCheckTimer) return; // 同一次重建只排一个
  deferredPositionCheckTimer = setTimeout(() => runDeferredPositionCheck('超时'), 1500);
}
function runDeferredPositionCheck(why) {
  if (deferredPositionCheckTimer) clearTimeout(deferredPositionCheckTimer); // 票 11-M：提前触发走进来时撤销还没到期的旧排程，别让它稍后把新排的复查抹成无声空转
  deferredPositionCheckTimer = null;
  const saved = deferredPositionSaved;
  deferredPositionSaved = null;
  if (!saved || !petWindow || petWindow.isDestroyed()) return;
  const wa = workAreaNearPoint(saved);
  const edge = petEdgeState(saved, wa);
  if (edge.state === 'nudge') {
    const b = petWindow.getBounds();
    if (b.x !== edge.clamped.x || b.y !== edge.clamped.y) {
      petWindow.setPosition(edge.clamped.x, edge.clamped.y);
      logLine(`解锁重建位置复查（${why}）：贴边悬出 ${edge.overflow}px（≤半幅），回挪至 ${edge.clamped.x},${edge.clamped.y}`);
    }
    return;
  }
  if (edge.state === 'out') {
    const def = petDefaultPosition(screen.getPrimaryDisplay().workArea);
    logLine(`解锁重建位置复查（${why}）：保存位置 ${saved.x},${saved.y} 仍出屏（就近工作区=${wa.x},${wa.y} ${wa.width}x${wa.height}），归位主屏右下角 ${def.x},${def.y}`);
    petWindow.setPosition(def.x, def.y);
    return;
  }
  const b = petWindow.getBounds();
  if (b.x !== saved.x || b.y !== saved.y) {
    petWindow.setPosition(saved.x, saved.y);
    logLine(`解锁重建位置复查（${why}）：显示器已恢复，拉回 ${saved.x},${saved.y}`);
  }
}

// ---- 走过去：按住 Ctrl + 连续三击任意位置 → 桌宠「走」过去（逐帧推进窗口位置，不是瞬移）----
// 为什么必须带修饰键：三击在编辑器/浏览器里是系统标准的「选段」操作，游戏里也常是连点，
// 无修饰键的三击会把桌宠弄到选中内容上面，误触代价（挡住刚选中的东西）远大于收益。
const tripleClick = walk.createTripleClickDetector();

let walkTimer = null;
let walkPlan = null; // { from, to, direction, startedAt, durationMs, frames }

// 全局钩子每次鼠标按下都会走这里：先照常计数、记录互动状态，再看要不要走过去
function onGlobalMouseDown(which, detail) {
  bumpMouse(which);
  if (!detail) return;
  let dip = { x: detail.x, y: detail.y };
  try {
    // 钩子给的是物理像素，Electron 的窗口坐标是 DIP（本机缩放 100% 时两者相同）
    dip = screen.screenToDipPoint(dip) || dip;
  } catch {
    // 换算失败就按原值用，宁可在高缩放下偏一点也不要不响应
  }
  if (petWindow && !petWindow.isDestroyed()) {
    const b = petWindow.getBounds();
    const inBox = walk.cursorOverPet(b, dip, petBoxInUse());
    // 点在互动范围内 = 正在跟它互动：把「自动让开」的 5 秒计时清零（点击可以打断计时）
    if (inBox) notePetInteraction();
    // 点在互动范围外 = 上一次互动已经结束（系统钩子不发 mouseup，只能这样兜底清掉「按着」状态）
    else petPressing = false;
    const inWindow = dip.x >= b.x && dip.x <= b.x + b.width && dip.y >= b.y && dip.y <= b.y + b.height;
    if (inWindow) {
      // 点在桌宠自己身上：不触发走过去（继续走原有的连点/摸头逻辑）
      tripleClick.reset();
      return;
    }
  }
  if (which !== 'left') return;
  if (!config.get('walkByTripleClick')) {
    tripleClick.reset();
    return;
  }
  if (!detail.ctrl) {
    // 不带修饰键的点击不参与累加，否则「普通两击 + Ctrl 一击」会凑成三击
    tripleClick.reset();
    return;
  }
  if (!tripleClick.push({ x: dip.x, y: dip.y, clicks: detail.clicks })) {
    // 手势成立但被冷却挡住：记一行，免得事后分不清「没识别到」和「被冷却吃了」
    if (tripleClick.lastSuppressed) {
      logLine(`移动跳过: 距上次触发仅 ${tripleClick.lastGapMs}ms，仍在冷却内`);
    }
    return;
  }
  walkPetTo(dip);
}



// 打断移动：拖动、锁屏重建窗口、退出、新的一次触发都会走这里。
// 位置不在这里落盘（只有走完或拖动结束才记），避免半路被打断时把中途位置当真。
function stopWalk(reason) {
  if (walkTimer) {
    clearInterval(walkTimer);
    walkTimer = null;
  }
  if (!walkPlan) return;
  const plan = walkPlan;
  walkPlan = null;
  logLine(`移动中断(${reason}): 目标 ${plan.to.x},${plan.to.y}，已推进 ${plan.frames} 帧`);
}

// 落位 + 落盘（与拖拽结束一致：位置会被记住，换显示器后按新位置自愈）
function applyPetPosition(pos) {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    petWindow.setPosition(pos.x, pos.y);
  } catch (err) {
    logLine('落位失败: ' + err.message);
    return;
  }
  config.set('petPosition', { x: pos.x, y: pos.y });
}

function walkPetTo(dip) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!petWindow.isVisible()) return; // 隐藏中不移动
  // 移动中再触发：先停掉旧的，再以「当前实际位置」重新规划，不会跳回去
  stopWalk('新的一次触发');
  const wa = workAreaNearPoint(dip);
  // walk.js 的落点/钳制按「桌宠内容矩形」算（1.0.52 固定窗：内容右下角==窗口右下角，
  // 窗口原点 = 内容左上角 - 内收量；1.0.64 从视觉矩形收紧，否则走不近屏幕上缘）
  const s = petScale();
  const size = contentSize(s);
  const to = walk.computeWalkTarget(dip, wa, size); // 内容左上角
  const off = petContentOffset(s);
  const b = petWindow.getBounds();
  const from = { x: b.x, y: b.y };
  const originTo = { x: to.x - off.x, y: to.y - off.y };
  const plan = walk.planWalk(from, originTo);

  if (plan.distance < 2) {
    // 已经站在那儿了：不动画，直接落位
    applyPetPosition(originTo);
    return;
  }

  const direction = walk.walkDirection(from, originTo);
  walkPlan = { from, to: originTo, direction, startedAt: Date.now(), durationMs: plan.durationMs, frames: 0 };
  logLine(
    `走过去: 点击 ${Math.round(dip.x)},${Math.round(dip.y)} → 窗口 ${originTo.x},${originTo.y}（距离 ${plan.distance}px / 计划 ${plan.durationMs}ms / 约 ${plan.frames} 帧，朝${direction < 0 ? '左' : '右'}，判定来源=${tripleClick.lastPath}）`
  );
  sendToPet('pet:walk', { active: true, direction });
  pushBubble('我来了～', 2000);

  walkTimer = setInterval(() => {
    if (!walkPlan) return;
    if (!petWindow || petWindow.isDestroyed()) {
      stopWalk('窗口已销毁');
      return;
    }
    const t = (Date.now() - walkPlan.startedAt) / walkPlan.durationMs;
    const p = walk.stepPosition(walkPlan.from, walkPlan.to, t);
    try {
      petWindow.setPosition(p.x, p.y);
    } catch (err) {
      logLine('移动失败: ' + err.message);
      stopWalk('setPosition 失败');
      return;
    }
    walkPlan.frames += 1;
    // 窗口在动，命中区跟着动：按真实光标重算穿透（只在状态翻转时才真的下发）
    syncPetPassThrough(false);
    if (t >= 1) finishWalk();
  }, walk.WALK.frameMs);
}

function finishWalk() {
  const plan = walkPlan;
  if (!plan) return;
  if (walkTimer) {
    clearInterval(walkTimer);
    walkTimer = null;
  }
  walkPlan = null;
  applyPetPosition(plan.to);
  const elapsed = Date.now() - plan.startedAt;
  logLine(
    `移动完成: ${plan.from.x},${plan.from.y} → ${plan.to.x},${plan.to.y}，实际 ${elapsed}ms / 计划 ${plan.durationMs}ms（${plan.frames} 帧）`
  );
  sendToPet('pet:walk', { active: false, direction: plan.direction });
}

// ---- 鼠标赖在身上不走 → 自己让开（优先向下，其次左右）----
// 场景：鼠标随手停在桌宠上不动（看视频/思考），它挡住底下的东西。5 秒没离开就走开，
// 位置由 walk.planFlee 决定（必须完整落在工作区内才算走得了）。
const CURSOR_FLEE_MS = 5000;
let cursorOverPetSince = 0;
// 「正按着鼠标」= 正在互动，不触发自动让开。
// 为什么不用系统钩子数按下次数：uiohook **不派发 mouseup**（类型声明里有、运行时不发，2026-09-22 实测），
// 只按 mousedown 计数会一直卡在「按着」→ 让开被永久禁用。改用渲染端的 DOM 按下/松开（可靠），
// 钩子只负责「点在互动范围内就清零计时」这一件事。
let petPressing = false;

// 用户正在跟桌宠互动（点/拖）：让开计时清零 —— 点击可以打断计时
function notePetInteraction() {
  cursorOverPetSince = 0;
}

function fleeFromCursor(bounds, cursor) {
  const wa = workAreaNearPoint({ x: bounds.x, y: bounds.y });
  // 让开规划按内容矩形算（1.0.64 从视觉矩形收紧，与贴边/拖拽判据同口径）
  const s = petScale();
  const size = contentSize(s);
  const off = petContentOffset(s);
  const contentTL = { x: bounds.x + off.x, y: bounds.y + off.y };
  const target = walk.planFlee(contentTL, cursor, wa, size);
  if (!target) {
    logLine('让开: 下/左/右都放不下（工作区太小），保持原位');
    return;
  }
  const dirName = target.label;
  logLine(
    `鼠标停留超过 ${CURSOR_FLEE_MS / 1000}s → 向${dirName}让开 ${target.movedPx}px（光标 ${cursor.x},${cursor.y}，窗口 ${bounds.x},${bounds.y} → 视觉 ${target.x},${target.y}）`
  );
  // 复用「走过去」：传目标内容矩形的中心点，它自己会算出左上角位置
  walkPetTo({ x: target.x + size.width / 2, y: target.y + size.height / 2 });
}

function checkCursorRest() {
  if (petPeekActive) return; // 让路穿透那 2 秒本来就是在给下层让路，别再叠一次自动让开
  if (!config.get('cursorFleeEnabled')) {
    cursorOverPetSince = 0;
    return;
  }
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) {
    cursorOverPetSince = 0;
    return;
  }
  // 正在走 / 正在睡 / 刚被点过或拖过：都不算「赖着不走」
  // 正按着鼠标（点住/拖动）= 正在互动，不触发让开
  // 正按着鼠标（点住/拖动）= 正在互动，不触发让开
  if (walkPlan || isSleeping || petPressing) {
    cursorOverPetSince = 0;
    return;
  }
  const bounds = petWindow.getBounds();
  let cursor = null;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    return;
  }
  if (!walk.cursorOverPet(bounds, cursor, petBoxInUse())) {
    cursorOverPetSince = 0;
    return;
  }
  if (!cursorOverPetSince) {
    cursorOverPetSince = Date.now();
    return;
  }
  if (Date.now() - cursorOverPetSince < CURSOR_FLEE_MS) return;
  cursorOverPetSince = 0;
  fleeFromCursor(bounds, cursor);
}

// ---- 隐藏桌宠：只留托盘图标，计数/翻译照常跑 ----
// 为什么用托盘：桌宠一藏，齿轮和计数都没了，必须有窗口之外的入口把它叫回来。
// （PLAN 里「托盘图标」原属 v1 范围外，是这轮按用户要求补上的。）
let tray = null;
let petHidden = false;

const TRAY_ICON = path.join(__dirname, 'resources', 'icon.ico');

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: petHidden ? '显示桌宠' : '隐藏桌宠', click: () => (petHidden ? showPet() : hidePet()) },
    { label: '打开统计面板', click: () => openStatsWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function createTray() {
  if (tray) return;
  try {
    const image = nativeImage.createFromPath(TRAY_ICON);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip(identity.TRAY_TITLE);
    tray.setContextMenu(buildTrayMenu());
    // 左键切换显隐、右键弹菜单（Windows 上两者都能直达）
    tray.on('click', () => (petHidden ? showPet() : hidePet()));
    tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  } catch (err) {
    logLine('托盘图标创建失败: ' + err.message);
  }
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function hidePet() {
  if (!petWindow || petWindow.isDestroyed()) return;
  stopWalk('隐藏桌宠');
  petHidden = true;
  cursorOverPetSince = 0;
  closeMenuWindow(); // 菜单是独立窗口，不关掉会孤零零悬在那儿
  petWindow.hide(); // hide 不等于 close：窗口还在，计数/钩子/翻译都不受影响
  refreshTrayMenu();
  logLine('隐藏桌宠: 计数与翻译继续，入口在托盘图标（左键切换显隐 / 右键菜单）');
  logHiddenMismatch('hidePet');
}

function showPet() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petHidden = false;
  // 隐藏→显示 与「锁屏解锁」是同一类问题：窗口会与输入系统失联（样式看着可点击、点击却进不来），
  // 用户实测「隐藏再显示后点不动」。既定的彻底解法就是换一个全新 HWND —— 直接复用解锁那条重建路径
  // （它会保留位置/皮肤/计数，并把 petIgnoreSent 置空让下一轮重新下发穿透状态；新 HWND 的
  // LAYERED 由 createPetWindow 开窗即挂，方案 1，不需要在此重挂）。
  recreatePetWindow('托盘显示');
  refreshTrayMenu();
  logLine('显示桌宠（已重建窗口句柄，避免隐藏→显示后点不动）');
  logHiddenMismatch('showPet');
}

// 票 11-T：petHidden 记账与窗口实际可见性的对账日志。漂移（记账隐藏但窗口可见，或反之）会把
// 托盘左键语义反转——1.0.67 实测：隐藏时锁屏，解锁重建不重置 petHidden（旧缺口），用户随后点
// 托盘想隐藏却被当成「显示」触发了 showPet 重建，P3 实测复现。守卫堵住已知漂移源之后，这行
// 日志负责把「未来新的漂移源」暴露在日志面上，而不是静默烂掉。
function logHiddenMismatch(where) {
  try {
    if (!petWindow || petWindow.isDestroyed()) return;
    const visible = petWindow.isVisible();
    if (petHidden !== visible) return; // 记账隐藏（true）期望不可见（false）：不等即一致
    logLine(`petHidden 对账：记账${petHidden ? '隐藏' : '可见'}与窗口实际${visible ? '可见' : '不可见'}不一致（${where}）`);
  } catch {
    // 对账失败不影响主流程
  }
}

// 任务管理器／任务栏按「应用是否有可聚焦的窗口」把进程归到同一个条目下。
// 桌宠窗为了不抢游戏焦点用的是 focusable:false（Windows 侧是 WS_EX_NOACTIVATE），
// 系统因此不把它当作应用窗口，于是主进程/GPU/网络/渲染这 4 个进程在任务管理器里
// 被列成 4 条独立条目，只能一个个结束任务。实测：单独放一个 1×1 可聚焦窗口即可
// 让它们收成一条可展开的「<显示名> (5)」（显示名 = identity.PRODUCT_NAME），
// 且桌宠窗口的外观与不抢焦点行为完全不变。
// 锚点窗口必须点击穿透（否则会挡掉它那 1 像素位置的点击），并用 showInactive 显示
// （不能激活，否则开机那一下会抢走前台窗口的焦点）。
let anchorWindow = null;

function createAnchorWindow() {
  if (anchorWindow && !anchorWindow.isDestroyed()) return;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    anchorWindow = new BrowserWindow({
      x: wa.x,
      y: wa.y,
      width: 1,
      height: 1,
      show: false,
      transparent: true,
      frame: false,
      skipTaskbar: true, // 不进任务栏：分组靠窗口存在，不靠任务栏按钮
      focusable: true, // 分组的关键：必须可聚焦，否则系统不认这个「应用」
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: false,
      webPreferences: { backgroundThrottling: true },
    });
    anchorWindow.setIgnoreMouseEvents(true);
    // 必须让窗口真的看不见：about:blank 是白底，透明窗口会把它当成不透明内容画出来
    //（之前桌面左上角那个白方块就是这个），所以内容背景也设成透明，再叠一层不透明度 0 兜底
    anchorWindow.setBackgroundColor('#00000000');
    anchorWindow.loadURL('data:text/html;charset=utf-8,<style>html,body{margin:0;background:transparent}</style>');
    anchorWindow.setOpacity(0);
    anchorWindow.showInactive();
    logHwnd(anchorWindow, '锚点窗口');
    // ★ 锚点窗不能再补 WS_EX_TOOLWINDOW（1.0.27 曾补，1.0.30 摘掉）：
    //   shell 把工具窗排除出「应用窗口」名单，锚点一挂 TOOLWINDOW，任务管理器就失去
    //   聚合锚点，整棵进程树散成 5 条独立条目（用户 2026-10-03 实测复现，PITFALLS §67）。
    //   分组靠的就是这个窗口的「可聚焦可见非工具窗」身份，skipTaskbar（DeleteTab 登记）
    //   保留即可；代价是 explorer 重启后任务栏可能低频回流一条纯透明条目（§57 的老问题，
    //   概率与代价都远小于分组散开，取舍记在 PITFALLS §67）。
    anchorWindow.on('closed', () => {
      anchorWindow = null;
    });
  } catch (err) {
    // 锚点窗口只影响任务管理器分组，建不出来也不能拖累主流程
    logLine('锚点窗口创建失败: ' + err.message);
    anchorWindow = null;
  }
}

// 窗口句柄写进日志：出「点不动」这类问题时，可以用 tools/probe-window-style.js
// 直接读它们的真实窗口样式（含锚点窗口——它若意外变成可接收点击，会是个看不见的挡板）
function logHwnd(win, label) {
  try {
    const h = win.getNativeWindowHandle().readBigUInt64LE(0);
    logLine(`${label} HWND=0x${h.toString(16)}`);
  } catch {
    // 取不到就算了
  }
}

// ---- 强制不进任务栏（WS_EX_TOOLWINDOW）----
// Electron 的 skipTaskbar 在 Windows 上是 ITaskbarList::DeleteTab，向 explorer（shell）登记的，
// 窗口本身没有对应样式位。任务栏一旦重建（explorer 重启、shell 崩溃自动重启、部分显示拓扑
// 变化），shell 会重新枚举可见顶层窗口并把 tab 加回来，Electron 不会补删——桌宠窗和锚点窗
// 就一起在任务栏冒出来（实测低频复现：一条纯透明（锚点）+ 一条显示桌宠）。
// 补 WS_EX_TOOLWINDOW：shell 枚举时直接排除工具窗，没有可丢失的登记，对上述场景免疫。
// 代价：两窗也从 Alt-Tab 列表消失（桌宠本就 focusable:false 不可激活，无实际影响）。
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_LAYERED = 0x00080000; // 分层窗口：per-pixel alpha 未知，矩形相交≠视觉遮挡；整窗点击穿透的必要位（§63）
const WS_EX_TRANSPARENT = 0x00000020; // 与 LAYERED 同挂才产生鼠标路由；对非分层窗只是 GDI 绘制顺序标志（§63），不涉及 DWM 合成
const LWA_COLORKEY = 0x00000001; // SetLayeredWindowAttributes 属性位：色键抠图
const LWA_ALPHA = 0x00000002; // SetLayeredWindowAttributes 属性位：整窗 alpha
const GW_HWNDPREV = 3; // z 链中位于其上方（盖住它）的窗口；最前窗口返回 NULL
const SWP_FRAME_ONLY = 0x01 | 0x02 | 0x04 | 0x10 | 0x20; // NOSIZE|NOMOVE|NOZORDER|NOACTIVATE|FRAMECHANGED
let _styleFns = null;

function styleFns() {
  if (_styleFns) return _styleFns;
  const user32 = koffi.load('user32.dll');
  _styleFns = {
    getEx: user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']),
    setEx: user32.func('SetWindowLongPtrW', 'int64', ['uintptr', 'int', 'int64']),
    setPos: user32.func('SetWindowPos', 'bool', ['uintptr', 'uintptr', 'int', 'int', 'int', 'int', 'uint32']),
    getWindow: user32.func('GetWindow', 'uintptr', ['uintptr', 'uint']),
    getRect: user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']),
    isVisible: user32.func('IsWindowVisible', 'bool', ['uintptr']),
    getClassName: user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']),
    getPid: user32.func('GetWindowThreadProcessId', 'uint32', ['uintptr', 'void *']),
    dwmCloaked: koffi.load('dwmapi.dll').func('DwmGetWindowAttribute', 'int32', ['uintptr', 'uint32', 'void *', 'uint32']),
    // 分层属性读数。整串式声明照抄 findings 第六节实测件（勿改参数形式——上一轮有人把
    // 声明写法问题误判成「本机参数被系统性清零」）；out 参语义见 layeredVisuallyTransparent。
    getLayeredAttr: user32.func('bool __stdcall GetLayeredWindowAttributes(uintptr hwnd, uint32 *pKey, uint8 *pAlpha, uint32 *pFlags)'),
  };
  return _styleFns;
}

// DWM cloak：开始菜单/搜索等系统壳窗（Windows.UI.Core.CoreWindow）平时被 DWM 隐身挂
// 在全屏位置，IsWindowVisible 仍返回 true 且 TOPMOST——只看可见性会把它们当成「压住
// 桌宠的全屏窗口」导致重申恒触发。DWMWA_CLOAKED 非 0 = 被 DWM 隐身，肉眼不可见。
function winCloaked(dwmCloaked, hwnd) {
  const out = Buffer.alloc(4);
  return dwmCloaked(hwnd, 14, out, 4) === 0 && out.readUInt32LE(0) !== 0;
}

// 解析 GetWindowRect 的 RECT 缓冲
function winRect(getRect, hwnd) {
  const b = Buffer.alloc(16);
  getRect(hwnd, b);
  return { l: b.readInt32LE(0), t: b.readInt32LE(4), r: b.readInt32LE(8), b: b.readInt32LE(12) };
}

// 窗口类名（UTF-16LE 缓冲）：识别 IME 幻影窗等无视觉内容的系统伴生窗口
function winClass(getClassName, hwnd) {
  const b = Buffer.alloc(512);
  const n = getClassName(hwnd, b, 256);
  return n > 0 ? b.toString('utf16le', 0, n * 2) : '';
}

// 分层窗是否「视觉上透明」（petCovered 的排除判据，2026-10-02 票 5；判据来源
// PITFALLS §61 子坑 4 —— ★3/★4 两组均为一手机测）：
// - 无 WS_EX_LAYERED：普通窗，窗口矩形即视觉边界，不算透明（返回 false，保留遮挡判定）。
// - LAYERED 且 GLWA ret=1 且 flags 带 LWA_ALPHA：按 alpha 细分——
//     alpha==255 → 肉眼完全不透明的分层窗（SLWA 写满 alpha），矩形压住桌宠就是真遮挡
//                  → 返回 false（不排掉），照常进候选/重申与归名日志；
//     alpha<255  → 半透明 → 返回 true（排除）。
// - LAYERED 且 ret=1 但 flags 不含 LWA_ALPHA（含 GLWA ret=0 的形态）：无显式 alpha 属性
//   的分层窗（per-pixel/DComp 类）。真 Electron 窗与 BongoCat 都靠这一支排除，但判别的
//   不变量是「flags 不含 LWA_ALPHA 就当透明」而**不是 ret 值**：ret 在同为 LAYERED 的窗
//   之间不稳定（自造裸挂读 false，真 Electron 窗被外部补挂读 1/flags 全零，findings
//   2026-10-02 第八节改判 1），唯一不变的是「只有显式 SLWA(LWA_ALPHA, 255) 才算不透明」。
//   这是 §61 子坑 4 闪烁回归的防线：这类窗肉眼全透明，矩形相交没有视觉意义。
// - LAYERED 且只有 LWA_COLORKEY（无 LWA_ALPHA）：保守按透明排除。理由：色键窗「不透明
//   像素」的分布无法从样式位得知，误判成不透明遮挡会引发无谓重申（false→true 折腾
//   z 序，§61 主坑的闪烁代价），而漏掉一次压回的代价小——两害取其轻。
function layeredVisuallyTransparent(getLayeredAttr, ex, hwnd) {
  if (!(ex & WS_EX_LAYERED)) return false;
  // out 参 Buffer 预填哨兵：ret=0 时系统零写入，没有哨兵就分不清「写出了 0」和「什么都没写」
  const k = Buffer.alloc(4), a = Buffer.alloc(1), f = Buffer.alloc(4);
  k.writeUInt32LE(0xcdabcd00); a[0] = 0xcd; f.writeUInt32LE(0xffffffff);
  if (!getLayeredAttr(hwnd, k, a, f)) return true;
  if (!(f.readUInt32LE(0) & LWA_ALPHA)) return true; // 仅色键 / 无属性：保守按透明
  return a[0] < 255;
}

// 桌宠是否被盖：TOPMOST band 内 z 链更前方存在与桌宠矩形相交、可见、非 cloak、
// 非 layered、非本应用伴生、非幻影的窗口才算，命中时返回肇事者（类名+矩形），
// 没被盖返回 null。条件缺一不可：
// - 非 TOPMOST 窗口全在 band 之下盖不住桌宠，PREV 链天然不含；
// - cloaked 系统壳窗（CoreWindow 全屏隐身挂着）不算；
// - layered（WS_EX_LAYERED）按 alpha 细分（layeredVisuallyTransparent，2026-10-02 票 5）：
//   1.0.22~1.0.25 是「LAYERED 置位即排除」的二值写法，漏掉肉眼完全不透明的分层窗（SLWA
//   alpha=255）——它压住桌宠时 petCovered 恒 null，一行日志都不写，无从归名，§60 承诺的
//   「被压后 1.5s 内压回」对它失效。现按 GLWA 属性判定：alpha==255 判不透明遮挡（照常进
//   候选/重申与归名日志）；ret=1 但 flags 不含 LWA_ALPHA（含 ret=0 形态；findings 第八节
//   改判 1：ret 不能当判别位）与 alpha<255、仅色键仍按透明排除——§61 子坑 4「BongoCat
//   互踩闪烁」的回归防线不动。
// - 本应用自己的窗口不算（own-PID 排除）：本进程窗口与桌宠相交必然是「透明压透明」，
//   没有视觉遮挡；且样式上无从稳定区分——锚点窗走 Electron API 挂了 LAYERED，菜单/
//   表情选择器是 DComp alpha 贴普通窗面（ex=0x8），桌宠窗自方案 1 起也永挂 LAYERED，
//   只能按进程归属排除。
// - IME 幻影窗不算：Default IME / MSCTFIME UI 是输入法框架的伴生窗，IsWindowVisible
//   返回 true 且 TOPMOST 非 layered，但没有可见内容（候选 UI 另有真窗，且受 cloak 排除
//   覆盖）。1.0.23 实机日志：用户每次打字 petCovered 都以 500ms 节奏持续命中
//   （16:52:22-28 连续 13 条）→ 2Hz 重申暴风，就是「面板压桌宠疯狂闪烁」的真凶路径；
//   Chromium 遮挡判定同样忽略这两类。Ghost 是系统给分层/失去响应窗创建的伴生窗
//   （dev 实测：外来 SetLayeredWindowAttributes 分层窗立即伴随一个同矩形 Ghost，
//   TOPMOST 可见非 layered），同样无独立视觉语义。肇事者类名随重申日志落盘，
//   再冒出别的幻影类可直接归名补排除。
const PHANTOM_CLASSES = new Set(['Default IME', 'MSCTFIME UI', 'Ghost']);

function petCovered() {
  try {
    const { getWindow, getRect, isVisible, getEx, dwmCloaked, getClassName, getPid, getLayeredAttr } = styleFns();
    const hwnd = petWindow.getNativeWindowHandle().readBigUInt64LE(0);
    // self 判定矩形与「桌宠视觉」同口径（票 11-E 任务 4）：1.0.52 起整窗恒 600×600 而视觉
    // 只有 300×petScale，按整窗判定面积比视觉大 (600/300s)²（s=1 时 4 倍）。校验轮按日志
    // 几何量化过 1.0.52 首启前后「只与整窗相交、与视觉不相交」= 0/0——这是潜在不一致的
    // 一致性修复，不是故障修复。与 layoutMenu 的避让判据同一先例（Electron DIP 坐标；
    // 本机缩放 100% 时与原生物理像素等价，DPI≠100% 是项目级未复核项，见 PITFALLS :368）。
    const wb = petWindow.getBounds();
    const vr = petVisualRect({ x: wb.x, y: wb.y }, petScale());
    const self = { l: vr.x, t: vr.y, r: vr.x + vr.width, b: vr.y + vr.height };
    const pidBuf = Buffer.alloc(4);
    let h = getWindow(hwnd, GW_HWNDPREV);
    for (let i = 0; h && i < 200; i++) {
      if (isVisible(h) && !winCloaked(dwmCloaked, h)) {
        getPid(h, pidBuf);
        const ex = Number(BigInt(getEx(h, GWL_EXSTYLE)) & 0xffffffffn);
        const own = pidBuf.readUInt32LE(0) === process.pid;
        if (!own && !layeredVisuallyTransparent(getLayeredAttr, ex, h)) {
          const r = winRect(getRect, h);
          const overlaps = self.l < r.r && r.l < self.r && self.t < r.b && r.t < self.b &&
            r.r > r.l && r.b > r.t; // 零面积窗没有视觉内容，不算遮挡
          if (overlaps) {
            const cls = winClass(getClassName, h);
            if (!PHANTOM_CLASSES.has(cls)) return { cls, rect: r };
          }
        }
      }
      h = getWindow(h, GW_HWNDPREV);
    }
  } catch {
    return { cls: null, rect: null }; // 检测失败按「被盖」处理，退回无条件重申，宁可多动不可失守
  }
  return null;
}

// 原生穿透翻转（方案 1，2026-10-02）：WS_EX_LAYERED 永在基线、开窗即挂永不摘，
// 之后只翻 WS_EX_TRANSPARENT——把 §63 丢掉的穿透语义拿回来，同时保住 §62 的零闪烁。
// why：整窗点击穿透 = LAYERED + TRANSPARENT 缺一不可（§63：TRANSPARENT 对非分层窗只是
// GDI 绘制顺序标志，不参与鼠标路由）；而在 Electron/DComp 窗上翻转 LAYERED 实测会闪
//（§62 真窗实证：两条 DWM 合成路径切换 → 整窗重合成；注意该因果只在 Electron/DComp 窗
// 上成立，裸 GDI 窗挂/摘 LAYERED 均 0 跳变，findings 第二节）。两条合起来，唯一「不闪又
// 真穿透」的写法就是让 LAYERED 成为常量、只翻 TRANSPARENT（§62 真窗 7 次翻转 + 票 3'
// γ1→γ2 翻 TRANSPARENT 均 0 跳变）。票 3' α2 态真窗实证：开窗即挂后 WindowFromPoint
// 归下层窗、注入点击 Δ=0，且双抓亮度与对照同档——裸挂 LAYERED 不杀渲染内容，DComp
// 照常合成（findings 第八节）。
// 挂位时机在 createPetWindow（建窗后、loadFile 前）就完成第一次写位；本函数此后兼任
// LAYERED 的兜底重挂点：任何调用发现 LAYERED 缺失都会在写位时补回（基线永含 LAYERED），
// 所以窗口重建路径（createPetWindow / resyncPassThrough）紧邻的调用天然就是重挂点，
// 不需要额外的补挂代码。γ1 的教训是运行时补挂有一次 mean +9.5 的视觉渐变（MAD 8 轮
// 才衰减），只要重建走 createPetWindow 就不会出现那种形态。
// WS_EX_TRANSPARENT：翻转不切合成路径故不闪（§62）。forward（穿透时向页面转发
// mousemove）自 §38 改为 250ms 光标轮询后已无消费者，LAYERED 的 alpha hit-test 也没有
// 别的依赖。TRANSPARENT 位生效无需 FRAMECHANGED，不带它（NCCALCSIZE 重算反而可能引起
// 重绘）；LAYERED 的识别由紧随其后的 forceNoTaskbar 的 FRAMECHANGED 覆盖。
function nativeSetIgnoreMouseEvents(win, ignore) {
  const { getEx, setEx } = styleFns();
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
  const cur = Number(BigInt(getEx(hwnd, GWL_EXSTYLE)) & 0xffffffffn);
  // 目标态从「LAYERED 永在的基线」重算：false 分支只摘 TRANSPARENT，true 分支只加
  // TRANSPARENT，两个分支都保 LAYERED。next===cur 提前返回必须保留（§62 子坑 1 的防护，
  // 方向反转后仍要）：可交互态（L 在、T 不在）再调 false 时才是真正的空转，不挡它——
  // 反过来 LAYERED 被外部清掉时 next 必然 ≠ cur，写位自动补挂。
  const base = (cur | WS_EX_LAYERED) & ~WS_EX_TRANSPARENT;
  const next = ignore ? (base | WS_EX_TRANSPARENT) : base;
  if (next === cur) return;
  setEx(hwnd, GWL_EXSTYLE, next);
}

function forceNoTaskbar(win, label) {
  try {
    const { getEx, setEx, setPos } = styleFns();
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    const ex = Number(BigInt(getEx(hwnd, GWL_EXSTYLE)) & 0xffffffffn);
    if (ex & WS_EX_TOOLWINDOW) return; // 已设置：不重复触发 FRAMECHANGED
    setEx(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW);
    setPos(hwnd, 0, 0, 0, 0, 0, SWP_FRAME_ONLY); // 让样式位生效
    logLine(`${label}已补 WS_EX_TOOLWINDOW（任务栏不再受 shell 重建影响）`);
  } catch (err) {
    // 兜底：skipTaskbar 仍在，只是退回「explorer 重建后可能回流」的旧行为
    logLine(`${label}设置 WS_EX_TOOLWINDOW 失败: ${err.message}`);
  }
}

// 解锁/唤醒后重建桌宠窗口。
// 实测证据（tools/probe-window-style.js --watch）：解锁后窗口样式显示「可接收点击」、
// 渲染端也活着（能回 pong），但鼠标点击就是不进来——属于窗口与会话/输入系统失联。
// 这种情况下"再设一次 setIgnoreMouseEvents"之类的补救都不可靠，换一个全新 HWND 才彻底。
// 代价：解锁瞬间桌宠闪一下（约 0.2 秒），位置/皮肤/计数都会照常恢复。
let recreatingPet = false;

function recreatePetWindow(why, deferSelfHeal) {
  if (!petWindow || petWindow.isDestroyed()) return;
  logLine(`${why}：重建桌宠窗口以确保输入恢复`);
  stopWalk('重建窗口'); // 定时器不能在旧窗口上继续 setPosition
  recreatingPet = true;
  recovering = true; // 期间 window-all-closed 不退出
  try {
    const b = petWindow.getBounds();
    config.set('petPosition', { x: b.x, y: b.y }); // 位置不丢
    petWindow.destroy();
    createPetWindow(deferSelfHeal); // 票 11-K：unlock/resume 的重建把归位决策推迟到延迟复查
  } catch (err) {
    logLine('重建桌宠窗口失败: ' + err.message);
  } finally {
    recreatingPet = false;
    setTimeout(() => {
      recovering = false;
    }, 2000);
  }
}

// 1.0.52 固定窗一次性迁移：窗口从「300×300 × petScale」变为恒 600×600，petPosition（窗口原点）
// 语义不变，但同一 origin 下视觉右下角（== 窗口右下角）会外扩 (600 - 300×旧scale)——
// 平移 origin 使视觉右下角保持在原地，用户看到的桌宠位置升级前后逐像素一致
function migratePetWindowFixed() {
  if (config.get('petWindowFixed')) return;
  const pos = config.get('petPosition');
  if (pos && Number.isInteger(pos.x) && Number.isInteger(pos.y)) {
    const s = petScale();
    config.set('petPosition', {
      x: Math.round(pos.x + PET_SIZE.width * s - PET_WINDOW_SIZE.width),
      y: Math.round(pos.y + PET_SIZE.height * s - PET_WINDOW_SIZE.height),
    });
    logLine(`固定窗迁移: petPosition 平移至 ${Math.round(pos.x + PET_SIZE.width * s - PET_WINDOW_SIZE.width)},${Math.round(pos.y + PET_SIZE.height * s - PET_WINDOW_SIZE.height)}（视觉右下角保持原地）`);
  }
  config.set('petWindowFixed', true);
}

function createPetWindow(deferSelfHeal) {
  petReady = false; // 新页面要重新发 pet:ready
  petQueue = [];
  // 新窗口的穿透状态从零开始：等渲染端上报可交互区域后由主进程轮询接管
  petIgnoreSent = null;
  // 进行中的让路穿透一并作废：旧窗口（可能已 destroy）上的计时器不许摸新窗口
  petPeekActive = false;
  clearTimeout(petPeekTimer);
  petPeekTimer = null;
  petInteractiveBox = null;
  // 命中区宽限期从这里起算（1.0.58）：建窗有两条路——开机首建、以及解锁/唤醒/托盘显示等重建，
  // 两条都会遇到「首报盒残缺」（计数还没推上来），所以放在唯一的建窗点而不是各调用方各写一次
  petRebuildGraceUntil = Date.now() + REBUILD_GRACE_MS;
  petWindow = new BrowserWindow({
    ...petSize(), // 固定 600×600（1.0.52）；缩放只改渲染端 #pet-root transform，窗口不再变
    ...resolvePetPosition(deferSelfHeal),
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    // 不抢焦点：全屏游戏/视频里点击、拖动桌宠都不会把游戏切到后台
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // 票 11-T（用户拍板纳入）：隐藏态下发生的一切重建（unlock/resume 等）都不得把桌宠露出来。
    // 1.0.67 实测：隐藏时锁屏，解锁重建的新窗建出即可见，而 petHidden 记账仍是「隐藏」——
    // 漂移直接把托盘左键语义反转（用户点隐藏却触发 showPet），实测复现。show:!petHidden 从
    // 建窗点就保持隐藏（比建完再 hide 干净，无「先显一瞬再收」的闪烁）；托盘显示路径 showPet
    // 先置 petHidden=false 再重建，不受影响。
    show: !petHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 常驻桌面可见，但被其他窗口遮挡时 Chromium 会节流定时器——手柄轮询/眨眼/提醒需要实时
      backgroundThrottling: false,
    },
  });
  // screen-saver 级：置顶带的最顶端，压过任务栏与其他自置顶窗口
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  // 初始就是穿透：形象之外的透明区不该拦住底下的点击。
  // 这个初值以前由渲染端 setIgnore(true) 设定，现在统一由主进程设定（唯一写入者）。
  // 方案 1 的挂位时机就在这里：建窗后、loadFile（任何内容开始合成）之前同步写位，
  // LAYERED 在首帧前就位（票 3' α 形态；运行时补挂的 γ 形态有 mean +9.5 的视觉渐变，
  // findings 第八节）——不要把首次写位推迟到渲染端上报或轮询。
  nativeSetIgnoreMouseEvents(petWindow, true);
  petIgnoreSent = true;
  logHwnd(petWindow, '桌宠窗口');
  forceNoTaskbar(petWindow, '桌宠窗口');

  petWindow.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  petWindow.webContents.on('did-finish-load', () => {
    pushCounter();
    pushSkin();
    pushPetConfig();
  });
  petWindow.on('closed', () => {
    petWindow = null;
    // 锚点窗口常驻，桌宠窗被关掉时必须一起收，否则 window-all-closed 永远不触发、进程留在后台。
    // 但「解锁后重建窗口」这条路是主动销毁再建，锚点要留着（否则分组身份丢了）。
    if (!quitting && !recreatingPet && anchorWindow && !anchorWindow.isDestroyed()) anchorWindow.destroy();
  });
  // 卡死自恢复：渲染进程崩溃或无响应时原地重载，否则桌宠会僵在屏幕上，
  // 用户只能去任务管理器结束进程。绝不能 destroy 窗口再重建——桌宠是唯一窗口，
  // 销毁它等于触发 window-all-closed → app.quit()，渲染进程崩一下整个程序就退出了。
  petWindow.webContents.on('unresponsive', () => {
    if (quitting) return;
    logLine('pet 窗口无响应，自动重载');
    reloadPet();
  });
  petWindow.webContents.on('render-process-gone', (_e, details) => {
    logLine(`pet 渲染进程退出: ${details.reason} exitCode=${details.exitCode}`);
    if (quitting) return;
    reloadPet();
  });
}

// 原地重载拿新的渲染进程；recovering 期间 window-all-closed 不退出，兜住重载窗口那一下的空档
function reloadPet() {
  if (!petWindow || petWindow.isDestroyed()) return;
  recovering = true;
  try {
    petWindow.webContents.reload();
  } catch (err) {
    logLine('原地重载失败: ' + err.message);
  }
  setTimeout(() => {
    recovering = false;
  }, 8000);
}

// 数据目录便携化后的一次性迁移：把旧版 AppData 里的 data\ 与 skins\ 搬到安装目录。
// 只复制目标中不存在的文件（绝不覆盖， timing 安全：任何时点调用都不会弄丢新数据）。
// 仅当数据目录确实解析到安装目录时执行（可写性回退到 AppData 的场景无需迁移）
function copyDirMissingOnly(src, dst) {
  // 返回实际复制的文件数（票 11-D 4b）：调用方据此决定打不打「补迁 N 个文件」日志
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copied += copyDirMissingOnly(s, d);
    else if (!fs.existsSync(d)) {
      fs.copyFileSync(s, d);
      copied++;
    }
  }
  return copied;
}

// ===== 旧数据迁移（每次启动都探测；missing-only 保证不覆盖已有，无缺可补时零动作零日志）=====
// （票 11-D 4b：原注释写「一次性」与实机不符——12:43:09 与 12:43:23 两次启动各探测了一遍；
//   「一次性」只体现在 missing-only 不覆盖。日志按实际复制文件数打，N=0 时静音，消掉每次启动的噪音。）
// 1.0.3 及以前：数据主位置在安装目录内 data\，另有同级 <程序名>-data\ 镜像副本。
// 1.0.4 起：数据主位置改为同级 <程序名>-data\（与程序分离，覆盖安装/卸载清空安装目录也不再丢）。
// 1.0.6 起：程序装到 <容器>\bin\ 下时，数据/皮肤回到容器根（<容器>\data\、<容器>\skin\）——
//   NSIS 的 $INSTDIR 只到 bin，覆盖安装清空 bin 时父目录的数据/皮肤不会被碰。
// 老用户升级：把下列旧位置用 copyDirMissingOnly 补进当前新位置（不覆盖，保证最新数据不被顶掉），
// 源目录留着不删（手动清理即可；装在同一路径时下次覆盖安装会自然清掉旧的安装目录内副本）。
function migrateLegacyData() {
  try {
    if (!app.isPackaged) return;
    const exeDir = path.dirname(app.getPath('exe'));
    // 票 11-B 第 5 条（改名迁移）：旧产品名的 Chromium userData 目录（%APPDATA%\<LEGACY_SLUG>）
    // 若被可写性回退路径当过数据根，里面的应用数据要 missing-only 补进当前位置。
    // 只搬 data\ 与 skins\ 两类应用数据，**不搬 Chromium 运行时文件**（Cache/Local Storage 等）：
    // 到这里时新名 profile 的 LevelDB 已被打开，混搬有实损风险，且缓存无关用户数据。
    const legacyUserData = path.join(app.getPath('appData'), identity.LEGACY_SLUG);
    const hasLegacyUserData =
      legacyUserData !== app.getPath('userData') &&
      (fs.existsSync(path.join(legacyUserData, 'data')) || fs.existsSync(path.join(legacyUserData, 'skins')));
    let legacyUserDataCopied = 0;
    if (hasLegacyUserData) {
      legacyUserDataCopied =
        copyDirMissingOnly(path.join(legacyUserData, 'data'), config.DATA_DIR) +
        copyDirMissingOnly(path.join(legacyUserData, 'skins'), config.SKIN_ROOT);
      // 只在真的补了文件时打日志（票 11-D 4b：该目录每个启动都在，N=0 不打，消掉 12:43:09/12:43:23 那种连打）
      if (legacyUserDataCopied > 0) {
        logLine(`已从旧版 userData（${legacyUserData}）补迁 ${legacyUserDataCopied} 个文件（只搬应用数据，Chromium 缓存不搬）`);
      }
    }
    const pre106Copied =
      copyDirMissingOnly(path.join(app.getPath('userData'), 'data'), config.DATA_DIR) +
      copyDirMissingOnly(path.join(exeDir, 'data'), config.DATA_DIR) +
      copyDirMissingOnly(path.join(app.getPath('userData'), 'skins'), config.SKIN_ROOT) +
      copyDirMissingOnly(path.join(exeDir, 'skins'), config.SKIN_ROOT);
    // 皮肤子目录 1.0.6 起从 skins\ 改名为 skin\：同一数据根下的旧目录并进新目录（missing-only）
    const skinsRenamedCopied = copyDirMissingOnly(path.join(config.USER_DATA_ROOT, 'skins'), config.SKIN_ROOT);
    if (skinsRenamedCopied > 0) {
      logLine(`旧皮肤子目录（skins→skin 改名遗留）补迁 ${skinsRenamedCopied} 个文件到 ${config.SKIN_ROOT}`);
    }
    if ((fs.existsSync(path.join(exeDir, 'data')) || fs.existsSync(path.join(exeDir, 'skins'))) && pre106Copied > 0) {
      logLine(`旧版数据补迁 ${pre106Copied} 个文件到 ${config.USER_DATA_ROOT}（安装目录内旧副本保留，下次覆盖安装自动清除）`);
    }
    // 新结构（程序在 bin\ 下）：并入旧结构遗留目录——同级 <容器名>-data\ 与 <容器>\bin-data\。
    // 旧皮肤子目录名是 skins、新的是 skin，两种都试（missing-only，不覆盖已有）。
    if (path.basename(exeDir).toLowerCase() === 'bin' && config.USER_DATA_ROOT === path.dirname(exeDir)) {
      const container = path.dirname(exeDir);
      const legacyRoots = [
        path.join(path.dirname(container), `${path.basename(container)}-data`),
        path.join(container, 'bin-data'),
      ];
      let mergedCopied = 0;
      for (const legacy of legacyRoots) {
        if (!fs.existsSync(legacy)) continue;
        mergedCopied +=
          copyDirMissingOnly(path.join(legacy, 'data'), config.DATA_DIR) +
          copyDirMissingOnly(path.join(legacy, 'skins'), config.SKIN_ROOT) +
          copyDirMissingOnly(path.join(legacy, 'skin'), config.SKIN_ROOT);
      }
      if (mergedCopied > 0) {
        logLine(`旧数据已并入新结构：补迁 ${mergedCopied} 个文件（${config.DATA_DIR} + ${config.SKIN_ROOT}），旧目录保留可手动删除`);
      }
    }
  } catch (err) {
    console.error('[migrate] 旧数据迁移失败:', err.message);
  }
}

// ===== 自启意图补齐（每次启动都探测；票 11-D 1c 引入，票 11-F 换 reg 直写）=====
// 历史：这里原是「旧自启 Run 键 / 旧 AUMID 键清理」（票 11-B 第 4、4b 条，11-C 重做，11-F 扩展）。
// 背景：Electron 写的 Run 值名按 productName 换轨（electron.app.desktop-pet → electron.app.Showcase），
// 旧键不会被自动清理，只删不写还会把「静默空转」变成「删掉用户自启且不补回」。
// 票 11-Q（2026-10-06）退休清理段（兼容层清单 ④）：公开面 orphan 首发、外部无 1.0.x 用户，
// 本机旧值名实测不在位（electron.app.desktop-pet / electron.app.Showcase 两代形态均已清毕）。
// 反向验收：仍残留旧名 Run 键的机器不再被自动清理，须手工删注册表值；新键读回判据
// （findRunEntry + RUN_VALUE_NAME）原样保留，行首空白容忍的回归基线在 verify-autostart-migration。
// 现职责只剩一条：config.autoStart=true 而注册表没有新键时按意图补齐（reg 直写，不碰 StartupApproved）。
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// StartupApproved\Run：任务管理器「启动应用」的启用/禁用标志落点（禁用只写标志不删 Run 值）。
// 票 11-F 裁决①：这里的禁用 = 用户意图不自启，勾选态合并它、写路径永不碰它。
const APPROVED_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

// ---- Run 键直写（票 11-F 方案 B，PITFALLS §75）----
// setLoginItemSettings 的默认值名跟随当前 AUMID、enabled 默认会清 StartupApproved 禁用标志
// （官方文档实锤）——1.0.54 首启据此写出第二条 Run 键并复活了用户的手工禁用。自启启用/关闭
// 一律 reg 直写：值名钉死 identity.RUN_VALUE_NAME（与 findRunEntry 判据同源）、写路径结构上
// 不碰 StartupApproved。dev 守卫与迁移清理同一纪律（dev 的 execPath 是 electron.exe，
// 写真实 Run 键 = 污染实机注册表，1.0.54 及以前 menuActions 的 setLoginItemSettings 无此守卫）。
function writeRunValue(cb) {
  if (!app.isPackaged) {
    logLine('dev 下不写自启 Run 键（isPackaged 守卫）');
    return;
  }
  execFile(
    'reg',
    ['add', RUN_KEY_PATH, '/v', identity.RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', `"${process.execPath}" ${AUTOSTART_ARG}`, '/f'],
    { windowsHide: true },
    (err) => cb && cb(err)
  );
}

function deleteRunValue(cb) {
  if (!app.isPackaged) {
    logLine('dev 下不删自启 Run 键（isPackaged 守卫）');
    return;
  }
  execFile('reg', ['delete', RUN_KEY_PATH, '/v', identity.RUN_VALUE_NAME, '/f'], { windowsHide: true }, (err) => cb && cb(err));
}

// 删 StartupApproved 里该值名的条目 = 恢复「未计量启用」。两个用途：①显式启用（菜单点
// 模式项）时清掉用户此前的手工禁用——那是本应用内的显式开启动作，覆盖系统层旧禁用是语义
// 正确的；②「关闭」自启时顺手清干净（Run 值都没了，残留条目只会让任务管理器数据发陈）。
function deleteApprovedValue(cb) {
  if (!app.isPackaged) return;
  execFile('reg', ['delete', APPROVED_KEY_PATH, '/v', identity.RUN_VALUE_NAME, '/f'], { windowsHide: true }, () => cb && cb());
}

// StartupApproved 读数缓存（勾选态合并系统事实用）：reg query 异步而菜单构建同步，bootApp
// 读一次存这里、写键回调里刷新。读回前的窗口期按「启用」兜底（与 1.0.54 及以前行为一致）。
// dev 不读：dev 的注册表状态不代表打包版，缓存保持默认。
let startupApprovedEnabled = true;
function refreshStartupApprovedState(cb) {
  if (!app.isPackaged) return;
  execFile('reg', ['query', APPROVED_KEY_PATH], { windowsHide: true }, (qErr, qOut) => {
    if (qErr || !qOut) return; // 键不存在 = 我们这条从未被计过 = 启用，缓存默认已对
    startupApprovedEnabled = isStartupApprovedEnabled(String(qOut), identity.RUN_VALUE_NAME) !== false;
    logLine(`自启启动项状态：任务管理器${startupApprovedEnabled ? '未禁用' : '已禁用（勾选态将视同关闭，且不会被启动流程复活）'}`);
    cb && cb();
  });
}

// AUMID 显示名注册（票 11-F 裁决③）：通知中心的归属名来自
// HKCU\Software\Classes\AppUserModelId\<AUMID>\DisplayName——electron-builder 只把 AUMID
// 写进快捷方式属性、不注册显示名（§66 补注），无此键时 toast 实测回退显示「Electron」。
// 幂等探测：键在则不写（不每次启动碰注册表）；卸载自动清（uninstaller.nsh 的
// UninstAppUserModelId 清的就是本键，键名 = build.appId，§66 补注）。
function ensureAumidDisplayName() {
  if (!app.isPackaged) return;
  const key = 'HKCU\\Software\\Classes\\AppUserModelId\\' + identity.APP_ID;
  execFile('reg', ['query', key], { windowsHide: true }, (qErr) => {
    if (!qErr) return; // 键已在（此前启动写过），不重复写
    execFile(
      'reg',
      ['add', key, '/v', 'DisplayName', '/d', identity.PRODUCT_NAME, '/t', 'REG_SZ', '/f'],
      { windowsHide: true },
      (aErr) =>
        logLine(
          aErr
            ? `AUMID 显示名注册失败: ${aErr.message}`
            : `已注册 AUMID 显示名（${identity.APP_ID} → ${identity.PRODUCT_NAME}），通知归属名生效`
        )
    );
  });
}

// 自启新键读回的三态描述（票 11-D 任务 1b）。11-C 的复查用裸 getLoginItemSettings() 当判据，
// 实机 13:29 在注册表新键在位时仍打印 openAtLogin=false（判据与地面真相矛盾，见 11-C 校验结论）
// ——复查一律改走 reg query 直读 + findRunEntry；措辞三态可区分，不输出引导用户手工改注册表的句子。
// 判据：findRunEntry 非空 且 command 映像基名 === 当前 execPath 基名（大小写不敏感）。
function describeOwnRunState(qErr, qOut, valueName, ownExeBase) {
  if (qErr || !qOut) return `注册表读不到（reg query 失败: ${qErr ? qErr.message : '空输出'}），本次不判断自启状态`;
  const entry = findRunEntry(String(qOut), valueName);
  if (!entry) return `注册表里读不到新键（${valueName}）`;
  const base = commandImageBasename(entry.command);
  if (base !== ownExeBase) return `读回的新键指向不是当前 exe（${entry.command}，映像基名 ${base}）`;
  return `已在注册表读回新键（${entry.valueName} → ${entry.command}）`;
}

function ensureAutostartIntent() {
  // dev 的 process.execPath 是 electron.exe：写真实 HKCU Run 键会污染实机注册表。
  // dev 下不写不删——这是 dev 与打包版的行为分界（票 11-C 1c）。
  if (!app.isPackaged) return;
  // 新键值名 = identity.RUN_VALUE_NAME（票 11-F 钉死 = APP_ID，写路径与判据同源）。
  const newValueName = identity.RUN_VALUE_NAME;
  const ownExeBase = path.basename(process.execPath).toLowerCase();
  execFile('reg', ['query', RUN_KEY_PATH], { windowsHide: true }, (qErr, qOut) => {
    if (qErr || !qOut) return; // 读不到就不动（残留无害：旧键指向的 exe 已被清，开机静默失败）
    // 意图补齐（票 11-D 1c，判据 11-F 钉死值名）：只看「新键值名不存在」：用户手工
    // 改过指向的新键也照算存在，不覆盖。直写不碰 StartupApproved——用户此前在任务管理器的
    // 禁用针对的是「在位的键」，键都没了禁用无从谈起，此时按意图补写是正确行为；若键在位
    // 且被禁用，本分支不触发（禁用状态保住）。
    // config.autoStart 是用户意图真源，不新增 config 项（铁律 2）。
    if (config.get('autoStart') === true && !findRunEntry(String(qOut), newValueName)) {
      writeRunValue();
      logLine(`自启意图补齐：注册表里没有自启键（${newValueName}），而 config.autoStart=true —— 按配置意图补齐自启项`);
      // 补写后重查一次注册表确认（票 11-D 1b：复查不走裸 API）
      execFile('reg', ['query', RUN_KEY_PATH], { windowsHide: true }, (rErr, rOut) => {
        logLine('自启意图补齐后 ' + describeOwnRunState(rErr, rOut, newValueName, ownExeBase));
      });
    }
  });
}

// 旧 AUMID 键清理（cleanupLegacyAumidKey）已随票 11-Q 退休（兼容层清单 ⑤，2026-10-06）：
// 它删的是 HKCU\Software\Classes\AppUserModelId\ 下的上一版 appId 键（com.desktoppet.app）。
// 撤的凭据：本机该键实测已无；公开面 orphan 首发、外部无 1.0.x 用户。反向验收：某台机器若
// 残留旧键会一直占着通知归属，只能 reg delete 手工清——identity.js 不再导出 LEGACY_APP_ID。

// ===== 内置皮肤释放（首次运行，missing-only）=====
// 皮肤随安装包分发（asar 内 assets/skins/），而打包版的皮肤扫描只看用户数据目录，
// 因此首次运行把内置皮肤释放到 <数据根>\skin\，让任何机器装完开箱即有这些表情包（含 ac_color）。
// 用 config.builtinSkinsVersion 记录已释放的批次，规则：
//   · 只补「当前批次还缺的」目录 —— 用户删掉的皮肤不会复活；
//   · 用户已有的同名目录保持不动（不覆盖用户自己的改动）；
//   · 以后内置皮肤更新，把 BUILTIN_SKINS_VERSION 递增即可再补一轮。
const BUILTIN_SKINS_VERSION = 1;

function installBuiltinSkins() {
  try {
    if (!app.isPackaged) return; // dev 模式直接读项目内 assets/skins
    if (config.get('builtinSkinsVersion') === BUILTIN_SKINS_VERSION) return;
    const src = path.join(app.getAppPath(), 'assets', 'skins');
    if (!fs.existsSync(src)) return;
    let released = 0;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dst = path.join(config.SKIN_ROOT, e.name);
      if (fs.existsSync(dst)) continue;
      copyDirMissingOnly(path.join(src, e.name), dst);
      released++;
    }
    config.set('builtinSkinsVersion', BUILTIN_SKINS_VERSION);
    if (released) logLine(`内置皮肤已释放到 ${config.SKIN_ROOT}（${released} 套）`);
  } catch (err) {
    console.error('[skins] 内置皮肤释放失败:', err.message);
  }
}

function bootApp() {
  app.whenReady().then(() => {
  // AUMID 必须在任何窗口/通知之前设好：Windows 系统通知（久坐提醒 toast）按 AUMID 归属应用，
  // electron-builder 的 NSIS 快捷方式用的就是 identity.APP_ID，两边一致 toast 才挂对本应用。
  //（dev 无快捷方式，toast 可能不弹或归到通用身份——气泡仍在，不影响主路径）
  // 注意：这一行的副作用不止通知——setLoginItemSettings 的默认值名跟随当前 AUMID（§75），
  // 1.0.55 起 Run 键 reg 直写值名钉死 identity.RUN_VALUE_NAME，不再依赖该默认值。
  app.setAppUserModelId(identity.APP_ID);
  migrateLegacyData();
  installBuiltinSkins();
  // 主题三模式：nativeTheme 会让所有 renderer 的 prefers-color-scheme 跟随
  nativeTheme.themeSource = config.get('theme') || 'system';

  rollDateIfNeeded();
  migratePetWindowFixed(); // 必须在建窗前：resolvePetPosition 读的是迁移后的 petPosition
  // 锚点必须先建：任务管理器认「应用」的时机是在子进程创建时，GPU/网络这些进程
  // 是在第一个窗口 load 时拉起来的；锚点建晚了，先起来的那些进程就归不进同一条目
  createAnchorWindow();
  createPetWindow();
  // 托盘常驻：既是「隐藏桌宠」之后的唯一入口，也顺手给了一个快捷显隐/退出
  createTray();

  // 1.0.71 显隐请求哨兵监听：第二实例抢锁失败立即退出前会写 identity.SHOW_REQUEST_NAME
  // （写端见文件尾抢锁失败分支）。提权首实例收不到 second-instance（Windows 完整性策略
  // no-write-up），文件是唯一保底通道；普通首实例下锁通道正常，哨兵只是冗余层。三重门槛：
  // ①时间戳 10s 内——残留旧文件（上次会话/上一次双击）不认；②2500ms 内来过 second-instance
  // 就让路（lastSecondInstanceAt，顶层声明）——普通实例下 second-instance 先到先办；
  // ③petHidden 才当真——哨兵的唯一用途是「隐藏态双击不显示」的兜底，显示态双击本就可见，
  // 动了只会多余重建。处理完删文件（防残留+防重复读），watch 回调连发靠读空文件自然吸收。
  const handleShowRequest = () => {
    const reqPath = path.join(config.DATA_DIR, identity.SHOW_REQUEST_NAME);
    let req = null;
    try {
      req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
    } catch {
      return; // 文件已删/读到半截：无请求可办
    }
    try {
      fs.unlinkSync(reqPath);
    } catch {
      // 删不掉不挡显示：下一次请求会覆盖写
    }
    if (!req || typeof req.at !== 'number' || Date.now() - req.at > 10000) return; // ①过期
    if (Date.now() - lastSecondInstanceAt < 2500) return; // ②锁通道正常，second-instance 已办
    if (!petHidden) return; // ③可见态无需动作
    logLine('显隐请求哨兵生效（second-instance 对提权首实例不可达，由文件通道补办显示）');
    showPet();
  };
  try {
    const showRequestWatcher = fs.watch(config.DATA_DIR, (event, fname) => {
      if (fname && fname !== identity.SHOW_REQUEST_NAME) return;
      handleShowRequest();
    });
    showRequestWatcher.on('error', (err) => {
      logLine('显隐请求哨兵监听异常（兜底通道失效，不影响主流程）: ' + err.message);
    });
  } catch (err) {
    logLine('显隐请求哨兵监听启动失败: ' + err.message);
  }

  // 提权运行确认（以管理员重启成功后给出可见反馈）：fltmc 仅管理员可执行。
  // 必须异步：spawnSync 会阻塞主进程事件循环，开机那一下窗口是死的。
  // 也不能用 try/catch 判权限——spawnSync 对非零退出码不抛异常，只有 execFile 的回调才拿得到失败。
  execFile('fltmc', [], { windowsHide: true }, (err) => {
    isAdmin = !err; // 探测结果落进模块状态：底部指示灯据此亮/灭（did-finish-load 时可能还没测完，这里补推一次）
    if (isAdmin) pushBubble('已以管理员权限运行', 3500);
    pushPetConfig();
    // 清理 1.0.30/1.0.31 任务计划方案的残留（DesktopPetAdminAutostart）：留着会在开机时
    // 多拉一份提权实例（单实例锁挡得住进程，挡不住多余的一次 UAC）。删除任务需要管理员，
    // 所以放在管理员探测回调里；任务不存在时 schtasks 报错即忽略。
    if (isAdmin) {
      try {
        execFile('schtasks', ['/delete', '/tn', 'DesktopPetAdminAutostart', '/f'], { windowsHide: true }, (e) => {
          if (!e) logLine('已清理任务计划方案遗留的 DesktopPetAdminAutostart（改用 Run 键自启后不再需要）');
        });
      } catch (e2) {
        // spawn 被安全策略拒绝时 execFile 同步抛（沙箱实测 EPERM），不能打断启动
        logLine('清理遗留任务计划时无法调用 schtasks: ' + e2.message);
      }
    }
  });

  // ①（票 11-F）：1.0.54 的「Run 键格式幂等重写」整段删除——其职责由自启意图补齐覆盖：
  // 新值名键按 config.autoStart 意图 reg 直写；直写路径结构上不碰 StartupApproved，用户在
  // 任务管理器的禁用不会被启动流程复活（§75 / 裁决①）。
  refreshStartupApprovedState(); // 异步预取勾选态合并所需的系统事实（首次开菜单前大概率已读回）
  // ② 旧身份残留清理（票 11-B 第 4、4b 条）：已随票 11-Q 退休（④自启旧值名清理段、
  // ⑤旧 AUMID 键清理段，2026-10-06）——留下的只有 ensureAutostartIntent 的意图补齐这一半。
  ensureAutostartIntent();
  // ③ AUMID 显示名注册（票 11-F 裁决③）：无此键时通知中心归属回退显示框架名（实测 Electron）。
  ensureAumidDisplayName();
  // ② 开机自启且配置了提权 → 请求提权（relaunchAsAdmin 内部处理 UAC 取消：普通实例
  // 不退出，桌宠降级为普通权限继续跑）。手动启动（无 --autostart）永不触发。
  if (shouldRequestElevationOnBoot(process.argv, config.get('autoStartAdmin'))) {
    logLine('开机自启：按配置请求管理员权限（UAC）');
    relaunchAsAdmin();
  }

  try {
    startKeylistener({
      onKey: (name) => {
        bumpKey(name);
        trackPetCtrl(name, true);
      },
      onKeyUp: (name) => trackPetCtrl(name, false),
      onMouseDown: onGlobalMouseDown,
      onActivity,
    });
    timers.push(setInterval(reconcileCtrlState, 2000)); // 钩子丢 keyup 的显隐自愈（见 reconcileCtrlState 注）
  } catch (err) {
    console.error('[keylistener] 全局钩子启动失败，计数停用:', err.message);
  }

  scheduleSpeech();
  restartReminder();
  timers.push(setInterval(checkSleep, 1000));

  // 穿透状态的兜底轮询：放主进程是因为渲染端定时器会被页面节流（锁屏/长时间无操作）
  timers.push(
    setInterval(() => {
      syncPetPassThrough(false);
      checkCursorRest();
    }, 120)
  );

  // 锁屏/解锁、睡眠/唤醒：系统会重建窗口表面，穿透状态可能被打回原样；这些也常是
  // 「回来后点不动」的触发点，所以强制重新同步一次，并把事件写进日志便于日后对照
  // 重建窗口时把「立即同步」推迟到渲染端上报可交互区域之后：
  // 刚 createPetWindow 的新页面尚未上报，此时只能拿兜底区域判定（它只覆盖形象附近），
  // 若光标恰好不在兜底区内就会被判成穿透并记账 true；等真实区域上报时又因
  // 「光标一直没动 → 没有 mousemove → justEntered 为假 + 值没变」而不再下发，
  // 新窗口于是又卡在穿透上——重建白做。改为等上报（或超时兜底）后再判定。
  const resyncPassThrough = (why, recreate) => {
    if (petPeekActive) endPetPeek(why); // 会话切换路径会重建窗口/重申置顶，peek 提前收场，别跟它抢窗口状态
    logLine(`${why}：重新同步穿透状态`);
    logHiddenMismatch(why); // 票 11-T：进系统事件路径先对账，漂移当场暴露
    if (recreate) {
      // 解锁/唤醒后窗口可能与会话/输入系统失联（样式看着可点击、点击却进不来），
      // 换一个全新窗口句柄最彻底；位置/皮肤/计数都会照常恢复
      recreatePetWindow(why, recreate); // 票 11-K：unlock/resume 的重建同时推迟位置归位决策（defer）
      // 新窗口的「轮询首次生效」由上报触发；recreatePetWindow 内部已把 petIgnoreSent 置空、
      // 区域置空，这里不再补一刀反向设置，也不立即 syncPetPassThrough。
      // LAYERED 无需在此重挂：新 HWND 由 createPetWindow 开窗即挂（方案 1）。
      petSyncAfterRebuild = true;
      try {
        if (anchorWindow && !anchorWindow.isDestroyed()) anchorWindow.setIgnoreMouseEvents(true);
      } catch {
        // 锚点不存在就算了
      }
      // 超时兜底：渲染端迟迟不报（极端情况）也要把新窗口接管起来，用兜底区域判定
      setTimeout(() => {
        if (!petSyncAfterRebuild) return;
        petSyncAfterRebuild = false;
        logLine(`${why}：等渲染端上报超时，按兜底区域接管穿透状态`);
        syncPetPassThrough(true);
      }, 1200);
      pingPet(why); // 渲染端若已僵住（没崩溃但不处理事件），这里会把它重载回来
      return;
    }
    // 1.0.25 前这里是 Electron API「反向设一次」，用于踢开 Chromium 内部「是否忽略鼠标
    // 事件」的去重标记，避免后续同值设置被吞；换 native 写路径后该动机已失效。判留理由
    // 更新（方案 1，2026-10-02）：这次调用兼任 LAYERED 兜底重挂——穿透态下 next===cur
    // 恒空操作（L|T 都在）；可交互态真写一次只翻 TRANSPARENT（不切合成路径，无视觉
    // 副作用）；无论记账处于哪态，LAYERED 一旦被外部清掉，这次调用都会把它补回。
    // 去重本身已由下面的 petIgnoreSent=null + syncPetPassThrough(force) 兜住。
    // 票 11-T（方案 A，用户拍板）：隐藏态就保持隐藏——1.0.67 实测 lock-screen 走这条分支时
    // 会把隐藏中的桌宠 showInactive 露出来（露面副作用实锤）；resync 的本分只是穿透/置顶兜底，
    // 不含「替用户取消隐藏」。穿透兜底（nativeSetIgnoreMouseEvents）与置顶重申照做，只跳过 showInactive。
    try {
      if (petWindow && !petWindow.isDestroyed()) {
        nativeSetIgnoreMouseEvents(petWindow, true);
        if (!petHidden) {
          petWindow.showInactive();
        }
        petWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    } catch (err) {
      logLine('重置窗口状态失败: ' + err.message);
    }
    petIgnoreSent = null;
    petOutsideSince = 0;
    petInteractiveBox = null; // 等渲染端重新上报；期间用兜底区域
    try {
      if (anchorWindow && !anchorWindow.isDestroyed()) anchorWindow.setIgnoreMouseEvents(true);
    } catch {
      // 锚点不存在就算了
    }
    sendToPet('pet:report-box', true);
    pingPet(why); // 渲染端若已僵住（没崩溃但不处理事件），这里会把它重载回来
    syncPetPassThrough(true);
  };
  powerMonitor.on('lock-screen', () => resyncPassThrough('lock-screen', false));
  powerMonitor.on('unlock-screen', () => resyncPassThrough('unlock-screen', true));
  powerMonitor.on('suspend', () => resyncPassThrough('suspend', false));
  powerMonitor.on('resume', () => resyncPassThrough('resume', true));
  // 票 11-K：解锁/唤醒后显示器枚举陆续恢复，metrics 一变即提前触发延迟位置复查（1.5s 超时兜底），
  // 别等满 1.5s 才把桌宠拉回副屏——副屏恢复通常远快于 1.5s，早拉回少一次「位置错半拍」的观感
  try {
    screen.on('display-metrics-changed', () => {
      if (deferredPositionCheckTimer) runDeferredPositionCheck('display-metrics-changed');
    });
  } catch {
    // screen 事件不可用就只靠超时兜底
  }
  // 平时也定期确认渲染端活着（30 秒一次，成本可忽略）
  timers.push(setInterval(() => pingPet('定期探测'), 30000));

  // 置顶会「过期」：任务栏与桌宠同在 TOPMOST band，explorer 在用户点任务栏/开始菜单/
  // 通知动作时会把自己重新抬到 band 顶部；托盘展开浮层（Win+B）弹出时也会盖上来。
  // 桌宠 focusable:false（WS_EX_NOACTIVATE）永远不能靠交互把自己抬回来，只能靠重申。
  // 重申必须「先 false 再 true」：直接重复同 level 的 setAlwaysOnTop 在高频连续调用下
  // 会变空操作（5 轮闭环实测 4 轮无效），先出 band 再进 band 才必然重调 SetWindowPos
  // 把自己排回 band 顶部（PITFALLS §60）。
  // 且重申必须「按需」（petCovered）：真的被可见窗口压住才动。无反扑时每 500ms 无谓
  // 折腾 z 序，会和矩形相交的普通窗口（统计面板拉宽压到桌宠上方透明区）在 DWM 合成
  // 上打架，表现为相交区域每秒闪 2 次；按需后平时零折腾，反扑/遮挡仍会压回。
  // 且按需还要「防抖」：1.0.23 实机日志仍抓到 2Hz 重申暴风（16:52:22-28 连续 13 条，
  // 时间与用户打字吻合，元凶是 IME 幻影窗，已在 petCovered 白名单排除），这里再兜底
  // 一层——遮挡要连续 3 拍（1.5s）成立才重申一次：瞬态/抖动的遮挡（托盘浮层、通知、
  // 未归名的幻影窗）不再逐拍互踩；持续遮挡（拖到任务栏上）恢复从 0.5s 变 1.5s，
  // 换取相交区域不再出现风暴式闪烁。肇事者类名落盘，再冒出新幻影类可直接归名补排除。
  // 隐藏到托盘时窗口不可见，跳过不唤醒。
  let coverStreak = 0;
  const COVER_TICKS = 3;
  const describeCover = (hit) =>
    hit.cls ? `${hit.cls} @(${hit.rect.l},${hit.rect.t})-(${hit.rect.r},${hit.rect.b})` : '检测失败，退回无条件重申';
  timers.push(
    setInterval(() => {
      try {
        if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) {
          coverStreak = 0;
          return;
        }
        const hit = petCovered();
        if (!hit) {
          coverStreak = 0;
          return;
        }
        coverStreak++;
        if (coverStreak < COVER_TICKS) {
          if (coverStreak === 1) logLine(`置顶遮挡候选(1/${COVER_TICKS})：${describeCover(hit)}`);
          return;
        }
        coverStreak = 0;
        logLine(`置顶重申：被可见窗口持续压住(≥${COVER_TICKS}拍)，压回 band 顶：${describeCover(hit)}`);
        petWindow.setAlwaysOnTop(false);
        petWindow.setAlwaysOnTop(true, 'screen-saver');
      } catch {
        // 窗口正在重建等瞬态：下个周期再补
      }
    }, 500)
  );

  // 手柄按键轮询（XInput，30Hz）
  try {
    gamepadX.start();
    let gamepadAnnounced = false;
    timers.push(
      setInterval(() => {
        if (!gamepadAnnounced && gamepadX.isConnected()) {
          gamepadAnnounced = true;
          pushBubble('🎮 手柄已连接', 2500);
        }
        const res = gamepadX.poll();
        if (res.pressed.length) bumpGamepad(res.pressed);
        if (res.stickMove) stickHappy();
        // 手柄活动同样算「人在操作」：睡眠中按手柄/拨摇杆要立刻唤醒（之前只认键鼠）
        if (res.pressed.length || res.stickMove) onActivity();
      }, 33)
    );
  } catch (err) {
    console.error('[gamepad] XInput 轮询启动失败:', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
  });
  });
}

if (lockAcquired) {
  // 票 11-T 回归修复：第二实例抢锁失败后的 400ms retry 每一拍 requestSingleInstanceLock
  // 都会在首实例上再 emit 一次 second-instance——1.0.68 实测隐藏态被反复 showPet 顶出来
  // （「点了隐藏又弹出」，直到风暴结束才消停，日志里「隐藏桌宠→托盘显示：重建」交替 8+ 轮）。
  // 1.0.70 已把普通双击的第二实例改为立即退出（retry 只留给提权链），风暴从源头消失；这个
  // 去抖降级为防御层——兜住提权让位超时后的残余拍与极速双击的冗余拍。真人双击是秒级离散
  // 动作：2500ms 内的重复事件一律视为余波，只计数落日志、不做 show/hide 动作
  // （提权让位分支不去抖，必须即时）。
  // lastSecondInstanceAt 声明已提至顶层（1.0.71）：bootApp 的显隐请求哨兵处理要拿它当去重基准。
  let secondInstanceDebounced = 0;
  app.on('second-instance', () => {
    if (adminRelaunchPending) {
      app.quit(); // 提权重启的新实例已在起，旧实例让位（即时，不经过去抖）
      return;
    }
    const now = Date.now();
    if (now - lastSecondInstanceAt < 2500) {
      // 活动窗 debounce（不是 throttle）：忽略拍也刷新基准——retry 风暴 400ms 一拍，
      // 若只按「上次当真拍」算间隔，每 2.5s 就会漏一拍继续把隐藏顶出来；刷新基准后
      // 只要事件间隔 <2500ms 就持续忽略，风暴结束后安静满 2500ms 才重新当真。
      secondInstanceDebounced++;
      lastSecondInstanceAt = now;
      logLine(`second-instance 去抖：2500ms 内第 ${secondInstanceDebounced} 次重复事件，忽略（第二实例 retry 余波）`);
      return;
    }
    secondInstanceDebounced = 0;
    lastSecondInstanceAt = now;
    if (petWindow && !petWindow.isDestroyed()) {
      logHiddenMismatch('second-instance'); // 票 11-T：进路径先对账
      if (petHidden) {
        // 票 11-T（方案 A）：隐藏态被再次双击 exe，走 showPet() 的重建显示——
        // 原 petWindow.show() 不重建不查账，1.0.67 实测露出旧 HWND 且点不动（P3）。
        showPet();
      } else {
        petWindow.show();
      }
    }
  });
  bootApp();
} else {
  // 票 11-T 回归根修（1.0.70）：抢锁失败后的 400ms retry，每一拍 requestSingleInstanceLock
  // 都会在首实例上再 emit 一次 second-instance——1.0.69 实测普通双击叠加后风暴长达 37s，
  // 首实例的去抖窗被风暴拍持续刷新，期间用户的全部真双击都被吞（「隐藏后再双击不显示，
  // 间隔短要试很多次」）。retry 的唯一正当场景是提权重启链：提权产物实例（argv 带
  // ELEVATED_AUTOSTART_ARG）抢锁时旧实例可能还没退完（UAC 确认 + 收尾），需要等它让位；
  // 普通双击的第二实例没有等待对象（首实例活得好好的），等下去只会制造风暴——立即退出。
  if (process.argv.includes(ELEVATED_AUTOSTART_ARG)) {
    const lockStart = Date.now();
    const retry = setInterval(() => {
      if (app.requestSingleInstanceLock()) {
        clearInterval(retry);
        lockAcquired = true;
        bootApp();
      } else if (Date.now() - lockStart > 20000) {
        clearInterval(retry);
        app.quit();
      }
    }, 400);
  } else {
    logLine('second-instance 抢锁失败且非提权产物实例：立即退出（首实例已在，retry 只留给提权链）');
    // 1.0.71 哨兵兜底：装机日志实锤提权首实例收不到 second-instance（Windows 完整性策略
    // no-write-up——Medium 第二实例写不进 High 首实例持有的单实例锁对象，1.0.70 复测
    // 「提权重启后双击不显示」四次双击首实例零反应；反向 High→Medium 不受限所以提权交接
    // 一直正常）。second-instance 通道不可控，退出前改走文件：写一个带时间戳的显隐请求，
    // 首实例 fs.watch 到后按三重门槛补走 showPet（读端见 bootApp）。
    try {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(config.DATA_DIR, identity.SHOW_REQUEST_NAME),
        JSON.stringify({ at: Date.now() })
      );
      logLine('已写显隐请求哨兵（second-instance 对提权首实例不可达，走文件通道兜底）');
    } catch (err) {
      logLine('显隐请求哨兵写入失败: ' + err.message);
    }
    app.quit();
  }
}

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  logLine('before-quit: 开始收尾');
  stopWalk('退出');
  if (tray && !tray.isDestroyed()) tray.destroy(); // 不销毁会在托盘里留个幽灵图标
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  try {
    stopKeylistener();
  } catch (err) {
    logLine('stopKeylistener 失败: ' + err.message);
  }
  flushDayRecord();
  // 兜底：3 秒内没退干净就硬退（unref 保证它本身不拖住退出）
  setTimeout(() => {
    logLine('退出超时，强制结束进程');
    app.exit(0);
  }, 3000).unref();
});

app.on('window-all-closed', () => {
  // recovering：自恢复重载窗口的空档不算「用户关掉了所有窗口」
  if (process.platform !== 'darwin' && !quitting && !recovering) app.quit();
});

// 主进程异常不再静默：写日志留现场，避免「突然没了/卡住」无从查起
process.on('uncaughtException', (err) => {
  logLine('uncaughtException: ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (reason) => {
  logLine('unhandledRejection: ' + (reason && reason.stack ? reason.stack : reason));
});

// ---- ipc ----

// 真实光标位置：渲染端不能只靠 mousemove 推位置——页面重载后（渲染进程被外部杀掉时
// 会自动重载）就没有任何 mousemove，若此时指针正停在桌宠上，窗口会一直卡在穿透状态
ipcMain.handle('pet:cursor', () => {
  try {
    return screen.getCursorScreenPoint();
  } catch {
    return null;
  }
});

// ---- 桌宠穿透状态：由主进程判定（渲染端只上报可交互区域）----
// 为什么必须放主进程：渲染页面的定时器在锁屏、长时间无操作等「页面被隐藏」的情况下会被
// Chromium 节流到每分钟一次，靠渲染端轮询兜底就会卡在穿透上点不动；主进程的定时器不受影响。
// 渲染端仍会在 mousemove 时按同一套规则立刻算一次，保证切换无延迟。
let petInteractiveBox = null; // 离散矩形数组（窗口内坐标 + 各自余量，渲染端上报；票 11-J 任务 2）
let petIgnoreSent = null;
// 兜底可交互区：渲染端还没上报（页面刚加载、或锁屏解锁后渲染端一时不响应）时用，
// 不能默认「整窗穿透」——那会让桌宠在可见的情况下完全点不动。
// 按当前 scale 从视觉矩形**在窗口内的偏移**派生（复用 petVisualOffset/visualSize，两者都是
// 窗口内坐标）：视觉矩形右下角对齐窗口右下角 (600,600)，覆盖形象/计数/齿轮。
// 1.0.55 及以前是写死常量 {x:40,y:140,200x155}——1.0.51 前「窗口=基准×scale」坐标系的值，
// 固定窗后兜底命中区落到窗口空白左上角（票 11-G 任务 3；纯逻辑判据 tools/verify-fallback-box.js）。
function petFallbackBox(s) {
  const off = petVisualOffset(s);
  const size = visualSize(s);
  return { x: off, y: off, width: size.width, height: size.height };
}

// 重建窗口后的「命中区宽限期」（1.0.58）：解锁重建 → 新页面**首次上报的盒子是不完整的**——
// 计数 chip 要等主进程下一次推送才存在，实机日志 7 次解锁全部首报 `122x152`（只有脸），
// 稳态却是 `260x15x`，差的正是左边那截计数；光标停在那儿就被判「区域外」→ 穿透 →
// 用户的第一次点击穿到桌面，等计数渲染出来第二次才中（实机 7 次里最慢一次是重建后 1.32s 才变宽）。
// 1.0.59（票 11-J 任务 4）收口：宽限∪（上报数组 ∪ 兜底视觉矩形，见 graceJudgeBoxes）**只在
// 重建后首次同步（petSyncAfterRebuild）那一次生效**，不再整段 2500ms 都并兜底——「重建后最多
// 多吞 2.5s」的旧上限缩到首判一拍；常态出口不变：收到「总面积变大」的上报立刻收回
// （说明残缺元素已渲染），REBUILD_GRACE_MS 只兜「渲染端迟迟不上报」的极端情况。
const REBUILD_GRACE_MS = 2500;
let petRebuildGraceUntil = 0;

// 离散矩形数组的总面积（宽限期「面积变大」判据用；票 11-J 任务 2 起上报是数组）
function boxesArea(rects) {
  if (!Array.isArray(rects)) return 0;
  return rects.reduce((s, r) => s + (r && r.width > 0 && r.height > 0 ? r.width * r.height : 0), 0);
}

// 宽限期是否提前结束：收到一次「面积变大」的上报 = 残缺的那截元素（计数 chip 等）已渲染出来
function graceEndsOnReport(prev, next, now, until) {
  if (!prev || !next) return false;
  if (!(now < until)) return false;
  return boxesArea(next) > boxesArea(prev);
}

// 重建后首次同步的判定盒（票 11-I 宽限 ∪ 票 11-J 任务 4 收口）：上报数组 ∪ 兜底视觉矩形，
// **离散并排**（不合成包围盒——并集把空隙重新吞回来）。只在 petSyncAfterRebuild 那一次
// （重建后第一次 force 同步）生效；具名函数同时是 tools/verify-rebuild-grace.js 的提取真源，勿改签名。
function graceJudgeBoxes(report, scale) {
  const fb = petFallbackBox(scale);
  return [...(Array.isArray(report) ? report : report ? [report] : []), fb];
}

// 命中判定用的「可交互区」，离散矩形数组（票 11-J 任务 2）：
//   · 一次上报都没到（页面刚加载/重建后渲染端未响应）→ [兜底视觉矩形]（单盒包成数组，语义不变）；
//   · 常态 → 上报数组原样（宽限∪已收口到重建后首次同步那一次，见 syncPetPassThrough 的 wide）。
function petBoxInUse() {
  const fb = petFallbackBox(petScale());
  if (!petInteractiveBox) return [fb];
  return petInteractiveBox;
}

// 日志里的「区域来源」口径——这条文案是本轮定位真机的唯一线索，别再写成二选一。
// wide 由调用方显式传入（本次判定是否并了兜底），标签跟实际判定走，不跟时间窗走
function boxSourceLabel(wide) {
  if (!petInteractiveBox) return '兜底';
  return wide ? '上报∪兜底(重建宽限)' : '渲染端上报';
}

let petPassLogAt = 0;
function logPassThrough(kind, ignore, box, inside, wide) {
  // 穿透状态变化是「点不动」类问题的核心现场，逐条记录（变化本身很稀少）
  const now = Date.now();
  if (now - petPassLogAt < 120) return; // 极端抖动时别刷屏
  petPassLogAt = now;
  // 上报是离散矩形数组（票 11-J 任务 2）：逐盒打印、竖线分隔——日志仍是判据的唯一现场，
  // 解析方（measure-exit-delay 等）按这个格式来
  const fmt = Array.isArray(box)
    ? box.map((r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`).join('|')
    : box
      ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`
      : '无';
  logLine(
    `穿透状态 ${kind}: ${ignore ? '穿透' : '可交互'}（光标在区域内=${inside ? '是' : '否'}，区域来源=${boxSourceLabel(wide)} ${fmt}）`
  );
}

// 交互保持：变「可交互」立即生效；变回「穿透」要等光标离开这么久。
// 理由是日志实测到的翻转——交互区域边界会随漂浮动画/元素显隐微动，指针停在边界上时
// 状态会以 2Hz 来回切；而 click 要求 mousedown 与 mouseup 落在同一个窗口上，
// 于是"按下时可交互、松开时已穿透"，点击直接丢失（表现就是怎么点都没反应）。
//
// ★ 但只延迟「离开」这一侧还不够（2026-09-25 复发）：曾把 justEntered 直接翻成 force，
//   等于给「变可交互」开了一条绕过本保持时间的即时通道；指针停在抖动边界上时，每翻一次
//   都会立刻抹掉刚下发的穿透 → 状态照样 2Hz 抖动（实测有 247ms 的反转，比 600ms 还短）。
//   真正的根治在下面 syncPetPassThrough 的命中判定：先让输入（inside）对边界抖动免疫，
//   保持时间才有意义。现在的即时通道只剩 petKeepInteractive 一条，且由真实事件驱动。
const PASS_HOLD_MS = 600;
let petOutsideSince = 0;
// 快速离开通道的外扩（票 11-J 任务 4，见 syncPetPassThrough）：必须盖住漂浮摆幅（±3px）+ JITTER_PAD，
// 否则静止在脸边的指针会被盒漂动周期性送进快速通道，重新制造 §52 的翻转形态。
const FAST_EXIT_PAD = 8;
// 拖拽/玻璃特效期间渲染端点名保持可交互（指针可能被拖到窗口外）
let petKeepInteractive = false;
// 重建窗口后「等渲染端首次上报再接管穿透状态」的标记（置真时不做兜底区域判定，见 resyncPassThrough；
// 票 11-J 任务 4 起它同时是宽限∪唯一生效窗口的开关）
let petSyncAfterRebuild = false;

// 任一小盒（外扩 pad）含点即命中（票 11-J 任务 2）：命中判定落在离散矩形上，
// 不再并成包围盒——并集包围盒里的透明空隙（现场 3 实测占 25.6%）不该算桌宠本体。
// 具名函数同时是判据件 tools/verify-hit-region.js 的提取真源，勿改签名。
function pointInBoxes(rects, x, y, pad) {
  if (!Array.isArray(rects)) rects = rects ? [rects] : [];
  for (const r of rects) {
    if (!r || !(r.width > 0) || !(r.height > 0)) continue;
    if (x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad) return true;
  }
  return false;
}

function syncPetPassThrough(force) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!petWindow.isVisible()) return; // 隐藏时不用管穿透
  if (petPeekActive) return; // 右键让路穿透期间状态被 peek 独占：轮询按记账会把它翻回去（光标正压在桌宠上），收场时 force 重算
  const box = petBoxInUse();
  const b = petWindow.getBounds();
  let p = null;
  try {
    p = screen.getCursorScreenPoint();
  } catch {
    // 取不到光标就保持现状
    return;
  }
  const now = Date.now();
  const x = p.x - b.x;
  const y = p.y - b.y;
  // 重建后首次同步（petSyncAfterRebuild 置真期间）：首报可能是残缺的（票 11-I），这一次判定
  // 并上兜底视觉矩形（宽限∪，graceJudgeBoxes）；其余时刻一律按上报数组判定——「最多多吞
  // 2.5s」就此缩到首判一拍（票 11-J 任务 4）。
  const wide = petSyncAfterRebuild && now < petRebuildGraceUntil;
  const judgeBoxes = wide ? graceJudgeBoxes(petInteractiveBox, petScale()) : box;
  // ★ 命中判定必须对「边界抖动」免疫，否则状态机再怎么迟滞都会被喂进真假交替的 inside。
  //   （§52 历史形态：旧并集包围盒随漂浮动画/计数宽度以 1~2Hz 上下移 ±6px，指针停在边界上
  //   时一次 box 变化就能把 inside 从真翻假 → 2Hz 抖动，落在翻转窗口里的点击被静默丢掉。）
  //   票 11-J 任务 3 重估（10 → 1）：离散小盒后抖动的两个旧来源——「并集整体边界随计数宽度
  //   变化」（只动 counter 自己的盒）与「bbox 随元素显隐变形」——都不再波及别的元素；
  //   剩下的只有 .pet-body 漂浮（translateY 0→-6，即脸/zzz 盒 ±3px 摆）。JITTER_PAD 的
  //   残余职责只有「贴盒静止指针的 inside 稳定」，而它的宽度恰是「inside 周期性翻出、
  //   600ms 保持又翻回」的振荡环宽（静止指针距元素 d ≤ JITTER_PAD 时仍会随摆动翻出）——
  //   取 1 把该环压到 1px。真正的翻转防线在保持期（PASS_HOLD_MS）与快速离开通道的
  //   FAST_EXIT_PAD ≥ 摆幅 + JITTER_PAD（见下）：inside 抖动只重置 petOutsideSince 计时，
  //   不直接驱动穿透翻转，也不产生样式写。
  const JITTER_PAD = 1;
  const inside = pointInBoxes(judgeBoxes, x, y, JITTER_PAD);
  if (inside) {
    petOutsideSince = 0;
  } else if (!petOutsideSince) {
    petOutsideSince = now;
  }
  // 拖拽/玻璃特效期间渲染端点名保持可交互：唯一的即时通道，且只朝「可交互」方向
  // （它由真实拖拽/玻璃事件驱动，不是边界抖动），指针被拖到窗外也不会中途变穿透。
  let ignore;
  if (petKeepInteractive) {
    ignore = false;
  } else if (inside) {
    // 在辖区内（含余量）→ 可交互。「进入即时生效」是安全的：指针真的移上来就能立刻点。
    ignore = false;
  } else {
    // 首轮（petIgnoreSent 为 null，即窗口刚建/刚重建）没有可延续的状态，
    // 直接按实时结果下发——否则 cursor 在区外时会被 null 兜成 false（漏了穿透）。
    if (petIgnoreSent === null) {
      ignore = true;
    } else if (!pointInBoxes(judgeBoxes, x, y, FAST_EXIT_PAD)) {
      // 快速离开通道（票 11-J 任务 4）：指针不在任何小盒 ∪ FAST_EXIT_PAD 内 = 真实离开，
      // 本 tick 即判穿透，不吃保持期。「拖完桌宠马上点文件」（2026-10-02 用户实测）与
      // 「移到紧邻图标」（本票现场 2，离开→转穿透 p50=777ms 的主体）都从这里走，
      // 延迟 ≈ 一个轮询拍。原 DISTANT_MOVE_PX=40 通道（1.0.42，只覆盖 >40px 的大幅移动）
      // 被本通道覆盖（离散盒后距所有元素 8px 外即真离开），退役。
      // 注意 x/y 是窗口内坐标：窗口被 flee/walk 移走时相对坐标同样大变，此时立即穿透
      // 也符合语义（桌宠已离开光标所在处，原地点击应给下层）。
      ignore = true;
    } else {
      // 指针贴着某元素（FAST_EXIT_PAD 环内）但不在 JITTER_PAD 环内：盒漂动可及的范围，
      // 「离开」可能是抖动假象 → 等已连续在区外满保持时间再翻（抖动远短于 600ms，翻不过去）。
      ignore = now - petOutsideSince >= PASS_HOLD_MS ? true : petIgnoreSent === true;
    }
  }
  if (!force && ignore === petIgnoreSent) return;
  petIgnoreSent = ignore;
  logPassThrough('桌宠', ignore, judgeBoxes, inside, wide);
  try {
    nativeSetIgnoreMouseEvents(petWindow, ignore);
  } catch (err) {
    logLine('设置穿透状态失败: ' + err.message);
  }
}

// ---- 右键桌宠：让路穿透 2 秒（参考本机 Bongo Cat 的「让一让」交互）----
// 右键桌宠 → 2 秒内同时发生：① 整窗点击穿透（点在桌宠身上 = 点在下层的文件/按钮）；
// ② 整体变暗 + 变透明（渲染端 body.peek，纯视觉）。
// 桌宠**保持置顶不动**（用户裁决 2026-10-06：曾按「SetWindowPos(HWND_BOTTOM) 压到 z 序底」
// 实现，实测后改为本方案——置底会把桌宠藏进窗体后面看不见，且与置顶重申循环对抗：
// petCovered 沿 GW_HWNDPREV 数遮挡隐含「自己还在 TOPMOST band」的前提，出 band 后上方
// 普通窗全被数成遮挡、1.5s 就被拽回 band 顶，见 PITFALLS §90），由变暗变透明取代。
// 为什么不复用常态穿透判定：syncPetPassThrough 是「光标在不在辖区」的常态机，peek 是
// 「无视光标、无条件穿透」的临时态，轮询每 120ms 会按记账把它翻回去（光标正压在桌宠上
// 触发右键的瞬间尤其如此）——所以 peek 期间轮询与停留让开两条定时路径都要挂起
// （petPeekActive 守卫，见各自位置），收场（到点 / 救援热键 / 锁屏 resync / 重建窗口）
// 统一走 endPetPeek 复原。置顶重申循环不需要挂起：桌宠没出 band，它的前提照常成立。
const PEEK_MS = 2000;
let petPeekActive = false;
let petPeekTimer = null;

function startPetPeek() {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
  clearTimeout(petPeekTimer);
  // 正常到不了这里（穿透态收不到第二次右键），防御性重开计时
  if (petPeekActive) {
    petPeekTimer = setTimeout(endPetPeek, PEEK_MS);
    return;
  }
  petPeekActive = true;
  logLine('右键桌宠：让路穿透 2 秒（整窗穿透 + 变暗变透明）');
  // 整窗穿透。主进程是穿透唯一写入者（§52）：直接写记账 + 原生位，等价于轮询的穿透分支
  petIgnoreSent = true;
  try {
    nativeSetIgnoreMouseEvents(petWindow, true);
  } catch (err) {
    logLine('让路穿透：设置穿透位失败: ' + err.message);
  }
  // 变暗变透明：渲染端只做视觉反馈，穿透状态归主进程（与穿透单写入者同一分界）
  sendToPet('pet:peek', true);
  petPeekTimer = setTimeout(endPetPeek, PEEK_MS);
}

function endPetPeek(reason) {
  clearTimeout(petPeekTimer);
  petPeekTimer = null;
  if (!petPeekActive) return;
  petPeekActive = false;
  logLine(`让路穿透结束${reason ? '（' + reason + '）' : ''}：恢复常态穿透判定与视觉`);
  const w = petWindow;
  if (!w || w.isDestroyed()) return; // 重建竞态：新窗口由 createPetWindow 以常驻参数建出，无需补
  sendToPet('pet:peek', false);
  // 立刻按当前光标重算常态穿透，别等下一拍轮询（2 秒一到的那次点击最容易被旧状态吃掉）
  syncPetPassThrough(true);
}

ipcMain.on('pet:peek-request', () => startPetPeek());

ipcMain.on('pet:interactive-box', (_event, box) => {
  // 票 11-J 任务 2：上报是离散矩形数组（各元素自带 BOX_PAD）。逐个校验，剔除非法项；
  // 全非法/为空 = 无可见交互元素 → null（按兜底区域判定，与旧 null 语义一致）
  const rects = Array.isArray(box)
    ? box.filter((r) => r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0)
    : [];
  const nextBox = rects.length ? rects : null;
  // 宽限期内收到「面积变大」的上报 = 漂浮气泡/计数等元素已渲染出来，首报残缺的问题已消失 → 立刻收宽限
  if (graceEndsOnReport(petInteractiveBox, nextBox, Date.now(), petRebuildGraceUntil)) {
    logLine(
      `重建宽限期提前结束：上报面积 ${Math.round(boxesArea(petInteractiveBox))} → ${Math.round(boxesArea(nextBox))}（元素已渲染齐）`
    );
    petRebuildGraceUntil = 0;
  }
  petInteractiveBox = nextBox;
  // 重建窗口后的首次上报：这才是新窗口真正可判定的时刻（见 resyncPassThrough 的注释）。
  // 用 force 下发一次，把新 HWND 从「初始穿透」翻成按真实区域算出的状态。
  if (petSyncAfterRebuild) {
    petSyncAfterRebuild = false;
    logLine('重建窗口后收到渲染端上报，按真实区域接管穿透状态');
    syncPetPassThrough(true);
    return;
  }
  syncPetPassThrough(false);
});

// ---- Ctrl+拖拽缩放桌宠（1.0.31 起替代 Ctrl+滚轮：与 Windows 桌面图标缩放手势重合）----
// 1.0.52 固定窗：窗口恒 600×600、视觉右下角钉在窗口右下角，缩放 = 渲染端纯 CSS transform
// （拖拽全程零原生窗口操作）。本进程只在松手时收到 pet:scale-end(v)：钳制、写盘、推送渲染端。
// 透明窗每次 setBounds（改尺寸/挪原点）都会让 OS 把陈旧帧先拉伸/错位显示 1~2 帧再回弹——
// 1.0.41 的 rAF 对齐方案让渲染端 transform 永远滞后窗口一步，等于每步缩放都必现错位帧，
// 双向抽搐；根治只能让缩放完全不碰窗口（PITFALLS §74）
function applyPetScale(next, persist) {
  const s = Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, Math.round(next * 100) / 100));
  if (!persist || s === petScale()) return s;
  config.set('petScale', s);
  pushPetConfig(); // 渲染端据此应用 #pet-root transform（走 petQueue，重载也会重放）
  logLine(`桌宠缩放: ${s.toFixed(2)}x（固定窗 600×600，纯 transform）`);
  return s;
}

ipcMain.on('pet:scale-end', (_event, v) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  applyPetScale(Number(v), true);
  // 放大朝手柄方向（左上）生长，若桌宠贴着屏幕左/上边缘，内容矩形可能伸出屏（1.0.64 起
  // 判据从视觉矩形收紧）——松手时按新 scale 做一次刚性回挪（窗口整体平移无陈旧帧问题），平时贴右下角缩放不会触发
  const b = petWindow.getBounds();
  const s = petScale();
  const vis = petContentRect({ x: b.x, y: b.y }, s);
  try {
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    let dx = 0;
    let dy = 0;
    if (vis.x < wa.x) dx = wa.x - vis.x;
    if (vis.y < wa.y) dy = wa.y - vis.y;
    if (dx || dy) {
      petWindow.setPosition(b.x + dx, b.y + dy);
      config.set('petPosition', { x: b.x + dx, y: b.y + dy });
      logLine(`缩放后回挪: 窗口 ${b.x},${b.y} → ${b.x + dx},${b.y + dy}（内容矩形出屏）`);
    }
  } catch {
    // 取不到显示器就不回挪
  }
});

// 拖拽/玻璃特效期间「保持可交互」：渲染端只说意图，下发仍由主进程负责（唯一写入者）
ipcMain.on('pet:keep-interactive', (_event, on) => {
  petKeepInteractive = !!on;
  syncPetPassThrough(true);
});

// 渲染端的「正按着鼠标」状态：按住不动时不让「鼠标停留 5 秒」触发让开，松开后重新计时
ipcMain.on('pet:pressing', (_event, on) => {
  petPressing = !!on;
  notePetInteraction();
});

// 点击到达探针：渲染端在 mousedown 捕获阶段都上报一条。这是排查「点不动」的第一判据——
// 有记录 = 点击确实到了窗口（问题在处理逻辑）；没记录 = 点击没到窗口（穿透/失联）。
// ★ 这两个通道此前在 preload/pet.js 里已接好，主进程却没有处理器，等于探针是哑的：
//   出问题时日志里一条都没有，无法区分「没到窗口」和「到了没记」，把排查带偏。
//   PITFALLS §10.6 把「点击到达探针」列为可复用资产，这里补齐落地点。
let lastClickProbeAt = 0;
ipcMain.on('pet:click-probe', (_event, what) => {
  const now = Date.now();
  if (now - lastClickProbeAt < 60) return; // 连点时不刷屏，够用来判断「有没有到」
  lastClickProbeAt = now;
  logLine(`桌宠收到点击: ${what}`);
});

// 渲染端异常上报：打包版没有控制台，pet.js 顶层抛错会让后面所有处理器注册中断
// （表现就是「点不动、菜单打不开」）而完全静默。既然渲染端已经挂了出口，主进程必须落地它。
ipcMain.on('pet:client-error', (_event, msg) => {
  logLine(`渲染端异常: ${msg}`);
});

// 渲染端存活探测：锁屏解锁后渲染端可能「没崩溃但不再处理任何事件」（点击自然也就没反应）。
// 主进程定期 ping，超时没回就重载页面——这也是穿透状态之外的第二道保险。
let petPongAt = 0;
let petPingTimer = null;

ipcMain.on('pet:pong', () => {
  petPongAt = Date.now();
});

function pingPet(why) {
  if (!petWindow || petWindow.isDestroyed()) return;
  petPongAt = 0;
  sendToPet('pet:ping', true);
  clearTimeout(petPingTimer);
  petPingTimer = setTimeout(() => {
    if (quitting) return;
    if (petPongAt) return;
    logLine(`渲染端 ${why} 无响应（未回 pong），重载页面`);
    petInteractiveBox = null; // 重载期间按兜底区域判定
    reloadPet();
  }, 2500);
}

// ---- 换皮 ipc ----

// 换皮导入统一管线（菜单「导入」与拖拽共用）：eif → 压缩包 → 图片/文件夹收集。
// eif/压缩包 → 解包 + 挑选窗；单张图片 → 直接建皮肤并设为 idle 生效；
// 多张图片 / 文件夹（递归收集）→ 建皮肤 + 挑选窗
function runSkinImport(valid) {
  try {
    const eif = valid.find((p) => path.extname(p).toLowerCase() === '.eif');
    const archive = valid.find((p) => skins.matchArchive(p)); // zip/7z/rar/tar 系（双扩展名在 skins 侧处理）
    if (eif) {
      const imported = skins.importEif(eif);
      config.set('skinName', imported.name);
      pushSkin();
      openPickerWindow(imported.name);
      return;
    }
    if (archive) {
      // 7z 解压走 wasm 是异步的；导入结果与 eif 同流程（zip 本可同步，统一走 async 省分叉）
      skins
        .importArchive(archive)
        .then((imported) => {
          config.set('skinName', imported.name);
          pushSkin();
          openPickerWindow(imported.name);
        })
        .catch((err) => pushBubble('导入失败：' + err.message, 4500));
      return;
    }
    const images = skins.collectImageFiles(valid);
    if (!images.length) {
      pushBubble('没有找到可导入的图片（支持 .eif、压缩包、图片或含图片的文件夹）', 4000);
      return;
    }
    // 皮肤命名：来源于文件夹时用文件夹名（比首图文件名直观），纯图片沿用首图名/dropped
    const firstDir = valid.find((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    if (images.length === 1) {
      const base = firstDir ? path.basename(firstDir) : path.basename(images[0], path.extname(images[0]));
      const dir = skins.uniqueSkinDir(base);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(images[0], path.join(dir, 'idle' + path.extname(images[0]).toLowerCase()));
      const name = path.basename(dir);
      config.set('skinName', name);
      pushSkin();
      pushBubble(`皮肤已应用：${name}`, 3500);
      return;
    }
    const base = firstDir ? path.basename(firstDir) : 'dropped';
    const dir = skins.uniqueSkinDir(base);
    fs.mkdirSync(dir, { recursive: true });
    images.forEach((p, i) => {
      fs.copyFileSync(p, path.join(dir, `sticker_${String(i + 1).padStart(3, '0')}${path.extname(p).toLowerCase()}`));
    });
    const name = path.basename(dir);
    config.set('skinName', name);
    pushSkin();
    openPickerWindow(name);
  } catch (err) {
    pushBubble('导入失败：' + err.message, 4500);
  }
}

// 拖拽导入（renderer 把拖入文件的磁盘路径发来），处理逻辑与菜单导入同一条管线
ipcMain.on('skins:drop-import', (_event, paths) => {
  if (!Array.isArray(paths)) return;
  const valid = paths.filter((p) => typeof p === 'string' && fs.existsSync(p));
  if (valid.length) runSkinImport(valid);
});

// 自绘菜单窗口
ipcMain.handle('menu:load', () => buildMenuState());
ipcMain.on('menu:action', (_event, id) => {
  if (typeof id !== 'string') return;
  runMenuAction(id);
  closeMenuWindow();
});
ipcMain.on('menu:resize', (_event, width, height) => {
  if (!menuWindow || menuWindow.isDestroyed()) return;
  // 高度上限动态化：小屏也要尽量全量展示选项（超出只能滚动，正常 1080p 用不满）
  // 注意必须取 .workArea：Display 对象本身没有 height 字段，误用会得到 NaN 一路传进 setBounds
  const wa = (screen.getDisplayNearestPoint(menuAnchor) || screen.getPrimaryDisplay()).workArea;
  const w = Math.max(180, Math.min(440, Math.ceil(width)));
  const h = Math.max(120, Math.min(640, wa.height - 24, Math.ceil(height)));
  const pos = layoutMenu(menuAnchor.x, menuAnchor.y, w, h); // 内容尺寸变了要重新钳位/避让桌宠
  menuWindow.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
  if (menuShowTimer) { clearTimeout(menuShowTimer); menuShowTimer = null; }
  if (!menuWindow.isVisible()) menuWindow.show(); // 真实尺寸就位后才首次显示，避免跳动
});
ipcMain.on('menu:font-set', (_event, size) => {
  const next = [12, 14, 16, 20].includes(Number(size)) ? Number(size) : 14;
  config.set('menuFontSize', next);
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.webContents.send('menu:font', next);
  }
});

// renderer 触发 picker（菜单「挑选表情映射…」与导入后自动打开共用）；emoji 皮肤走字符网格
ipcMain.on('skins:open-picker', (_event, skinName) => {
  if (skinName === 'emoji' || skins.resolveSkin(skinName).dir) openPickerWindow(skinName);
});

ipcMain.handle('picker:load', (_event, skinName) => {
  // emoji 皮肤：挑选窗渲染完整 emoji 目录（字符网格），映射存 emoji-skin.json
  if (skinName === 'emoji') {
    return { name: 'emoji', states: skins.SKIN_STATES, emoji: true, images: [], mapping: skins.getEmojiMapping() };
  }
  const resolved = skins.resolveSkin(skinName);
  if (!resolved.dir) return { name: skinName, states: [], images: [], mapping: {} };
  return {
    name: skinName,
    states: skins.SKIN_STATES,
    images: skins.listSkinImages(skinName).map((file) => ({
      file,
      url: pathToFileURL(path.join(resolved.dir, file)).href,
    })),
    mapping: resolved.frames,
  };
});

ipcMain.on('picker:save', (_event, payload) => {
  const { name, frames } = payload || {};
  if (name === 'emoji') {
    try {
      skins.setEmojiMapping(frames);
    } catch (err) {
      pushBubble('保存失败：' + err.message, 4000);
      return;
    }
    if (config.get('skinName') === 'emoji') pushSkin();
    if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
    return;
  }
  const resolved = skins.resolveSkin(name);
  if (!resolved.dir || !frames || typeof frames !== 'object') return;
  const allowed = new Set(skins.listSkinImages(name));
  const clean = {};
  for (const state of skins.SKIN_STATES) {
    const v = frames[state];
    if (typeof v === 'string' && allowed.has(v)) clean[state] = v;
  }
  if (!clean.idle) return; // idle 必须分配
  fs.writeFileSync(path.join(resolved.dir, 'skin.json'), JSON.stringify({ frames: clean }, null, 2));
  if (config.get('skinName') === name) pushSkin();
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
});

ipcMain.on('picker:close', () => {
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
});

// F3 拖拽：renderer 发位移增量，松手后位置写入 config
// 按发送方窗口移动：原来桌宠拖拽和字幕条共用这条 IPC（字幕条已移除），仍按发送方窗口移动以免将来复用踩坑
ipcMain.on('pet:move-by', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  // 拖动会与「走过去」抢窗口位置：拖动优先，立刻停掉移动（松手后由 drag-end 落盘）
  if (win === petWindow) {
    notePetInteraction(); // 正在拖它：让开计时重新开始
    if (walkPlan) stopWalk('拖动打断');
  }
  const b = win.getBounds();
  const target = { x: b.x + dx, y: b.y + dy };
  // 屏幕钳制只对桌宠本身：拖拽是唯一没有屏内约束的移动路径（走过去/让开/缩放回挪各自已钳）
  const next = win === petWindow ? clampPetOriginToWorkArea(target) : target;
  win.setPosition(next.x, next.y);
});

ipcMain.on('pet:drag-end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  // 只有桌宠自己的拖拽才持久化位置
  if (win !== petWindow) return;
  const b = win.getBounds();
  config.set('petPosition', { x: b.x, y: b.y });
});

// 菜单入口：桌宠下方齿轮按钮（替代右键），按桌宠窗口坐标弹出。
// 齿轮是开关：菜单开着时再点 = 关闭。两条时序都要覆盖：
// ①桌宠窗口不抢焦点 → open-at 到达时菜单还在，直接关；
// ②桌宠窗口抢焦点 → 点击先触发菜单 blur 自毁，open-at 稍后到达，
//   用 lastMenuCloseAt 短窗（300ms，人工重复点击达不到）识别这种情况，不再重开。
ipcMain.on('menu:open-at', (event, x, y) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
    closeMenuWindow();
    return;
  }
  if (Date.now() - lastMenuCloseAt < 300) return;
  const b = win.getBounds();
  openMenuWindow(b.x + Number(x) || b.x, b.y + Number(y) || b.y);
});

// F7 统计：打开面板与数据汇总
ipcMain.on('stats:open', openStatsWindow);

ipcMain.handle('stats:get', () => collectStats());

// 汇总 data/keys-*.json：指标卡、今日输入 Top10（键盘+鼠标+手柄混合）、最近 14 天序列（缺数据的天补 0）
// 口径：今日/最近7天/累计/趋势 = 键盘 + 鼠标 + 手柄 总数据
function collectStats() {
  rollDateIfNeeded();
  let files = [];
  try {
    files = fs.readdirSync(config.DATA_DIR).filter((f) => /^keys-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    // data 目录不存在：全空
  }
  const daySum = (rec) => {
    const m = rec.mouse || {};
    const g = rec.gamepad || {};
    return (
      (rec.total || 0) +
      (m.left || 0) + (m.right || 0) + (m.middle || 0) +
      Object.values(g).reduce((s, v) => s + v, 0)
    );
  };
  const days = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, f), 'utf8'));
      if (rec && rec.date) {
        days.push({ rec });
      }
    } catch {
      // 跳过损坏文件
    }
  }
  days.sort((a, b) => a.rec.date.localeCompare(b.rec.date));

  const today = todayStr();
  const todayRec = days.find((d) => d.rec.date === today)?.rec;

  const lastNDays = (n) => {
    const out = [];
    const end = new Date(today + 'T00:00:00');
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const found = days.find((x) => x.rec.date === ds);
      out.push({ date: ds, total: found ? daySum(found.rec) : 0 });
    }
    return out;
  };

  const last7 = lastNDays(7);

  // Top10：键盘按键 + 鼠标左/右/中键 + 手柄按键 混合排名
  const top10 = Object.entries(todayRec ? todayRec.keys || {} : {})
    .map(([key, count]) => ({ key, count }))
    .concat(
      Object.entries(todayRec ? todayRec.mouse || {} : {}).map(([k, count]) => ({
        key: { left: '鼠标左键', right: '鼠标右键', middle: '鼠标中键' }[k] || k,
        count,
      })),
      Object.entries(todayRec ? todayRec.gamepad || {} : {}).map(([key, count]) => ({ key, count }))
    )
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    today: todayRec ? daySum(todayRec) : 0,
    last7: last7.reduce((s, d) => s + d.total, 0),
    all: days.reduce((s, d) => s + daySum(d.rec), 0),
    top10,
    last14: lastNDays(14),
    mouseToday: Object.assign({ left: 0, right: 0, middle: 0 }, todayRec ? todayRec.mouse : {}),
    // renderBars 只吃 {key,count} 数组；之前直接传对象，.length 恒 undefined，手柄区永远显示空态
    gamepadToday: Object.entries(todayRec ? todayRec.gamepad || {} : {})
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    gamepadStatus: gamepadX.getStatus(),
  };
}

timers.push(setInterval(flushDayRecord, 5000));
// 菜单弹出位置的纯几何布局（无 Electron 依赖，main.js 与测试脚本共用同一份实现）。
// 优先