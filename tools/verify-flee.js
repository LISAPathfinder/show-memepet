// 验证「鼠标停在桌宠身上超过 5 秒 → 自动让开」（端到端，票 11-O 四断言版）：
//   真实光标停到桌宠命中区中心 → 等 CURSOR_FLEE_MS → 断言：
//   ① 日志出现「让开」决策行（并解析方向与 movedPx）；
//   ② 同一秒内出现「走过去:」行——1.0.64 悬空引用（票 11-O）让 fleeFromCursor 在
//      walkPetTo 之前抛 ReferenceError，「让开」行之后永远不会再有「走过去」行，
//      装机日志实证 6 条让开后面全空、uncaughtException 5 条——这两行是否相邻
//      就是「让开动作是否真的发生」的分水岭；
//   ③ 窗口最终位置 ≈ 让开行声明目标换算的期望窗口位（内容矩形口径：
//      期望窗口位 = 目标 − (600−round(300·s), 600−round(160·s))，与 main.js 同式），
//      且位移方向的分量符号与方向 label 一致；
//   ④ 期间日志 uncaughtException 计数增量为 0——兜底吞异常会把功能失效藏成一行日志，
//      **跑完运行时件必须 grep uncaughtException，非 0 就是发现**（本件把这条写进断言）。
// ⚠ 本件必须留着 cursorFleeEnabled=true 跑（跑前自查，false exit 3）——这条路径此前
//   在一切量测里从不执行，正是 1.0.64 把它弄坏却全绿 through CI 的原因（§83 教训）。
// 纯 node（koffi 移动/读光标）+ 主进程调试端口（读窗口 bounds/config）+ 渲染端
// 调试端口（读上报盒定位命中区中心，固定窗后「窗口几何中心」不是桌宠所在，§76）。
// 用法（先起带调试端口的隔离实例）：
//   PET_USER_DATA_DIR=<临时目录> SHOWCASE_DATA_DIR=<同目录> \
//     npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/verify-flee.js [等待秒数，默认 7]
// 退出码：0 = 四断言全过；1 = 断言不过；3 = 前置不满足（实例没起 / cursorFleeEnabled=false /
//         装机版在跑——assertNoBlockingInstances，不许绕、不许 taskkill 用户的实例）。
// 注意：期间用户若动了鼠标会打断测量（真实机器的固有干扰）——等待期间本件每 500ms
// 把光标按回命中点，但人手拖着晃仍可能拉长触发时间，重跑即可。
const fs = require('fs');
const path = require('path');

const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
const user32 = koffi.load('user32.dll');
// 注意：这里必须用 void* + Buffer 的写法（与 probe-window-style.js 同款）。
// 声明成 `_Out_ POINT *pt` 再传 {x,y} 对象是**读不出值**的：调用不报错、字段恒 undefined
// （probe-mouse-event 第一版就栽在这上面，实测踩过）。
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const getCursor = () => {
  const buf = Buffer.alloc(8);
  GetCursorPos(buf);
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
};

