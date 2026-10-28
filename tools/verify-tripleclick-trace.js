// @runtime: ci —— CI 强制层判据件（票 14-U 任务 A/C）：Ctrl+三击「为什么没成」的留痕；
//   执行面在 run-ci.js（清单从 ci.yml 动态解析），纯 node 零依赖、不起实例、不碰注册表。
//
// 缘起（真人层读数，装机 1.1.11）：约 30 次尝试只有 9 条「走过去: 点击」，**21 次丢弃在日志里
// 一行都不留**。三条候选出口（OS 连击计数不是 3 / Ctrl 掉一拍 / 点在桌宠身上）互斥性未知，
// 而今天 移动跳过=0 已排除冷却 ⇒ 没有留痕就只能编机理链。本票先修可观测性，不是先修手势。
//
// 三层牙齿（缺一层就是没牙的断言）：
//   ①行为级（红法 U-c 的前半）：真驱动 walk.js 的 createGestureTrace / createTripleClickDetector，
//     摘掉 walk.js 里的 opt.log(...) 或改坏限流 ⇒ 当场红；
//   ②vm 真跑产品代码（V 组）：main.js 的 onGlobalMouseDown 整块函数体进 vm、桩掉外作用域，断言的是
//     **真落进 logLine 的那几行**——§83/§63 的共性是判定层全绿而运行时路径炸了，字面接线审不出拼错变量名。
//     V7/V8 是复测轮新增的一正一反（四下带 Ctrl 全落桌宠 ⇒ 四行 in-window／三下不带 Ctrl ⇒ 零行）；
//     V3/V7/V8 的「宠身」点与 V9 的「窗口内透明处」点都从 core/geometry.js 的兜底盒真几何派生——
//     14-V 的病根是守卫拿 getBounds() 整窗判，兜底盒一旦退化成整窗，两组点就分不开、这条回归钉子恒绿；
//   ③接线级（红法 U-c 的后半）：按**分支体定界**读 main.js 的 onGlobalMouseDown，摘掉任一出口
//     的 drop/take/fired/clear 调用、丢掉 detail.ctrl 参数或把 log 接成空函数 ⇒ 当场红（票 14-C 场景 17 的教训：
//     真正长牙的是「体内必须含这次调用」，纯禁串会漏）。
//
// 断言表（每条标「什么改动会让它红」）：
//   R1 U-a 喂 clicks=[1,2,4]（跳过 3）⇒ 三下都不触发，且**恰好一行**留痕、指认成 not-os-3，
//      序列读数原样带出 clicks=[1,2,4]（红于：沉默、红于：归成别的分类、红于：把序列丢了）
//   R2 前两击不成行（过程不是失败尝试）⇒ 攒满三击前零行（红于：每下一击都刷一行＝30 次刷 90 行）
//   R3 U-b 喂 clicks=undefined ⇒ OS 计数不可用，自攒兜底必须真触发（lastPath='seq'）且零留痕行
//      （红于：兜底变成死代码——票面点名要证的「不是死代码」）
//   R4 成功路径 [1,2,3] ⇒ 触发的正是第三击、零留痕行（走过去那行已留痕，不重复记）
//   R5 冷却吃掉 ⇒ lastReason='ok-but-cooldown' 且**不补行**（「移动跳过」是它唯一的行，别弄坏）
//   R6 Ctrl 掉一拍 ⇒ drop(CTRL_DROP) 成行，且这一击自己带进账（ctrl=[1,1,0] 是这条候选的唯一证据）
//   R7 点在桌宠身上（复测轮修正）⇒ 带 Ctrl **无条件成行**（R10 单击即成行；R12 四下带 Ctrl ⇒ 恰四行、
//      每行带自己那一下的 OS 计数——这一串永远走不到 take()，逐击留痕是它唯一的可见方式）；
//      R11 反向断言：不带 Ctrl 的连续三下落在桌宠身上 ⇒ 仍然零行（防这条修正变成「只要 in-window 就刷日志」，
//      也防把「正常摸头刷屏」放回来）。修之前的盲区＝真人定向组实测「4 下点宠身 ⇒ 三击未成 0 行」，
//      因为 in-window 分支在 push() 之前就 reset，串永远凑不到旧门槛要求的 2 击。
//   R8 枚举真源唯一：件内钉死的 token 表 == walk.MISS_REASONS 逐项（红于：加/改/删一个原因名）
//   R9 功能关着（walkByTripleClick=false）⇒ clear 不记账，之后的 ctrl 掉拍也不成行（红于：关着还刷行）
//   T1 限流红线：30 次独立尝试 ×3 击（每次都不成）⇒ 行数恰为 30，**不是 90**（票面明令；
//      唯一的例外是上面 R7/R12 那条 per-click 留痕——它不属于「一次手势一行」这一族，理由在 walk.js 注释里）
//   T2 连点尾巴不重复记账：成功触发后冷却窗内的 clicks=4/5/6 三下 ⇒ 零行（红于：把已经走过的
//      一次手势的尾巴又判成一次新的失败尝试）
//   T3 pending 不泄漏：任何一条出口之后 pending 归零（红于：上一串的点击混进下一串，序列读数失真）
//   W1..W5 main.js 五个出口按分支体定界接线（in-window / config-off / ctrl / push-fail / fired 早于落位）
//   W8 票 14-V 的接线钉子：in-window 守卫必须取互动盒的判定（`const inWindow = inBox`），
//     且 onGlobalMouseDown 体内不得再用窗口矩形算「点在桌宠上」（红于：改回 `dip.x >= b.x && …`）
//   V9 窗口内透明处 Ctrl+三击 ⇒ 必须走过去且零 in-window 行（红于：守卫改回整窗矩形——真人那侧
//     就是「约 30 次只有 9 次成功」的形态：透明区点击被整串作废，日志里只有 in-window 行）
//   W6 gestureTrace 构造点必须把 log 接到 logLine（红于：接成空函数＝留痕静默失效，正是本票要消灭的形态）
//   W7 原因名走真源：onGlobalMouseDown 体内不得出现裸字面量 'in-window'/'ctrl-drop'/'not-os-3'
//   G1..G3 边界拍照（票面禁令的机器化）：`clicks === 3` 的「恰好 3」不许写成 >=3；
//      DEFAULTS 的 intervalMs/distancePx/cooldownMs 三值不许被「顺手调阈值」改动；
//      自攒兜底仍然只在 !osAvailable 时才跑（A′ 未拍板前不得改成两路并行——六连点会算成两次三击）
//
// ★ 能力边界（打在输出第一行，别把本件读成「所有丢弃都有行」）：用户只点两下就停手、或钩子根本没
//   送到第三击 ⇒ 没有事件就没有结清点，本票**有意不加定时器**去猜（加了会把实测 700ms 间隔也认的
//   慢三击谎报成未成）。真人复测数法因此是「未成行数 ≤ 尝试次数」，缺的那部分正是这条边界。
//
// 用法：node tools/verify-tripleclick-trace.js [仓库根，默认 cwd；突变副本一律传**绝对路径**]
// 退出码：0 全绿 / 1 断言失败（脚本自身异常也落 1，stderr 打「脚本异常：<原因>」）/
//         3 前置不满足（walk.js 或 main.js 读不到、被提取的函数/分支/导出项不存在＝改名或删除，
//         断言不许静默跳过）。判定面 0/1/3，无装置面 2（铁律 3）。
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || process.cwd());
const blocked = (msg) => {
  console.error(`前置不满足（exit 3）：${msg}`);
  process.exit(3);
};

