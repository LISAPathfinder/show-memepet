// 验证卡死自恢复：先让 pet 渲染进程崩溃（应自动重建窗口），再让渲染线程假死（应自动重载）。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/verify-recovery.js
import occ from './lib-occupancy.js';
occ.assertNoBlockingInstances('verify-recovery.js'); // 占用自检 exit 3（票 11-G 任务 4）
function connect(port, pick) {
  return (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = pick(targets);
    if (!t) throw new Error(`端口 ${port} 上找不到目标：` + targets.map((x) => x.url).join(' | '));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    const send = (expression, awaitReply = true) =>
      new Promise((resolve) => {
        const id = ++seq;
        if (!awaitReply) {
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression } }));
          resolve(null);
          return;
        }
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          resolve(msg.result && msg.result.result && msg.result.result.value);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
    return { send };
  })();
}

const petTargets = async () => {
  const ts = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  return ts.filter((t) => t.url && t.url.endsWith('pet.html'));
};

const main = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);

console.log('崩溃前 pet 渲染目标数:', (await petTargets()).length);

// 1) 强制渲染进程崩溃 → 应触发 render-process-gone 并重建窗口
await main.send(`
  (() => {
    const { webContents } = process.mainModule.require('electron');
    const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('pet.html'));
    if (!wc) return 'no pet webContents';
    wc.forcefullyCrashRenderer();
    return 'crash dispatched';
  })()
`).then((r) => console.log('步骤1:', r));

await new Promise((r) => setTimeout(r, 5000));
console.log('崩溃 5 秒后 pet 渲染目标数:', (await petTargets()).length);

// 2) 渲染线程假死 12 秒 → 应触发 unresponsive 并自动重载
const pet = await connect(9333, (ts) => ts.find((t) => t.url && t.url.endsWith('pet.html')));
pet.send('const __t = Date.now(); while (Date.now() - __t < 12000) {}', false);
console.log('步骤2: 已注入 12 秒假死，等待主进程判定无响应…');
await new Promise((r) => setTimeout(r, 20000));
console.log('假死后 pet 渲染目标数:', (await petTargets()).length);
process.exit(0);
