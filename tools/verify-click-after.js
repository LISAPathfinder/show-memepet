// @runtime: shared —— hide/walk 后首点击判据，attach 调试端口+真实点击
// 「移动/隐藏后点不动」的受控复现工具（本机实测用，需要 dev 实例带 --inspect=9229 启动）：
//   ① baseline      —— 光标压到形象区中心 → 注入真实左键点击 → 页面必须收到 mousedown（自证工具链可用）
//   ② after-walk    —— 让光标停在形象上等自动让开（同一条 walkPetTo 循环）→ 移到新位置再点。**需
//                      cursorFleeEnabled=true**（装置按 FLEE_TRUE 临时翻上来），关着就是不可测 ⇒ exit 3 不判红
//   ③ 真入口端到端  —— 齿轮→菜单页 menuAction('hide-pet')→hidePet()；再「双击一次 exe」（第二实例）→
//                      second-instance→showPet() 重建 → 首击必须点得动，且句柄必须换（守 1.0.67 的 P3 症状）
//   ④ 同句柄探针    —— CDP 裸调同句柄 hide()/showInactive() → 再点。**机理探针，不计入验收**：产品从 1.0.71
//                      起 showPet 走重建，这条路径没人走（PITFALLS §95）。实测同句柄重显后 mousedown 持续丢失。
// 顺序是判据的一部分：④ 会把这个 HWND 之后的 down 全毒化，所以排到最后——过去它排中间，导致后面的步骤必然假红。
// 每次点击前都用 WindowFromPoint 校验「这一点确实会落到桌宠窗口」，避免把「点到别的窗口」误判成 bug。
// 瞄点走 tools/lib-aim.js（票 11-S 任务 2 换轨）：渲染端上报盒脸中心每步重取 + 「落点不在形象上」
// 前置断言（原「窗口几何中心+20~30px」在 1.0.64 内容矩形模型下落气泡预留区，件却照样报通过）。
// 用法：node tools/verify-click-after.js [dev|<日志路径>]
// 归因旗标（票 11-Y3 T1；默认路径的 ①②③ 三断言不受影响，带旗标时才走实验分支）：
//   --repeat-after-hideshow N  hide→showInactive 后在同一瞄点连点 N 次，逐次报 down/up/click + 焦点三读数
//   --focus-variant show|focus 把「显示」调用换成会夺焦的形态（show()／showInactive()+focus()）做反证
// 退出码（铁律 3）：0 = 断言全绿；1 = 断言失败；3 = 前置不满足（占用/端口/找不到窗/上报盒读不到/落点不在形象上/
//   **④ 的显隐迁移无法证明**（11-Y3 T2 补的锚）/ **② 需要「自动让开」开着而它没开**——这两种都不许判成产品红）。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
const { PreconditionError, loadRectMath, aimAt, computeAim, assertPointOnPet } = require('./lib-aim');

const user32 = koffi.load('user32.dll');
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
// POINT 是**按值**传参（x64 下打包进寄存器）：必须按 int64 传，声明成 void* 传 Buffer 会恒返回 0（踩过）
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr', ['int64']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);
const mouse_event = user32.func('void __stdcall mouse_event(uint32, uint32, uint32, uint32, uintptr)');
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']);
// click-to-focus 判别用：按下那一刻谁是前台窗口（若首击只是激活窗口，前台会在这一击之后才变成桌宠）
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uintptr', []);

