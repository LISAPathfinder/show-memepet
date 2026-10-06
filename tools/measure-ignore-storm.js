// 量化验证：宠物脸上的鼠标移动/拖拽期间，桌宠窗口的穿透状态会被翻转多少次。
// 红线（延续原「200 次移动 → 0~2 次」口径）：200 次合成 mousemove 期间，以约 20Hz 采样
// 「穿透位(ex&0x20) + 命中路由(WindowFromPoint 归属)」组合状态，任一场景翻转 >2 次判失败。
// 口径沿革：旧版数 pet:set-ignore-mouse-events IPC，该口径 1.0.0（897ffd7）起已无渲染端
// 生产者、1.0.25（koffi 直写）后连主进程侧消费者一并消失，恒 0 空转；本轮改采窗口真实状态。
// 瞬态说明：20Hz（50ms）采样会漏掉短于采样间隔的状态变化，报出的翻转次数是下界——
// 启动时先实测 500ms 内采样循环实际触发次数并写进输出（轮询驱动的主进程写入有 120ms
// 轮询周期 + 600ms 保持垫底，50ms 采样对它们足够密；纯瞬态翻转不在本工具覆盖内）。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/measure-ignore-storm.js
// 退出码：0 = 各场景翻转 ≤2；1 = 有场景翻转 >2 或环境不满足（实测读数见输出）。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./lib-occupancy').warnBlockingInstances(); // 测量件只警告不拦（票 11-G 任务 4）
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

// ===== 命中路由层观测（统一口径，koffi 范式照 probe-window-style.js / probe-click-target.js）=====
// 1.0.25 实测（2026-10-02）：桌宠顶层窗穿透态 ex=0x080000a8（带 WS_EX_TRANSPARENT、无 LAYERED），
// 但整块 300x300 上 WindowFromPoint 仍返回 Chrome_RenderWidgetHostHWND（桌宠渲染子窗）——
// 「样式位挂着但点不穿」是被测对象的真 bug，单看 ex 位会漏报，故组合状态含命中路由。
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
// WindowFromPoint 的 POINT 按值传：按 int64 传，低 32 位 x / 高 32 位 y；传 void* 会恒为 0。
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr', ['int64']);
const GetAncestor = user32.func('GetAncestor', 'uintptr', ['uintptr', 'uint32']);
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr']);
const GWL_EXSTYLE = -20;
const GA_ROOT = 2;
const packPoint = (x, y) => (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
const rootOf = (h) => (h ? Number(GetAncestor(h, GA_ROOT)) : 0);
const hitAt = (x, y) => Number(WindowFromPoint(packPoint(x, y)));
const cursorPos = () => {
  const b = Buffer.alloc(8);
  GetCursorPos(b);
  return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const petRoot = rootOf(petHwnd);

// 采样器：脚本进程本地 koffi 直读（不经 CDP，单次读是同步 user32 调用，微秒级）
const SAMPLE_MS = 50; // 目标 ≈20Hz
const samples = [];
let sampling = true;
const sampleOnce = () => {
  if (!IsWindow(petHwnd)) return null;
  const c = cursorPos();
  const hit = hitAt(c.x, c.y);
  const ex = Number(BigInt(GetWindowLongPtrW(petHwnd, GWL_EXSTYLE)) & 0xffffffffn);
  const transparent = !!(ex & 0x20);
  const hitPet = hit !== 0 && rootOf(hit) === petRoot;
  return { ex, transparent, hitPet, hit };
};
const timer = setInterval(() => {
  if (!sampling) return;
  const s = sampleOnce();
  if (s) samples.push({ t: Date.now(), s });
}, SAMPLE_MS);

// 采样频率基准（待核 ○ 的落实：把实测数字写进输出）
const freq = await new Promise((resolve) => {
  let n = 0;
  const t0 = Date.now();
  const iv = setInterval(() => {
    n++;
    if (Date.now() - t0 >= 500) {
      clearInterval(iv);
      resolve(n);
    }
  }, SAMPLE_MS);
});
console.log(`采样频率基准：目标间隔 ${SAMPLE_MS}ms，500ms 实测触发 ${freq} 次 ≈ ${Math.round((freq / 500) * 1000)}Hz`);
console.log(`桌宠 HWND=0x${petHwnd.toString(16)} 根窗口=0x${petRoot.toString(16)}\n`);

const N = 200;
const scenes = {
  '场景一 脸上移动': `
    const face = document.querySelector('#pet-face');
    const r = face.getBoundingClientRect();
    for (let i = 0; i < ${N}; i++) {
      face.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: r.left + r.width / 2 + (i % 3), clientY: r.top + r.height / 2 + (i % 3), buttons: 0,
      }));
    }`,
  '场景二 拖拽桌宠': `
    const face = document.querySelector('#pet-face');
    const r = face.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    face.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy, buttons: 1, button: 0 }));
    for (let i = 0; i < ${N}; i++) {
      face.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + i, clientY: cy + i, buttons: 1, button: 0 }));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx + ${N}, clientY: cy + ${N}, buttons: 0, button: 0 }));`,
  '场景三 透明区移动': `
    for (let i = 0; i < ${N}; i++) {
      document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: i % 5, clientY: i % 5, buttons: 0 }));
    }`,
};

let ok = true;
for (const [name, body] of Object.entries(scenes)) {
  const t0 = Date.now();
  const moved = await pet.evaluate(`(() => { ${body} return ${N}; })()`);
  await sleep(1500); // 尾巴：渲染端上报 + 主进程 120ms 轮询写入落地
  const t1 = Date.now();
  const win = samples.filter((p) => p.t >= t0 - 80 && p.t <= t1); // 80ms 容差带住场景开始前最后一个样本
  let flips = 0;
  let desync = 0; // 失谐样本：穿透位与命中路由矛盾（bug 形态），不计入翻转但单独报
  const flipLog = [];
  for (let i = 1; i < win.length; i++) {
    const a = win[i - 1].s;
    const b2 = win[i].s;
    if (a.transparent !== b2.transparent || a.hitPet !== b2.hitPet) {
      flips++;
      flipLog.push(
        `    ${new Date(win[i].t).toLocaleTimeString()} → EXSTYLE=0x${b2.ex.toString(16).padStart(8, '0')} ` +
          `穿透位=${b2.transparent ? '挂' : '无'} 命中桌宠=${b2.hitPet ? '是' : '否'}`
      );
    }
    if (b2.transparent !== !b2.hitPet) desync++;
  }
  const verdict = flips > 2 ? `✗ FAIL（>2）` : '✓ PASS（≤2）';
  console.log(`${name} x${moved} → 组合状态翻转 ${flips} 次 ${verdict}${desync ? `（另有 ${desync} 个失谐样本：穿透位与命中路由矛盾）` : ''}`);
  if (flips > 2) {
    ok = false;
    console.log('  翻转明细：');
    for (const l of flipLog.slice(0, 12)) console.log(l);
    if (flipLog.length > 12) console.log(`    …共 ${flipLog.length} 次`);
  }
}
clearInterval(timer);
sampling = false;
console.log(ok ? '\n结论：PASS（各场景翻转 ≤2）' : '\n结论：FAIL');
process.exit(ok ? 0 : 1);
