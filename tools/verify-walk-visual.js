// @runtime: shared —— 走路动画渲染端判据，attach 调试端口
// 验证「走过去」的渲染端一半（新状态 move + 朝向翻转 + 走路动画）：
// 主进程逻辑在 tools/verify-walk.js 里纯 node 测；真实三击走系统钩子，注入不了合成按键，
// 那一段只能人工确认。这里覆盖的是「主进程决定开始/结束移动之后」渲染端的表现。
// 用法（先起带调试端口的实例）：
//   PET_USER_DATA_DIR=<临时目录> npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/verify-walk-visual.js [截图输出路径]
// 注意：本文件是 CommonJS（用了 require），所以入口包一层 async 函数，不能用顶层 await
// （node 22 对 require + 顶层 await 并存会直接报 ERR_AMBIGUOUS_MODULE_SYNTAX）。
const fs = require('fs');
const path = require('path');

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

async function main() {
  const outShot = process.argv[2] || path.join(process.env.TEMP || '.', 'walk-move-state.png');
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);

  // 从主进程发 pet:walk（与 main.js 里 walkPetTo/finishWalk 发的是同一条通道）
  const sendWalk = (active, direction) =>
    mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        if (!w) return '找不到桌宠窗口';
        w.webContents.send('pet:walk', { active: ${active}, direction: ${direction} });
        return 'sent';
      })()
    `);

  const readState = () =>
    renderer.evaluate(`
      (() => {
        const face = document.getElementById('pet-face');
        const body = document.querySelector('.pet-body');
        return JSON.stringify({
          state: document.body.dataset.state,
          flip: face.classList.contains('flip'),
          faceScale: getComputedStyle(face).scale,
          bodyAnim: getComputedStyle(body).animationName,
          text: face.textContent,
        });
      })()
    `);

  console.log('发送 pet:walk {active:true, direction:-1}（向左走）:', await sendWalk(true, -1));
  // 票 14-I：读**稳态**不读瞬时态。`pet:walk` 是 IPC 投递后由渲染端下一帧应用 class/transform，
  // 固定 400ms 在「页面刚被重建 / 首帧合成」时会读到上一状态（实测全量轮里偶发 bodyAnim 还是
  // float → 判据红，单跑必绿）。轮询到目标状态为止，上限 1.5s——产品真坏时照样红。
  const readUntil = async (pred, ms = 1500) => {
    const end = Date.now() + ms;
    let st = JSON.parse(await readState());
    while (!pred(st) && Date.now() < end) {
      await sleep(100);
      st = JSON.parse(await readState());
    }
    return st;
  };
  const leftState = await readUntil((s) => s.state === 'move' && s.bodyAnim === 'walk-bob');
  console.log('  → 渲染端状态 =', JSON.stringify(leftState));

  const shot = await renderer.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outShot, Buffer.from(shot.data, 'base64'));
  console.log('  → 截图 =', outShot);

  console.log('发送 pet:walk {active:true, direction:1}（向右走）:', await sendWalk(true, 1));
  const rightState = await readUntil((s) => s.state === 'move' && s.flip === false);
  console.log('  → 渲染端状态 =', JSON.stringify(rightState));

  console.log('发送 pet:walk {active:false}:', await sendWalk(false, 1));
  const idleState = await readUntil((s) => s.state === 'idle');
  console.log('  → 渲染端状态 =', JSON.stringify(idleState));

  const ok =
    leftState.state === 'move' &&
    leftState.flip === true &&
    String(leftState.faceScale).replace(/\s+/g, ' ').startsWith('-1') &&
    leftState.bodyAnim === 'walk-bob' &&
    rightState.flip === false &&
    idleState.state === 'idle' &&
    idleState.flip === false;
  console.log(ok ? '\n✓ 渲染端 move 状态、朝向翻转、走路动画都生效，结束回 idle' : '\n✗ 有不符预期的项，见上面输出');
  process.exit(ok ? 0 : 1);
}

require('./lib-occupancy').assertNoBlockingInstances('verify-walk-visual.js'); // 占用自检 exit 3（票 11-G 任务 4）
main().catch((err) => {
  console.error('验证失败:', err.message);
  process.exit(1);
});
