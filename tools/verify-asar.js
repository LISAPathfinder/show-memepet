// @runtime: artifact —— 校验构建产物 app.asar 指纹（release/win-unpacked），出包后安装前跑
// 构建后校验 app.asar 完整性：防止「内容错位」的坏包流出到安装。
// 背景（2026-09-25，PITFALLS §4.9）：1.0.12 某次构建产出的 app.asar 头部索引正常，
// 但 package.json 的内容区是「package.json 中后段 + preload.js 开头」的错位拼接——
// Electron 读不到 main 入口 → 双击后 0.6 秒静默退出（退出码 0、无 stderr、无日志）。
// 因此：**每次 npm run dist 之后、安装之前，必须先跑本工具**。
//
// 比对清单（不再手抄，2026-10-08 闭包钉子轮）：
//   - 根目录 js = require('./x') 相对闭包 ∩ 根目录 js，由 tools/verify-build-files.js 的
//     deriveTopFiles 派生（identity.js 是名字单一真源、两个 autostart 件等都经 main.js require
//     可达）——新增模块漏登 build.files 时，CI 第 14 件 verify-build-files.js 先红；这里对
//     包内实物的逐件指纹是第二道（两处同时漏登在结构上不再可能：清单只能从闭包来）。
//   - renderer/** 整目录纳入逐件指纹（此前渲染端从不与装机产物对指纹）：源目录里每个文件
//     都必须在 asar 的 renderer/ 下存在且内容一致（行尾归一后）。
//   - build.files 里**其余目录 glob 条目**（现值 core/**，票 12-A/0a-2 起）同样逐件指纹（⑦）：
//     目录名不写死，从 build.files 的 `/**` 形态派生（renderer/** 由上一条单独覆盖，不重复计）；
//     源根读不到/为空、或包里该前缀没有实物，一律红。12-A/0a-2 把 core/ 登记进 build.files 后，
//     包内有实物（asar list 见 \\core\\geometry.js）但 ⑤⑥ 都不覆盖它——新目录面曾无人比对。
//   - 比对清单逐项核对 build.files：清单项不在打包清单里 = 清单与闭包脱节，红。
//
// 用法（纯 node，无 Electron 依赖）：
//   node tools/verify-asar.js <app.asar 路径> [源根]   校验指定 asar（源根默认本仓库根）
//   node tools/verify-asar.js                          自动校验 ../<BUILD_DIR_NAME>/release/win-unpacked
//   第二参数传源根供突变自证（对 %TEMP% 副本跑，不碰工作树——§72：禁原地改跟踪件）。
// 退出码：0 = 通过；1 = 有问题。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BUILD_DIR_NAME } = require('../identity');
const { computePackClosure, deriveTopFiles, parseBuildFiles, matchesBuildEntry } = require('./verify-build-files.js');

let asar;
try {
  asar = require('@electron/asar');
} catch {
  console.error('缺少 @electron/asar：请在本项目根目录（node_modules）下运行');
  process.exit(1);
}

const DEFAULT_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.resolve(process.argv[3] || DEFAULT_ROOT);

const targets = process.argv[2]
  ? [process.argv[2]]
  : [path.join(DEFAULT_ROOT, '..', BUILD_DIR_NAME, 'release', 'win-unpacked', 'resources', 'app.asar')];

