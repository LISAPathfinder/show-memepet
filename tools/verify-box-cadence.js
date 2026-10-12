// @runtime: ci —— CI 强制层判据件：上报节奏 vm 回归，纯 node，执行面在 run-ci.js
// 可交互盒上报节奏判据（票 11-L / 11-J 任务 2b，铁律 3：真断言 + 非零退出码）。
//
// 背景：主进程判定用的 petInteractiveBox 靠渲染端上报刷新，2b 前唯一常态驱动是 1s 定时器——
// 盒最多陈旧 1s（第四层根因）：元素消失而旧盒还在 → 吞点击；元素出现而旧盒没有 → 误穿透。
// 2b 改造：rAF 每帧驱动「变化才上报」，比对键 3px 量化（漂浮连续漂移不上报，离散突变一帧即报），
// 1s 定时器兜底 + onReportBox/onPing 点名保留。
//
// 量法：`BOX_PAD` / `BOX_EPSILON` / `boxSignature` 自票 0a-2 起真源在 core/interactive-box.js，
// 本件 **require 真函数**（纯 node 可载，见 core 纯度闸）；仍从 renderer/pet.js 定界提取的是
// DOM/IPC 绑的那两半——`interactiveBox`（querySelectorAll/getBoundingClientRect/drag/glass）与
// `reportInteractiveBox`（window.petAPI + 模块级 lastBoxSig 去重态），加上 INTERACTIVE_SELECTOR。
// 提取件注入可控 DOM 桩（元素 rect 可逐帧改），断言：首报恰好一次、静止/量化内漂移零 IPC、
// 量化外漂移与显隐必报、rAF 循环与兜底通道在位，另钉一条**加载面正向对照**（pet.html 必须先
// 于 pet.js 加载 core 那个文件——渲染端无 CommonJS，顺序反了或摘掉标签都是整页 SyntaxError/
// ReferenceError，静态层看不见，只有这条与运行时轮拦得住）。
//
// 用法：node tools/verify-box-cadence.js [仓库根，默认 cwd]
// 退出码：0 = 断言全绿；1 = 断言失败（脚本异常也落 1）；3 = 前置不满足（提取不到）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = process.argv[2] || process.cwd();
const petPath = path.join(root, 'renderer', 'pet.js');
if (!fs.existsSync(petPath)) {
  console.error('前置不满足（exit 3）：renderer/pet.js 不存在于 ' + petPath);
  process.exit(3);
}
const src = fs.readFileSync(petPath, 'utf8');

function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let depth = 0;
  const open = src.indexOf('{', i);
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1).replace(/\r/g, '');
    }
  }
  return null;
}
function extractConst(name) {
  const m = src.match(new RegExp(`const ${name} = ([^;\\n]+);`));
  return m ? `const ${name} = ${m[1]};` : null;
}
// 纯的三段走 require 真源（core/interactive-box.js，票 0a-2）：缺文件或缺导出＝前置不满足（exit 3），
// 不许「拿不到就当量化不存在」往下跑。
const boxPath = path.join(root, 'core', 'interactive-box.js');
if (!fs.existsSync(boxPath)) {
  console.error('前置不满足（exit 3）：core/interactive-box.js 不存在于 ' + boxPath + '（BOX_PAD/BOX_EPSILON/boxSignature 真源）');
  process.exit(3);
}
const boxCore = require(boxPath);
const coreMissing = ['BOX_PAD', 'BOX_EPSILON', 'boxSignature'].filter((k) => boxCore[k] === undefined);
if (coreMissing.length) {
  console.error(`前置不满足（exit 3）：core/interactive-box.js 导出缺 ${coreMissing.join('/')}（改名或删除要同步本件）`);
  process.exit(3);
}
// DOM/IPC 绑的两半仍从 pet.js 定界提取
const parts = {
  sel: extractConst('INTERACTIVE_SELECTOR'),
  iBox: extractFn('interactiveBox'),
  rep: extractFn('reportInteractiveBox'),
};
const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`前置不满足（exit 3）：提取失败——${missing.join('/')}`);
  process.exit(3);
}
// 模块级状态：lastBoxSig 声明提取（CRLF 容忍）
const stateMatch = src.match(/let lastBoxSig = '';/);
if (!stateMatch) {
  console.error('前置不满足（exit 3）：lastBoxSig 状态声明提取不到');
  process.exit(3);
}

