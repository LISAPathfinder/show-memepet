// @runtime: ci —— CI 强制层判据件：久坐提醒三态的真值表与结构对齐，纯 node 零依赖
// 票 13-B 的判据：菜单交互从「两个独立勾」改成「一项三态互斥子菜单」之后，什么算改坏了。
//
// 为什么要有它（四条各对一个真实回归形态）：
//   ①三态语义：`notify` 是「气泡 + toast」，不是「只 toast」。谁把 showsToast 写成 `mode !== off`
//     或把 bubble 也算进 toast，今天这套判据必红。
//   ②迁移正确性（派生断言）：老用户配置里只有旧两键。判据不只看 fromLegacy 的输出形状，
//     而是断言**迁移后的显示行为 ≡ 旧代码在同样输入下的显示行为**（4 组全算），
//     这样「迁移把偏好读反」才会红——只看形状拦不住口径替换（PITFALLS §98 同族）。
//   ③结构对齐：REMINDER_MODES 里每个模式都要在 main.js 的 menuActions 里有 `reminder-<mode>` 动作。
//     漏登记不是小事——runMenuAction 先查表再走前缀分支，缺项会把 id 当成未知动作静默吞掉。
//   ④不留双真源：main.js 里不许再出现 `config.get('reminderEnabled')` / `reminderNotifyWindows`
//     这类读取（旧键只允许活在 config.js 的迁移行里，那是读 saved、不是读 config）。
//
// 工艺（都踩过坑，见 §97 与第 46/55 款）：
//   - 结构扫描面**写明**：扫 main.js 与 config.js 的代码行，跳过 `//` 注释行与行内注释尾部；
//     注释里出现旧键名是在解释历史，算命中就是不可满足的判据。
//   - 正向对照先跑：三个被读文件必须存在且非空、core 导出必须齐——上游读不到时集合断言会空转全绿。
//   - 不复制真源：真值表一律 require `core/reminder-mode.js` 的真函数算。
//
// 用法：node tools/verify-reminder-mode.js [仓库根]（默认本仓库根；argv 传根供突变自证，不必复制整仓）
// 退出码：0 全绿 / 1 断言失败（件自身异常也落 1，stderr 打「脚本异常：<原因>」）/ 3 前置不满足。
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const P_CORE = path.join(root, 'core', 'reminder-mode.js');
const P_MAIN = path.join(root, 'main.js');
const P_CONFIG = path.join(root, 'config.js');
const missing = [P_CORE, P_MAIN, P_CONFIG].filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error(`前置不满足：${missing.map((p) => path.relative(root, p)).join('、')} 读不到（仓库根 ${root} 无效？）`);
  process.exit(3);
}

let checks = 0;
let fails = 0;
function check(ok, label, detail) {
  checks++;
  if (detail) console.log(`${ok ? '✓' : '✗'} ${label} —— ${detail}`);
  else console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) fails++;
}

const rm = require(P_CORE);
const { OFF, BUBBLE, NOTIFY, DEFAULT_MODE, REMINDER_MODES, isMode, normalize, showsBubble, showsToast, fromLegacy, checkedFor } = rm;

// ---- ①正向对照：导出面齐、文件非空（防"读不到就空转全绿"）----
const EXPORTS = ['OFF', 'BUBBLE', 'NOTIFY', 'DEFAULT_MODE', 'REMINDER_MODES', 'isMode', 'normalize', 'showsBubble', 'showsToast', 'fromLegacy', 'checkedFor'];
const missingExports = EXPORTS.filter((k) => rm[k] === undefined);
check(missingExports.length === 0, '正向对照：core/reminder-mode 导出齐', `缺 ${missingExports.length}：${missingExports.join(',') || '无'}`);
const mainSrc = fs.readFileSync(P_MAIN, 'utf8');
const configSrc = fs.readFileSync(P_CONFIG, 'utf8');
check(mainSrc.length > 1000 && configSrc.length > 200 && fs.statSync(P_CORE).size > 200,
  '正向对照：三个被扫文件都非空', `main=${mainSrc.length}B config=${configSrc.length}B core=${fs.statSync(P_CORE).size}B`);
