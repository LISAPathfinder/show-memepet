// Ctrl 显隐状态对账自愈判据（票 11-S 任务 1，铁律 3：真断言 + 非零退出码）。
//
// 背景（校验轮⑥）：f31b6ba 修「没按 Ctrl 手柄也出现」的 reconcileCtrlState 两拍对账自愈
// （main.js bootApp 里 setInterval(reconcileCtrlState, 2000)）此前没有任何判据的执行路径
// 经过它，装机日志「Ctrl 状态对账」0 命中——票 11-O「有专属判据没人跑」的更糟翻版：
// 这次连判据都没有。本件从 main.js 定界提取 petCtrlState / pushPetCtrlState / trackPetCtrl /
// reconcileCtrlState（含 ctrlKeyProbe / ctrlDriftStreak 两个模块级 let）在 vm 沙箱里跑，
// 桩 koffi（GetAsyncKeyState 读数可编程 + 读数计数）、logLine、sendToPet（记录 pet:ctrl 推送序列）。
//
// 断言（每条标「哪次改动会让它红」，§77① 正向对照义务）：
// ① 闩住（丢 keyup）后真值连两拍松开 ⇒ 恰好一次 down:false 推送 + 一条对账日志
//    （红于：纠正分支不动 petCtrlState / 门槛 2 拍调 3 拍）
// ② 只一拍不一致 ⇒ 必须零推送零日志（锁两拍门槛；红于：删掉 ctrlDriftStreak 门槛）
// ③ 真按住期间真值恒 true、钩子已推 true ⇒ 零纠正零日志（红于：对账误纠）
// ④ 接线：bootApp 函数体内必须有 setInterval(reconcileCtrlState, N) 且 N ≤ 2000。
//    必须按函数体定界，写成全局 src.includes(...) 是恒绿守卫（那串在函数定义处本来就有）
//    （红于：摘掉那行接线 / 周期调大到 >2000 / 把接线挪出 bootApp）
// ⑤ 补全丢 keydown 方向：钩子没见过按下、真值两拍按住 ⇒ 两拍后推 down:true + 对账日志
//    （红于：门槛 2 拍调 3 拍；M2 删的是 left=false 分支，不红本条——两方向分支各自独立被锁）
// ⑥ 拍序「不一致→一致→不一致」⇒ 零纠正（一致拍必须重置 streak；红于：删掉一致分支里的
//    ctrlDriftStreak = 0——校验轮⑦ W3 实测原本全绿，票 11-T 任务 4 补上）
// ⑦ 钩子只见过 CtrlRight、真值两拍松开 ⇒ 纠正后 left/right 双侧清零且推 down:false
//    （红于：双侧清零改成只清 left——W8 正是用户报的「右 Ctrl 闩死」形态，校验轮⑦ 实测原本全绿）
// ⑧ 每次读真值的 vk 实参必须是 0x11（VK_CONTROL）：桩记下 vk 序列，①②⑥⑦ 都查
//    （红于：0x11 改 0x12=VK_MENU——校验轮⑦ W1 实测原本全绿）
// 读数计数（probeReads）防假绿：reconcile 若因探针缺失静默 return，①②③ 的拍数断言当场红。
//
// 突变自证（本件不内置；在 %TEMP% 的 main.js 副本上做突变、传副本根目录复跑本件，各红对应条）：
// M1 删 ctrlDriftStreak 门槛→②红；M2 纠正分支不动 petCtrlState→①⑤红；
// M3 摘掉 bootApp 里那行 setInterval→④红；M4 门槛 2 拍调 3 拍→①红；
// W1 读错键码 0x11→0x12→⑧红；W3 删一致分支的重置→⑥红；W8 双侧清零改只清 left→⑦红。
//
// 用法：node tools/verify-ctrl-reconcile.js [仓库根，默认 cwd]
// 退出码：0 = 断言全绿；1 = 断言失败（脚本自身异常也落 1，stderr 打「脚本异常：<原因>」）；
//         3 = 前置不满足（main.js 不存在 / 目标块提取不到）。纯逻辑件：不接实例、无占用自检。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const mainPath = path.join(process.argv[2] || process.cwd(), 'main.js');
if (!fs.existsSync(mainPath)) {
  console.error('前置不满足（exit 3）：main.js 不存在于 ' + mainPath);
  process.exit(3);
}
const src = fs.readFileSync(mainPath, 'utf8').replace(/\r/g, '');

// 括号配对提取函数体（同 verify-unlock-position 先例：模板串 ${...} 大括号天然成对，配平可靠）
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

