// @runtime: shared —— attach 9229 主进程读看门狗计数/形状，不自己起实例、不改场地
// 任务栏按钮不回流（票 14-D）：守护「本应用任何窗口在任务栏里都不该有按钮」（桌宠窗有
// WS_EX_TOOLWINDOW 免疫，锚点窗只能靠 shell 侧 DeleteTab 登记）。
//
// 要修的真故障（用户实机截图，1.1.4 装机版）：任务栏偶尔冒出一条本应用按钮，图标下面还带
// 「正在运行」横条。定位：对本应用的窗口补发一次 shell 的 DeleteTab，按钮当即刻消失
// ⇒ 按钮来自**锚点窗**，且是 shell 侧登记丢了（explorer 重建 / 开机自启时任务栏还没起来），
// 不是窗口样式没设。产品侧修法 = startTaskbarWatchdog（main.js）：自持 ITaskbarList，
// 每 1s 读 GetShellWindow 判 shell 重建、每 5s 无条件补删。
//
// 本件断言三层（缺一层就会「看着绿、功能死」）：
//   ① 产品诊断面在（`__taskbarTicks` / `__taskbarSweep`）——被摘掉必红，不许静默当跳过；
//   ② 看门狗真在跑：2.2s 内 ticks 必须增长（定时器被删/被 where 拦住就红）；
//   ③ 产品**自己的** DeleteTab 通道返回 S_OK（不借本件自建的 COM 对象——那是另一条通道，
//      仪器的通道通不能证明被测的通道通）；
//   ④ 形状前提（koffi 读真实 EXSTYLE）：锚点窗**不带** TOOLWINDOW 且**不带** NOACTIVATE
//      ＝它确实是「shell 会登记成任务栏按钮」的那类窗口（本件守的就是它）；桌宠窗**带**
//      TOOLWINDOW ＝免疫层在位。若有人给锚点窗补 TOOLWINDOW 来「修」任务栏，这里会红，
//      因为那会打掉任务管理器分组身份（PITFALLS §67）。
//
// ⚠ 本件**测不到**终判「任务栏里到底有没有那条按钮」——shell 没有查询接口（Win11 任务栏是
//   XAML，没有可枚举的 TB_BUTTON）。终判归真人层：用户重启 explorer / 重启机器 ≥5 次并报
//   命中数（每条都该是 0）。
//
// 用法（先起带调试端口的隔离实例）：
//   PET_USER_DATA_DIR=<临时目录> SHOWCASE_DATA_DIR=<同一临时目录> \
//     npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/verify-taskbar-tabs.js
// 退出码：0 = 全过；1 = 断言不符；3 = 前置不满足（9229 连不上＝隔离实例没起，不是被测物坏）。
const koffi = require('koffi');

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;

function connect(port) {
  return (async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = targets.find((x) => x.type === 'node') || targets[0];
    if (!t) throw new Error(`端口 ${port} 上找不到主进程目标`);
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
          if (msg.error) return reject(new Error(msg.error.message));
          const r = msg.result;
          if (r.exceptionDetails) {
            return reject(new Error(r.exceptionDetails.exception?.description || 'evaluate 失败'));
          }
          resolve(r.result.value);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    return { evaluate };
  })();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  try {
    await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error('前置不满足（exit 3）：调试端口 9229 连不上（带调试端口的隔离实例没起或已退出）。');
    console.error('先起隔离实例：PET_USER_DATA_DIR=<临时目录> SHOWCASE_DATA_DIR=<同一临时目录> \\');
    console.error('  npx electron --inspect=9229 --remote-debugging-port=9333 .');
    process.exit(3);
  }
  const mainProc = await connect(9229);

  // ---- 窗口清单（含真实句柄，后面用 koffi 读 EXSTYLE）----
  const wins = JSON.parse(
    await mainProc.evaluate(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        return JSON.stringify(BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => ({
          url: w.webContents.getURL(),
          hwnd: w.getNativeWindowHandle().readBigUInt64LE(0).toString(),
          visible: w.isVisible(),
          focusable: w.isFocusable(),
          bounds: w.getBounds(),
        })));
      })()
    `)
  );
  const pet = wins.find((w) => (w.url || '').endsWith('pet.html'));
  const anchor = wins.find((w) => (w.url || '').startsWith('data:text/html'));
  if (!pet || !anchor) {
    console.error(`前置不满足（exit 3）：没同时找到桌宠窗与锚点窗（读到 ${wins.length} 个窗口）。`);
    process.exit(3);
  }
  console.log(`窗口：桌宠 ${pet.hwnd} ${pet.bounds.width}x${pet.bounds.height}，锚点 ${anchor.hwnd} ${anchor.bounds.width}x${anchor.bounds.height}`);

  // ---- ① 诊断面在（票 14-D 被摘掉必须红，不许降级成跳过）----
  const hasTicks = await mainProc.evaluate('typeof __taskbarTicks === "function"');
  const hasSweep = await mainProc.evaluate('typeof __taskbarSweep === "function"');
  check('产品带看门狗诊断面（__taskbarTicks / __taskbarSweep）', hasTicks === true && hasSweep === true,
    `ticks=${hasTicks} sweep=${hasSweep}`);
  if (!hasTicks || !hasSweep) {
    console.log(`\nPASS ${total - failed} / FAIL ${failed}（诊断面缺失，余下断言未跑）`);
    process.exit(1);
  }

  // ---- ② 看门狗真在跑：2.2s 内 ticks 必须增长 ----
  const t0 = Number(await mainProc.evaluate('__taskbarTicks()'));
  await sleep(2200);
  const t1 = Number(await mainProc.evaluate('__taskbarTicks()'));
  check('看门狗定时器在跑（2.2s 内 ticks 增长）', Number.isFinite(t0) && t1 >= t0 + 1, `ticks ${t0} → ${t1}`);

  // ---- ③ 产品自己的 DeleteTab 通道 S_OK ----
  const sweep = await mainProc.evaluate('__taskbarSweep()');
  check('产品侧 ITaskbarList::DeleteTab 对全部窗口返回 S_OK', sweep === true, `sweep=${sweep}`);

  // ---- ④ 形状前提：锚点窗仍是「会被登记成任务栏按钮」的形状，桌宠窗免疫位在位 ----
  const user32 = koffi.load('user32.dll');
  const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
  const exOf = (hwndHex) => Number(BigInt(GetWindowLongPtrW(BigInt(hwndHex), GWL_EXSTYLE)) & 0xffffffffn);
  const exAnchor = exOf(anchor.hwnd);
  const exPet = exOf(pet.hwnd);
  const hex = (v) => `0x${v.toString(16).padStart(8, '0')}`;

  check('锚点窗没有 WS_EX_TOOLWINDOW（没人为躲任务栏打掉分组身份）',
    (exAnchor & WS_EX_TOOLWINDOW) === 0, `锚点 EXSTYLE=${hex(exAnchor)}`);
  check('锚点窗没有 WS_EX_NOACTIVATE（仍是可聚焦的「应用窗口」）',
    (exAnchor & WS_EX_NOACTIVATE) === 0, `锚点 EXSTYLE=${hex(exAnchor)}`);
  check('桌宠窗带 WS_EX_TOOLWINDOW（shell 枚举时直接排除的免疫层）',
    (exPet & WS_EX_TOOLWINDOW) !== 0, `桌宠 EXSTYLE=${hex(exPet)}`);

  console.log(`\nPASS ${total - failed} / FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('脚本异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  process.exit(1);
});
