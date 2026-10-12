// @runtime: ci —— CI 强制层判据件：PITFALLS 条目结构断言，纯 node 零依赖，执行面在 run-ci.js
// PITFALLS 条目结构断言：把「新坑条目必须落在 ## 九 之内、不得掉进 ## 十 之后」从
// 口头自检（「改完 grep -nE '^## 九|^### 9|^## 十' 自检」——已被 §96 证伪：口头自检挡不住）
// 变成机器断言。同一坑三次实录：§86/87/88 曾掉在「## 十」之后（人工搬回，c4db88e）、
// §91 同型、§96（17cf8b4）又掉在「## 十、复盘」之后。
//
// 断言（全部现算，不把当前数字写死）：
//   R1 末章隔离：出现「## 十、」之后不得再出现任何 `### N.`（N 纯数字、非 N.M 子节形式）；
//      锚找不到判红（不许当绿）。这条治 §96 那类错位。
//   R2 条号唯一：非豁免 `### N.` 的 N 必须唯一；豁免表 EXEMPT_DUPES 逐项带理由，
//      豁免号的重复次数必须恰等于登记值（46 = 2 处历史重号，登记不改——改号会让引用失联）；
//      第三处出现 = 红。删豁免 = 现存两处立刻红（豁免真在起作用）。
//   R3 新条递增：max(N) == 次大值 + 1（防跳号/防写成 96.5 之类）；条号有洞不算红
//      （39/40/41 不存在是既有形态）。条数 < 2 时红（无从比较）。
//   R4 读到东西才算数（正向对照，PITFALLS §77① 同族——防「文件改名/读空 ⇒ 集合为空 ⇒
//      所有断言恒真」）：必须解析到 ≥50 条编号条目且 max(N) ≥ 90，否则 exit 1 打实际数字。
//   R5 退出码全项目统一：0 全绿 / 1 断言失败或脚本自身异常（stderr 打「脚本异常：<原因>」）/
//      3 前置不满足（PITFALLS.md 不存在、根传错）。
//
// 解析口径（按既有历史形态，不许为了变绿去改文档）：
//   - 条   = `### N. <标题>`（N 纯数字，标题不以数字开头——现存条无一例外）；
//   - 子节 = `### N.M <标题>`（M 纯数字），十架专有形态 10.1~10.6 与 4.x/20.x/29.x 同族，
//     不参与 R1/R2/R3。
//   - 确定结果（S3 语义）：把末条「### 96.」改写成「### 96.5」之类 N.M 形态 ⇒ 按子节解析、
//     三条断言都不拦（96 从条集合消失后 max=95、次大=94，R3 恰好绿）——这是「条与子节
//     必须区分」这一解析规则的直接推论，登记在案；该形态的真实防线是 R1 对「## 十、」锚
//     的隔离 + code review。写「### 120.」跳号则 R3 必红。
//   - 章标题不假设连续或纯数字（无「## 四、」、有「## 六点五、」）。
//
// 用法：node tools/verify-docs-structure.js [仓库根]（默认本仓库根；argv[2] 传根供突变自证，
//       先例 verify-fallback-box.js / verify-build-files.js——注意是 process.argv[2]）
// 判据层：文档结构层（纯文本解析），不接实例、零依赖。
'use strict';
const fs = require('fs');
const path = require('path');

function fail3(msg) { console.error(msg); process.exit(3); }

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const docPath = path.join(root, 'PITFALLS.md');
if (!fs.existsSync(docPath)) fail3(`前置不满足：${docPath} 不存在（根传错或文件改名）——不许当绿`);

// 豁免表：历史重号登记（号 → 允许出现次数 + 理由）。登记不改号——改号会让既有引用失联。
// 新增豁免必须在这里点名并写理由与日期。
const EXEMPT_DUPES = {
  46: { count: 2, reason: '历史重号（363 行 uiohook 实测 与 658 行「点不动」复发第八轮），登记不改号' },
};

let lines;
try {
  lines = fs.readFileSync(docPath, 'utf8').split(/\r?\n/);
} catch (e) {
  console.error(`脚本异常：读 PITFALLS.md 失败：${e.message}`);
  process.exit(1);
}

