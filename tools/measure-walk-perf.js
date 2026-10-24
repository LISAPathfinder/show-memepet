// @runtime: shared —— 默认形态连调试端口量「移动一帧」的开销/定时器精度（--local 子集除外）
// 量「走过去」的两个旋钮：单次原生移窗的开销、主进程定时器实际能跑到多少 Hz。
// 决定 WALK.frameMs 该定多少（帧率太低时窗口每步位移大，看着就是阶梯感）。
// 票 14-I：移动调用改 **SetWindowPos(SWP_NOSIZE)**——产品 1.1.4 起走这条（main.js
// movePetWindowTo，§98），旧版本这里量的是 Electron `setPosition`：它每次往返把窗口尺寸
// 涨 2~3px，200+120 拍的测量直接把 605×605 撑成 1202×1120，之后整轮共享批的场地全废
// （resizable:false 的窗口 SetWindowPos 改不小，只能 setBounds 拉回且永远差 1 DIP）。
// 量产品真正在跑的路径，既是对的口径，也不再制造不可逆的场地损伤。
// 用法（先起带主进程调试端口的实例）：
//   PET_USER_DATA_DIR=<临时目录> npx electron --inspect=9229 --remote-debugging-port=9333 .
//   node tools/measure-walk-perf.js
// 注意：测量期间会让桌宠窗口左右抖动 1px，结束后恢复原位（位置-only，尺寸零改动）。
const path = require('path');
// CDP 表达式里 require 裸名解析不到（process.mainModule.require 的解析基点不在仓库根，
// 实测「Cannot find module 'koffi'」）——与 §96 同族，一律用绝对路径。
const KOFFI_ABS = JSON.stringify(path.join(__dirname, '..', 'node_modules', 'koffi'));
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

async function main() {
  // --local：不开 Electron，直接在纯 node 里量定时器精度（libuv 定时器在 Electron 主进程里是同一套）
  if (process.argv.includes('--local')) {
    const bench = async (want, label) => {
      const start = Date.now();
      let ticks = 0;
      await new Promise((res) => {
        const id = setInterval(() => {
          ticks += 1;
          if (Date.now() - start >= 600) { clearInterval(id); res(); }
        }, want);
      });
      const elapsed = Date.now() - start;
      console.log(`  ${label}：请求 ${want}ms → 实测 ${(ticks / elapsed * 1000).toFixed(1)} Hz（${ticks} 帧 / ${elapsed}ms）`);
      return +(ticks / elapsed * 1000).toFixed(1);
    };

    console.log('纯 node 定时器精度：');
    await bench(8, '默认精度');
    await bench(16, '默认精度');
    try {
      const koffi = require('koffi');
      const winmm = koffi.load('winmm.dll');
      const begin = winmm.func('void __stdcall timeBeginPeriod(uint32)');
      const endPeriod = winmm.func('void __stdcall timeEndPeriod(uint32)');
      begin(1);
      await bench(8, 'timeBeginPeriod(1) 后');
      await bench(16, 'timeBeginPeriod(1) 后');
      endPeriod(1);
    } catch (err) {
      console.log('  timeBeginPeriod 不可用:', err.message);
    }
    return;
  }

  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);
  const out = await mainProc.evaluate(`
    (async () => {
      const { BrowserWindow, screen } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      if (!w) return JSON.stringify({ error: '找不到桌宠窗口' });
      const b = w.getBounds();
      // 票 14-I：与产品 movePetWindowTo 同款——位置-only，物理坐标由所在屏的 dipToScreenPoint 算
      const koffiW = process.mainModule.require(${KOFFI_ABS});
      const u32 = koffiW.load('user32.dll');
      const SetWindowPosW = u32.func('SetWindowPos', 'bool', ['uintptr', 'uintptr', 'int', 'int', 'int', 'int', 'uint32']);
      const hwndW = w.getNativeWindowHandle().readBigUInt64LE(0);
      const SWP_MOVE = 0x0001 | 0x0004 | 0x0010; // NOSIZE | NOZORDER | NOACTIVATE
      const moveTo = (x, y) => {
        const p = screen.dipToScreenPoint({ x, y });
        SetWindowPosW(hwndW, 0, Math.round(p.x), Math.round(p.y), 0, 0, SWP_MOVE);
      };
      const N = 200;
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) moveTo(b.x + (i % 2), b.y);
      const t1 = process.hrtime.bigint();
      moveTo(b.x, b.y);
      const perCallMs = Number(t1 - t0) / 1e6 / N;

      const results = {};
      for (const want of [8, 16, 33]) {
        const start = Date.now();
        let ticks = 0;
        await new Promise((res) => {
          const id = setInterval(() => {
            ticks += 1;
            moveTo(b.x + (ticks % 2), b.y);
            if (Date.now() - start >= 600) { clearInterval(id); res(); }
          }, want);
        });
        const elapsed = Date.now() - start;
        results[want] = { ticks, elapsed, hz: +(ticks / elapsed * 1000).toFixed(1) };
      }

      // 顺带量一下「提高系统定时器精度」能不能救帧率（winmm.timeBeginPeriod(1)）。
      // 它会影响整机功耗，只作为备选：能提多少看 withPeriod 字段。
      let withPeriod = null;
      try {
        const koffi = process.mainModule.require(${KOFFI_ABS});
        const winmm = koffi.load('winmm.dll');
        const begin = winmm.func('void __stdcall timeBeginPeriod(uint32)');
        const endPeriod = winmm.func('void __stdcall timeEndPeriod(uint32)');
        begin(1);
        const start = Date.now();
        let ticks = 0;
        await new Promise((res) => {
          const id = setInterval(() => {
            ticks += 1;
            moveTo(b.x + (ticks % 2), b.y);
            if (Date.now() - start >= 600) { clearInterval(id); res(); }
          }, 8);
        });
        withPeriod = +(ticks / (Date.now() - start) * 1000).toFixed(1);
        endPeriod(1);
      } catch (err) {
        withPeriod = '调用失败: ' + err.message;
      }

      moveTo(b.x, b.y);
      return JSON.stringify({ perCallMs: +perCallMs.toFixed(3), intervals: results, withPeriod8ms: withPeriod });
    })()
  `);
  console.log('测量结果：', out);
  const d = JSON.parse(out);
  if (!d.error) {
    for (const [want, r] of Object.entries(d.intervals)) {
      const pxPerStep = (240 * (Number(want) / 1000)).toFixed(1);
      console.log(`  请求 ${want}ms/帧 → 实测 ${r.hz} Hz（${r.ticks} 帧 / ${r.elapsed}ms）；240px/s 时每步位移约 ${pxPerStep}px`);
    }
    console.log(`  提高系统定时器精度后（8ms 请求）→ ${d.withPeriod8ms} Hz`);
  }
  process.exit(0);
}

require('./lib-occupancy').warnBlockingInstances(); // 测量件只警告不拦（票 11-G 任务 4）
main().catch((err) => {
  console.error('测量失败:', err.message);
  process.exit(1);
});
