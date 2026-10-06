// 穿透「单写入者」回归件（真断言，1.0.57 加固轮改写）：
//   A 渲染端拿不到穿透写入口（`petAPI.setIgnoreMouseEvents` 已摘）；
//   B 光标稳定压在形象上 1.75s（≥6 次轮询）期间，原生穿透位从未被置上且结束时仍可交互
//     —— 抓 §52 那个真实失效形态（记账与原生状态脱节 → 轮询不再下发 → 该可交互却卡在穿透）；
//   C 拖拽/玻璃通道 keepInteractive(true) 期间光标在窗外仍保持可交互；
//   D 关掉 keepInteractive、光标仍在窗外 → 回到穿透（保持可交互不是单向阀门）。
//
// 历史（为什么这个件长这样）：
//   1.0.56 及以前，preload 把 setIgnoreMouseEvents 暴露给渲染端、主进程还挂着
//   `pet:set-ignore-mouse-events` 处理器，本件的任务是「从渲染端写一次 ignore=true，
//   看主进程会不会自愈」。§52 的单写入者当时只是**约定**，靠处理器里同步 petIgnoreSent 兜住。
//   1.0.57 起入口整个摘掉（暴露 + 处理器都删），单写入者变成**结构事实**，
//   于是本件从「复现毒化→看自愈」改成「证明写不动」。静态侧由 tools/verify-single-writer.js 配套把关。
//   旧版的「③ 卡死 / ④ 救不回来」读数全部来自本件自己的两条测量法缺陷，见 PITFALLS §76。
//
// 前置（不满足 exit 3，不计入断言）：
//   · 无装机版实例在跑（占用自检 tools/lib-occupancy.js，§61 子坑 3；dev 隔离实例是被测对象不拦）；
//   · 9229/9333 可连且 pet.html 在；
//   · ① 光标压上形象上报盒中心后 ≤800ms 翻成可交互（轮询活着）——这一步同时保证 B 不是
//     「因为光标不在桌宠上所以一直穿透」的空断言。
//
// 测量法（1.0.56 票 11-G 修定的两条，别再退回去）：
//   · 瞄准点 = 渲染端实时上报的可交互盒中心（渲染端 CDP 调 interactiveBox()），**每步重取**；
//     固定窗（1.0.52）下窗口几何中心是视觉矩形左上角的空白处，瞄它会测出假「卡死」（§76）；
//   · 「鼠标久留自动让开」会把窗口挪走：本件每步重瞄兜住，复跑规程另在隔离 config 关
//     cursorFleeEnabled（config.js 已有键，不新增配置项）。
//
// 用法：node tools/verify-passthrough-desync.js   （需 dev 隔离实例带 --inspect=9229 --remote-debugging-port=9333）
// 退出码：0 = 断言全绿（末尾 PASS n/N）；1 = 断言失败 / 脚本自身异常（stderr 逐条列「哪一段、期望、实读」
//         或打「脚本异常：」行）；3 = 前置不满足（占用 / 端口不通 / ① 预期态读不到）。
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
require('./lib-occupancy').assertNoBlockingInstances('verify-passthrough-desync.js');

