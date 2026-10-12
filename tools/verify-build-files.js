// @runtime: ci —— CI 强制层判据件：打包闭包钉子（verify-asar 清单来源），纯 node，执行面在 run-ci.js
// 打包输入闭包钉子：把「新增 require('./x') 忘了登记进 package.json 的 build.files」
// 从「靠人记两步」变成「忘了必红」。
//
// 背景：build.files 是手工登记清单；verify-asar.js 的比对清单历史上也是另一份手抄（TOP_FILES）。
// 两处同时漏登就完全无声（autostart-elevation.js 曾漏登，靠出包后人工发现）。
// 本件从入口 main.js / preload.js 递归求 require 相对闭包 + loadFile 目标，钉死两件事：
//   (1) 闭包 ⊆ build.files——每个被 require 的文件必须在打包清单里；
//   (2) build.files 的每一项 ∈ 闭包——死登记（没人 require 的 js）判红，
//       目录 glob 与资源文件走 EXEMPT_BUILD_ENTRIES 显式豁免表（白名单 + 注释，
//       不许改成「跳过所有含 * 的项」——那会把新 glob 的漏登也放行）；
//   (3) verify-asar 的比对清单 = 「闭包 ∩ 根目录 js」派生（deriveTopFiles），与 build.files
//       根 js 项双向一致——手抄清单从此不存在，改清单只能改 build.files 一处；
//   (4) 正向对照哨兵（PITFALLS §77①：只写「搜不到 X」的守卫结构上恒绿）——
//       main 入口必须在闭包内、build.files 必须是非空数组，防「上游读不到 → 集合断言空转全绿」；
//   (5) core 纯度闸（票 12-A）——core/ 下任何 .js 不得 require electron/fs/child_process/net/
//       koffi/uiohook-napi 或本地 config/identity，不得出现 Date.now( 或 process.env。
//       作用域＝仓库根的 core/ 目录（递归，含将来新增的 core/*.js），命中红并点名 文件:行；
//       core 面为空＝红（正向对照）。判据在源码结构层：require 实参走 scanRequires 从**原文**取
//       字面量，Date.now(/process.env 这类无实参形态才走「原文命中起点在等长剥白版里仍非空格」
//       的代码位判定（PITFALLS §97：拿剥白文本找需要读实参的形态＝恒绿守卫）。
//
// 扫描器两条硬要求：
//   ① 注释与字符串字面量/模板串里的 require('…') 文本不算（tools/ 里就有
//      process.mainModule.require('electron') 这类 CDP 注入文本，命中字符串内容=假红）；
//      实现是「等长净化」：把注释与字符串内容替换成空格（换行保留），净化文本与原文逐字符对位，
//      行号免费保持一致；模板串的 ${…} 内是真代码，原样保留参与扫描。
//   ② 发现 require(变量)/计算式 require（含 `./${x}` 插值模板）→ 直接红并点名行号——
//      闭包不可静态封闭时宁可红，禁止静默跳过。
//      已知取舍：正则字面量不做状态（除法/正则分词歧义大）；产品码正则内无 require 字样，
//      若将来出现，形态是漏报（静默），由 verify-asar 对包内实物的指纹兜底。
//
// 用法：node tools/verify-build-files.js [仓库根]（默认本仓库根；传根供突变自证，不必复制整仓）
// 退出码：0 = 断言全绿；1 = 断言失败（脚本自身异常也落 1，stderr 打「脚本异常：<原因>」）；
//         3 = 前置不满足（给的根下没有 package.json）。
// 判据层：源码结构层（require 闭包 ↔ build.files 集合关系），不接实例、不碰 asar 产物；
//         打包实物侧的第二道是 verify-asar.js（比对清单由本件派生函数供给，单一事实源）。
'use strict';
const fs = require('fs');
const path = require('path');

