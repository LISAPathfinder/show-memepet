// 重建/首屏「命中区宽限期」纯逻辑回归（1.0.58 立件；1.0.59 票 11-J 任务 2 适配离散数组、
// 任务 4 收口宽限∪生效窗口）
//
// 要修的真故障：锁屏解锁后主进程会重建桌宠窗口；新页面**首次上报的可交互盒是残缺的**——
// 左边那颗计数 chip 要等主进程下一次推送才存在。实机日志（2026-10-04）7 次解锁重建，
// 首报盒 7 次全是 `389,448 122x152`（只有脸），而稳态是 `320,44x 260x15x`：差的正是左半截计数。
// 光标停在那一截上 → 判「区域外」→ 穿透 → **用户第一次点击穿到桌面**，等元素渲染齐第二次才中。
//
// 修法（main.js）：建窗（含开机首建与一切重建）后开一段宽限期。1.0.59 起上报是**离散矩形数组**，
// 宽限∪ = 上报数组 ∪ 兜底视觉矩形（graceJudgeBoxes，离散并排不合成包围盒），且**只在重建后
// 首次同步（petSyncAfterRebuild）那一次生效**——「重建后最多多吞 2.5s」的旧上限缩到首判一拍；
// 常态出口不变：收到「总面积变大」的上报立刻收回，REBUILD_GRACE_MS 只兜「渲染端迟迟不上报」。
//
// 本件不复制实现：从 main.js 源码提取 PET_SIZE / PET_WINDOW_SIZE / visualSize / petVisualOffset /
// petFallbackBox / boxesArea / graceEndsOnReport / petBoxInUse / graceJudgeBoxes 各段，在 vm 沙箱里
// 注入状态后求值。断言里既有"该变宽"也有"该退出"，还有**正向对照**（提取不到新函数就红）——
// 只写否定式的守卫会因为文件改名或读不到而永远绿（PITFALLS §77）。
//
// 票 11-T 守卫（1.0.68）：「隐藏态被无重建地露出来」的分支定界 + 行为级断言——
// ① resyncPassThrough 的 recreate=false 分支体内必须出现 petHidden 判定，且 vm 行为级验证
//    隐藏态下 showInactive 零次（守卫删掉或写成 `if (false && petHidden)` 永不成立都红——
//    行为级才是牙齿，字面量级断言抓不死「守卫在但逻辑死」）；
// ② second-instance 回调体必须出现 petHidden 判定，行为级验证隐藏态改调 showPet、可见态仍走
//    petWindow.show()；
// ③ createPetWindow 必须 `show: !petHidden`（unlock/resume 重建不再把隐藏态露出来）；
// ④ logHiddenMismatch 对账函数在位且调用点 ≥4（hidePet/showPet/second-instance/resync）。
// 提取/定界失败一律红（改名、删函数不许静默跳过）。
//
// 票 11-T 提权兜底（1.0.71）：「提权重启后双击不显示」——装机日志实锤提权首实例（High IL）
// 收不到普通第二实例（Medium IL）的 second-instance（Windows 完整性策略 no-write-up 写不进
// High 的锁对象）。守卫⑤：写端立即退出分支必须带显隐请求哨兵写入；读端 bootApp 必须 fs.watch
// + handleShowRequest 三重门槛（时效/去重/petHidden）齐备，且行为级验证五用例（生效/过期/
// 让路/可见态/读空）。
//
// 票 11-U（1.0.72 后）：1.0.72 在 resync 体首行加了 `if (petPeekActive) endPetPeek(why)`（main.js:2219，
// 会话切换提前收场 peek），而 petPeekActive 是顶层 let（模块作用域）——运行时/`node --check` 都不报，
// 只有「抽函数体进 vm 沙箱」的件会炸（ReferenceError，件自身崩不是断言红）。沙箱补桩给**真语义**：
// 可读写的 petPeekActive + endPetPeek 计数桩（同构真函数：不活跃早退、活跃时翻记账 false），
// 不许塞个假值让件变绿。并把 peek×resync 耦合升成行为级断言：peek 活跃走 recreate=false ⇒
// endPetPeek 恰一次且记账翻回——删掉 main.js:2219 那行，这两条必红（此前删了它没有任何件会红）。
//
// 用法：node tools/verify-rebuild-grace.js [main.js 路径，默认仓库根 main.js]
// 退出码：0 = 断言全绿（末尾 PASS n/N）；1 = 断言不过或提取失败；1 + 「脚本异常：」= 本件自身出错。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'main.js'));

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  return null;
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{[^}]*\\};`));
  return m ? m[0] : null;
}
// 票 11-T：resyncPassThrough 是 `const 名字 = (...) => {` 箭头函数，extractFn 的
// function 声明匹配抓不到；按括号配平提取（模板串 ${...} 大括号天然成对，配平可靠）
function extractArrowFn(src, name) {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  return null;
}
// 票 11-T：提取 `app.on('<事件>', () => { ... })` 整段（含注册外壳与收尾 `)`/`;`，沙箱里用 app 桩接住回调）
function extractAppOnHandler(src, event) {
  const start = src.indexOf(`app.on('${event}', `);
  if (start < 0) return null;
  const arrow = src.indexOf('=>', start);
  if (arrow < 0) return null;
  const open = src.indexOf('{', arrow);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) {
        // 回调体配平后还要吃掉收尾的 `)`（和 `;`），否则段文本本身语法不完整，vm eval 必炸
        let end = i + 1;
        while (end < src.length && /\s/.test(src[end])) end++;
        if (src[end] === ')') {
          end++;
          while (end < src.length && /\s/.test(src[end])) end++;
          if (src[end] === ';') end++;
        }
        return src.slice(start, end);
      }
    }
  }
  return null;
}
function extractNumberConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = ([0-9.]+);`));
  return m ? Number(m[1]) : null;
}

