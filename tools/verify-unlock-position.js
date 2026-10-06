// 解锁/唤醒重建的位置归位判据（票 11-K 任务 3，铁律 3：真断言 + 非零退出码）。
//
// 背景：unlock-screen/resume → recreatePetWindow → createPetWindow → resolvePetPosition() 的
// 恢复判据「保存位置完整落在就近显示器工作区」会在显示器枚举竞态下误判（副屏短暂缺席 →
// 就近屏找到主屏 → 副屏位置被判出屏 → 弹回主屏右下角）。1.0.60 起该路径 deferSelfHeal：
// 先按保存位置建窗，归位决策推迟到延迟复查（display-metrics-changed 提前 + 1.5s 超时兜底）。
//
// 量法：vm 提取 main.js 的 resolvePetPosition / scheduleDeferredPositionCheck / runDeferredPositionCheck /
// petEdgeState（含两个模块级 let）与 clampPetOriginToWorkArea，注入可控桩（显示器列表可开关、窗口位置可钳制、
// 定时器可手动到期 fireTimer），跑十四个场景 + 源码级断言。判据落在「返回什么位置/何时决策」的语义层。
// 场景 8（票 11-M）：丢唤醒竞态——提前触发消费掉复查后，旧 1.5s 定时器到期不得把新排的复查抹成无声空转。
// 场景 9/10/11（票 11-K 真因修正·方案 1）：贴边悬出 ≤ 内容半幅回挪不归位（两路径）+ 55/56px 半幅边界。
// 场景 13（1.0.64 内容矩形模型）：非对称真实桩——脸贴上缘 y=-400 放行（旧视觉模型钳 -300）、
// y 半幅 80px、x 半幅 150px 不变（11-K 装机案例口径）、模型接线源码断言（防静默改回视觉矩形）。
// 场景 14（票 11-N）：摆放三路接线的函数体双向断言——walkPetTo/fleeFromCursor/pet:scale-end
// 体内必须出现内容矩形串、不得出现视觉矩形串（全局搜是恒绿守卫，必须定界函数体）。
//
// 用法：node tools/verify-unlock-position.js [仓库根，默认 cwd]
// 退出码：0 = 断言全绿；1 = 断言失败（脚本异常也落 1）；3 = 前置不满足（源码提取不到）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = process.argv[2] || process.cwd();
const mainPath = path.join(root, 'main.js');
if (!fs.existsSync(mainPath)) {
  console.error('前置不满足（exit 3）：main.js 不存在于 ' + mainPath);
  process.exit(3);
}
const src = fs.readFileSync(mainPath, 'utf8');

// 括号配对提取函数体（模板串里的 ${...} 大括号天然成对，注释无裸大括号，配平可靠）
function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let depth = 0;
  const open = src.indexOf('{', i);
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  return null;
}
const FN_NAMES = ['resolvePetPosition', 'scheduleDeferredPositionCheck', 'runDeferredPositionCheck', 'petEdgeState', 'clampPetOriginToWorkArea'];
const fns = FN_NAMES.map((n) => extractFn(n));
if (fns.some((f) => !f)) {
  console.error('前置不满足（exit 3）：目标函数提取失败（' +
    FN_NAMES.filter((n, i) => !fns[i]).join('/') + '）');
  process.exit(3);
}

// 按锚点提取代码块（票 11-N）：pet:scale-end 是 ipcMain.on('pet:scale-end', (_e, v) => { … })
// 箭头函数，不是 function 声明，extractFn 取不到。从锚点后第一个 { 做括号配对。
function extractAt(anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  let depth = 0;
  const open = src.indexOf('{', i);
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  return null;
}

