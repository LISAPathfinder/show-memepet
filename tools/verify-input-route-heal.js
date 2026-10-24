// @runtime: shared —— attach 9229 主进程读自检诊断面 + koffi 隐藏渲染子窗制造故障，不自己起实例
// 输入通道自愈（票 14-E）：守「渲染子窗口失联后，产品自己能把它救回来」。
//
// 要修的故障（2026-10-21 用户实机报「挂着没动一段时间后点不动」）：
//   息屏 / 现代待机唤醒后，Chromium 的渲染子窗（Chrome_RenderWidgetHostHWND，真正接收鼠标消息
//   的那个）被藏起来且不再回来。外壳窗口 EXSTYLE 仍是「可交互」、WindowFromPoint 也落在桌宠上，
//   但点击全丢——只有第三层读数（落点是不是那个子窗）看得出来。
//   实机证据：系统 Kernel-Power 566 在 21:36/21:44/23:05 记了 3 次 SessionUnlock，
//   而产品 powerMonitor 的 unlock 钩子最后一次触发停在 19:16 ⇒ 事件不来，重建不发生。
//   产品侧修法 = checkPetInputRoute（main.js）：不依赖任何系统事件，2s 一次按「子窗口在不在
//   / 尺寸是否等于父窗」自检，连续 2 拍不健康且过冷却就 recreatePetWindow。
//
// 本件断言五层（缺一层就会「看着绿、功能死」）：
//   ① 诊断面在（__petRouteChecks / __petRouteHeals 是数字）——被摘掉必红，不许静默当跳过；
//   ② 基线：桌宠窗口下确实有一个可见、与父窗同尺寸的渲染子窗（本件守的对象此刻健康）；
//   ③ 自检真在跑：2.5s 内 __petRouteChecks 必须增长（定时器被摘/被 where 拦住就红）；
//   ④ 故障注入后产品**自己**重建了窗口（HWND 必须变）+ __petRouteHeals ≥ 1
//      ——注意判据是「重建」不是「子窗又可见了」：Chromium 自己也可能把子窗放回来，
//      那不能证明自愈通道活着（同 §63 的代理指标教训）；
//   ⑤ 重建后的新窗口子窗可见、尺寸与父窗一致（输入通道真的恢复了，不只是换了个壳）。
//      **读稳态不读瞬时态**（票 14-I）：HWND 一变就立刻读子窗，读到的常是「子窗已建、页面还没
//      开始合成」（可见=false）——重建是成功的，判据却红了。轮询到可见（上限 8s）再断言。
//
// ⚠ 本件测不到终判「点击真的进来了」——那需要注入真实点击并读渲染端 DOM 事件
//   （REAL_INPUT_TOOLS 授权闸门那一路，见 verify-click-after）。本件只守到「窗口换新、子窗在位」，
//   点击连通由探针 probe-click-target（落点=渲染子窗）+ 真人层覆盖。
//
// 用法（先起带调试端口的隔离实例）：
//   PET_USER_DATA_DIR=<临时目录> SHOWCASE_DATA_DIR=<同一临时目录> \
//     npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/verify-input-route-heal.js
// 退出码：0 = 全过；1 = 断言不符；3 = 前置不满足（9229 连不上＝隔离实例没起，不是被测物坏）。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');

const RENDER_CHILD_CLASS = 'Chrome_RenderWidgetHostHWND';
// 票 14-I：等待窗必须**覆盖产品的重建冷却**（main.js PET_ROUTE_HEAL_COOLDOWN_MS = 30s）。
// 判据是「本件注入的故障让产品重建窗口」，而冷却期内产品**按设计不重建**——上游件（verify-hide
// 的隐藏→显示重建）刚触发过一次自愈时，冷却还剩二三十秒，旧的 9s 等待必然读到「HWND 没变、
// heals 没增」，把正常行为判成红（全量里稳定复现、单跑必绿，就是这个形状）。
// 轮询到 HWND 变了就立即 break：场地干净时仍然 ~1.2s 出结果，只有撞上冷却才真的等满。
const HEAL_WAIT_MS = 34_000;

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

