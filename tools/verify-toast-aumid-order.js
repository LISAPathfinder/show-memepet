// @runtime: ci —— 纯 node 源码级 + vm 行为级判据件（票 14-S 任务 3）：toast 归属名的**顺序不变量**；
//   执行面在 run-ci.js（ci.yml 动态解析），零第三方依赖、不起实例、不碰注册表。
//
// ★ 能力边界（必须先看这段，否则会把本件读成「归属名已验证」——那就是本票要消灭的假守卫）：
//   **本件判不了通知中心里显示的是不是这个名字。** 归属名在本机没有任何自动判据面（探针实测：
//   ToastNotifier.Setting 经 PS 5.1 投影读回**空串**；History.GetNotifications() 抛**空引用**）。
//   显示名对不对只有人工看通知中心这一条路。本件只判两件事：
//   ①**注册函数的行为**（vm 里真调 main.js 的 ensureAumidDisplayName，桩掉 execFileSync 看它到底
//     调了什么 argv、落了什么日志）：三态措辞可区分、写入的注册表键名/值名/值内容、**同步完成**；
//   ②**启动流里的先后**（按 bootApp 函数体定界、按行号比较）：注册调用点必须早于任何能发通知的调用点。
//   顺序之所以是判据：shell 在某 AUMID 的**第一条**通知落地时就解析并缓存归属名，之后补写键不会回头改
//   （探针三档实测：先写键再发 ⇒ 组头显示 DisplayName；不写键 ⇒ 裸 AUMID；先发再写 ⇒ 永久停在裸 AUMID）。
//
// 断言（每条标「哪次改动会让它红」，§77① 正向对照义务——纯否定式守卫在文件读不到时不许变绿）：
//   P  三锚点：件内 PINNED 字面 ↔ identity.APP_ID ↔ package.json build.appId ↔ main.js 里键的构造式
//      （红于：换 AUMID 时 main.js 跟着漂——同一条表达式与 identity 比对是同源恒真，只有这份独立拍照红；
//        也红于红法 S-b「写了个 AUMID 对不上的键名」）
//   B1 dev 短路：app.isPackaged=false ⇒ 零 reg 调用零日志（红于：摘掉那道 guard，dev 会写真 HKCU）
//   B2 键已在：query 不抛 ⇒ 只 1 条 argv 且 == ['query', 钉死键]；日志含「键已在（本次未写）」、
//      不含「本次已写入」不含「生效」（红于：把「没写」说成「写了」）
//   B3 补写：query 抛 ⇒ 第 2 条 argv 逐项 == ['add', 钉死键,'/v','DisplayName','/d','Showcase','/t','REG_SZ','/f']；
//      日志含「本次已写入」（红于：错键名/错值名/裸产品名不取自 identity）
//   B4 失败分支：add 也抛 ⇒ 日志含「写入失败」、不含「本次已写入」「生效」
//      （红法 S1：把 reg add 的失败分支也打成「已写入」——本条当场红）
//   B5 同步完成：execFile（异步回调版）调用数恒 0，且 run() **返回时**日志已落定
//      （红于：退回异步 execFile / 用 setTimeout 赌时序——票面明令禁止的形态）
//   B6 耗时读数在位：三态日志都匹配 /耗时 <数字>ms/（红于：删掉任务 2 要求留下的实测耗时读数）
//   B7 判据面自述在位：三态日志都含「无自动判据面」（红于：删掉这句——下一个人会重新把它读成显示名判据）
//   C1 通知点拍照：main.js 代码行里 `new Notification(` 出现数 == 1，且所在函数 ==
//      sendReminderWindowsNotification（红于：新增第二个通知点/挪进更早的函数——届时必须扩本件）
//   C2 可达集拍照：体内有通知点的函数 ∪ 体内直接调用它们的函数 == 件内钉死的两件套
//      （红于：多一条调度链＝集合变化，逼作者回来确认新链是否也在注册之后）
//   C3 顺序（本票灵魂，红法 S-a）：bootApp 体内「注册调用那一行」的行号 < 体内每一个可发通知调用点
//      的行号（把注册调用挪到 restartReminder 之后 ⇒ 本条红）
//   C4 正向对照：bootApp 体内必须真有且只有 1 处注册调用，且可达集成员也真在体内
//      （缺 C4 时 C3 在「两边都不存在」的空集上恒绿）
//   C5/C6 措辞禁串：注册函数体内（剔注释行）不出现「生效」；全文（剔注释行）不出现旧措辞
//      「通知归属名生效」（红于：S1 那种把写入成功写成归属名生效的回归）
//   注释行剔除是逐行启发式（行首 // 或 * ）：只用于「在/不在」判定，不用于顺序——顺序一律按行号。
//
// 红法读数在票 14-S「执行记录」；突变一律 %TEMP% 整仓副本 + **绝对路径**影子根（§104 同族：
//   传相对影子根会骗过前置、跑到深处的 require 才炸，症状是一次活红而不是 exit 3）。
//
// 用法：node tools/verify-toast-aumid-order.js [仓库根，默认 cwd]
// 退出码：0 全绿 / 1 断言失败（脚本自身异常也落 1，stderr 打「脚本异常：<原因>」）/
//         3 前置不满足（main.js 或 identity.js/package.json 读不到、目标函数提取失败＝函数被改名，
//         断言不许静默跳过）。判定面 0/1/3，无装置面 2（铁律 3）；
//   纯逻辑件：不接实例、无占用自检（票 11-G 硬约束——给 CI 纯逻辑件加 exit 3 前置＝自己造红灯）。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(process.argv[2] || process.cwd());
const blocked = (msg) => {
  console.error(`前置不满足（exit 3）：${msg}`);
  process.exit(3);
};

