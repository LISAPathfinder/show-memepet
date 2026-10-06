// 验证缩放链路（1.0.30 Ctrl+滚轮 → 1.0.31 Ctrl+拖拽 → 1.0.39 Ctrl 手柄拖动 → 1.0.52 固定窗）：
// 按住 Ctrl 桌宠左上方出现发光三角手柄（比计数栏小一圈），拖手柄缩放——1.0.52 起窗口恒
// 600×600（= 基准 300 × 上限 2）、#pet-root 钉窗口右下角 + transform-origin 右下，拖拽全程
// **零原生窗口操作**（缩放 = 纯 CSS transform，透明窗 setBounds 的陈旧帧闪烁在结构上消失）；
// 松手 scaleEnd 带最终 scale → 主进程钳制、写盘、推送渲染端；拖过量程边界手柄加 limit 类
// （变红保持发光）。
// 票 11-N：④ 的「petPosition 不变」原是无条件断言，缺「起点离左/上缘够远」这个未声明前提
// ——1.0.64 起贴边缩放回挪（按内容矩形）会把贴左缘起点挪回屏内，产品行为正确、断言缺前提。
// 现改为**自设起点 + 方向对拍**：T1 非贴边 (700,600) 必须零位移（锁「回挪不得无条件平移」）；
// T2 贴左缘 (−200,−200) 必须等于按产品同款算法算出的期望（锁「该回挪必须回挪」），并要求
// 日志出现「缩放后回挪 …（内容矩形出屏）」。期望公式与 main.js pet:scale-end 同式：
//   contentX = x + (600 − round(300·s))；contentY = y + (600 − round(160·s))；s 取缩放后新值；
//   dx = max(0, wa.x − contentX)；dy = max(0, wa.y − contentY)。
//   300/160 手抄 main.js 的视觉基准宽与 PET_CONTENT_HEIGHT（同步义务同 verify-pass-hold）。
// 用法（先起带调试端口的隔离实例）：
//   PET_USER_DATA_DIR=<临时目录> SHOWCASE_DATA_DIR=<同一临时目录> \
//     npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/verify-scale.js
// 退出码：0 = 全过；1 = 断言不符；3 = 前置不满足（调试端口连不上 = 隔离实例没起，非被测物坏），
//         stderr 会打出该起的命令。跑完把 petScale 恢复为 1。
// ⚠ 双实例场地（装机版同时在跑）时本件照跑（无占用闸门）但读数可信度降一级（票 11-N 前置提示）。
//   T2 的日志断言走数据根日志文件（identity.LOG_NAME），SHOWCASE_DATA_DIR 从主进程 env 回读。
// 真实 Ctrl 按键（系统级 uiohook）无法在本 harness 内合成，手柄显隐用主进程往
// pet:ctrl 通道注入的方式驱动（与 trackPetCtrl 的下发同一条通道）；按真键的终判留实机验收。
const fs = require('fs');
const path = require('path');
const identity = require('../identity');

