// 全局键盘+鼠标钩子封装（F5/F8）
// 钩子实现被隔离在这一层：换实现只需保持 startKeylistener({ onKey, onMouseDown }) 接口，main.js 不用改。
// 但**不要**用 node-global-key-listener 这个降级方案：它的 Windows 辅助进程 WinKeyServer.exe
// 会被 Defender 按键盘记录器隔离（Trojan:Win32/KeyLogger!AMTB，属行为启发式误报，因它本身
// 就是装全局键盘钩子的）。真要换实现，请另找 N-API 钩子或签名过的辅助进程。
const { uIOhook, UiohookKey } = require('uiohook-napi');

const codeToName = new Map(
  Object.entries(UiohookKey).map(([name, code]) => [code, name])
);

// keycode → 可读键名：字母（A）、数字（0）、Space/Enter/Shift/Ctrl… 用枚举名，未知键记 Key_0xNN
function readableKeyName(keycode) {
  const name = codeToName.get(keycode);
  if (name === undefined) return `Key_0x${keycode.toString(16).toUpperCase()}`;
  return name;
}

// libuiohook 的 button 值：1 左键 / 2 右键 / 3 中键（4、5 为侧键，不计）
const MOUSE_BUTTON_NAME = { 1: 'left', 2: 'right', 3: 'middle' };

// 修饰键按下状态：事件里自带 ctrlKey/altKey，但那两个标志在本机是否真被填充过没有验证，
// 所以并行维护一份按下集合，判定时取「事件标志 || 自行跟踪」，两条路任一条可用即可
const MOD_KEYS = { Ctrl: 'ctrl', CtrlRight: 'ctrl', Alt: 'alt', AltRight: 'alt' };
const modDown = { ctrl: false, alt: false };

let started = false;

function startKeylistener({ onKey, onKeyUp, onMouseDown, onMouseUp, onActivity }) {
  if (started) return;
  started = true;
  uIOhook.on('keydown', (e) => {
    const name = readableKeyName(e.keycode);
    if (MOD_KEYS[name]) modDown[MOD_KEYS[name]] = true;
    onKey(name);
    if (onActivity) onActivity('key');
  });
  uIOhook.on('keyup', (e) => {
    const name = readableKeyName(e.keycode);
    if (MOD_KEYS[name]) modDown[MOD_KEYS[name]] = false;
    // 松开也要报（1.0.39 缩放手柄靠它知道 Ctrl 何时松开）；上层自己过滤感兴趣的键
    if (onKeyUp) onKeyUp(name);
  });
  uIOhook.on('mousedown', (e) => {
    const which = MOUSE_BUTTON_NAME[e.button];
    // 点击详情（坐标/连击/修饰键）透传给上层：走过去要用；计数行为不变
    if (which) {
      onMouseDown(which, {
        x: e.x,
        y: e.y,
        clicks: e.clicks,
        ctrl: !!(e.ctrlKey || modDown.ctrl),
        alt: !!(e.altKey || modDown.alt),
      });
    }
    if (onActivity) onActivity('mouse');
  });
  // 松开事件：**不要指望它** —— 实测 uiohook 不派发 mouseup（类型声明里有、运行时不发），
  // 需要「是否正按着」这类状态请走渲染端的 DOM 事件（renderer/pet.js 的 mousedown/mouseup）。
  // 这里留着 listener 只是为了让将来换实现的人一眼看到这个坑。
  uIOhook.on('mouseup', (e) => {
    const which = MOUSE_BUTTON_NAME[e.button];
    if (which && onMouseUp) onMouseUp(which);
  });
  // F3 打瞌睡判定需要鼠标移动信号，原生事件太密，这里节流到 ≥1 秒
  let lastMoveReport = 0;
  uIOhook.on('mousemove', () => {
    if (!onActivity) return;
    const now = Date.now();
    if (now - lastMoveReport >= 1000) {
      lastMoveReport = now;
      onActivity('mouse');
    }
  });
  uIOhook.start();
}

// 退出时显式摘钩：原生钩子线程不随 app.quit() 自动结束，残留会让进程退不掉
function stopKeylistener() {
  if (!started) return;
  started = false;
  try {
    uIOhook.stop();
  } catch {
    // 已停止或未启动，忽略
  }
}

module.exports = { startKeylistener, stopKeylistener, readableKeyName };
