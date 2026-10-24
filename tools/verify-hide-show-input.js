// @runtime: shared —— 真入口显隐后输入连通判据，attach 调试端口+真实点击
// 验证「隐藏→显示后点击失效」：判据用应用日志的「桌宠收到点击」（应用自己的记录），
// 注入走 SendInput（此前实测能把点击送进页面并落日志）。dev 实例需带 --inspect/--remote-debugging-port。
//
// ⚠ 路径定性（票 11-Y3 改判，2026-10-09）：原先第③步用 CDP 直调 `showInactive()` 把隐藏的窗
// 「无重建地」露出来，而产品自 1.0.71 起 `showPet()` 走 `recreatePetWindow` 换 HWND、resync 里的
// showInactive 又被票 11-T 的 petHidden 守卫跳过 ⇒ 那条路径**已经没人走**，件却长期把它计成产品红
// （机理与实测见 PITFALLS §95：同句柄 hide→show 后 mousedown 持续丢失，10/10，`up` 仍送达）。
// 现在 ③ 改走**真入口**（再起一个实例 → second-instance → showPet 重建），于是本件与
// verify-click-after 成了**同一条用户路径上的两台独立仪器**：那件读渲染端 DOM 事件，本件读应用日志。
// 顺带修掉本件自己的读日志坑：logLines 原先没去 `split('\\n')` 的尾部空元素，mark 多算 1 行，
// 当点击只落一行日志时 `slice(mark)` 正好把它漏掉 ⇒ 整件恒「没收到」（§95 同族的位差问题）。
// 瞄点走 tools/lib-aim.js（票 11-S 任务 2）：渲染端上报盒脸中心每步重取 + 「落点不在形象上」前置断言。
// 退出码（铁律 3 统一语义，票 11-S 任务 3 归位）：0 = 断言全绿；1 = 断言失败（脚本自身异常
// 也落 1，stderr 打「脚本异常：<原因>」）；3 = 前置不满足（占用冲突 / 调试端口连不上 /
// 端口上没有目标 / 找不到 pet 窗 / 上报盒读不到 / 落点不在形象上）。此前全文件只有
// exit(0)/exit(1)，前置不满足会 exit 0——把「没测」报成「通过」，破 0/1/3 统一口径。
// 票 11-Y3 T3-② 追加两类 3：① 自证步骤收不到点击（仪器不通，后续读数无判据力）、真入口显示锚等不到。
// 装置聚合里 exit 3 同样不算通过，所以"不许溜绿"这条没有损失，只是不再把测量失效说成产品缺陷。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
const { PreconditionError, loadRectMath, aimAt } = require('./lib-aim'); // 瞄点换轨 + 「落点不在形象上」前置（票 11-S 任务 2）
const { showPetBySecondInstance } = require('./lib-show-pet'); // 票 14-I：真入口显示（第二实例→showPet 重建）