check(REMINDER_MODES.length === 3, '三态就是三态（REMINDER_MODES 长度 3）', `现值 ${REMINDER_MODES.length}：${REMINDER_MODES.join('/')}`);
check(OFF === 'off' && BUBBLE === 'bubble' && NOTIFY === 'notify', '模式字面量稳定（配置里存的就是这三个词）',
  `${OFF}/${BUBBLE}/${NOTIFY}`);

// ---- ②真值表：每种模式的显示行为 ----
const TRUTH = { off: [false, false], bubble: [true, false], notify: [true, true] };
const tableOk = REMINDER_MODES.every((m) => {
  const t = TRUTH[m];
  return !!t && showsBubble(m) === t[0] && showsToast(m) === t[1];
});
check(tableOk, '真值表：off=都不发／bubble=只气泡／notify=气泡+toast',
  REMINDER_MODES.map((m) => `${m}(气泡=${showsBubble(m)},toast=${showsToast(m)})`).join(' '));
check(showsToast(BUBBLE) === false, '「仅桌宠气泡」绝不发系统通知（把 bubble 算进 toast 必红这一条）',
  `showsToast('bubble')=${showsToast(BUBBLE)}`);
check(showsBubble(NOTIFY) === true, '「同时发 Windows 通知」仍要发气泡（改成只发 toast 必红这一条）',
  `showsBubble('notify')=${showsBubble(NOTIFY)}`);

// ---- ③互斥：任一模式下三项恒恰有一项勾选 ----
const excl = REMINDER_MODES.map((m) => REMINDER_MODES.filter((w) => checkedFor(m, w, DEFAULT_MODE)).length);
check(excl.every((n) => n === 1), '菜单三项互斥：每个模式下勾选数恒为 1', `逐模式勾选数=[${excl.join(',')}]`);
// 非法输入的正确行为：不猜、也不空着——一律落到调用方给的兜底那一项，菜单恒有一项勾着
// （「三项都不勾」看起来更安全，实际会让用户以为设置丢了，且点哪一项都无法解释当前态）。
check(checkedFor('xxx', OFF, DEFAULT_MODE) === false && checkedFor('xxx', NOTIFY, DEFAULT_MODE) === true
  && checkedFor(undefined, BUBBLE, DEFAULT_MODE) === false,
  '非法值不猜：落到兜底项（notify），既不乱勾也不空着', '');
const exclBad = ['xxx', undefined, null, 'off ', 'OFF', ''].map((v) => REMINDER_MODES.filter((w) => checkedFor(v, w, DEFAULT_MODE)).length);
check(exclBad.every((n) => n === 1), '脏数据下三项仍恰有一项勾（互斥不因输入非法而破）', `逐输入勾选数=[${exclBad.join(',')}]`);
check(normalize('nope', BUBBLE) === BUBBLE && normalize(NOTIFY, BUBBLE) === NOTIFY && isMode('off') === true && isMode('OFF') === false,
  'normalize/isMode：非法退回调用方兜底、大小写敏感（防 Off 这种拼法悄悄生效）', '');

// ---- ④迁移：旧两键 → 三态，且必须与旧代码显示行为逐组等价 ----
const LEGACY_CASES = [
  { enabled: true, notify: true, want: NOTIFY },
  { enabled: true, notify: false, want: BUBBLE },
  { enabled: false, notify: true, want: OFF }, // 无意义组合：旧代码 toast 嵌在 if(enabled) 里，实际什么都不发
  { enabled: false, notify: false, want: OFF },
];
const mig = LEGACY_CASES.map((c) => ({ ...c, got: fromLegacy(c.enabled, c.notify, DEFAULT_MODE) }));
check(mig.every((c) => c.got === c.want), '旧两键四组组合的迁移结果符合预期',
  mig.map((c) => `(${c.enabled},${c.notify})→${c.got}`).join(' '));
