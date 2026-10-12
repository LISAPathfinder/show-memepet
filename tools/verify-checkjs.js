// @runtime: ci —— CI 强制层判据件：checkJs 静态层棘轮（错误条数只降不升 + petAPI ambient 在位），执行面在 run-ci.js
// 零构建静态检查层判据（票 11-Z）：tsc --noEmit + allowJs/checkJs 的棘轮——静态错误只许降不许升，
// ambient（types/globals.d.ts 的 petAPI 声明）被删必须立刻红，而不是靠总条数偶然没涨混过去。
//
// 断言（a/b/c/d/e/f 对应票面；全部现算对比，不设宽松上限）：
//   c 下限防御（正向对照，§77①/§95 同族——防「tsc 没跑起来/读空/参数写错 ⇒ 解析为空 ⇒ 断言恒真」）：
//      解析到的错误总条数与文件数不得为 0。真清零的那天要有意改这条与 BASELINE，不许静默绿。
//   b petAPI ambient 在位：`Property 'petAPI' does not exist` 命中必须 == 0（44 条曾全靠它压下）。
//   a 棘轮上限：总条数 ≤ BASELINE.total 且 逐文件 ≤ BASELINE.files；基线无键（新文件冒错误）＝红。
//   d 只降不升（提示性，不红）：实际 < 基线时明打「基线可下调 N 条」，不许静默放宽、不许自动改文件。
//      门控（票 11-Z4 收紧、票 11-Z5 再扩 f 维）：只在 c 过（解析非空）**且 e 过（检查面一致）
//      且 f 过（加载面覆盖）**时才有资格谈下调——
//      检查面不一致时的下降是「整片文件静默离开检查面」的假象（校验轮实测：include 摘掉 renderer，
//      23→6 还被包装成「可下调 17 条」rc=0），此时正确输出是 e 红 + 没有任何下调提示。
//   e 检查面覆盖（票 11-Z4，主新增）：A 面（单一真源 = 目标根 package.json 的 build.files 派生）
//      与 B 面（tsc --listFilesOnly 实际输入，剔除 node_modules 与 .d.ts）**集合相等**，双向点名：
//      A 有 B 无＝打包面带着、静态层没检查（缩 include / glob 深度漂移的主红）；B 有 A 无＝静态层
//      检查了不发货的东西或白名单漏登记。`/**` 目录条目**递归**展开（单层 glob 与 ** 语义之差正是
//      深度漂移的形状）；含 `*` 的其他形态判红（超出可派生范围）；精确 .js 条目断言文件真实存在。
//      parseBuildFiles 派生不了＝前置不满足（exit 3），不许「派生不了就跳过覆盖断言」——那是静默放行。
//   f 加载面覆盖（票 11-Z5，主新增）：C 面＝**权威加载清单**——html 集合从 A 面已有的目录条目
//      （faceA.dirNames）递归派生 .html（禁写死 'renderer'：白名单将来加 core/** 之类，加载面自动
//      跟着长），逐条解析 `<script src>`，路径按 **html 自身所在目录** 解析（src="lib/deep.js" 在
//      renderer/menu.html 里 → renderer/lib/deep.js），posix 归一后与 B 面同形可比。断言两步：
//      ①存在性——被引 js 必须真实存在（产品 js 被删/改名而 html 加载端没同步 ⇒ 红点名
//      `menu.html:23 → renderer/menu.js` 形状；menu.js 不被任何 require 引用、html 是它唯一加载端，
//      这条链 e 条看不见——e 的目录枚举对「文件消失」是 A/B 同步缩小，见票面）；②**单向 C ⊆ B**——
//      被引 js 都必须在 tsc 实际输入面里（include 缩面/glob 深度漂移的镜像侧）。
//      **不做反向（B 有 C 无＝正常，不判）**：根目录 12 个 js 里 main/preload/config/identity 等
//      是 require 加载或主进程件，不经 html——preload 走 main.js 的 webPreferences、
//      gamepad-xinput 走 main.js require，那两路已由 verify-build-files 的 require 闭包守。
//      写成集合相等会当场误伤 12 个件，后人别「顺手统一」。
//      不可派生形态一律判红不静默跳过（与 e 条「含 * 形态判红」同口径）：
//        - src 以 /、http、file、data: 开头，或含 ?/#（绝对路径/外链/带查询串，静态解析无真源）；
//        - 标签带 type=（module 语义不同，加载语义变了必须人工审）；
//        - src 无引号包裹（解析器不猜无引号形态）；
//        - 解析器看不见真源的注入特征：document.createElement('script') / insertAdjacentHTML /
//          innerHTML（从紧：出现即红，误伤时按流程显式豁免并在此登记）/ `.src=` 动态赋值。
//      选择放行并在此登记的形态：行内 <script>…</script>（无 src）——不引用外部文件、不产生
//      加载面条目，其代码随 html 本体走（html 在 build.files 的目录条目内）；本票只管外部 js 加载面。
//      **C 面为空必须红**（§77① 下限防御同族）：解析到 0 个 html 或 0 条 script src ⇒ f 红，
//      不许「没解析到就跳过」。纯文件系统解析，不新增第二次 tsc 调用（复用 e 已有的 faceB）。
//   f₂ js 面注入扫描（票 11-Z6，扩 11-Z5 的作用域边界）：上面四条注入特征原先**只扫 html**，
//      校验轮 F12 实测漏判——往 renderer/menu.js 注入 `document.createElement('script')` + `.src=`
//      赋值（menu.html 不动）⇒ 全绿 PASS 6/6。加载清单能从静态文本推出，前提是没人用脚本造加载器，
//      所以这条形态扩到 **B 面的每个 js**（含 main.js，共 17 个件；仍是纯文件系统读，不加 tsc 调用）。
//      **只扩这一条，不外扩**：innerHTML / insertAdjacentHTML 不扩到 js 面——浏览器语义下经这两者
//      插入的 <script> 不执行，而 renderer 现存 8 处 innerHTML 赋值（清空容器、拼 svg/div）会当场
//      误伤且无判别力；`.src=` 也不 blanket 扩（skin-picker.js:82 是 img.src 非脚本）。html 面那两条
//      从紧红保留（html 里现 0 命中，属为将来设的闸）。
//      「在代码里」而非「在注释/字符串里」才判红：复用 verify-build-files 的 stripForScan
//      （等长剥白：注释与字符串内容抹成空格、换行保留 ⇒ 行号保真），原文命中的起点在剥白版里
//      仍是空格 ⇒ 那是字面文本不造加载器，放行；仍非空格 ⇒ 真代码，红。
//
// 退出码统一口径：0 全绿 / 1 断言失败或脚本自身异常（stderr 打「脚本异常：<原因>」）/ 3 前置不满足
//   （tsconfig.checkjs.json 缺失、typescript 未安装、目标根 package.json 读不到或 build.files 缺失/非数组）。
//   precondition 与断言失败分码。
//
// 实现要点：
//   - 异步 spawn 而非 spawnSync：WorkBuddy 会话沙箱拦「node 为父的同步进程创建」（EBUSY），
//     异步带管道两种环境行为一致（run-ci.js 同款实现）。
//   - 仓库根一律 fs.realpathSync.native 规范化（§96：普通 realpath 不规范化盘符大小写，等于没修），
//     spawn 的 cwd 用规范化根。
//   - tsc 定位：目标根的 node_modules/typescript/bin/tsc 优先；没有（影子根不带 node_modules）则退回
//     本件所在仓的——保证「argv 传影子根」的红法仍能跑（cwd=影子根，模块解析噪声用控制组差集法消化）。
//   - 输出按行解析 `^<file>(<line>,<col>): error TS<code>`；文件路径用 tsc 原样输出（相对根、正斜杠），
//     BASELINE.files 的键必须与之同形。
//
// 用法：node tools/verify-checkjs.js [仓库根]（默认本仓库根；argv[2] 传根供影子根红法——
//       注意是 process.argv[2]，不是 argv[1]）
// 判据层：tsc 真实类型检查输出（终判层），不接实例、不产构建物（noEmit）。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// e 条复用 verify-build-files 的白名单解析器（不自己造解析器；该件 :335 有 require.main 守卫，
// 被 require 不会自跑，verify-asar.js 已是同款用法先例）。stripForScan 给 f₂ 的「注释/字符串里的
// 字面文本不算代码」判定用——同一套剥白工艺，别在两件里各写一份注释剥离器。
const { parseBuildFiles, matchesBuildEntry, stripForScan } = require('./verify-build-files.js');