// 日志定位：SHOWCASE_DATA_DIR 优先——隔离实例的日志落在数据根，起实例与跑件必须读同一个
// 数据根（§89 根因 3 同族修正，对齐 verify-flee 的解析）；仓库 data/ 只是 dev 回落。
// 候选序双认（票 11-A）；都不存在时回落第一候选（保持旧行为：读不存在路径 = 空读数）。
const DEFAULT_LOG = (() => {
  const roots = [process.env.SHOWCASE_DATA_DIR, path.join(__dirname, '..', 'data')].filter(Boolean);
  for (const root of roots) {
    for (const name of LOG_CANDIDATES) {
      const p = path.join(root, name);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return path.join(roots[0], LOG_CANDIDATES[0]);
})();

// 位置参数只认「看起来像路径」的那个：旗标名（--xxx）和旗标值（如 --repeat-after-hideshow 5）都不能当日志路径，
// 否则 logLines() 静默读空、所有「应用日志=有记录」判据恒假（票 11-Y3 实测踩到；既有 --delay-scan/--aim-scan 同坑）。
const POS = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== 'dev' && (/[\\/]/.test(a) || a.endsWith('.log'))) || '';
const LOG = POS || DEFAULT_LOG;

// 归因旗标（票 11-Y3 T1）
const argVal = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : '';
};
const REPEAT_N = Number(argVal('--repeat-after-hideshow')) || 0;
const FOCUS_VARIANT = ['show', 'focus'].includes(argVal('--focus-variant')) ? argVal('--focus-variant') : '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cursor = () => {
  const b = Buffer.alloc(8);
  GetCursorPos(b);
  return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
};
const hwndAt = (x, y) => Number(WindowFromPoint((BigInt(y >>> 0) << 32n) | BigInt(x >>> 0)));
const className = (h) => {
  const b = Buffer.alloc(256 * 2);
  GetClassNameW(h, b, 256);
  return b.toString('utf16le').replace(/\0.*$/, '') || '(无类名)';
};
const rectOf = (h) => {
  const r = Buffer.alloc(16);
  GetWindowRect(h, r);
  const l = r.readInt32LE(0);
  const t = r.readInt32LE(4);
  return { x: l, y: t, w: r.readInt32LE(8) - l, h: r.readInt32LE(12) - t };
};
const clickAt = (x, y, holdMs = 0) => {
  SetCursorPos(x, y);
  mouse_event(0x0002, 0, 0, 0, 0); // LEFTDOWN
  if (holdMs > 0) {
    // 模拟真人按住的时间：注入 down/up 相隔微秒时，Chromium 可能只留 up（本轮踩过），
    // 量「点不动」时必须给足按下时长，否则测的是注入伪影而不是产品行为
    const end = Date.now() + holdMs;
    while (Date.now() < end) {
      /* 忙等，保持按下 */
    }
  }
  mouse_event(0x0004, 0, 0, 0, 0); // LEFTUP
};

// 可选：在按下之前额外注入一次真实的 MOUSEMOVE（SendInput）。用来分辨
// 「主进程把状态翻成可交互」是否足够 —— 还是必须有一次鼠标移动，点击才会被窗口接收。
let SendInput = null;
let INPUT = null;
try {
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  });
  INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT });
  SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
} catch {
  // koffi 结构体重复定义等情况直接跳过
}
const injectMove = () => {
  if (!SendInput) return;
  const input = { type: 0, mi: { dx: 1, dy: 0, mouseData: 0, dwFlags: 0x0001, time: 0, dwExtraInfo: 0 } };
  SendInput(1, [input], koffi.sizeof(INPUT));
};

function connect(port) {
  return (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = targets.find((x) => x.type === 'node') || targets[0];
    if (!t) throw new Error(`端口 ${port} 上没有调试目标（dev 实例是不是没带 --inspect 启动？）`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
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
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    return { evaluate };
  })();
}

