// 探针：比较渲染端拿到的窗口屏幕坐标 vs 主进程里的真实窗口位置，
// 以及定时重算时「屏幕坐标 → 窗口内坐标」的换算是否落在宠物脸上。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/probe-pointer.js
import occ from './lib-occupancy.js';
occ.warnBlockingInstances(); // 测量件只警告不拦（票 11-G 任务 4）
function connect(port, pick) {
  return (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = pick(targets);
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
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
    return { evaluate };
  })();
}

const main = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);
const pet = await connect(9333, (ts) => ts.find((t) => t.url && t.url.endsWith('pet.html')));

console.log(
  '主进程里的桌宠窗口 bounds:',
  await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    return JSON.stringify(w.getBounds());
  })()
`)
);

console.log(
  '渲染端窗口坐标:',
  await pet.evaluate(
    `JSON.stringify({ screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight, dpr: window.devicePixelRatio, inner: window.innerWidth + 'x' + window.innerHeight })`
  )
);

// 用「脸上一点」做端到端换算检查
console.log(
  '换算检查:',
  await pet.evaluate(`
  (() => {
    const face = document.querySelector('#pet-face');
    const r = face.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    // 模拟一次真实的 mousemove：screenX = 窗口屏幕坐标 + 窗口内坐标
    const sx = window.screenX + cx, sy = window.screenY + cy;
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: cx, clientY: cy, screenX: sx, screenY: sy,
    }));
    const back = document.elementFromPoint(sx - window.screenX, sy - window.screenY);
    return JSON.stringify({ 脸上点: [cx, cy], 换算回来: (back || {}).id || (back || {}).tagName });
  })()
`)
);
process.exit(0);