// 票 11-N 场景 14：摆放三路（走过去/让开/缩放回挪）的接线断言对象。
// 提取失败必须 exit 3 前置拦截——函数被改名时三条断言不许静默跳过。
const WIRING = [
  { key: 'walkPetTo', body: extractFn('walkPetTo') },
  { key: 'fleeFromCursor', body: extractFn('fleeFromCursor') },
  { key: 'pet:scale-end', body: extractAt("ipcMain.on('pet:scale-end'") },
];
const missingWiring = WIRING.filter((w) => !w.body);
if (missingWiring.length) {
  console.error('前置不满足（exit 3）：接线断言的函数体提取失败（' +
    missingWiring.map((w) => w.key).join('/') + '）');
  process.exit(3);
}
const stateRe = /let deferredPositionCheckTimer = null;\s*let deferredPositionSaved = null/;
const stateMatch = src.match(stateRe);
if (!stateMatch) {
  console.error('前置不满足（exit 3）：延迟复查的模块级状态声明提取不到');
  process.exit(3);
}
const stateSrc = stateMatch[0].replace(/\r/g, '');
const VM_SRC = stateSrc + '\n' + fns.join('\n');

// ---- 桩环境 ----
// 显示器模型：主屏 (0,0) 1920x1040，副屏 (1920,0) 1080x1920；secondaryInList 控制副屏是否「已枚举」。
// 保存位置默认取副屏 (1966,656)——纯合成场景（真机实况是单屏 2560x1440 无副屏、桌宠常停贴右缘，
// 见 findings「票 11-K 真因修正」；本件测的是「副屏缺席竞态」这条代码路径本身，对有副屏的用户仍真实）。
const PRIMARY_WA = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY_WA = { x: 1920, y: 0, width: 1080, height: 1920 };
const SAVED = { x: 1966, y: 656 };

// 手动让某个 timer 到期（票 11-M：旧桩只 push、从不执行回调，丢唤醒竞态在旧件里构造不出来）。
// 已撤销 → 跳过并打一行；返回 'executed' / 'skipped' / 'not-found' 供断言归因。
function fireTimer(timers, id) {
  const t = timers.find((x) => x.id === id);
  if (!t) return 'not-found';
  if (t.cancelled) {
    console.log('  （fire: 已撤销，不执行）');
    return 'skipped';
  }
  t.executed = true;
  t.fn();
  return 'executed';
}

