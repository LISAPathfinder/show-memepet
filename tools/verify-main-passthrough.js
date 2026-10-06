// 隔离验证「穿透状态由主进程判定」：把桌宠页面换成 about:blank（渲染端彻底失效，既无定时器
// 也无事件处理），再移动真实光标，看穿透状态是否仍随光标进出宠物区域而变化。
// 驱动说明：渲染端 mousemove 处理器已收窄为拖拽专用，合成 mousemove 不再驱动判定；
// 真实光标经主进程 120ms 轮询驱动（当前架构的官方驱动路径），本脚本全程用真实光标移动。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/verify-main-passthrough.js
// 退出码：0 = 全部断言通过；1 = 有断言不过或环境不满足（实测读数见输出）。
// 端口写死为字面量（不接受外部输入），需要换端口时改下面两行。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./lib-occupancy').assertNoBlockingInstances('verify-main-passthrough.js'); // 占用自检 exit 3（票 11-G 任务 4）
const MAIN_LIST = 'http://127.0.0.1:9229/json/list';
const RENDERER_LIST = 'http://127.0.0.1:9333/json/list';

// ===== 命中路由层判据（统一口径，koffi 范式照 probe-window-style.js / probe-click-target.js）=====
// 1.0.25 实测（2026-10-02）：桌宠顶层窗穿透态 ex=0x080000a8（带 WS_EX_TRANSPARENT、无 LAYERED），
// 但整块 300x300 上 WindowFromPoint 仍返回 Chrome_RenderWidgetHostHWND（桌宠渲染子窗）——
// 「样式位挂着但点不穿」是被测对象的真 bug。因此判据必须两层组合，只看 ex 位会把 bug 判成绿：
//   预期穿透   = ex 带 0x20 且 WindowFromPoint(光标处) 的 GA_ROOT 不是桌宠顶层窗
//   预期可交互 = ex 不带 0x20 且 WindowFromPoint(光标处) 的 GA_ROOT 是桌宠顶层窗
// 只满足 ex 位（任一方向）= fail。钩子观测迁移整体押后（样式矩阵探针会话并行进行中），
// 本轮先落判据与退出码。
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
// WindowFromPoint 的 POINT 按值传：按 int64 传，低 32 位 x / 高 32 位 y；传 void* 会恒为 0。
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr', ['int64']);
const GetAncestor = user32.func('GetAncestor', 'uintptr', ['uintptr', 'uint32']);
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr']);
const GWL_EXSTYLE = -20;
const GA_ROOT = 2;
const packPoint = (x, y) => (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
const exOf = (h) => Number(BigInt(GetWindowLongPtrW(h, GWL_EXSTYLE)) & 0xffffffffn);
const rootOf = (h) => (h ? Number(GetAncestor(h, GA_ROOT)) : 0);
const hitAt = (x, y) => Number(WindowFromPoint(packPoint(x, y)));
const cursorPos = () => {
  const b = Buffer.alloc(8);
  GetCursorPos(b);
  return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
};
// moveTo 带回读校验：真实光标是共享资源（用户/其他程序都会动它），设完读回确认落点，
// 不在目标 ±5px 内重试一次；仍不在则打印告警（读数可能被污染），由断言读数自证。
const moveTo = (x, y) => {
  for (let i = 0; i < 2; i++) {
    SetCursorPos(Math.round(x), Math.round(y));
    const c = cursorPos();
    if (Math.abs(c.x - x) <= 5 && Math.abs(c.y - y) <= 5) return true;
  }
  const c = cursorPos();
  console.log(`⚠ SetCursorPos(${Math.round(x)},${Math.round(y)}) 后光标实际在 (${c.x},${c.y})——光标被外部移动，读数可能受污染`);
  return false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function passState(petHwnd) {
  if (!IsWindow(petHwnd)) throw new Error('桌宠窗口句柄已失效（窗口被重建？请重跑）');
  const c = cursorPos();
  const hit = hitAt(c.x, c.y);
  const ex = exOf(petHwnd);
  const petRoot = rootOf(petHwnd);
  const transparent = !!(ex & 0x20);
  const hitPet = hit !== 0 && rootOf(hit) === petRoot;
  return { ...c, ex, hit, petRoot, transparent, hitPet };
}
const fmtState = (s) =>
  `光标=(${s.x},${s.y}) EXSTYLE=0x${s.ex.toString(16).padStart(8, '0')} 穿透位=${s.transparent ? '挂' : '无'} ` +
  `WindowFromPoint=0x${s.hit.toString(16)} 命中桌宠=${s.hitPet ? '是' : '否'}`;
function judgePass(s, expectTransparent, label) {
  const ok = expectTransparent ? s.transparent && !s.hitPet : !s.transparent && s.hitPet;
  if (ok) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  console.log(`  ✗ ${label} —— 判据不过，实测: ${fmtState(s)}`);
  if (expectTransparent && s.transparent && s.hitPet)
    console.log('    → 形态=「穿透位挂着但 WindowFromPoint 仍命中桌宠」（穿透态点不穿）');
  if (expectTransparent && !s.transparent) console.log('    → 形态=「该穿透时穿透位没挂上」');
  if (!expectTransparent && s.transparent) console.log('    → 形态=「该可交互时穿透位仍挂着」');
  if (!expectTransparent && !s.transparent && !s.hitPet)
    console.log('    → 形态=「穿透位已摘但命中不落桌宠」（可交互态点不进）');
  return false;
}

function connectTarget(target) {
  return (async () => {
    if (!target) throw new Error('CDP 目标不存在');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    const evaluate = (expression) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (msg.result && msg.result.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluate 失败'));
            return;
          }
          resolve(msg.result.result.value);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
    return { evaluate };
  })();
}
const pickTarget = async (port, pick) => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = pick(targets);
  if (!t) throw new Error(`端口 ${port} 上找不到目标：` + targets.map((x) => x.url).join(' | '));
  return t;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const main = await connectTarget(await pickTarget(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]));

// 兜底：页面可能被上一轮运行留在 about:blank；不在就把 pet.html 装回去
const petTarget = async () => {
  const ts = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  return ts.find((t) => t.url && t.url.endsWith('pet.html')) || null;
};
let pt = await petTarget();
if (!pt) {
  console.log('渲染端不是 pet.html（可能被上一轮 verify-main-passthrough 换成 about:blank），恢复中…');
  await main.evaluate(`
    (() => {
      const { BrowserWindow, app } = process.mainModule.require('electron');
      const path = process.mainModule.require('node:path');
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL() === 'about:blank');
      if (!w) return 'no blank window';
      w.loadFile(path.join(app.getAppPath(), 'renderer', 'pet.html'));
      return 'restored';
    })()
  `);
  await wait(2000);
  pt = await petTarget();
  if (!pt) {
    console.error('恢复 pet.html 失败');
    process.exit(1);
  }
}
const pet = await connectTarget(pt);

// 桌宠 HWND 与脸中心必须在 loadURL('about:blank') 之前拿：之后渲染端 URL 匹配不到 pet.html
const petHwnd = parseInt(
  await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('pet.html'));
    if (!w) return '';
    return '0x' + w.getNativeWindowHandle().readBigUInt64LE(0).toString(16);
  })()
