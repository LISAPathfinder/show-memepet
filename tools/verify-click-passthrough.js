// 真机终判判据（票 11-J 任务 1）：桌宠盖住的点位上，**第一次**注入点击必须归属桌面。
//
// 票面：桌宠盖住一个已知点位（现场里是桌面图标），指针停在那里 → 等 ≥1s → 注入一次真实点击
// → 断言 WindowFromPoint 的 GA_ROOT 归属 = 桌面（Progman/WorkerW），且**第一次就归属桌面**。
// 改前该判据要能复现「第一次归桌宠窗」（现场 1：同一位置连点 10 次全被 pet-root 吞）。
//
// 判别性设计（别改弱）：目标点取「当前上报并集包围盒外 6~12px、且距**每个**上报小盒 ≥16px」
// 的点——这个带在改前语义（包围盒 ∪ 16px 环）里判「区内」= 点击被桌宠窗吃掉（FAIL=改前形态）；
// 在改后语义（离散小盒 + 快速离开通道）里距所有元素都超出 FAST_EXIT_PAD → 一拍内穿透，
// 等 1.2s 后注入点击必归桌面（PASS）。等 1.2s 这一步同时兜住「FAST_EXIT_PAD 环内 600ms 保持」
// 的慢出口——本件考的是"稳态后第一次点击给谁"，不是切换延迟（延迟归 measure-exit-delay）。
//
// ⚠⚠ 本件移动真实光标并注入真实鼠标点击（SendInput），属「只有用户在场/授权才跑」的一类：
//    不带 --i-accept-real-input 时打印说明并 exit 3（前置不满足），绝不变相绕过。
//
// 用法：node tools/verify-click-passthrough.js --i-accept-real-input
//       （需 dev 隔离实例：--inspect=9229 --remote-debugging-port=9333；隔离 config 建议
//        cursorFleeEnabled=false，防长按触发「自动让开」挪走窗口——PITFALLS §76 教训③）
// 退出码：0 = 首次点击即归桌面；1 = 断言失败（含「第一次归了桌宠窗」的改前形态）；
//         3 = 前置不满足（未授权 / 占用 / 端口不通 / 找不到桌面根窗）。
const koffi = require('koffi');
const { assertNoBlockingInstances } = require('./lib-occupancy');

