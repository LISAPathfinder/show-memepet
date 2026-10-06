// 对账探针：把「主进程判定穿透状态」用的三个输入量（窗口 bounds / 真实光标 / 渲染端上报的 box）摊开看，
// 一眼看出是谁和谁不一致（「点不动」类问题的定位入口）。
// 用法（dev 实例带 --inspect=9229 启动）：node tools/probe-passthrough-inputs.js
function connect(port) {
  return (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = targets.find((x) => x.type === 'node') || targets[0];
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

(async () => {
  require('./lib-occupancy').warnBlockingInstances(); // 测量件只警告不拦（票 11-G 任务 4）
  const m = await connect(9229);
  const out = await m.evaluate(`
    (() => {
      const { BrowserWindow, screen } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      if (!w) return JSON.stringify({ error: '找不到桌宠窗口' });
      const b = w.getBounds();
      const p = screen.getCursorScreenPoint();
      return JSON.stringify({
        bounds: b,
        cursor: p,
        winCursorInRect: p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height,
        visible: w.isVisible(),
        alwaysOnTop: w.isAlwaysOnTop(),
        focused: w.isFocused(),
        // 光标相对窗口的位置（和渲染端 box 的坐标系一致，便于对照日志里的 box）
        cursorInWindow: { x: p.x - b.x, y: p.y - b.y },
      }, null, 1);
    })()
  `);
  console.log(out);
  process.exit(0);
})().catch((e) => {
  console.error('探针失败:', e.message);
  process.exit(1);
});