// 棘轮基线：2026-10-11 票 11-Z 在 HEAD 44106a5 + typescript 5.9.3 上现算
// （tsc -p tsconfig.checkjs.json：无 ambient 67 条 → 含 ambient 23 条，petAPI 44 → 0）。
// 规则：只许降不许升；要上调必须改这里并在提交信息写理由（编译器换版本会整体漂，精确 pin）。
const BASELINE = {
  total: 23,
  files: {
    'renderer/pet.js': 6,
    'renderer/stats.js': 5,
    'renderer/skin-picker.js': 3,
    'main.js': 3,
    'renderer/menu.js': 2,
    'gamepad-xinput.js': 2,
    'skins.js': 1,
    'renderer/emoji-catalog.js': 1,
  },
};

function fail3(msg) { console.error(msg); process.exit(3); }

// §96 同族：根规范化，native 失败的兜底必须显式（盘符大写 + 明打），不许静默用原始路径。
function normalizeRoot(r) {
  try { return fs.realpathSync.native(r); } catch (e) {
    const fb = r.replace(/^([a-zA-Z]):/, (d) => d.toUpperCase()); // 回调收到的是全匹配（含冒号），不能再加 ':'
    console.error(`⚠ verify-checkjs: realpathSync.native 失败（${e.message}）——已显式退回「盘符大写」兜底：${fb}（原始传入 ${r}）`);
    return fb;
  }
}