// 迁移期双认（票 11-A）：按候选序取第一个存在的日志文件；隔离实例走 SHOWCASE_DATA_DIR
// 优先（与本件起实例的用法一致），都不在回落仓库开发态 data/。
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
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 失败');
      return r.result.value;
    };
    return { evaluate };
  })();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const waitSec = Number(process.argv[2]) || 7;
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));

  // 前置：cursorFleeEnabled 必须为 true（本件测的就是这条路径，false=白跑）
  const cfg = JSON.parse(
    await mainProc.evaluate(`(() => { const c = process.mainModule.require('./config'); return JSON.stringify({ flee: c.get('cursorFleeEnabled'), scale: c.get('petScale') }); })()`)
  );
  if (!cfg.flee) {
    console.error('前置不满足（exit 3）：cursorFleeEnabled=false——本件必须留着让开开关跑（这是被测路径本身）');
    process.exit(3);
  }
  const scale = Number(cfg.scale) || 1;

  // 默认把桌宠搬到屏幕中间：下方有余量，planFlee 才有确定解（默认位贴右下角会让不开）
  await mainProc.evaluate(`
    (() => {
      const { BrowserWindow, screen } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      if (!w) return '找不到桌宠窗口';
      const wa = screen.getPrimaryDisplay().workArea;
      const b = w.getBounds();
      w.setPosition(Math.round(wa.x + wa.width / 2 - b.width / 2), Math.round(wa.y + wa.height / 2 - b.height / 2));
      return 'moved';
    })()
  `);
  await sleep(500);

  const readPet = () =>
    mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        if (!w) return JSON.stringify({ error: '找不到桌宠窗口' });
        const b = w.getBounds();
        return JSON.stringify({ hidden: !w.isVisible(), x: b.x, y: b.y });
      })()
    `);

  const before = JSON.parse(await readPet());
  if (before.error) throw new Error(before.error);
  if (before.hidden) throw new Error('桌宠当前是隐藏状态，先让它显示出来再测');

  // 瞄准命中区中心：从渲染端上报盒取最大盒（脸）中心——固定窗后窗口几何中心不是桌宠（§76）
  const rawBoxes = JSON.parse(
    await renderer.evaluate(`(() => { const b = interactiveBox(); const arr = Array.isArray(b) ? b : b ? [b] : []; return JSON.stringify(arr.filter(r => r.width > 0 && r.height > 0)); })()`)
  );
  if (!rawBoxes.length) throw new Error('渲染端上报盒读不到');
  const face = rawBoxes.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const aim = { x: Math.round(before.x + face.x + face.width / 2), y: Math.round(before.y + face.y + face.height / 2) };

  const original = getCursor();
  const countIn = (text, needle) => text.split(needle).length - 1;
  const logBeforeText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const logBeforeLen = logBeforeText.length;
  const uncaughtBefore = countIn(logBeforeText, 'uncaughtException');

  console.log(`光标移到命中区中心 ${aim.x},${aim.y}（窗口 ${before.x},${before.y} scale=${scale}），每 500ms 按回原位，等 ${waitSec}s + 走路完成…`);
  SetCursorPos(aim.x, aim.y);

  // 触发让开（等待期按住光标防用户鼠标干扰）→ 再等走路动画完成（位置连续 3 拍不变）
  for (let i = 0; i < waitSec * 2; i++) {
    await sleep(500);
    SetCursorPos(aim.x, aim.y);
  }
  let after = JSON.parse(await readPet());
  let stable = 0;
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    const cur = JSON.parse(await readPet());
    if (cur.x === after.x && cur.y === after.y) stable++;
    else { after = cur; stable = 0; }
    if (stable >= 3) break;
  }

  const logTail = (fs.readFileSync(LOG, 'utf8').slice(logBeforeLen));
  SetCursorPos(original.x, original.y); // 还原光标

  console.log(`窗口位置：${before.x},${before.y} → ${after.x},${after.y}`);
  for (const l of logTail.split('\n').filter((l) => /让开|走过去|uncaughtException/.test(l)).slice(0, 10))
    console.log('  日志 >', l.trim());

  // ① 让开决策行（解析方向与 movedPx）
  const fleeLine = logTail.split('\n').find((l) => /让开 \d+px/.test(l));
  check('① 日志出现「让开 NNNpx」决策行', !!fleeLine,
    fleeLine ? fleeLine.trim().slice(0, 90) : '增量日志无让开行');
  if (fleeLine) {
    // ② 同一秒「走过去:」行（ISO 时间戳取秒比较；1.0.64 坏版本让开后必无走过去）
    const fleeTs = (fleeLine.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/) || [])[1];
    const walkLine = logTail.split('\n').find((l) => /走过去: /.test(l) &&
      (l.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/) || [])[1] === fleeTs);
    check('② 同一秒内出现「走过去:」行（让开动作真的进入执行）', !!walkLine,
      walkLine ? walkLine.trim().slice(0, 80) : `让开行 [${fleeTs}] 后无同秒走过去行`);
    // ③ 窗口最终位置 ≈ 目标换算的期望窗口位 + 方向分量符号
    const m = fleeLine.match(/向(.+?)让开 (\d+)px.*→ 视觉 (-?\d+),(-?\d+)/);
    if (m) {
      const label = m[1];
      const movedPx = Number(m[2]);
      const target = { x: Number(m[3]), y: Number(m[4]) };
      const expectWin = {
        x: target.x - (600 - Math.round(300 * scale)),
        y: target.y - (600 - Math.round(160 * scale)),
      };
      const dErr = Math.hypot(after.x - expectWin.x, after.y - expectWin.y);
      check('③ 窗口按方向位移 ≈ movedPx（终位 vs 让开目标换算，±40px）', dErr <= 40,
        `终位 ${after.x},${after.y} vs 期望 ${expectWin.x},${expectWin.y}（目标 ${target.x},${target.y}）偏差 ${Math.round(dErr)}px`);
      const dirOk =
        (!label.includes('下') || after.y > before.y) &&
        (!label.includes('左') || after.x < before.x) &&
        (!label.includes('右') || after.x > before.x) &&
        (!label.includes('上') || after.y < before.y);
      check(`③b 位移分量符号与方向「${label}」一致`, dirOk,
        `Δ=(${after.x - before.x},${after.y - before.y})`);
    } else {
      check('③ 让开行可解析（方向/movedPx/目标坐标）', false, fleeLine.trim().slice(0, 90));
    }
  } else {
    check('② 同一秒内出现「走过去:」行', false, '无让开行，跳过');
    check('③ 窗口按方向位移 ≈ movedPx', false, '无让开行，跳过');
  }
  // ④ 兜底异常增量 = 0（把「功能失效被 uncaughtException 吞成日志」直接变成红灯）
  const uncaughtAfter = countIn(logTail, 'uncaughtException');
  check('④ 期间 uncaughtException 计数增量为 0', uncaughtAfter === 0,
    `增量 ${uncaughtAfter}（跑前全量 ${uncaughtBefore}）`);

  console.log(failed === 0 ? '\n✓ 鼠标久留自动让开端到端全过' : `\n✗ ${failed} 项断言不过`);
  process.exit(failed === 0 ? 0 : 1);
}

require('./lib-occupancy').assertNoBlockingInstances('verify-flee.js'); // 占用自检 exit 3（票 11-G 任务 4）
main().catch((err) => {
  console.error(`脚本异常：${err && err.message ? err.message : err}`);
  process.exit(1);
});
