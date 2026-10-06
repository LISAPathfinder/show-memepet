// petCovered 按 alpha 判定（票 5）的三窗回归：koffi 造三种分层窗压在 dev 桌宠上，断言重申链路的反应。
// 判据来源：PITFALLS §61 子坑 4（★3/★4 两组一手机测）。
// 用例（自包含：自己起 dev 实例、隔离应用数据根与 Chromium userData、盯实例自己的日志；
//       spawn 前自检已有桌宠实例，占用即 exit 3 —— PITFALLS §65 子坑 6）：
//   1) SLWA alpha=255（肉眼完全不透明分层窗）→ 2.5s 内出现「置顶重申」且归名=造窗类名
//      （机制上界：3 拍 × 500ms 防抖 + tick 相位，见 main.js coverStreak）；
//   2) SLWA alpha=128（半透明）→ 零候选、零重申（该类名）；
//   3) ULW per-pixel（全 alpha=0 位图，模拟 BongoCat 形态）→ 零候选、零重申（保住 §61 子坑 4）。
//   每用例打印造窗的 GLWA 读数（probe-layered-attr.js 同口径）作证据。
// 退出码：0 = 三用例全过；1 = 有断言不过或环境不满足（实测读数见输出）；
//         2 = 整体超时/未捕获异常；3 = 已有桌宠实例在跑（本件要求独占，理由见 findBlockingInstances）。
// 临时目录（%TEMP%\petcover-alpha-*）纪律：exit 0 时删掉自己建的隔离数据目录；非 0 退出
// 保留现场便于查因，并打印应用日志（identity.LOG_NAME）/ electron-stdout.log 的完整路径（手动删即可）。
// 纯 node + koffi，不引入 Electron 依赖（铁律 5）。koffi 造窗走 §61 子坑 5 的定型写法：
// lpfnWndProc 用 GetProcAddress(DefWindowProcW) 裸地址、lpsz* 用 'void *' + utf16le Buffer、
// func() 声明在 koffi.struct() 之后。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LOG_NAME } = require('../identity');
const { findBlockingInstances } = require('./lib-occupancy'); // 票 11-G 任务 4：占用自检抽库共用

const ROOT = path.resolve(__dirname, '..');
const koffi = require(path.join(ROOT, 'node_modules', 'koffi'));

// ---- user32 / gdi32 / kernel32 声明 ----
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const WNDCLASSW = koffi.struct('WNDCLASSW', {
  style: 'uint32',
  lpfnWndProc: 'uintptr', // 直接赋 DefWindowProcW 裸地址，不需要 koffi.register/proto（§61 子坑 5）
  cbClsExtra: 'int32',
  cbWndExtra: 'int32',
  hInstance: 'uintptr',
  hIcon: 'void *',
  hCursor: 'void *',
  hbrBackground: 'void *',
  lpszMenuName: 'void *',
  lpszClassName: 'void *', // 'str16' 字段会让 RegisterClassW 静默失败（§61 子坑 5），用 Buffer
});
const GetModuleHandleW = kernel32.func('GetModuleHandleW', 'uintptr', ['void *']);
const GetProcAddress = kernel32.func('GetProcAddress', 'uintptr', ['uintptr', 'str']);
// 占用自检用（findBlockingInstances）：票 11-G 任务 4 起抽到 tools/lib-occupancy.js 共用（见 require）
const RegisterClassW = user32.func('RegisterClassW', 'uint16', ['WNDCLASSW *']);
const CreateWindowExW = user32.func('CreateWindowExW', 'uintptr', ['uint32', 'void *', 'void *', 'uint32', 'int', 'int', 'int', 'int', 'uintptr', 'uintptr', 'uintptr', 'void *']);
const DestroyWindow = user32.func('DestroyWindow', 'bool', ['uintptr']);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr']);
const SetWindowPos = user32.func('SetWindowPos', 'bool', ['uintptr', 'uintptr', 'int', 'int', 'int', 'int', 'uint32']);
const GetDC = user32.func('GetDC', 'uintptr', ['uintptr']);
const ReleaseDC = user32.func('ReleaseDC', 'int', ['uintptr', 'uintptr']);
const CreateCompatibleDC = gdi32.func('CreateCompatibleDC', 'uintptr', ['uintptr']);
const DeleteDC = gdi32.func('DeleteDC', 'bool', ['uintptr']);
const DeleteObject = gdi32.func('DeleteObject', 'bool', ['uintptr']);
const SelectObject = gdi32.func('SelectObject', 'uintptr', ['uintptr', 'uintptr']);
const PatBlt = gdi32.func('PatBlt', 'bool', ['uintptr', 'int', 'int', 'int', 'int', 'uint32']);
const CreateDIBSection = gdi32.func('CreateDIBSection', 'uintptr', ['uintptr', 'void *', 'uint32', 'void **', 'uintptr', 'uint32']);
// UpdateLayeredWindow 第 8 参是 BLENDFUNCTION *（4 字节：BlendOp/BlendFlags/SourceConstantAlpha/AlphaFormat），第 9 参才是 dwFlags
const UpdateLayeredWindow = user32.func('UpdateLayeredWindow', 'bool', ['uintptr', 'uintptr', 'void *', 'void *', 'uintptr', 'void *', 'uint32', 'void *', 'uint32']);
// 照抄 findings 第六节（勿改参数形式）
const SLWA = user32.func('bool __stdcall SetLayeredWindowAttributes(uintptr hwnd, uint32 crKey, uint8 bAlpha, uint32 flags)');
const GLWA = user32.func('bool __stdcall GetLayeredWindowAttributes(uintptr hwnd, uint32 *pKey, uint8 *pAlpha, uint32 *pFlags)');

const WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000;
const WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000;
const LWA_ALPHA = 0x2, ULW_ALPHA = 2, BLACKNESS = 0x42;
const HWND_TOPMOST = 0xffffffff;
const SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
const SWP_CLAMP = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
const DefWindowProcWAddr = GetProcAddress(GetModuleHandleW(Buffer.from('user32.dll\0', 'utf16le')), 'DefWindowProcW');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const utf16 = (s) => Buffer.from(s + '\0', 'utf16le');

function glwaOf(hwnd) {
  const k = Buffer.alloc(4), a = Buffer.alloc(1), f = Buffer.alloc(4);
  k.writeUInt32LE(0xcdabcd00); a[0] = 0xcd; f.writeUInt32LE(0xffffffff);
  const ret = GLWA(hwnd, k, a, f);
  if (!ret) return 'ret=false（出参零写入，哨兵原样 → per-pixel/DComp 或未设 SLWA 属性）';
  return `ret=true crKey=0x${k.readUInt32LE(0).toString(16)} bAlpha=${a[0]} flags=0x${f.readUInt32LE(0).toString(16)}`;
}

// 造 TOPMOST 分层窗（不显示内容语义交给 SLWA/ULW），返回 hwnd
function makeOverlay(className, x, y, w, h, useUlw) {
  const clsName = utf16(className);
  const wc = {
    style: 0,
    lpfnWndProc: DefWindowProcWAddr,
    cbClsExtra: 0, cbWndExtra: 0,
    hInstance: 0, hIcon: null, hCursor: null, hbrBackground: null,
    lpszMenuName: null,
    lpszClassName: clsName,
  };
  if (!RegisterClassW(wc)) throw new Error(`RegisterClassW(${className}) 失败`);
  const ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED;
  const hwnd = CreateWindowExW(ex, clsName, clsName, WS_POPUP | WS_VISIBLE, x, y, w, h, 0, 0, 0, null);
  if (!hwnd || !IsWindow(hwnd)) throw new Error(`CreateWindowExW(${className}) 失败`);
  if (useUlw) {
    // per-pixel 分层：全 alpha=0 的 32bpp DIB（模拟 BongoCat——肉眼透明、LAYERED 置位、
    // 不走 SLWA，GLWA 应为 ret=false；本用例同时把这一读数坐实）
    const hdcScreen = GetDC(0);
    const bmi = Buffer.alloc(40);
    bmi.writeUInt32LE(40, 0); // biSize
    bmi.writeInt32LE(w, 4); bmi.writeInt32LE(-h, 8); // top-down
    bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(32, 14); // planes, 32bpp BI_RGB
    const ppvBits = Buffer.alloc(8);
    const hbmp = CreateDIBSection(hdcScreen, bmi, 0, ppvBits, 0, 0);
    const hdcMem = CreateCompatibleDC(hdcScreen);
    const old = SelectObject(hdcMem, hbmp);
    PatBlt(hdcMem, 0, 0, w, h, BLACKNESS); // 位图清 0 → alpha 全 0 → 全透明
    const pptSize = Buffer.alloc(8), pptSrc = Buffer.alloc(8);
    pptSize.writeInt32LE(w, 0); pptSize.writeInt32LE(h, 4);
    // BLENDFUNCTION：BlendOp=AC_SRC_OVER(0)、BlendFlags=0、SourceConstantAlpha=255、AlphaFormat=AC_SRC_ALPHA(1)
    const blend = Buffer.from([0, 0, 255, 1]);
    const ok = UpdateLayeredWindow(hwnd, hdcScreen, null, pptSize, hdcMem, pptSrc, 0, blend, ULW_ALPHA);
    SelectObject(hdcMem, old);
    DeleteDC(hdcMem); DeleteObject(hbmp); ReleaseDC(0, hdcScreen);
    if (!ok) { DestroyWindow(hwnd); throw new Error('UpdateLayeredWindow 失败'); }
  }
  SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
  return hwnd;
}

