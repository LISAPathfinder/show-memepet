// 「点不动」取证工具：回答「此刻光标处的点击会落到哪个窗口」，并可注入一次真实点击看应用有没有收到。
// 用法：
//   node tools/probe-click-target.js              # 只查：光标位置 → WindowFromPoint 的窗口/类名/矩形；并列出桌宠窗口对比
//   node tools/probe-click-target.js --click      # 顺带注入一次左键点击（真实 mouse_event，会真的点到那个窗口上）
// 判读：WindowFromPoint 返回的不是桌宠窗口 → 说明有窗口压在它上面（点被别的窗口吃了）；
//       是桌宠窗口但应用日志没有「桌宠收到点击」→ 问题在窗口内部（渲染端处理/输入路由）。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
const { installedDataRoot, lastError } = require('./lib-container');

const user32 = koffi.load('user32.dll');
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
// WindowFromPoint 的 POINT 是**按值**传的结构体（x64 下 8 字节进寄存器），
// 不能像 out 参数那样声明成 void* 传 Buffer —— 那样会传成指针、结果恒为 0（本轮踩过）。
// 正确写法：按 int64 传，低 32 位 x、高 32 位 y。
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr', ['int64']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr']);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['uintptr', 'void *', 'int']);
const mouse_event = user32.func('void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)');
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uintptr', []);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);

const POINT = () => Buffer.alloc(8);
const RECT = () => Buffer.alloc(16);
const cursor = () => {
  const b = POINT();
  GetCursorPos(b);
  return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
};
const text16 = (fn, h, n = 256) => {
  const buf = Buffer.alloc(n * 2);
  fn(h, buf, n);
  return buf.toString('utf16le').replace(/\0.*$/, '');
};
const title = (hwnd) => {
  const t = text16(GetWindowTextW, hwnd);
  return t || text16(GetClassNameW, hwnd);
};
const rectOf = (h) => {
  const r = RECT();
  GetWindowRect(h, r);
  const l = r.readInt32LE(0);
  const t = r.readInt32LE(4);
  return { x: l, y: t, w: r.readInt32LE(8) - l, h: r.readInt32LE(12) - t };
};

// 桌宠窗口句柄：优先用参数，其次从日志里拿最新的（与 probe-window-style 同源）。
// 装机日志目录从 HKCU 卸载键反推（tools/lib-container.js，票 11-R 起——不再写本机路径字面量）；
// 迁移期双认（票 11-A）：候选日志名逐个试（改名过渡期旧版可能还在写旧名）
function petHwndFromLog() {
  const installed = installedDataRoot();
  if (installed) console.log(`容器 = ${installed.container}（来源：${installed.from}）→ 装机日志目录 ${installed.dataDir}`);
  else console.log('未取到安装容器，本件只查了 dev 目录' + (lastError() ? `（${lastError()}）` : ''));
  const logs = [
    ...(installed ? LOG_CANDIDATES.map((n) => path.join(installed.dataDir, n)) : []),
    ...LOG_CANDIDATES.map((n) => path.join(__dirname, '..', 'data', n)),
  ];
  for (const f of logs) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('桌宠窗口 HWND='));
      for (let i = lines.length - 1; i >= 0; i--) {
        const h = parseInt(lines[i].split('HWND=')[1].trim(), 16);
        if (h && IsWindowVisible(h)) return h;
      }
    } catch {
      // 换下一个日志
    }
  }
  return 0;
}

// POINT 按值打包成 int64（低 32 位 x / 高 32 位 y）
const packPoint = (x, y) => (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
const hitAt = (x, y) => Number(WindowFromPoint(packPoint(x, y)));

// 一次性把光标移到指定坐标（与 move-cursor.js 同源，避免额外调用）
const moveTo = (x, y) => SetCursorPos(x, y);
if (process.argv.includes('--at')) {
  const i = process.argv.indexOf('--at');
  moveTo(Number(process.argv[i + 1]), Number(process.argv[i + 2]));
  const c2 = cursor();
  console.log(`已把光标移到 ${c2.x},${c2.y}`);
}

const c = cursor();
const hit = hitAt(c.x, c.y);
const pet = petHwndFromLog();
const fg = GetForegroundWindow();

const describe = (h) => {
  if (!h) return '(空)';
  const r = rectOf(h);
  const ex = Number(GetWindowLongPtrW(h, -20));
  return `HWND=0x${h.toString(16)} 标题/类名="${title(h)}" 矩形=${r.x},${r.y} ${r.w}x${r.h} 可见=${IsWindowVisible(h)} EXSTYLE=0x${ex.toString(16).padStart(8, '0')}`;
};

console.log('光标 =', `${c.x},${c.y}`);
console.log('前台窗口 =', describe(fg));
console.log('日志里的桌宠窗口 =', describe(pet));
console.log('光标处的点击会落到 =', describe(hit));
if (hit && pet && hit !== pet) {
  console.log('!! 落点不是桌宠窗口 —— 有窗口压在它上面（点击被那个窗口吃了）');
  let parent = hit;
  for (let i = 0; i < 6; i++) {
    const p = Number(koffi.load('user32.dll').func('GetParent', 'uintptr', ['uintptr'])(parent));
    if (!p) break;
    console.log(`   上层层级 ${i + 1}:`, describe(p));
    parent = p;
  }
} else if (hit && hit === pet) {
  console.log('OK 落点就是桌宠窗口 —— 若此时点击仍无反应，问题在窗口内部（不是被遮挡/穿透）');
}

if (process.argv.includes('--click')) {
  // 注入一次真实左键点击（mouse_event 走系统输入队列，与真手点同一路径）
  mouse_event(0x0002, 0, 0, 0, 0); // LEFTDOWN
  mouse_event(0x0004, 0, 0, 0, 0); // LEFTUP
  console.log('已注入一次左键点击（看应用日志是否出现「桌宠收到点击」）');
}