// ○b 显式豁免表：build.files 里不依赖 require 闭包的合法项，逐条写明理由。
// 新增豁免必须在这里点名并写理由——「显式豁免制」是 (2) 死登记判红的前提。
const EXEMPT_BUILD_ENTRIES = [
  // 目录 glob：承载渲染端静态资源（html/css/js），由 <script>/<link> 引用而非 require 可达；
  // 其进包完整性由 verify-asar.js 对 renderer/** 整目录逐件指纹兜底
  'renderer/**',
  // 目录 glob（票 12-A）：主进程几何纯函数。闭包以解析后的具体路径（core/geometry.js）出现并被
  // (1) 覆盖，(2) 的条目名是 glob 形态、不可能等于任何闭包成员路径——与 renderer/** 同一形状，
  // 走显式豁免而不是改成「跳过所有含 * 的项」。
  // 已知取舍：glob 自身空转（core/ 被清空但仍登记）这里拦不住，由 (1) 的闭包成员覆盖断言与
  // verify-checkjs 的 e 条双向兜底。
  'core/**',
  // electron-builder win.icon 引用的构建资源，运行时无人 require
  'resources/icon.ico',
];

// ── (5) core 纯度闸（票 12-A）──
// core/ 之所以有价值，全在它「能在纯 node 下被 require 且同输入同输出」：判据件因此可以 require
// 真函数，而不是从产品源码抽函数体丢进 vm（全仓最脆的一层）。没有这根钉子，下一轮就有人把
// 有状态读取偷偷搬进 core。禁止面＝任何 IO / 环境依赖 / 全局可变时间源。
const CORE_FORBIDDEN_BARE = ['electron', 'fs', 'child_process', 'net', 'koffi', 'uiohook-napi'];
const CORE_FORBIDDEN_LOCAL = ['config', 'identity'];
// 需要读实参的形态（require('x')）走 scanRequires 从原文取字面量，绝不对其剥白文本跑正则——
// 等长剥白会把 'x' 这个字符串实参一起抹掉，正则永不命中＝恒绿守卫（PITFALLS §97）。
// 纯字面形态（不含实参）才可对剥白版做「起点是否仍非空格」的代码位判定。
const CORE_FORBIDDEN_FORMS = [
  { re: /\bDate\.now\s*\(/g, label: 'Date.now(' },
  { re: /\bprocess\.env\b/g, label: 'process.env' },
];

function collectCoreJs(dir, out) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) collectCoreJs(p, out);
    else if (it.isFile() && it.name.endsWith('.js')) out.push(p);
  }
}

// 返回 { hits: [{file,line,why}], count: 扫到的 core .js 数 }；core 目录不存在时 count=0，
// 由正向对照那条拦（§77①：读不到东西不许让集合断言空转全绿）
function scanCorePurity(root) {
  const hits = [];
  const dir = path.join(root, 'core');
  if (!fs.existsSync(dir)) return { hits, count: 0 };
  const files = [];
  collectCoreJs(dir, files);
  for (const abs of files.sort()) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const src = fs.readFileSync(abs, 'utf8');
    const clean = stripForScan(src);
    const lineAt = makeLineLookup(src);
    const { specs } = scanRequires(src);
    for (const s of specs) {
      if (s.relative) {
        const name = path.posix.basename(path.posix.normalize(s.spec)).replace(/\.js$/, '');
        if (CORE_FORBIDDEN_LOCAL.includes(name)) hits.push({ file: rel, line: s.line, why: `require('${s.spec}')` });
      } else {
        const name = s.spec.replace(/^node:/, '');
        if (CORE_FORBIDDEN_BARE.includes(name)) hits.push({ file: rel, line: s.line, why: `require('${s.spec}')` });
      }
    }
    for (const { re, label } of CORE_FORBIDDEN_FORMS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const ch = clean[m.index];
        if (ch === ' ' || ch === '\n' || ch === '\r' || ch === undefined) {
          if (re.lastIndex === m.index) re.lastIndex = m.index + 1;
          continue; // 注释/字符串里的字面文本，不是代码
        }
        hits.push({ file: rel, line: lineAt(m.index), why: label });
        if (re.lastIndex === m.index) re.lastIndex = m.index + 1;
      }
    }
  }
  return { hits, count: files.length };
}

