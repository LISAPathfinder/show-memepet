// 验证「指针不动但命中区变了」时穿透状态能否自愈（宠物脸漂浮/窗口被拖动都会触发这个情形）。
// 做法（驱动全走真实光标 + 渲染端 box 上报）：
//   1) 真实光标移到宠物脸中心 → 主进程 120ms 轮询应把状态算成可交互；
//   2) 真实光标移到窗口内、交互区外的透明点 → 过 600ms 离开保持后应变穿透；
//   3) 光标不动，把气泡元素临时铺到光标处（交互区并集因此扩大并上报主进程）→
//      状态应在不发任何 mousemove 的情况下翻回可交互（= 自愈）。
// 驱动说明：渲染端 mousemove 处理器已收窄为拖拽专用，合成 mousemove 不再驱动判定（判定与
// 写路径都在主进程），本脚本不用合成事件，改用真实光标驱动。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/verify-passthrough.js
// 退出码：0 = 全部断言通过；1 = 有断言不过或环境不满足（实测读数见输出）。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./lib-occupancy').assertNoBlockingInstances('verify-passthrough.js'); // 占用自检 exit 3（票 11-G 任务 4）
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

const face = JSON.parse(
  await pet.evaluate(`
  (() => {
    const el = document.querySelector('#pet-face');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2 + window.screenX, y: r.top + r.height / 2 + window.screenY });
  })()
`)
);
// 交互元素并集从渲染端拿（纯 DOM）；窗口 bounds 必须从主进程拿（页面里没有 process/electron）
const box = JSON.parse(
  await pet.evaluate(`
  (() => {
    // 与渲染端 interactiveBox() 同口径：交互元素并集（未加 pad）
    const els = document.querySelectorAll('#pet-face, #bubble, #counter, #zzz, #admin-lamp, #menu-gear');
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
      x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
    }
    return JSON.stringify({ x1, y1, x2, y2 });
  })()
`)
);
const b = JSON.parse(
  await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('pet.html'));
    return JSON.stringify(w.getBounds());
  })()
`)
);
console.log(`脸中心: (${face.x},${face.y})  窗口: ${b.x},${b.y} ${b.width}x${b.height}  交互并集(client): ${JSON.stringify(box)}`);

// 选透明点：窗口内、交互并集外 ≥30px（主进程判定区 = 并集 + BOX_PAD6 + JITTER_PAD10）
// 三向候选按序取第一个满足的：顶边中部 / 左边中部 / 右边中部
const margin = 30;
const outsideBox = (cx, cy) => {
  const px = cx - b.x;
  const py = cy - b.y;
  return px < box.x1 - margin || px > box.x2 + margin || py < box.y1 - margin || py > box.y2 + margin;
};
const cands = [
  { x: b.x + b.width / 2, y: b.y + 12 },
  { x: b.x + 12, y: b.y + b.height / 2 },
  { x: b.x + b.width - 12, y: b.y + b.height / 2 },
];
const blank = cands.find((p) => outsideBox(p.x, p.y));
if (!blank) {
  console.error('窗口内找不到交互并集外的透明点（形象铺满窗口？异常布局）');
  process.exit(1);
}

let ok = true;

// 1) 光标移到脸上 → 应为可交互
moveTo(face.x, face.y);
await sleep(900);
let s = passState(petHwnd);
console.log(`步骤1 真实光标移到脸上 (${face.x},${face.y}):`);
ok = judgePass(s, false, '  应可交互') && ok;

// 2) 光标移到窗口内透明点 → 过 600ms 保持后应为穿透
moveTo(blank.x, blank.y);
await sleep(1400);
s = passState(petHwnd);
console.log(`步骤2 真实光标移到透明点 (${blank.x},${blank.y}):`);
ok = judgePass(s, true, '  应穿透') && ok;

// 3) 光标不动，把气泡铺到光标处 → 交互区扩大上报 → 应自愈为可交互
// 铺设手法（1.0.52 固定窗后修正，票 11-E 任务 6b）：#pet-root 恒带 transform（scale 恒等矩阵
// 也算），CSS 规范下它是 fixed 后代的 containing block——直接给 #bubble 设 fixed 坐标会以
// #pet-root 原点 (300,300) 计算，铺不到目标点（实测 elementFromPoint 落 BODY、自愈不触发；
// 五件套 1.0.52 后零读数，一直没暴露）。修法：临时把 #bubble 移挂 body 下（fixed 相对视口），
// 测完复原挂载点与样式。被测语义（气泡=交互元素盖住指针 → 并集扩大 → 主进程自愈）与判据
// 都不变；产品链路不受影响——真实气泡的并集计算走 getBoundingClientRect 视口坐标。
const inject = await pet.evaluate(`
  (() => {
    const root = document.getElementById('pet-root');
    const b = document.getElementById('bubble');
    window.__bubbleStyle = b.getAttribute('style') || '';
    window.__bubbleNext = b.nextSibling;
    document.body.appendChild(b); // 脱离 #pet-root 的 transform containing block
    b.className = '';
    b.style.cssText = 'position:fixed;left:${blank.x - b.x - 30}px;top:${blank.y - b.y - 30}px;width:60px;height:60px;opacity:0.01;z-index:9999;display:block';
    const under = document.elementFromPoint(${blank.x - b.x}, ${blank.y - b.y});
    return '此刻指针下是 ' + ((under || {}).id || (under || {}).tagName);
  })()
`);
console.log(`步骤3 气泡盖住指针（光标不动）: ${inject}`);
await sleep(2200); // 渲染端 1s 定时上报 box 变化 + 主进程重算下发
s = passState(petHwnd);
ok = judgePass(s, false, '  600ms 后应自愈为可交互') && ok;

// 复原，避免影响后续步骤（1.0.52 后挂载点也要还原：bubble 平时在 #pet-root 内随 flex 布局）
await pet.evaluate(`(() => {
  const root = document.getElementById('pet-root');
  const b = document.getElementById('bubble');
  b.style.cssText = window.__bubbleStyle;
  if (window.__bubbleNext && window.__bubbleNext.parentElement === root) root.insertBefore(b, window.__bubbleNext);
  else root.appendChild(b);
  return 'restored';
})()`);
console.log(ok ? '结论：PASS（命中区变化后状态自愈）' : '结论：FAIL');
process.exit(ok ? 0 : 1);
