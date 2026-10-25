// @runtime: ci —— CI 强制层判据件：checkJs 分档棘轮（票 14-L，第 19 件）——档枚举／逐档 manifest／逐档基线台账，
//   复用 verify-checkjs 导出的 tsc 执行与解析函数（该件 require 守卫保证被 require 不自跑），执行面在 run-ci.js
//
// 任务 0 三题拍板（2026-10-24）在本件的落点：
//   Q1 逐档各比一次（不并集）——并集法只保证「每个文件有人查」，不保证「该严查的被严查」：core 从严格档
//      include 漏出时它还在基础档大清单里，并集不变、全绿，严格档静默空转（11-Z4 的 23→6 缩面事故同族）。
//      逐档成立的三条机制：
//      ① 应检面（manifest）手写在本件 TIERS 里，**禁止从该档 tsconfig 的 include 派生**——tsc 照 include 读文件，
//         A/B 同源则「B == manifest」恒真（考试范围以复习了什么为准）；改 include 不改 manifest ⇒ 红，反向也红（L9）。
//      ② 档间重叠不分区：基础档（tsconfig.checkjs.json，仍由 verify-checkjs 管它的 a–f₂，本件不碰）照旧全量，
//         严格档是加查——T2 的「manifest ⊆ 基础档 A 面」把重叠关系钉死，分区漏档即裸奔。
//      ③ 档清单 glob 枚举 tsconfig.tier-*.json，与 TIERS 键集**双向相等**（T1）——手抄档清单不存在，
//         新增档＝新 tsconfig＋TIERS 新键两处显式；删档文件 ⇒ 有键无档红；删到 0 ⇒ 下限红（L10）。
//   Q2 牙落在基线台账 schema：TIERS 的 baseline 是 { n, history: [{date, ticket, reason, n}] }，
//      T4 校验「n === history 末条的 n」——只改 n 不补记录必红（L7/L11 红面）；上调＋补「票号+理由」即放行（L11 绿面）。
//      已知边界：连末条 n 一起原地改写可绕过运行时校验——那已是可见的两处数据改写，靠 diff review 与提交留痕兜底，
//      运行时无法自证历史（与 BASELINE 裸数字相比，这里至少强制了「动数字必动结构化记录」）。
//      提交信息只作人的记录、不做判据面（pre-commit 阶段 message 尚不存在／CI checkout depth=1／rebase 改写）。
//   Q3 本件独立于 verify-checkjs（落地形态 (b)）：不动那件被 11-Z4/Z5/Z6 三轮红法验证过的 a–f₂ 语义。
//
// 断言组（对应票面 L 红法）：
//   T1 档枚举：glob tsconfig.tier-*.json ⇄ TIERS 键集双向相等；档数 ≥1（下限防御，§77① 同族——
//      删到 0 不许「没有档=没有断言=空转全绿」）。
//   T2 逐档应检面：tsc --listFilesOnly 实际输入（剔 node_modules/.d.ts）== TIERS.files 双向点名；
//      files 非空；files ⊆ 基础档 A 面（派生自 build.files，verify-checkjs 的 deriveCheckFaceA 同源）。
//   T3 逐档棘轮：tsc 错误总数 ≤ baseline.n；实际 < n 时明打「★ 可下调」（advisory，落账＝改 n＋history 补一条）。
//   T4 台账 schema：n 非负整数；history 非空且每条有 date/ticket/reason/n；n === history 末条 n。
//   T5 逐档下限：listFilesOnly 解析为 0 个文件必红（tsc 没跑起来／tsconfig 坏掉不许伪装成通过）。
//
// tsconfig extends 陷阱（本档实测）：extends 是**逐属性覆盖**——基档显式 noImplicitAny:false 会在子档
//   strict:true 下存活（strict 只抬「未被显式设置」的旗标），所以 tier 的 compilerOptions 必须 strict 与
//   noImplicitAny 两条都显式写 true。只写 strict:true 时 34 条 TS7006 一条都不报、棘轮空转。
//
// 用法：node tools/verify-checkjs-tiers.js [仓库根]（默认本仓库根；argv[2] 传根供影子根红法——
//       影子根无 node_modules 时 tsc 退回本件所在仓的，与 verify-checkjs 同款）
// 退出码：0 断言全绿 / 1 断言失败（脚本自身异常也落 1，stderr 打「脚本异常：<原因>」）/
//         3 前置不满足（根下无 package.json、build.files 派生不出基础档 A 面、typescript 未安装）。
// 判据层：tsc 真实类型检查输出 + tsc 实际输入面（终判层），不接实例、不产构建物（noEmit）。
'use strict';
const fs = require('fs');
const path = require('path');
const {
  runTsc, runTscListFiles, parseTscFileList, deriveCheckFaceA, ERR_LINE_RE, normalizeRoot,
} = require('./verify-checkjs.js');

