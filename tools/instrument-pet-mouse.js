// 在桌宠页面上装一个鼠标事件记录器（通过 CDP），滚动保留最近 40 条事件，用来判定
// 「真实点击时页面收到了什么」——区分「mousedown 丢」和「事件根本没到」。
// 用法：node tools/instrument-pet-mouse.js [install|dump|clear]
const ACTION = process.argv[2] || 'dump';

async function connect(port, pick) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = pick(targets);
  if (!t) throw new Error(`端口 ${port} 上找不到目标页面`);
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
}

(async () => {
  require('./lib-occupancy').warnBlockingInstances(); // 测量件只警告不拦（票 11-G 任务 4）
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));
  if (ACTION === 'install') {
    const out = await renderer(`(() => {
      if (window.__mouseTrace) return '已经装过了';
      window.__mouseTrace = [];
      const push = (t) => (e) => {
        window.__mouseTrace.push(
          t + ' ' + new Date().toISOString().slice(11, 23) + ' btn=' + e.buttons +
          ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) +
          ' target=' + ((e.target && e.target.id) || (e.target && e.target.className) || '?')
        );
        if (window.__mouseTrace.length > 40) window.__mouseTrace.shift();
      };
      for (const t of ['mousedown', 'mouseup', 'click', 'mousemove', 'mouseover', 'mouseout']) {
        document.addEventListener(t, push(t), true);
      }
      return '记录器已安装（mousedown/mouseup/click/mousemove/over/out）';
    })()`);
    console.log(out);
  } else if (ACTION === 'clear') {
    console.log(await renderer('(window.__mouseTrace = [], "已清空")'));
  } else {
    console.log(await renderer('JSON.stringify(window.__mouseTrace || "未安装记录器", null, 1)'));
  }
  process.exit(0);
})().catch((e) => {
  console.error('操作失败:', e.message);
  process.exit(1);
});