// ---- 件内拍照（第三锚点，2026-10-27 现算 HEAD 59bd368）----
// 换 appId / 产品名是有意识的决策，必须连这张表与本票一起改（build.files 登记、checkJs 基线同款棘轮纪律）。
const PINNED = {
  AUMID: 'com.showcase.app',
  PRODUCT_NAME: 'Showcase',
  REG_PREFIX: 'HKCU\\Software\\Classes\\AppUserModelId\\',
  VALUE_NAME: 'DisplayName',
  VALUE_TYPE: 'REG_SZ',
  NOTIFY_CALL_SITES: 1,
  NOTIFY_FN: 'sendReminderWindowsNotification',
  REACHABLE: ['restartReminder', 'sendReminderWindowsNotification'], // 排序后比较
};
const PINNED_KEY = PINNED.REG_PREFIX + PINNED.AUMID;

const mainPath = path.join(root, 'main.js');
if (!fs.existsSync(mainPath)) blocked(`${mainPath} 不存在——读不到源码不许打绿灯`);
const src = fs.readFileSync(mainPath, 'utf8').replace(/\r/g, '');
let identity;
try {
  identity = require(path.join(root, 'identity.js'));
} catch (e) {
  blocked(`identity.js 取不到（${e.message}）——三锚点少一条`);
}
const pkgPath = path.join(root, 'package.json');
if (!fs.existsSync(pkgPath)) blocked(`package.json 不存在（${pkgPath}）`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const isCommentLine = (t) => /^\s*\/\//.test(t) || /^\s*\*/.test(t) || /^\s*\/\*/.test(t);
// 剔注释行的文本只用于「在/不在」判定（不保序、不保偏移）
const stripComments = (text) => text.split('\n').filter((t) => !isCommentLine(t)).join('\n');
const codeSrc = stripComments(src);

// 括号配对提取函数体（verify-ctrl-reconcile / verify-unlock-position 同款手法）
function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let depth = 0;
  const open = src.indexOf('{', i);
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  return null;
}
// 全文函数定义区间（{ 配平），用于「这一处通知点落在哪个函数体内」
function fnRanges() {
  const out = [];
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (let m; (m = re.exec(src));) {
    const open = src.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}' && --depth === 0) {
        out.push({ name: m[1], start: m.index, end: k });
        break;
      }
    }
  }
  return out;
}
const lineOfIndex = (idx) => src.slice(0, idx).split('\n').length;

