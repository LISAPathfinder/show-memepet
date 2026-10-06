// 读桌宠各窗口的「真实」扩展样式（不依赖调试端口，可直接对安装版使用）：
// 判定 WS_EX_TRANSPARENT（点击穿透）是否真的挂在窗口上，是排查「点不动」的硬证据。
// 用法：node tools/probe-window-style.js            （自动从日志找句柄；每条都校验「归属 PID 属于
//       本应用进程 + 类名 Chrome_WidgetWin_1」，一条不过都不打表——进程退出后句柄值会被系统
//       复用给别家窗口，不校验归属就会把 Chrome/DirectUI 等窗口当桌宠读数；判据落在终判层这条纪律
//       见开发协议铁律 3，协议本机维护、不随公开版发布）
//       node tools/probe-window-style.js 0x123456   （手动指定某个句柄，显式要求、不做归属校验）
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { EXE_BASENAMES, LOG_CANDIDATES, isAppImage } = require('../identity');
const { installedDataRoot, lastError } = require('./lib-container');

const EX = {
  0x00000020: 'WS_EX_TRANSPARENT(点击穿透)',
  0x00080000: 'WS_EX_LAYERED(分层/透明窗)',
  0x00000080: 'WS_EX_TOOLWINDOW(不进任务栏)',
  0x08000000: 'WS_EX_NOACTIVATE(不抢焦点)',
  0x00040000: 'WS_EX_APPWINDOW',
};
const GWL_EXSTYLE = -20;

const user32 = koffi.load('user32.dll');
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr']);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']);
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['uintptr', 'void *']);

// 归属校验要用进程快照与映像路径（纯 node + koffi，铁律 5）
const kernel32 = koffi.load('kernel32.dll');
// PROCESSENTRY32W 字段偏移用 koffi.offsetof 取：x64 上 th32DefaultHeapID 是 8 字节对齐的
// ULONG_PTR，中间有 padding，手算偏移必错
const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: 'uint16[260]',
});
const CreateToolhelp32Snapshot = kernel32.func('CreateToolhelp32Snapshot', 'uintptr', ['uint32', 'uint32']);
const Process32FirstW = kernel32.func('Process32FirstW', 'bool', ['uintptr', 'void *']);
const Process32NextW = kernel32.func('Process32NextW', 'bool', ['uintptr', 'void *']);
const CloseHandle = kernel32.func('CloseHandle', 'bool', ['uintptr']);
const OpenProcess = kernel32.func('OpenProcess', 'uintptr', ['uint32', 'bool', 'uint32']);
const QueryFullProcessImageNameW = kernel32.func('QueryFullProcessImageNameW', 'bool', ['uintptr', 'uint32', 'void *', 'void *']);

const INVALID_HANDLE = 0xffffffffffffffffn;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function ownerPidOf(hwnd) {
  const pid = Buffer.alloc(4);
  GetWindowThreadProcessId(hwnd, pid);
  return pid.readUInt32LE(0);
}

function imageFullPath(pid) {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h || h === 0n) return '';
  try {
    const buf = Buffer.alloc(1024);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(512);
    if (!QueryFullProcessImageNameW(h, 0, buf, len)) return '';
    return buf.toString('utf16le', 0, len.readUInt32LE(0) * 2);
  } finally {
    CloseHandle(h);
  }
}

// 「本应用进程」的 PID 集合：安装版按 identity.EXE_BASENAMES 认映像名（迁移期双认新旧名，票 11-A）；
// dev 是 electron.exe，但只认映像路径含本应用标识的（别的项目也会拉起同名 electron.exe，不能混进来）
function collectPetPids() {
  const TH32CS_SNAPPROCESS = 0x2;
  const size = koffi.sizeof(PROCESSENTRY32W);
  const offPid = koffi.offsetof(PROCESSENTRY32W, 'th32ProcessID');
  const offExe = koffi.offsetof(PROCESSENTRY32W, 'szExeFile');
  const pids = new Set();
  const hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!hSnap || hSnap === INVALID_HANDLE) return pids;
  try {
    const entry = Buffer.alloc(size);
    entry.writeUInt32LE(size, 0);
    const all = new Map(); // pid -> 映像名
    let ok = Process32FirstW(hSnap, entry);
    while (ok) {
      all.set(entry.readUInt32LE(offPid), entry.toString('utf16le', offExe, offExe + 520).replace(/\0.*$/, ''));
      ok = Process32NextW(hSnap, entry);
    }
    for (const [pid, exe] of all) {
      const name = exe.toLowerCase();
      if (isAppImage(name)) { pids.add(pid); continue; }
      if (name === 'electron.exe' && isAppImage(imageFullPath(pid))) pids.add(pid);
    }
  } finally {
    CloseHandle(hSnap);
  }
  return pids;
}

