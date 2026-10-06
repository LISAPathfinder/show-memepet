// 构建后校验 app.asar 完整性：防止「内容错位」的坏包流出到安装。
// 背景（2026-09-25，PITFALLS §4.9）：1.0.12 某次构建产出的 app.asar 头部索引正常，
// 但 package.json 的内容区是「package.json 中后段 + preload.js 开头」的错位拼接——
// Electron 读不到 main 入口 → 双击后 0.6 秒静默退出（退出码 0、无 stderr、无日志）。
// 因此：**每次 npm run dist 之后、安装之前，必须先跑本工具**。
//
// 用法（纯 node，无 Electron 依赖）：
//   node tools/verify-asar.js <app.asar 路径>   校验指定 asar
//   node tools/verify-asar.js                    自动校验 ../<BUILD_DIR_NAME>/release/win-unpacked
// 退出码：0 = 通过；1 = 有问题。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BUILD_DIR_NAME } = require('../identity');

let asar;
try {
  asar = require('@electron/asar');
} catch {
  console.error('缺少 @electron/asar：请在本项目根目录（node_modules）下运行');
  process.exit(1);
}

const PROJ_ROOT = path.join(__dirname, '..');
// 打进 asar 的项目源文件（package.json build.files 白名单的顶层条目），用于内容比对
// （identity.js 是名字单一真源，main.js/preload.js 都 require 它，票 11-A 起纳入比对；
// 两个 autostart 件同理是 main.js 直接 require 的顶层模块——autostart-elevation.js 此前漏登，
// autostart-migration.js 为票 11-C 新增，本清单按自身口径补齐）
const TOP_FILES = ['main.js', 'identity.js', 'preload.js', 'config.js', 'skins.js', 'gamepad-xinput.js', 'lines.js', 'keylistener.js', 'menu-layout.js', 'walk.js', 'autostart-elevation.js', 'autostart-migration.js'];

const targets = process.argv[2]
  ? [process.argv[2]]
  : [path.join(PROJ_ROOT, '..', BUILD_DIR_NAME, 'release', 'win-unpacked', 'resources', 'app.asar')];

let failed = false;

for (const asarPath of targets) {
  const problems = [];
  if (!fs.existsSync(asarPath)) {
    console.error(`[FAIL] 不存在: ${asarPath}`);
    failed = true;
    continue;
  }
  // ① 头部索引可读
  let info, header;
  try {
    info = asar.getRawHeader(asarPath);
    header = info.header;
  } catch (err) {
    console.error(`[FAIL] 头部索引读取失败 ${asarPath}: ${err.message}`);
    failed = true;
    continue;
  }

  // ② package.json 可解析且有 main 字段（坏包最先坏在这里）
  let pkg = null;
  const pkgEntry = header.files['package.json'];
  if (!pkgEntry) {
    problems.push('asar 里没有 package.json');
  } else {
    try {
      const buf = readEntry(asarPath, info.headerSize, pkgEntry);
      pkg = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      problems.push(`package.json 不是合法 JSON（内容错位的典型症状）: ${err.message.slice(0, 80)}`);
    }
  }
  if (pkg && !pkg.main) problems.push('package.json 缺少 main 字段');

  // ③ main 入口文件存在且非空
  if (pkg && pkg.main) {
    const mainEntry = header.files[pkg.main];
    if (!mainEntry || mainEntry.size === 0) {
      problems.push(`入口文件 ${pkg.main} 不在 asar 里或为空`);
    }
  }

  // ④ 关键源文件与项目源比对（能抓住「索引对、内容错」的一切错位）
  // 行尾归一（票 11-C 任务 2）：本机 core.autocrlf=true，git checkout 触碰过的文件工作副本是 CRLF，
  // 而 asar 里存的是构建那一刻的工作副本字节（往往是 LF）——按原始字节 sha 比对会把
  // 「内容完全相同、只差行尾」误报成内容错位（2026-10-04 校验轮实录的假红真因）。
  // 归一范围仅限行尾：CRLF/CR → LF，两侧同样处理后再比；行中间的任何字符差仍然命中
  // （判别性自证见票 11-C 验收 b：往 identity.js 变量名处插一个空格必须仍 exit 1——
  // 若归一把断言变成恒真，就是「假红」换成了「假绿」）。
  for (const name of TOP_FILES) {
    const entry = header.files[name];
    if (!entry) {
      problems.push(`缺少 ${name}`);
      continue;
    }
    const src = path.join(PROJ_ROOT, name);
    if (!fs.existsSync(src)) continue; // 项目源都不在了，比对无从谈起（别的环节会暴露）
    const inAsar = readEntry(asarPath, info.headerSize, entry);
    const onDisk = fs.readFileSync(src);
    if (sha256(normalizeEol(inAsar)) !== sha256(normalizeEol(onDisk))) {
      problems.push(`${name} 内容与项目源不一致（错位/截断，行尾归一后 asar sha256=${sha256(normalizeEol(inAsar)).slice(0, 12)}…）`);
    }
  }

  if (problems.length) {
    console.error(`[FAIL] ${asarPath}`);
    for (const p of problems) console.error('  - ' + p);
    failed = true;
  } else {
    console.log(`[PASS] ${asarPath}（package.json 可解析、main=${pkg.main}、${TOP_FILES.length} 个源文件行尾归一后比对一致）`);
  }
}

process.exit(failed ? 1 : 0);

// ---- helpers ----

function readEntry(asarPath, headerSize, entry) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, 8 + headerSize + Number(entry.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

// 行尾归一：CRLF / 孤立 CR 一律折成 LF。只动行尾，不动任何其它字节（见 ④ 的注释）
function normalizeEol(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