const root = normalizeRoot(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
const tsconfigPath = path.join(root, 'tsconfig.checkjs.json');
if (!fs.existsSync(tsconfigPath)) {
  fail3(`前置不满足：${tsconfigPath} 不存在（根传错或 tsconfig 改名/缺失）——不许当绿`);
}
// e 条前置：A 面单一真源是目标根 package.json 的 build.files。派生不了就 exit 3——
// 「白名单读不到 ⇒ 跳过覆盖断言」= 给缩面留静默通道，与「tsconfig 缺失不许当绿」同一口径。
if (!parseBuildFiles(root)) {
  fail3(`前置不满足：${path.join(root, 'package.json')} 读不到，或 build.files 缺失/非数组——e 条检查面覆盖无法派生，不许跳过该断言当绿`);
}

// tsc 定位：目标根优先，退回本件所在仓（影子根红法仍可跑）。
const scriptRepoTsc = path.join(path.resolve(__dirname, '..'), 'node_modules', 'typescript', 'bin', 'tsc');
let tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
let tscSource = '目标根 node_modules';
if (!fs.existsSync(tscBin)) {
  if (!fs.existsSync(scriptRepoTsc)) {
    fail3(`前置不满足：typescript 未安装（${tscBin} 与 ${scriptRepoTsc} 均不存在）——不许当绿`);
  }
  tscBin = scriptRepoTsc;
  tscSource = '本件所在仓 node_modules（目标根无 typescript）';
}
// 编译器版本随打印（棘轮读数依赖版本，精确 pin 在 package.json；换版本=整体漂，须重算基线）。
try {
  const tsPkgRoot = tscBin.includes('node_modules') ? tscBin.split(`${path.sep}node_modules${path.sep}`)[0] : root;
  const ver = JSON.parse(fs.readFileSync(path.join(tsPkgRoot, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
  console.log(`[checkjs] typescript ${ver}（tsc 来自：${tscSource}）`);
} catch (e) { console.log(`[checkjs] typescript 版本读取失败（${e.message}）——继续`); }

function runTsc(bin, cfg, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, '-p', cfg], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => resolve({ code: null, out, err, spawnErr: e }));
    p.on('close', (code) => resolve({ code, out, err, spawnErr: null }));
  });
}