const stateDecl = src.match(/const petCtrlState = \{[^}]*\};/);
const letsDecl = src.match(/let ctrlKeyProbe = null;[^\n]*\nlet ctrlDriftStreak = 0;/);
const pushFn = extractFn('pushPetCtrlState');
const trackFn = extractFn('trackPetCtrl');
const reconFn = extractFn('reconcileCtrlState');
const bootFn = extractFn('bootApp');
const MISSING = [
  ['petCtrlState 声明', stateDecl],
  ['ctrlKeyProbe/ctrlDriftStreak 声明', letsDecl],
  ['pushPetCtrlState', pushFn],
  ['trackPetCtrl', trackFn],
  ['reconcileCtrlState', reconFn],
  ['bootApp', bootFn],
].filter(([, v]) => !v).map(([k]) => k);
if (MISSING.length) {
  console.error('前置不满足（exit 3）：目标块提取失败（' + MISSING.join('/') + '）——函数被改名时断言不许静默跳过');
  process.exit(3);
}

const VM_SRC = [stateDecl[0], letsDecl[0], pushFn, trackFn, reconFn].join('\n');

// ---- 桩环境 ----
// koffi 桩：load('user32.dll').func('GetAsyncKeyState', ...) 返回可编程读数函数，
// 返回值由 setKey 切换（0 = 松开 / 0x8000 = 按住高位），每次读数 probeReads+1。
function buildVm() {
  const logs = [];
  const pushes = []; // sendToPet 收到的 { channel, payload } 序列
  const vkReads = []; // 票 11-T⑧：记下每次 GetAsyncKeyState 的 vk 实参（W1 读错键码必须红）
  let keyState = 0;
  let probeReads = 0;
  const sandbox = {
    koffi: {
      load: () => ({
        func: (name) => {
          if (name !== 'GetAsyncKeyState') throw new Error('桩只认 GetAsyncKeyState，收到 ' + name);
          return (vk) => {
            probeReads++;
            vkReads.push(vk);
            return keyState;
          };
        },
      }),
    },
    logLine: (s) => logs.push(String(s)),
    sendToPet: (channel, payload) => pushes.push({ channel, payload }),
  };
  vm.createContext(sandbox);
  vm.runInContext(VM_SRC, sandbox, { filename: 'main.js[vm]' });
  return {
    logs,
    pushes,
    vkReads,
    get probeReads() {
      return probeReads;
    },
    setKey: (v) => {
      keyState = v;
    },
    track: (name, down) => sandbox.trackPetCtrl(name, down),
    reconcile: () => sandbox.reconcileCtrlState(),
    // 取沙箱内 petCtrlState 的当前值（值拷贝，防跨 context 引用差异）
    state: () => vm.runInContext('({ left: petCtrlState.left, right: petCtrlState.right, sent: petCtrlState.sent })', sandbox),
  };
}

