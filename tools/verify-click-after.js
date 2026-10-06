// 「移动/隐藏后点不动」的受控复现工具（本机实测用，需要 dev 实例带 --inspect=9229 启动）：
//   1) baseline        —— 光标压到形象区中心 → 注入真实左键点击 → 日志应出现「桌宠收到点击」
//   2) after-hide-show —— 经调试端口执行 hide() + showInactive()（与 showPet 同一套底层调用）→ 再点
//   3) after-walk      —— 让光标停在形象上等自动让开（走的是同一条 walkPetTo 循环）→ 移到新位置再点
// 每次点击前都用 WindowFromPoint 校验「这一点确实会落到桌宠窗口」，避免把「点到别的窗口」误判成 bug。
// 瞄点走 tools/lib-aim.js（票 11-S 任务 2 换轨）：渲染端上报盒脸中心每步重取 + 「落点不在形象上」
// 前置断言（原「窗口几何中心+20~30px」在 1.0.64 内容矩形模型下落气泡预留区，件却照样报通过）。
// 用法：node tools/verify-click-after.js [dev|<日志路径>]
// 退出码（铁律 3）：0 = 断言全绿；1 = 断言失败；3 = 前置不满足（占用/端口/找不到窗/上报盒读不到/落点不在形象上）。
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

// 迁移期双认（票 11-A）：dev 默认路径按候选序取第一个存在的日志（改名过渡期旧版可能还在写旧名）；
// 都不存在时回落当前写用名——保持旧行为（读不存在路径 = 空读数）
const DEFAULT_LOG = (() => {
  for (const name of LOG_CANDIDATES) {
    const p = path.join(__dirname, '..', 'data', name);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return path.join(__dirname, '..', 'data', LOG_CANDIDATES[0]);
})();

const LOG =
  process.argv[2] && process.argv[2] !== 'dev'
    ? process.argv[2]
    : DEFAULT_LOG;

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
// 用「行数」而不是字节偏移切片：字节偏移在文件被重写/恢复镜像时会错位
const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n') : []);
const newLinesSince = (n) => logLines().slice(n);

async function main() {
  const rectMath = loadRectMath(path.join(__dirname, '..')); // main.js 矩形公式提取失败 = 前置不满足
  const mainProc = await connect(9229);
  // 渲染端连接（记录鼠标事件）：判据用它 —— 比「日志里有没有一行」可靠得多
  // （本轮踩过：应用日志其实记到了点击，我却用日志当判据，得出过完全相反的结论）
  const renderer = await (async () => {
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

  const hideShow = () =>
    mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        w.hide();
        setTimeout(() => { w.showInactive(); w.setAlwaysOnTop(true, 'screen-saver'); }, 700);
        return 'hidden→shown';
      })()
    `);

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

  console.log('日志:', LOG);
  const results = {};

  console.log('\n① baseline（未做任何操作，验证工具链本身能用）');
  results.baseline = await clickTest('baseline');

  console.log('\n② after-hide-show（hide → showInactive，与「隐藏桌宠」后从托盘显示同一套调用）');
  console.log('  ', await hideShow());
  await sleep(2200);
  results.hideShow = await clickTest('after-hide-show');

  console.log('\n③ after-walk（光标停在形象上等自动让开，走的是同一条 walkPetTo 循环）');
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
  console.log(`   ${walked ? '已触发出走 / 完成 ✓' : '没有触发移动 ✗'}（若关掉了「自动让开」开关，这一步测不到）`);
  results.walk = await clickTest('after-walk');

  console.log('\n结论：', JSON.stringify(results));
  const ok = results.baseline && results.hideShow && results.walk;
  console.log(ok ? '三项都正常 —— 说明这次没能复现「点不动」' : '有失败项 —— 复现了！看上面哪一步开始丢点击');
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
