// 自启注册表读回纯函数回归件（票 11-C 任务 1d 立件；票 11-Q 起判据换轨）。纯 node 零依赖、
// 真断言、非零退出码（铁律 3）。判据落在被测语义（findRunEntry / isStartupApprovedEnabled 的
// 返回值）上，任何一条不符 exit 1。
//
// 票 11-Q（2026-10-06）退休 ④（自启旧值名清理段）：pickLegacyRunEntries 随生产调用一并删除，
// 本件原「旧键匹配用例矩阵」随之退役。11-B 回归基线**重写语义而非删掉**：
//   旧半「缺陷正则对实机形态夹具命中 0」保留——它是夹具保真守卫（变红 = 夹具丢了行首 4 空格）；
//   新半换成**活判据**：findRunEntry（main.js 新键读回用同一函数）对同形态夹具必须命中 1——
//   「reg query 行首空白容忍」这条教训从此钉在还在跑的路径上，而不是钉在已退休的旧键匹配上。
// 夹具含从实机 dump 抄来的行（行首 4 空格 + 双引号路径 + ` --autostart`），出处：票 11-B
// 校验结论的只读复演读数；夹具与新旧两条对照都在本文件内，不依赖外部文档。
// 用法：node tools/verify-autostart-migration.js
'use strict';

const fs = require('fs');
const path = require('path');
const { findRunEntry, commandImageBasename, isStartupApprovedEnabled } = require('../autostart-migration');
const { LEGACY_SLUG, RUN_VALUE_NAME } = require('../identity');

