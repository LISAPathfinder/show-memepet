// 验证「隐藏桌宠 + 托盘」：
//   1) 走真实路径隐藏（renderer 的 menuAction('hide-pet')，与点菜单是同一条 IPC）；
//   2) 断言窗口还在但不可见（hide 不是 close）、进程没退；
//   3) 注入一个 F24 按键（没有应用会占用），断言计数仍在涨 —— 证明「后台继续运行」；
//   4) 恢复显示。
// 用法（先起带调试端口的实例）：
//   PET_USER_DATA_DIR=<临时目录> npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/verify-hide.js
// 托盘图标本身是原生 UI，这里只验证它没创建失败（日志无「托盘图标创建失败」）+ 显隐行为，
// 图标长什么样、左键/右键菜单由人眼确认。
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
// 注入按键用系统级 keybd_event（不是 Electron 内部 API）：这样测的是「隐藏后系统钩子还在收键」
const keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)');
const VK_F24 = 0x87; // 135：没有应用会绑这个键，副作用最小
const KEYEVENTF_KEYUP = 2;
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

async function main() {
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);

  const today = async () => Number(await renderer.evaluate('window.petAPI.getStats().then((s) => s.today)'));
  const petState = async () =>
    JSON.parse(
      await mainProc.evaluate(`
        (() => {
          const { BrowserWindow } = process.mainModule.require('electron');
          const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
          if (!w) return JSON.stringify({ error: '窗口没了（不该发生）' });
          return JSON.stringify({ visible: w.isVisible(), destroyed: w.isDestroyed(), windows: BrowserWindow.getAllWindows().length });
        })()
      `)
    );

  // 注入一个按键来验证「隐藏后还在统计」：F24 没有应用会绑定，副作用最小
  const pressF24 = () => {
    keybd_event(VK_F24, 0, 0, 0);
    keybd_event(VK_F24, 0, KEYEVENTF_KEYUP, 0);
  };

  const before = await petState();
  console.log('隐藏前：', JSON.stringify(before));
  const t0 = await today();

  console.log('走真实路径隐藏（menuAction("hide-pet")）：', await renderer.evaluate('(() => { window.petAPI.menuAction("hide-pet"); return "sent"; })()'));
  await sleep(800);
  const hidden = await petState();
  console.log('隐藏后：', JSON.stringify(hidden));

  console.log('注入 F24 按键（系统级 keybd_event）：', (pressF24(), 'sent'));
  // 计数是「内存累计 + 每 5 秒落盘」，而 stats:get 是从磁盘文件汇总的 → 必须等过落盘周期再看
  let t1 = t0;
  for (let i = 0; i < 12 && t1 <= t0; i++) {
    await sleep(1000);
    t1 = await today();
  }
  console.log(`计数：隐藏前 ${t0} → 隐藏后 ${t1}`);

  // 恢复显示（与 showPet 里同一套底层调用）
  await mainProc.evaluate(`
    (() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      w.showInactive();
      w.setAlwaysOnTop(true, 'screen-saver');
      return 'shown';
    })()
  `);
  await sleep(600);
  const shown = await petState();
  console.log('恢复显示后：', JSON.stringify(shown));

  const ok =
    before.visible === true &&
    hidden.visible === false &&
    hidden.destroyed === false &&
    hidden.windows === before.windows &&
    t1 > t0 &&
    shown.visible === true;
  console.log(ok ? '\n✓ 隐藏=只隐藏不销毁、进程与统计继续、可恢复显示' : '\n✗ 有不符预期的项，见上面输出');
  process.exit(ok ? 0 : 1);
}

require('./lib-occupancy').assertNoBlockingInstances('verify-hide.js'); // 占用自检 exit 3（票 11-G 任务 4）
main().catch((err) => {
  console.error('验证失败:', err.message);
  process.exit(1);
});