const walkPath = path.join(root, 'walk.js');
const mainPath = path.join(root, 'main.js');
if (!fs.existsSync(walkPath)) blocked(`${walkPath} 不存在——读不到源码不许打绿灯`);
if (!fs.existsSync(mainPath)) blocked(`${mainPath} 不存在`);

// 按**影子根绝对路径** require：突变副本里的 walk.js 必须真被加载（§96 装置仓≠被测仓同族坑）
let walk;
try {
  walk = require(walkPath);
} catch (e) {
  blocked(`walk.js 取不到（${e.message}）——本件的行为层断言没有真源`);
}
for (const name of ['createGestureTrace', 'createTripleClickDetector', 'MISS_REASONS', 'DEFAULTS']) {
  if (walk[name] === undefined) blocked(`walk.js 未导出 ${name}——改名/删除时断言不许静默跳过`);
}

// 命中区真源：与产品同一份（core/geometry.js 的兜底盒＝视觉矩形 300×300 右下角锚定）。
// 本件不测命中区精度（那归 verify-hit-region），但必须用真几何——14-V 之所以能长期藏着，
// 就是因为判据侧也拿「整个窗口」当「桌宠身上」，点哪都算命中，分不出透明区。
let geo;
try {
  geo = require(path.join(root, 'core', 'geometry.js'));
} catch (e) {
  blocked(`core/geometry.js 取不到（${e.message}）——没有命中区真源，V 组分不开「宠身」与「窗口内透明处」`);
}
if (typeof geo.petFallbackBox !== 'function') blocked('core/geometry.js 未导出 petFallbackBox()——改名时断言不许静默跳过');

// 三处被测点：窗口原点 1000,1000（尺寸取本机实读 605，与真机 §105 口径同）。
// PET_BOX 是 scale=1 时窗口内的视觉矩形（x/y=300、300×300，右下角锚定）⇒ 窗口 75% 不在盒内。
const BOUNDS = { x: 1000, y: 1000, width: 605, height: 605 };
const PET_BOX = geo.petFallbackBox(1);
const ONPET = { x: BOUNDS.x + PET_BOX.x + PET_BOX.width / 2, y: BOUNDS.y + PET_BOX.y + PET_BOX.height / 2 };
const DEADZONE = { x: BOUNDS.x + 20, y: BOUNDS.y + 20 }; // 窗口左上角透明区：14-V 的现场

const src = fs.readFileSync(mainPath, 'utf8').replace(/\r/g, '');

// 件内拍照（第三锚点：与 walk.js/main.js 同源比对照样会恒绿，只有独立拍照能红）
const PINNED = {
  REASONS: {
    NOT_OS_3: 'not-os-3',
    SEQ_BROKEN: 'seq-broken',
    SEQ_INCOMPLETE: 'seq-incomplete',
    COOLDOWN: 'ok-but-cooldown',
    CTRL_DROP: 'ctrl-drop',
    IN_WINDOW: 'in-window',
  },
  THRESHOLDS: { intervalMs: 500, distancePx: 8, cooldownMs: 400 }, // 票面：没读数之前调阈值就是猜
  LINE_HEAD: '三击未成',
};

const isCommentLine = (t) => /^\s*\/\//.test(t) || /^\s*\*/.test(t) || /^\s*\/\*/.test(t);
const codeOf = (text) => text.split('\n').filter((t) => !isCommentLine(t)).join('\n');

// 括号配平提取（verify-toast-aumid-order / verify-ctrl-reconcile 同款手法）。
// 一律**按传入的那份文本 + 该文本内的偏移**取：早先版本把切片内的偏移交给全局 src 用，
// 结果提取到错的区域（首跑 8 条 W 组假红就是这么来的）。
function extractFrom(text, idx) {
  if (idx < 0) return null;
  const open = text.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return text.slice(idx, k + 1);
  }
  return null;
}
const fnRange = (text, name) => {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) return { body: null, start: -1, end: -1 };
  const body = extractFrom(text, start);
  return { body, start, end: start + (body ? body.length : 0) };
};

