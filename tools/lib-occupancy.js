// 占用自检共用库（票 11-G 任务 4）：findBlockingInstances 从 verify-petcovered-alpha.js 原样抽出，
// 供「会 attach 调试端口 / 起 dev 实例」的诊断件统一调用。
//
// 退出码语义（全项目诊断件统一，DIAGNOSTICS.md 诊断表有登记）：
//   0 = 断言全绿；1 = 断言失败（脚本自身异常也落 1，stderr 打「脚本异常：<原因>」区分）；
//   3 = 前置不满足（含已有实例占用）。
// 必拦（exit 3）的是 verify-* 回归件：第二个实例（= 装机版；dev 隔离实例是被测对象不算）
// 的 TOPMOST band / 光标轮询 / z 序会污染判据（PITFALLS §61 子坑 3）——不是「抢单实例锁」（userData 已隔离，锁不互斥）。
// probe/measure 类测量件只警告不拦：它们常被当判据读，但拦掉会断掉「对装机版在跑时的
// 现场取样」这个正当用法，改为 stderr 一行「读数可能被污染」。
// 纯 node + koffi，不引入 Electron 依赖（铁律 5）。
const path = require('node:path');
const koffi = require(path.join(__dirname, '..', 'node_modules', 'koffi'));
const { isAppImage } = require('../identity');

const kernel32 = koffi.load('kernel32.dll');
// 占用自检用：进程内枚举，不拉 PowerShell 子进程（会话沙箱/执行策略会禁）
const K32EnumProcesses = kernel32.func('K32EnumProcesses', 'bool', ['uint32 *', 'uint32', 'uint32 *']);
const OpenProcess = kernel32.func('OpenProcess', 'uintptr', ['uint32', 'bool', 'uint32']);
const QueryFullProcessImageNameW = kernel32.func('QueryFullProcessImageNameW', 'bool', ['uintptr', 'uint32', 'void *', 'uint32 *']);
const CloseHandle = kernel32.func('CloseHandle', 'bool', ['uintptr']);

// ---- 已有实例占用自检（票 9 / PITFALLS §65 子坑 6 引入，票 11-G 任务 4 抽出共用）----
// 返回命中列表；null = 检测手段不可用（调用方自行决定警告放行还是硬失败）。
// 全量语义：装机版映像名直认 + 本项目 dev electron.exe（路径含 exe 名主干）也算——
// 仅供**自起实例的独占件**（verify-petcovered-alpha）使用：它要 spawn 自己的 dev 实例，
// 场地里任何现成桌宠（含别人的 dev）都是污染源。
function findBlockingInstances() {
  // 进程内枚举（EnumProcesses + QueryFullProcessImageNameW），不拉 PowerShell——spawn 子进程的
  // 探测手段在会话沙箱/执行策略下会静默失败（实测 spawnSync powershell 直接不行），
  // 而进程内 API 没有这个失败面，也不吃 PATH；PROCESS_QUERY_LIMITED_INFORMATION 跨提权可读
  // 映像路径（装机版以管理员运行也认得出）。
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  let size = 2048; // 先给 2048 个 pid 坑，不够再扩一倍（EnumProcesses 常规两段式）
  let pids, needed = Buffer.alloc(4);
  for (;;) {
    pids = Buffer.alloc(size * 4);
    if (!K32EnumProcesses(pids, size * 4, needed)) return null;
    if (needed.readUInt32LE(0) <= size * 4) break;
    size *= 2;
  }
  const count = needed.readUInt32LE(0) / 4;
  const hits = [], unresolved = [];
  for (let i = 0; i < count; i++) {
    const pid = pids.readUInt32LE(i * 4);
    if (!pid) continue;
    const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) { unresolved.push(pid); continue; }
    const buf = Buffer.alloc(520); // 260 WCHAR，路径上限
    const sz = Buffer.alloc(4); sz.writeUInt32LE(260);
    const ok = QueryFullProcessImageNameW(h, 0, buf, sz);
    CloseHandle(h);
    if (!ok) { unresolved.push(pid); continue; }
    const exe = buf.toString('utf16le', 0, sz.readUInt32LE(0) * 2);
    const base = exe.slice(exe.lastIndexOf('\\') + 1).toLowerCase();
    if (isAppImage(exe)) {
      hits.push({ pid, name: base, exe });
    }
  }
  // 那行「打不开句柄」的提示只在**一个实例都没命中**时才打——本机常态就有 150+ 个系统进程开不了句柄
  // （实测 305 pid / 148 能开），命中到实例时不必用这种噪声干扰读数；只在"可能因此假放行"时提醒。
  if (unresolved.length && !hits.length)
    console.error(`   （占用自检：${unresolved.length} 个进程打不开句柄未识别，多为系统进程属常态；若怀疑漏认请 pwsh 侧 Get-Process 复核）`);
  return hits;
}

// 外接式件（连 dev 隔离实例跑判据的 verify-* / probe-* / measure-*）专用：只拦**装机版**
// 映像名进程。dev 的 electron.exe 是它们的**被测对象**，不是污染源——isAppImage 对本项目
// 路径下的 electron.exe 也返回 true（路径含检出目录主干或 showcase 主干，identity.DEV_PATH_STEMS；
// 票 11-Q 前这层识别搭 EXE_BASENAMES 双认的车，旧映像名退休后改挂检出位置），直接用全量版会把
// 测试对象拦掉、件永远连不上自己的实例（票 11-G 任务 4 落地时实测定案）。
// 装机版映像名 = EXE_BASENAMES 直名（票 11-Q 起只有 Showcase.exe；旧名 desktop-pet.exe 双认已撤），
// electron.exe 不在内。
function findBlockingInstalledInstances() {
  const hits = findBlockingInstances();
  if (hits === null) return null;
  return hits.filter((b) => b.name !== 'electron.exe');
}

// 必拦模式（外接式 verify-* 回归件用）：有装机版实例 → 打印 pid/映像名 → exit 3；
// 枚举不可用 → 警告后放行（沿用 verify-petcovered-alpha 的旧行为，别把「查不出」当成「没有」）。
// 注意拦的是装机版：dev 隔离实例是这些件的被测对象，不拦（见 findBlockingInstalledInstances）。
function assertNoBlockingInstances(toolName) {
  const blockers = findBlockingInstalledInstances();
  if (blockers === null) {
    console.error('⚠ 无法自检已有实例（进程枚举不可用），继续执行——若读数可疑，先想到双实例污染（§61 子坑 3）');
    return;
  }
  if (!blockers.length) return;
  console.error(`✗ 检测到 ${blockers.length} 个正在运行的桌宠实例，${toolName} 要求独占，请先退出正在运行的桌宠：`);
  for (const b of blockers) console.error(`   pid=${b.pid}  ${b.name}  ${b.exe}`);
  console.error('（userData 已随数据根隔离，这不是单实例锁问题；拦的是第二实例的 TOPMOST band / 光标轮询 / z 序对判据的污染——§61 子坑 3）');
  process.exit(3);
}

// 警告模式（probe/measure 测量件用）：有装机版实例 → stderr 一行提示，不改退出码、不拦。
function warnBlockingInstances() {
  const blockers = findBlockingInstalledInstances();
  if (blockers === null || !blockers.length) return;
  console.error(`⚠ 有 ${blockers.length} 个装机版桌宠实例在跑，读数可能被污染（本件是探针/测量件，只警告不拦）：`);
  for (const b of blockers) console.error(`   pid=${b.pid}  ${b.name}  ${b.exe}`);
}

module.exports = { findBlockingInstances, findBlockingInstalledInstances, assertNoBlockingInstances, warnBlockingInstances };