// ---- 等长净化：注释与字符串内容 → 空格（换行保留），模板串 ${…} 内代码原样保留 ----
function stripForScan(src) {
  const out = src.split('');
  const n = src.length;
  // 栈帧：code（花括号深度，顶层 code 的 depth 归零后遇 } 不 pop）/ tpl（模板串内）
  const stack = [{ type: 'code', depth: 0 }];
  const blank = (i) => { if (src[i] !== '\n' && src[i] !== '\r') out[i] = ' '; };
  let i = 0;
  while (i < n) {
    const fr = stack[stack.length - 1];
    const c = src[i];
    if (fr.type === 'tpl') {
      if (c === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
      if (c === '`') { i++; stack.pop(); continue; }
      if (c === '$' && src[i + 1] === '{') { i += 2; stack.push({ type: 'code', depth: 0 }); continue; }
      blank(i); i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { blank(i); i++; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; } else { blank(i); i++; }
      }
      i++; continue;
    }
    if (c === '`') { i++; stack.push({ type: 'tpl' }); continue; }
    if (c === '{') { fr.depth++; i++; continue; }
    if (c === '}') {
      if (fr.depth > 0) { fr.depth--; i++; continue; }
      if (stack.length > 1) { stack.pop(); i++; continue; } // 闭合某个 ${，回模板串
      i++; continue;
    }
    i++;
  }
  return out.join('');
}

// 行起点表 + 二分行号（等长净化保证 clean 与 src 行号一致）
function makeLineLookup(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

// 括号配对（净化文本上：字符串内容已空格化，不会干扰配对）
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 从原文 pos 处提取一个完整的单/双引号字符串字面量，返回 { val, end }（end 为闭引号下一位）或 null
function readStringAt(src, pos) {
  const q = src[pos];
  if (q !== "'" && q !== '"') return null;
  let i = pos + 1, val = '';
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\' && i + 1 < src.length) { val += src[i + 1]; i += 2; }
    else { val += src[i]; i++; }
  }
  return i < src.length ? { val, end: i + 1 } : null;
}

// 扫描一个 js 源文本 → { relative: [{spec,line}], dynamic: [{line,arg}], specs: [{spec,line,relative}] }
// specs 是「全部字面量 require 实参」（含裸模块名），给 (5) 纯度闸用；relative 仍是闭包要的相对路径子集。
function scanRequires(src) {
  const clean = stripForScan(src);
  const lineAt = makeLineLookup(src);
  const relative = [], dynamic = [], specs = [];
  const re = /(?<![A-Za-z0-9_$.])require\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(clean, open);
    if (close < 0) continue; // 配对失败（正则字面量错位等罕见形态），见头部取舍
    const rawArg = clean.slice(open + 1, close);
    const arg = rawArg.trim();
    const line = lineAt(m.index);
    if (!arg) { dynamic.push({ line, arg: '(空参数)' }); continue; }
    const off = open + 1 + (rawArg.length - rawArg.trimStart().length);
    if (arg[0] === "'" || arg[0] === '"') {
      const r = readStringAt(src, off);
      if (!r) { dynamic.push({ line, arg: '(字符串解析失败)' }); continue; }
      // 只关心相对 require：裸模块名（node 内置 / node_modules 第三方）由依赖安装与
      // electron-builder 的 dependencies 自动打包承载，不在 build.files 手工登记范围
      const isRelative = /^\.{1,2}\//.test(r.val);
      specs.push({ spec: r.val, line, relative: isRelative });
      if (!isRelative) continue;
      relative.push({ spec: r.val, line });
    } else if (arg[0] === '`') {
      if (arg.includes('${')) dynamic.push({ line, arg: '(模板插值 require)' });
      else {
        const r = readStringAt(src, off);
        if (!r) dynamic.push({ line, arg: '(模板串解析失败)' });
        else {
          const isRelative = /^\.{1,2}\//.test(r.val);
          specs.push({ spec: r.val, line, relative: isRelative });
          if (isRelative) relative.push({ spec: r.val, line });
        }
      }
    } else {
      dynamic.push({ line, arg: arg.slice(0, 60) });
    }
  }
  return { relative, dynamic, specs };
}