const fails = [];
const ENTRY_RE = /^### (\d+)\.(.*)$/;
const isSubsection = (rest) => /^\d+(\s|$)/.test(rest); // `### N.M 标题`：M 后接空白或行尾

const chapters = [];           // { line, title }（1-based 行号）
let entries = [];              // { n, line }
let subsections = 0;
let tenAnchorLine = -1;        // 「## 十、」锚

lines.forEach((raw, i) => {
  const line = raw.trimEnd();
  if (/^## 十、/.test(line)) { tenAnchorLine = i + 1; chapters.push({ line: i + 1, title: line }); return; }
  if (/^## /.test(line)) { chapters.push({ line: i + 1, title: line }); return; }
  const m = line.match(ENTRY_RE);
  if (!m) return;
  if (isSubsection(m[2])) { subsections++; return; }
  entries.push({ n: parseInt(m[1], 10), line: i + 1 });
});

// R4 正向对照先算（防读空 ⇒ 后续断言空转全绿）
const count = entries.length;
const maxN = count ? Math.max(...entries.map(e => e.n)) : 0;
if (count < 50 || maxN < 90) {
  fails.push(`R4 读数下限：解析到 ${count} 条（要求 ≥50）、max(N)=${maxN}（要求 ≥90）` +
    `——文件读空/改名/解析被改坏时集合断言会空转全绿，先查这里`);
}

// R1 末章隔离
if (tenAnchorLine < 0) {
  fails.push(`R1 找不到「## 十、」锚——末章隔离失效（锚改名/被删不许当绿）`);
} else {
  const after = entries.filter(e => e.line > tenAnchorLine);
  if (after.length) {
    fails.push(`R1 末章隔离：「## 十、」（第 ${tenAnchorLine} 行）之后出现 ${after.length} 条编号条目：` +
      after.map(e => `第 ${e.line} 行 §${e.n}`).join('、') + '——这就是 §96 那类错位');
  }
}

// R2 条号唯一（豁免号允许恰 = 登记次数）
const byN = new Map();
for (const e of entries) {
  if (!byN.has(e.n)) byN.set(e.n, []);
  byN.get(e.n).push(e);
}
for (const [n, list] of byN) {
  const exempt = EXEMPT_DUPES[n];
  const allowed = exempt ? exempt.count : 1;
  if (list.length > allowed) {
    const why = exempt ? `豁免登记 ${n} 允许 ${exempt.count} 处（${exempt.reason}），实见 ${list.length} 处`
                       : `非豁免条号重复`;
    fails.push(`R2 条号唯一：§${n} 出现 ${list.length} 处（第 ${list.map(x => x.line).join('、')} 行）——${why}`);
  }
}

// R3 新条递增：max == 次大 + 1
if (count >= 2) {
  const sorted = [...new Set(entries.map(e => e.n))].sort((a, b) => b - a);
  if (sorted[0] !== sorted[1] + 1) {
    fails.push(`R3 新条递增：max(N)=${sorted[0]}，次大=${sorted[1]}，期望 max == 次大+1（防跳号/防写成 96.5 之类）`);
  }
} else if (count > 0) {
  fails.push(`R3 新条递增：条数 ${count} < 2，无从比较 max 与次大`);
}

// 读数（现算数字，原件必绿时打印）
const exemptHits = entries.filter(e => EXEMPT_DUPES[e.n]).length;
console.log(`PITFALLS 结构读数：章数=${chapters.length} 条数=${count} 子节数=${subsections} ` +
  `max(N)=${maxN} 「## 十、」锚=第${tenAnchorLine >= 0 ? tenAnchorLine : '无'}行 ` +
  `豁免命中=${exemptHits}（${Object.keys(EXEMPT_DUPES).map(k => `§${k}×${byN.get(+k) ? byN.get(+k).length : 0}/${EXEMPT_DUPES[k].count}`).join('、') || '无'}）`);

if (fails.length) {
  console.error(`✗ ${fails.length} 项断言失败：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASS：PITFALLS 条目结构断言全绿');
