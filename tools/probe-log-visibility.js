// logLine 落盘可见性分流实验（票 11-T 任务 5；结清 2026-10-05 台账「新发现 1」的归因）。
//
// 背景：11-S 校验轮三次实测「工具读窗内判据行没有、稍后 grep 就有」，当时被记成
// 「logLine 落盘对读方有 1~2s 可见性延迟」。写侧 main.js 的 logLine 是
// fs.mkdirSync + fs.appendFileSync（同步、无缓冲、每次直达 fd）——秒级延迟不可能来自写盘。
// 本件按票面三分流逐项排除，不允许在归因做实前统一放大六件日志面判据的读窗：
// (a) 写侧可见性：同进程 appendFileSync 写哨兵 → 立刻 readFileSync 全文找哨兵，打毫秒差。
//     同步 fs 语义下应微秒级可见；若这里有毫秒级延迟才是「写盘延迟」。
// (b) 读写同源性：主进程写侧 = config.DATA_DIR（只认 SHOWCASE_DATA_DIR 覆盖；PET_USER_DATA_DIR
//     只改 Electron userData 层，不改 DATA_DIR）→ dev 实例无论怎么起都写仓内 data/；
//     工具读侧 = tools 里 LOG_CANDIDATES 第一个存在的文件（<仓>/data/ 下当前写用名）。
//     本件动态解析两侧路径并判定是否同文件（含装机目录的 <容器>\data 另算一侧）。
// (c) 读法核对：逐件扫 tools 里日志面判据的读法——全量 readFileSync + 行数切片（无 stat/size
//     偏移缓存）或有缓存。有「先 stat 后读」才可能造成读偏移。
// 结论去向：见台账「票 11-T 回填」。(a)(b)(c) 全排干净后，剩余唯一候选 = 触发链本身慢
// （渲染端 mousedown → ipcRenderer.send 异步投递 → 主进程忙时排队 → logLine 晚落盘）。
//
// 用法：node tools/probe-log-visibility.js [仓库根，默认 cwd]
// 退出码（铁律 3）：0 = 断言全绿；1 = 断言失败（写侧真出现延迟才可能）；3 = 前置不满足。
// 纯 fs 件：不接实例、无占用自检；探针写独立文件，不污染判据日志（当前写用日志只落一行对照）。
const fs = require('fs');
const path = require('path');
const { LOG_CANDIDATES } = require('../identity');

const root = path.resolve(process.argv[2] || process.cwd());
const dataDir = path.join(root, 'data');
if (!fs.existsSync(dataDir)) {
  console.error('前置不满足（exit 3）：data 目录不存在于 ' + dataDir);
  process.exit(3);
}

