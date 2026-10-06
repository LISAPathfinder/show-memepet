// 验证救援动作的渲染端一半：主进程发 pet:force-interactive 后，
// 桌宠应弹出菜单窗口，且救援链路不得把穿透状态搞坏（光标在脸上时应保持可交互）。
// 边界（与旧版一致）：真实按键（Ctrl→Alt→P）走的是系统级钩子，注入不了合成按键，
// rescuePet() 主进程侧的强制下发（nativeSetIgnoreMouseEvents(false)）不在本脚本覆盖内；
// 这里覆盖的是「主进程决定救援之后」的链路。
// 前置：把真实光标移到宠物脸上并等轮询收敛——救援断言建立在正常状态上。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/verify-rescue.js
// 退出码：0 = 全部断言通过；1 = 有断言不过或环境不满足（实测读数见输出）。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./lib-occupancy').assertNoBlockingInstances('verify-rescue.js'); // 占用自检 exit 3（票 11-G 任务 4）
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

const main = await connectTarget(await pickTarget(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]));

// 兜底：页面可能被 verify-main-passthrough 的上一轮运行留在 about:blank；不在就把 pet.html 装回去
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

// 前置：真实光标移到宠物脸中心，等主进程轮询收敛为可交互
const face = JSON.parse(
  await pet.evaluate(`
  (() => {
    const el = document.querySelector('#pet-face');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2 + window.screenX, y: r.top + r.height / 2 + window.screenY });
  })()
`)
);
moveTo(face.x, face.y);
await sleep(900);
let ok = true;
const before = passState(petHwnd);
console.log('救援前:', fmtState(before));
ok = judgePass(before, false, '  前置：光标在脸上应为可交互') && ok;

// 模拟主进程的救援动作：给桌宠发 pet:force-interactive
console.log(
  '发送 pet:force-interactive:',
  await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    if (!w) return '找不到桌宠窗口';
    w.webContents.send('pet:force-interactive');
    return 'sent';
  })()
`)
);

await sleep(1200);

// 断言 1：菜单窗口应出现（渲染端 onForceInteractive → openMenuAt 的落地）
const windows = await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    return BrowserWindow.getAllWindows().map((w) => w.webContents.getURL().split('/').pop()).join(', ');
  })()
`);
console.log(`  救援后窗口列表 = [${windows}]`);
if (windows.split(', ').includes('menu.html')) {
  console.log('  ✓ 菜单窗口已弹出');
} else {
  console.log('  ✗ 菜单窗口未出现（渲染端 onForceInteractive → menu:open-at 链路断了？）');
  ok = false;
}

// 断言 2：救援不得把状态搞坏——光标仍在脸上，应保持可交互
const after = passState(petHwnd);
console.log('救援后:', fmtState(after));
ok = judgePass(after, false, '  救援后应保持可交互') && ok;

console.log(ok ? '结论：PASS' : '结论：FAIL');
process.exit(ok ? 0 : 1);
