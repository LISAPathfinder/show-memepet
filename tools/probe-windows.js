// 只读探针：查当前主进程里有哪些窗口、状态如何
import occ from './lib-occupancy.js';
occ.warnBlockingInstances(); // 测量件只警告不拦（票 11-G 任务 4）
const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
const main = targets.find((t) => t.type === 'node') || targets[0];
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let seq = 0;
const evaluate = (expression) =>
  new Promise((resolve) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      const r = msg.result && msg.result.result;
      resolve(r && (r.description || r.value));
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });

console.log('窗口:', await evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    return BrowserWindow.getAllWindows().map((w) =>
      (w.isDestroyed() ? 'destroyed' : 'alive') + ' | ' + (w.webContents.isCrashed() ? 'CRASHED' : 'ok') + ' | ' + w.webContents.getURL()
    ).join('\\n');
  })()
`));
console.log('可见:', await evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    return BrowserWindow.getAllWindows().map((w) => w.isVisible() + '@' + JSON.stringify(w.getBounds())).join(' | ');
  })()
`));

// 渲染端是否真的恢复出内容（而不是一张空白页）
const rt = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const petTarget = rt.find((t) => t.url && t.url.endsWith('pet.html'));
if (petTarget) {
  const pws = new WebSocket(petTarget.webSocketDebuggerUrl);
  await new Promise((res) => pws.addEventListener('open', res));
  const reply = await new Promise((resolve) => {
    pws.addEventListener('message', (ev) => resolve(JSON.parse(ev.data)));
    pws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `JSON.stringify({
            face: !!document.querySelector('#pet-face'),
            counter: (document.querySelector('#counter') || {}).textContent,
            state: document.body.dataset.state,
          })`,
          returnByValue: true,
        },
      })
    );
  });
  console.log('渲染端状态:', reply.result && reply.result.result && reply.result.result.value);
}
process.exit(0);