const logSize = () => (fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);
// 用「行数」而不是字节偏移切片：字节偏移在文件被重写/恢复镜像时会错位。
// ⚠ split('\n') 会在结尾多出一个空元素，**它必须丢掉**——否则 before 比真实行数多 1，
// 追加进来的第一行正好落在 slice(before) 之外（本仓实测：②/③ 的锚行一直读不到，件报「应用日志=无记录」
// 而日志文件里明明有那行；「移动完成」能读到只是因为那时已追加了多行。§64 子坑2 同族的位差问题）。
const logLines = () => {
  if (!fs.existsSync(LOG)) return [];
  const arr = fs.readFileSync(LOG, 'utf8').split('\n');
  while (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
};
const newLinesSince = (n) => logLines().slice(n);

async function main() {
  const rectMath = loadRectMath(path.join(__dirname, '..')); // main.js 矩形公式提取失败 = 前置不满足
  const mainProc = await connect(9229);
  // 渲染端连接（记录鼠标事件）：判据用它 —— 比「日志里有没有一行」可靠得多
  // （本轮踩过：应用日志其实记到了点击，我却用日志当判据，得出过完全相反的结论）
  // 必须是 let：showPet() 重建窗口会换渲染页，旧连接随之失效（③ 真入口步骤靠重连才测得下去）
  let renderer = await (async () => {
    const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const t = targets.find((x) => (x.url || '').endsWith('pet.html'));
    if (!t) throw new Error('找不到桌宠页面（--remote-debugging-port=9333 没开？）');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    return (expression) =>
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
  })();

  const installTracer = () =>
    renderer(`(() => {
      window.__mt = [];
      for (const t of ['mousedown', 'mouseup', 'click']) {
        document.addEventListener(t, (e) => {
          window.__mt.push(t + '@' + new Date().toISOString().slice(11, 23) + ' target=' +
            ((e.target && e.target.id) || '?'));
        }, true);
      }
      return 'tracer ready';
    })()`);
  const readTrace = async () => JSON.parse(await renderer('JSON.stringify(window.__mt)'));
  const clearTrace = () => renderer('(window.__mt = [], "ok")');
  await installTracer();

  // --probe-inject：确认「注入的点击有没有进系统」——用桌宠脚下的计数器（全局钩子数的）与渲染端状态做判据，
  // 排掉「注入本身不工作」这种误判。
  if (process.argv.includes('--probe-inject')) {
    const renderer = await (async () => {
      const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      const t = targets.find((x) => (x.url || '').endsWith('pet.html'));
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res) => ws.addEventListener('open', res));
      let seq = 0;
      return (expression) =>
        new Promise((resolve) => {
          const id = ++seq;
          const onMsg = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== id) return;
            ws.removeEventListener('message', onMsg);
            resolve(msg.result?.result?.value);
          };
          ws.addEventListener('message', onMsg);
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
    })();

    const readState = () => renderer('JSON.stringify({ counter: document.getElementById("counter").textContent, state: document.body.dataset.state })');
    // 瞄点换轨（票 11-S 任务 2）：上报盒脸中心 + 「落点不在形象上」前置（不满足 exit 3）
    const aimCtx = await aimAt({ mainProc: mainProc.evaluate, renderer, rectMath, label: 'probe-inject' });
    const aim = aimCtx.aim;

    console.log('注入前：', await readState());
    SetCursorPos(aim.x, aim.y);
    await sleep(800); // 等穿透状态翻过来
    const before = logLines().length;
    clickAt(aim.x, aim.y);
    await sleep(400);
    console.log('注入后（400ms）：', await readState());
    await sleep(1400);
    console.log('注入后（1.8s）：', await readState());
    console.log('新日志行：');
    for (const l of newLinesSince(before).filter((x) => x.trim())) console.log('   >', l.trim());
    process.exit(0);
  }

  // --listen：在渲染端挂捕获阶段监听器，数「页面到底收到没有」——区分「事件没到窗口」和「到了但没人处理」
  if (process.argv.includes('--listen')) {
    const renderer = await (async () => {
      const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      const t = targets.find((x) => (x.url || '').endsWith('pet.html'));
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res) => ws.addEventListener('open', res));
      let seq = 0;
      return (expression) =>
        new Promise((resolve) => {
          const id = ++seq;
          const onMsg = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== id) return;
            ws.removeEventListener('message', onMsg);
            resolve(msg.result?.result?.value);
          };
          ws.addEventListener('message', onMsg);
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
    })();

    await renderer(`(() => {
      window.__ev = { trace: [], lastTarget: '' };
      for (const t of ['mousedown', 'mouseup', 'click', 'mousemove']) {
        document.addEventListener(t, (e) => {
          // buttons 是「按下时有哪些键处于按下状态」：mouseup 时正常应为 0
          window.__ev.trace.push(t + '@' + Math.round(performance.now()) + ' btn=' + e.buttons +
            ' target=' + ((e.target && e.target.id) || (e.target && e.target.className) || '?'));
          if (t === 'mousedown') window.__ev.lastTarget = (e.target && e.target.id) || '?';
        }, true);
      }
      return 'listeners installed';
    })()`);
    const trace = () => renderer('JSON.stringify(window.__ev.trace)');
    const clear = () => renderer('(window.__ev.trace = [], "cleared")');

    // 瞄点换轨（票 11-S 任务 2）：上报盒脸中心 + 前置断言
    const aimCtx = await aimAt({ mainProc: mainProc.evaluate, renderer, rectMath, label: 'listen' });
    const aim = aimCtx.aim;
    SetCursorPos(aim.x - 200, aim.y); // 先离开，让状态复位
    await sleep(1300);
    await clear();
    SetCursorPos(aim.x, aim.y);
    await sleep(700);
    console.log('进入 700ms 后的序列：', await trace());
    const hitNow2 = hwndAt(aim.x, aim.y);
    console.log(`   点时光标处窗口 = 0x${hitNow2.toString(16)}/${className(hitNow2)}`);
    await clear();
    clickAt(aim.x, aim.y, 60); // 按住 60ms：模拟真人点击
    await sleep(800);
    console.log('点击（按住 60ms）后的序列：', await trace());
    console.log('   页面状态 =', await renderer('document.body.dataset.state'));
    process.exit(0);
  }

  // --aim-scan：同一位置反复点几次 + 竖向偏移扫描，判断「落点像素是否参与命中测试」
  // （透明窗口按像素 alpha 命中，形象还有 ±6px 漂浮/颠簸动画 → 同一个点可能时灵时不灵）
  if (process.argv.includes('--aim-scan')) {
    // 基准瞄点换轨上报盒脸中心（票 11-S 任务 2）；dy 扫描是刻意的偏移探针（判哪些像素参与命中），
    // 只对基准点（dy=0）做「落点不在形象上」前置，偏移点不判——不然扫描本身跑不完。每步重取。
    for (const dy of [0, 20, 45, 70, 100]) {
      const scanCtx = await computeAim({ mainProc: mainProc.evaluate, renderer, rectMath, label: 'aim-scan+' + dy });
      if (dy === 0) assertPointOnPet(scanCtx);
      const aim = { x: scanCtx.aim.x, y: scanCtx.aim.y + dy };
      const results = [];
      for (let round = 0; round < 3; round++) {
        SetCursorPos(aim.x - 260, aim.y);
        await sleep(1200);
        await clearTrace();
        SetCursorPos(aim.x, aim.y);
        await sleep(600);
        if (process.argv.includes('--with-move')) {
          injectMove(); // 先动 1px：模拟真人「移过去」最后那点微动
          await sleep(80);
        }
        clickAt(aim.x, aim.y, 60);
        await sleep(700);
        const t = await readTrace();
        results.push(t.some((x) => x.startsWith('mousedown')) ? 'down✓' : 'down✗');
      }
      console.log(`  窗口内纵向偏移 +${String(dy).padStart(3)} → ${results.join(' / ')}`);
    }
    process.exit(0);
  }

  // --synth-move：实验「主进程补一个合成 mousemove 给渲染端」能不能修好「第一下点不动」。
  // 先移动光标到形象上（此时窗口刚从穿透翻成可交互、页面一次 move 都没收到），
  // 对比「补发合成 move」与「不补发」两种情况下，随后的点击能不能被页面收到 down。
  if (process.argv.includes('--synth-move')) {
    const synth = (x, y) =>
      mainProc.evaluate(`
        (() => {
          const { BrowserWindow } = process.mainModule.require('electron');
          const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
          w.webContents.sendInputEvent({ type: 'mouseMove', x: ${x}, y: ${y} });
          return 'sent';
        })()
      `);

    for (const withSynth of [false, true]) {
      // 瞄点换轨（票 11-S 任务 2）：上报盒脸中心 + 前置断言
      const aimCtx = await aimAt({ mainProc: mainProc.evaluate, renderer, rectMath, label: 'synth-move' + withSynth });
      const aim = aimCtx.aim;
      SetCursorPos(aim.x - 260, aim.y);
      await sleep(1300);
      await clearTrace();
      SetCursorPos(aim.x, aim.y);
      await sleep(600); // 主进程最多 250ms 就会把状态翻成可交互
      if (withSynth) await synth(130, 170); // 补一个窗口内坐标的合成 mouseMove
      await sleep(100);
      clickAt(aim.x, aim.y, 60);
      await sleep(800);
      const t = await readTrace();
      console.log(
        `  ${withSynth ? '补发合成 move' : '不补发（默认路径）'} → 页面: ${t.length ? t.join(' | ') : '(什么都没收到)'}`
      );
    }
    process.exit(0);
  }

  // 再以不同延迟注入点击。（这正是「移过去就点」丢点击的量化口径）
  if (process.argv.includes('--delay-scan')) {
    // 瞄点换轨（票 11-S 任务 2）：上报盒脸中心 + 前置断言；复位点仍取窗外
    const scanCtx = await aimAt({ mainProc: mainProc.evaluate, renderer, rectMath, label: 'delay-scan' });
    const aim = scanCtx.aim;
    const away = { x: Math.max(5, scanCtx.info.x - 120), y: aim.y };
    console.log(`形象区目标 ${aim.x},${aim.y}（上报盒脸中心）；复位点（窗外）${away.x},${away.y}`);
    for (const delay of [0, 80, 160, 250, 400, 700, 1200]) {
      SetCursorPos(away.x, away.y);
      await sleep(1300); // 等状态复位成「穿透」（离开保持 600ms）
      const before = logLines().length;
      SetCursorPos(aim.x, aim.y);
      if (delay) await sleep(delay);
      const hitNow = hwndAt(aim.x, aim.y); // 点下去这一刻，这个坐标上真正可点的窗口是谁
      clickAt(aim.x, aim.y);
      await sleep(1200);
      const got = newLinesSince(before).some((l) => /桌宠收到点击/.test(l));
      console.log(
        `  进入后 ${String(delay).padStart(4)}ms 点击 → ${got ? '收到 ✓' : '丢了 ✗'}  （点时光标处窗口：${
          hitNow ? `0x${hitNow.toString(16)}/${className(hitNow)}` : '无'
        }）`
      );
    }
    process.exit(0);
  }

  // 桌宠窗的状态读数（visible/focused/hwnd）——迁移锚与前台归属对照都用它
  const petState = () =>
    mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        const b = Array.from(new Uint8Array(w.getNativeWindowHandle()));
        let hwnd = 0n;
        b.forEach((by, i) => { hwnd += BigInt(by) * (1n << BigInt(8 * i)); });
        return JSON.stringify({ visible: w.isVisible(), focused: w.isFocused(), hwnd: '0x' + hwnd.toString(16) });
      })()
    `);

  // T2（票 11-Y3）：② 过去只用 CDP 裸调 hide()/showInactive()，**全程不落一行日志**，
  // 所以既证明不了迁移发生、也不能证否。现在分两步做并各自回读 isVisible：迁移没做成就是前置问题（exit 3），
  // 不许继续判产品红（§83「决策行与执行行必须成对断言」用到件自己身上）。
  const hideShow = async () => {
    await mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        w.hide();
        return 'hide called';
      })()
    `);
    const afterHide = JSON.parse(await petState());
    if (afterHide.visible !== false) {
      throw new PreconditionError(`② 的 hide() 没生效（isVisible=${String(afterHide.visible)}），这一步的点击读数没有锚`);
    }
    await sleep(700);
    const showCall =
      FOCUS_VARIANT === 'show'
        ? 'w.show();'
        : "w.showInactive(); w.setAlwaysOnTop(true, 'screen-saver');" + (FOCUS_VARIANT === 'focus' ? ' w.focus();' : '');
    await mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        ${showCall}
        return 'show called';
      })()
    `);
    const afterShow = JSON.parse(await petState());
    if (afterShow.visible !== true) {
      throw new PreconditionError(`② 的 show（变体=${FOCUS_VARIANT || 'showInactive'}）没生效（isVisible=${String(afterShow.visible)}）`);
    }
    console.log(`     迁移锚：hide 后 visible=${afterHide.visible} focused=${afterHide.focused} → show 后 visible=${afterShow.visible} focused=${afterShow.focused}`);
    return afterShow;
  };

  // 一次点击测试：先移动光标并等 600ms（模拟人手「移过去再点」），再注入点击（按住 60ms），
  // 判据 = 页面有没有收到 mousedown（收到 down+up+click 才算真的点上了）
  async function clickTest(label) {
    // 瞄点换轨（票 11-S 任务 2）：上报盒脸中心每步重取 + 「落点不在形象上」前置（找不到窗/瞄空 → exit 3）
    const ctx = await aimAt({ mainProc: mainProc.evaluate, renderer, rectMath, label });
    const info = ctx.info;
    const aim = ctx.aim;
    SetCursorPos(aim.x - 260, aim.y); // 先离开窗口，让穿透状态复位
    await sleep(1200);
    await clearTrace();
    SetCursorPos(aim.x, aim.y);
    await sleep(600);
    const before = logLines().length;
    clickAt(aim.x, aim.y, 60);
    await sleep(900);
    const trace = await readTrace();
    const down = trace.some((t) => t.startsWith('mousedown'));
    const up = trace.some((t) => t.startsWith('mouseup'));
    const clickEvt = trace.some((t) => t.startsWith('click'));
    const logged = newLinesSince(before).some((l) => /桌宠收到点击/.test(l));
    console.log(
      `  [${label}] 瞄 ${aim.x},${aim.y}（窗口 ${info.x},${info.y}）→ 页面收到 down=${down ? '✓' : '✗'} up=${
        up ? '✓' : '✗'
      } click=${clickEvt ? '✓' : '✗'}；应用日志=${logged ? '有记录' : '无记录'}`
    );
    if (!down && trace.length) console.log('     页面事件：', trace.join(' | '));
    return down;
  }

  // 连任意一个渲染页（③ 要用菜单页；pet.html 的连接在上面已建好）
  const connectPage = async (urlSuffix) => {
    const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const t = targets.find((x) => (x.url || '').endsWith(urlSuffix));
    if (!t) throw new PreconditionError(`找不到 ${urlSuffix} 页面`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    return (expression) =>
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
  };

  // ③ 真入口端到端（票 11-Y3 A）：齿轮 → 菜单页 menuAction('hide-pet') → hidePet()；
  // 再「双击一次 exe」（第二实例）→ app second-instance → showPet() 重建句柄 → 首击必须点得动。
  // 这条守的是 1.0.67 的 P3 症状（露出旧 HWND 点不动，票 11-T 方案 A 的真人层验收项），
  // 与 ④ 的区别：④ 是 CDP 裸调同句柄 hide/show，产品从 1.0.71 起已不走（§95）。
  async function realEntryTest() {
    const before = logLines().length;
    const st0 = JSON.parse(await petState());
    await renderer(`(() => { const g = document.getElementById('menu-gear'); if (!g) return 'no-gear'; g.click(); return 'gear clicked'; })()`);
    await sleep(900);
    let menuEval;
    try {
      menuEval = await connectPage('menu.html');
    } catch (e) {
      throw new PreconditionError('③ 齿轮没开出菜单页（真入口第一步就走不通）：' + e.message);
    }
    await menuEval(`(() => { window.petAPI.menuAction('hide-pet'); return 'hide-pet dispatched'; })()`);
    // 锚点用轮询而不是单次定点判定：hidePet() 的日志行在 hide() 之后才落，固定 1200ms 实测会抢跑
    let hideAnchored = false;
    let stHidden = st0;
    for (let i = 0; i < 10 && !(hideAnchored && stHidden.visible === false); i++) {
      await sleep(500);
      hideAnchored = newLinesSince(before).some((l) => /隐藏桌宠/.test(l));
      stHidden = JSON.parse(await petState());
    }
    if (!hideAnchored || stHidden.visible !== false) {
      throw new PreconditionError(`③ 真入口隐藏未成功（日志锚=${hideAnchored} isVisible=${stHidden.visible}）——这一步的读数没有锚`);
    }
    console.log(`     ③ 隐藏锚：日志「隐藏桌宠」命中、isVisible=false、HWND=${st0.hwnd}`);
    const exePath = (() => {
      const e = (() => { try { return require('electron'); } catch { return ''; } })();
      return typeof e === 'string' && e ? e : path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
    })();
    const petUserData = String(await mainProc.evaluate('(() => String(process.env.PET_USER_DATA_DIR || ""))()'));
    if (!petUserData) {
      throw new PreconditionError('③ 需要实例带 PET_USER_DATA_DIR 启动（第二实例必须撞同一把单实例锁，否则起的是第二个应用）');
    }
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE; // §64：置空串不算，必须删除该变量
    childEnv.PET_USER_DATA_DIR = petUserData;
    const second = require('child_process').spawn(exePath, [path.join(__dirname, '..')], { env: childEnv, stdio: 'ignore', detached: true });
    second.unref();
    let showAnchored = false;
    let stShown = st0;
    for (let i = 0; i < 14 && !showAnchored; i++) {
      await sleep(700);
      showAnchored = newLinesSince(before).some((l) => /显示桌宠（已重建窗口句柄/.test(l));
      stShown = JSON.parse(await petState());
    }
    if (!showAnchored) throw new PreconditionError('③ 没等到「显示桌宠（已重建窗口句柄」日志行（第二实例没触发 second-instance→showPet？）');
    // 重建换掉的正是**渲染页**：旧 WebSocket 对着已销毁的页面，必须重连 + 重挂事件跟踪器，否则后面读到的
    // down/up 全是旧页面的空读数（假红）
    renderer = await connectPage('pet.html');
    await installTracer();
    const swapped = stShown.hwnd !== st0.hwnd;
    console.log(`     ③ 显示锚：日志命中、isVisible=${stShown.visible}、HWND ${st0.hwnd} → ${stShown.hwnd} ${swapped ? '（已换句柄 ✓）' : '（★同句柄露出＝11-T 回退）'}`);
    const down = await clickTest('real-entry-shown');
    return { down, swapped };
  }

  // ── 归因实验（票 11-Y3 T1）：只在带旗标时走，默认路径的 ①②③ 不受影响 ──────────
  if (REPEAT_N > 0 || FOCUS_VARIANT) {
    console.log('日志:', LOG);
    console.log(
      `实验模式（归因用，不作验收）：--repeat-after-hideshow=${REPEAT_N || 1} --focus-variant=${FOCUS_VARIANT || '(默认 showInactive，不夺焦)'}`
    );
    const focusSnap = async () => {
      const st = JSON.parse(await petState());
      const fg = Number(GetForegroundWindow());
      const fgHex = '0x' + (fg || 0).toString(16);
      return `桌宠{visible=${st.visible} focused=${st.focused} hwnd=${st.hwnd}} 前台窗=${fgHex}/${fg ? className(fg) : '无'}` +
        ` ${fgHex === st.hwnd ? '＝桌宠' : '≠桌宠'}`;
    };
    const baseOk = await clickTest('实验前基线自证');
    console.log(`     基线后读数：${await focusSnap()}`);
    const bState = JSON.parse(await petState());
    if (!bState.visible) {
      console.error('前置不满足：基线后桌宠不可见，读数无效');
      process.exit(3);
    }
    await hideShow();
    await sleep(2200);
    const seq = [];
    for (let r = 1; r <= (REPEAT_N || 1); r++) {
      seq.push(await clickTest(`第${r}击`));
      console.log(`     第${r}击后读数：${await focusSnap()}`);
    }
    const firstLost = !seq[0];
    const laterOk = seq.slice(1).some(Boolean);
    console.log(
      '\nVERDICT: 基线down=' + (baseOk ? '✓' : '✗') + '｜首击' + (firstLost ? '丢' : '不丢') +
      '，后续 ' + seq.slice(1).map((x) => (x ? '✓' : '✗')).join('') +
      (firstLost && laterOk ? ' → click-to-focus 特征成立（首击被用于激活窗口，第二击恢复）' : '') +
      (firstLost && !laterOk ? ' → 首击与后续都丢（不是"首击被激活吃掉"，指向持久的前台/激活归属）' : '') +
      (!firstLost ? ` → 该变体下首击不丢（变体=${FOCUS_VARIANT || 'showInactive'}）` : '')
    );
    process.exit(0);
  }

  console.log('日志:', LOG);
  const results = {};

  // 顺序是判据的一部分（票 11-Y3）：② 会让**同一个 HWND 此后一直丢 mousedown**（实测 10/10），
  // 放在中间就把后面的步骤全带脏——过去 ③ 的红其实是 ② 的下游。所以 ② 排到最后、且不计入验收。
  console.log('\n① baseline（未做任何操作，验证工具链本身能用）');
  results.baseline = await clickTest('baseline');

  console.log('\n② after-walk（光标停在形象上等自动让开，走的是同一条 walkPetTo 循环）');
  // 瞄点换轨（票 11-S 任务 2）：上报盒脸中心 + 前置断言
  const walkCtx = await aimAt({ mainProc: mainProc.evaluate, renderer, rectMath, label: 'after-walk 基准' });
  const aim = walkCtx.aim;
  console.log(`   把光标停在 ${aim.x},${aim.y}（上报盒脸中心，窗口 ${walkCtx.info.x},${walkCtx.info.y}）等 8 秒…`);
  const walkMark = logLines().length;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    SetCursorPos(aim.x, aim.y); // 按住不动，避免真实鼠标打断「停留」判定
  }
  const walkLog = newLinesSince(walkMark).join('\n');
  const walked = /移动完成|走过去/.test(walkLog);
  if (!walked) {
    // 装置会把 cursorFleeEnabled 置 false（防物理鼠标干扰）——那时这一步物理上不可测，
    // 按铁律 3 属前置不满足（exit 3），不许计成产品红（票 11-Y3 T3-③）。
    console.log('   没有触发出走：「自动让开」开关关着 ⇒ 这一步不可测（exit 3，不判红）');
    throw new PreconditionError('after-walk 需要 cursorFleeEnabled=true 才能测（当前让开没触发，8 秒内无「走过去/移动完成」日志）');
  }
  console.log('   已触发出走 / 完成 ✓');
  results.walk = await clickTest('after-walk');

  console.log('\n③ 真入口端到端（齿轮→菜单 hide-pet→hidePet；第二实例→second-instance→showPet 重建）');
  const re = await realEntryTest();
  results.realEntry = re.down;
  results.hwndSwapped = re.swapped;
  if (!re.swapped) {
    console.log('   ★ showPet 没有换句柄——票 11-T 的方案 A 被回退（1.0.67 的 P3 症状会复活）');
  }

  console.log('\n④ 同句柄 hide→show（**机理探针·不计验收**，§95：产品 1.0.71 起已不走这条路径）');
  await hideShow();
  await sleep(2200);
  results.sameHwndProbe = await clickTest('same-hwnd-probe');
  console.log(`   机理读数：同句柄重显后 down=${results.sameHwndProbe ? '✓' : '✗'}（预期✗；这正是产品必须换 HWND 的理由）`);

  console.log('\n结论：', JSON.stringify(results));
  const ok = results.baseline && results.walk && results.realEntry && results.hwndSwapped;
  console.log(
    ok
      ? '验收三项（基线 / 让开后 / 真入口显示后首击）全过 + 句柄已换 ——「点不动」未复现'
      : `有失败项 —— 验收项：baseline=${results.baseline} walk=${results.walk} realEntry=${results.realEntry} swapped=${results.hwndSwapped}（④ 同句柄探针=${results.sameHwndProbe} 不计）`
  );
  process.exit(ok ? 0 : 1);
}

require('./lib-occupancy').assertNoBlockingInstances('verify-click-after.js'); // 占用自检 exit 3（票 11-G 任务 4）
main().catch((err) => {
  if (err instanceof PreconditionError) {
    console.error('前置不满足（exit 3）：' + err.message);
    process.exit(3);
  }
  console.error('脚本异常：' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