const user32 = koffi.load('user32.dll');
const FindWindowExW = user32.func('FindWindowExW', 'uintptr', ['uintptr', 'uintptr', 'void *', 'void *']);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);
const ShowWindow = user32.func('ShowWindow', 'bool', ['uintptr', 'int']);
const wstr = (s) => Buffer.from(s + '\0', 'utf16le');
const childOf = (hwnd) => (hwnd ? Number(FindWindowExW(hwnd, 0, wstr(RENDER_CHILD_CLASS), null)) : 0);
const rectOf = (h) => {
  const b = Buffer.alloc(16);
  GetWindowRect(h, b);
  const l = b.readInt32LE(0), t = b.readInt32LE(4);
  return { w: b.readInt32LE(8) - l, h: b.readInt32LE(12) - t };
};

const PET_HWND_EXPR = `
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && (x.webContents.getURL() || '').endsWith('pet.html'));
    return w ? w.getNativeWindowHandle().readBigUInt64LE(0).toString() : '';
  })()
`;

function logHasHealLine() {
  // 隔离实例的数据根由装置经 env 传入（SDK 四契约）；读不到就不判（不让环境差异制造假红）。
  // 文件名走 identity.LOG_CANDIDATES，不写裸字面量（verify-identity 会红）
  const dir = process.env.SHOWCASE_DATA_DIR;
  if (!dir) return null;
  for (const name of LOG_CANDIDATES) {
    try {
      if (fs.readFileSync(path.join(dir, name), 'utf8').includes('输入通道自检')) return true;
    } catch {
      // 这个候选不存在，试下一个
    }
  }
  return false;
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

  // ---- ① 诊断面 ----
  const hasFace = await mainProc.evaluate(
    'typeof __petRouteChecks === "number" && typeof __petRouteHeals === "number"'
  );
  check('产品带输入通道自检诊断面（__petRouteChecks / __petRouteHeals）', hasFace === true, `has=${hasFace}`);
  if (!hasFace) {
    console.log(`\nPASS ${total - failed} / FAIL ${failed}（诊断面缺失，余下断言未跑）`);
    process.exit(1);
  }

  // ---- ② 基线：子窗口在、可见、与父窗同尺寸 ----
  const hwnd0 = Number(await mainProc.evaluate(PET_HWND_EXPR));
  if (!hwnd0) {
    console.error('前置不满足（exit 3）：没找到桌宠窗口（pet.html），实例没起好。');
    process.exit(3);
  }
  const child0 = childOf(hwnd0);
  const child0Visible = child0 ? IsWindowVisible(child0) : false;
  const pr0 = rectOf(hwnd0);
  const cr0 = child0 ? rectOf(child0) : { w: 0, h: 0 };
  check('基线：桌宠窗口有渲染子窗口且可见', child0 !== 0 && child0Visible === true,
    `父=0x${hwnd0.toString(16)} 子=${child0 ? '0x' + child0.toString(16) : '(无)'} 可见=${child0Visible}`);
  check('基线：子窗口与父窗同尺寸（输入通道形状正确）',
    Math.abs(cr0.w - pr0.w) <= 8 && Math.abs(cr0.h - pr0.h) <= 8,
    `父=${pr0.w}x${pr0.h} 子=${cr0.w}x${cr0.h}`);
  if (!child0 || !child0Visible) {
    console.log(`\nPASS ${total - failed} / FAIL ${failed}（基线就不健康，故障注入无意义）`);
    process.exit(1);
  }

  // ---- ③ 自检真在跑 ----
  const c0 = Number(await mainProc.evaluate('__petRouteChecks'));
  await sleep(2500);
  const c1 = Number(await mainProc.evaluate('__petRouteChecks'));
  check('自检定时器在跑（2.5s 内 __petRouteChecks 增长）', Number.isFinite(c0) && c1 >= c0 + 1, `checks ${c0} → ${c1}`);

  // ---- ④ 故障注入：藏掉渲染子窗（等价于实机「息屏后子窗不再回来」形态）----
  const h0 = Number(await mainProc.evaluate('__petRouteHeals'));
  ShowWindow(child0, 0); // SW_HIDE
  const hidOk = !IsWindowVisible(child0);
  check('故障注入：渲染子窗口已隐藏（自检该看到的形态）', hidOk === true, `可见=${IsWindowVisible(child0)}`);

  // 等自愈：轮询窗口句柄，自愈成功的判据是「换了新窗口」
  let hwnd1 = hwnd0;
  const deadline = Date.now() + HEAL_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(400);
    hwnd1 = Number(await mainProc.evaluate(PET_HWND_EXPR));
    if (hwnd1 && hwnd1 !== hwnd0) break;
  }
  check('自愈真的重建了窗口（HWND 变了，不是 Chromium 自己把子窗放回来）', hwnd1 !== hwnd0,
    `HWND 0x${hwnd0.toString(16)} → ${hwnd1 ? '0x' + hwnd1.toString(16) : '(空)'}`);

  const h1 = Number(await mainProc.evaluate('__petRouteHeals'));
  check('重建计数增长（__petRouteHeals 至少 +1）', Number.isFinite(h1) && h1 >= h0 + 1, `heals ${h0} → ${h1}`);

  // ---- ⑤ 新窗口的输入通道恢复 ----
  // 判据必须是**稳态**读数（票 14-I）：HWND 一变就立刻读子窗，读到的常是「子窗已建、页面还没开始
  // 合成」的瞬时态（可见=false），重建本身是成功的——把瞬时态当终判会让本件在「重建刚好落在刷新
  // 窗口内」时随机红。轮询到子窗可见为止（上限 8s），再断言可见性与尺寸。
  const CHILD_READY_MS = 8000;
  const childDeadline = Date.now() + CHILD_READY_MS;
  let child1 = 0;
  let child1Visible = false;
  let pr1 = { w: 0, h: 0 };
  let cr1 = { w: 0, h: 0 };
  for (;;) {
    child1 = childOf(hwnd1);
    child1Visible = child1 ? IsWindowVisible(child1) : false;
    pr1 = hwnd1 ? rectOf(hwnd1) : { w: 0, h: 0 };
    cr1 = child1 ? rectOf(child1) : { w: 0, h: 0 };
    if (child1Visible || Date.now() > childDeadline) break;
    await sleep(300);
  }
  check('重建后子窗口可见', child1 !== 0 && child1Visible === true,
    `新窗口子=${child1 ? '0x' + child1.toString(16) : '(无)'} 可见=${child1Visible}`);
  check('重建后子窗与父窗同尺寸（输入通道真的恢复，不只是换了壳）',
    Math.abs(cr1.w - pr1.w) <= 8 && Math.abs(cr1.h - pr1.h) <= 8,
    `父=${pr1.w}x${pr1.h} 子=${cr1.w}x${cr1.h}`);

  const hasLog = logHasHealLine();
  if (hasLog !== null) {
    check('应用日志记了这次自愈（输入通道自检行）', hasLog === true, `hasLog=${hasLog}`);
  }

  // ---- 净场兜底：万一自愈没成，别把「子窗隐藏」留给下一件 ----
  const finalChild = childOf(hwnd1 || hwnd0);
  if (finalChild && !IsWindowVisible(finalChild)) {
    ShowWindow(finalChild, 5);
    console.log('  （净场兜底：自愈未生效，已手工恢复子窗可见）');
  }

  console.log(`\nPASS ${total - failed} / FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('脚本异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  process.exit(1);
});