// B 面读数：tsc --listFilesOnly 列 tsc 实际吃进的输入文件（实测 ~0.5s；不为省这一次调用
// 而用文件系统去猜 include 语义——猜的答案永远是"我以为的检查面"，不是 tsc 的）。
function runTscListFiles(bin, cfg, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, '-p', cfg, '--listFilesOnly'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => resolve({ code: null, out, err, spawnErr: e }));
    p.on('close', (code) => resolve({ code, out, err, spawnErr: null }));
  });
}

// A 面派生：从 build.files 白名单推出「打包面有哪些 .js」。只认两种可派生形态：
//   - 精确 .js 条目：直接计入，并断言该文件真实存在（白名单指向不存在的文件＝打包缺件，e 红）；
//   - `/**` 结尾的目录条目（本仓唯一 glob 形态 renderer/**）：**递归**列出该目录下全部 .js——
//     递归是抓 glob 深度漂移的牙（tsconfig 侧单层 `renderer/*.js` 与白名单 `renderer/**` 的
//     语义之差，只有递归展开对集合才暴露得出来）。
// 含 `*` 的其他形态、非字符串条目＝「白名单 glob 形态超出可派生范围」＝e 红，不静默跳过；
// 非 .js 条目（resources/icon.ico）不参与 A 面。
function collectFilesDeep(dir, ext, out) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) collectFilesDeep(p, ext, out);
    else if (it.isFile() && it.name.endsWith(ext)) out.push(p);
  }
}

function deriveCheckFaceA(root) {
  const { entries } = parseBuildFiles(root);
  const aSet = new Set();
  const bad = [];
  const dirNames = [];
  let exactCount = 0;
  for (const entry of entries) {
    if (typeof entry !== 'string') { bad.push(`非字符串条目 ${JSON.stringify(entry)}`); continue; }
    if (entry.endsWith('/**')) {
      dirNames.push(entry.slice(0, -3) || '/');
      const dir = path.join(root, entry.slice(0, -3));
      if (!fs.existsSync(dir)) { bad.push(`目录条目 ${entry} 指向的目录不存在`); continue; }
      const files = [];
      collectFilesDeep(dir, '.js', files);
      for (const f of files) aSet.add(path.relative(root, f).replace(/\\/g, '/'));
    } else if (entry.includes('*')) {
      bad.push(`白名单 glob 形态超出可派生范围：${entry}（本件只认精确 .js 与 /** 目录两种形态）`);
    } else if (entry.endsWith('.js')) {
      if (!fs.existsSync(path.join(root, entry))) {
        bad.push(`白名单精确条目 ${entry} 指向的文件不存在（打包会缺件）`);
        continue;
      }
      exactCount++;
      aSet.add(entry.replace(/\\/g, '/'));
    }
    // 其余（resources/icon.ico 等）：非 .js 条目不参与 A 面
  }
  return { aSet, bad, exactCount, dirNames, entries };
}