let pass = 0;
let fail = 0;
function assert(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

try {
  // ---- (a) 写侧可见性：200 次哨兵，写后立刻读 ----
  const PROBE_FILE = path.join(dataDir, 'log-visibility-probe.log');
  const N = 200;
  let worst = 0;
  let invisible = 0;
  for (let i = 0; i < N; i++) {
    const line = `[probe] visibility-sentinel #${i} @${Date.now()}ns-${Math.random().toString(36).slice(2, 8)}\n`;
    fs.mkdirSync(dataDir, { recursive: true }); // 与 logLine 完全同构：先 mkdir 再 append
    const t0 = process.hrtime.bigint();
    fs.appendFileSync(PROBE_FILE, line);
    const full = fs.readFileSync(PROBE_FILE, 'utf8'); // 「立刻读」= 下一条同步语句
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > worst) worst = ms;
    if (!full.includes(line.trim())) invisible++;
  }
  assert(invisible === 0, `(a) ${N} 次哨兵全部「写后立刻读即可见」（同步 fs 无缓冲，零不可见）`,
    `不可见=${invisible}，最慢一拍=${worst.toFixed(3)}ms`);
  assert(worst < 50, '(a) 最慢一拍也在 50ms 内（毫秒~秒级延迟不可能来自写盘）',
    `worst=${worst.toFixed(3)}ms`);

  // 写侧语义对照：对当前写用日志（LOG_CANDIDATES[0]，identity 读取）落一行对照哨兵
  const mainLog = path.join(dataDir, LOG_CANDIDATES[0]);
  const sentinel = `[probe] 同文件对照哨兵 ${new Date().toISOString()}（票 11-T 任务 5 (a)）`;
  const t0 = process.hrtime.bigint();
  fs.appendFileSync(mainLog, sentinel + '\n');
  const seen = fs.readFileSync(mainLog, 'utf8').includes(sentinel);
  const msMain = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(seen, `(a) 对真实日志 ${LOG_CANDIDATES[0]} 的对照哨兵同样立即可见`,
    `${msMain.toFixed(3)}ms（该行留在日志里，行首 [probe] 便于事后剔除）`);

  // ---- (b) 读写同源性 ----
  const showcaseDataDir = process.env.SHOWCASE_DATA_DIR || null;
  const petUserDataDir = process.env.PET_USER_DATA_DIR || null;
  const writeSide = showcaseDataDir || path.join(root, 'data'); // dev 主进程写侧（config.js DATA_DIR 同构）
  let readSide = path.join(dataDir, LOG_CANDIDATES[0]); // 工具读侧：LOG_CANDIDATES 第一个存在的
  for (const name of LOG_CANDIDATES) {
    try {
      if (fs.statSync(path.join(dataDir, name)).isFile()) { readSide = path.join(dataDir, name); break; }
    } catch {}
  }
  console.log(`  · (b) 主进程写侧 DATA_DIR = ${writeSide}${showcaseDataDir ? '（SHOWCASE_DATA_DIR 覆盖）' : '（dev 默认 = 仓内 data/）'}`);
  console.log(`  · (b) PET_USER_DATA_DIR = ${petUserDataDir || '未设'}——它只改 Electron userData 层，不改 DATA_DIR（main.js 测试接缝）`);
  console.log(`  · (b) 工具读侧 = ${readSide}`);
  assert(path.resolve(writeSide) === path.dirname(path.resolve(readSide)),
    '(b) dev 场景下写侧与读侧是同一目录（「读错文件」候选排除）',
    `${path.resolve(writeSide)} vs ${path.dirname(path.resolve(readSide))}`);
  if (petUserDataDir) {
    console.log('  · (b) ⚠ 本进程设了 PET_USER_DATA_DIR：CDP 自动化实例的 Chromium 层（缓存/崩溃转储）落它下面，但日志不落——日志仍走 DATA_DIR');
  }

  // ---- (c) 读法核对：逐件扫日志面判据的读法 ----
  // 判据口径（v2，v1 启发式把「选 LOG 文件的存在性 statSync」「mtime 排序」「koffi.offsetof」
  // 全误报成缓存——R 式教训：先看实况再写断言）。真正要排除的偏移缓存形态只有两种：
  //   ① statSync().size 被用作 slice/read 起点（字节偏移裁剪读内容）；
  //   ② 跨调用保留读位置的模块级状态（let last/saved/prev Size|Offset|Pos）。
  // verify-click-after 的 logSize()（statSync(LOG).size）是定义未用的死代码，且它注释明说
  // 「用行数而不是字节偏移切片」——不命中以上两种，属正常全量重读。
  const toolsDir = path.join(__dirname);
  const journalUsers = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js') && f !== 'probe-log-visibility.js').map((f) => {
    const src = fs.readFileSync(path.join(toolsDir, f), 'utf8');
    const readsLog = /readFileSync\(LOG|logLines|LOG_CANDIDATES/.test(src);
    if (!readsLog) return null;
    // 行切片判据件（logLines/newLinesSince/gotClickSince 形态）必须「全量 readFileSync + split('\n')」；
    // 全文检索件（readFileSync 后 includes/mtime 排序）不要求 split，只查缓存形态
    const isLineSlicer = /logLines\(|newLinesSince\(|gotClickSince\(/.test(src);
    const fullReread = !isLineSlicer || (/readFileSync\([^)]*['"]utf8['"]\)/.test(src) && /split\(['"]\\n['"]\)/.test(src));
    const sizeSlicing = /slice\([^)]*\.size\b|\.size\b[^;\n]*slice\(/.test(src);
    const offsetState = /\b(?:let|const)\s+\w*(?:last|saved|prev)(?:Size|Offset|Pos)\b/i.test(src);
    return { f, isLineSlicer, fullReread, cached: sizeSlicing || offsetState, sizeSlicing, offsetState };
  }).filter(Boolean);
  const cacheSuspects = journalUsers.filter((x) => x.cached);
  const slicerBroken = journalUsers.filter((x) => x.isLineSlicer && !x.fullReread);
  const slicers = journalUsers.filter((x) => x.isLineSlicer);
  console.log(`  · (c) 日志面判据件 ${journalUsers.length} 件（其中行切片判据 ${slicers.length} 件）：${journalUsers.map((x) => x.f).join('、')}`);
  assert(
    journalUsers.length > 0 && slicerBroken.length === 0 && cacheSuspects.length === 0,
    '(c) 行切片判据件全为「全量 readFileSync 重读 + 行数切片」、无字节偏移裁剪、无跨调用读位置状态（「读法缓存」候选排除）',
    [
      slicerBroken.length ? `非全量重读的行切片件：${slicerBroken.map((x) => x.f).join('、')}` : null,
      cacheSuspects.length ? `疑似带缓存的件：${cacheSuspects.map((x) => `${x.f}(sizeSlicing=${x.sizeSlicing},offsetState=${x.offsetState})`).join('、')}` : null,
    ].filter(Boolean).join('；') || '逐件核对无缓存'
  );

  // ---- 归纳 ----
  console.log('\n归纳：(a) 写盘立即可见 + (b) 读写同文件 + (c) 无读法缓存 ⇒ 「1~2s 才可见」的延迟不在读/写任何一侧，');
  console.log('剩余唯一候选 = 触发链本身慢：渲染端 mousedown → ipcRenderer.send（异步投递）→ 主进程忙时（120ms 轮询/置顶重申/koffi 调用挤主线程）排队 → logLine 晚落盘。');
  console.log('判据读窗的补偿方向应针对「落行晚」而非「读得晚」，且不许统一放大读窗（票 11-T 任务 5 禁令）——按件按场景重估。');

  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('脚本异常：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}
