// @runtime: shared —— 拖拽钳制 12 断言，attach 调试端口 + 真实合成拖拽
// 拖拽屏幕钳制回归（票 14-B）：用户报「Win11 下拖动会越过屏幕边缘」。
// 根因：Electron 的 setPosition 在非整数 DPI 缩放下会把窗口**尺寸**抖大（DIP↔物理往返取整，
// 每步 +1~2px 累积，本机 1.13 缩放实测拖动 30 步 600→679，静置不动），而钳制/摆放判据按
// 600×600 算内容矩形——窗口越大，可见内容被顶出屏幕越多。产品侧改 koffi
// SetWindowPos(SWP_NOSIZE) 只改位置，钳制按真实窗口尺寸算（main.js movePetWindowTo /
// clampPetOriginToWorkArea）。
// 本件断言两件事，缺一不可：
//   ① 连续移动后窗口尺寸不膨胀（≤ 基线+1，DIP 取整噪声）；
//   ② 每次移动后「内容矩形」（真源 core/geometry.js，不手抄）完整落在工作区内（容差 1px），
//      且真的钳到边界（贴边时右/下缘 ≤ 1px、左/上缘 ≥ -1px，防「函数在、没接线」恒绿）。
// ③ 真实手势段（CDP Input.dispatchMouseEvent 带动 movementX）只断言尺寸不膨胀：PITFALLS §73
//    已记合成 movement 在窗口自身移动时会被放大/缩小，走多远不可信，尺寸与钳制可信。
// 用法（先起带调试端口的隔离实例）：
//   PET_USER_DATA_DIR=<临时目录> SHOWCASE_DATA_DIR=<同一临时目录> \
//     npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/verify-drag-clamp.js
// 退出码：0 = 全过；1 = 断言不符；3 = 前置不满足（调试端口连不上 = 隔离实例没起，非被测物坏）。
// 跑完把 petPosition 与窗口位置恢复为跑前状态（共享批的复位拍照吃）。
const fs = require('fs');
const path = require('path');


// §96：CDP 表达式里的配置/几何通道必须用绝对路径 require（只能 realpathSync.native 规范化
// 盘符大小写），否则与产品分裂成两个缓存副本。
const ROOT = (() => {
  const r = path.resolve(__dirname, '..');
  try { return fs.realpathSync.native(r); } catch (e) {
    const fb = r.replace(/^([a-zA-Z]):/, (d) => d.toUpperCase());
    console.error(`⚠ verify-drag-clamp: realpathSync.native 失败（${e.message}）——退回「盘符大写」兜底：${fb}`);
    return fb;
  }
})();
const CFG_REQ = `process.mainModule.require(${JSON.stringify(path.join(ROOT, 'config.js'))})`;
const GEO_REQ = `process.mainModule.require(${JSON.stringify(path.join(ROOT, 'core', 'geometry.js'))})`;