// ── f 条：C 面派生（票 11-Z5）──权威加载清单，语义见文件头。
// html 注释先做「等行数净化」再解析（行号保真，verify-build-files 扫描器同款工艺）：
// 注释里的 <script> 与注入特征代码不执行，不该替活代码背红。
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m0) => m0.replace(/[^\n]/g, ''));
}
const SCRIPT_OPEN_RE = /<script\b([^>]*)>/gi;
function deriveCheckFaceC(root, dirNames, note) {
  const refs = [];
  const bad = [];
  let htmlCount = 0;
  for (const dn of dirNames) {
    const dir = path.join(root, dn);
    if (!fs.existsSync(dir)) continue; // e 条已把「目录不存在」点名，f 不重复计红
    const htmls = [];
    collectFilesDeep(dir, '.html', htmls);
    for (const htmlAbs of htmls) {
      htmlCount++;
      const relHtml = path.relative(root, htmlAbs).replace(/\\/g, '/');
      const htmlDir = path.dirname(htmlAbs);
      const text = stripHtmlComments(fs.readFileSync(htmlAbs, 'utf8'));
      // 注入特征（解析器看不见真源）：按文件全文判。innerHTML 从紧出现即红，误伤时按流程豁免。
      if (/document\.createElement\(\s*['"]script['"]/i.test(text)) bad.push(`${relHtml} 出现 document.createElement('script')——动态注入脚本，加载面不可静态解析`);
      if (/insertAdjacentHTML/i.test(text)) bad.push(`${relHtml} 出现 insertAdjacentHTML——可注入 <script>，加载面不可静态解析`);
      if (/\.innerHTML\s*=/i.test(text)) bad.push(`${relHtml} 出现 innerHTML 赋值——可注入 <script>（从紧判红，误伤须显式豁免并登记件头），加载面不可静态解析`);
      if (/\.src\s*=/i.test(text)) bad.push(`${relHtml} 出现 .src= 动态赋值——src 动态拼接，加载面不可静态解析`);
      let m;
      SCRIPT_OPEN_RE.lastIndex = 0;
      while ((m = SCRIPT_OPEN_RE.exec(text)) !== null) {
        const attrs = (m[1] || '').trim();
        const line = text.slice(0, m.index).split('\n').length;
        const srcM = attrs.match(/(?<![-\w])src\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        if (/type\s*=/i.test(attrs)) {
          bad.push(`${relHtml}:${line} script 带 type=（module 加载语义不同，须人工审）${srcM ? `：src="${srcM[1] ?? srcM[2]}"` : ''}`);
          continue;
        }
        if (!srcM) {
          if (/(?<![-\w])src\s*=/i.test(attrs)) {
            bad.push(`${relHtml}:${line} src 无引号包裹，超出可解析形态：${attrs}`);
          }
          continue; // 行内 script（无 src）：不产生加载面条目，放行理由登记在文件头
        }
        const src = (srcM[1] !== undefined ? srcM[1] : srcM[2]).trim();
        const low = src.toLowerCase();
        if (low.startsWith('/') || low.startsWith('http') || low.startsWith('file') || low.startsWith('data:') || /[?#]/.test(src)) {
          bad.push(`${relHtml}:${line} src="${src}" 不可派生（绝对路径/外链/带查询或锚点，静态解析无真源）`);
          continue;
        }
        const otherAttrs = attrs
          .replace(/(?<![-\w])src\s*=\s*(?:"[^"]*"|'[^']*')/i, '')
          .split(/\s+/).filter(Boolean)
          .filter((a) => !/^(defer|async)$/i.test(a));
        if (otherAttrs.length) {
          note.push(`f 注：${relHtml}:${line} script 带其他属性（按可解析处理，属性原文标注）：${otherAttrs.join(' ')}`);
        }
        refs.push({
          from: relHtml,
          line,
          src,
          target: path.relative(root, path.resolve(htmlDir, src)).replace(/\\/g, '/'),
        });
      }
    }
  }
  return { refs, bad, htmlCount };
}

// ── f₂：js 面注入扫描（票 11-Z6）──语义见文件头。只判 document.createElement('script') 一条形态，
// 作用域＝B 面（tsc 实际吃进的每个产品 js），命中即红：C 面无法从静态文本推出加载清单。
const SCRIPT_CREATE_RE = /document\s*\.\s*createElement\s*\(\s*['"]script['"]/gi;
function scanJsFaceInjection(root, faceB) {
  const hits = [];
  for (const rel of [...faceB].sort()) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const clean = stripForScan(text); // 等长剥白（注释/字符串内容→空格，换行保留 ⇒ 行号与 text 一致）
    SCRIPT_CREATE_RE.lastIndex = 0;
    let m;
    while ((m = SCRIPT_CREATE_RE.exec(text)) !== null) {
      const ch = clean[m.index];
      if (ch === ' ' || ch === '\n' || ch === '\r') continue; // 注释或字符串里的字面文本，不造加载器
      hits.push({ file: rel, line: text.slice(0, m.index).split('\n').length });
      if (SCRIPT_CREATE_RE.lastIndex === m.index) SCRIPT_CREATE_RE.lastIndex = m.index + 1; // 防零宽匹配空转
    }
  }
  return hits;
}

// B 面解析：listFilesOnly 输出（绝对路径、正斜杠）→ 剔 node_modules、剔 .d.ts → 相对根正斜杠。
// 加一道「行指向真实存在的文件」防御——错误文案（error TS18003 之类）不许被当文件收进 B 面。
function parseTscFileList(text, root) {
  const bSet = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.trim();
    if (!f || f.includes('node_modules') || f.endsWith('.d.ts')) continue;
    const abs = path.isAbsolute(f) ? f : path.resolve(root, f);
    if (!fs.existsSync(abs)) continue;
    bSet.add(path.relative(root, abs).replace(/\\/g, '/'));
  }
  return bSet;
}

const ERR_LINE_RE = /^([^(]+)\((\d+),(\d+)\): error (TS\d+):/;

(async () => {
  const r = await runTsc(tscBin, tsconfigPath, root);
  if (r.spawnErr) {
    if (r.spawnErr.code === 'ENOENT') {
      fail3(`前置不满足：tsc 起不来（${r.spawnErr.message}）——typescript 未安装或不完整`);
    }
    throw new Error(`spawn 失败：${r.spawnErr.message}`);
  }
  const text = Buffer.concat([...r.out, ...r.err]).toString('utf8');
  const lines = text.split(/\r?\n/);
  const perFile = new Map();
  let total = 0, petApiHits = 0, unparsed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(ERR_LINE_RE);
    if (!m) { unparsed++; continue; }
    total++;
    const f = m[1];
    perFile.set(f, (perFile.get(f) || 0) + 1);
    if (line.includes("Property 'petAPI' does not exist")) petApiHits++;
  }
  const distinctFiles = perFile.size;

  console.log(`[checkjs] tsc exit=${r.code} 解析错误 ${total} 条 / ${distinctFiles} 个文件 / petAPI 命中 ${petApiHits}（基线 ${BASELINE.total}，非判定行 ${unparsed}）`);

  // e 检查面覆盖：A 面（build.files 白名单派生）vs B 面（tsc --listFilesOnly 实际输入）。
  const faceA = deriveCheckFaceA(root);
  const listR = await runTscListFiles(tscBin, tsconfigPath, root);
  if (listR.spawnErr) throw new Error(`listFilesOnly spawn 失败：${listR.spawnErr.message}`);
  const faceB = parseTscFileList(Buffer.concat([...listR.out, ...listR.err]).toString('utf8'), root);
  const aOnly = [...faceA.aSet].filter((f) => !faceB.has(f)).sort();
  const bOnly = [...faceB].filter((f) => !faceA.aSet.has(f)).sort();
  const eOk = faceA.bad.length === 0 && aOnly.length === 0 && bOnly.length === 0;

  // f 加载面覆盖（票 11-Z5）：C 面（html script src 权威加载清单）——存在性 + 单向 C⊆B。
  // 纯文件系统解析，不新增第二次 tsc 调用（复用 e 已有的 faceB）。
  const fNotes = [];
  const faceC = deriveCheckFaceC(root, faceA.dirNames, fNotes);
  const jsInject = scanJsFaceInjection(root, faceB);
  const fMissing = [];
  const fOutside = [];
  for (const ref of faceC.refs) {
    if (!fs.existsSync(path.join(root, ref.target))) fMissing.push(ref);
    else if (!faceB.has(ref.target)) fOutside.push(ref);
  }
  const fOk = faceC.bad.length === 0 && faceC.htmlCount > 0 && faceC.refs.length > 0
    && fMissing.length === 0 && fOutside.length === 0 && jsInject.length === 0;
  for (const n of fNotes) console.log(`[checkjs] ${n}`);

  const fails = [];
  // c 下限防御：先算，防「解析为空 ⇒ 后续断言空转全绿」
  if (total === 0 || distinctFiles === 0) {
    fails.push(`c 下限防御：解析到 ${total} 条 / ${distinctFiles} 个文件——tsc 没跑起来、读空或参数写错不许当绿` +
      `（tsc exit=${r.code}；若确已真清零，须有意改本件 c 条与 BASELINE）`);
  }
  // b petAPI ambient 在位
  if (petApiHits !== 0) {
    fails.push(`b petAPI ambient 被摘：${petApiHits} 条 'Property petAPI does not exist'（types/globals.d.ts 的 interface Window 必须在位）`);
  }
  // a 棘轮上限：总数 + 逐文件
  if (total > BASELINE.total) {
    fails.push(`a 棘轮：总条数 ${total} > 基线 ${BASELINE.total}（+${total - BASELINE.total}）`);
  }
  // e 检查面覆盖断言：集合相等，双向点名（票 11-Z4 的主红 = A 有 B 无：打包面带着、静态层没检查）。
  if (faceA.bad.length) {
    fails.push(`e 检查面覆盖：白名单不可派生/缺件——${faceA.bad.join('；')}`);
  }
  if (aOnly.length) {
    fails.push(`e 检查面覆盖：A 有 B 无 ×${aOnly.length}（打包面带着、静态层没检查——include 缩面/glob 深度漂移）：${aOnly.join('、')}`);
  }
  if (bOnly.length) {
    const orphan = bOnly.filter((f) => !matchesBuildEntry(f, faceA.entries));
    fails.push(`e 检查面覆盖：B 有 A 无 ×${bOnly.length}（静态层检查了不发货的东西，或白名单漏登记` +
      `${orphan.length ? `；其中 ${orphan.length} 个不被任何白名单条目形态覆盖＝白名单漏登记：${orphan.join('、')}` : ''}）：${bOnly.join('、')}`);
  }
  if (eOk) {
    const dirCount = faceA.aSet.size - faceA.exactCount;
    console.log(`[checkjs] e 检查面覆盖：打包面 ${faceA.aSet.size} == tsc 输入 ${faceB.size}（根 ${faceA.exactCount} + ${faceA.dirNames.join('+') || '无'} 递归 ${dirCount}，派生自 build.files）`);
  }
  // f 断言红（票 11-Z5）：不可派生形态 / C 面为空 / 引用不存在 / C 有 B 无。
  if (faceC.bad.length) {
    fails.push(`f 加载面覆盖：不可派生形态/解析器看不见真源——${faceC.bad.join('；')}`);
  }
  if (faceC.htmlCount === 0 || faceC.refs.length === 0) {
    fails.push(`f 加载面覆盖：加载面为空（解析到 ${faceC.htmlCount} 个 html / ${faceC.refs.length} 条 script src 引用）——解析不出权威加载清单不许当绿`);
  }
  if (fMissing.length) {
    fails.push(`f 加载面覆盖：引用的 js 不存在 ×${fMissing.length}（产品 js 被删/改名而 html 加载端没同步）：${fMissing.map((r) => `${r.from}:${r.line} → ${r.target}`).join('、')}`);
  }
  if (fOutside.length) {
    fails.push(`f 加载面覆盖：C 有 B 无 ×${fOutside.length}（html 加载端引用的 js 不在 tsc 检查面——include 缩面/glob 深度漂移的镜像侧）：${fOutside.map((r) => `${r.target}（${r.from}:${r.line} 引用）`).join('、')}`);
  }
  if (jsInject.length) {
    fails.push(`f 加载面覆盖：js 面出现 document.createElement('script') ×${jsInject.length}` +
      `（脚本自造加载器，C 面无法从静态文本推出——改成 html 静态 <script src>，或有意动态加载时` +
      `显式登记豁免并写理由）：${jsInject.map((h) => `${h.file}:${h.line}`).join('、')}`);
  }
  if (fOk) {
    console.log(`[checkjs] f 加载面覆盖：${faceC.htmlCount} 个 html 的 ${faceC.refs.length} 条 script src 全部存在且都在检查面内` +
      `（单向 C⊆B，反向不判；另扫 ${faceB.size} 个 js 面无 createElement('script') 造加载器）`);
  }
  const downgrades = [];
  // d 门控（票 11-Z4 收紧 c+e，票 11-Z5 再扩 f）：解析非空且检查面一致且加载面覆盖——
  // 「删了 menu.js 还打★可下调」正是本票要堵的形状：文件侧缩面时 e 看不见（A/B 同步缩小），
  // f 才拦得住；f 红时绝不允许出现下调提示。
  const lowerBoundOk = (total > 0 && distinctFiles > 0) && eOk && fOk;
  for (const [f, n] of perFile) {
    const cap = BASELINE.files[f];
    if (cap === undefined) {
      fails.push(`a 棘轮：基线无键 ${f}（${n} 条）——新文件冒静态错误；如属有意请登记 BASELINE.files 并写理由`);
    } else if (n > cap) {
      fails.push(`a 棘轮：${f} ${n} 条 > 基线 ${cap}（+${n - cap}）`);
    } else if (n < cap) {
      downgrades.push(`${f} 可下调 ${cap - n} 条：${cap} → ${n}`);
    }
  }
  // d 只降不升：明打可下调量，不自动改文件、不静默放宽。只在 c 过（解析非空）且 e 过（检查面一致）
  // 且 f 过（加载面覆盖，票 11-Z5）时
  // 才有资格谈下调——「检查没跑起来」的 0 条不是基线可降，「整片文件离开检查面」的下降是缩面假象
  // （票 11-Z4 校验轮实测：include 摘掉 renderer 后 23→6 还打「可下调 17 条」rc=0），静默提示会把
  // 这两类都诱导成「改善」落账。缩面时的正确输出＝e/f 红 + 没有任何下调提示。
  if (lowerBoundOk && total < BASELINE.total) {
    console.log(`[checkjs] ★ 基线可下调 ${BASELINE.total - total} 条：${BASELINE.total} → ${total}（改 tools/verify-checkjs.js 的 BASELINE 落账，本件仍 exit 0）`);
    for (const d of downgrades) console.log(`[checkjs]   - ${d}`);
  }

  if (fails.length) {
    for (const f of fails) console.error(`✗ ${f}`);
    console.error(`FAIL：a/b/c/d/e/f 断言共命中 ${fails.length} 处`);
    process.exit(1);
  }
  console.log('✓ a 棘轮上限（总数+逐文件，基线内）');
  console.log('✓ b petAPI ambient 在位（命中 0）');
  console.log('✓ c 下限防御（解析非空，检查真在跑）');
  console.log('✓ d 只降不升（无上调；下降已明打）');
  console.log(`✓ e 检查面覆盖（打包面==tsc 输入，双向集合相等，派生自 build.files）`);
  console.log(`✓ f 加载面覆盖（html 加载端引用的 js 存在且 ⊆ tsc 输入面，单向 C⊆B 不判反向）`);
  console.log(`PASS 6/6（checkjs 静态层棘轮，基线 ${BASELINE.total} 条）`);
  process.exit(0);
})().catch((e) => {
  console.error(`脚本异常：${(e && e.message) || e}`);
  process.exit(1);
});