const regFn = extractFn('ensureAumidDisplayName');
const bootFn = extractFn('bootApp');
const MISSING = [['ensureAumidDisplayName', regFn], ['bootApp', bootFn]].filter(([, v]) => !v).map(([k]) => k);
if (MISSING.length) blocked(`目标块提取失败（${MISSING.join('/')}）——函数被改名/删除时断言不许静默跳过`);
const bootStartLine = lineOfIndex(src.indexOf(bootFn));
// bootApp 的「代码行」带绝对行号（顺序判定只用行号，不用偏移）
const bootCodeLines = bootFn
  .split('\n')
  .map((t, i) => ({ n: bootStartLine + i, code: t }))
  .filter(({ code }) => !isCommentLine(code));

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
const sameArgs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- vm 沙箱：桩掉 child_process，看函数真调了什么 argv、落了什么日志 ----
function buildVm({ isPackaged = true, queryThrows = false, addThrows = false } = {}) {
  const calls = [];
  const logs = [];
  let asyncCalls = 0;
  const sandbox = {
    app: { isPackaged },
    identity,
    logLine: (s) => logs.push(String(s)),
    process, // 提供 hrtime.bigint（宿主单调时钟，与产品同款 API）
    execFile: () => {
      asyncCalls++;
    },
    execFileSync: (cmd, args) => {
      calls.push({ cmd, args });
      const isAdd = args[0] === 'add';
      if ((isAdd && addThrows) || (!isAdd && queryThrows)) throw Object.assign(new Error(`桩：${cmd} 非零退出`), { status: 1 });
      return '';
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(regFn, sandbox, { filename: 'main.js[vm]' });
  return {
    calls,
    logs,
    get asyncCalls() {
      return asyncCalls;
    },
    run: () => sandbox.ensureAumidDisplayName(),
  };
}

console.log(`仓库根：${root}`);
console.log('★ 能力边界：本件判不了「通知中心显示的是不是这个名字」——归属名无自动判据面（Setting 读回空串／History 抛空引用）。');
console.log('  本件只判：①注册函数的行为（三态措辞／写入键名／同步完成）②bootApp 内注册调用点早于任何可发通知的调用点。');

try {
  console.log('P 三锚点（件内拍照 ↔ identity.js ↔ package.json ↔ main.js 的键构造式）');
  assert(identity.APP_ID === PINNED.AUMID, 'identity.APP_ID == 件内钉死 AUMID', `${identity.APP_ID}`);
  assert(identity.PRODUCT_NAME === PINNED.PRODUCT_NAME, 'identity.PRODUCT_NAME == 件内钉死产品名', `${identity.PRODUCT_NAME}`);
  assert(pkg.build && pkg.build.appId === PINNED.AUMID, 'package.json build.appId == 件内钉死 AUMID', pkg.build ? `${pkg.build.appId}` : '无 build.appId');
  const keyExpr = (regFn.match(/const key = ([^;]+);/) || [, ''])[1];
  assert(/'HKCU\\\\Software\\\\Classes\\\\AppUserModelId\\\\'\s*\+\s*identity\.APP_ID/.test(keyExpr),
    'main.js 的键 == 注册表前缀字面 ⊕ identity.APP_ID（不是别处来的键名）', keyExpr.slice(0, 90));

  console.log('B1 dev 短路（app.isPackaged=false 一律不碰注册表）');
  {
    const t = buildVm({ isPackaged: false });
    t.run();
    assert(t.calls.length === 0 && t.asyncCalls === 0 && t.logs.length === 0, 'dev 下零 reg 调用零日志',
      `calls=${t.calls.length} async=${t.asyncCalls} logs=${t.logs.length}`);
  }

  console.log('B2 键已在（query 成功）');
  {
    const t = buildVm();
    t.run();
    assert(t.calls.length === 1 && t.calls[0].cmd === 'reg' && sameArgs(t.calls[0].args, ['query', PINNED_KEY]),
      '只调用一次 reg query 且键名 == 钉死键', JSON.stringify(t.calls[0] ? t.calls[0].args : null));
    assert(t.logs.length === 1 && t.logs[0].includes('键已在（本次未写）'), '三态之一：键已在（本次未写）', t.logs[0] || '无日志');
    assert(t.logs.length === 1 && !t.logs[0].includes('本次已写入'), '「键已在」不许同时说「本次已写入」', t.logs[0] || '');
    assert(t.logs.length === 1 && !t.logs[0].includes('生效'), '日志无「生效」措辞（写入成功 ≠ 归属名生效）', t.logs[0] || '');
    assert(t.logs.length === 1 && /耗时 \d+(\.\d+)?ms/.test(t.logs[0]), '日志带实测耗时读数（任务 2 要求）',
      (t.logs[0] ? t.logs[0].match(/耗时 \S+/) : null) ? t.logs[0].match(/耗时 \S+/)[0] : '无');
    assert(t.logs.length === 1 && t.logs[0].includes('无自动判据面'), '日志明打「归属名无自动判据面」', '');
    assert(t.asyncCalls === 0 && t.logs.length === 1, '同步完成：run() 返回时日志已落定（没有挂在回调里）',
      `async=${t.asyncCalls} logs=${t.logs.length}`);
  }

  console.log('B3 本次补写（query 抛 ⇒ 走 add；reg.exe 对「键不存在」也返回 1，§77）');
  {
    const t = buildVm({ queryThrows: true });
    t.run();
    assert(t.calls.length === 2, 'query 之后确实发起了一次 add', JSON.stringify(t.calls.map((c) => c.args[0])));
    assert(t.calls[1] && sameArgs(t.calls[1].args, ['add', PINNED_KEY, '/v', PINNED.VALUE_NAME, '/d', PINNED.PRODUCT_NAME, '/t', PINNED.VALUE_TYPE, '/f']),
      'add 参数逐项 == 钉死键/DisplayName/产品名（取自 identity）/REG_SZ/强制', JSON.stringify(t.calls[1] ? t.calls[1].args : null));
    assert(t.logs.length === 1 && t.logs[0].includes(`本次已写入（${PINNED_KEY} → ${PINNED.PRODUCT_NAME}）`),
      '三态之一：本次已写入（打的是**实际写入的键** → 产品名）', t.logs[0] || '无日志');
    assert(t.logs.length === 1 && !t.logs[0].includes('生效'), '写入成功的日志同样不许说「生效」', t.logs[0] || '');
    assert(t.logs.length === 1 && /耗时 \d+(\.\d+)?ms/.test(t.logs[0]) && t.logs[0].includes('无自动判据面'),
      '补写态同样带耗时读数与判据面自述', '');
    assert(t.asyncCalls === 0, '补写路径也用同步 execFileSync（不是 execFile 回调）', `async=${t.asyncCalls}`);
  }

  console.log('B4 写入失败（add 也抛）——红法 S1 的落点');
  {
    const t = buildVm({ queryThrows: true, addThrows: true });
    t.run();
    assert(t.logs.length === 1 && t.logs[0].includes('写入失败'), '失败分支日志含「写入失败」', t.logs[0] || '无日志');
    assert(t.logs.length === 1 && !t.logs[0].includes('本次已写入'), '失败分支绝不许打「本次已写入」（S1 的落点）', t.logs[0] || '');
    assert(t.logs.length === 1 && !t.logs[0].includes('生效'), '失败分支不许出现「生效」', t.logs[0] || '');
    assert(t.logs.length === 1 && /耗时 \d+(\.\d+)?ms/.test(t.logs[0]) && t.logs[0].includes('无自动判据面'),
      '失败态也带耗时读数与判据面自述', '');
  }

  console.log('C1 通知点拍照（新增通知点＝本件必须扩面，不许静默漏判）');
  const ranges = fnRanges();
  const notifyFnNames = ranges
    .filter((r) => /new Notification\(/.test(stripComments(src.slice(r.start, r.end))))
    .map((r) => r.name);
  const notifyCount = (codeSrc.match(/new Notification\(/g) || []).length;
  assert(notifyCount === PINNED.NOTIFY_CALL_SITES, `代码行里 new Notification( 出现数 == ${PINNED.NOTIFY_CALL_SITES}`, `现算 ${notifyCount}`);
  assert(sameArgs(notifyFnNames, [PINNED.NOTIFY_FN]), `唯一通知点所在函数 == ${PINNED.NOTIFY_FN}`, notifyFnNames.join(',') || '零命中（提取器无牙）');

  console.log('C2 可达集拍照（体内有通知点的函数 ∪ 体内直接调用它们的函数）');
  const callerNames = ranges
    .filter((r) => !notifyFnNames.includes(r.name))
    .filter((r) => {
      const body = stripComments(src.slice(r.start, r.end));
      return notifyFnNames.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(body));
    })
    .map((r) => r.name);
  const reachable = [...new Set([...notifyFnNames, ...callerNames])].sort();
  assert(notifyFnNames.length > 0, '正向对照：确实提取到「体内有 new Notification( 」的函数', notifyFnNames.join(','));
  assert(sameArgs(reachable, PINNED.REACHABLE), '可达集 == 件内钉死集合（多一条/少一条都红——新调度链必须回来确认它也在注册之后）',
    `现算 ${reachable.join(',')}｜钉死 ${PINNED.REACHABLE.join(',')}`);

  console.log('C3/C4 顺序不变量（bootApp 体内按行号定界，红法 S-a 的落点）');
  const regLine = bootCodeLines.filter(({ code }) => /\bensureAumidDisplayName\s*\(/.test(code));
  assert(regLine.length === 1, 'bootApp 体内恰 1 处注册调用（C4 正向对照：0 处或多处都不许让 C3 空集恒绿）',
    regLine.length ? `:L${regLine[0].n}` : '体内未命中');
  const notifyLines = bootCodeLines.filter(({ code }) =>
    reachable.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(code) && !/\bensureAumidDisplayName\b/.test(code))
  );
  assert(notifyLines.length >= 1, '正向对照：bootApp 体内确实存在可发通知的调用点', notifyLines.map(({ n }) => `:L${n}`).join(','));
  const earliest = notifyLines.length ? Math.min(...notifyLines.map(({ n }) => n)) : -1;
  assert(regLine.length === 1 && earliest >= 0 && regLine[0].n < earliest,
    '注册调用行号 < 每一个可发通知调用点的行号（同步写入完成后才可能排入通知）',
    earliest >= 0 && regLine[0] ? `注册 :L${regLine[0].n} vs 最早通知调度 :L${earliest}` : '无从比较');

  console.log('C5/C6 措辞禁串');
  assert(!stripComments(regFn).includes('生效'), '注册函数体内（剔注释行）不出现「生效」',
    stripComments(regFn).includes('生效') ? '命中' : '');
  assert(!codeSrc.includes('通知归属名生效'), '全文（剔注释行）不出现旧措辞「通知归属名生效」', '');

  console.log(`\nPASS ${pass} / FAIL ${failCount}`);
  if (failCount) {
    console.error(`✗ toast 归属名顺序不变量 ${failCount} 条失败（提醒：本件判不了显示名，只判顺序与注册行为）`);
    process.exit(1);
  }
  console.log('PASS：注册同步完成 + 键名三锚点一致 + 三态措辞可区分 + bootApp 内注册早于任何通知调度点');
  process.exit(0);
} catch (e) {
  console.error(`脚本异常：${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
}