const TIER_FILE_RE = /^tsconfig\.tier-.*\.json$/;
const CONTRACT_FILE_RE = /^contract-.*\.d\.ts$/;

// ── 契约面登记（票 14-L 任务 2；ratchet 清单，与 TIERS 键同款双向枚举）──────────
// 为什么由本件管而不是 verify-checkjs：两份项目 tsconfig 都开 skipLibCheck（压 @types 噪声），
// 它会跳过**所有** .d.ts 的类型检查——契约里的「类型级用例」在项目配置下永远不跑（红法 L8 首轮实测
// 撞出来的假牙：改坏签名两件全绿，单文件直跑 tsc 才见断言翻红）。所以 T6 用文件实参独立 spawn tsc
// （不吃项目配置、不带 skipLibCheck）逐份查：契约改坏签名 ⇒ 用例断言 TS2344 ⇒ 这里必红。
const CONTRACT_FILES = [
  'types/contract-native-koffi.d.ts',
  'types/contract-uiohook-events.d.ts',
  'types/contract-cdp-readback.d.ts',
];

// ── 档登记表（棘轮数据，键＝tsconfig 文件名）────────────────────────────────
// files 是手写 manifest（禁从该档 include 派生）；baseline.history 是留痕台账，动 n 必须补记录。
// 快照口径：2026-10-24 @ HEAD 97d5900 + typescript 5.9.3 现算（与 verify-checkjs BASELINE 同款纪律，
// 编译器版本精确 pin，换版本=整体漂须重算落账）。
const TIERS = {
  'tsconfig.tier-core.json': {
    files: ['core/geometry.js', 'core/interactive-box.js', 'core/reminder-mode.js', 'identity.js'],
    baseline: {
      n: 34,
      history: [
        { date: '2026-10-24', ticket: '14-L', n: 34, reason: '开档快照：strict+noImplicitAny 首开，34 条全为 TS7006（geometry 20／interactive-box 2／reminder-mode 11／identity 1）' },
      ],
    },
  },
};

function fail3(msg) { console.error(msg); process.exit(3); }

// tsc 定位：目标根优先，退回本件所在仓（影子根不带 node_modules 也能跑）——与 verify-checkjs 同策略。
// 这段是环境自举不是判据逻辑，不做成共享导出（verify-checkjs 那份与它的 fail3/打印交织在主流程里）。
function findTsc(r) {
  const scriptRepoTsc = path.join(path.resolve(__dirname, '..'), 'node_modules', 'typescript', 'bin', 'tsc');
  const target = path.join(r, 'node_modules', 'typescript', 'bin', 'tsc');
  if (fs.existsSync(target)) return target;
  if (fs.existsSync(scriptRepoTsc)) return scriptRepoTsc;
  return null;
}

// T4 台账 schema：n 与 history 末条 n 必须一致——「只把数字调大/调小、不补记录」在这里当场红（L7/L11）。
function ledgerFails(name, b) {
  const out = [];
  if (!b || typeof b !== 'object') return [`${name}：baseline 缺失或不是对象`];
  if (!Number.isInteger(b.n) || b.n < 0) out.push(`${name}：baseline.n=${JSON.stringify(b.n)} 非法（要非负整数）`);
  if (!Array.isArray(b.history) || b.history.length === 0) {
    out.push(`${name}：history 为空——每个数字都必须有落账记录（开档快照也是一条）`);
  } else {
    for (let i = 0; i < b.history.length; i++) {
      const h = b.history[i];
      for (const k of ['date', 'ticket', 'reason', 'n']) {
        if (h[k] === undefined || h[k] === null || String(h[k]).trim() === '') {
          out.push(`${name}：history[${i}] 缺 ${k}（留痕四件套 date/ticket/reason/n 一个不许空）`);
        }
      }
    }
    const last = b.history[b.history.length - 1];
    if (Number.isInteger(b.n) && Number.isInteger(last.n) && b.n !== last.n) {
      out.push(`${name}：baseline.n=${b.n} ≠ history 末条 n=${last.n}——只改数字不补记录（上调必带票号+理由，下调同样要落账）`);
    }
  }
  return out;
}