const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const WS_EX_TRANSPARENT = 0x20;
// 回落日志路径（主进程读不到自己数据目录时才用）：按候选序取第一个存在的日志文件（票 11-A 双认）
const LOG = (() => {
  for (const name of LOG_CANDIDATES) {
    const p = path.join(__dirname, '..', 'data', name);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return path.join(__dirname, '..', 'data', LOG_CANDIDATES[0]);
})();
let LOG_PATH = LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logTail = (n = 3) => {
  try {
    return fs
      .readFileSync(LOG_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .slice(-n)
      .join('\n    ');
  } catch {
    return `（日志读不到：${LOG_PATH}）`;
  }
};

const preFail = (msg) => {
  console.error(`前置不满足（exit 3）：${msg}`);
  process.exit(3);
};

function connect(port, pick) {
  return (async () => {
    let targets;
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      preFail(
        `调试端口 ${port} 连不上——隔离实例没起或没带调试参数。先起：` +
          `PET_USER_DATA_DIR/SHOWCASE_DATA_DIR 指到隔离目录后 ` +
          `node_modules/electron/dist/electron.exe --inspect=9229 --remote-debugging-port=9333 .`
      );
    }
    const t = pick(targets);
    if (!t) preFail(`端口 ${port} 上找不到目标（${port === 9333 ? '需要 pet.html 页面' : '需要主进程 node target'}）`);
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
  })();
}

(async () => {
  console.log('[regress] 单写入者回归：A/B/C/D 计入退出码，前置不满足 exit 3');
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));

  const petBounds = async () =>
    JSON.parse(
      await mainProc(`
      (() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
        const b = w.getBounds();
        return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, hwnd: w.getNativeWindowHandle().readBigInt64LE().toString() });
      })()
    `)
    );
  const style = (hwnd) => Number(GetWindowLongPtrW(Number(BigInt(hwnd)), -20));
  const transparent = async () => {
    const info = await petBounds();
    const ex = style(info.hwnd);
    return { transparent: (ex & WS_EX_TRANSPARENT) !== 0, ex, hwnd: info.hwnd, info };
  };

  // 隔离实例的日志在它自己的数据目录（仓库 data/ 是别的实例的），经 CDP 读真实路径；读不到再回落
  try {
    const dir = await mainProc(`process.mainModule.require('./config').DATA_DIR`);
    const name = await mainProc(`process.mainModule.require('./identity').LOG_NAME`);
    if (dir && name && fs.existsSync(path.join(dir, name))) LOG_PATH = path.join(dir, name);
  } catch {}

  // 瞄准点 = 渲染端实时上报的可交互盒中心（窗口内坐标 + 窗口原点），每步重取。
  // 1.0.59 票 11-J 任务 2 起上报是离散矩形数组：瞄**最大盒（=脸）**的中心——
  // 对数组取平均中心会落在元素之间的空隙上（§76 同型的几何假设坑）
  const aimPoint = async () => {
    const info = await petBounds();
    const raw = await renderer('(() => (typeof interactiveBox === "function" ? interactiveBox() : null))()');
    const rects = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((r) => r && r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const box = rects.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return {
      x: info.x + Math.round(box.x + box.width / 2),
      y: info.y + Math.round(box.y + box.height / 2),
      info,
    };
  };
  // 窗外点：窗口左侧外 ~120px（贴左缘时改窗口上方外），用于 C/D
  const outsidePoint = (info) => {
    const x = Math.max(5, info.x - 120);
    if (x < info.x) return { x, y: Math.max(5, info.y + info.h - 60) };
    return { x, y: Math.max(5, info.y - 120) };
  };

  // ---- 前置 ①：光标压上报映盒中心 → 轮询应翻成可交互 ----
  const aim = await aimPoint();
  if (!aim) preFail('渲染端上报的可交互盒读不到（interactiveBox() 为空）——页面没就绪或交互元素全隐藏');
  SetCursorPos(aim.x, aim.y);
  await sleep(800);
  const st1 = await transparent();
  console.log(`① 瞄上报盒中心 ${aim.x},${aim.y}（窗口 ${aim.info.x},${aim.info.y} ${aim.info.w}x${aim.info.h}），压上去后：`, JSON.stringify(st1), '\n   日志 >', logTail(2));
  if (st1.transparent)
    preFail(`① 光标压在形象上报盒中心 800ms 后仍是穿透（期望可交互）。ex=0x${st1.ex.toString(16)}。轮询没翻面：实例不是带调试端口的隔离实例、或主进程轮询已坏`);

  // ---- 断言 A（接口层）：渲染端拿不到穿透写入口 ----
  const apiKinds = await renderer(
    '(() => JSON.stringify({ setIgnore: typeof window.petAPI?.setIgnoreMouseEvents, keys: Object.keys(window.petAPI || {}).length }))()'
  );
  const { setIgnore: apiKind } = JSON.parse(apiKinds);
  const okA = apiKind === 'undefined';
  console.log(`A 渲染端 petAPI.setIgnoreMouseEvents 的类型：${apiKind}（期望 undefined）→ ${okA ? '写入口已摘 ✓' : '仍存在 ✗'}`);

  // ---- 断言 B（不变量层）：光标压在形象上时，连续 ≥6 次轮询内穿透位**一次都没被置上** ----
  // 这里原本设计成「渲染端穷举 petAPI 全部函数逐个试写」，实跑证明那个设计是错的（2026-10-04 首跑 exit 1）：
  // petAPI 上多数 API 有真实副作用——试调用会改 scale、结束拖拽、开菜单、上报点击与异常，
  // 桌宠因此被判成穿透是**正确行为**，不是写入口复活。判"渲染端写不动"的终判层不在这里：
  // 静态侧由 verify-single-writer.js 断言通道与暴露都不存在，运行时侧由 A 断言入口不可达。
  // 所以 B 改成非破坏性的不变量：光标稳定压在上报盒中心 1.75s（≥6 次轮询）期间，
  // busy-loop 监视原生穿透位**从未**置上、结束时仍可交互——它抓的是 §52 那个真实失效形态
  // （记账与原生状态脱节 → 轮询因「值没变」不再下发 → 该可交互却卡在穿透）。
  const hwndCached = st1.hwnd;
  let sawTransparent = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 1750) {
    if ((style(hwndCached) & WS_EX_TRANSPARENT) !== 0) {
      sawTransparent = true;
      break;
    }
  }
  const stB = await transparent();
  const okB = !sawTransparent && !stB.transparent;
  console.log(
    `B 光标压在形象上 1.75s（busy-loop 监视原生穿透位）：期间置上=${sawTransparent}，结束时实读「${stB.transparent ? '穿透' : '可交互'}」` +
      `（期望 置上=false 且 可交互）→ ${okB ? '未出现该可交互却卡穿透的形态 ✓' : '出现 §52 的卡死形态 ✗'}`
  );
  if (sawTransparent || stB.transparent) console.log('   日志 >', logTail(4));

  // ---- 诊断段 ④（非断言，不参与退出码）：光标移开再移回，轮询应重新判回可交互 ----
  SetCursorPos(Math.max(5, aim.x - 300), aim.y);
  await sleep(1200);
  const aim4 = await aimPoint();
  if (aim4) SetCursorPos(aim4.x, aim4.y);
  await sleep(900);
  const st4 = await transparent();
  console.log(`④（仅诊断，不计退出码）「移开再移回」后：${st4.transparent ? '仍穿透' : '可交互'}`);

  // ---- 断言 C：keepInteractive(true) + 光标在窗外 → 保持可交互 ----
  const aim5 = await aimPoint();
  if (!aim5) preFail('C 前…渲染端可交互盒读不到（页面在测试中途被换掉？）');
  const out5 = outsidePoint(aim5.info);
  await renderer('(window.petAPI.keepInteractive(true), "on")');
  SetCursorPos(out5.x, out5.y);
  await sleep(1500);
  const st5 = await transparent();
  const okC = !st5.transparent;
  console.log(`C 光标在窗口外 ${out5.x},${out5.y} + keepInteractive(true)：${okC ? '保持可交互 ✓' : '穿透了 ✗'}（期望「保持可交互」，实读「${st5.transparent ? '穿透' : '可交互'}」）`);
  await renderer('(window.petAPI.keepInteractive(false), "off")');

  // ---- 断言 D：关掉 keepInteractive、光标仍在外 → 回到穿透 ----
  await sleep(1600); // 保持期 600ms + 轮询余量
  const st6 = await transparent();
  const okD = st6.transparent;
  console.log(`D 关掉 keepInteractive、光标仍在外：${okD ? '回到穿透 ✓' : '仍是可交互 ✗'}（期望「回到穿透」，实读「${st6.transparent ? '穿透' : '可交互'}」）`);

  // 收尾：光标挪离窗口，别让余态影响下一个人
  const aimEnd = await aimPoint().catch(() => null);
  SetCursorPos(Math.max(5, (aimEnd ? aimEnd.info.x : 100) - 200), 5);

  const results = [
    { seg: 'A 渲染端无穿透写入口（petAPI.setIgnoreMouseEvents）', expect: 'undefined（已摘）', actual: apiKind, ok: okA },
    { seg: 'B 光标压在形象上 1.75s 期间穿透位从未置上且维持可交互', expect: '置上=false／可交互', actual: `置上=${sawTransparent}／${stB.transparent ? '穿透' : '可交互'}`, ok: okB },
    { seg: 'C keepInteractive(true) + 光标在窗外', expect: '可交互（保持）', actual: st5.transparent ? '穿透' : '可交互', ok: okC },
    { seg: 'D 关闭 keepInteractive、光标仍在外', expect: '穿透（回到）', actual: st6.transparent ? '穿透' : '可交互', ok: okD },
  ];
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n断言失败 ${failed.length}/${results.length}：`);
    for (const f of failed) console.error(`  段 ${f.seg}：期望 ${f.expect}；实读 ${f.actual}`);
  }
  console.log(`PASS ${passed}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  // 脚本自身异常也落 1，但打「脚本异常：」行与断言失败区分（票 11-G 任务 4 退出码语义）
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exit(1);
});
