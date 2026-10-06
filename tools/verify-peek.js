// 右键让路穿透（peek）回归件（真断言；1.0.72 内按用户裁决从「置底」改为「变暗变透明」）：
//   前置① 光标压上形象上报盒中心 ≤800ms 翻成可交互（轮询活着，避免「因为没交互能力而全绿」的空测）；
//   A 触发后穿透位（WS_EX_TRANSPARENT）置上 —— 整窗点击穿透（终判层=原生样式位，非记账）；
//   B TOPMOST 位保持置上 —— 让路穿透**不动 z 序**（曾按置底实现，用户裁决取消；桌宠必须仍在 TOPMOST band）；
//   C 未压底 —— z 链下一窗（GW_HWNDNEXT 首跳）存在且不是桌面窗（Progman/WorkerW），即没有沉到桌面层；
//   D 渲染端 body.peek 类在 —— 变暗 + 变透明的视觉已应用；
//   E peek 中段（1.2s~1.85s）busy 监视穿透位**从未被常态轮询翻回** —— 光标此刻正压在桌宠身上，
//     是 syncPetPassThrough 最想翻成「可交互」的位置；peek 守卫失效的话 120ms 内就会被翻回去，
//     这是本功能最刁钻的回归形态（记账与 peek 守卫脱节）；
//   F 到点自动复原：穿透位按光标位置复原（光标仍压在形象上 → 可交互）、TOPMOST 仍置上、
//     body.peek 移除。
// 触发路径走渲染端真实输入管线：CDP Input.dispatchMouseEvent 注入**右键**按下/抬起
// （与真右键同一 DOM mousedown(button=2) → petAPI.peekRequest → 主进程链路；§62 子坑 2
// 提醒 CDP 点击不走 Windows hit-test——本件不拿它验证命中，命中态由前置①先行建立）。
//
// 前置（不满足 exit 3，不计入断言）：
//   · 无装机版实例在跑（tools/lib-occupancy.js 占用自检；dev electron.exe 也算占用——verify 要独占）；
//   · 9229/9333 可连且 pet.html 在；
//   · 前置① 可交互翻转成立。
//
// 用法：node tools/verify-peek.js   （需 dev 隔离实例带 --inspect=9229 --remote-debugging-port=9333）
// 退出码：0 = 断言全绿（末尾 PASS n/N）；1 = 断言失败 / 脚本自身异常（stderr 打「脚本异常：」行）；
//         3 = 前置不满足（占用 / 端口不通 / ① 预期态读不到）。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
require('./lib-occupancy').assertNoBlockingInstances('verify-peek.js');

