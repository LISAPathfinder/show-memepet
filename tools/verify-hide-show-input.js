// 验证「隐藏→显示后点击失效」：判据用应用日志的「桌宠收到点击」（应用自己的记录），
// 注入走 SendInput（此前实测能把点击送进页面并落日志）。dev 实例需带 --inspect/--remote-debugging-port。
//
// ⚠ 本件测的是【无重建】的 showInactive 路径（票 11-T 校验轮⑦ 更正定性）：第②步的「显示」
// 是 CDP 直调 BrowserWindow.showInactive()（:107 附近），与托盘显示的 showPet() 根本不是同一条
// 路径——showPet 不调 showInactive、它整体重建窗口（createPetWindow 换新 HWND）。因此本件的
// 读数只代表「hide 之后被无重建地 showInactive 露出来」这一场景（正是 resync recreate=false /
// second-instance 那族缺口），**不代表托盘显示**；托盘显示的显隐回归由装机版真人 P1 覆盖
// （票 11-T 任务 1 实测：重建后 5/5 可点）。它此前注释里「与 showPet 相同的底层调用」是错的。
// 瞄点走 tools/lib-aim.js（票 11-S 任务 2）：渲染端上报盒脸中心每步重取 + 「落点不在形象上」前置断言。
// 退出码（铁律 3 统一语义，票 11-S 任务 3 归位）：0 = 断言全绿；1 = 断言失败（脚本自身异常
// 也落 1，stderr 打「脚本异常：<原因>」）；3 = 前置不满足（占用冲突 / 调试端口连不上 /
// 端口上没有目标 / 找不到 pet 窗 / 上报盒读不到 / 落点不在形象上）。此前全文件只有
// exit(0)/exit(1)，前置不满足会 exit 0——把「没测」报成「通过」，破 0/1/3 统一口径。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
const { PreconditionError, loadRectMath, aimAt } = require('./lib-aim'); // 瞄点换轨 + 「落点不在形象上」前置（票 11-S 任务 2）

const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT });
const SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
// 迁移期双认（票 11-A）：按候选序取第一个存在的日志文件（改名过渡期旧版可能还在写旧名）；
// 都不存在时回落当前写用名——保持旧行为（读不存在路径 = 空读数），不在此发明新失败模式
const LOG = (() => {
  for (const name of LOG_CANDIDATES) {
    const p = path.join(__dirname, '..', 'data', name);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return path.join(__dirname, '..', 'data', LOG_CANDIDATES[0]);
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (f) => SendInput(1, [{ type: 0, mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: f, time: 0, dwExtraInfo: 0 } }], koffi.sizeof(INPUT));
const logLines = () => fs.readFileSync(LOG, 'utf8').split('\n');
const gotClickSince = (n) => logLines().slice(n).some((l) => /桌宠收到点击/.test(l));

function connect(port, pick) {
  return (async () => {
    let targets;
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch (e) {
      const why = e && e.cause ? e.cause.code || e.cause.message : e.message;
      throw new PreconditionError(`调试端口 ${port} 连不上（${why}）——实例未在跑或缺 --inspect/--remote-debugging-port`);
    }
    const t = pick(targets);
    if (!t) throw new PreconditionError(`端口 ${port} 上没有目标`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new PreconditionError(`端口 ${port} 的 WebSocket 连不上`)));
    });
    let s = 0;
    return (e) =>
      new Promise((res, rej) => {
        const id = ++s;
        const h = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id !== id) return;
          ws.removeEventListener('message', h);
          if (m.result && m.result.exceptionDetails) rej(new Error(m.result.exceptionDetails.exception.description));
          else res(m.result.result.value);
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } }));
      });
  })();
}

async function clickAndCheck(label) {
  // 每步重取：瞄点 = 渲染端上报盒最大盒（脸）中心（票 11-S 任务 2 换轨，原几何中心+30 落气泡预留区）；
  // aimAt 内含前置断言：落点 ∉（上报盒 ∪ 兜底盒 ∪ 内容矩形）→ PreconditionError → exit 3
  const ctx = await aimAt({ mainProc, renderer: rendererProc, rectMath, label });
  const aim = ctx.aim;
  SetCursorPos(aim.x - 260, aim.y);
  await sleep(1200);
  SetCursorPos(aim.x, aim.y);
  await sleep(700); // 等穿透状态翻成可交互（主进程 120ms 轮询）
  const mark = logLines().length;
  send(0x0001);
  send(0x0002);
  await sleep(80);
  send(0x0004);
  await sleep(1200);
  const ok = gotClickSince(mark);
  console.log(
    `  [${label}] 瞄 ${aim.x},${aim.y}（visible=${ctx.info.visible}，脸盒 ${ctx.face.width}x${ctx.face.height}）→ ${
      ok ? '收到点击 ✓' : '没收到 ✗'
    }`
  );
  return ok;
}

let mainProc;
let rendererProc;
let rectMath;
(async () => {
  console.log('【定性】本件测的是无重建的 showInactive 路径（CDP 直调），不代表托盘显示的 showPet() 重建路径（票 11-T）');
  require('./lib-occupancy').assertNoBlockingInstances('verify-hide-show-input.js'); // 占用自检 exit 3（票 11-G 任务 4）
  rectMath = loadRectMath(path.join(__dirname, '..')); // main.js 矩形公式提取失败 = 前置不满足
  mainProc = await connect(9229, (t) => t.find((x) => x.type === 'node') || t[0]); // 旧码 || x[0] 是引用错误，前置路径会炸成脚本异常
  rendererProc = await connect(9333, (t) => t.find((x) => (x.url || '').endsWith('pet.html')));
  const a = await clickAndCheck('① 隐藏前');
  console.log('② 隐藏 → 显示（走菜单隐藏 + CDP 直调 showInactive——无重建路径，≠ showPet 的重建显示）');
  await rendererProc('(() => { window.petAPI.menuAction("hide-pet"); return "hidden"; })()');
  await sleep(800);
  await mainProc(`
    (() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      w.showInactive();
      w.setAlwaysOnTop(true, 'screen-saver');
      return 'shown';
    })()
  `);
  await sleep(1500);
  const b = await clickAndCheck('③ 显示后');
  SetCursorPos(100, 100);
  const ok = a && b;
  console.log(ok ? '\n✓ 隐藏→显示后点击仍正常' : a && !b ? '\n✗ 复现：隐藏→显示后点击失效' : '\n? 隐藏前就不通，测量本身有问题');
  process.exit(ok ? 0 : 1); // 断言失败 1（含「隐藏前就不通」：测不出全绿就不许报 0）
})().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error('前置不满足（exit 3）：' + e.message);
    process.exit(3);
  }
  console.error('脚本异常：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
