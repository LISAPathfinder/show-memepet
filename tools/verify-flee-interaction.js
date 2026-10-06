// 验证「点击互动期间不触发让开 + 点击打断 5 秒计时」（dev 实例带 --inspect 启动时用）：
//   A) 按住左键 8 秒（超过 5 秒阈值）→ 期间不得出现「让开」；松开后重新计时，约 5 秒后应让开
//   B) 每 2 秒点一下、连点 5 次（共约 10 秒）→ 期间不得出现「让开」（每次点击都清零计时）
// 判据取应用日志里的「让开」行（真实行为），瞄点走 tools/lib-aim.js（票 11-S 任务 2 换轨）：
// 渲染端上报盒脸中心每步重取 + 「落点不在形象上」前置断言——原几何中心+40 落气泡预留区。
// 退出码（铁律 3）：0 = 断言全绿；1 = 断言失败；3 = 前置不满足（占用/端口/找不到窗/上报盒读不到/落点不在形象上）。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
const { PreconditionError, loadRectMath, aimAt } = require('./lib-aim');

const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});
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
const lines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n') : []);
const fledSince = (n) => lines().slice(n).filter((l) => /让开/.test(l));

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

const send = (flags) => {
  const input = { type: 0, mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } };
  SendInput(1, [input], koffi.sizeof(INPUT));
};

(async () => {
  require('./lib-occupancy').assertNoBlockingInstances('verify-flee-interaction.js'); // 占用自检 exit 3（票 11-G 任务 4）
  const rectMath = loadRectMath(path.join(__dirname, '..')); // main.js 矩形公式提取失败 = 前置不满足
  const m = await connect(9229, (t) => t.find((x) => x.type === 'node') || t[0]);
  const renderer = await connect(9333, (t) => t.find((x) => (x.url || '').endsWith('pet.html')));
  // 瞄点换轨（票 11-S 任务 2）：上报盒脸中心 + 「落点不在形象上」前置断言（不满足 exit 3）
  const ctx = await aimAt({ mainProc: m, renderer, rectMath, label: 'A 按住' });
  const aim = ctx.aim;
  console.log(
    `桌宠窗口 ${ctx.info.x},${ctx.info.y}；光标瞄 ${aim.x},${aim.y}（上报盒脸中心 ${ctx.face.width}x${ctx.face.height}）`
  );

  // ---- A) 按住 8 秒 ----
  SetCursorPos(aim.x, aim.y);
  await sleep(300);
  const holdMark = lines().length;
  send(0x0001); // MOVE
  send(0x0002); // LEFTDOWN
  console.log('A) 按住左键 8 秒（阈值 5 秒，按理不该让开）…');
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    SetCursorPos(aim.x, aim.y); // 保持光标不动（防止真实鼠标干扰）
  }
  const duringHold = fledSince(holdMark).length;
  send(0x0004); // LEFTUP
  console.log(`   按住期间出现「让开」次数 = ${duringHold} → ${duringHold === 0 ? '✓ 未触发（符合预期）' : '✗ 触发了'}`);

  // 松手后重新计时：约 5~6.5 秒内应该让开一次
  const releaseMark = lines().length;
  await sleep(6500);
  const afterRelease = fledSince(releaseMark).length;
  console.log(`   松手后 6.5 秒内出现「让开」次数 = ${afterRelease} → ${afterRelease >= 1 ? '✓ 计时重新开始并触发' : '✗ 没有触发'}`);

  // ---- B) 每 2 秒点一下，连点 5 次 ----
  // 先等宠物从上次让开的位置稳定下来，重新瞄准（每步重取）
  await sleep(1500);
  const ctx2 = await aimAt({ mainProc: m, renderer, rectMath, label: 'B 连点' });
  const aim2 = ctx2.aim;
  console.log(`重新瞄 ${aim2.x},${aim2.y}（窗口 ${ctx2.info.x},${ctx2.info.y}）`);
  const clickMark = lines().length;
  console.log(`B) 每 2 秒点一次、共 5 次（合计约 10 秒 > 5 秒阈值）…`);
  for (let i = 0; i < 5; i++) {
    SetCursorPos(aim2.x, aim2.y);
    send(0x0001);
    send(0x0002);
    await sleep(60);
    send(0x0004);
    await sleep(1940);
  }
  const duringClicks = fledSince(clickMark).length;
  console.log(`   连点期间出现「让开」次数 = ${duringClicks} → ${duringClicks === 0 ? '✓ 未触发（点击打断了计时）' : '✗ 触发了'}`);

  SetCursorPos(aim2.x - 300, aim2.y);
  const ok = duringHold === 0 && afterRelease >= 1 && duringClicks === 0;
  console.log(ok ? '\n✓ 新规则成立：按住/点击期间不让开，松手后重新计时' : '\n✗ 有不符预期的项');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error('前置不满足（exit 3）：' + e.message);
    process.exit(3);
  }
  console.error('脚本异常：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