const str16 = (fn, h, size) => {
  const buf = Buffer.alloc(size * 2);
  fn(h, buf, size);
  return buf.toString('utf16le').replace(/\0.*$/, '');
};

function rectOf(hwnd) {
  const r = Buffer.alloc(16);
  GetWindowRect(hwnd, r);
  // RECT 是 left/top/right/bottom，宽高要自己减（直接拿 right/bottom 当宽高是经典错误）
  const l = r.readInt32LE(0);
  const t = r.readInt32LE(4);
  return { l, t, w: r.readInt32LE(8) - l, h: r.readInt32LE(12) - t };
}

// 收集日志里的候选句柄：数据目录可能有好几份（装机 + 开发），按日志文件的
// 修改时间从新到旧扫。这里只负责收集，不判断有效性——
// 「是否仍然有效」必须靠归属校验（PID + 类名），不能拿尺寸/IsWindow 当判据
function collectCandidates() {
  // 装机日志目录从 HKCU 卸载键反推（tools/lib-container.js，票 11-R 起——不再写本机路径字面量）；
  // 取不到必须明说，不许把"装机日志没参与"藏成零候选
  const installed = installedDataRoot();
  if (installed) console.log(`容器 = ${installed.container}（来源：${installed.from}）→ 装机日志目录 ${installed.dataDir}`);
  else console.error('未取到安装容器，本件只查了 dev 目录' + (lastError() ? `（${lastError()}）` : ''));
  const roots = [
    ...(installed ? [installed.dataDir] : []),
    path.join(__dirname, '..', 'data'),
  ];
  const out = [];
  for (const root of roots) {
    // 迁移期双认（票 11-A）：候选日志名逐个试，同目录新旧名并存时按 mtime 取最新
    const found = [];
    for (const name of LOG_CANDIDATES) {
      const f = path.join(root, name);
      try {
        found.push({ f, mtime: fs.statSync(f).mtimeMs, txt: fs.readFileSync(f, 'utf8') });
      } catch {
        // 该候选不存在，试下一个
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    for (const { f, mtime, txt } of found) {
      for (const m of txt.matchAll(/(桌宠窗口|锚点窗口) HWND=0x([0-9a-f]+)/g)) {
        out.push({ label: m[1], hwnd: BigInt('0x' + m[2]), from: f, mtime });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const arg = process.argv[2];
const watch = arg === '--watch';
const argHwnd = watch ? process.argv[3] : arg;

// fail-closed：日志句柄必须先过归属校验才允许打表。桌宠进程退出后，句柄值会被系统
// 复用给别的进程（实测把 Chrome_RenderWidgetHostHWND / DirectUIHWND 当过「桌宠窗口」，
// IsWindow 还全为 true），只看 IsWindow/尺寸属于代理指标，防不住复用（铁律 3）。
const PET_CLASS = 'Chrome_WidgetWin_1'; // Electron BrowserWindow 顶层窗类名（桌宠窗与锚点窗都是）

let targets;
if (argHwnd) {
  targets = [{ label: process.argv[4] || '指定窗口', hwnd: BigInt(argHwnd), from: '命令行参数' }];
} else {
  const appPids = collectPetPids();
  const valid = [];
  const rejected = [];
  let deadCount = 0;
  for (const c of collectCandidates()) {
    if (!IsWindow(c.hwnd)) { deadCount++; continue; } // 纯失效是老日志常态，静默跳过
    const pid = ownerPidOf(c.hwnd);
    const cls = str16(GetClassNameW, c.hwnd, 128);
    if (appPids.has(pid) && cls === PET_CLASS) valid.push(c);
    else rejected.push({ c, pid, cls });
  }
  if (!valid.length) {
    console.error('读数无效：桌宠进程未运行 / 句柄已被复用，日志里的 HWND 不可信，不打印样式表。');
    if (!appPids.size) {
      console.error(`  本机未发现本应用进程（安装版映像名 ${EXE_BASENAMES.join(' / ')}，或 dev 的 electron.exe）→ 桌宠进程未运行。`);
    }
    for (const r of rejected) {
      console.error(`  ✗ ${r.c.label} HWND=0x${r.c.hwnd.toString(16)}（来自 ${r.c.from}）：归属 PID=${r.pid} 类名=${r.cls} —— 不属于本应用进程，句柄已被别的窗口复用`);
    }
    if (deadCount) console.error(`  （另有 ${deadCount} 条日志句柄已失效 IsWindow=false）`);
    console.error('  请先启动桌宠再跑本工具；或手动指定句柄：node tools/probe-window-style.js 0x123456');
    process.exit(1);
  }
  targets = valid;
}

// 持续监测：每 250ms 采样一次，只在「光标是否在窗内」或「是否穿透」发生变化时打印一行。
// 用途：鼠标必须一直悬停在桌宠上才能复现时，先起这个再看/点——免得跑一次命令就把鼠标移开了。
if (watch) {
  const pet = targets.find((t) => t.label === '桌宠窗口') || targets[0];
  console.log(`持续监测 ${pet.label} HWND=0x${pet.hwnd.toString(16)}（250ms 一次，变化时才打印；Ctrl+C 结束）`);
  let last = '';
  setInterval(() => {
    const c = Buffer.alloc(8);
    GetCursorPos(c);
    const px = c.readInt32LE(0);
    const py = c.readInt32LE(4);
    const r = rectOf(pet.hwnd);
    const ex = Number(BigInt(GetWindowLongPtrW(pet.hwnd, GWL_EXSTYLE)) & 0xffffffffn);
    const inside = px >= r.l && px <= r.l + r.w && py >= r.t && py <= r.t + r.h;
    const ignore = !!(ex & 0x20);
    const key = `${inside}|${ignore}`;
    if (key === last) return;
    last = key;
    console.log(
      `${new Date().toLocaleTimeString()} 光标=(${px},${py}) 光标在窗内=${inside ? '是' : '否'}  ` +
        (ignore ? '窗口=穿透 WS_EX_TRANSPARENT' : '窗口=可接收点击') +
        (inside && ignore ? '   ← ★ 异常：光标在桌宠上却仍穿透，点击必然进不来' : '')
    );
  }, 250);
} else {
  const cur = Buffer.alloc(8);
  GetCursorPos(cur);
  const cx = cur.readInt32LE(0);
  const cy = cur.readInt32LE(4);
  console.log(`光标=(${cx},${cy})\n`);

  for (const t of targets) {
    const h = t.hwnd;
    if (!argHwnd && (!IsWindow(h) || rectOf(h).w <= 0)) continue;
    const r = rectOf(h);
    const ex = Number(BigInt(GetWindowLongPtrW(h, GWL_EXSTYLE)) & 0xffffffffn);
    const inside = cx >= r.l && cx <= r.l + r.w && cy >= r.t && cy <= r.t + r.h;
    console.log(`${t.label}  HWND=0x${h.toString(16)}  类名=${str16(GetClassNameW, h, 128)}  （来自 ${t.from}）`);
    console.log(`  可见=${IsWindowVisible(h)}  位置=${r.l},${r.t} ${r.w}x${r.h}  光标在窗口内=${inside}`);
    // 期望值取窗口真源（票 11-E 任务 5）：1.0.52 起桌宠窗固定 600×600、与 petScale 无关
    // （PITFALLS §74，常量真源 main.js PET_WINDOW_SIZE）；随缩放变的是「视觉尺寸」（300×petScale），
    // 那不是窗口尺寸——本工具读的是窗口矩形，按整窗口径判。
    if (t.label === '桌宠窗口' && (r.w !== 600 || r.h !== 600)) {
      console.log('  ⚠ 尺寸不是 600x600：1.0.52 起桌宠窗恒为 600×600（固定窗，与缩放无关）。');
      console.log('    读到别的尺寸 = 这条日志来自 1.0.52 之前的旧实例，或句柄已被系统复用给别的窗口；');
      console.log('    请让桌宠以当前版本重启一次再跑本工具，再对照上面打印的实际尺寸判断。');
    }
    console.log(`  EXSTYLE=0x${ex.toString(16).padStart(8, '0')}`);
    for (const [bit, name] of Object.entries(EX)) {
      if (ex & Number(bit)) console.log(`    ✓ ${name}`);
    }
    const ignore = !!(ex & 0x20);
    console.log(
      ignore
        ? '  → 当前「点击穿透」：点到它身上会被转发到下层窗口'
        : '  → 当前「可接收点击」：若此时点在它身上仍无反应，问题不在穿透'
    );
    if (inside && ignore) console.log('  ★ 异常：光标就在它身上却仍是穿透状态——点击必然进不来');
    console.log('');
  }
  console.log('提示：锚点窗口是 1×1 级、不可见的辅助窗口，正常应始终带 WS_EX_TRANSPARENT；');
  console.log('      若它没有该标志，就会变成一个看不见的挡板（它在屏幕左上角，通常不影响桌宠）。');
  console.log('      想「保持鼠标悬停在桌宠上」观察，用：node tools/probe-window-style.js --watch');
}
