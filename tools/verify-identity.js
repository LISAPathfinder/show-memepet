// 名字一致性守卫（票 11-A）：
// package.json 是 JSON、引用不了 JS 常量，identity.js 的值与 package.json 之间只能靠
// 断言兜底——漏改一处从静默失效变成必红（开发协议铁律 3「判据落在终判层」的正面应用；
// 该协议本机维护、不随公开版发布）。
//
// 用法（纯 node、零依赖，main 与 tools 共用 identity.js）：
//   node tools/verify-identity.js
// 退出码：0 = 全部一致；1 = 任一比对不一致 / identity 自身不自洽 / tools/ 存在裸日志名字面量
//         / main.js、renderer/ 存在裸产品名字面量。
//
// 四组检查：
//   ① identity.js 自身：9 个导出常量存在且非空、EXE_BASENAMES 是非空数组且含当前产品名
//     派生的 exe 名（productName 决定映像名，二者脱钩 = 双认名单失真）、APP_ID 由 slug 派生；
//   ② package.json 六项逐项比对：name / build.productName / build.nsis.artifactName /
//     build.directories.output / build.appId / build.nsis.guid（钉死字面量，票 11-B 第 2b 条）；
//   ③ tools/ 源码不得出现裸日志名字面量（needle 运行时取自 identity，改名后自动跟着换）——
//     读日志必须走 LOG_NAME/LOG_CANDIDATES，否则「读不到日志 → 零候选断言假绿」的坑会回来；
//   ④ main.js / renderer/ 代码行不得出现裸产品名字面量（票 11-E 任务 2b）——产品名散回
//     业务代码时第③组结构上抓不到（它只扫 tools/ 的日志名），不补这组，改名这处还会漏
//     （症状：通知/文案仍显示旧名，不报错）。
const fs = require('fs');
const path = require('path');
const identity = require('../identity');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;