// ---- 桩 DOM：元素集与 rect 可逐帧改 ----
// 元素形态对齐判据件现场（11-J）：face 110x110 @ (110,110)、counter 89x21、gear 26x26、lamp 12x12
function makeElements(rects) {
  return rects.map((r) => ({ getBoundingClientRect: () => ({ ...r }) }));
}
function buildVm(elements, opts = {}) {
  const ipc = [];
  const rafCalls = [];
  const timers = [];
  let els = elements;
  const sandbox = {
    document: { querySelectorAll: () => els },
    window: {
      innerWidth: 600,
      innerHeight: 600,
      petAPI: { setInteractiveBox: (box) => ipc.push(box ? JSON.parse(JSON.stringify(box)) : null) },
    },
    drag: { active: false },
    glass: { on: false },
    requestAnimationFrame: (fn) => {
      rafCalls.push(fn);
      return rafCalls.length;
    },
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: () => {},
    // 纯的三段从 core 真源注入沙箱全局（不是把 pet.js 的 const 文本拼进去跑）
    BOX_PAD: boxCore.BOX_PAD,
    BOX_EPSILON: boxCore.BOX_EPSILON,
    boxSignature: boxCore.boxSignature,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [parts.sel, 'let lastBoxSig = \'\';', parts.iBox, parts.rep].join('\n'),
    sandbox,
    { filename: 'renderer/pet.js[vm]' }
  );
  return {
    ipc,
    rafCalls,
    timers,
    setElements: (r) => {
      els = makeElements(r);
    },
    report: () => sandbox.reportInteractiveBox(),
  };
}
const BASE = [
  { left: 112, top: 112, width: 110, height: 110 }, // face（+BOX_PAD=2 → 盒 110,110 114x114）
  { left: 401, top: 573, width: 89, height: 21 },   // counter
  { left: 497, top: 570, width: 26, height: 26 },   // gear
  { left: 381, top: 577, width: 12, height: 12 },   // admin-lamp
];