// 产品同款回挪期望（票 11-N，与 main.js pet:scale-end 的 :2617–2626 同式）：
// s 必须取**缩放后**的新值；wa 用与回挪同源的 getDisplayNearestPoint(起点).workArea。
// 300 = 视觉基准宽（PET_SIZE）、160 = PET_CONTENT_HEIGHT，均手抄 main.js，改动需同步。
const expectedAfterScale = (x, y, s, wa) => {
  const contentX = x + (600 - Math.round(300 * s));
  const contentY = y + (600 - Math.round(160 * s));
  const dx = Math.max(0, wa.x - contentX);
  const dy = Math.max(0, wa.y - contentY);
  return { x: x + dx, y: y + dy };
};

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
          if (msg.error) {
            reject(new Error(msg.error.message));
            return;
          }
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
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)}`);
}

const PET_WINDOW = 600; // 固定窗边长（与 main.js PET_WINDOW_SIZE 一致）

async function main() {
  // 前置类探测（票 11-E 任务 6a）：连不上调试端口 = 隔离实例没起，属「环境不满足」而非
  // 「被测物坏」——原来落进 catch 报 fetch failed + exit 1，与断言失败同码、分不清责任。
  // 照 verify-petcovered-alpha 的前置类退出码先例（它 exit 3 = 已有实例占用），这里
  // exit 3 = 隔离实例没起/端口不通，并在 stderr 打出该起的命令。
  for (const port of [9333, 9229]) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    } catch {
      console.error(`前置不满足：调试端口 ${port} 连不上（带调试端口的隔离实例没起或已退出）。`);
      console.error('先起隔离实例再跑本件：');
      console.error('  PET_USER_DATA_DIR=<临时目录> npx electron --inspect=9229 --remote-debugging-port=9333 .');
      process.exit(3);
    }
  }
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);

  const readBounds = () =>
    mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        const b = w.getBounds();
        return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height });
      })()
    `).then(JSON.parse);
  const readConfig = () =>
    mainProc
      .evaluate(`(() => { const c = process.mainModule.require('./config'); return JSON.stringify({ petScale: c.get('petScale'), petPosition: c.get('petPosition') }); })()`)
      .then(JSON.parse);
  const readRenderer = () =>
    renderer.evaluate(`
      (() => {
        const root = document.getElementById('pet-root');
        const m = root.style.transform.match(/scale\\(([\\d.]+)\\)/);
        const rr = root.getBoundingClientRect();
        // 只测 #pet-root 容器矩形：脸元素自带 blink pop 弹跳动画，rect 会撞上动画中帧（±12%），
        // 容器矩形无自身动画、随缩放严格等比，且右下角 == (600,600) 直接证明右下角锚定
        return JSON.stringify({
          scale: m ? Math.round(Number(m[1]) * 100) / 100 : null,
          rootW: Math.round(rr.width),
          rootRight: Math.round(rr.right),
          rootBottom: Math.round(rr.bottom),
        });
      })()
    `).then(JSON.parse);

  // 往 pet:ctrl 通道注入 Ctrl 状态（与 main.js trackPetCtrl 下发同一条通道、同一负载形态）
  const sendCtrl = (down) =>
    mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        w.webContents.send('pet:ctrl', { down: ${down} });
        return 'sent';
      })()
    `);

  // 合成手柄拖拽（真实入口）：mousedown 起拖 → mousemove 即时改 transform（固定窗下无窗口
  // 操作可等，无需 sleep 等窗口）→ mouseup scaleEnd 带值持久化。dy 为正 = 向上拖 = 放大
  // （0.005/px：dy 20 = +0.1），dy 为负 = 向下拖 = 缩小；一次起拖可分多拍 move（同一拖拽）。
  let dragOrigin = null;
  const dragBegin = async () => {
    dragOrigin = await renderer
      .evaluate(`(() => {
        const r = document.getElementById('scale-handle').getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`)
      .then(JSON.parse);
    await renderer.evaluate(
      `document.getElementById('scale-handle').dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: ${dragOrigin.x}, clientY: ${dragOrigin.y}, bubbles: true })); 'down'`
    );
  };
  const dragMove = (dy) =>
    renderer.evaluate(
      `document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: ${dragOrigin.x}, clientY: ${dragOrigin.y - dy}, bubbles: true })); 'moved'`
    );
  const dragFinish = (dy) =>
    renderer.evaluate(
      `document.dispatchEvent(new MouseEvent('mouseup', { buttons: 0, clientX: ${dragOrigin.x}, clientY: ${dragOrigin.y - dy}, bubbles: true })); 'up'`
    );
  const limitOn = () => renderer.evaluate(`document.getElementById('scale-handle').classList.contains('limit')`);

  // 起点自设（票 11-N）：不再沿用「机器上桌宠当时停哪」。setPosition 与 config.petPosition
  // 同步写（scaleEnd 的回挪分支只在位移非零时写 config，非贴边零位移时 config 必须已是起点值），
  // 并回读 bounds 作为「起点自设生效」的实现证据。
  const placeAt = async (x, y) => {
    const wa = JSON.parse(
      await mainProc.evaluate(
        `(() => { const { screen } = process.mainModule.require('electron'); return JSON.stringify(screen.getDisplayNearestPoint({ x: ${x}, y: ${y} }).workArea); })()`
      )
    );
    await mainProc.evaluate(
      `(() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        w.setPosition(${x}, ${y});
        process.mainModule.require('./config').set('petPosition', { x: ${x}, y: ${y} });
        return 'placed';
      })()`
    );
    await sleep(300); // 等一拍落稳
    return wa;
  };
  // 数据根日志的 needle 计数（T2 日志断言用；读不到算前置问题）
  const logCount = (needle) => {
    const p = path.join(process.env.SHOWCASE_DATA_DIR || '', identity.LOG_NAME);
    if (!fs.existsSync(p)) {
      console.error(`前置不满足：数据根日志读不到（${p}）——SHOWCASE_DATA_DIR 指向的目录与隔离实例不一致`);
      process.exit(3);
    }
    return fs.readFileSync(p, 'utf8').split(needle).length - 1;
  };

  console.log('⓪ 起点自设（票 11-N）：窗口摆到非贴边 T1 起点 (700,600) + config 同步');
  const waT1 = await placeAt(700, 600);
  const b0 = await readBounds();
  check('起点自设生效：窗口 bounds == (700,600)（evaluate 回读证据，不依赖环境残留）', [b0.x, b0.y], [700, 600]);
  const c0 = await readConfig();
  check('起点自设生效：config petPosition == (700,600)', [c0.petPosition.x, c0.petPosition.y], [700, 600]);

  console.log('① 初始态（固定窗）');
  check('初始窗口 600×600（固定窗不再随缩放变）', [b0.width, b0.height], [PET_WINDOW, PET_WINDOW]);
  check('初始 petScale', c0.petScale, 1);

  console.log('② Ctrl 注入 + 拖手柄到 1.1');
  await sendCtrl(true);
  await sleep(150);
  await dragBegin();
  await dragMove(20); // +20px = +0.1
  await sleep(120);
  const b1 = await readBounds();
  const r1 = await readRenderer();
  const c1 = await readConfig();
  check('拖拽中窗口纹丝不动（600×600，零原生操作）', [b1.width, b1.height], [PET_WINDOW, PET_WINDOW]);
  check('拖拽中 config 不写盘（松手才持久化）', c1.petScale, 1);
  check('渲染端 transform 即时应用', r1.scale, 1.1);
  check('容器 rect 等比变大（穿透适配证据）', r1.rootW, Math.round(300 * 1.1));
  check('容器右下角钉在 (600,600)（右下角锚定证明）', [r1.rootRight, r1.rootBottom], [PET_WINDOW, PET_WINDOW]);

  console.log('③ 同一拖拽继续到 1.5');
  await dragMove(100); // 累计 +100px = +0.5（起始 1.0）
  await sleep(120);
  const b2 = await readBounds();
  const r2 = await readRenderer();
  check('窗口仍 600×600', [b2.width, b2.height], [PET_WINDOW, PET_WINDOW]);
  check('transform 到 1.5', r2.scale, 1.5);
  check('容器 rect 450', r2.rootW, Math.round(300 * 1.5));

  console.log('④ 松手（scaleEnd 带值持久化）');
  await dragFinish(100);
  await sleep(200);
  const c2 = await readConfig();
  const b2b = await readBounds();
  check('config 持久化 1.5', c2.petScale, 1.5);
  check('窗口仍 600×600（松手也不改窗口）', [b2b.width, b2b.height], [PET_WINDOW, PET_WINDOW]);
  // 票 11-N T1：非贴边起点 (700,600) 缩放后必须**零位移**——锁「回挪不得无条件平移窗口」。
  // 期望按产品同款公式现算（s 取缩放后新值 1.5），本场地应得 (700,600) 本身。
  const expT1 = expectedAfterScale(700, 600, c2.petScale, waT1);
  check('T1 非贴边 (700,600)：缩放后 petPosition 零位移', [c2.petPosition.x, c2.petPosition.y], [expT1.x, expT1.y]);
  check('T1 窗口 bounds 同步零位移', [b2b.x, b2b.y], [expT1.x, expT1.y]);

  console.log('⑤ 拖过头（-240px → raw 0.3）→ 下限钳制 0.5 + 顶格红显，松手');
  await dragBegin();
  await dragMove(-240);
  await sleep(120);
  const r3 = await readRenderer();
  check('拖过量程时手柄加 limit 类（变红保持发光）', await limitOn(), true);
  check('transform 钳在 0.5', r3.scale, 0.5);
  check('容器 rect 150', r3.rootW, Math.round(300 * 0.5));
  await dragFinish(-240);
  await sleep(200);
  check('config 钳在 0.5', (await readConfig()).petScale, 0.5);
  check('松手后 limit 类移除', await limitOn(), false);

  console.log('⑥ 滚轮路径已删：合成 Ctrl+滚轮不得再改变缩放');
  await renderer.evaluate(
    `document.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, cancelable: true, bubbles: true }))`
  );
  await sleep(200);
  check('Ctrl+滚轮无效果（防手势重合回归）', (await readConfig()).petScale, 0.5);

  await sendCtrl(false);
  await sleep(150);

  const handleState = () =>
    renderer
      .evaluate(
        `(() => {
          const el = document.getElementById('scale-handle');
          if (!el) return JSON.stringify({ missing: true });
          const r = el.getBoundingClientRect();
          const c = document.getElementById('counter').getBoundingClientRect();
          return JSON.stringify({
            hidden: el.classList.contains('hidden'),
            inWindow: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
            sizeMatch: c.height > 0 && Math.abs(r.height - c.height * 0.65) < 1.5,
          });
        })()`
      )
      .then(JSON.parse);

  console.log('⑦ 缩放手柄显隐与尺寸（1.0.39/1.0.40/1.0.41）：Ctrl 按住出现 → 拖手柄缩放 → 松手持久化 → Ctrl 松开消失');
  check('未按 Ctrl 手柄隐藏', (await handleState()).hidden, true);
  await sendCtrl(true);
  await sleep(150);
  const h1 = await handleState();
  check('Ctrl 按下 → 手柄出现且完整落在窗口内', [h1.hidden, h1.inWindow], [false, true]);
  check('手柄边长 = 计数栏高度×0.65（1.0.41 缩小一圈）', h1.sizeMatch, true);
  // DOM 合成真实手势：按住手柄向上拖 40px = +0.2（0.005/px），从 0.5 → 0.7
  await renderer.evaluate(
    `(() => {
      const el = document.getElementById('scale-handle');
      const r = el.getBoundingClientRect();
      const x0 = Math.round(r.left + r.width / 2);
      const y0 = Math.round(r.top + r.height / 2);
      el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: x0, clientY: y0, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: x0, clientY: y0 - 40, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { buttons: 0, clientX: x0, clientY: y0 - 40, bubbles: true }));
      return 'gestured';
    })()`
  );
  await sleep(250);
  check('拖手柄向上 40px → scale 0.7 且松手已持久化', (await readConfig()).petScale, 0.7);
  await sendCtrl(false);
  await sleep(150);
  check('Ctrl 松开 → 手柄隐藏', (await handleState()).hidden, true);

  console.log('⑧ 旧手势已移除（1.0.39）：Ctrl+按脸拖动不再缩放');
  await renderer.evaluate(
    `(() => {
      const face = document.getElementById('pet-face');
      const r = face.getBoundingClientRect();
      const x0 = Math.round(r.left + r.width / 2);
      const y0 = Math.round(r.top + r.height / 2);
      face.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, clientX: x0, clientY: y0, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, ctrlKey: true, clientX: x0, clientY: y0 - 60, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { buttons: 0, ctrlKey: true, clientX: x0, clientY: y0 - 60, bubbles: true }));
      return 'gestured';
    })()`
  );
  await sleep(250);
  // 60px 若仍走缩放会 +0.3；现在走普通移动（movementX/Y=0 合成事件不会真位移），scale 应保持 0.7
  check('Ctrl+按脸拖动 scale 不变（手势已移交手柄）', (await readConfig()).petScale, 0.7);

  console.log('⑨ 恢复 petScale=1（走真实手柄管线：拖 +60px = +0.3，0.7 → 1.0）');
  await sendCtrl(true);
  await sleep(150);
  await dragBegin();
  await dragMove(60);
  await dragFinish(60);
  await sleep(250);
  await sendCtrl(false);
  await sleep(150);
  check('恢复后 config petScale=1', (await readConfig()).petScale, 1);
  check('恢复后 transform 回 scale(1)', (await readRenderer()).scale, 1);
  check('窗口仍 600×600', [(await readBounds()).width, (await readBounds()).height], [PET_WINDOW, PET_WINDOW]);

  console.log('⑩ T2 贴左缘 (−200,−200)（票 11-N）：缩放后必须按内容矩形回挪');
  // 起点自设同 ⓪；contentX = −200 + (600 − 450) = −50 < wa.x → 产品应回挪 dx=50。
  // 这是旧无条件断言的「缺前提」现场：1.0.63 起 A/B 复跑实测 (−200,−200) → (−150,−200)。
  const waT2 = await placeAt(-200, -200);
  const bT2a = await readBounds();
  check('T2 起点自设生效：bounds == (−200,−200)', [bT2a.x, bT2a.y], [-200, -200]);
  const nudge0 = logCount('缩放后回挪');
  await sendCtrl(true);
  await sleep(150);
  await dragBegin();
  await dragMove(100); // 1.0 → 1.5
  await dragFinish(100);
  await sleep(250);
  await sendCtrl(false);
  await sleep(150);
  const cT2 = await readConfig();
  const bT2 = await readBounds();
  const expT2 = expectedAfterScale(-200, -200, cT2.petScale, waT2);
  check('T2 config petScale=1.5（缩放后新值）', cT2.petScale, 1.5);
  check(
    `T2 petPosition == 产品同款算法期望（dx=max(0,wa.x−contentX)，s 取缩放后新值）`,
    [cT2.petPosition.x, cT2.petPosition.y],
    [expT2.x, expT2.y]
  );
  check('T2 窗口 bounds 同步到期望', [bT2.x, bT2.y], [expT2.x, expT2.y]);
  const nudge1 = logCount('缩放后回挪');
  check('T2 日志出现「缩放后回挪」（内容矩形出屏回挪落日志）', nudge1 > nudge0, true);

  console.log('⑩b 恢复 petScale=1（件尾承诺；恢复拖拽起点贴左缘，1.5→1.0 后内容矩形回屏内无回挪）');
  await sendCtrl(true);
  await sleep(150);
  await dragBegin();
  await dragMove(-100); // 1.5 → 1.0
  await dragFinish(-100);
  await sleep(250);
  await sendCtrl(false);
  await sleep(150);
  check('⑩b 恢复后 config petScale=1', (await readConfig()).petScale, 1);

  console.log(failed === 0 ? '\n✓ Ctrl+拖拽缩放链路全部通过' : `\n✗ ${failed} 项断言不过`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验证失败:', err.message);
  process.exit(1);
});