function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' —— ' + detail : ''}`);
}

// ---- ① identity.js 自身 ----
console.log('== identity.js 自身 ==');
for (const key of ['APP_SLUG', 'PRODUCT_NAME', 'APP_ID', 'RUN_VALUE_NAME', 'LOG_NAME', 'ADMIN_LOG_NAME', 'BUILD_DIR_NAME', 'TRAY_TITLE', 'WINDOW_TITLE']) {
  const v = identity[key];
  check(`${key} 存在且为非空字符串`, typeof v === 'string' && v.length > 0, `值=${JSON.stringify(v)}`);
}
// 票 11-F：自启 Run 键值名钉死 = APP_ID（写路径与 findRunEntry 判据同源，§75——Electron
// 默认值名跟随 AUMID 且会漂移，钉死后两边不再脱钩）。派生自洽锚：与 APP_ID/LOG_NAME 同理，
// 没有这条，RUN_VALUE_NAME 与 APP_ID 错开时守卫全绿而注册表出现第二条键。
check(
  'RUN_VALUE_NAME 由 APP_ID 派生（自启 Run 值名 = AUMID，票 11-F）',
  identity.RUN_VALUE_NAME === identity.APP_ID,
  `实际=${JSON.stringify(identity.RUN_VALUE_NAME)} 期望=${JSON.stringify(identity.APP_ID)}`
);
const exeArr = identity.EXE_BASENAMES;
check(
  'EXE_BASENAMES 是非空字符串数组',
  Array.isArray(exeArr) && exeArr.length > 0 && exeArr.every((n) => typeof n === 'string' && n.length > 0),
  `值=${JSON.stringify(exeArr)}`
);
check(
  'EXE_BASENAMES 含当前产品名派生的映像名（PRODUCT_NAME → exe 名）',
  Array.isArray(exeArr) && exeArr.some((n) => n.toLowerCase() === String(identity.PRODUCT_NAME).toLowerCase() + '.exe'),
  `期望含 ${String(identity.PRODUCT_NAME).toLowerCase()}.exe`
);
check(
  'EXE_BASENAMES 每个条目都由当前产品名派生（迁移期双认已随票 11-Q 退休——谁把旧名/别名加回来这里必红）',
  Array.isArray(exeArr) && exeArr.every((n) => n.toLowerCase() === String(identity.PRODUCT_NAME).toLowerCase() + '.exe'),
  `值=${JSON.stringify(exeArr)}`
);
check(
  'LEGACY_APP_ID 已随票 11-Q 退休（identity 不再导出，旧 AUMID 清理段已删——复活性变更必须连这条守卫一起改）',
  !('LEGACY_APP_ID' in identity),
  identity.LEGACY_APP_ID == null ? '已撤' : `仍在=${JSON.stringify(identity.LEGACY_APP_ID)}`
);
check(
  'LOG_CANDIDATES 以 LOG_NAME 开头（当前写用名必须是第一候选）',
  Array.isArray(identity.LOG_CANDIDATES) && identity.LOG_CANDIDATES[0] === identity.LOG_NAME,
  `值=${JSON.stringify(identity.LOG_CANDIDATES)}`
);
// 派生自洽锚：这几个名字由 APP_SLUG 派生（票面已定日志名随 slug 走，见 findings 票 1.3）。
// 没有这条，LOG_NAME 打错字四项比对全绿——判别性自证（验收 b）会失败，守卫对最关键的日志名不设防
check(
  'LOG_NAME 由 APP_SLUG 派生（"<APP_SLUG>.log"）',
  identity.LOG_NAME === identity.APP_SLUG + '.log',
  `实际=${JSON.stringify(identity.LOG_NAME)} 期望=${JSON.stringify(identity.APP_SLUG + '.log')}`
);
check(
  'ADMIN_LOG_NAME 由 APP_SLUG 派生（"<APP_SLUG>-admin.log"）',
  identity.ADMIN_LOG_NAME === identity.APP_SLUG + '-admin.log',
  `实际=${JSON.stringify(identity.ADMIN_LOG_NAME)} 期望=${JSON.stringify(identity.APP_SLUG + '-admin.log')}`
);
check(
  'BUILD_DIR_NAME 由 APP_SLUG 派生（"<APP_SLUG>-build"）',
  identity.BUILD_DIR_NAME === identity.APP_SLUG + '-build',
  `实际=${JSON.stringify(identity.BUILD_DIR_NAME)} 期望=${JSON.stringify(identity.APP_SLUG + '-build')}`
);
// 票 11-B 第 2b 条：APP_ID 由 slug 派生（§1.1 候选 A 选它的理由）。若日后换成不能派生的值，
// 这里连同 identity.js 的派生表达式一起改成字面量比对，并在注释注明它不派生自 slug。
check(
  'APP_ID 由 APP_SLUG 派生（"com.<APP_SLUG>.app"）',
  identity.APP_ID === 'com.' + identity.APP_SLUG + '.app',
  `实际=${JSON.stringify(identity.APP_ID)} 期望=${JSON.stringify('com.' + identity.APP_SLUG + '.app')}`
);

// ---- ② package.json 四项逐项比对 ----
console.log('== package.json 与 identity.js 比对 ==');
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (e) {
  console.error(`✗ package.json 读取/解析失败: ${e.message}`);
  process.exit(1);
}
const b = pkg.build || {};
const bNsis = b.nsis || {};
const bDirs = b.directories || {};
const checks = [
  ['name === APP_SLUG', pkg.name, identity.APP_SLUG],
  ['build.productName === PRODUCT_NAME', b.productName, identity.PRODUCT_NAME],
  // artifactName 是 electron-builder 的字面模板，${version}/${ext} 不是 JS 插值，单引号拼接保持原样
  ['build.nsis.artifactName === "<APP_SLUG>-setup-${version}.${ext}"', bNsis.artifactName, identity.APP_SLUG + '-setup-${version}.${ext}'],
  ['build.directories.output === "../<BUILD_DIR_NAME>/release"', bDirs.output, '../' + identity.BUILD_DIR_NAME + '/release'],
  // 票 11-B 第 2b 条：appId 换值后把它纳入守卫（换 appId 会改 AUMID 身份，见 §66 补注）
  ['build.appId === APP_ID', b.appId, identity.APP_ID],
  // guid 必须是字面量——它就是钉住的身份。改动它等于断开升级链、装出并存实例、
  // 数据根劈成两半（PITFALLS §66：1.0.28 实踩；1.0.29 起钉住，18 次覆盖安装只有一条键）。
  // 这条把「手滑改/删 guid」从静默灾难变成 CI 必红。
  ['build.nsis.guid === "fc5d11e1-8dec-51f5-b3eb-7f4d1eb01281"（钉死，见 PITFALLS §66）', bNsis.guid, 'fc5d11e1-8dec-51f5-b3eb-7f4d1eb01281'],
];
for (const [label, actual, expect] of checks) {
  check(
    label,
    actual === expect,
    actual === expect ? `值=${JSON.stringify(actual)}` : `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)}`
  );
}

// ---- ③ tools/ 裸日志名字面量扫描 ----
console.log('== tools/ 裸日志名字面量扫描 ==');
// needle 运行时从 identity 取（含回落名）：改名后自动改为扫描新名 + 旧名残留，本文件自身
// 源码不出现任何日志名字面量，因此不需要排除自己
const needles = [...new Set([identity.LOG_NAME, identity.ADMIN_LOG_NAME, ...(identity.LOG_CANDIDATES || [])])];
const toolFiles = fs.readdirSync(__dirname).filter((n) => n.endsWith('.js'));
let literalHits = 0;
for (const f of toolFiles) {
  const lines = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const needle of needles) {
      if (line.includes(needle)) {
        literalHits++;
        console.log(`✗ 裸字面量 "${needle}" @ tools/${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
  });
}
check(
  `tools/ 下无裸日志名字面量（扫描 ${toolFiles.length} 个 js × ${needles.length} 个名字）`,
  literalHits === 0,
  literalHits === 0 ? '读日志均走 identity.LOG_NAME / LOG_CANDIDATES' : `${literalHits} 处命中，应改为 require('../identity')`
);