// ---- CDP 连接（口径照 verify-passthrough.js）----
function connectTarget(target) {
  return (async () => {
    if (!target) throw new Error('CDP 目标不存在');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let seq = 0;
    const evaluate = (expression) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (msg.result && msg.result.exceptionDetails) { reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluate 失败')); return; }
          resolve(msg.result.result.value);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
    return { evaluate };
  })();
}

let child = null;
let tmpData = null;
const waitSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function cleanup(exitCode) {
  try {
    if (child && child.pid) {
      // spawnSync：exit 处理器是同步的，异步 taskkill 等不到它完成就要删目录了
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
    if (!tmpData) return;
    if (exitCode !== 0) {
      // 失败现场保留：应用日志（identity.LOG_NAME）/ electron-stdout.log 是查因证据
      console.error(`-- 运行失败（exit=${exitCode}）：临时数据目录保留供查因`);
      console.error(`   ${LOG_NAME}      : ${path.join(tmpData, LOG_NAME)}`);
      console.error(`   electron-stdout.log  : ${path.join(tmpData, 'electron-stdout.log')}`);
      console.error(`   （目录本体: ${tmpData}，查因后可手动删）`);
      return;
    }
    // 强杀后 electron 的日志/LevelDB 句柄不会立刻释放，直接删必撞 EBUSY：宽限 + 重试兜住
    waitSync(400);
    try {
      fs.rmSync(tmpData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.error(`⚠ 临时数据目录删除失败（保留供查因）: ${tmpData}\n  ${e && e.message}`);
    }
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(2));
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e); process.exit(2); });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`);
}

// ---- 已有实例占用自检（票 9 / PITFALLS §65 子坑 6）----
// userData 隔离后单实例锁不再互斥，但本件仍要求独占：第二个桌宠会在 TOPMOST band 顶插队，
// 污染 petCovered 的 z 序与归名判定（§61 子坑 3，票 3' 前置同款）。spawn 前把占用挑明，
// 别让人等 30s 拿到「渲染端未就绪」的误导文案。实现自 1.0.56（票 11-G 任务 4）起在
// tools/lib-occupancy.js（枚举逻辑原样未动），此处保留本件专属的文案与 exit 3 收尾。

async function main() {
  // 占用检测放在 mkdtemp 之前：exit 3 时 tmpData 尚为 null，不留任何临时目录
  const blockers = findBlockingInstances();
  if (blockers === null) {
    console.error('⚠ 无法自检已有实例（进程枚举不可用），继续执行——若稍后报「渲染端 30s 未就绪」，先想到单实例锁/双实例插队（PITFALLS §65 子坑 6）');
  } else if (blockers.length) {
    console.error('✗ 单实例锁被占用，本件要求独占实例，请先退出正在运行的桌宠：');
    for (const b of blockers) console.error(`   pid=${b.pid}  ${b.name}  ${b.exe}`);
    console.error('（userData 已随数据根一并隔离，锁本身不再互斥；拦的是双实例 TOPMOST band 顶插队对 z 序/归名判定的污染——§61 子坑 3。此前的失败形态：抢不到锁 20s 后 app.quit，误报「渲染端 30s 未就绪」）');
    process.exit(3);
  }
  tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'petcover-alpha-'));
  const logPath = path.join(tmpData, LOG_NAME);
  const out = fs.openSync(path.join(tmpData, 'electron-stdout.log'), 'a');
  console.log(`[env] 数据目录隔离：${tmpData}`);

  // 起 dev 实例（错峰纪律：起跑前确认 9229/9333 无占用由外部保证，见票面并发纪律）
  // ELECTRON_RUN_AS_NODE 必须从环境里删掉（置空串不够——Electron 的 HasVar 只查存在性）：
  // WorkBuddy 等 Electron 宿主的子进程环境里带着它，继承进来会让 electron.exe 以纯 node
  // 模式启动 → app undefined，main.js 直接炸
  // PET_USER_DATA_DIR 一并隔离（main.js:35-36 的测试接缝）：单实例锁活在 Chromium userData 里，
  // 此前只隔 SHOWCASE_DATA_DIR（应用数据根），装机版在跑时这里自起的实例必然抢不到锁 →
  // main.js:1663 重试 20s 后 app.quit() → 误报「渲染端 30s 未就绪」（PITFALLS §65 子坑 6 根因）
  // 数据根隔离（票 11-B 第 5c 条引入）：旧名 DESKTOP_PET_DATA_DIR 双传已随票 11-Q 退休（⑥，
  // config.js 不再读旧名）——只传新名即可
  const childEnv = {
    ...process.env,
    SHOWCASE_DATA_DIR: tmpData,
    PET_USER_DATA_DIR: tmpData,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(require(path.join(ROOT, 'node_modules', 'electron')), ['.', '--inspect=9229', '--remote-debugging-port=9333'], {
    cwd: ROOT, stdio: ['ignore', out, out],
    env: childEnv,
  });

  // 等渲染端 pet.html 就绪
  let petTarget = null;
  for (let i = 0; i < 150 && !petTarget; i++) {
    await wait(200);
    try {
      const ts = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      petTarget = ts.find((t) => t.url && t.url.endsWith('pet.html')) || null;
    } catch {}
  }
  if (!petTarget) { console.error(`✗ 30s 内渲染端 pet.html 未就绪（electron-stdout.log: ${path.join(tmpData, 'electron-stdout.log')}）`); process.exit(1); }
  await wait(1500); // 初始化稳定（穿透状态、重申定时器等）
  const main = await connectTarget(await (async () => {
    const ts = await (await fetch('http://127.0.0.1:9229/json/list')).json();
    return ts.find((t) => t.type === 'node') || ts[0];
  })());

  const petHwnd = parseInt(await main.evaluate(`
    (() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('pet.html'));
      if (!w) return '';
      return '0x' + w.getNativeWindowHandle().readBigUInt64LE(0).toString(16);
    })()`), 16);
  const bounds = JSON.parse(await main.evaluate(`
    (() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('pet.html'));
      return JSON.stringify(w.getBounds());
    })()`));
  if (!petHwnd || !IsWindow(petHwnd)) { console.error('✗ 拿不到有效的桌宠窗口句柄'); process.exit(1); }
  console.log(`[env] 桌宠 HWND=0x${petHwnd.toString(16)} bounds=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);

  // 遮挡矩形：桌宠矩形外扩 60px；测试期间把桌宠钳回初始位置（walk/flee 会自己动，§61 子坑 5 方法学）
  const pad = 60;
  const ox = bounds.x - pad, oy = bounds.y - pad;
  const ow = bounds.width + pad * 2, oh = bounds.height + pad * 2;
  const clampTimer = setInterval(() => {
    try { SetWindowPos(petHwnd, 0, bounds.x, bounds.y, 0, 0, SWP_CLAMP); } catch {}
  }, 250);

  const logSize = () => { try { return fs.statSync(logPath).size; } catch { return 0; } };
  // 基线与读取必须同口径（字节）：日志含中文，readFileSync('utf8') 的 slice 按字符数切，
  // 与 statSync().size 的字节数对不上，会整段切错（首跑用例 1 因此漏看已落盘的重施行）
  const readLogFrom = (from) => { try { return fs.readFileSync(logPath).slice(from).toString('utf8'); } catch { return ''; } };

  const cases = [
    { name: '用例1 SLWA alpha=255（不透明分层窗）→ 应重申且归名', cls: 'PetCoverProbe255', mode: 'alpha255' },
    { name: '用例2 SLWA alpha=128（半透明）→ 零候选零重申', cls: 'PetCoverProbe128', mode: 'alpha128' },
    { name: '用例3 ULW per-pixel（全透明，BongoCat 形态）→ 零候选零重申', cls: 'PetCoverProbeULW', mode: 'ulw' },
  ];

  for (const c of cases) {
    console.log(`\n== ${c.name} ==`);
    const base = logSize();
    const hwnd = makeOverlay(c.cls, ox, oy, ow, oh, c.mode === 'ulw');
    if (c.mode === 'alpha255') SLWA(hwnd, 0, 255, LWA_ALPHA);
    if (c.mode === 'alpha128') SLWA(hwnd, 0, 128, LWA_ALPHA);
    SetWindowPos(hwnd, HWND_TOPMOST, ox, oy, ow, oh, SWP_NOACTIVATE);
    console.log(`  造窗 HWND=0x${hwnd.toString(16)} 矩形=(${ox},${oy})-(${ox + ow},${oy + oh}) GLWA: ${glwaOf(hwnd)}`);

    if (c.mode === 'alpha255') {
      const t0 = Date.now();
      let seen = null, firstCandidate = null;
      while (Date.now() - t0 < 4000) {
        await wait(100);
        const delta = readLogFrom(base);
        if (firstCandidate === null) {
          const cand = delta.split('\n').find((l) => l.includes('置顶遮挡候选') && l.includes(c.cls));
          if (cand) firstCandidate = { at: Date.now() - t0, line: cand.trim() };
        }
        const hit = delta.split('\n').find((l) => l.includes('置顶重申') && l.includes(c.cls));
        if (hit) { seen = { at: Date.now() - t0, line: hit.trim() }; break; }
      }
      if (firstCandidate) console.log(`  候选行 @${firstCandidate.at}ms: ${firstCandidate.line}`);
      record('1.5s 防抖链路内出现置顶重申（观测窗 2.5s）', !!seen && seen.at <= 2500,
        seen ? `${seen.at}ms（机制上界=3拍×500ms+tick相位）` : '4s 观测窗内未出现');
      record('归名=造窗类名', !!seen && seen.line.includes(c.cls));
      if (seen) console.log(`  重施行 @${seen.at}ms: ${seen.line}`);
    } else {
      await wait(4500); // ≥4 拍 + 余量：候选在第 1 拍就会落盘，4.5s 足够暴露误判
      const delta = readLogFrom(base);
      const bad = delta.split('\n').filter((l) => (l.includes('置顶遮挡候选') || l.includes('置顶重申')) && l.includes(c.cls));
      record('零候选、零重申（按类名过滤）', bad.length === 0, bad.length ? bad[0].trim() : '观测窗 4.5s 内无相关日志');
    }

    try { DestroyWindow(hwnd); } catch {}
    await wait(800); // streak 归零（窗已销毁，下一拍 petCovered 必为 null）
  }

  clearInterval(clampTimer);
  console.log('\n== 汇总 ==');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
  const ok = results.every((r) => r.ok);
  console.log(ok ? '结论：PASS（petCovered alpha 判定三窗回归通过）' : '结论：FAIL');
  process.exit(ok ? 0 : 1);
}

setTimeout(() => { console.error('✗ 整体超时（120s）'); process.exit(2); }, 120000).unref();
main().catch((e) => { console.error('✗', e); process.exit(2); });