try {
  const DOWN = 0x8000;

  console.log('① 闩住（丢 keyup）后真值连两拍松开 ⇒ 恰好一次 down:false 推送 + 一条对账日志');
  {
    const t = buildVm();
    t.track('Ctrl', true); // 钩子正常推 down:true；此后 keyup 被钩子丢弃，left 闩在 true
    t.setKey(0); // 系统真值：已松开
    t.reconcile(); // 第一拍：只记 streak
    t.reconcile(); // 第二拍：纠正 + 日志 + 推送
    assert(
      t.pushes.length === 2 && t.pushes[0].payload.down === true && t.pushes[1].payload.down === false,
      '恰好一次 down:false 推送（前置一次 down:true）',
      `pushes=${JSON.stringify(t.pushes)}`
    );
    assert(t.logs.length === 1 && t.logs[0].includes('Ctrl 状态对账'), '落一条对账日志',
      t.logs.length ? t.logs[0].slice(0, 40) + '…' : '无日志');
    assert(t.probeReads === 2, '两拍各读一次真值（探针静默失效会在此红）', `probeReads=${t.probeReads}`);
    assert(t.vkReads.length === 2 && t.vkReads.every((v) => v === 0x11),
      '两拍读的都是 vk=0x11（VK_CONTROL）——读错键码（0x12=VK_MENU）在此红（票 11-T⑧/W1）',
      `vkReads=${JSON.stringify(t.vkReads)}`);
  }

  console.log('② 只一拍不一致 ⇒ 必须零推送零日志（两拍门槛）');
  {
    const t = buildVm();
    t.track('Ctrl', true);
    t.setKey(0);
    t.reconcile(); // 只一拍
    assert(t.pushes.length === 1 && t.pushes[0].payload.down === true, '零纠正推送（只有钩子那次 down:true）',
      `pushes=${JSON.stringify(t.pushes)}`);
    assert(t.logs.length === 0, '零对账日志', `logs=${t.logs.length}`);
    assert(t.probeReads === 1, '这一拍真读了真值（不是没跑）', `probeReads=${t.probeReads}`);
    assert(t.vkReads.length === 1 && t.vkReads[0] === 0x11, '读的是 vk=0x11（VK_CONTROL）',
      `vkReads=${JSON.stringify(t.vkReads)}`);
  }

  console.log('③ 真按住期间真值恒 true、钩子已推 true ⇒ 零纠正零日志');
  {
    const t = buildVm();
    t.track('CtrlRight', true); // 右 Ctrl（VK_CONTROL 聚合口径：任一按住即按住）
    t.setKey(DOWN);
    for (let i = 0; i < 3; i++) t.reconcile();
    assert(t.pushes.length === 1 && t.pushes[0].payload.down === true, '零额外推送', `pushes=${t.pushes.length}`);
    assert(t.logs.length === 0, '零对账日志', `logs=${t.logs.length}`);
    assert(t.probeReads === 3, '三拍都在读（不是空转）', `probeReads=${t.probeReads}`);
  }

  console.log('④ 接线：bootApp 函数体内 setInterval(reconcileCtrlState, N) 且 N ≤ 2000（函数体定界，禁全局 includes）');
  {
    const m = bootFn.match(/setInterval\(\s*reconcileCtrlState\s*,\s*(\d+)\s*\)/);
    assert(m, 'bootApp 体内有 setInterval(reconcileCtrlState, N)（摘掉接线或挪出函数体都红）',
      m ? '在位' : 'bootApp 体内未命中');
    assert(m && Number(m[1]) <= 2000, '对账周期 N ≤ 2000', m ? `N=${m[1]}` : '无匹配');
  }

  console.log('⑤ 补全丢 keydown 方向：真值两拍按住 ⇒ 两拍后推 down:true + 对账日志');
  {
    const t = buildVm();
    t.setKey(DOWN); // 钩子从未见过按下（keydown 丢失），tracked=false
    t.reconcile();
    t.reconcile();
    assert(t.pushes.length === 1 && t.pushes[0].payload.down === true, '两拍后推 down:true（丢 keydown 方向自愈）',
      `pushes=${JSON.stringify(t.pushes)}`);
    assert(t.logs.length === 1 && t.logs[0].includes('Ctrl 状态对账'), '落一条对账日志', `logs=${t.logs.length}`);
  }

  console.log('⑥ 拍序「不一致→一致→不一致」⇒ 零纠正（一致拍必须重置门槛 streak）');
  {
    const t = buildVm();
    t.track('Ctrl', true); // 钩子推 down:true，此后 keyup 丢失，left 闩在 true
    t.setKey(0);
    t.reconcile(); // 拍1：不一致（streak=1，零动作）
    t.setKey(DOWN);
    t.reconcile(); // 拍2：一致——必须把 streak 重置回 0（W3：删掉这行重置，拍3 就误纠）
    t.setKey(0);
    t.reconcile(); // 拍3：又只一拍不一致 ⇒ 零动作
    assert(t.pushes.length === 1 && t.pushes[0].payload.down === true, '零纠正推送（只有钩子那次 down:true）',
      `pushes=${JSON.stringify(t.pushes)}`);
    assert(t.logs.length === 0, '零对账日志', `logs=${t.logs.length}`);
    assert(t.probeReads === 3 && t.vkReads.every((v) => v === 0x11), '三拍全读真值且 vk=0x11',
      `probeReads=${t.probeReads} vkReads=${JSON.stringify(t.vkReads)}`);
  }

  console.log('⑦ 钩子只见过 CtrlRight、真值两拍松开 ⇒ 左右两侧全部清零且推 down:false（W8=只清 left 会闩死右 Ctrl）');
  {
    const t = buildVm();
    t.track('CtrlRight', true); // 右 Ctrl 闩住（用户报的「右 Ctrl 闩死」形态）
    t.setKey(0);
    t.reconcile(); // 拍1
    t.reconcile(); // 拍2：纠正
    assert(t.pushes.length === 2 && t.pushes[1].payload.down === false, '恰好一次 down:false 推送',
      `pushes=${JSON.stringify(t.pushes)}`);
    const st = t.state();
    assert(st.left === false && st.right === false, '纠正后双侧清零（right 不许残留——只清 left 的回归在此红）',
      `state=${JSON.stringify(st)}`);
    assert(t.logs.length === 1 && t.logs[0].includes('Ctrl 状态对账'), '落一条对账日志', `logs=${t.logs.length}`);
  }

  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('脚本异常：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}
