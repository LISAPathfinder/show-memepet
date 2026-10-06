// 检查桌宠窗口此刻在 z 链上是否压着任务栏（Shell_TrayWnd）：
// 「桌宠被任务栏盖住」的硬证据，也是 PITFALLS §60（周期重申置顶）的验收工具。
// 用法：node tools/verify-taskbar-zorder.js
// 退出码：0 = 桌宠在任务栏上层（或不重叠）；1 = 被任务栏盖住；2 = 环境异常（窗不在等）
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { LOG_CANDIDATES } = require('../identity');
const { installedDataRoot, lastError } = require('./lib-container');

const user32 = koffi.load('user32.dll');
const FindWindowW = user32.func('FindWindowW', 'uintptr', ['string16', 'string16']);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr']);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr']);
const GetWindow = user32.func('GetWindow', 'uintptr', ['uintptr', 'uint']);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);

const GW_HWNDNEXT = 2; // z 链中位于其下方（被它盖住）的窗口
const GW_HWNDPREV = 3; // z 链中位于其上方（盖住它）的窗口
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x8;

function rectOf(hwnd) {
  const r = Buffer.alloc(16);
  GetWindowRect(hwnd, r);
  const l = r.readInt32LE(0);
  const t = r.readInt32LE(4);
  return { l, t, r: r.readInt32LE(8), b: r.readInt32LE(12) };
}

function overlap(a, b) {
  return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}

// 从日志抓最新的桌宠窗口句柄：数据目录可能有好几份（装机 + 开发），按日志
// 修改时间从新到旧扫，取仍然有效的最后一条（与 probe-window-style.js 同思路）。
// 装机日志目录从 HKCU 卸载键反推（tools/lib-container.js，票 11-R 起——不再写本机路径字面量）；
// 取不到必须明说。它**不会因此打绿灯**：零候选走下方 exit 2（环境异常），exit 0 只来自真实句柄
function pickPetHwnd() {
  const installed = installedDataRoot();
  if (installed) console.log(`容器 = ${installed.container}（来源：${installed.from}）`);
  else console.log('未取到安装容器，本件只查了 dev 目录' + (lastError() ? `（${lastError()}）` : ''));
  const roots = [
    ...(installed ? [installed.dataDir] : []),
    path.join(__dirname, '..', 'data'),
  ];
  const files = [];
  for (const root of roots) {
    // 迁移期双认（票 11-A）：候选日志名逐个试（改名过渡期旧版可能还在写旧名）
    for (const name of LOG_CANDIDATES) {
      const f = path.join(root, name);
      try {
        files.push({ f, mtime: fs.statSync(f).mtimeMs });
      } catch {
        // 没有这份日志就跳过
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files) {
    const txt = fs.readFileSync(f, 'utf8');
    const ms = [...txt.matchAll(/桌宠窗口 HWND=0x([0-9a-f]+)/g)];
    for (let i = ms.length - 1; i >= 0; i--) {
      const hwnd = BigInt('0x' + ms[i][1]);
      if (IsWindow(hwnd)) return { hwnd, from: f };
    }
  }
  return null;
}

// 沿某个方向走 z 链，返回是否在撞到上限前遇到 target（附带走了几步）
function walkChain(from, target, dir) {
  let h = GetWindow(from, dir);
  let steps = 0;
  while (h && steps < 500) {
    if (h === target) return { hit: true, steps };
    h = GetWindow(h, dir);
    steps++;
  }
  return { hit: false, steps };
}

const pet = pickPetHwnd();
if (!pet) {
  console.log('✗ 日志里没有仍有效的桌宠窗口句柄——先启动桌宠再跑本工具');
  process.exit(2);
}
const taskbar = FindWindowW('Shell_TrayWnd', null);
if (!taskbar) {
  console.log('✗ 没找到 Shell_TrayWnd（任务栏窗口），环境异常');
  process.exit(2);
}

const petRect = rectOf(pet.hwnd);
const barRect = rectOf(taskbar);
const petEx = Number(BigInt(GetWindowLongPtrW(pet.hwnd, GWL_EXSTYLE)) & 0xffffffffn);
const barEx = Number(BigInt(GetWindowLongPtrW(taskbar, GWL_EXSTYLE)) & 0xffffffffn);
const above = walkChain(pet.hwnd, taskbar, GW_HWNDPREV); // 往上：任务栏在桌宠上方 = 被盖
const below = above.hit ? null : walkChain(pet.hwnd, taskbar, GW_HWNDNEXT);

console.log(`任务栏   HWND=0x${taskbar.toString(16)}  rect=${JSON.stringify(barRect)}  TOPMOST=${(barEx & WS_EX_TOPMOST) ? '✓' : '✗'}`);
console.log(`桌宠窗口 HWND=0x${pet.hwnd.toString(16)}  rect=${JSON.stringify(petRect)}  TOPMOST=${(petEx & WS_EX_TOPMOST) ? '✓' : '✗'}  可见=${IsWindowVisible(pet.hwnd) ? '✓' : '✗'}  (句柄来自 ${pet.from})`);
console.log(`矩形重叠=${overlap(petRect, barRect) ? '是（z 顺序影响观感）' : '否（互不相碰，仅记录链序）'}`);

if (above.hit) {
  console.log(`✗ 桌宠被任务栏盖住：任务栏在 z 链上方 ${above.steps} 步处。若非刚被「反扑」的 3 秒窗口期，说明置顶重申没生效（查 PITFALLS §60）`);
  process.exit(1);
}
if (below && below.hit) {
  console.log(`✓ 桌宠在任务栏上层（z 链下方 ${below.steps} 步处是任务栏）`);
  process.exit(0);
}
console.log('? z 链上未在同链遇到任务栏（可能跨 band），请人工目视确认');
process.exit(2);