const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const GetWindow = user32.func('GetWindow', 'uintptr', ['uintptr', 'uint']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']);
const GWL_EXSTYLE = -20;
const GW_HWNDNEXT = 2;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOPMOST = 0x8;
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW']);

// 回落日志路径（隔离实例自己的数据目录经 CDP 解析后再覆盖；见主流程）
const LOG = (() => {
  for (const name of LOG_CANDIDATES) {
    const p = path.join(__dirname, '..', 'data', name);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return path.join(__dirname, '..', 'data', LOG_CANDIDATES[0]);
})();
let LOG_PATH = LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logTail = (n = 4) => {
  try {
    return fs
      .readFileSync(LOG_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .slice(-n)
      .join('\n    ');
  } catch {
    return `（日志读不到：${LOG_PATH}）`;
  }
};

const preFail = (msg) => {
  console.error(`前置不满足（exit 3）：${msg}`);
  process.exit(3);
};

// 与 verify-passthrough-desync.js 同构的 CDP 连接，多暴露一个裸 send（Input 域注入要用）
function connect(port, pick) {
  return (async () => {
    let targets;
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      preFail(
        `调试端口 ${port} 连不上——隔离实例没起或没带调试参数。先起（注意剥 ELECTRON_RUN_AS_NODE、` +
          `SHOWCASE_DATA_DIR 与 PET_USER_DATA_DIR 双传，PITFALLS §89）：` +
          `env -u ELECTRON_RUN_AS_NODE SHOWCASE_DATA_DIR=<临时目录> PET_USER_DATA_DIR=<同目录> ` +
          `node_modules/electron/dist/electron.exe --inspect=9229 --remote-debugging-port=9333 .`
      );
    }
    const t = pick(targets);
    if (!t) preFail(`端口 ${port} 上找不到目标（${port === 9333 ? '需要 pet.html 页面' : '需要主进程 node target'}）`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (msg.error) {
            reject(new Error(`${method}: ${msg.error.message}`));
            return;
          }
          if (msg.result && msg.result.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluate 失败'));
            return;
          }
          resolve(msg.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true }).then((r) => r.result.value);
    return { send, evaluate };
  })();
}

(async () => {
  console.log('[regress] 右键让路穿透：前置① + A~F 计入退出码，前置不满足 exit 3');
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));

  const petBounds = async () =>
    JSON.parse(
      await mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        const b = w.getBounds();
        return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, hwnd: w.getNativeWindowHandle().readBigInt64LE().toString() });
      })()
    `)
    );
  const exOf = (hwnd) => Number(BigInt(GetWindowLongPtrW(Number(BigInt(hwnd)), GWL_EXSTYLE)) & 0xffffffffn);

  // 隔离实例的日志在它自己的数据目录（仓库 data/ 是别的实例的），经 CDP 读真实路径
  try {
    const dir = await mainProc.evaluate(`process.mainModule.require('./config').DATA_DIR`);
    const name = await mainProc.evaluate(`process.mainModule.require('./identity').LOG_NAME`);
    if (dir && name && fs.existsSync(path.join(dir, name))) LOG_PATH = path.join(dir, name);
  } catch {}

  // 瞄准点 = 渲染端实时上报的最大可交互盒（=脸）中心，每步重取（与 desync 件同一口径，§76）
  const aimPoint = async () => {
    const info = await petBounds();
    const raw = await renderer.evaluate('(() => (typeof interactiveBox === "function" ? interactiveBox() : null))()');
    const rects = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((r) => r && r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const box = rects.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return {
      win: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
      screen: { x: info.x + Math.round(box.x + box.width / 2), y: info.y + Math.round(box.y + box.height / 2) },
      info,
    };
  };

  // ---- 前置 ①：光标压上报盒中心 → 轮询应翻成可交互 ----
  const aim = await aimPoint();
  if (!aim) preFail('渲染端上报的可交互盒读不到（interactiveBox() 为空）——页面没就绪或交互元素全隐藏');
  SetCursorPos(aim.screen.x, aim.screen.y);
  await sleep(800);
  let ex = exOf(aim.info.hwnd);
  console.log(`① 瞄上报盒中心 屏幕${aim.screen.x},${aim.screen.y}（窗口 ${aim.info.x},${aim.info.y} ${aim.info.w}x${aim.info.h}），ex=0x${ex.toString(16)}`);
  if (ex & WS_EX_TRANSPARENT)
    preFail(`① 光标压在形象上报盒中心 800ms 后仍是穿透（期望可交互）。轮询没翻面：实例不是带调试端口的隔离实例、或主进程轮询已坏`);

  // ---- 触发：CDP 注入右键 按下/抬起（viewport 坐标 = 窗口内坐标）----
  await renderer.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: aim.win.x, y: aim.win.y, button: 'right', buttons: 2, clickCount: 1,
  });
  await renderer.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: aim.win.x, y: aim.win.y, button: 'right', buttons: 0, clickCount: 1,
  });
  const t0 = Date.now();
  await sleep(400);

  const peekState = async () => {
    const info = await petBounds();
    const ex = exOf(info.hwnd);
    const peekClass = await renderer.evaluate('document.body.classList.contains("peek")');
    return { info, ex, transparent: (ex & WS_EX_TRANSPARENT) !== 0, topmost: (ex & WS_EX_TOPMOST) !== 0, peekClass };
  };

  // ---- 断言 A/B/D：穿透位置上 + TOPMOST 保持 + body.peek 在 ----
  const st1 = await peekState();
  console.log(`A/B/D 触发后 400ms：ex=0x${st1.ex.toString(16)} 穿透位=${st1.transparent} TOPMOST=${st1.topmost} body.peek=${st1.peekClass}`);
  const okA = st1.transparent;
  const okB = st1.topmost === true;
  const okD = st1.peekClass === true;
  if (!okA || !okB || !okD) console.log('   日志 >', logTail(4));

  // ---- 断言 C：未压底（z 链下一窗存在且不是桌面窗）----
  const hwndNum = Number(BigInt(st1.info.hwnd));
  const nextHwnd = GetWindow(hwndNum, GW_HWNDNEXT);
  let nextCls = null;
  if (nextHwnd) {
    const buf = Buffer.alloc(512);
    const n = GetClassNameW(nextHwnd, buf, 256);
    nextCls = n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
  }
  const okC = !!nextHwnd && !DESKTOP_CLASSES.has(nextCls);
  console.log(`C 未压底：z 链下一窗 = ${nextHwnd ? `${nextCls}（0x${nextHwnd.toString(16)}）` : '无（已是 z 序最底）'} → ${okC ? '桌宠仍在窗口层 ✓' : '沉到桌面层了 ✗'}`);

  // ---- 断言 E：peek 中段（1.2s→1.85s）穿透位从未被常态轮询翻回 ----
  // 光标正压在形象上（前置①摆的位），常态机此刻最想翻「可交互」；peek 守卫失效的话
  // 一个轮询拍（120ms）内穿透位就会被摘掉。busy 监视这一整窗。
  while (Date.now() - t0 < 1200) await sleep(20);
  let sawInteractive = false;
  while (Date.now() - t0 < 1850) {
    if ((exOf(st1.info.hwnd) & WS_EX_TRANSPARENT) === 0) {
      sawInteractive = true;
      break;
    }
  }
  const okE = !sawInteractive;
  console.log(`E peek 中段 1.2s~1.85s busy 监视：穿透位被翻回=${sawInteractive}（期望 false——光标压在桌宠上时 peek 必须独占状态）→ ${okE ? '无脱守 ✓' : '被轮询翻回 ✗'}`);
  if (sawInteractive) console.log('   日志 >', logTail(6));

  // ---- 断言 F：到点自动复原（穿透位按光标复原 + TOPMOST 仍在 + body.peek 移除）----
  let restored = false;
  while (Date.now() - t0 < 4200) {
    if ((exOf(st1.info.hwnd) & WS_EX_TRANSPARENT) === 0) {
      restored = true;
      break;
    }
    await sleep(20);
  }
  await sleep(400); // 留给 endPetPeek 的 force 重算与渲染端 class 移除
  const st2 = await peekState();
  const okF = restored && !st2.transparent && st2.topmost && st2.peekClass === false;
  console.log(
    `F 复原（触发后 ${Date.now() - t0}ms 读）：穿透位=${st2.transparent}（光标仍压形象 → 期望 false）TOPMOST=${st2.topmost} body.peek=${st2.peekClass} → ${okF ? '复原 ✓' : '未复原 ✗'}`
  );
  if (!okF) console.log('   日志 >', logTail(6));

  // 收尾：光标挪离窗口，别让余态影响下一个人
  SetCursorPos(Math.max(5, st1.info.x - 200), 5);

  const results = [
    { seg: 'A 穿透位（WS_EX_TRANSPARENT）置上', expect: 'true', actual: String(st1.transparent), ok: okA },
    { seg: 'B TOPMOST 位保持置上（不动 z 序）', expect: 'true', actual: String(st1.topmost), ok: okB },
    { seg: 'C 未压底（z 链下一窗非桌面窗）', expect: '非 Progman/WorkerW', actual: nextHwnd ? String(nextCls) : '无下一窗', ok: okC },
    { seg: 'D 渲染端 body.peek（变暗变透明）', expect: 'true', actual: String(st1.peekClass), ok: okD },
    { seg: 'E peek 中段穿透位从未被轮询翻回', expect: 'false', actual: String(sawInteractive), ok: okE },
    { seg: 'F 到点自动复原（常态穿透+去视觉）', expect: '全部复原', actual: `transparent=${st2.transparent} topmost=${st2.topmost} peek=${st2.peekClass}`, ok: okF },
  ];
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n断言失败 ${failed.length}/${results.length}：`);
    for (const f of failed) console.error(`  段 ${f.seg}：期望 ${f.expect}；实读 ${f.actual}`);
  }
  console.log(`PASS ${passed}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  // 脚本自身异常也落 1，但打「脚本异常：」行与断言失败区分（票 11-G 任务 4 退出码语义）
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exit(1);
});