function buildVm({ secondaryInList, savedPos = SAVED, winBounds = null }) {
  const timers = [];
  const logs = [];
  const posCalls = [];
  let bounds = winBounds || { x: savedPos.x, y: savedPos.y };
  const sandbox = {
    config: { get: () => savedPos },
    workAreaNearPoint: (p) =>
      secondaryInList && p.x >= SECONDARY_WA.x ? SECONDARY_WA : PRIMARY_WA,
    petContentRect: (origin) => ({ x: origin.x + 245, y: origin.y + 245, width: 110, height: 110 }),
    petScale: () => 1,
    // 与上方 petContentRect 桩同构（内容 = origin 内收 245、尺寸 110），供拖拽屏幕钳制场景使用
    contentSize: () => ({ width: 110, height: 110 }),
    petContentOffset: () => ({ x: 245, y: 245 }),
    petDefaultPosition: (wa) => ({ x: wa.x + wa.width - 612, y: wa.y + wa.height - 612 }),
    screen: {
      getPrimaryDisplay: () => ({ workArea: PRIMARY_WA }),
      getAllDisplays: () =>
        (secondaryInList ? [PRIMARY_WA, SECONDARY_WA] : [PRIMARY_WA]).map((workArea) => ({ workArea })),
    },
    logLine: (s) => logs.push(String(s)),
    petWindow: {
      isDestroyed: () => false,
      getBounds: () => ({ ...bounds }),
      setPosition: (x, y) => {
        bounds = { x, y };
        posCalls.push({ x, y });
      },
    },
    setTimeout: (fn, ms) => {
      timers.push({ id: timers.length + 1, fn, ms, cancelled: false, executed: false });
      return timers.length; // 恒真值，schedule 的「只排一个」判据可用；返回值即条目 id
    },
    // 票 11-M：真撤销语义（置 cancelled，fireTimer 时跳过）。不许写成空函数——那会让场景 8 假绿
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(VM_SRC, sandbox, { filename: 'main.js[vm]' });
  return {
    timers,
    logs,
    posCalls,
    fire: (id) => fireTimer(timers, id),
    resolvePetPosition: (d) => sandbox.resolvePetPosition(d),
    runDeferredPositionCheck: (why) => sandbox.runDeferredPositionCheck(why),
    clampPetOriginToWorkArea: (o) => sandbox.clampPetOriginToWorkArea(o),
    get bounds() {
      return bounds;
    },
  };
}

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

const visInPrimary = (p) => p.x + 245 >= PRIMARY_WA.x && p.y + 245 >= PRIMARY_WA.y;

console.log('场景 1：保存位置合法（副屏已枚举）→ 原样恢复，不排复查');
{
  const t = buildVm({ secondaryInList: true });
  const r1 = t.resolvePetPosition(false);
  const r2 = t.resolvePetPosition(true);
  assert(r1.x === SAVED.x && r1.y === SAVED.y && r2.x === SAVED.x && r2.y === SAVED.y,
    'defer 两态都返回 saved', `${r1.x},${r1.y}`);
  assert(t.timers.length === 0 && t.logs.length === 0, '无复查排程、无日志');
}

console.log('场景 2：出屏 + 非 defer（开机首建/托盘显示等）→ 归位默认 + 日志（原语义不变）');
{
  const t = buildVm({ secondaryInList: false });
  const r = t.resolvePetPosition(false);
  const def = { x: PRIMARY_WA.x + PRIMARY_WA.width - 612, y: PRIMARY_WA.y + PRIMARY_WA.height - 612 };
  assert(r.x === def.x && r.y === def.y, '返回主屏右下角默认位', `${r.x},${r.y}`);
  assert(t.logs.some((s) => s.includes('判出屏')), '归位决策落日志');
  assert(t.timers.length === 0, '不排延迟复查');
}

console.log('场景 3：出屏 + defer（unlock/resume 重建）→ 保留 saved + 安排复查（判据核心）');
{
  const t = buildVm({ secondaryInList: false });
  const r = t.resolvePetPosition(true);
  assert(r.x === SAVED.x && r.y === SAVED.y, '仍按保存位置建窗（不弹回主屏）', `${r.x},${r.y}`);
  assert(t.timers.length === 1 && t.timers[0].ms === 1500, '超时兜底复查已排（1.5s）');
  assert(t.logs.every((s) => !s.includes('判出屏')), 'defer 路径不落「立即归位」日志');
}

console.log('场景 4：复查·拉回（排程时缺席、触发时恢复）——两阶段桩');
{
  let secondary = false; // 阶段开关：false=副屏未枚举，true=已恢复
  const sandbox = {
    config: { get: () => SAVED },
    workAreaNearPoint: () => (secondary ? SECONDARY_WA : PRIMARY_WA),
    petContentRect: (origin) => ({ x: origin.x + 245, y: origin.y + 245, width: 110, height: 110 }),
    petScale: () => 1,
    petDefaultPosition: (wa) => ({ x: wa.x + wa.width - 612, y: wa.y + wa.height - 612 }),
    screen: { getPrimaryDisplay: () => ({ workArea: PRIMARY_WA }) },
    logLine: (s) => logs2.push(String(s)),
    petWindow: {
      isDestroyed: () => false,
      getBounds: () => ({ x: 1308, y: 428 }),
      setPosition: (x, y) => posCalls2.push({ x, y }),
    },
    setTimeout: (fn, ms) => {
      timers2.push({ id: timers2.length + 1, fn, ms, cancelled: false, executed: false });
      return timers2.length; // 恒真值
    },
    // 票 11-M：真撤销语义（置 cancelled）。修后产品码会在这里调 clearTimeout，缺桩直接 ReferenceError
    clearTimeout: (id) => {
      const t = timers2.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
  };
  var logs2 = [];
  var posCalls2 = [];
  var timers2 = [];
  vm.createContext(sandbox);
  vm.runInContext(VM_SRC, sandbox, { filename: 'main.js[vm]' });
  sandbox.resolvePetPosition(true); // 阶段一：缺席，排程
  secondary = true; // 阶段二：副屏恢复
  sandbox.runDeferredPositionCheck('display-metrics-changed');
  assert(posCalls2.length === 1 && posCalls2[0].x === SAVED.x && posCalls2[0].y === SAVED.y,
    '副屏恢复后复查拉回 saved', `setPosition→${posCalls2[0] ? posCalls2[0].x + ',' + posCalls2[0].y : '∅'}`);
  assert(logs2.some((s) => s.includes('拉回')), '拉回决策落日志');
}

console.log('场景 5：复查·归位——保存位置仍出屏（真拔屏）→ 归位默认 + 日志');
{
  const logs2 = [];
  const posCalls2 = [];
  const timers2 = [];
  const sandbox = {
    config: { get: () => SAVED },
    workAreaNearPoint: () => PRIMARY_WA, // 副屏始终缺席
    petContentRect: (origin) => ({ x: origin.x + 245, y: origin.y + 245, width: 110, height: 110 }),
    petScale: () => 1,
    petDefaultPosition: (wa) => ({ x: wa.x + wa.width - 612, y: wa.y + wa.height - 612 }),
    screen: { getPrimaryDisplay: () => ({ workArea: PRIMARY_WA }) },
    logLine: (s) => logs2.push(String(s)),
    petWindow: {
      isDestroyed: () => false,
      getBounds: () => ({ x: 1308, y: 428 }),
      setPosition: (x, y) => posCalls2.push({ x, y }),
    },
    setTimeout: (fn, ms) => {
      timers2.push({ id: timers2.length + 1, fn, ms, cancelled: false, executed: false });
      return timers2.length; // 恒真值
    },
    // 票 11-M：真撤销语义（置 cancelled）。修后产品码会在这里调 clearTimeout，缺桩直接 ReferenceError
    clearTimeout: (id) => {
      const t = timers2.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(VM_SRC, sandbox, { filename: 'main.js[vm]' });
  sandbox.resolvePetPosition(true);
  sandbox.runDeferredPositionCheck('超时');
  const def = { x: PRIMARY_WA.x + PRIMARY_WA.width - 612, y: PRIMARY_WA.y + PRIMARY_WA.height - 612 };
  assert(posCalls2.length === 1 && posCalls2[0].x === def.x && posCalls2[0].y === def.y,
    '真拔屏时归位主屏右下角', `setPosition→${posCalls2[0].x},${posCalls2[0].y}`);
  assert(logs2.some((s) => s.includes('仍出屏')), '归位决策落日志（不再无声）');
}

console.log('场景 6：同一次重建只排一个复查（重复 defer 不叠加定时器）');
{
  const t = buildVm({ secondaryInList: false });
  t.resolvePetPosition(true);
  const n1 = t.timers.length;
  t.resolvePetPosition(true);
  assert(n1 === 1 && t.timers.length === 1, 'schedule 幂等', `timers=${t.timers.length}`);
}

console.log('场景 7：defer 传递链与提前触发（源码级）');
{
  assert(src.includes('recreatePetWindow(why, recreate)'), 'resyncPassThrough → recreatePetWindow 传 recreate');
  assert(src.includes('createPetWindow(deferSelfHeal)'), 'recreatePetWindow → createPetWindow 传 defer');
  assert(src.includes('...resolvePetPosition(deferSelfHeal)'), 'createPetWindow → resolvePetPosition 传 defer');
  assert(src.includes("display-metrics-changed") && src.includes('runDeferredPositionCheck'), 'display-metrics-changed 提前触发在位');
  assert(src.includes("powerMonitor.on('unlock-screen', () => resyncPassThrough('unlock-screen', true))"), 'unlock-screen 走 recreate=true');
}

console.log('场景 8：丢唤醒竞态（票 11-M）——提前触发消费掉复查后，旧 T1 到期不得抹掉新排的 T2');
{
  let secondary = false; // 两阶段开关：false=副屏缺席，true=已恢复（沿用场景 4 的写法）
  const logs8 = [];
  const posCalls8 = [];
  const timers8 = [];
  const sandbox = {
    config: { get: () => SAVED },
    workAreaNearPoint: () => (secondary ? SECONDARY_WA : PRIMARY_WA),
    petContentRect: (origin) => ({ x: origin.x + 245, y: origin.y + 245, width: 110, height: 110 }),
    petScale: () => 1,
    petDefaultPosition: (wa) => ({ x: wa.x + wa.width - 612, y: wa.y + wa.height - 612 }),
    screen: { getPrimaryDisplay: () => ({ workArea: PRIMARY_WA }) },
    logLine: (s) => logs8.push(String(s)),
    petWindow: {
      isDestroyed: () => false,
      getBounds: () => ({ x: 1308, y: 428 }),
      setPosition: (x, y) => posCalls8.push({ x, y }),
    },
    setTimeout: (fn, ms) => {
      timers8.push({ id: timers8.length + 1, fn, ms, cancelled: false, executed: false });
      return timers8.length; // 恒真值
    },
    clearTimeout: (id) => {
      const t = timers8.find((x) => x.id === id);
      if (t) t.cancelled = true; // 真撤销语义（票 11-M）
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(VM_SRC, sandbox, { filename: 'main.js[vm]' });

  // 时间线照票面 §四：T+0 排 T1（副屏缺席）→ T+0.3s 副屏恢复、display-metrics-changed 提前拉回
  // → T+0.6s 副屏再缺席、第二次重建排 T2 → T+1.5s fire(T1) → T+2.1s fire(T2)
  sandbox.resolvePetPosition(true);
  assert(timers8.length === 1, 'T1 已排（1.5s 兜底）');
  secondary = true;
  sandbox.runDeferredPositionCheck('display-metrics-changed');
  assert(posCalls8.length === 1 && posCalls8[0].x === SAVED.x && posCalls8[0].y === SAVED.y,
    '提前触发已把 saved 拉回', `setPosition→${posCalls8[0].x},${posCalls8[0].y}`);
  secondary = false;
  sandbox.resolvePetPosition(true);
  assert(timers8.length === 2, 'T2 已排（提前触发已清 timer，schedule 放行）');

  const r1 = fireTimer(timers8, timers8[0].id); // T+1.5s：T1 到期
  // 断言 B：修好后 T1 已被撤销，fire 必须跳过；改前无撤销语义 → T1 执行并抹掉 saved
  assert(r1 === 'skipped', '断言 B：fire(T1) 被跳过（已撤销，不执行）', `fire(T1)→${r1}`);

  // 断言 A 的归因窗口：快照取在 fire(T1) 之后、fire(T2) 之前，之后的增量只能来自 T2 的执行
  //（改前 fire(T1) 会执行并产生 setPosition/日志，所以快照必须在那之后才取，否则假绿）
  const posBefore = posCalls8.length;
  const logBefore = logs8.length;
  const r2 = fireTimer(timers8, timers8[1].id); // T+2.1s：T2 到期
  const newPos = posCalls8.length - posBefore;
  const newLogs = logs8.slice(logBefore);
  assert(
    r2 === 'executed' &&
      (newPos > 0 ||
        newLogs.some((s) => s.includes('拉回') || (s.includes('仍出屏') && s.includes('归位主屏右下角')))),
    '断言 A：fire(T2) 后 T2 真执行了复查（新 setPosition 或 拉回/仍出屏…归位 日志）',
    `fire(T2)→${r2}，新 setPosition=${newPos}，新日志=${newLogs.length}条`
  );
}

console.log('场景 9：贴边悬出 ≤ 内容半幅（非 defer）→ 最小位移回挪，不归位默认（11-K 真因修正·方案 1）');
{
  // 桩的内容矩形 = origin+(245,245) 110x110：origin.x=1577 → 右缘 1932，对 1920 宽主屏悬出 12px（实机同构量级）
  const t = buildVm({ secondaryInList: false, savedPos: { x: 1577, y: 656 } });
  const r = t.resolvePetPosition(false);
  assert(r.x === 1565 && r.y === 656, '返回钳回屏内的坐标（右缘贴 1920，y 不动）', `${r.x},${r.y}`);
  assert(t.logs.some((s) => s.includes('回挪')) && t.logs.every((s) => !s.includes('判出屏')),
    '回挪决策落日志、不落「判出屏」');
  assert(t.timers.length === 0, '非 defer 路径直接钳回，不排复查');
}

console.log('场景 10：贴边悬出 ≤ 内容半幅（defer 路径）→ 仍推迟到复查，复查执行回挪');
{
  const t = buildVm({ secondaryInList: false, savedPos: { x: 1577, y: 656 } });
  const r = t.resolvePetPosition(true);
  assert(r.x === 1577 && r.y === 656 && t.timers.length === 1,
    'defer 路径仍按保存位置建窗并排复查（枚举稳定后再钳，竞态安全）', `${r.x},${r.y}`);
  t.runDeferredPositionCheck('超时');
  assert(t.posCalls.length === 1 && t.posCalls[0].x === 1565 && t.posCalls[0].y === 656,
    '复查把窗口回挪到屏内（不是默认角）', `setPosition→${t.posCalls[0].x},${t.posCalls[0].y}`);
  assert(t.logs.some((s) => s.includes('回挪')) && t.logs.every((s) => !s.includes('归位主屏右下角')),
    '回挪日志落、不落「归位主屏右下角」');
}

console.log('场景 11：阈值边界（内容半幅）——悬出 55px 回挪（含边界）、56px 仍走原「归位默认」语义');
{
  // 桩的内容矩形 110x110 → 半幅 55。悬出 55：origin.x+355-1920=55 → origin.x=1620 → 钳回 1565
  const t55 = buildVm({ secondaryInList: false, savedPos: { x: 1620, y: 656 } });
  const r55 = t55.resolvePetPosition(false);
  assert(r55.x === 1565 && r55.y === 656, '悬出 55px（=半幅，边界含）→ 回挪', `${r55.x},${r55.y}`);
  // 悬出 56（>半幅）→ 原「判出屏归位默认」语义不变
  const t56 = buildVm({ secondaryInList: false, savedPos: { x: 1621, y: 656 } });
  const r56 = t56.resolvePetPosition(false);
  const def = { x: PRIMARY_WA.x + PRIMARY_WA.width - 612, y: PRIMARY_WA.y + PRIMARY_WA.height - 612 };
  assert(r56.x === def.x && r56.y === def.y && t56.logs.some((s) => s.includes('判出屏')),
    '悬出 56px（>半幅）→ 原「判出屏归位默认」语义不变', `${r56.x},${r56.y}`);
}

console.log('场景 12：拖拽屏幕钳制——桌宠不允许被移出屏幕（2026-10-05 用户拍板）');
{
  const t = buildVm({ secondaryInList: false });
  // 实机同构：贴右缘停靠拖到 2094 → 内容矩形右缘 2094+355=2449，钳回 1565（右缘贴 1920）
  const c1 = t.clampPetOriginToWorkArea({ x: 2094, y: 533 });
  assert(c1.x === 1565 && c1.y === 533, '右缘外 529px → 钳回屏内贴右缘（y 不动）', `${c1.x},${c1.y}`);
  const c2 = t.clampPetOriginToWorkArea({ x: 100, y: 100 });
  assert(c2.x === 100 && c2.y === 100, '屏内位置原样放行', `${c2.x},${c2.y}`);
  const c3 = t.clampPetOriginToWorkArea({ x: -305, y: 100 });
  assert(c3.x === -245 && c3.y === 100, '左缘外 → 钳到内容矩形贴左缘', `${c3.x},${c3.y}`);
  const c4 = t.clampPetOriginToWorkArea({ x: 100, y: 1200 });
  assert(c4.x === 100 && c4.y === 685, '下缘外 → 钳到内容矩形贴下缘', `${c4.x},${c4.y}`);
  // 源码级正向对照：钳制必须真的接在 pet:move-by 拖拽通路上（防「函数在、没接线」的恒绿）
  assert(src.includes('win === petWindow ? clampPetOriginToWorkArea(target) : target'),
    '拖拽通路 pet:move-by 已接入钳制（源码级）');
}

console.log('场景 13：内容矩形模型（1.0.64 判据收紧）——脸能贴上缘、y 半幅 80px、x 半幅 150px 不变');
{
  // 真实模型桩（s=1）：内容 = origin+(300,440) 300x160（视觉 300x300 顶部的气泡预留位不再算本体）。
  // 对称桩（场景 1-12）分不出横纵口径，这里用非对称桩锁死「纵向收紧、横向不变」的模型事实
  const WA13 = { x: 0, y: 0, width: 1920, height: 1040 };
  const logs13 = [];
  const posCalls13 = [];
  const saved13 = { x: 500, y: -400 };
  const sandbox = {
    config: { get: () => saved13 },
    workAreaNearPoint: () => WA13,
    petContentRect: (origin) => ({ x: origin.x + 300, y: origin.y + 440, width: 300, height: 160 }),
    petScale: () => 1,
    contentSize: () => ({ width: 300, height: 160 }),
    petContentOffset: () => ({ x: 300, y: 440 }),
    petDefaultPosition: (wa) => ({ x: wa.x + wa.width - 612, y: wa.y + wa.height - 612 }),
    screen: {
      getPrimaryDisplay: () => ({ workArea: WA13 }),
      getAllDisplays: () => [{ workArea: WA13 }],
    },
    logLine: (s) => logs13.push(String(s)),
    petWindow: {
      isDestroyed: () => false,
      getBounds: () => ({ x: saved13.x, y: saved13.y }),
      setPosition: (x, y) => posCalls13.push({ x, y }),
    },
    setTimeout: (fn, ms) => 1,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(VM_SRC, sandbox, { filename: 'main.js[vm]' });
  // 新能力：窗口上沿悬出屏 400px 放行——内容矩形顶 = -400+440 = 40 仍在屏内（脸贴上缘）；
  // 旧视觉模型（y 下限 -300）会把它钳回 -300，此断言在旧模型下必红
  const c1 = sandbox.clampPetOriginToWorkArea({ x: 500, y: -400 });
  assert(c1.x === 500 && c1.y === -400, '上缘新可达：y=-400 放行（内容矩形贴上缘，旧视觉模型钳 -300）', `${c1.x},${c1.y}`);
  const c2 = sandbox.clampPetOriginToWorkArea({ x: 500, y: -500 });
  assert(c2.x === 500 && c2.y === -440, '上缘硬限：内容矩形顶不出工作区（y=-440）', `${c2.x},${c2.y}`);
  // y 半幅 = 内容高一半 = 80：悬出 100px 判「大幅出屏」归位（旧视觉半幅 150 会判贴边回挪——模型收紧的代价，接受）
  saved13.x = 1000;
  saved13.y = -540;
  const r100 = sandbox.resolvePetPosition(false);
  assert(r100.x === 1308 && r100.y === 428 && logs13.some((s) => s.includes('判出屏')),
    'y 悬出 100px（>内容半幅 80）→ 判出屏归位', `${r100.x},${r100.y}`);
  // x 半幅 = 视觉宽一半 = 150 不变：11-K 装机实测的 100~134px 右缘悬出仍判贴边回挪，修复语义不回退
  saved13.x = 1460;
  saved13.y = 100;
  const r140 = sandbox.resolvePetPosition(false);
  assert(r140.x === 1320 && r140.y === 100 && logs13.some((s) => s.includes('贴边悬出')),
    'x 悬出 140px（≤半幅 150，横向口径不变）→ 贴边回挪钳回屏内', `${r140.x},${r140.y}`);
  // 模型接线（源码级）：摆放判据必须引用内容矩形助手，防「静默改回视觉矩形」的模型回退
  assert(src.includes('const vis = petContentRect(origin, petScale())'), 'petEdgeState 用内容矩形（源码级）');
  assert(src.includes('const off = petContentOffset(s)') && src.includes('const size = contentSize(s)'),
    '拖拽钳制用内容矩形助手（源码级）');
}

console.log('场景 14：摆放三路接线（票 11-N）——walkPetTo / fleeFromCursor / pet:scale-end 必须按内容矩形算');
{
  // §77①：不许写成全局 src.includes('contentSize(s)')——contentSize 在 main.js 多处本来就有
  // （petContentRect 自己就用），全局搜必然通过＝恒绿守卫。必须定界到函数体，体内做双向断言：
  // 出现内容矩形串（正向对照）且不出现视觉矩形串。三处接线在 1.0.64 收紧后无人锁，
  // 改回 visualSize/petVisualRect 时 CI 十三件里其余十二件仍全绿且无日志可查——本场景就是补这个洞。
  // 'vis.' 是 1.0.64 悬空引用回归（票 11-O）的形态位：fleeFromCursor 末行用了
  // 未定义的 vis.width/vis.height。1c 用独立禁串（pet:scale-end 体内合法存在
  // const vis = petContentRect(...)，不许被这条误伤）。
  const VIS_BAN = ['visualSize', 'petVisualOffset', 'petVisualRect', 'vis.'];
  function wiringAssert(body, mustHave, mustNot, label) {
    const missing = mustHave.filter((s) => !body.includes(s));
    const forbidden = mustNot.filter((s) => body.includes(s));
    assert(missing.length === 0 && forbidden.length === 0, label,
      missing.length || forbidden.length
        ? `缺[${missing.join(' ')}] 现[${forbidden.join(' ')}]`
        : '体内双向通过');
  }
  wiringAssert(WIRING[0].body,
    ['contentSize(s)', 'petContentOffset(s)', 'computeWalkTarget(dip, wa, size)'],
    VIS_BAN, '1a walkPetTo 走过去落点按内容矩形算（函数体双向断言）');
  wiringAssert(WIRING[1].body,
    ['contentSize(s)', 'petContentOffset(s)', 'planFlee(contentTL, cursor, wa, size)'],
    VIS_BAN, '1b fleeFromCursor 让开规划按内容矩形算（函数体双向断言）');
  wiringAssert(WIRING[2].body,
    ['petContentRect({ x: b.x, y: b.y }, s)'],
    ['petVisualRect({ x: b.x, y: b.y }'],
    '1c pet:scale-end 缩放回挪按内容矩形算（函数体双向断言）');
}

console.log('场景 15：fleeFromCursor 真调一次（票 11-O）——不抛异常 + dip == target + size/2');
{
  // 场景 14 只做源码字符串断言，抓不住「体内引用了不存在的变量」这种运行时炸——
  // 1.0.64 把定义端 const vis = visualSize(s) 改成 const size = contentSize(s) 后，
  // fleeFromCursor 末行的 vis.width/vis.height 悬空，每次让开抛 ReferenceError 被
  // uncaughtException 兜底吞成日志（装机 1.0.64 让开功能完全失效）。这里在 vm 沙箱
  // 里真调一次：walkPetTo 桩成 spy 记录 dip，断言调用不抛 + dip 恰等于 target + size/2
  //（内容矩形中心；1.0.64 起让开规划按内容矩形算，dip 语义随之）。
  const logs15 = [];
  const dips15 = [];
  const TARGET15 = { x: 800, y: 900, movedPx: 200, label: '下' }; // planFlee 桩返回值
  const SIZE15 = { width: 300, height: 160 }; // s=1 的内容矩形（与 petContentOffset 桩同构）
  const sandbox = {
    workAreaNearPoint: () => PRIMARY_WA,
    petScale: () => 1,
    contentSize: () => SIZE15,
    petContentOffset: () => ({ x: 300, y: 440 }),
    CURSOR_FLEE_MS: 5000,
    walk: { planFlee: () => TARGET15 },
    walkPetTo: (dip) => dips15.push(dip), // spy：抓住 fleeFromCursor 交给走过去管线的落点
    logLine: (s) => logs15.push(String(s)),
  };
  vm.createContext(sandbox);
  vm.runInContext(WIRING[1].body, sandbox, { filename: 'main.js[fleeFromCursor]' });
  let threw = null;
  try {
    sandbox.fleeFromCursor({ x: 100, y: 100 }, { x: 150, y: 150 });
  } catch (e) {
    threw = e;
  }
  assert(!threw, '调用不抛异常（1.0.64 悬空引用 vis 在此必抛 ReferenceError）',
    threw ? `${threw.constructor.name}: ${threw.message}` : '执行完成');
  const wantDip = { x: TARGET15.x + SIZE15.width / 2, y: TARGET15.y + SIZE15.height / 2 };
  assert(dips15.length === 1 && dips15[0].x === wantDip.x && dips15[0].y === wantDip.y,
    'walkPetTo 收到的 dip == target + size/2（内容矩形中心）',
    threw ? '（因抛异常未到达）' : dips15.length ? `${dips15[0].x},${dips15[0].y}` : 'walkPetTo 未被调用');
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
