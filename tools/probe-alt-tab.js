// 「Alt-Tab / 任务视图会列出哪些窗口」侦察件（1.0.31 摘掉锚点窗 WS_EX_TOOLWINDOW 后的
// 回归排查，PITFALLS §67）：按 shell 的近似过滤条件枚举顶层窗口——
//   可见 && 非 WS_EX_TOOLWINDOW && 未被 DWM cloak
// 命中的窗口就是 Alt-Tab 候选（真实任务视图还有自己的聚合逻辑，终判仍以人眼为准）。
// 用法：
//   node tools/probe-alt-tab.js                列出全系统 Alt-Tab 候选
//   node tools/probe-alt-tab.js --pet          只列本应用（identity.EXE_BASENAMES）/ electron 进程的候选
// 配合 dev/安装版日志里的「锚点窗口 HWND=0x…」对号入座。
const koffi = require('koffi');
const { EXE_BASENAMES } = require('../identity');

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const kernel32 = koffi.load('kernel32.dll');

// koffi 3.x 的回调（koffi.proto/register）在本机全部「cannot be used as a parameter」，
// 不赌它——枚举顶层窗口改走 GetDesktopWindow → GW_CHILD → GW_HWNDNEXT 链
// （与 EnumWindows 等价，main.js petCovered 同款遍历模式）；out 参用普通 Buffer。
const GetWindow = user32.func('GetWindow', 'uintptr', ['uintptr', 'uint']);
const GetDesktopWindow = user32.func('GetDesktopWindow', 'uintptr', []);
const GW_CHILD = 5;
const GW_HWNDNEXT = 2;
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr']);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['uintptr', 'void *', 'int']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']);
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['uintptr', 'void *']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);
const DwmGetWindowAttribute = dwmapi.func('DwmGetWindowAttribute', 'int32', ['uintptr', 'uint32', 'void *', 'uint32']);
const OpenProcess = kernel32.func('OpenProcess', 'uintptr', ['uint32', 'bool', 'uint32']);
const CloseHandle = kernel32.func('CloseHandle', 'bool', ['uintptr']);
const QueryFullProcessImageNameW = kernel32.func('QueryFullProcessImageNameW', 'bool', ['uintptr', 'uint32', 'void *', 'void *']);

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function exeNameOf(pid) {
  let h = 0;
  try {
    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return '?';
    const buf = Buffer.alloc(1024);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(512); // 容量（UTF-16 字符数），in/out
    if (!QueryFullProcessImageNameW(h, 0, buf, size)) return '?';
    const full = buf.toString('utf16le', 0, size.readUInt32LE(0) * 2);
    return full.split('\\').pop() || '?';
  } catch {
    return '?';
  } finally {
    if (h) CloseHandle(h);
  }
}

const rows = [];
const collect = (hwnd) => {
  try {
    if (!IsWindowVisible(hwnd)) return true;
    const ex = Number(BigInt(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & 0xffffffffn);
    if (ex & WS_EX_TOOLWINDOW) return true;
    const cloak = Buffer.alloc(4);
    if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloak, 4) === 0 && cloak.readUInt32LE(0) !== 0) return true;
    const tb = Buffer.alloc(512);
    const tn = GetWindowTextW(hwnd, tb, 256);
    const title = tn > 0 ? tb.toString('utf16le', 0, tn * 2) : '(无标题)';
    const cbb = Buffer.alloc(512);
    const cn = GetClassNameW(hwnd, cbb, 256);
    const cls = cn > 0 ? cbb.toString('utf16le', 0, cn * 2) : '?';
    const pidBuf = Buffer.alloc(4);
    GetWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    const rb = Buffer.alloc(16);
    let size = '?';
    if (GetWindowRect(hwnd, rb)) {
      size = `${rb.readInt32LE(8) - rb.readInt32LE(0)}x${rb.readInt32LE(12) - rb.readInt32LE(4)}@${rb.readInt32LE(0)},${rb.readInt32LE(4)}`;
    }
    rows.push({ hwnd: `0x${hwnd.toString(16)}`, pid, exe: exeNameOf(pid), cls, title, size });
  } catch {
    // 单窗失败不影响枚举
  }
  return true;
};

// 从桌面窗口的子窗口链头沿 NEXT 遍历全部顶层窗口（EnumWindows 的等价走法）
for (let h = GetWindow(GetDesktopWindow(), GW_CHILD); h; h = GetWindow(h, GW_HWNDNEXT)) {
  collect(h);
}

const pet = process.argv.includes('--pet');
// 双认映像名（票 11-A，迁移期新旧 exe 名并存）；electron 仍宽匹配——本件是侦察件
// （列候选给人眼复核），不是 fail-closed 守卫，保持原有语义不动
const hits = rows.filter((r) => {
  const name = r.exe.toLowerCase();
  return EXE_BASENAMES.some((n) => n.toLowerCase() === name) || /electron/i.test(name);
});
const list = pet ? hits : rows;
console.log(`Alt-Tab 候选窗口共 ${rows.length} 个${pet ? `，其中桌宠相关 ${hits.length} 个` : ''}：`);
for (const r of list) {
  console.log(`  ${r.hwnd}  pid=${String(r.pid).padEnd(6)}  ${r.exe.padEnd(16)}  ${r.cls.padEnd(24)}  ${String(r.size).padEnd(18)}  "${r.title}"`);
}
if (pet && hits.length === 0) console.log('  （桌宠相关进程没有任何 Alt-Tab 候选——锚点/桌宠窗都被过滤）');
console.log('\n注：真实 Alt-Tab（任务视图）还有自己的聚合与过滤逻辑，此列表是近似条件；最终以人眼按一次 Alt+Tab 为准。');
