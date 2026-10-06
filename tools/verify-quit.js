// 退出路径冒烟测试：连主进程调试端口，可选先执行一段表达式（如加载语音 worker），
// 再调 app.quit()，测量进程树退干净所需时间。
// 用法：PET_USER_DATA_DIR=... npx electron --inspect=9229 . 起进程后
//   node tools/verify-quit.js                      # 直接退出
//   node tools/verify-quit.js "<预置表达式>"        # 先做准备再退出
import occ from './lib-occupancy.js';
occ.assertNoBlockingInstances('verify-quit.js'); // 占用自检 exit 3（票 11-G 任务 4）
const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
const main = targets.find((t) => t.type === 'node') || targets[0];
if (!main) {
  console.error('找不到主进程调试目标');
  process.exit(1);
}

const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));

let seq = 0;
function evaluate(expression, awaitPromise) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.result && msg.result.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluate 失败'));
        return;
      }
      resolve(msg.result && msg.result.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise } }));
  });
}

const pre = process.argv[2];
if (pre) {
  const r = await evaluate(pre, true);
  console.log('预置表达式完成:', r && (r.description || r.value));
}

const started = Date.now();
await evaluate("process.mainModule.require('electron').app.quit()", false);
console.log('app.quit() 已调用');

// 轮询：调试端口消失 = 主进程已退出
let goneAt = 0;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    await fetch('http://127.0.0.1:9229/json/list');
  } catch {
    goneAt = Date.now();
    break;
  }
}
console.log(goneAt ? `主进程退出耗时 ${goneAt - started}ms` : '超时：15 秒内主进程仍未退出');
process.exit(goneAt ? 0 : 2);