// 打包输入闭包与派生清单（源根坏 = 判据层直接红，不在读数上打绿灯）
const closure = computePackClosure(SRC_ROOT);
const TOP_FILES = deriveTopFiles(closure.files);
const buildEntries = parseBuildFiles(SRC_ROOT);
const rendererDir = path.join(SRC_ROOT, 'renderer');
const rendererFiles = fs.existsSync(rendererDir) ? listFilesRecursively(rendererDir) : null;

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

  // ④ 判据层自检（源根本身不可静态封包 / 清单与打包清单脱节 = 比对读数不可信，先红）
  for (const p of closure.problems) problems.push(`源根闭包问题: ${p}`);
  for (const d of closure.dynamicAll) problems.push(`源根存在计算式 require: ${d.file}:${d.line} require(${d.arg})`);
  if (!buildEntries) problems.push('源根 package.json 的 build.files 读不到——无法核对比对清单一致性');
  else for (const name of TOP_FILES) {
    if (!matchesBuildEntry(name, buildEntries.entries)) {
      problems.push(`比对清单项 ${name} 不在 build.files——打包清单与 require 闭包脱节（漏登）`);
    }
  }
  if (pkg && pkg.main && !TOP_FILES.includes(normPkgMain(pkg.main))) {
    problems.push(`main 入口 ${pkg.main} 不在比对清单——闭包求值失败（入口读不到？）`);
  }
  if (rendererFiles === null) problems.push('源根 renderer/ 目录读不到——渲染端逐件比对无从谈起');

  // ⑤ 关键源文件与项目源比对（能抓住「索引对、内容错」的一切错位）
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
    const src = path.join(SRC_ROOT, name);
    if (!fs.existsSync(src)) {
      // 项目源都不在了不再静默跳过（§77①：读不到不许打绿灯）——报出来
      problems.push(`项目源缺失: ${name}，比对无从谈起`);
      continue;
    }
    const inAsar = readEntry(asarPath, info.headerSize, entry);
    const onDisk = fs.readFileSync(src);
    if (sha256(normalizeEol(inAsar)) !== sha256(normalizeEol(onDisk))) {
      problems.push(`${name} 内容与项目源不一致（错位/截断，行尾归一后 asar sha256=${sha256(normalizeEol(inAsar)).slice(0, 12)}…）`);
    }
  }

  // ⑥ renderer/** 整目录逐件指纹（渲染端 2,600+ 行此前从不与装机产物对指纹）
  if (rendererFiles) {
    const rendererNode = header.files['renderer'];
    for (const rel of rendererFiles) {
      let node = rendererNode;
      for (const seg of rel.split('/')) node = node && node.files ? node.files[seg] : null;
      if (!node || node.size === undefined) {
        problems.push(`缺少 renderer/${rel}`);
        continue;
      }
      const srcAbs = path.join(rendererDir, rel);
      const inAsar = readEntry(asarPath, info.headerSize, node);
      const onDisk = fs.readFileSync(srcAbs);
      if (sha256(normalizeEol(inAsar)) !== sha256(normalizeEol(onDisk))) {
        problems.push(`renderer/${rel} 内容与项目源不一致（错位/截断，行尾归一后 asar sha256=${sha256(normalizeEol(inAsar)).slice(0, 12)}…）`);
      }
    }
  }

  // ⑦ build.files 里其余「目录 glob」条目逐件指纹（票 12-A/0a-2 的 core/** 是第一个用户）
  // 为什么必须有：12-A/0a-2 把 core/ 登记进 build.files 后，包内实物是有的（asar list 见
  // \core\geometry.js、\core\interactive-box.js），但 ⑤ 只覆盖「根目录 js」、⑥ 只覆盖 renderer/**，
  // core 面进包却不被比对——「索引对、内容错」这一类（§4.9 的原始症状）在新目录上重新变成无人看。
  // 这里不写死目录名：从 build.files 的 `/**` 条目派生（renderer/** 已由 ⑥ 单独覆盖，不重复计），
  // 将来再加 glob 自动进面。源根读不到/为空、或包里该前缀没有实物，一律红（§77① 同族）。
  const extraDirs = (buildEntries ? buildEntries.entries : [])
    .filter((e) => typeof e === 'string' && e.endsWith('/**') && e !== 'renderer/**')
    .map((e) => e.slice(0, -3));
  let extraCount = 0;
  for (const dirRel of extraDirs) {
    const absDir = path.join(SRC_ROOT, dirRel);
    const files = fs.existsSync(absDir) ? listFilesRecursively(absDir) : null;
    if (!files || files.length === 0) {
      problems.push(`build.files 的目录条目 ${dirRel}/** 在源根读不到或为空——比对清单无从派生，不许打绿灯`);
      continue;
    }
    const rootNode = dirRel.split('/').reduce((node, seg) => (node && node.files ? node.files[seg] : null), header);
    if (!rootNode || !rootNode.files || Object.keys(rootNode.files).length === 0) {
      problems.push(`asar 里没有 ${dirRel}/ 目录或为空，而源根有 ${files.length} 个文件——该目录未进包（漏登 glob 或打包配置被改）`);
      continue;
    }
    for (const rel of files) {
      let node = rootNode;
      for (const seg of rel.split('/')) node = node && node.files ? node.files[seg] : null;
      if (!node || node.size === undefined) {
        problems.push(`缺少 ${dirRel}/${rel}`);
        continue;
      }
      const srcAbs = path.join(absDir, rel);
      const inAsar = readEntry(asarPath, info.headerSize, node);
      const onDisk = fs.readFileSync(srcAbs);
      if (sha256(normalizeEol(inAsar)) !== sha256(normalizeEol(onDisk))) {
        problems.push(`${dirRel}/${rel} 内容与项目源不一致（错位/截断，行尾归一后 asar sha256=${sha256(normalizeEol(inAsar)).slice(0, 12)}…）`);
      }
    }
    extraCount += files.length;
  }

  if (problems.length) {
    console.error(`[FAIL] ${asarPath}`);
    for (const p of problems) console.error('  - ' + p);
    failed = true;
  } else {
    console.log(`[PASS] ${asarPath}（package.json 可解析、main=${pkg.main}、${TOP_FILES.length} 个根 js（闭包派生）+ ${rendererFiles ? rendererFiles.length : 0} 个 renderer 文件${extraDirs.length ? ` + ${extraCount} 个 ${extraDirs.join('/')} 文件` : ''}行尾归一后比对一致）`);
  }
}

process.exit(failed ? 1 : 0);

// ---- helpers ----

function normPkgMain(m) { return String(m).replace(/\\/g, '/'); }

function listFilesRecursively(dir, base) {
  const out = [];
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${it.name}` : it.name;
    if (it.isDirectory()) out.push(...listFilesRecursively(path.join(dir, it.name), rel));
    else if (it.isFile()) out.push(rel);
  }
  return out.sort();
}

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

// 行尾归一：CRLF / 孤立 CR 一律折成 LF。只动行尾，不动任何其它字节（见 ⑤ 的注释）
function normalizeEol(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