const onDownRange = fnRange(src, 'onGlobalMouseDown');
if (!onDownRange.body) blocked('onGlobalMouseDown 提取失败——函数被改名/删除时接线断言不许空集恒绿');
const onDown = onDownRange.body;
// 五个出口按**分支体**定界（全局 includes 必绿，票 14-C/11-N 的教训）；偏移一律相对整份 src。
// 条件是 `if (!tripleClick.push({...}))` 这种**内嵌花括号**的分支，直接找「下一个 {」会取到
// 参数对象字面量（首跑 W3 两条假红就是这么来的）——先把 if 条件的圆括号配平，再取语句块。
function blockFromCondition(text, idx) {
  const openParen = text.indexOf('(', idx);
  if (openParen < 0) return null;
  let depth = 0;
  let k = openParen;
  for (; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) break;
  }
  const brace = text.indexOf('{', k);
  const body = brace < 0 ? null : extractFrom(text, brace);
  return body === null ? null : { body, start: brace, end: brace + body.length };
}
const branches = {};
const branchRanges = {};
for (const [key, needle] of [
  ['inWindow', 'if (inWindow) {'],
  ['configOff', "if (!config.get('walkByTripleClick')) {"],
  ['ctrl', 'if (!detail.ctrl) {'],
  ['pushFail', 'if (!tripleClick.push('],
]) {
  const abs = src.indexOf(needle, onDownRange.start);
  if (abs < 0 || abs >= onDownRange.end) blocked(`onGlobalMouseDown 体内找不到分支锚「${needle}」（分支被改名/改写＝接线断言失去被测对象）`);
  const got = blockFromCondition(src, abs);
  if (!got) blocked(`分支「${needle}」体提取失败（括号没配平）`);
  branches[key] = got.body;
  branchRanges[key] = got;
}
// push 成事之后的收尾：从 push-fail 分支结束处取到 onGlobalMouseDown 体内末尾
const afterPush = src.slice(branchRanges.pushFail.end, onDownRange.end);

let pass = 0;
let failCount = 0;
const assert = (cond, label, detail) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 真驱动一条手势：note 与 push 的先后与 main.js 完全一致（先记账再判定），
// 返回值形如 { fired, reason, lines } —— lines 是这一串留下的行
function driveGesture(det, tr, seq, t0 = 1000, stepMs = 120) {
  let fired = false;
  let reason = '';
  seq.forEach((clicks, i) => {
    const now = t0 + i * stepMs;
    const ctrl = typeof clicks.ctrl === 'number' ? clicks.ctrl : 1;
    if (ctrl === 0) {
      tr.note(clicks.v, 0);
      tr.drop(PINNED.REASONS.CTRL_DROP);
      reason = PINNED.REASONS.CTRL_DROP;
      return;
    }
    tr.note(clicks.v, 1);
    fired = det.push({ x: 800, y: 800, clicks: clicks.v }, now);
    if (fired) {
      tr.fired(now);
      reason = '';
    } else {
      reason = det.lastReason;
      tr.take(reason);
    }
  });
  return { fired, reason };
}
const mk = () => {
  const lines = [];
  return {
    det: walk.createTripleClickDetector(),
    tr: walk.createGestureTrace({ log: (s) => lines.push(String(s)) }),
    lines,
  };
};
// 序列既可写成裸数字（默认 ctrl 按住），也可写成 { v, ctrl }
const seqOf = (arr) => arr.map((v) => (typeof v === 'number' || v === undefined ? { v } : v));