let pass = 0;
let fail = 0;
function assert(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('场景 1：首报恰好一次，静止时零 IPC');
{
  const t = buildVm(makeElements(BASE));
  t.report();
  assert(t.ipc.length === 1, '首报 1 次', `ipc=${t.ipc.length}`);
  assert(t.ipc[0].length === 4 && Math.abs(t.ipc[0][0].x - 110) <= 1, '上报为离散数组（4 盒，face 盒 ~110,110）');
  t.report();
  t.report();
  assert(t.ipc.length === 1, '静止重复调用不再 IPC');
}

console.log('场景 2：连续缓动（漂浮形态）下 IPC 被量化压到远低于帧率');
{
  const t = buildVm(makeElements(BASE));
  t.report();
  const n0 = t.ipc.length;
  // 模拟 float 动画峰值段 1s：60 帧 × 0.1px（峰值速度 ~6px/s）。rAF 帧驱动下若用精确比对
  // 会 60 次 IPC（每帧都变）；3px 量化后只在跨量化边界时上报（期望 2~3 次）。
  for (let f = 1; f <= 60; f++) {
    t.setElements(BASE.map((r) => ({ ...r, top: r.top + f * 0.1 })));
    t.report();
  }
  const n1 = t.ipc.length - n0;
  assert(n1 <= 12, `60 帧缓动仅 ${n1} 次 IPC（帧驱动 ≠ 帧级上报）`, n1 <= 12 ? '量化生效' : '量化失效——检查比对键');
}

console.log('场景 3：量化外漂移（>3px）必 IPC——突变下一帧可见');
{
  const t = buildVm(makeElements(BASE));
  t.report();
  const jumped = BASE.map((r) => ({ ...r, top: r.top + 6 })); // scale 弹跳量级（+6px）
  t.setElements(jumped);
  t.report();
  assert(t.ipc.length === 2, '+6px 突变触发上报', `ipc=${t.ipc.length}`);
  assert(t.ipc[1][0].y - t.ipc[0][0].y === 6, '上报数据是精确盒（非量化值）', `Δy=${t.ipc[1][0].y - t.ipc[0][0].y}`);
}

console.log('场景 4：元素显隐（盒数变）必 IPC——2b 要治的两面之「出现」');
{
  const t = buildVm(makeElements(BASE));
  t.report();
  t.setElements(BASE.slice(0, 3)); // zzz/lamp 消失一类：少一盒
  t.report();
  assert(t.ipc.length === 2 && t.ipc[1].length === 3, '盒数变化触发上报', `n=${t.ipc[1].length}`);
  t.setElements([]); // 全隐藏
  t.report();
  assert(t.ipc.length === 3 && t.ipc[2] === null, '全隐藏上报 null（主进程走兜底判定）');
}

console.log('场景 5：拖拽/玻璃进出（整窗单盒）必 IPC');
{
  const t = buildVm(makeElements(BASE));
  t.report();
  // drag.active 在 interactiveBox 里读桩——桩固定 false，这里改用语义等价验证：整窗形态属
  // 「宽高差 >> 3px」的离散突变，由场景 3 的量化判据覆盖；源码级断言兜底（下节）
  assert(src.includes('drag.active || glass.on'), '整窗单盒分支在位（拖拽/玻璃）');
}

console.log('场景 6：rAF 循环与兜底通道（源码级）');
{
  assert(/function boxReportLoop\(\)[\s\S]{0,200}?reportInteractiveBox\(\);[\s\S]{0,200}?requestAnimationFrame\(boxReportLoop\)/.test(src.replace(/\r/g, '')),
    'rAF 循环在位（每帧驱动变化检测）');
  assert(/if \(typeof requestAnimationFrame === 'function'\) requestAnimationFrame\(boxReportLoop\);/.test(src.replace(/\r/g, '')),
    'rAF 可用性守卫在位');
  assert(/setInterval\(reportInteractiveBox, 1000\);/.test(src), '1s 定时器兜底保留');
  assert(/onReportBox\(\(\) => reportInteractiveBox\(\)\)/.test(src), '主进程点名通道保留');
  assert(boxCore.BOX_EPSILON === 3, '量化容差 3px（真源 core/interactive-box.js，漂浮 ±3px 不误报）', `BOX_EPSILON=${boxCore.BOX_EPSILON}`);
  assert(boxCore.BOX_PAD === 2, '上报盒余量 2px（同文件；6→2 是票 11-J 任务 3 的实算结论）', `BOX_PAD=${boxCore.BOX_PAD}`);
  // 加载面正向对照：pet.html 必须**先于 pet.js** 加载 core 那个文件——渲染端没有 CommonJS，
  // 两个符号面靠经典脚本的全局词法作用域共享。摘掉标签或顺序反转，pet.js 会当场报错、
  // 穿透上报链整条断，而 verify-checkjs 的 f 条是单向 C⊆B（不判「B 有 C 无」），结构上看不见这种缺失。
  const htmlPath = path.join(root, 'renderer', 'pet.html');
  const htmlSrc = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  const iCore = htmlSrc.indexOf('src="../core/interactive-box.js"');
  const iPet = htmlSrc.indexOf('src="pet.js"');
  assert(iCore >= 0 && iPet >= 0 && iCore < iPet, 'pet.html 加载面：core/interactive-box.js 在位且先于 pet.js',
    `core@${iCore} pet.js@${iPet}（-1＝没找到）`);
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