let failed = 0;
let passed = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` : 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)}`}`);
}

// —— 实机 dump 形态（2026-10-04 校验轮 reg query 只读复演抄录：行首 4 空格、列间 4 空格）——
// 这是 11-B 缺陷的原始现场：当年 main.js 写死行首不容空白的正则，对这一行命中 0、整条清理静默空转。
// 命令串里的目录已按仓库文本约定换成中性路径（判据只看值名与映像基名，目录不参与断言）。
const LEGACY_VALUE_NAME = 'electron.app.desktop-pet';
const LEGACY_COMMAND = '"D:\\Apps\\desktop-pet\\bin\\desktop-pet.exe" --autostart';
const REAL_DUMP = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  `    ${LEGACY_VALUE_NAME}    REG_SZ    ${LEGACY_COMMAND}`,
  '',
].join('\r\n');

// 票 11-B 旧正则原样复刻（^(\S*\.desktop-pet)...，行首不容空白），仅作缺陷纪念 + 夹具保真守卫
const OLD_REGEX_11B = new RegExp('^(\\S*\\.' + LEGACY_SLUG + ')\\s+REG_SZ\\s+(.*)$', 'i');

// 当前时代的实机形态（1.0.55 起 reg 直写，值名钉死 identity.RUN_VALUE_NAME；路径是实机安装容器）
const CURRENT_COMMAND = '"D:\\Apps\\desktop-pet\\bin\\Showcase.exe" --autostart';
const CURRENT_DUMP = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  `    ${RUN_VALUE_NAME}    REG_SZ    ${CURRENT_COMMAND}`,
  '',
].join('\r\n');

console.log(`① 回归基线（11-B 语义重写版；legacySlug = identity.LEGACY_SLUG = "${LEGACY_SLUG}"，活判据值名 = identity.RUN_VALUE_NAME）`);
const oldHits = REAL_DUMP.split(/\r?\n/).filter((l) => OLD_REGEX_11B.test(l)).length;
console.log(`  旧缺陷正则（11-B 版）对实机形态行命中：${oldHits}（红：缺陷复现纪念）`);
check('旧缺陷正则对实机形态命中 0（此断言变红 = 夹具丢了实机行首空白）', oldHits, 0);
const liveHit = findRunEntry(CURRENT_DUMP, RUN_VALUE_NAME);
console.log(`  活判据 findRunEntry 对同形态当前值名行命中：${liveHit ? 1 : 0}（绿：行首空白容忍在被测路径上）`);
check('活判据：实机形态当前值名行 → 找到', liveHit !== null, true);
check('  取出 valueName', liveHit ? liveHit.valueName : null, RUN_VALUE_NAME);
check('  取出 command', liveHit ? liveHit.command : null, CURRENT_COMMAND);

console.log('② findRunEntry（新键读回判据，票 11-D 任务 1a）');
// 11-C 时代 Electron 默认值名形态（electron.app.<getName()>）；1.0.55 起 reg 直写后值名 = RUN_VALUE_NAME
const NEW_VALUE_NAME = 'electron.app.Showcase';
const NEW_COMMAND = '"D:\\Apps\\desktop-pet\\bin\\Showcase.exe" --autostart';
const NEW_DUMP = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  `    ${NEW_VALUE_NAME}    REG_SZ    ${NEW_COMMAND}`,
  '',
].join('\r\n');
const hitNew = findRunEntry(NEW_DUMP, NEW_VALUE_NAME);
check('新键实机形态 → 找到', hitNew !== null && hitNew.valueName === NEW_VALUE_NAME && hitNew.command === NEW_COMMAND, true);
check('值名大小写不敏感（electron.app.showcase → 命中注册表原样 Showcase）',
  findRunEntry(NEW_DUMP, 'electron.app.showcase') !== null &&
  findRunEntry(NEW_DUMP, 'electron.app.showcase').valueName === NEW_VALUE_NAME, true);
check('RUN_VALUE_NAME 直写形态 → 找到（1.0.55+ 现行形态）', findRunEntry(CURRENT_DUMP, RUN_VALUE_NAME) !== null, true);
check('不存在的新键 → null', findRunEntry(REAL_DUMP, RUN_VALUE_NAME), null);
check('空文本 → null', findRunEntry('', NEW_VALUE_NAME), null);
check('行首空白容忍（夹具行首 4 空格，回归 11-B 失配根因）',
  findRunEntry(`    ${NEW_VALUE_NAME}    REG_SZ    ${NEW_COMMAND}`, NEW_VALUE_NAME) !== null, true);
const dumpExpandNew = `    ${NEW_VALUE_NAME}    REG_EXPAND_SZ    ${NEW_COMMAND}`;
check('类型不限（REG_EXPAND_SZ 也算「值存在」，指向复核归调用方）', findRunEntry(dumpExpandNew, NEW_VALUE_NAME) !== null, true);

console.log('③ commandImageBasename（1b 第二判据：命令串取映像基名）');
check('基名判据（指向 Showcase.exe）', commandImageBasename(NEW_COMMAND), 'showcase.exe');
check('基名判据负例（手工改指 helper.exe）', commandImageBasename('"D:\\Apps\\desktop-pet\\bin\\helper.exe" --autostart'), 'helper.exe');

console.log('④ isStartupApprovedEnabled（票 11-F：任务管理器禁用 = 意图不自启，StartupApproved 首字节三态解析）');
// 实机形态抄录（2026-10-04 reg query StartupApproved\Run 读数：行首 4 空格 + 连续 hex；
// 01=禁用带 FILETIME 尾（同 EADM 实测形态），02=启用全零尾，03=启用带时间戳尾）
const APPROVED_DUMP = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
  '    electron.app.Showcase    REG_BINARY    03000000EA833D4DE253DD01',
  '    com.showcase.app    REG_BINARY    0100000009A408A75DEBDB01',
  '    GameViewer    REG_BINARY    020000000000000000000000',
  '',
].join('\r\n');
check('首字节 03 → 启用（实机 electron.app.Showcase 基线读数）', isStartupApprovedEnabled(APPROVED_DUMP, 'electron.app.Showcase'), true);
check('首字节 01 → 禁用（11-F 裁决：禁用 = 意图不自启）', isStartupApprovedEnabled(APPROVED_DUMP, 'com.showcase.app'), false);
check('首字节 02 → 启用（全零尾形态）', isStartupApprovedEnabled(APPROVED_DUMP, 'GameViewer'), true);
check('值名无条目 → null（任务管理器「未计量」语义，调用方按启用处理）', isStartupApprovedEnabled(APPROVED_DUMP, 'no.such.entry'), null);
check('空文本 → null', isStartupApprovedEnabled('', 'com.showcase.app'), null);
check('行首空白容忍（实机 dump 形态，回归 11-B 失配根因）', isStartupApprovedEnabled('    com.showcase.app    REG_BINARY    03000000', 'com.showcase.app'), true);
check('畸形 hex（非数字）→ null 防御', isStartupApprovedEnabled('    com.showcase.app    REG_BINARY    xyz', 'com.showcase.app'), null);

console.log('⑤ 调用点定界（票 11-R 任务 1：④ 退休的退出码牙齿）——读 main.js 源码');
// 代码行匹配：注释行豁免（与 probe-compat-layer-state 的 codeHits 同口径）——main.js:139 留着
// 「pickLegacyRunEntries 已随票 11-Q 退休」的退休记录注释，朴素 includes 会把注释当接缝。
const codeHits = (src, needle) =>
  src === null
    ? null
    : src
        .split('\n')
        .filter((l) => {
          const s = l.trim();
          return !(s.startsWith('//') || s.startsWith('/*') || s.startsWith('*'));
        })
        .filter((l) => l.includes(needle)).length;
let mainSrc = null;
try {
  mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
} catch (e) {
  console.error(`  脚本异常：main.js 读不到（${e.message}）`);
}
const legacyCalls = codeHits(mainSrc, 'pickLegacyRunEntries');
check('main.js 已无 pickLegacyRunEntries 代码行调用（变红 = ④ 清理段复活）', legacyCalls, 0);
const intentCalls = codeHits(mainSrc, 'ensureAutostartIntent();');
check('ensureAutostartIntent(); 调用点仍在（正向对照，防"读不到源码即绿灯"）', intentCalls !== null && intentCalls > 0, true);

console.log(`结果：${passed} pass / ${failed} fail`);
if (failed) {
  console.error('结论：FAIL');
  process.exit(1);
}
console.log('结论：PASS');