try {
  console.log(`仓库根：${root}`);
  console.log('★ 能力边界：本件判不了「真实鼠标点击有没有到钩子」，只判代码层的归因与留痕；');
  console.log('  「只点两下就停手」这类丢弃有意不留行（加定时器会把实测 700ms 间隔也认的慢三击谎报成未成）。');

  // ---- R1 U-a：跳过 3 的三连击必须指认成 not-os-3 ----
  console.log('R1 U-a · 喂 clicks=[1,2,4] ⇒ 不触发且指认 not-os-3');
  {
    const { det, tr, lines } = mk();
    const { fired } = driveGesture(det, tr, seqOf([1, 2, 4]));
    assert(fired === false, '三击不触发（没有一下等于 3）', `fired=${fired}`);
    assert(det.lastReason === PINNED.REASONS.NOT_OS_3, '检测器归因 == not-os-3', `lastReason=${det.lastReason}`);
    assert(lines.length === 1, '整串只留一行（不沉默、也不刷三行）', `行数=${lines.length}｜${lines.join(' ⏎ ')}`);
    assert(lines.length === 1 && lines[0].includes(`(${PINNED.REASONS.NOT_OS_3})`), '留痕里的原因就是 not-os-3（不是别的分类）', lines[0] || '');
    assert(lines.length === 1 && lines[0].includes('clicks=[1,2,4]'), '序列读数原样带出三下的 clicks 值',
      lines.length ? (lines[0].match(/clicks=\[[^\]]*\]/) || [''])[0] : '');
    assert(lines.length === 1 && lines[0].includes('ctrl=[1,1,1]'), '同时带出每击的 ctrl 判定',
      lines.length ? (lines[0].match(/ctrl=\[[^\]]*\]/) || [''])[0] : '');
    assert(lines.length === 1 && lines[0].startsWith(PINNED.LINE_HEAD), `行首 == 「${PINNED.LINE_HEAD}」`, '');
  }

  // ---- R2 前两击不成行 ----
  console.log('R2 · 攒满三击之前不成行（限流第一道）');
  {
    const { det, tr, lines } = mk();
    det.push({ x: 800, y: 800, clicks: 1 }, 1000);
    tr.note(1, 1, 1000);
    tr.take(det.lastReason);
    det.push({ x: 800, y: 800, clicks: 2 }, 1120);
    tr.note(2, 1, 1120);
    tr.take(det.lastReason);
    assert(lines.length === 0, '第 1、2 击各归因 not-os-3 但不成行', `行数=${lines.length}`);
    assert(tr.pending === 2, '两击都还在账上（pending=2），第三击才能带出完整序列', `pending=${tr.pending}`);
  }

  // ---- R3 U-b：OS 计数不可用时自攒兜底必须真触发 ----
  console.log('R3 U-b · 喂 clicks=undefined ⇒ 自攒兜底必须能触发（证明不是死代码）');
  {
    const { det, tr, lines } = mk();
    const { fired } = driveGesture(det, tr, seqOf([undefined, undefined, undefined]));
    assert(fired === true, '兜底路径真触发（第三击返回 true）', `fired=${fired}`);
    assert(det.lastPath === 'seq', '触发来源记 seq（自攒，不是 os）', `lastPath=${det.lastPath}`);
    assert(lines.length === 0, '成功触发不留「未成」行', `行数=${lines.length}`);
    const d2 = walk.createTripleClickDetector();
    const slow = [undefined, undefined, undefined].map((c, i) => d2.push({ x: 800, y: 800, clicks: c }, 5000 + i * 700));
    assert(eq(slow, [false, false, false]) && d2.lastReason === PINNED.REASONS.SEQ_BROKEN,
      '兜底真的在数间隔：同三下改成 700ms 间隔（>intervalMs 500）就不触发并指认 seq-broken',
      JSON.stringify(slow));
  }

  // ---- R4 成功路径零行 ----
  console.log('R4 · 成功路径 [1,2,3] ⇒ 只触发一次且零留痕行');
  {
    const { det, tr, lines } = mk();
    const { fired } = driveGesture(det, tr, seqOf([1, 2, 3]));
    assert(fired === true && det.lastPath === 'os', '第三击触发且来源 os', `fired=${fired} lastPath=${det.lastPath}`);
    assert(lines.length === 0, '零「未成」行（走过去那一行已留痕，不重复记）', `行数=${lines.length}`);
    assert(tr.pending === 0, '成功后结清', `pending=${tr.pending}`);
  }

  // ---- R5 冷却不补行 ----
  console.log('R5 · 冷却吃掉 ⇒ 不补行（「移动跳过」是它唯一的那一行）');
  {
    const { det, tr, lines } = mk();
    driveGesture(det, tr, seqOf([1, 2, 3]));
    const second = driveGesture(det, tr, seqOf([1, 2, 3]), 1200, 60); // 距上次触发仅 ~120ms < 400ms
    assert(second.fired === false, '第二次手势被冷却吃掉', `fired=${second.fired}`);
    assert(det.lastReason === PINNED.REASONS.COOLDOWN, '归因 == ok-but-cooldown', `lastReason=${det.lastReason}`);
    assert(det.lastSuppressed === true && det.lastGapMs > 0, 'lastSuppressed/lastGapMs 语义没被弄坏（现有「移动跳过」的判据）',
      `suppressed=${det.lastSuppressed} gap=${det.lastGapMs}`);
    assert(lines.length === 0, '冷却不补「未成」行（否则一次手势两行）', `行数=${lines.length}`);
  }

  // ---- R6 Ctrl 掉一拍 ----
  console.log('R6 · Ctrl 掉一拍 ⇒ 这一击自己带进账（ctrl=[1,1,0]）');
  {
    const { det, tr, lines } = mk();
    driveGesture(det, tr, seqOf([1, 2, { v: 3, ctrl: 0 }]));
    assert(lines.length === 1, '整串留一行', `行数=${lines.length}｜${lines.join(' ⏎ ')}`);
    assert(lines.length === 1 && lines[0].includes(`(${PINNED.REASONS.CTRL_DROP})`), '原因指认 ctrl-drop', lines[0] || '');
    assert(lines.length === 1 && lines[0].includes('clicks=[1,2,3]') && lines[0].includes('ctrl=[1,1,0]'),
      '掉拍那一下的 clicks 与 ctrl=0 都在读数里（票面点名的候选唯一证据）', lines[0] || '');
    assert(det.lastReason === PINNED.REASONS.NOT_OS_3,
      '掉拍那击根本没进 push（lastReason 还停在上一击的 not-os-3＝这一击没被检测器看过）', `lastReason=${det.lastReason}`);
  }

  // ---- R7 点在桌宠身上：带 Ctrl 无条件成行，不带 Ctrl 一律静默（票 14-U 复测轮修正）----
  console.log('R7 · 点中宠身（互动盒）⇒ 带 Ctrl 成行（每击一行）；不带 Ctrl 零行（防噪初衷不变）');
  {
    const { tr, lines } = mk();
    tr.note(1, 1, 1000);
    tr.note(2, 1, 1100);
    tr.drop(PINNED.REASONS.IN_WINDOW, true);
    assert(lines.length === 1 && lines[0].includes(`(${PINNED.REASONS.IN_WINDOW})`), '有在途串 ⇒ 一行 in-window',
      `${lines.length} 行｜${lines[0] || ''}`);
    const t2 = mk();
    t2.tr.drop(PINNED.REASONS.IN_WINDOW, false);
    assert(t2.lines.length === 0, '对照：空串 + **不带 Ctrl** ⇒ 零行（正常摸头/连点桌宠不刷日志）', `行数=${t2.lines.length}`);
    const t3 = mk();
    t3.tr.note(1, 1, 1000);
    t3.tr.drop(PINNED.REASONS.IN_WINDOW, true);
    assert(t3.lines.length === 1 && t3.lines[0].includes(`(${PINNED.REASONS.IN_WINDOW})`),
      'R10 单击带 Ctrl ⇒ 无条件成行（复测轮的盲区：这一类以前一行都不留，串永远凑不到 2）',
      `行数=${t3.lines.length}｜${t3.lines[0] || ''}`);
    const t4 = mk();
    [1, 2, 3, 4].forEach((c) => {
      t4.tr.note(c, 1, 1000);
      t4.tr.drop(PINNED.REASONS.IN_WINDOW, true);
    });
    const seqRead = t4.lines.map((l) => (l.match(/clicks=\[([\d,]+)\]/) || [, ''])[1]).join('|');
    assert(t4.lines.length === 4 && seqRead === '1|2|3|4',
      'R12 四下带 Ctrl 全落宠身 ⇒ 恰四行、每行带自己那一下的 clicks 读数（**每击一行是有意声明的口径**：' +
      '这一串永远走不到 take()，逐击留痕是它唯一的可见方式）',
      `行数=${t4.lines.length}｜序列=${seqRead}`);
    const t5 = mk();
    [1, 2, 3].forEach(() => t5.tr.drop(PINNED.REASONS.IN_WINDOW, false)); // 不带 Ctrl 时 main.js 侧不记账
    assert(t5.lines.length === 0, 'R11 反向断言：不带 Ctrl 的连续三下落在桌宠身上 ⇒ 仍然零行（防把噪声放回来）',
      `行数=${t5.lines.length}`);
  }

  // ---- R8 枚举真源 ----
  console.log('R8 · 原因枚举真源唯一（件内拍照 ↔ walk.MISS_REASONS）');
  assert(eq(Object.keys(walk.MISS_REASONS).map((k) => `${k}=${walk.MISS_REASONS[k]}`).sort(),
    Object.keys(PINNED.REASONS).map((k) => `${k}=${PINNED.REASONS[k]}`).sort()),
    'MISS_REASONS 逐项 == 件内钉死表（加/改/删一名都红，逼回来同步本件与台账）',
    Object.values(walk.MISS_REASONS).join(','));
  {
    const { det, tr } = mk();
    // 位移超限（自攒路径的 seq-broken）与「还没攒够」（seq-incomplete）两条也要真能指认
    det.push({ x: 100, y: 100, clicks: undefined }, 1000);
    tr.note(undefined, 1, 1000);
    det.push({ x: 900, y: 900, clicks: undefined }, 1100);
    tr.note(undefined, 1, 1100);
    assert(det.lastReason === PINNED.REASONS.SEQ_BROKEN, '位移超限归因 seq-broken', `lastReason=${det.lastReason}`);
    // 实测：初值 lastAt=0 ⇒ **第一击**的 now-lastAt 恒 >intervalMs，归因是 seq-broken（不是 seq-incomplete）；
    // 「串还在攒」这个状态只在第二击起才可能出现。留痕只在满三击时成行，所以这个措辞不影响日志，
    // 但判据必须按实测钉住，别让它成为「将来有人以为第一击该报 incomplete」的空想断言。
    const d3 = walk.createTripleClickDetector();
    d3.push({ x: 300, y: 300, clicks: undefined }, 1000);
    assert(d3.lastReason === PINNED.REASONS.SEQ_BROKEN, '第一击（lastAt 初值 0，间隔判超限）归因 seq-broken',
      `lastReason=${d3.lastReason}`);
    d3.push({ x: 300, y: 300, clicks: undefined }, 1100); // 间隔 100ms 且同点：串没断，还没攒够
    assert(d3.lastReason === PINNED.REASONS.SEQ_INCOMPLETE, '第二击（串没断、还没攒够）归因 seq-incomplete',
      `lastReason=${d3.lastReason}`);
  }

  // ---- R9 功能关着不留痕 ----
  console.log('R9 · walkByTripleClick=false ⇒ 只清账，不留痕');
  {
    assert(/gestureTrace\.clear\(\)/.test(codeOf(branches.configOff)),
      'configOff 分支体内调 gestureTrace.clear()（关着还每击都记账＝每一下都攒一串）', '');
    const { tr, lines } = mk();
    tr.clear();
    tr.note(1, 0, 1000);
    tr.drop(PINNED.REASONS.CTRL_DROP);
    assert(lines.length === 0, 'clear 之后单击掉拍不成行（pending 门槛 ≥2）', `行数=${lines.length}`);
  }

  // ---- T1 限流红线 ----
  console.log('T1 · 30 次尝试 ⇒ 最多 30 行，不是 90 行（票面明令的限流口径）');
  {
    const { det, tr, lines } = mk();
    for (let i = 0; i < 30; i++) {
      driveGesture(det, tr, seqOf([1, 2, 4]), 5000 + i * 10000, 120); // 每次尝试间隔 10s（避开冷却）
    }
    assert(lines.length === 30, '30 次失败尝试恰 30 行', `行数=${lines.length}`);
    const allOk = lines.every((l) => l.includes(`(${PINNED.REASONS.NOT_OS_3})`) && l.includes('clicks=[1,2,4]'));
    assert(allOk, '每行都指认 not-os-3 并带完整三击读数', '');
  }

  // ---- T2 连点尾巴不重复记账 ----
  console.log('T2 · 成功后的连点尾巴（clicks=4/5/6）不再算一次新失败');
  {
    const { det, tr, lines } = mk();
    driveGesture(det, tr, seqOf([1, 2, 3])); // 六连点的前三下已经成事（firedAt=1240）
    const inWindow = [4, 5].map((c, i) => det.push({ x: 800, y: 800, clicks: c }, 1400 + i * 100));
    [4, 5].forEach((c, i) => tr.note(c, 1, 1400 + i * 100));
    [4, 5].forEach(() => tr.take(det.lastReason));
    assert(eq(inWindow, [false, false]) && tr.pending === 0,
      '冷却窗（400ms）内的尾巴既不触发也不记账', `inWindow=${JSON.stringify(inWindow)} pending=${tr.pending}`);
    // 出了冷却窗的第 6 下算**新的一次尝试**的第一击：记账但不成行（满三击才成行）
    det.push({ x: 800, y: 800, clicks: 6 }, 1700);
    tr.note(6, 1, 1700);
    tr.take(det.lastReason);
    assert(tr.pending === 1 && lines.length === 0,
      '过窗那一下重新开始记账、仍零行（红于：把一次手势的尾巴判成一次新的失败尝试）',
      `pending=${tr.pending} 行数=${lines.length}`);
  }

  // ---- T3 pending 不泄漏 ----
  console.log('T3 · 每条出口之后 pending 该归零（唯一例外：不足三击要留着账）');
  {
    const cases = [
      ['take 满三击', (t) => { t.note(1, 1, 1000); t.note(2, 1, 1100); t.note(4, 1, 1200); t.take(PINNED.REASONS.NOT_OS_3); }, 0],
      ['take 冷却', (t) => { t.note(1, 1, 1000); t.take(PINNED.REASONS.COOLDOWN); }, 0],
      ['drop 成行', (t) => { t.note(1, 1, 1000); t.note(2, 1, 1100); t.drop(PINNED.REASONS.IN_WINDOW); }, 0],
      ['drop 单击不足门槛', (t) => { t.note(1, 1, 1000); t.drop(PINNED.REASONS.CTRL_DROP); }, 0],
      ['fired', (t) => { t.note(1, 1, 1000); t.note(2, 1, 1100); t.fired(1200); }, 0],
      ['clear', (t) => { t.note(1, 1, 1000); t.clear(); }, 0],
    ];
    for (const [name, run, want] of cases) {
      const { tr } = mk();
      run(tr);
      assert(tr.pending === want, `T3 ${name} 后 pending=${want}`, `实际 ${tr.pending}`);
    }
    const keep = mk();
    keep.tr.note(1, 1, 1000);
    keep.tr.take(PINNED.REASONS.NOT_OS_3);
    assert(keep.tr.pending === 1 && keep.lines.length === 0,
      '「不足三击」必须留着账且不成行（否则序列读数少几击）', `pending=${keep.tr.pending} 行数=${keep.lines.length}`);
  }

  // ---- V 组：把 main.js 的 onGlobalMouseDown 放进 vm 真跑（W 组只审字面，审不出拼错变量名）----
  // §83/§63 那两轮的共性是「判定层全绿而运行时路径根本炸了」。本组用真函数 + 桩外作用域，
  // 让合成点击真走一遍产品代码，断言的是**真落进 logLine 的那几行**。
  console.log('V · vm 真跑 main.js 的 onGlobalMouseDown（真函数 + 桩外作用域）');
  const vm = require('vm');
  function buildSandbox({ bounds = BOUNDS, walkEnabled = true, boxes = [PET_BOX] } = {}) {
    const logs = [];
    const walks = [];
    const bumps = [];
    const det = walk.createTripleClickDetector();
    const tr = walk.createGestureTrace({ log: (s) => logs.push(String(s)) });
    const sandbox = {
      screen: { screenToDipPoint: (p) => ({ x: p.x, y: p.y }) },
      config: { get: () => walkEnabled },
      petWindow: { isDestroyed: () => false, getBounds: () => bounds },
      petBoxInUse: () => boxes, // 真几何（14-V 前这里是 []，于是「窗口内」被当成「宠身」）
      notePetInteraction: () => {},
      petPressing: false,
      bumpMouse: (which) => bumps.push(which),
      walk,
      tripleClick: det,
      gestureTrace: tr,
      logLine: (s) => logs.push(String(s)),
      walkPetTo: (p) => walks.push(p),
    };
    vm.createContext(sandbox);
    vm.runInContext(onDown, sandbox, { filename: 'main.js[vm]' });
    return {
      logs,
      walks,
      bumps,
      det,
      tr,
      click: (which, detail) => sandbox.onGlobalMouseDown(which, detail),
    };
  }
  const OFF = { x: 500, y: 500 }; // 窗口外（bounds 1000..1605）
  {
    const s = buildSandbox();
    s.click('left', { ...OFF, clicks: 1, ctrl: true });
    s.click('left', { ...OFF, clicks: 2, ctrl: true });
    s.click('left', { ...OFF, clicks: 4, ctrl: true });
    assert(s.bumps.length === 3, '正向对照：真跑到了函数头（bumpMouse 计数＝不是提取到空函数）', `bumps=${s.bumps.length}`);
    assert(s.walks.length === 0, 'V1 没触发走过去', `walks=${s.walks.length}`);
    const traceLines = s.logs.filter((l) => l.startsWith(PINNED.LINE_HEAD));
    assert(traceLines.length === 1 && traceLines[0].includes(`(${PINNED.REASONS.NOT_OS_3})`) && traceLines[0].includes('clicks=[1,2,4]'),
      'V1 真走产品代码 ⇒ 恰好一行 not-os-3 且带完整序列读数（U-c 摘掉 take() 时这里与 W3 同时红）',
      `${traceLines.length} 行｜${traceLines.join(' ⏎ ') || '零行（＝留痕静默失效的形态）'}`);
  }
  {
    const s = buildSandbox();
    s.click('left', { ...OFF, clicks: 1, ctrl: true });
    s.click('left', { ...OFF, clicks: 2, ctrl: true });
    s.click('left', { ...OFF, clicks: 3, ctrl: false });
    assert(s.walks.length === 0 && s.det.lastReason === PINNED.REASONS.NOT_OS_3,
      'V2 ctrl=false 那击没进 push（走的是 push 之前的出口）', `walks=${s.walks.length}`);
    const ctrlLines = s.logs.filter((l) => l.includes(`(${PINNED.REASONS.CTRL_DROP})`));
    assert(ctrlLines.length === 1 && ctrlLines[0].includes('ctrl=[1,1,0]'),
      'V2 真跑 ⇒ 一行 ctrl-drop 且掉拍位读成 0（这条候选第一次变成可指认的读数）',
      `${ctrlLines.length} 行｜${ctrlLines[0] || '零行'}`);
  }
  {
    const s = buildSandbox();
    s.click('left', { ...OFF, clicks: 1, ctrl: true });
    s.click('left', { ...OFF, clicks: 2, ctrl: true });
    s.click('left', { ...ONPET, clicks: 3, ctrl: true });
    const wLines = s.logs.filter((l) => l.includes(`(${PINNED.REASONS.IN_WINDOW})`));
    assert(wLines.length === 1 && s.walks.length === 0, 'V3 第三击落在桌宠身上（互动盒内）⇒ 一行 in-window 且不走过去',
      `${wLines.length} 行｜${wLines[0] || '零行'}`);
    const s2 = buildSandbox();
    s2.click('left', { ...ONPET, clicks: 1, ctrl: false });
    s2.click('left', { ...ONPET, clicks: 2, ctrl: false });
    assert(s2.logs.filter((l) => l.startsWith(PINNED.LINE_HEAD)).length === 0,
      'V3 对照：不带 Ctrl 的桌宠点击（正常摸头）⇒ 零行，不刷日志',
      `${s2.logs.length} 行｜${s2.logs.join(' ⏎ ') || '零行'}`);
  }
  {
    // V7＝真人定向组的机器化（复测轮修正的落点）：四下 Ctrl+左键全落在桌宠身上。
    // 修之前这一类是「三击未成 0 行、in-window 0 行」——日志里唯一看得见的只有渲染端那条点击到达探针。
    const s = buildSandbox();
    [1, 2, 3, 4].forEach((c) => s.click('left', { ...ONPET, clicks: c, ctrl: true }));
    const wLines = s.logs.filter((l) => l.includes(`(${PINNED.REASONS.IN_WINDOW})`));
    const seqRead = wLines.map((l) => (l.match(/clicks=\[([\d,]+)\]/) || [, ''])[1]).join('|');
    assert(s.walks.length === 0, 'V7 前置：四下点桌宠确实一次都没走过去（这是设计，不是 bug）', `walks=${s.walks.length}`);
    assert(wLines.length === 4 && seqRead === '1|2|3|4',
      'V7 真跑 ⇒ 四下带 Ctrl 全落桌宠 ⇒ 四行 in-window，每行带自己那一下的 OS 计数（修之前是 0 行）',
      `行数=${wLines.length}｜序列=${seqRead}`);
    assert(wLines.every((l) => l.includes('ctrl=[1]')), 'V7 每行的 Ctrl 位读成 1（意图证据在行里，不靠事后猜）',
      wLines[0] || '');
    // V8＝反向：不带 Ctrl 的连续三下落在桌宠身上（正常摸头）⇒ 必须零行——防这条修正变成「只要 in-window 就刷日志」
    const s2 = buildSandbox();
    [1, 2, 3].forEach((c) => s2.click('left', { ...ONPET, clicks: c, ctrl: false }));
    assert(s2.logs.filter((l) => l.startsWith(PINNED.LINE_HEAD)).length === 0 && s2.walks.length === 0,
      'V8 反向断言：不带 Ctrl 的三下落在桌宠身上 ⇒ 零行零走过去（噪声没被放回来）',
      `行数=${s2.logs.length}｜walks=${s2.walks.length}`);
  }
  {
    // V9＝票 14-V 的回归钉子：窗口内的透明处不是宠身。旧守卫拿 getBounds() 的 600×600 整窗判
    // 「点在桌宠上」，而默认 scale=1 时形象只占右下 300×300（窗口 75% 透明）⇒ 桌面上看似离宠很远
    // 的一串 Ctrl+三击会被整串作废、只留 in-window 行。真人那侧读成「约 30 次只成功 9 次」。
    const inWindowRect =
      DEADZONE.x >= BOUNDS.x && DEADZONE.x <= BOUNDS.x + BOUNDS.width &&
      DEADZONE.y >= BOUNDS.y && DEADZONE.y <= BOUNDS.y + BOUNDS.height;
    assert(inWindowRect, 'V9 前置：被测点在窗口矩形内（否则钉不住旧判据）',
      `点 ${DEADZONE.x},${DEADZONE.y}｜窗 ${BOUNDS.x},${BOUNDS.y} ${BOUNDS.width}×${BOUNDS.height}`);
    const s = buildSandbox();
    [1, 2, 3].forEach((c) => s.click('left', { ...DEADZONE, clicks: c, ctrl: true }));
    const wLines = s.logs.filter((l) => l.includes(`(${PINNED.REASONS.IN_WINDOW})`));
    assert(s.walks.length === 1, 'V9 窗口内透明处 Ctrl+三击 ⇒ 必须走过去（旧实现这里 0 次）', `walks=${s.walks.length}`);
    assert(wLines.length === 0, 'V9 且零 in-window 行（透明区没被当成宠身）', `${wLines.length} 行｜${wLines[0] || ''}`);
  }
  {
    const s = buildSandbox();
    s.click('left', { ...OFF, clicks: 1, ctrl: true });
    s.click('left', { ...OFF, clicks: 2, ctrl: true });
    s.click('left', { ...OFF, clicks: 3, ctrl: true });
    assert(s.walks.length === 1, 'V4 成功路径真调 walkPetTo 一次', `walks=${s.walks.length}`);
    assert(s.logs.filter((l) => l.startsWith(PINNED.LINE_HEAD)).length === 0, 'V4 成功不留「未成」行', '');
    // 紧接着的同一次连击尾巴（OS 计数累加到 4/5/6）
    s.click('left', { ...OFF, clicks: 4, ctrl: true });
    s.click('left', { ...OFF, clicks: 5, ctrl: true });
    s.click('left', { ...OFF, clicks: 6, ctrl: true });
    assert(s.logs.filter((l) => l.startsWith(PINNED.LINE_HEAD)).length === 0,
      'V4 连点六下：只在第三下成事，尾巴既不重复触发也不补「未成」行', `${s.walks.length} 次走过去`);
  }
  {
    const s = buildSandbox();
    s.click('left', { ...OFF, clicks: 1, ctrl: true });
    s.click('left', { ...OFF, clicks: 2, ctrl: true });
    s.click('left', { ...OFF, clicks: 3, ctrl: true });
    s.click('left', { x: 501, y: 501, clicks: 1, ctrl: true });
    s.click('left', { x: 501, y: 501, clicks: 2, ctrl: true });
    s.click('left', { x: 501, y: 501, clicks: 3, ctrl: true });
    const skip = s.logs.filter((l) => l.includes('移动跳过'));
    const trace = s.logs.filter((l) => l.startsWith(PINNED.LINE_HEAD));
    assert(skip.length === 1, 'V5 冷却仍由现有「移动跳过」那一行承担（没被弄坏）', `${skip.length} 行｜${skip[0] || ''}`);
    assert(trace.length === 0, 'V5 冷却不补「未成」行（一次手势两行＝限流没做到）', `${trace.length} 行`);
    assert(s.walks.length === 1, 'V5 冷却期内不再第二次走过去', `walks=${s.walks.length}`);
  }
  {
    const s = buildSandbox({ walkEnabled: false });
    [1, 2, 3, 4].forEach((c) => s.click('left', { ...OFF, clicks: c, ctrl: true }));
    assert(s.logs.length === 0 && s.walks.length === 0, 'V6 功能关着 ⇒ 零留痕零走过去（关着不刷日志）',
      `logs=${s.logs.length} walks=${s.walks.length}`);
    const s2 = buildSandbox();
    s2.click('right', { ...OFF, clicks: 3, ctrl: true });
    s2.click('left', { ...OFF, clicks: undefined, ctrl: true });
    assert(s2.logs.filter((l) => l.startsWith(PINNED.LINE_HEAD)).length === 0,
      'V6 非左键不留痕；OS 计数不可用的第一击只记账不成行', `${s2.tr.pending} 记账`);
  }

  // ---- W 组：main.js 接线（按分支体定界）----
  console.log('W1..W5 · main.js 五个出口的接线（体内必须含这次调用，U-c 的后半牙齿）');
  const inWindowCode = codeOf(branches.inWindow);
  assert(/tripleClick\.reset\(\)/.test(inWindowCode), 'W1 正向对照：in-window 分支仍 reset（触发语义没被顺手改掉）', '');
  assert(/gestureTrace\.drop\(walk\.MISS_REASONS\.IN_WINDOW,\s*detail\.ctrl\)/.test(inWindowCode),
    'W1 in-window 分支把 detail.ctrl 传给 drop()（复测轮的修正：不带这个参数＝这类失败继续隐形）', '');
  assert(/if \(detail\.ctrl\) gestureTrace\.note\(detail\.clicks, 1\)/.test(inWindowCode),
    'W1 记账受 Ctrl 门控（无条件记账会让「两下点桌宠」重新变成刷日志的形态）', '');
  const ctrlCode = codeOf(branches.ctrl);
  assert(/tripleClick\.reset\(\)/.test(ctrlCode), 'W2 正向对照：ctrl 分支仍 reset', '');
  assert(/gestureTrace\.note\(detail\.clicks, 0\)/.test(ctrlCode),
    'W2 ctrl 分支把那一下记进账（不记就读不出「掉一拍」落在第几击）', '');
  assert(/gestureTrace\.drop\(walk\.MISS_REASONS\.CTRL_DROP\)/.test(ctrlCode),
    'W2 ctrl 分支体内接了 drop(CTRL_DROP)（U-c：摘掉这行必红）', '');
  const pushCode = codeOf(branches.pushFail);
  assert(/gestureTrace\.take\(tripleClick\.lastReason\)/.test(pushCode),
    'W3 push-fail 分支体内接了 take(tripleClick.lastReason)（U-c：摘掉这行必红）', '');
  assert(/移动跳过/.test(pushCode) && /lastSuppressed/.test(pushCode),
    'W3 正向对照：现有「移动跳过」那行没被弄坏（冷却归因仍由它承担）', '');
  const noteIdx = onDown.indexOf('gestureTrace.note(detail.clicks, 1);');
  const pushIdx2 = onDown.indexOf('if (!tripleClick.push(');
  assert(noteIdx >= 0 && noteIdx < pushIdx2, 'W4 参与击在判定之前就记账（顺序反了会漏记第三击）',
    noteIdx < 0 ? '体内未命中' : `note@${noteIdx} push@${pushIdx2}`);
  const firedIdx = afterPush.indexOf('gestureTrace.fired();');
  const walkIdx = afterPush.indexOf('walkPetTo(dip)');
  assert(firedIdx >= 0 && walkIdx >= 0 && firedIdx < walkIdx,
    'W5 成功路径 fired() 早于 walkPetTo()（晚了则冷却窗开不出来，连点尾巴会补假行）',
    `fired@${firedIdx} walk@${walkIdx}`);
  {
    const ctorIdx = src.indexOf('walk.createGestureTrace(');
    const ctorLine = ctorIdx < 0 ? '' : src.slice(ctorIdx, src.indexOf('\n', ctorIdx));
    assert(/walk\.createGestureTrace\(\{\s*log:\s*logLine\s*\}\)/.test(ctorLine),
      'W6 构造点把 log 接到 logLine（接成空函数＝留痕静默失效，正是本票要消灭的形态）', ctorLine.trim());
  }
  {
    const bare = ['not-os-3', 'in-window', 'ctrl-drop', 'ok-but-cooldown'].filter((t) => onDown.includes(`'${t}'`));
    assert(bare.length === 0, 'W7 原因名走真源：onGlobalMouseDown 体内无裸字面量', bare.join(',') || '');
  }
  {
    const onDownCode = codeOf(onDown);
    assert(/const\s+inWindow\s*=\s*inBox\s*;/.test(onDownCode),
      'W8 票 14-V：in-window 守卫取互动盒的判定结果（`const inWindow = inBox`）', '');
    const rectRef = onDownCode.match(/\bdip\.[xy]\s*[<>]=?\s*b\.[xy]|\bb\.[xy]\s*\+\s*b\.(?:width|height)/);
    assert(!rectRef, 'W8 回归钉子：体内不得再用窗口矩形算「点在桌宠上」（14-V 的真因：透明区被当成宠身）',
      rectRef ? `命中 ${rectRef[0]}` : '');
  }

  // ---- G 组：边界拍照（票面禁令机器化）----
  console.log('G1..G3 · 触发语义与阈值的拍照（本票不许改这几处）');
  {
    const walkSrc = fs.readFileSync(walkPath, 'utf8').replace(/\r/g, '');
    const code = codeOf(walkSrc);
    assert(/evt\.clicks === 3/.test(code), 'G1 push 里仍是「恰好等于 3」（真机依据：>=3 会把六连点算成两次三击）', '');
    assert(!/evt\.clicks\s*>=\s*3/.test(code), 'G1 没被改成 >=3', '');
    const guardIdx = walkSrc.indexOf('if (!osAvailable)');
    assert(guardIdx >= 0, 'G3 自攒兜底仍只在 !osAvailable 时才跑（A′ 未拍板前不得两路并行）', '');
    const seqBlock = guardIdx >= 0 ? extractFrom(walkSrc, guardIdx) : null;
    assert(seqBlock !== null && /count >= 3/.test(codeOf(seqBlock)), 'G3 兜底内部的 count>=3 没被改动', '');
    for (const [k, v] of Object.entries(PINNED.THRESHOLDS)) {
      assert(walk.DEFAULTS[k] === v, `G2 DEFAULTS.${k} == ${v}（没读数之前调阈值就是猜）`, `现算 ${walk.DEFAULTS[k]}`);
    }
  }

  console.log(`\nPASS ${pass} / FAIL ${failCount}`);
  if (failCount) {
    console.error(`✗ 三击留痕判据 ${failCount} 条失败（红法 U-c 的两种摘法：walk.js 不 log ⇒ R/T 组红；main.js 不调 ⇒ W 组红）`);
    process.exit(1);
  }
  console.log('PASS：原因枚举可用（not-os-3/seq-*/ctrl-drop/in-window）＋ 限流到位（非 in-window 路径一次手势最多一行；' +
    'in-window 带 Ctrl 每击一行、不带 Ctrl 零行）＋ main.js 五处接线在位');
  process.exit(0);
} catch (e) {
  console.error(`脚本异常：${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
}