// 提取 loadFile 的第一参数里的字符串字面量，拼成相对路径。
// 产品形态固定为 loadFile(path.join(__dirname, 'renderer', 'xxx.html'))——
// 第一参数里解析不出任何字符串字面量 = 动态目标，红（与计算式 require 同理，禁止静默跳过）。
function extractLoadFileTargets(src) {
  const clean = stripForScan(src);
  const lineAt = makeLineLookup(src);
  const out = [];
  // 注意与 require 不同：loadFile 在产品码里只有 win.loadFile( 方法形态，
  // 负向后顾不能排除 `.` 前缀（只排除标识符直接前缀，防 xxloadFile 误配）
  const re = /(?<![A-Za-z0-9_$])loadFile\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const open = m.index + m[0].length - 1;
    const line = lineAt(m.index);
    // 第一参数范围：depth 从 0 起，遇 depth==0 的逗号截断；depth 变 -1 即参数表结束
    let depth = 0, end = -1;
    for (let i = open + 1; i < clean.length; i++) {
      const c = clean[i];
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) { end = i; break; } depth--; }
      else if (c === ',' && depth === 0) { end = i; break; }
    }
    if (end < 0) { out.push({ err: true, line }); continue; }
    const seg = clean.slice(open + 1, end);
    const lits = [];
    // 净化后字符串内容全是空格 → seg 里出现的引号必然是字面量边界引号，逐个成对消费
    const sre = /(['"])/g;
    let s;
    while ((s = sre.exec(seg))) {
      const r = readStringAt(src, open + 1 + s.index);
      if (!r) break;
      lits.push(r.val);
      sre.lastIndex = s.index + (r.end - (open + 1 + s.index)); // seg 坐标：消费掉整个字面量（含闭引号）
    }
    if (!lits.length) { out.push({ err: true, line }); continue; }
    out.push({ rel: lits.join('/'), line });
  }
  return out;
}

function normRel(p) { return String(p).replace(/\\/g, '/').replace(/^\.\//, ''); }

// 相对 require spec → 仓库内相对路径（无扩展名时试 .js，再试 /index.js）
function resolveRelativeSpec(spec, fromRel, root) {
  const baseDir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, spec));
  const ext = path.posix.extname(joined);
  const candidates = ext ? [joined] : [joined + '.js', joined + '/index.js'];
  for (const c of candidates) if (fs.existsSync(path.join(root, c))) return { rel: normRel(c) };
  return { err: true };
}

// 从入口递归求打包输入闭包（纯函数：不 exit、不打印，问题以 problems/dynamicAll 返回）
// 返回 { files: Map<rel, [{from,line}]>, problems: string[], dynamicAll: [{file,line,arg}], pkgMain }
function computePackClosure(root) {
  const files = new Map();
  const problems = [], dynamicAll = [];
  let pkgMain = 'main.js';
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { files, problems: ['仓库根下没有 package.json'], dynamicAll, pkgMain };
  }
  try { pkgMain = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main || 'main.js'; } catch { /* 前置层会拦 */ }
  pkgMain = normRel(pkgMain);
  const queue = [
    { rel: pkgMain, from: 'package.json main 字段', line: 0, isEntry: true },
    { rel: 'preload.js', from: '入口清单（preload）', line: 0, isEntry: true },
  ];
  while (queue.length) {
    const e = queue.shift();
    if (files.has(e.rel)) { files.get(e.rel).push({ from: e.from, line: e.line }); continue; }
    let src;
    try { src = fs.readFileSync(path.join(root, e.rel), 'utf8'); } catch {
      // 入口读不到不记 problem——由 (4) 正向对照「main ∈ 闭包」承担（§77①：读不到不许打绿灯）；
      // 链上成员读不到记 problem，因为那说明某条 require 指向不存在的东西
      if (!e.isEntry) problems.push(`require/loadFile 目标文件读不到: ${e.rel}（来源 ${e.from}:${e.line}）`);
      continue;
    }
    files.set(e.rel, [{ from: e.from, line: e.line }]);
    if (!e.rel.endsWith('.js')) continue; // loadFile 目标（html）入集合但不展开
    const { relative, dynamic } = scanRequires(src);
    for (const d of dynamic) dynamicAll.push({ file: e.rel, line: d.line, arg: d.arg });
    for (const r of relative) {
      const res = resolveRelativeSpec(r.spec, e.rel, root);
      if (res.err) { problems.push(`require 目标解析不到: ${e.rel}:${r.line} require('${r.spec}')`); continue; }
      queue.push({ rel: res.rel, from: e.rel, line: r.line });
    }
    for (const lf of extractLoadFileTargets(src)) {
      if (lf.err) { problems.push(`loadFile 目标无法解析为相对文件: ${e.rel}:${lf.line}`); continue; }
      queue.push({ rel: normRel(lf.rel), from: e.rel, line: lf.line });
    }
  }
  return { files, problems, dynamicAll, pkgMain };
}

// verify-asar 的比对清单 = 闭包 ∩ 根目录 js（排序稳定）。手抄清单由此废除。
function deriveTopFiles(closureFiles) {
  return [...closureFiles.keys()].filter((r) => !r.includes('/') && r.endsWith('.js')).sort();
}