function connect(port, pick) {
  return (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = pick(targets);
    if (!t) throw new Error(`端口 ${port} 上找不到目标页面`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (msg.error) return reject(new Error(msg.error.message));
          resolve(msg.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 失败');
      return r.result.value;
    };
    return { evaluate, send };
  })();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // attach 型件（与 verify-scale 同口径）：不设占用闸门——findBlockingInstances 会把被测的
  // 隔离实例本身算成「已有实例」，而本件判的是被测窗口自己的几何，不靠独占场地。
  for (const port of [9333, 9229]) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    } catch {
      console.error(`前置不满足（exit 3）：调试端口 ${port} 连不上（带调试端口的隔离实例没起或已退出）。`);
      console.error('先起隔离实例再跑本件：');
      console.error('  PET_USER_DATA_DIR=<临时目录> SHOWCASE_DATA_DIR=<同一临时目录> npx electron --inspect=9229 --remote-debugging-port=9333 .');
      process.exit(3);
    }
  }
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);

  // 一次读全：窗口 bounds、当前 scale、内容矩形、工作区（真源 core/geometry 计算，不手抄 600/300/160）。
  // ⚠ 模块实例必须优先取**产品侧**已加载的那份（require.cache 里第一个 config.js / geometry.js）：
  // 本件也用来验收装机产物（Showcase.exe + 调试端口），此时装置仓 ≠ 被测仓——按装置仓绝对路径
  // require 会读到开发仓的 data/config.json，把「产品写盘正确」读成 pos 停在上次的值（§96 同族，
  // 装置侧路径只在产品侧取不到时兜底）。
  const readState = () =>
    mainProc.evaluate(`
      (() => {
        const { BrowserWindow, screen } = process.mainModule.require('electron');
        const pick = (re) => {
          const cache = (process.mainModule.constructor && process.mainModule.constructor._cache) || {};
          const hit = Object.keys(cache).find((k) => re.test(k));
          return hit ? cache[hit].exports : null;
        };
        const geo = pick(/[/\\\\]core[/\\\\]geometry\\.js$/i) || ${GEO_REQ};
        const cfg = pick(/[/\\\\]config\\.js$/i) || ${CFG_REQ};
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        if (!w) return JSON.stringify({ err: 'no pet window' });
        const b = w.getBounds();
        const s = Number(cfg.get('petScale')) || 1;
        // 内容尺寸用 core 真源（contentSize），内收量按**真实窗口尺寸**算——与产品钳制同式。
        // 不能用 petContentRect(origin, s) 的常量 600 模型：非整数 DPI 缩放下窗口尺寸有 ±1
        // 取整噪声（本机 600→605），常量口径会把「产品按真实尺寸钳正确」读成越界 5px 假红。
        const cs = geo.contentSize(s);
        const rect = { x: b.x + b.width - cs.width, y: b.y + b.height - cs.height, width: cs.width, height: cs.height };
        const wa = screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }).workArea;
        return JSON.stringify({ bounds: b, scale: s, rect, wa, pos: cfg.get('petPosition') });
      })()
    `).then(JSON.parse);

  const move = (dx, dy) => renderer.evaluate(`window.petAPI.moveBy(${dx}, ${dy})`);

  // 内容矩形出界量（>0 = 越界）：四边各算一次，取最大
  const overflowOf = (st) => {
    const { rect, wa } = st;
    return Math.max(wa.x - rect.x, rect.x + rect.width - (wa.x + wa.width), wa.y - rect.y, rect.y + rect.height - (wa.y + wa.height), 0);
  };

  const start = await readState();
  if (start.err) {
    console.error(`前置不满足（exit 3）：找不到桌宠窗口（${start.err}）`);
    process.exit(3);
  }
  const w0 = start.bounds.width;
  const h0 = start.bounds.height;
  console.log(`基线：窗口 ${w0}x${h0} @${start.bounds.x},${start.bounds.y}，scale=${start.scale}，` +
    `内容矩形 ${start.rect.width}x${start.rect.height}，工作区 ${start.wa.x},${start.wa.y} ${start.wa.width}x${start.wa.height}`);

  // ---- A. 连续右下推 40 步：尺寸不膨胀 + 内容不越界 + 真的钳到右下 ----
  let grow = 0;
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    await move(400, 400);
    await sleep(25);
    if (i % 8 === 7 || i === 39) {
      const st = await readState();
      grow = Math.max(grow, st.bounds.width - w0, st.bounds.height - h0);
      worst = Math.max(worst, overflowOf(st));
    }
  }
  const endA = await readState();
  check('右下连推 40 步：窗口尺寸不膨胀（≤ 基线+1）', grow <= 1, `最大增量 ${grow}px（基线 ${w0}x${h0} → ${endA.bounds.width}x${endA.bounds.height}）`);
  check('右下连推 40 步：内容矩形始终不出工作区', worst <= 1, `最大越界 ${worst}px`);
  check('右下连推 40 步：真的钳到屏边（内容右缘贴工作区右缘 ±2px）',
    Math.abs(endA.rect.x + endA.rect.width - (endA.wa.x + endA.wa.width)) <= 2,
    `内容右缘 ${endA.rect.x + endA.rect.width} / 工作区右缘 ${endA.wa.x + endA.wa.width}`);
  check('右下连推 40 步：内容下缘也在工作区内（±2px）',
    Math.abs(endA.rect.y + endA.rect.height - (endA.wa.y + endA.wa.height)) <= 2,
    `内容下缘 ${endA.rect.y + endA.rect.height} / 工作区下缘 ${endA.wa.y + endA.wa.height}`);

  // ---- B. 连续左上推 40 步 ----
  grow = 0;
  worst = 0;
  for (let i = 0; i < 40; i++) {
    await move(-400, -400);
    await sleep(25);
    if (i % 8 === 7 || i === 39) {
      const st = await readState();
      grow = Math.max(grow, st.bounds.width - w0, st.bounds.height - h0);
      worst = Math.max(worst, overflowOf(st));
    }
  }
  const endB = await readState();
  check('左上连推 40 步：窗口尺寸不膨胀（≤ 基线+1）', grow <= 1, `最大增量 ${grow}px（→ ${endB.bounds.width}x${endB.bounds.height}）`);
  check('左上连推 40 步：内容矩形始终不出工作区', worst <= 1, `最大越界 ${worst}px`);
  check('左上连推 40 步：真的钳到屏边（内容左/上缘贴工作区边界 ±2px）',
    Math.abs(endB.rect.x - endB.wa.x) <= 2 && Math.abs(endB.rect.y - endB.wa.y) <= 2,
    `内容左上 ${endB.rect.x},${endB.rect.y} / 工作区左上 ${endB.wa.x},${endB.wa.y}`);

  // ---- C. 单步巨量：一步拖到天外（钳制必须兜住，不能依赖多步累积） ----
  await move(99999, 99999);
  await sleep(200);
  const endC = await readState();
  check('单步巨量 (+99999,+99999)：内容矩形不出工作区', overflowOf(endC) <= 1, `越界 ${overflowOf(endC)}px`);
  await move(-99999, -99999);
  await sleep(200);
  const endD = await readState();
  check('单步巨量 (-99999,-99999)：内容矩形不出工作区', overflowOf(endD) <= 1, `越界 ${overflowOf(endD)}px`);

  // ---- D. 真实手势（真实入口 mousedown→mousemove→mouseup）：尺寸不膨胀 + 松手落盘 ----
  await move(400, 0); // 先离左缘远一点，保证手势有位移空间
  await sleep(200);
  const beforeHand = await readState();
  const center = await renderer
    .evaluate(`(() => { const r = document.getElementById('pet-face').getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`)
    .then(JSON.parse);
  const mouse = (type, x, y, buttons) =>
    renderer.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  await mouse('mousePressed', center.x, center.y, 1);
  let cx = center.x;
  let cy = center.y;
  for (let i = 0; i < 30; i++) {
    cx -= 40;
    cy -= 25;
    await mouse('mouseMoved', cx, cy, 1);
    await sleep(16);
  }
  await mouse('mouseReleased', cx, cy, 0);
  await sleep(400);
  const afterHand = await readState();
  check('真实手势拖动 30 拍：窗口尺寸不膨胀（≤ 基线+1）',
    afterHand.bounds.width - beforeHand.bounds.width <= 1 && afterHand.bounds.height - beforeHand.bounds.height <= 1,
    `${beforeHand.bounds.width}x${beforeHand.bounds.height} → ${afterHand.bounds.width}x${afterHand.bounds.height}`);
  check('真实手势松手后：petPosition 落盘 == 窗口当前原点',
    !!afterHand.pos && afterHand.pos.x === afterHand.bounds.x && afterHand.pos.y === afterHand.bounds.y,
    `pos=${JSON.stringify(afterHand.pos)} bounds=${afterHand.bounds.x},${afterHand.bounds.y}`);
  check('真实手势拖动后：内容矩形不出工作区', overflowOf(afterHand) <= 1, `越界 ${overflowOf(afterHand)}px`);

  // ---- 收尾：恢复跑前位置与持久化值（共享批复位拍照吃）----
  // 位置-only 恢复：setBounds/setPosition 都会让窗口尺寸 +1（正是本件在守的回归），
  // 用产品同款 SetWindowPos(SWP_NOSIZE) 才不会把测过的场地再改脏。
  await mainProc.evaluate(`
    (() => {
      const { BrowserWindow, screen } = process.mainModule.require('electron');
      const cache = (process.mainModule.constructor && process.mainModule.constructor._cache) || {};
      const hit = Object.keys(cache).find((k) => /[/\\\\]config\\.js$/i.test(k));
      const cfg = hit ? cache[hit].exports : ${CFG_REQ};
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      cfg.set('petPosition', ${JSON.stringify(start.pos)});
      const p = screen.dipToScreenPoint({ x: ${start.bounds.x}, y: ${start.bounds.y} });
      const koffi = process.mainModule.require(${JSON.stringify(path.join(ROOT, 'node_modules', 'koffi'))});
      const SetWindowPos = koffi.load('user32.dll').func('bool __stdcall SetWindowPos(uintptr h, uintptr after, int x, int y, int cx, int cy, uint32 flags)');
      const hwnd = w.getNativeWindowHandle().readBigUInt64LE(0);
      SetWindowPos(hwnd, 0, Math.round(p.x), Math.round(p.y), 0, 0, 0x15);
      return 'restored';
    })()
  `);
  await sleep(200);
  const restored = await readState();
  check('收尾：位置与 petPosition 已恢复跑前状态',
    restored.bounds.x === start.bounds.x && restored.bounds.y === start.bounds.y &&
      JSON.stringify(restored.pos) === JSON.stringify(start.pos),
    `bounds=${restored.bounds.x},${restored.bounds.y} pos=${JSON.stringify(restored.pos)}`);

  console.log(`\nPASS ${13 - failed} / FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('脚本异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  process.exit(1);
});