// 票 11-T 实测教训：`show: !petHidden,` 属性行被突变删掉后，守卫正则仍命中 main.js 注释里的
// 「show:!petHidden 从建窗点就保持隐藏」——结构断言假绿（R3 红法当场抓出）。所有字面量断言
// 一律先剥行注释再匹配；代价是字符串里含 `//`（如 URL）会被误剥，本三段源码内无此形态，
// 且误剥方向只会让守卫更严（宁红勿假绿）。
function stripLineComments(s) {
  return s
    .split('\n')
    .map((l) => {
      const idx = l.indexOf('//');
      return idx >= 0 ? l.slice(0, idx) : l;
    })
    .join('\n');
}

let total = 0;
let failed = 0;
function check(name, ok, detail) {
  total++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

// 实机读数（取自装机版自己那本运行日志——文件名一律走 identity，注释里也不写字面量，见 §72）
const FIRST = [{ x: 389, y: 448, width: 122, height: 152 }]; // 解锁后首报：只有脸（数组形态）
const STEADY = [{ x: 320, y: 443, width: 260, height: 157 }]; // 计数渲染完的稳态盒
const COUNTER_POINT = { x: 330, y: 470 }; // 计数 chip 所在处：首报盒外、稳态盒内
const FAR_POINT = { x: 100, y: 100 }; // 窗口左上角的透明空白：并集也该放过它
const FACE_POINT = { x: 450, y: 500 }; // 脸上：三态都应在内

// 测试侧的命中判定（此处不带余量以严格考盒本身；含余量的语义由 verify-hit-region 考）
const inside = (rects, p) =>
  rects.some((r) => !!r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height);

try {
  const src = fs.readFileSync(mainPath, 'utf8');

  // ---- 提取（正向对照：少了任何一段就说明实现被改名或删除）----
  const parts = {
    petSize: extractConst(src, 'PET_SIZE'),
    winSize: extractConst(src, 'PET_WINDOW_SIZE'),
    visualSize: extractFn(src, 'visualSize'),
    petVisualOffset: extractFn(src, 'petVisualOffset'),
    petFallbackBox: extractFn(src, 'petFallbackBox'),
    boxesArea: extractFn(src, 'boxesArea'),
    graceEndsOnReport: extractFn(src, 'graceEndsOnReport'),
    petBoxInUse: extractFn(src, 'petBoxInUse'),
    graceJudgeBoxes: extractFn(src, 'graceJudgeBoxes'),
  };
  const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
  check('main.js 里能提取到全部所需定义', missing.length === 0, missing.length ? `缺 ${missing.join('/')}` : '9 段齐全');
  const GRACE = extractNumberConst(src, 'REBUILD_GRACE_MS');
  check('REBUILD_GRACE_MS 常量存在且是正数', typeof GRACE === 'number' && GRACE > 0, `值=${GRACE}`);
  check(
    '宽限期在建窗唯一入口赋值（createPetWindow 内设 petRebuildGraceUntil）',
    /function createPetWindow\([^)]*\)[\s\S]{0,900}?petRebuildGraceUntil = Date\.now\(\) \+ REBUILD_GRACE_MS;/.test(src),
    '否则开机首建/解锁重建/托盘显示三条路只补了一条'
  );
  check(
    '宽限∪只在重建后首次同步生效（syncPetPassThrough 里 wide = petSyncAfterRebuild && 未超时）',
    /const wide = petSyncAfterRebuild && now < petRebuildGraceUntil;/.test(src),
    '否则宽限∪退化回 2500ms 时间窗全程并兜底（票 11-J 任务 4 收口被回退）'
  );
  if (missing.length || typeof GRACE !== 'number') {
    console.log(`PASS ${total - failed}/${total}`);
    process.exit(1);
  }

  // ---- 票 11-T 守卫：隐藏态不得被无重建地露出来（分支/函数体定界 + 行为级）----
  const resyncBody = extractArrowFn(src, 'resyncPassThrough');
  check('票 11-T：resyncPassThrough 函数体可提取（改名/删除必红，不许静默跳过）',
    !!resyncBody, resyncBody ? `${resyncBody.length} 字符` : '提取失败');
  const secondInstanceSeg = extractAppOnHandler(src, 'second-instance');
  check('票 11-T：second-instance 注册段可提取',
    !!secondInstanceSeg, secondInstanceSeg ? `${secondInstanceSeg.length} 字符` : '提取失败');
  const createBody = extractFn(src, 'createPetWindow');
  check('票 11-T：createPetWindow 函数体可提取',
    !!createBody, createBody ? `${createBody.length} 字符` : '提取失败');

  if (resyncBody) {
    const branchAnchor = 'if (recreate) {';
    const branchIdx = resyncBody.indexOf(branchAnchor);
    check('resyncPassThrough 体内能找到 if (recreate) 分支定界锚', branchIdx >= 0,
      branchIdx >= 0 ? '在位' : '锚丢失（分支结构被改时必须红，不许绿灯）');
    if (branchIdx >= 0) {
      let depth = 0;
      let close = -1;
      for (let k = resyncBody.indexOf('{', branchIdx); k < resyncBody.length; k++) {
        if (resyncBody[k] === '{') depth++;
        else if (resyncBody[k] === '}') {
          depth--;
          if (!depth) { close = k; break; }
        }
      }
      const elseBody = close >= 0 ? stripLineComments(resyncBody.slice(close + 1)) : null;
      check('recreate=false 分支体定界成功（闭括号后非空残段）',
        !!elseBody && elseBody.length > 50, elseBody ? `${elseBody.length} 字符` : '定界失败');
      check(
        'recreate=false 分支体内必须出现 petHidden 判定（锁屏/睡眠不再把隐藏态 showInactive 出来）',
        !!elseBody && /petHidden/.test(elseBody),
        '删守卫或把判定挪出该分支都会红（全局 includes 是恒绿守卫，main.js 本有 5 处 petHidden）'
      );

      // 行为级（牙齿）：字面量在但逻辑死（如 if (false && petHidden)）在这里红
      const runResync = (hiddenVal, peekActive) => {
        const calls = { showInactive: 0, nativeIgnore: 0, alwaysOnTop: 0, recreate: 0, endPeek: 0 };
        const sandbox = {
          petHidden: hiddenVal,
          // 票 11-U：resync 体首行引用顶层 let petPeekActive（main.js:2219），模块作用域变量
          // 不随函数体提取进沙箱，必须补桩否则 ReferenceError（件自身崩）。给可读写真值，不塞死值。
          petPeekActive: !!peekActive,
          petSyncAfterRebuild: false,
          petIgnoreSent: 1,
          petOutsideSince: 1,
          petInteractiveBox: { x: 1 },
          petWindow: {
            isDestroyed: () => false,
            showInactive: () => calls.showInactive++,
            setAlwaysOnTop: () => calls.alwaysOnTop++,
          },
          anchorWindow: null,
          nativeSetIgnoreMouseEvents: () => calls.nativeIgnore++,
          recreatePetWindow: () => calls.recreate++,
          sendToPet: () => {},
          pingPet: () => {},
          syncPetPassThrough: () => {},
          logLine: () => {},
          logHiddenMismatch: () => {},
          setTimeout: () => 0,
        };
        // endPetPeek 桩与真函数（main.js:2726-2727）同构：不活跃早退，活跃时计数并翻记账 false
        sandbox.endPetPeek = () => {
          if (!sandbox.petPeekActive) return;
          calls.endPeek++;
          sandbox.petPeekActive = false;
        };
        vm.createContext(sandbox);
        vm.runInContext(resyncBody, sandbox, { filename: 'main.js[resync]' });
        vm.runInContext('resyncPassThrough("沙箱", false)', sandbox);
        return Object.assign({}, calls, { peekActiveAfter: sandbox.petPeekActive });
      };
      const rHidden = runResync(true);
      check(
        '行为级：隐藏态走 recreate=false 路径，showInactive 必须零次（穿透/置顶兜底照做不缺席）',
        rHidden.showInactive === 0 && rHidden.nativeIgnore === 1 && rHidden.alwaysOnTop === 1,
        JSON.stringify(rHidden)
      );
      const rVisible = runResync(false);
      check(
        '行为级：可见态走 recreate=false 路径，showInactive 照常一次（正常锁屏不误伤）',
        rVisible.showInactive === 1, JSON.stringify(rVisible)
      );
      // 票 11-U：peek×resync 耦合升断言。1.0.72 起 resync 体首行 `if (petPeekActive) endPetPeek(why)`
      // （main.js:2219，会话切换路径提前收场 peek，别跟它抢窗口状态）——删掉这行此前没有任何件会红。
      // 红法：删 main.js:2219 ⇒ 下面两条必红（endPeek 归零、记账停在 true）。
      const rPeekHidden = runResync(true, true);
      check(
        '行为级（票 11-U）：peek 活跃 + 隐藏态走 recreate=false 路径——endPetPeek 恰一次、petPeekActive 翻回 false，且仍不 showInactive（11-T 保持隐藏语义在 peek 收场路径上不回退）',
        rPeekHidden.endPeek === 1 && rPeekHidden.showInactive === 0 && rPeekHidden.peekActiveAfter === false,
        JSON.stringify(rPeekHidden)
      );
      const rPeekVisible = runResync(false, true);
      check(
        '行为级（票 11-U）：peek 活跃 + 可见态走 recreate=false 路径——endPetPeek 恰一次且翻记账，正常 resync 行为（showInactive/穿透/置顶）不因 peek 收场缺席',
        rPeekVisible.endPeek === 1 && rPeekVisible.showInactive === 1 &&
          rPeekVisible.nativeIgnore === 1 && rPeekVisible.alwaysOnTop === 1 && rPeekVisible.peekActiveAfter === false,
        JSON.stringify(rPeekVisible)
      );
    }
  }

  check(
    'second-instance 回调体内必须出现 petHidden 判定（隐藏时改调 showPet，不再无条件 show）',
    !!secondInstanceSeg && /petHidden/.test(stripLineComments(secondInstanceSeg)),
    '删守卫即红'
  );
  if (secondInstanceSeg) {
    const T0 = 1e9; // 模拟时间戳基点：真实 lastSecondInstanceAt 初值 0、真时钟巨大值（首拍必当真），沙箱同构
    const runSecond = (hiddenVal, schedule, adminQuit) => {
      const calls = { show: 0, showPet: 0, quit: 0 };
      const logs = [];
      const sandbox = {
        adminRelaunchPending: !!adminQuit,
        petHidden: hiddenVal,
        petWindow: { isDestroyed: () => false, show: () => calls.show++ },
        showPet: () => calls.showPet++,
        logHiddenMismatch: () => {},
        logLine: (s) => logs.push(String(s)),
        Date: { now: () => sandbox.__now }, // 可控时钟：模拟 400ms 一拍的 retry 风暴
        __now: 0,
        // main.js 里这两个 let 声明在 app.on 之前的外层块，不在提取段内，沙箱补齐
        lastSecondInstanceAt: 0,
        secondInstanceDebounced: 0,
      };
      sandbox.app = { on: (_evt, fn) => { sandbox.__handler = fn; }, quit: () => calls.quit++ };
      vm.createContext(sandbox);
      vm.runInContext(secondInstanceSeg, sandbox, { filename: 'main.js[second-instance]' });
      if (typeof sandbox.__handler !== 'function') return null; // 未注册 → 调用方红
      for (const t of schedule) {
        sandbox.__now = t;
        sandbox.__handler();
      }
      return { calls, logs };
    };
    const sHidden = runSecond(true, [T0]);
    check(
      '行为级：隐藏态 second-instance 必须改调 showPet（重建显示），不得 petWindow.show()',
      !!sHidden && sHidden.calls.showPet === 1 && sHidden.calls.show === 0, JSON.stringify(sHidden.calls)
    );
    const sVisible = runSecond(false, [T0]);
    check(
      '行为级：可见态 second-instance 照旧 petWindow.show()（不做多余重建）',
      !!sVisible && sVisible.calls.show === 1 && sVisible.calls.showPet === 0, JSON.stringify(sVisible.calls)
    );
    // 票 11-T 回归（1.0.69）：第二实例 retry 风暴——抢锁失败后 400ms 一拍重复 emit
    // second-instance，隐藏态每拍都被 showPet 顶出来（装机实测「隐藏→托盘显示：重建」
    // 交替 8+ 轮直到 20s 风暴结束）。这里用可控时钟重放风暴，锁死活动窗去抖。
    // 时间戳从 1e9 起算：真实 lastSecondInstanceAt 初值 0、真时钟是巨大值（首拍必当真），
    // 沙箱也从大时间戳起跑，语义同构。
    const stormT = [];
    for (let t = 400; t <= 19600; t += 400) stormT.push(T0 + t);
    const sStorm = runSecond(true, [T0, ...stormT, T0 + 22200]);
    check(
      '行为级：20s retry 风暴（400ms×49 拍）里 showPet 只在首拍+安静后尾拍各执行一次，49 拍全去抖（活动窗去抖在位）',
      !!sStorm && sStorm.calls.showPet === 2 && sStorm.calls.show === 0 && sStorm.logs.length === stormT.length,
      `showPet=${sStorm && sStorm.calls.showPet} 去抖日志=${sStorm && sStorm.logs.length}/${stormT.length}`
    );
    check(
      '行为级：风暴结束安静 2.6s 后的 second-instance 重新当真（去抖不许永久吞掉真双击）',
      !!sStorm && sStorm.calls.showPet === 2, `showPet=${sStorm && sStorm.calls.showPet}`
    );
    const sQuitEarly = runSecond(true, [T0 + 400], true);
    check(
      '行为级：提权让位（adminRelaunchPending）不经过去抖——首拍即 400ms 内也立即 quit',
      !!sQuitEarly && sQuitEarly.calls.quit === 1, `quit=${sQuitEarly && sQuitEarly.calls.quit}`
    );
  }

  check(
    'createPetWindow 建窗 show 位必须挂在 petHidden 上（show: !petHidden——unlock/resume 重建不再露出隐藏态）',
    !!createBody && /show:\s*!petHidden\s*,/.test(stripLineComments(createBody)),
    '改成无条件 show、写成 false && !petHidden 这类永不成立表达式都红（行注释已剥离，注释字面量不再顶数）'
  );
  {
    const mismatchDef = /function logHiddenMismatch\(/.test(src);
    const mismatchCalls = (src.match(/logHiddenMismatch\(/g) || []).length - (mismatchDef ? 1 : 0);
    check(
      'petHidden 对账函数 logHiddenMismatch 在位且调用点 ≥4（hidePet/showPet/second-instance/resync）',
      mismatchDef && mismatchCalls >= 4,
      `定义${mismatchDef ? '在位' : '缺失'}，调用 ${mismatchCalls} 处`
    );
  }

  // 票 11-T 回归根修（1.0.70）：抢锁失败的 400ms retry 只留给提权产物实例——普通双击的第二
  // 实例立即退出。retry 每拍都会在首实例 emit second-instance，不门槛化就会制造持续刷新
  // 去抖基准的风暴（1.0.69 实测 37s，期间用户全部真双击被吞）。
  {
    const gateIdx = src.indexOf('process.argv.includes(ELEVATED_AUTOSTART_ARG)');
    const retryIdx = src.indexOf('const retry = setInterval');
    check(
      '抢锁失败分支：retry 必须被提权标志门槛化（argv.includes(ELEVATED_AUTOSTART_ARG) 在 retry 定义之前且同块）',
      gateIdx >= 0 && retryIdx > gateIdx && retryIdx - gateIdx < 2000,
      gateIdx >= 0 ? `门槛在位（距 retry 定义 ${retryIdx - gateIdx} 字符）` : '门槛缺失（retry 对所有第二实例开放时必红）'
    );
    check(
      '抢锁失败分支：非提权第二实例必须立即退出（剥离注释后仍含立即退出日志行）',
      /second-instance 抢锁失败且非提权产物实例/.test(stripLineComments(src)),
      '删立即退出分支（恢复无条件 retry）即红'
    );
  }

  // 票 11-T 提权兜底（1.0.71）：1.0.70 复测「提权重启后双击不显示」——装机日志实锤提权首实例
  // （High IL）收不到普通第二实例（Medium IL）的 second-instance：Windows 完整性策略
  // no-write-up，Medium 写不进 High 持有的单实例锁对象；反向 High→Medium 不受限所以提权交接
  // 正常。修法=文件哨兵：第二实例退出前写带时间戳的显隐请求，首实例 fs.watch 到后按三重门槛
  // （时效 / second-instance 去重 / petHidden）补走 showPet。
  {
    const flat = stripLineComments(src);
    const writeAnchor = flat.indexOf("logLine('second-instance 抢锁失败且非提权产物实例");
    const writeQuit = writeAnchor >= 0 ? flat.indexOf('app.quit();', writeAnchor) : -1;
    const writeSeg = writeAnchor >= 0 && writeQuit > writeAnchor ? flat.slice(writeAnchor, writeQuit) : null;
    check(
      '哨兵写端：立即退出分支在 app.quit() 前写显隐请求哨兵（writeFileSync + SHOW_REQUEST_NAME）',
      !!writeSeg && writeSeg.includes('fs.writeFileSync') && writeSeg.includes('identity.SHOW_REQUEST_NAME'),
      writeSeg ? '写端在位' : '删哨兵写（恢复 1.0.70 裸退出）即红——提权首实例将永远收不到双击'
    );
    const bootBody = extractFn(src, 'bootApp');
    check(
      '哨兵读端：bootApp 体内启动显隐请求监听（fs.watch(config.DATA_DIR) + SHOW_REQUEST_NAME）',
      !!bootBody && /fs\.watch\(config\.DATA_DIR/.test(stripLineComments(bootBody)) &&
        stripLineComments(bootBody).includes('identity.SHOW_REQUEST_NAME'),
      '删监听即红（兜底通道消失，提权后双击回到无响应）'
    );
    const handleBody = extractArrowFn(src, 'handleShowRequest');
    check('哨兵读端：handleShowRequest 函数体可提取（改名/删除必红，不许静默跳过）',
      !!handleBody, handleBody ? `${handleBody.length} 字符` : '提取失败');
    if (handleBody) {
      const hb = stripLineComments(handleBody);
      check(
        '哨兵读端：三重门槛在位（时效 req.at / second-instance 去重 lastSecondInstanceAt / 隐藏态 petHidden）',
        hb.includes('req.at') && hb.includes('lastSecondInstanceAt') && hb.includes('petHidden'),
        '任一门槛被删都红'
      );
      // 行为级（牙齿）：门槛在但逻辑死（如改成 1e9 时效、恒 false 条件）在这里红
      const runHandle = (opts) => {
        const calls = { showPet: 0, unlink: 0 };
        const sandbox = {
          fs: {
            readFileSync: opts.broken
              ? () => { throw new Error('boom'); }
              : () => JSON.stringify({ at: opts.at }),
            unlinkSync: () => calls.unlink++,
          },
          path: require('path'),
          config: { DATA_DIR: '<DATA_DIR>' },
          identity: { SHOW_REQUEST_NAME: '<SHOW_REQUEST>' },
          Date: { now: () => opts.now },
          lastSecondInstanceAt: opts.lastSi,
          petHidden: opts.hidden,
          showPet: () => calls.showPet++,
          logLine: () => {},
        };
        vm.createContext(sandbox);
        vm.runInContext(handleBody, sandbox, { filename: 'main.js[handleShowRequest]' });
        vm.runInContext('handleShowRequest()', sandbox);
        return calls;
      };
      const h1 = runHandle({ at: 5000, now: 6000, lastSi: 0, hidden: true });
      check(
        '行为级：新鲜请求+隐藏态+锁通道安静 → showPet 恰一次且哨兵文件被删',
        h1.showPet === 1 && h1.unlink === 1, JSON.stringify(h1)
      );
      const h2 = runHandle({ at: -15000, now: 0, lastSi: -100000, hidden: true });
      check(
        '行为级：超过 10s 的残留请求不认（时效门槛——上次会话的旧文件不得顶数）',
        h2.showPet === 0, JSON.stringify(h2)
      );
      const h3 = runHandle({ at: 5000, now: 6000, lastSi: 5000, hidden: true });
      check(
        '行为级：2500ms 内来过 second-instance 时哨兵让路（去重门槛——普通实例下锁通道先到先办）',
        h3.showPet === 0, JSON.stringify(h3)
      );
      const h4 = runHandle({ at: 5000, now: 6000, lastSi: 0, hidden: false });
      check(
        '行为级：可见态收到哨兵不动作（显示态双击本就可见，动了只是多余重建）',
        h4.showPet === 0, JSON.stringify(h4)
      );
      const h5 = runHandle({ broken: true, at: 5000, now: 6000, lastSi: 0, hidden: true });
      check(
        '行为级：哨兵文件读不到时不崩不动作（半截写/已删的竞态）',
        h5.showPet === 0 && h5.unlink === 0, JSON.stringify(h5)
      );
    }
  }

  // ---- 沙箱：注入状态，跑真函数的派生结果 ----
  const ctx = {
    __box: null, // 数组或 null（渲染端上报）
    __graceUntil: 0,
    __scale: 1,
    petInteractiveBox: null,
    petRebuildGraceUntil: 0,
  };
  ctx.Date = { now: () => ctx.__now };
  vm.createContext(ctx);
  const boot = [
    parts.petSize,
    parts.winSize,
    parts.visualSize,
    parts.petVisualOffset,
    parts.petFallbackBox,
    parts.boxesArea,
    parts.graceEndsOnReport,
    parts.petBoxInUse,
    parts.graceJudgeBoxes,
    'function petScale() { return __scale; }',
    'function boxNow() { petInteractiveBox = __box; petRebuildGraceUntil = __graceUntil; return petBoxInUse(); }',
    'function judgeNow(report) { petInteractiveBox = report; return graceJudgeBoxes(report, __scale); }',
    'function graceNow(p, n, now, until) { return graceEndsOnReport(p, n, now, until); }',
  ].join('\n');
  vm.runInContext(boot, ctx);
  const boxAt = (arr, until, now, scale) => {
    ctx.__box = arr;
    ctx.__graceUntil = until;
    ctx.__now = now;
    ctx.__scale = scale === undefined ? 1 : scale;
    return vm.runInContext('boxNow()', ctx);
  };
  const judgeAt = (report, scale) => {
    ctx.__scale = scale === undefined ? 1 : scale;
    return vm.runInContext(`judgeNow(${JSON.stringify(report)})`, ctx);
  };
  const grace = (p, n, now, until) => {
    ctx.__now = now;
    return vm.runInContext(`graceNow(${JSON.stringify(p)}, ${JSON.stringify(n)}, ${now}, ${until})`, ctx);
  };

  // ---- 断言：宽限∪（首判一次）----
  const j1 = judgeAt(FIRST, 1);
  check(
    '首判宽限∪：首报残缺盒与兜底**离散并排**（长度 2，不合成包围盒），计数 chip 那点算在区域内（第一次点击不再丢）',
    Array.isArray(j1) && j1.length === 2 && inside(j1, COUNTER_POINT) === true,
    `判定盒=${JSON.stringify(j1)}`
  );
  check('首判宽限∪：脸上照旧命中', inside(j1, FACE_POINT) === true, `判定盒=${JSON.stringify(j1)}`);
  check(
    '首判宽限∪：窗口左上透明空白仍判区域外（宽限≠整窗可点，穿透语义没被废掉）',
    inside(j1, FAR_POINT) === false,
    `判定盒=${JSON.stringify(j1)}`
  );
  const j0 = judgeAt(null, 1);
  check('渲染端没上报时首判就是兜底盒本身（单盒数组）', j0.length === 1 && j0[0].x === 300 && j0[0].width === 300, JSON.stringify(j0));

  // ---- 断言：常态判定不再并兜底（宽限∪收口的另一面）----
  const u = boxAt(FIRST, 1000, 0, 1); // 宽限计时未过期，但 petBoxInUse 常态只回上报数组
  check(
    '常态判定（petBoxInUse）：宽限计时未过期也**不再并兜底**，命中区=上报数组原样（收口生效）',
    Array.isArray(u) && u.length === 1 && u[0].width === FIRST[0].width,
    `常态=${JSON.stringify(u)}`
  );
  check(
    '常态判定：计数 chip 那点重新变成区域外（兜底只在首判那一次，不永久放大）',
    inside(u, COUNTER_POINT) === false,
    `常态=${JSON.stringify(u)}`
  );

  const steady = boxAt(STEADY, 0, 5000, 1);
  check(
    '宽限结束后收到稳态盒：按上报数组判定，不无谓并大',
    steady.length === 1 && steady[0].width === STEADY[0].width && steady[0].height === STEADY[0].height,
    JSON.stringify(steady)
  );

  const noReport = boxAt(null, 1000, 0, 1);
  check(
    '上报尚未到达时用兜底视觉矩形（1.0.56 票 11-G 语义未退化）',
    noReport.length === 1 && noReport[0].x === 300 && noReport[0].y === 300 && noReport[0].width === 300 && noReport[0].height === 300,
    JSON.stringify(noReport)
  );

  const half = boxAt([{ x: 490, y: 520, width: 61, height: 76 }], 1000, 0, 0.5); // scale=0.5 的残缺首报
  check(
    'scale=0.5 时首判宽限∪的兜底部分右下角贴住窗口右下角 (600,600)（随 scale 派生，不是固定 300×300）',
    judgeAt([{ x: 490, y: 520, width: 61, height: 76 }], 0.5).some((r) => r.x + r.width === 600 && r.y + r.height === 600) &&
      half.length === 1,
    `常态=${JSON.stringify(half)}`
  );

  // ---- 断言：面积变大收口（Σ 语义）----
  check('宽限内「总面积变大」的上报提前结束宽限', grace(FIRST, STEADY, 100, GRACE) === true, '18544 → 40820');
  check('面积变小不该结束宽限', grace(STEADY, FIRST, 100, GRACE) === false, '稳态 → 残缺');
  check(
    '数组语义：两个小盒合计 20000 > 首报 18544 也算「变大」（Σ 而非单盒宽×高）',
    grace(FIRST, [{ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }], 100, GRACE) === true,
    '离散多盒的合计面积'
  );
  check('宽限已过期时不再判结束', grace(FIRST, STEADY, GRACE + 1, GRACE) === false, 'now>until');
  check('缺任一侧时不崩也不误结束', grace(null, STEADY, 0, GRACE) === false && grace(FIRST, null, 0, GRACE) === false, 'prev/next 为空');

  console.log(`PASS ${total - failed}/${total}`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exit(1);
}