function parseBuildFiles(root) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
  const entries = pkg && pkg.build && pkg.build.files;
  return Array.isArray(entries) ? { entries } : null;
}

// build.files 条目匹配：精确相等，或「尾缀 /**」目录 glob（当前清单唯一 glob 形态）。
// 其他 glob 形态按不匹配处理——宁可红（死登记）也不静默放行新形态。
function matchesBuildEntry(rel, entries) {
  for (const e of entries) {
    if (typeof e !== 'string') continue;
    if (e === rel) return true;
    if (e.endsWith('/**') && rel.startsWith(e.slice(0, -2))) return true;
  }
  return false;
}

// ---- CLI ----
function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    console.error(`前置不满足：${root} 下没有 package.json——传的仓库根无效`);
    process.exit(3);
  }
  let checks = 0, fails = 0;
  const check = (ok, label) => { checks++; console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) fails++; };

  const closure = computePackClosure(root);
  const build = parseBuildFiles(root);
  const buildFiles = build ? build.entries : null;

  // 扫描器硬要求②：计算式 require = 闭包不可静态封闭，红
  for (const d of closure.dynamicAll) {
    check(false, `计算式 require（闭包无法静态封闭）: ${d.file}:${d.line} require(${d.arg})`);
  }

  // (1) 闭包完整性 + 闭包 ⊆ build.files
  for (const p of closure.problems) check(false, `(1) ${p}`);
  for (const [rel, via] of closure.files) {
    const ok = !!buildFiles && matchesBuildEntry(rel, buildFiles);
    check(ok, `(1) 闭包成员 ${rel} 被 build.files 覆盖（via ${via[0].from}:${via[0].line}${via.length > 1 ? ` 等 ${via.length} 处` : ''}）`);
  }

  // (2) build.files 每一项 ∈ 闭包（死登记判红；豁免表除外）
  if (buildFiles) {
    for (const e of buildFiles) {
      if (EXEMPT_BUILD_ENTRIES.includes(e)) continue;
      check(closure.files.has(e), `(2) build.files 项 ${e} 可由 require 闭包到达（死登记/未豁免判红）`);
    }
  } else {
    check(false, '(2) build.files 读不到或不是数组');
  }

  // (3) verify-asar 比对清单（闭包 ∩ 根 js）与 build.files 根 js 项双向一致
  const derived = deriveTopFiles(closure.files);
  const rootJsInBuild = buildFiles
    ? buildFiles.filter((e) => typeof e === 'string' && e.endsWith('.js') && !e.includes('/') && !EXEMPT_BUILD_ENTRIES.includes(e)).sort()
    : [];
  check(buildFiles !== null && JSON.stringify(derived) === JSON.stringify(rootJsInBuild),
    `(3) 比对清单与 build.files 根 js 项一致：派生 [${derived.join(', ')}] vs 清单 [${rootJsInBuild.join(', ')}]`);

  // (4) 正向对照哨兵（§77①）：单独成函数——e 红法「摘掉哨兵」时整行摘除，
  //     验证它是不是该场景下唯一有牙的断言
  runForwardChecks();

  // (5) core 纯度闸（票 12-A）：core/ 下任何 .js 不得 require 任何 IO/环境模块、不得用
  //     Date.now( 或 process.env——这一刀的全部价值就是它纯，判据件才敢 require 真函数。
  const purity = scanCorePurity(root);
  for (const h of purity.hits) check(false, `(5) core 纯度破坏: ${h.file}:${h.line} ${h.why}（core 必须零依赖纯函数，改回调用方）`);
  check(purity.count > 0, `(5) 正向对照：core/ 面扫到 ${purity.count} 个 .js（目录缺失/被清空时本闸不许空转全绿）`);

  function runForwardChecks() {
    check(closure.files.has(closure.pkgMain),
      `(4a) 正向对照：main 入口 ${closure.pkgMain} 在闭包内（读不到入口/闭包求值失败时此条必红）`);
    check(Array.isArray(buildFiles) && buildFiles.length >= 1, '(4b) 正向对照：build.files 是非空数组');
  }

  console.log(`PASS ${checks - fails}/${checks}`);
  process.exit(fails ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error(`脚本异常：${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

module.exports = { computePackClosure, deriveTopFiles, parseBuildFiles, matchesBuildEntry, scanRequires, stripForScan, EXEMPT_BUILD_ENTRIES };