// 契约面检查走 tsconfig.contract.json（票 14-L）：项目两份配置都开 skipLibCheck（压 @types 噪声），它跳过
// 所有 .d.ts ⇒ 契约里的类型级用例在项目配置下永远不跑（红法 L8 首轮实测撞出的假牙：改坏签名两件全绿，
// 单文件直跑才见断言翻红）。这份配置不带 skipLibCheck、`"types": []` 禁掉 @types 自动装载（CLI 的
// `--types ''` 不被接受，TS6044）——契约的用例断言只有在这条执行通道下才真被检查。

(async () => {
  const root = normalizeRoot(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    fail3(`前置不满足：${root} 下没有 package.json——传的仓库根无效`);
  }
  // 基础档 A 面（manifest ⊆ 它）：派生自 build.files 单一真源，与 verify-checkjs e 条同源。
  const faceA = deriveCheckFaceA(root);
  if (faceA.aSet.size === 0) {
    fail3(`前置不满足：build.files 派生不出基础档 A 面（读不到或无 .js 条目）——T2 的 ⊆ 判定失真，不许跳过当绿`);
  }
  const tscBin = findTsc(root);
  if (!tscBin) {
    fail3(`前置不满足：typescript 未安装（${root} 与本件所在仓的 node_modules/typescript/bin/tsc 均不存在）——不许当绿`);
  }

  const fails = [];
  const notes = [];

  // ── T1 档枚举：glob ⇄ 登记表 双向相等 ──
  const onDisk = fs.readdirSync(root).filter((f) => TIER_FILE_RE.test(f)).sort();
  const registered = Object.keys(TIERS).sort();
  if (onDisk.length === 0) {
    fails.push(`T1 档枚举：tsconfig.tier-*.json 一个都不在——档清空不许「没有档=没有断言」空转全绿（§77①）`);
  }
  for (const f of onDisk.filter((f) => !TIERS[f])) {
    fails.push(`T1 档枚举：${f} 在磁盘上但不在 TIERS 登记表——新档必须两处显式（tsconfig＋登记键），不许静默漏管`);
  }
  for (const f of registered.filter((f) => !onDisk.includes(f))) {
    fails.push(`T1 档枚举：TIERS 登记了 ${f} 但文件不存在——删档是显式动作，须连登记键一起删且留下落账`);
  }
  if (onDisk.length && registered.length && onDisk.join('|') === registered.join('|')) {
    notes.push(`T1 档枚举：磁盘 ${onDisk.length} 档 == 登记表 ${registered.length} 键（${onDisk.join('、')}）`);
  }

  for (const name of registered) {
    const tier = TIERS[name];
    const cfgPath = path.join(root, name);

    // ── T2 应检面：B 面（tsc 实际输入）== manifest 双向 ──
    const listR = await runTscListFiles(tscBin, cfgPath, root);
    if (listR.spawnErr) throw new Error(`listFilesOnly spawn 失败：${listR.spawnErr.message}`);
    const faceB = parseTscFileList(Buffer.concat([...listR.out, ...listR.err]).toString('utf8'), root);
    if (faceB.size === 0) {
      fails.push(`T5 逐档下限：${name} 的 tsc 输入面解析为 0 个文件——tsc 没跑起来／tsconfig 坏掉／include 全空，不许当绿`);
      continue;
    }
    const mf = new Set(tier.files);
    if (mf.size === 0) fails.push(`T2 应检面：${name} 的 manifest 为空——空 manifest 不许过（§77①）`);
    const manifestOnly = [...mf].filter((f) => !faceB.has(f)).sort();
    const inputOnly = [...faceB].filter((f) => !mf.has(f)).sort();
    for (const f of manifestOnly) {
      fails.push(`T2 应检面：${name} manifest 有 ${f}、tsc 实际没读（include 缩面/深度漂移/manifest 手误，L2/L9）`);
    }
    for (const f of inputOnly) {
      fails.push(`T2 应检面：${name} tsc 读了 ${f}、manifest 没登记（include 扩面或 manifest 漏写，L9 反向）`);
    }
    const outsideBase = tier.files.filter((f) => !faceA.aSet.has(f)).sort();
    for (const f of outsideBase) {
      fails.push(`T2 应检面：${name} 的 ${f} 不在基础档 A 面（打包面）——分档只许在发货面上加查，档间重叠不许破`);
    }
    if (!manifestOnly.length && !inputOnly.length && !outsideBase.length) {
      notes.push(`T2 应检面：${name} manifest ${mf.size} == tsc 输入 ${faceB.size}（⊆ 基础档 A 面 ${faceA.aSet.size}）`);
    }

    // ── T3 逐档棘轮 + T4 台账 schema ──
    const r = await runTsc(tscBin, cfgPath, root);
    if (r.spawnErr) throw new Error(`tsc spawn 失败：${r.spawnErr.message}`);
    const text = Buffer.concat([...r.out, ...r.err]).toString('utf8');
    const perFile = new Map();
    let total = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(ERR_LINE_RE);
      if (!m) continue;
      total++;
      perFile.set(m[1], (perFile.get(m[1]) || 0) + 1);
    }
    const detail = [...perFile.entries()].map(([f, n]) => `${f} ${n}`).join('／') || '无';
    const n = tier.baseline ? tier.baseline.n : undefined;
    if (Number.isInteger(n) && total > n) {
      fails.push(`T3 棘轮：${name} 错误 ${total} 条 > 基线 ${n}（+${total - n}）——修错或走台账落账，不许只改数字`);
    }
    if (Number.isInteger(n) && total < n) {
      notes.push(`★ ${name} 基线可下调 ${n - total} 条：${n} → ${total}（改 TIERS 的 n 并在 history 补一条落账，仍 exit 0）`);
    }
    for (const f of ledgerFails(name, tier.baseline)) fails.push(`T4 台账：${f}`);
    notes.push(`T3 棘轮：${name} tsc 解析 ${total} 条 / ${perFile.size} 文件（基线 ${n}）：${detail}`);
  }

  // ── T6 契约面（票 14-L 任务 2 的判据落点）：glob ⇄ 登记双向相等 + 独立 tsc 直查 ──
  const contractOnDisk = fs.readdirSync(path.join(root, 'types'))
    .filter((f) => CONTRACT_FILE_RE.test(f)).map((f) => `types/${f}`).sort();
  const contractReg = [...CONTRACT_FILES].sort();
  if (contractOnDisk.length === 0) fails.push('T6 契约面：types/contract-*.d.ts 一个都不在——契约面清空不许空转全绿（§77①）');
  for (const f of contractOnDisk.filter((f) => !contractReg.includes(f))) {
    fails.push(`T6 契约面：${f} 在磁盘上但不在 CONTRACT_FILES 登记清单——新契约必须两处显式（文件＋登记）`);
  }
  for (const f of contractReg.filter((f) => !contractOnDisk.includes(f))) {
    fails.push(`T6 契约面：登记了 ${f} 但文件不存在——删契约是显式动作，须连登记一起删`);
  }
  const contractTargets = contractReg.filter((f) => contractOnDisk.includes(f));
  if (contractTargets.length) {
    const contractCfg = path.join(root, 'tsconfig.contract.json');
    if (!fs.existsSync(contractCfg)) {
      fail3(`前置不满足：${contractCfg} 不存在——契约面的执行通道（无 skipLibCheck + types:[]）不能缺，不许跳过当绿`);
    }
    const cR = await runTsc(tscBin, contractCfg, root);
    if (cR.spawnErr) throw new Error(`契约面 tsc spawn 失败：${cR.spawnErr.message}`);
    const cText = Buffer.concat([...cR.out, ...cR.err]).toString('utf8');
    let cErrors = 0;
    for (const line of cText.split(/\r?\n/)) {
      if (!ERR_LINE_RE.test(line)) continue;
      cErrors++;
      fails.push(`T6 契约面：${line.replace(/\\/g, '/')}（契约改坏签名 ⇒ 类型级用例断言翻红，L8）`);
    }
    if (cErrors === 0) notes.push(`T6 契约面：${contractTargets.length} 份契约独立 tsc 直查 0 错（skipLibCheck 管不到这条路）`);
  }

  for (const nt of notes) console.log(`[tiers] ${nt}`);
  if (fails.length) {
    for (const f of fails) console.error(`✗ ${f}`);
    console.error(`FAIL：T1–T6 断言共命中 ${fails.length} 处`);
    process.exit(1);
  }
  console.log('✓ T1 档枚举（glob ⇄ 登记表双向相等，档数下限）');
  console.log('✓ T2 应检面（manifest == tsc 输入，⊆ 基础档 A 面，档间重叠）');
  console.log('✓ T3 棘轮（逐档总数 ≤ 基线，下调明打）');
  console.log('✓ T4 台账 schema（n === history 末条 n，留痕四件套齐）');
  console.log('✓ T5 逐档下限（tsc 输入面非空）');
  console.log('✓ T6 契约面（contract-*.d.ts ⇄ 登记双向，独立 tsc 直查用例断言）');
  console.log(`PASS 6/6（checkJs 分档棘轮，${registered.length} 档）`);
  process.exit(0);
})().catch((e) => {
  console.error(`脚本异常：${(e && e.message) || e}`);
  process.exit(1);
});