// 派生断言（只看输出形状拦不住口径替换）：迁移后的显示行为 ≡ 旧代码的显示行为
const equiv = LEGACY_CASES.map((c) => {
  const m = fromLegacy(c.enabled, c.notify, DEFAULT_MODE);
  const legacyBubble = !!c.enabled;
  const legacyToast = !!c.enabled && !!c.notify; // 旧代码：toast 嵌在 if (reminderEnabled) 里面
  return showsBubble(m) === legacyBubble && showsToast(m) === legacyToast;
});
check(equiv.every(Boolean), '迁移等价性：4 组旧输入下「气泡/toast」与旧代码逐组一致（迁移不许改变可见行为）',
  `一致 ${equiv.filter(Boolean).length}/4`);
check(fromLegacy(undefined, undefined, DEFAULT_MODE) === DEFAULT_MODE && DEFAULT_MODE === NOTIFY,
  '双缺席（全新安装）用调用方兜底，且默认仍是「气泡+通知」（沿用 1.0.53 起的默认）',
  `fallback=${fromLegacy(undefined, undefined, DEFAULT_MODE)} DEFAULT=${DEFAULT_MODE}`);
check(fromLegacy(undefined, undefined, BUBBLE) === BUBBLE, '兜底值由调用方决定（core 不自带第二份默认值）', '');

// ---- ⑤结构对齐：模式 → 菜单动作 id；旧键读取不残留 ----
// 只看代码行：跳过整行注释（`//` 与 `/*`、`*` JSDoc 续行）与行内 `//` 之后的部分。
// JSDoc 里出现旧键名是在声明 saved 的形状（2026-10-13 checkJs 要求才加的），把它算成"还在读旧键"
// 就是判据过宽——同一族错法在票 11-Z6 的 §97 里记过：扫描面口径必须与危险面一致。
function codeLines(src) {
  return src.split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '')); // 只剥「行首或空白后的 //」，避免把 'https://…' 这类字符串内的斜杠对当成注释起点
}
const mainCode = codeLines(mainSrc);
const configCode = codeLines(configSrc);
const actionMiss = REMINDER_MODES.filter((m) => !mainCode.some((l) => l.includes(`'reminder-${m}'`)));
check(actionMiss.length === 0, '每个模式都在 main.js 的 menuActions 里有对应动作登记',
  `缺 ${actionMiss.length}：${actionMiss.map((m) => `reminder-${m}`).join(',') || '无'}`);
const labelMiss = REMINDER_MODES.filter((m) => !mainCode.some((l) => l.includes(`[RM_${m.toUpperCase()}]`)));
check(labelMiss.length === 0, '每个模式在 main.js 的菜单文案表里都有标签（漏一项会渲染出 undefined）',
  `缺 ${labelMiss.length}：${labelMiss.join(',') || '无'}`);
const legacyRead = mainCode.filter((l) => /config\.get\(['"]reminder(Enabled|NotifyWindows)['"]\)/.test(l) || /config\.set\(['"]reminder(Enabled|NotifyWindows)['"]\)/.test(l));
check(legacyRead.length === 0, 'main.js 不再读/写旧两键（残留就是双真源，一条断言直接点名行）',
  `${legacyRead.length} 处 ${legacyRead.slice(0, 2).map((l) => l.trim().slice(0, 60)).join(' | ') || '无'}`);
// config.js 允许出现旧键名，但只能在迁移那一行且读的是 saved（不是 cache）——否则等于旧键还活着
const configLegacy = configCode.filter((l) => /reminderEnabled|reminderNotifyWindows/.test(l));
check(configLegacy.every((l) => /savedObj/.test(l)), 'config.js 里旧键只出现在读 saved 的迁移行（不重新进 DEFAULTS）',
  `${configLegacy.length} 行：${configLegacy.map((l) => l.trim().slice(0, 40)).join(' | ')}`);
check(!/^\s*reminderEnabled:|^\s*reminderNotifyWindows:/m.test(configCode.join('\n')),
  'DEFAULTS 里没有旧键（新键 reminderMode 才是唯一入口，铁律 2）', '');
check(/reminderMode:\s*DEFAULT_REMINDER_MODE/.test(configCode.join('\n')),
  'DEFAULTS 的 reminderMode 取 core 的常量而不是又写一遍字符串（防两份默认值漂移）', '');

console.log(`PASS ${checks - fails}/${checks}`);
process.exit(fails ? 1 : 0);