`),
  16
);
if (!petHwnd || !IsWindow(petHwnd)) {
  console.error('拿不到有效的桌宠窗口句柄（桌宠没起来？）');
  process.exit(1);
}

const face = JSON.parse(
  await pet.evaluate(`
  (() => {
    const el = document.querySelector('#pet-face');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2 + window.screenX, y: r.top + r.height / 2 + window.screenY });
  })()
`)
);
const bounds = JSON.parse(
  await main.evaluate(`
  (() => {
    const { BrowserWindow, screen } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    return JSON.stringify({ b: w.getBounds(), wa: screen.getPrimaryDisplay().workArea });
  })()
`)
);
console.log('宠物脸中心:', JSON.stringify(face), '窗口:', JSON.stringify(bounds.b));

// 选一个保证在桌宠矩形外（外扩 50px）且在工作区内的远点：四角候选按序取第一个不与桌宠相交的
const pad = 50;
const corners = [
  { x: bounds.wa.x + 30, y: bounds.wa.y + 30 },
  { x: bounds.wa.x + bounds.wa.width - 30, y: bounds.wa.y + 30 },
  { x: bounds.wa.x + 30, y: bounds.wa.y + bounds.wa.height - 30 },
  { x: bounds.wa.x + bounds.wa.width - 30, y: bounds.wa.y + bounds.wa.height - 30 },
];
const far = corners.find(
  (p) =>
    p.x < bounds.b.x - pad || p.x > bounds.b.x + bounds.b.width + pad || p.y < bounds.b.y - pad || p.y > bounds.b.y + bounds.b.height + pad
);
if (!far) {
  console.error('工作区四角都被桌宠矩形覆盖（异常布局），无法选窗外远点');
  process.exit(1);
}

// 渲染端彻底失效：页面换成空白页（没有 pet.js，没有定时器，没有事件处理）
await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    w.loadURL('about:blank');
    return 'renderer blanked';
  })()
`);
await new Promise((r) => setTimeout(r, 1200));

const step = async (label, x, y, expectTransparent) => {
  moveTo(x, y);
  // 变「穿透」要过 600ms 离开保持 + 120ms 轮询；变「可交互」进入即生效
  await sleep(expectTransparent ? 1400 : 900);
  const s = passState(petHwnd);
  console.log(`${label}:`);
  return judgePass(s, expectTransparent, `  ${expectTransparent ? '应穿透' : '应可交互'}`);
};

let ok = true;
ok = (await step(`光标移到宠物脸上 (${face.x},${face.y})`, face.x, face.y, false)) && ok;
ok = (await step(`光标移到窗外远点 (${far.x},${far.y})`, far.x, far.y, true)) && ok;
ok = (await step(`光标再回到脸上 (${face.x},${face.y})`, face.x, face.y, false)) && ok;
console.log(ok ? '结论：渲染端已失效，状态仍随真实光标变化 = 判定确实在主进程（PASS）' : '结论：FAIL');

// 收尾恢复：about:blank 是本脚本的破坏性前置，跑完把 pet.html 装回去，后续工具才能继续用
//（锚点窗是 data: URL 不是 about:blank，不会误伤；pet.html 是否恢复成功不改变本脚本退出码）
await main.evaluate(`
  (() => {
    const { BrowserWindow, app } = process.mainModule.require('electron');
    const path = process.mainModule.require('node:path');
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL() === 'about:blank');
    if (!w) return 'nothing to restore';
    w.loadFile(path.join(app.getAppPath(), 'renderer', 'pet.html'));
    return 'pet.html restored';
  })()
`);
await wait(1200);
process.exit(ok ? 0 : 1);
