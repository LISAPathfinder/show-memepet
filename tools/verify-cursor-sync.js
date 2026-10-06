// 验证「页面重载后穿透状态是否立刻正确」——对应渲染进程被外部杀掉 → 自动重载后的真实场景。
// 做法：把真实光标放到宠物脸上 → 重载桌宠页面（重载后没有任何 mousemove）→
//       看主进程 120ms 轮询能否立刻把状态算成可交互。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/verify-cursor-sync.js --face
// 退出码：0 = 全部断言通过；1 = 有断言不过或环境不满足（实测读数见输出）。
// 端口写死为字面量（不接受外部输入），需要换端口时改下面两行。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./lib-occupancy').assertNoBlockingInstances('verify-cursor-sync.js'); // 占用自检 exit 3（票 11-G 任务 4）
const MAIN_LIST = 'http://127.0.0.1:9229/json/list';
const RENDERER_LIST = 'http://127.0.0.1:9333/json/list';

// ===== 命中路由层判据（统一口径，koffi 范式照 probe-window-style.js / probe-click-target.js）=====
// 1.0.25 实测（2026-10-02）：桌宠顶层窗穿透态 ex=0x080000a8（带 WS_EX_TRANSPARENT、无 LAYERED），
// 但整块 300x300 上 WindowFromPoint 仍返回 Chrome_RenderWidgetHostHWND（桌宠渲染子窗）——
// 「样式位挂着但点不穿」是被测对象的真 bug。因此判据必须两层组合，只看 ex 位会把 bug 判成绿：
//   预期穿透   = ex 带 0x20 且 WindowFromPoint(光标处) 的 GA_ROOT 不是桌宠顶层窗
//   预期可交互 = ex 不带 0x20 且 WindowFromPoint(光标处) 的 GA_ROOT 是桌宠顶层窗
// 只满足 ex 位（任一方向）= fail。钩子观测（BrowserWindow.prototype 钩子仅剩锚点窗会经过）
// 迁移到本口径的整体改造押后（穿透写路径可能被样式矩阵探针会话并行改掉），本轮先落判据与退出码。
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
// WindowFromPoint 的 POINT 按值传（x64 下 8 字节进寄存器）：按 int64 传，低 32 位 x / 高 32 位 y；
// 声明成 void* 传 Buffer 会传成指针、结果恒为 0（probe-click-target.js 踩过的坑）。
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

// 从主进程拿桌宠顶层窗 HWND（返回 '0x...' 字符串；必须在页面换成非 pet.html 之前拿）
const petHwndExpr = `
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('pet.html'));
    if (!w) return '';
    return '0x' + w.getNativeWindowHandle().readBigUInt64LE(0).toString(16);
  })()
`;

// 只接受 CDP 返回的目标对象（URL 来自 CDP 响应，不由参数拼装）
async function openTarget(target) {
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
        if (msg.error) return reject(new Error(msg.error.message));
        if (msg.result && msg.result.exceptionDetails) return reject(new Error('evaluate 失败'));
        if (!msg.result) return reject(new Error('CDP 返回里既没有 result 也没有 error'));
        resolve(msg.result.result.value);
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  return { evaluate };
}

const mainTargets = await (await fetch(MAIN_LIST)).json();
const main = await openTarget(mainTargets.find((t) => t.type === 'node') || mainTargets[0]);

// 把真实光标移到「宠物脸」的屏幕中心（用系统 API，产生真实光标事件）。
// 不能用窗口中心：桌宠形象只占窗口的一部分，窗口中心常常落在透明区。
// 兜底：页面可能被 verify-main-passthrough 的上一轮运行留在 about:blank；不在就把 pet.html 装回去。
// 恢复必须先于 HWND 获取——about:blank 时 URL 匹配不到 pet.html，拿不到句柄。
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let petTargets = await (await fetch(RENDERER_LIST)).json();
let petT = petTargets.find((t) => t.url && t.url.endsWith('pet.html'));
if (!petT) {
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
  petTargets = await (await fetch(RENDERER_LIST)).json();
  petT = petTargets.find((t) => t.url && t.url.endsWith('pet.html'));
  if (!petT) {
    console.error('恢复 pet.html 失败');
    process.exit(1);
  }
}
const pet = await openTarget(petT);

const petHwnd = parseInt(await main.evaluate(petHwndExpr), 16);
if (!petHwnd || !IsWindow(petHwnd)) {
  console.error('拿不到有效的桌宠窗口句柄（桌宠没起来？）');
  process.exit(1);
}

if (process.argv[2] !== '--face') {
  console.error('本脚本断言「光标在宠物脸上时重载后应恢复可交互」，无确定预期则断言无意义。');
  console.error('用法：node tools/verify-cursor-sync.js --face');
  process.exit(1);
}

const rect = JSON.parse(
  await pet.evaluate(`
    (() => {
      const el = document.querySelector('#pet-face');
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2 + window.screenX, y: r.top + r.height / 2 + window.screenY, w: r.width, h: r.height });
    })()
  `)
);
const x = Math.round(rect.x);
const y = Math.round(rect.y);
moveTo(x, y);
console.log(`已把真实光标移到宠物脸中心 (${x},${y})，脸尺寸 ${Math.round(rect.w)}x${Math.round(rect.h)}`);
await sleep(800);

let ok = true;
const before = passState(petHwnd);
console.log('重载前:', fmtState(before));
ok = judgePass(before, false, '重载前：光标在脸上应为可交互') && ok;

// 重载页面：模拟渲染进程被外部杀掉后的自动重载。重载后没有任何 mousemove，
// 唯一能算出穿透状态的途径就是主进程按真实光标位置判定（reload 不重建窗口，HWND 不变）。
await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    w.webContents.reload();
    return 'reloaded';
  })()
`);
await sleep(2500);

const after = passState(petHwnd);
console.log('重载后:', fmtState(after));
ok = judgePass(after, false, '重载后：无任何 mousemove 也应恢复可交互') && ok;

console.log(ok ? '结论：PASS' : '结论：FAIL');
process.exit(ok ? 0 : 1);