const user32 = koffi.load('user32.dll');
const { dipSetter, readDipScale } = require('./lib-cursor'); // 票 14-G：DIP→物理换算
// 件里的坐标全是 DIP，这个 setter 吃 DIP、发物理像素（定义见 lib-cursor）
let DIP_SCALE = 0;
const SetCursorPos = dipSetter(() => DIP_SCALE);
const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT });
const SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
// 日志定位：SHOWCASE_DATA_DIR 优先——隔离实例的日志落在数据根，起实例与跑件必须读同一个
// 数据根（§89 根因 3 同族修正，对齐 verify-flee 的解析）；仓库 data/ 只是 dev 回落。
// 候选序双认（票 11-A）；都不存在时回落第一候选（保持旧行为：读不存在路径 = 空读数）。
const LOG = (() => {
  const roots = [process.env.SHOWCASE_DATA_DIR, path.join(__dirname, '..', 'data')].filter(Boolean);
  for (const root of roots) {
    for (const name of LOG_CANDIDATES) {
      const p = path.join(root, name);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return path.join(roots[0], LOG_CANDIDATES[0]);
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (f) => SendInput(1, [{ type: 0, mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: f, time: 0, dwExtraInfo: 0 } }], koffi.sizeof(INPUT));
// ⚠ split('\n') 结尾会多出一个空元素，**必须去掉**：否则 mark 比真实行数多 1，`slice(mark)` 正好漏掉
// 追加进来的第一行——当点击只落一行日志时，本件唯一的判据就恒「没收到」（票 11-Y3 与 verify-click-after
// 同批修掉的坑；那边表现为「应用日志=无记录」，这边表现为整件假红）。
const logLines = () => {
  const arr = fs.readFileSync(LOG, 'utf8').split('\n');
  while (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
};
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
  console.log('【定性】本件测【真入口】显示路径：隐藏走菜单动作 hide-pet（产品 hidePet()），显示再起一个实例走 second-instance → showPet()（重建句柄）。原「CDP 同句柄 showInactive」形态产品 1.0.71 起已放弃，见 PITFALLS §95（票 11-Y3 改判）');
  require('./lib-occupancy').assertNoBlockingInstances('verify-hide-show-input.js'); // 占用自检 exit 3（票 11-G 任务 4）
  rectMath = loadRectMath(path.join(__dirname, '..')); // main.js 矩形公式提取失败 = 前置不满足
  mainProc = await connect(9229, (t) => t.find((x) => x.type === 'node') || t[0]); // 旧码 || x[0] 是引用错误，前置路径会炸成脚本异常
  DIP_SCALE = await readDipScale(mainProc); // 票 14-G：值取产品自己用的那个
  rendererProc = await connect(9333, (t) => t.find((x) => (x.url || '').endsWith('pet.html')));
  const a = await clickAndCheck('① 隐藏前');
  if (!a) {
    // T3-②（票 11-Y3）：① 是仪器的自证步骤。隐藏前就收不到输入，说明瞄点/注入/日志读取这一环不通，
    // 后面 ③ 读到什么都不能归因给产品 ⇒ 按铁律 3 落**前置不满足 exit 3**，不许伪装成产品红。
    // （装置聚合里 exit 3 同样不算通过、不会溜绿，所以可见性没有损失——只是不再骗人说这是缺陷。）
    console.error('测量不通：① 隐藏前就收不到点击 ⇒ 本件后续读数无判据力（exit 3，不是产品红）');
    process.exit(3);
  }
  console.log('② 隐藏（走菜单动作 hide-pet → 产品的 hidePet()）');
  await rendererProc('(() => { window.petAPI.menuAction("hide-pet"); return "hidden"; })()');
  await sleep(800);
  console.log('③ 显示走**真入口**：再起一个实例 → second-instance → showPet()（重建句柄）。1.0.71 起产品不再用同句柄 showInactive 露面（PITFALLS §95）');
  // 票 14-I：这段（选 exe + 校验 PET_USER_DATA_DIR + spawn + 等日志锚）抽进 lib-show-pet，
  // verify-hide 的收场也走它——两件同一条真入口，别各抄一份。
  const petUserData = String(await mainProc('(() => String(process.env.PET_USER_DATA_DIR || ""))()'));
  if (!petUserData) {
    console.error('前置不满足：主进程没有 PET_USER_DATA_DIR，第二实例撞不到同一把单实例锁（会起成第二个应用）');
    process.exit(3);
  }
  const revived = await showPetBySecondInstance({ repoRoot: path.join(__dirname, '..'), timeoutMs: 15_000 });
  if (!revived.ok) {
    console.error(`前置不满足：没等到「显示桌宠（已重建窗口句柄」日志行——真入口显示没走通，后续读数无锚（日志 ${revived.logPath}）`);
    process.exit(3);
  }
  // showPet() 重建换掉的正是渲染页：旧 WebSocket 对着已销毁的页面，必须重连，
  // 否则 ④ 的 aimAt 读的是旧页面的空读数（票 11-Y3；与 verify-click-after 同一坑）
  rendererProc = await connect(9333, (t) => t.find((x) => (x.url || '').endsWith('pet.html')));
  await sleep(1500);
  const b = await clickAndCheck('④ 真入口显示后');
  SetCursorPos(100, 100);
  const ok = a && b;
  console.log(ok
    ? '\n✓ 隐藏→真入口显示后点击仍正常（本件判据=应用日志，与 verify-click-after 的 DOM 事件层互证同一条用户路径）'
    : '\n✗ 复现：隐藏→真入口显示后收不到点击（这才是产品红线，需立案）');
  // ① 不通已在上面落 exit 3，所以这里的 1 只剩一种含义：真入口显示后输入确实断了
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error('前置不满足（exit 3）：' + e.message);
    process.exit(3);
  }
  console.error('脚本异常：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