const user32 = koffi.load('user32.dll');
// ⚠ W 后缀 API 的字符串参数必须 'string16'（UTF-16）：'str' 是 UTF-8 char*，"Progman" 按
//   ANSI 字节被 FindWindowW 当 UTF-16 解释 → 永远找不到桌面根（首跑实锤，同 §61 子坑 5 一族；
//   已验证形态见 verify-taskbar-zorder.js）
const FindWindowW = user32.func('FindWindowW', 'uintptr', ['string16', 'string16']);
const FindWindowExW = user32.func('FindWindowExW', 'uintptr', ['uintptr', 'uintptr', 'string16', 'string16']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']);
const GetAncestor = user32.func('GetAncestor', 'uintptr', ['uintptr', 'uint32']);
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr', ['int64']);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const MOUSEINPUT = koffi.struct('MOUSEINPUT_VCP', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});
const INPUT = koffi.struct('INPUT_VCP', { type: 'uint32', mi: MOUSEINPUT });
const SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
const GA_ROOT = 2;
const LEFTDOWN = 0x0002;
const LEFTUP = 0x0004;
const packPoint = (x, y) => (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
const rootOf = (h) => (h ? Number(GetAncestor(h, GA_ROOT)) : 0);
const className = (h) => {
  const b = Buffer.alloc(512);
  const n = GetClassNameW(h, b, 256);
  return n > 0 ? b.toString('utf16le', 0, n * 2) : '';
};
// 桌面根集合：Progman + 桌面级 WorkerW（本机实测 18 个 WorkerW，图标宿主 SysListView32 挂在
// 桌面级 WorkerW 下而非 Progman 下——断言只认 Progman 会把「第一次点击命中桌面图标」误判成
// FAIL，而「点桌宠旁边的文件能点中」恰是票 11-J 票面场景的成功形态，2026-10-05 实跑修正）
function findDesktopRoots() {
  const roots = [];
  const push = (h) => {
    const root = rootOf(h);
    if (root && !roots.some((r) => r.hwnd === root)) roots.push({ hwnd: root, cls: className(root) });
  };
  const progman = FindWindowW('Progman', null);
  if (progman) push(progman);
  let worker = 0;
  do {
    worker = FindWindowExW(0, worker, 'WorkerW', null);
    if (worker) push(worker);
  } while (worker);
  return roots;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(port, pick) {
  return (async () => {
    let targets;
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      console.error('前置不满足（exit 3）：调试端口 ' + port + ' 连不上——先起 dev 隔离实例');
      process.exit(3);
    }
    const t = pick(targets);
    if (!t) {
      console.error('前置不满足（exit 3）：端口 ' + port + ' 上找不到目标');
      process.exit(3);
    }
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

// 点到矩形集的最小外部距离（在任一矩形内为 0）
const distOut = (p, rects) => {
  let d = Infinity;
  for (const r of rects) {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
    d = Math.min(d, Math.hypot(dx, dy));
  }
  return d;
};

(async () => {
  if (process.argv[2] !== '--i-accept-real-input') {
    console.error(
      '前置不满足（exit 3）：本件注入真实鼠标点击、移动真实光标，只有用户在场/授权才跑。\n' +
        '确认在场后用 `node tools/verify-click-passthrough.js --i-accept-real-input` 重跑。'
    );
    process.exit(3);
  }
  assertNoBlockingInstances('verify-click-passthrough.js');

  const desktops = findDesktopRoots();
  if (!desktops.length) {
    console.error('前置不满足（exit 3）：找不到桌面根窗（Progman/WorkerW）');
    process.exit(3);
  }
  const isDesktopRoot = (root) => desktops.some((d) => d.hwnd === root);
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));

  const info = JSON.parse(
    await mainProc(`(() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      const b = w.getBounds();
      return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, hwnd: w.getNativeWindowHandle().readBigUInt64LE(0).toString() });
    })()`)
  );
  const petRoot = rootOf(BigInt(info.hwnd));
  const boxes = JSON.parse(
    await renderer(
      '(() => { const b = interactiveBox(); const arr = Array.isArray(b) ? b : b ? [b] : []; return JSON.stringify(arr.filter(r => r.width > 0 && r.height > 0).map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }))); })()'
    )
  );
  if (!boxes.length) {
    console.error('前置不满足（exit 3）：渲染端上报盒读不到');
    process.exit(3);
  }
  // 上报盒换到屏幕坐标
  const screenBoxes = boxes.map((r) => ({ x: info.x + r.x, y: info.y + r.y, width: r.width, height: r.height }));
  const bb = screenBoxes.reduce(
    (a, r) => ({
      x1: Math.min(a.x1, r.x),
      y1: Math.min(a.y1, r.y),
      x2: Math.max(a.x2, r.x + r.width),
      y2: Math.max(a.y2, r.y + r.height),
    }),
    { x1: 1e9, y1: 1e9, x2: -1e9, y2: -1e9 }
  );

  // 目标点：包围盒外 6~12px 的带（改前=环内被吞；改后距每盒 ≥16px → 快速穿透），
  // 四向候选，取第一个满足「距每个上报小盒 ≥16px 且在屏幕内」的
  const edges = [
    { x: bb.x1 - 9, y: Math.round((bb.y1 + bb.y2) / 2) },
    { x: bb.x2 + 9, y: Math.round((bb.y1 + bb.y2) / 2) },
    { x: Math.round((bb.x1 + bb.x2) / 2), y: bb.y1 - 9 },
    { x: Math.round((bb.x1 + bb.x2) / 2), y: Math.min(bb.y2 + 9, info.y + info.h - 20) },
  ];
  const target = edges.find((p) => p.x > 4 && p.y > 4 && distOut(p, screenBoxes) >= 16);
  if (!target) {
    console.error('前置不满足（exit 3）：找不到「包围盒外 6~12px 且距每个小盒 ≥16px」的目标点（布局异常）');
    process.exit(3);
  }
  console.log(`① 桌宠窗口 ${info.x},${info.y} ${info.w}x${info.h}；上报盒 ${screenBoxes.length} 个；目标点 ${target.x},${target.y}（包围盒外 ~9px、距最近小盒 ${Math.round(distOut(target, screenBoxes))}px）`);
  console.log(`   桌面根集合=[${desktops.map((d) => '0x' + d.hwnd.toString(16) + '(' + d.cls + ')').join(', ')}]  桌宠根=0x${petRoot.toString(16)}`);

  // 指针停到目标点：先压到脸上（保证起点是可交互、petLastInsidePos 有值），再移过去，等 1.2s
  const face = screenBoxes.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  SetCursorPos(Math.round(face.x + face.width / 2), Math.round(face.y + face.height / 2));
  await sleep(700);
  SetCursorPos(target.x, target.y);
  await sleep(1200);

  // 注入一次真实点击（按住 80ms），期间 5ms 采样 WindowFromPoint 的 GA_ROOT 归属
  const samples = [];
  let sampling = true;
  const timer = setInterval(() => {
    if (!sampling) return;
    const hit = Number(WindowFromPoint(packPoint(target.x, target.y)));
    samples.push({ t: Date.now(), root: rootOf(hit), cls: className(hit) });
  }, 5);
  const send = (flags) => SendInput(1, [{ type: 0, mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } }], koffi.sizeof(INPUT));
  send(LEFTDOWN);
  await sleep(80);
  send(LEFTUP);
  await sleep(150);
  sampling = false;
  clearInterval(timer);

  const first = samples[0] || { root: 0, cls: '?' };
  const toDesktop = samples.filter((s) => isDesktopRoot(s.root)).length;
  const toPet = samples.filter((s) => s.root === petRoot).length;
  console.log(`② 点击期间采样 ${samples.length} 次：归属桌面体系 ${toDesktop} 次、归属桌宠根 ${toPet} 次；首次归属 root=0x${(first.root || 0).toString(16)}(${first.cls})`);
  const ok = samples.length > 0 && isDesktopRoot(first.root) && toPet === 0;
  console.log(ok ? 'PASS：第一次点击即归桌面体系（不归桌宠窗——「被吞」形态未复现）' : 'FAIL：第一次点击未归桌面体系（若首次归属桌宠根 = 改前「被吞」形态复现）');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