// ---- ④ main.js / renderer/ 裸产品名字面量扫描（票 11-E 任务 2b） ----
console.log('== main.js / renderer/ 裸产品名字面量扫描 ==');
// needle 运行时取自 identity（改名后自动跟着换）；identity.js 是单一真源自身，不在扫描名单。
// 注释行判定（写死规则）：trim 后行首是 // 、/* 、* 、<!-- 四者之一 → 注释行豁免；
//   行尾注释不豁免（该行有代码）。理由：注释里的硬编码名不进运行期行为，代码行里的会
//   （症状：通知/文案仍显示旧名，不报错）。纯行前缀判定、不解析语言语义——宁可对
//   「以 * 开头的 CSS 通配选择器行」这类罕见形态少豁免，也不给代码行留豁免口子。
const prodNeedle = identity.PRODUCT_NAME;
const scanTargets = ['main.js'];
const rendererDir = path.join(ROOT, 'renderer');
if (fs.existsSync(rendererDir)) {
  scanTargets.push(...fs.readdirSync(rendererDir).filter((n) => fs.statSync(path.join(rendererDir, n)).isFile()).map((n) => `renderer/${n}`));
}
let prodHits = 0;
for (const rel of scanTargets) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s.startsWith('<!--')) return; // 注释行豁免
    if (s.includes(prodNeedle)) {
      prodHits++;
      console.log(`✗ 裸产品名字面量 "${prodNeedle}" @ ${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}
check(
  `main.js / renderer/ 无裸产品名字面量（扫描 ${scanTargets.length} 个文件 × 1 个名字；注释行按行前缀规则豁免）`,
  prodHits === 0,
  prodHits === 0 ? '显示名均走 identity.PRODUCT_NAME' : `${prodHits} 处命中，应改为 require('./identity')`
);

console.log(failed === 0 ? '\n结论：PASS（名字单一真源与 package.json 全部一致）' : `\n结论：FAIL（${failed} 项不过）`);
process.exit(failed === 0 ? 0 : 1);
