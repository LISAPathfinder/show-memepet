// @runtime: ci —— 契约⇄真源接线闸（票 14-M 任务 4b）：main.js / tools/inject-click.js 的 koffi 绑定
//   （Win32 导出名＋参数元数）与 types/contract-native-koffi.d.ts 契约登记**双向相等**，纯 node 源码级。
// 立件理由（票 14-M §五）：14-L 的 T6 只证明「契约自己的类型级用例真在被 tsc 检查」，
//   不证明「契约 == main.js 实际绑定」——当时靠产品码 blob 未变保证两者不矛盾，今后改绑定不会有任何判据红。
//   deleteTab 尤其说明「拿 needle 搜产品码」这条路对契约根本不成立（真源走 COM vtable slot，
//   字面名产品码 0 命中是正常现象），所以匹配键＝**Win32 导出名**（每个 .func( 调用的第一个字符串参数，
//   数组式与整串式两种声明形态都有），不是 JS 侧键名/变量名。
// 牙齿设计（M6 是本件的灵魂）：件内 REGISTRY 是**第三锚点**——契约与绑定同时改坏同一名（两边一致地
//   改名/改元数）在「提取↔契约」两两比对下恒绿（同源恒真，§91 同族），只有对照这份独立拍照的
//   REGISTRY 才红。改任何一侧都必须有意识更新本件（棘轮语义，与 build.files 登记、checkJs 基线同款纪律）。
// 红法（%TEMP% 整仓副本＋绝对路径，同轮跑零突变对照；读数回填票 14-M §十一）：
//   M6 契约与绑定同一名同时改坏（setPos 元数 7→6 两边同改）⇒ 必红（A2+B2 双双失配）；
//   M7 只改坏绑定（元数）⇒ 必红（A2）；只改坏契约（元数）⇒ 必红（B2）；M8 什么都不改 ⇒ 全绿。
// 扫描面＝main.js ＋ tools/inject-click.js（契约文件头自述的真源「产品码与 tools 现行 koffi 绑定」）；
//   gamepad-xinput.js 的 XInput 绑定不在 14-L 契约面，本件不扫。纯 node 零第三方依赖零实例。
// 退出码：0 全绿 / 1 断言失败或脚本异常（打「脚本异常：」）——判定面 0/1，无 2/3（无前置可缺）。
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const fail = (msg) => { console.error(msg); process.exit(1); };

// 数组式：.func('Name', 'ret', [p1, p2, …])——ret 串与数组跨行都吃（ShellExecuteW 的参数表换行排）；
//   参数里可含 koffi.pointer(X)（无顶层逗号），按顶层逗号数计元数。
// 整串式：.func('[ret ][__stdcall ]Name(p1, p2)')——GetLayeredWindowAttributes / GetShellWindow /
//   CoCreateInstance / CoInitializeEx / keybd_event 五处现行。
// 两种形态并集必须吃光源里全部 .func(（A0 完备性断言），否则提取器对「新形态」静默漏计＝假绿。
function extractBindings(src, label) {
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const out = new Map(); // win32Name -> { arity, line }
  const put = (name, arity, idx) => {
    const prev = out.get(name);
    if (prev && prev.arity !== arity) {
      throw new Error(`${label} 同名绑定 ${name} 元数冲突：${prev.arity}（:L${prev.line}）vs ${arity}（:L${lineOf(idx)}）`);
    }
    out.set(name, { arity, line: lineOf(idx) });
  };
  let consumed = 0;
  const reArr = /\.func\(\s*'([A-Za-z_]\w*)'\s*,\s*'(?:[^']*)'\s*,\s*\[([^\]]*)\]/g;
  for (let m; (m = reArr.exec(src));) {
    put(m[1], m[2].split(',').map((s) => s.trim()).filter(Boolean).length, m.index);
    consumed += 1;
  }
  const reStr = /\.func\(\s*'([^']+)'\s*\)/g;
  for (let m; (m = reStr.exec(src));) {
    const sig = m[1].match(/^(?:[A-Za-z0-9_]+\s+)?(?:__stdcall\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*$/);
    if (!sig) throw new Error(`${label} 整串式绑定解析不了：'${m[1]}'（:L${lineOf(m.index)}）`);
    put(sig[1], sig[2].trim() ? sig[2].split(',').length : 0, m.index);
    consumed += 1;
  }
  return { map: out, consumed, total: (src.match(/\.func\(/g) || []).length };
}

// 契约侧提取：interface 方法成员（键＝Container.member）＋函数类型别名（键＝别名本身）。
// 先剥注释再解析——契约的 doc 注释里满是 Win32 签名与括号，不剥会把注释当成员（假登记）；
// 带 <…> 泛参的 type（_Eq/_IsTrue 类型级用例工具）天然不匹配「= (」形态，下划线过滤是冗余防线。
function extractContract(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out = new Map(); // 'StyleFns.getEx' / 'GetAsyncKeyStateFn' -> arity
  const ifaceRe = /interface\s+(\w+)\s*\{([^{}]*)\}/g;
  for (let m; (m = ifaceRe.exec(code));) {
    const memberRe = /(\w+)\s*\(([^)]*)\)\s*:\s*[^;]+;/g;
    for (let t; (t = memberRe.exec(m[2]));) {
      out.set(`${m[1]}.${t[1]}`, t[2].trim() ? t[2].split(',').length : 0);
    }
  }
  const aliasRe = /type\s+([A-Za-z]\w*)\s*=\s*\(([^)]*)\)\s*=>/g;
  for (let m; (m = aliasRe.exec(code));) {
    if (m[1].startsWith('_')) continue;
    out.set(m[1], m[2].trim() ? m[2].split(',').length : 0);
  }
  return out;
}

// ---- 第三锚点：登记表（现行真源的一次性拍照，2026-10-24 @ HEAD 0e8dc4a）----
// contract 名（接口成员用 Container.member，类型别名用别名）↔ Win32 导出名 ↔ 参数元数 ↔ 真源文件。
// 改绑定/改契约/新增绑定任何一侧，都必须连这份表一起改——「登记了才允许存在」与 build.files 同款。
const REGISTRY = [
  { contract: 'StyleFns.getEx', win32: 'GetWindowLongPtrW', arity: 2, src: 'main.js' },
  { contract: 'StyleFns.setEx', win32: 'SetWindowLongPtrW', arity: 3, src: 'main.js' },
  { contract: 'StyleFns.setPos', win32: 'SetWindowPos', arity: 7, src: 'main.js' },
  { contract: 'StyleFns.getWindow', win32: 'GetWindow', arity: 2, src: 'main.js' },
  { contract: 'StyleFns.getRect', win32: 'GetWindowRect', arity: 2, src: 'main.js' },
  { contract: 'StyleFns.isVisible', win32: 'IsWindowVisible', arity: 1, src: 'main.js' },
  { contract: 'StyleFns.getClassName', win32: 'GetClassNameW', arity: 3, src: 'main.js' },
  { contract: 'StyleFns.getPid', win32: 'GetWindowThreadProcessId', arity: 2, src: 'main.js' },
  { contract: 'StyleFns.findChild', win32: 'FindWindowExW', arity: 4, src: 'main.js' },
  { contract: 'StyleFns.dwmCloaked', win32: 'DwmGetWindowAttribute', arity: 4, src: 'main.js' },
  { contract: 'StyleFns.getLayeredAttr', win32: 'GetLayeredWindowAttributes', arity: 4, src: 'main.js' },
  { contract: 'GetAsyncKeyStateFn', win32: 'GetAsyncKeyState', arity: 1, src: 'main.js' },
  { contract: 'ShellExecuteWFn', win32: 'ShellExecuteW', arity: 6, src: 'main.js' },
  { contract: 'GetShellWindowFn', win32: 'GetShellWindow', arity: 0, src: 'main.js' },
  { contract: 'SendInputFn', win32: 'SendInput', arity: 3, src: 'tools/inject-click.js' },
  { contract: 'SetCursorPosFn', win32: 'SetCursorPos', arity: 2, src: 'tools/inject-click.js' },
];
// 产品有、契约无 ⇒ 显式豁免（票面：「红或显式豁免名单」）——豁免是声明，不是漏登记的遮羞布
const EXEMPT_BINDINGS = new Map([
  ['CoCreateInstance', 'COM 会话管线（taskbarLink 取 ITaskbarList），非新壳能力面——契约按 TaskbarLink vtable 语义收'],
  ['CoInitializeEx', 'COM STA 初始化（主线程已是 STA，幂等防御调用），同上'],
  ['keybd_event', '注入工具辅助原语（inject-click），票 14-L 契约未收——收编前豁免'],
]);
// 契约有、产品无字面绑定 ⇒ 显式豁免（COM vtable 语义接口，obj 隐式参——票 14-M §五 点名 deleteTab）
const EXEMPT_CONTRACT = new Map([
  ['TaskbarLink.release', 'COM vtable slot(2)，obj 隐式参——字面名产品码 0 命中是正常现象（票 14-M §五）'],
  ['TaskbarLink.hrInit', 'COM vtable slot(3)——同上'],
  ['TaskbarLink.deleteTab', 'COM vtable slot(5)＋protoDeleteTab(void*,uintptr)——同上'],
]);

const readSrc = (rel) => {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) fail(`脚本异常：读不到 ${rel}（root=${root}）`);
  return fs.readFileSync(p, 'utf8');
};

let mainExt;
let injectExt;
let contract;
try {
  // 剥块注释再提取：注释掉的旧绑定不该计数（行注释不剥——main.js 无 '//' 出现在字符串里的风险面，
  // 且 A0 的 consumed==total 断言会把任何漏计当场点名）
  const stripBlock = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  mainExt = extractBindings(stripBlock(readSrc('main.js')), 'main.js');
  injectExt = extractBindings(stripBlock(readSrc('tools/inject-click.js')), 'tools/inject-click.js');
  contract = extractContract(readSrc('types/contract-native-koffi.d.ts'));
} catch (e) {
  fail(`脚本异常：${e.message}`);
}

const fails = [];
const assertCount = { a0: 0, a2: 0, a3: 0, b2: 0, b3: 0 };

// A0 提取器完备性＋正向对照（§77① 同族：解析器坏了不许伪装成「没有绑定」所以恒绿）
for (const [label, ext, minN, probes] of [
  ['main.js', mainExt, 15, [['SetWindowPos', 7], ['GetLayeredWindowAttributes', 4], ['ShellExecuteW', 6], ['GetShellWindow', 0]]],
  ['tools/inject-click.js', injectExt, 3, [['SendInput', 3], ['SetCursorPos', 2]]],
]) {
  assertCount.a0 += 1;
  if (ext.consumed !== ext.total) {
    fails.push(`A0 提取完备性：${label} 有 ${ext.total} 处 .func( 只解析出 ${ext.consumed} 处——出现了解析器不认识的声明形态，先扩提取器再谈契约`);
  }
  assertCount.a0 += 1;
  if (ext.map.size < minN) {
    fails.push(`A0 提取完备性：${label} 只提取出 ${ext.map.size} 个绑定（<${minN}）——提取器大概率塌方，不许当绿`);
  }
  for (const [name, arity] of probes) {
    assertCount.a0 += 1;
    const got = ext.map.get(name);
    if (!got || got.arity !== arity) {
      fails.push(`A0 正向对照：${label} 应有 ${name}(${arity}) 实得 ${got ? got.arity : '无'}——探针失配即提取器无牙`);
    }
  }
}

// A2 登记表 ↔ 真源：登记的每条绑定必须在真源里按同元数存在（正向对照在位，防「读不到就绿」）
for (const r of REGISTRY) {
  assertCount.a2 += 1;
  const ext = r.src === 'main.js' ? mainExt : injectExt;
  const got = ext.map.get(r.win32);
  if (!got) fails.push(`A2 登记表↔真源：${r.src} 里找不到绑定 ${r.win32}（契约面 ${r.contract}）——绑定被改名/删除而登记表没跟上`);
  else if (got.arity !== r.arity) fails.push(`A2 登记表↔真源：${r.win32} 元数不符——真源 ${got.arity}（:L${got.line}）vs 登记表 ${r.arity}（契约面 ${r.contract}）`);
}

// A3 真源 ↔ 登记表 ∪ 豁免：真源每条绑定都必须被登记（防「新增绑定不登记」，build.files 同款纪律）
const regWin32 = new Set(REGISTRY.map((r) => r.win32));
for (const [label, ext] of [['main.js', mainExt], ['tools/inject-click.js', injectExt]]) {
  for (const [name, got] of ext.map) {
    assertCount.a3 += 1;
    if (!regWin32.has(name) && !EXEMPT_BINDINGS.has(name)) {
      fails.push(`A3 真源↔登记表：${label} 的绑定 ${name}(${got.arity}，:L${got.line}) 既不在登记表也不在豁免名单——新增 koffi 绑定必须同步契约与登记表`);
    }
  }
}

// B2 登记表 ↔ 契约：登记的每条契约面必须在契约文件里按同元数存在
for (const r of REGISTRY) {
  assertCount.b2 += 1;
  const got = contract.get(r.contract);
  if (got === undefined) fails.push(`B2 登记表↔契约：契约文件里找不到 ${r.contract}——契约成员被改名/删除而登记表没跟上`);
  else if (got !== r.arity) fails.push(`B2 登记表↔契约：${r.contract} 元数不符——契约 ${got} vs 登记表 ${r.arity}（真源绑定 ${r.win32}=${r.arity}）`);
}

// B3 契约 ↔ 登记表 ∪ 豁免：契约每个成员都必须被登记或豁免（防「契约加了条目永远没人对照」）
const regContracts = new Set(REGISTRY.map((r) => r.contract));
for (const [name, arity] of contract) {
  assertCount.b3 += 1;
  if (!regContracts.has(name) && !EXEMPT_CONTRACT.has(name)) {
    fails.push(`B3 契约↔登记表：契约成员 ${name}(${arity}) 既不在登记表也不在豁免名单——契约有、真源无字面绑定的成员要么补真源锚点要么进豁免名单`);
  }
}

const total = assertCount.a0 + assertCount.a2 + assertCount.a3 + assertCount.b2 + assertCount.b3;
console.log(`登记表 ${REGISTRY.length} 条（main.js ${REGISTRY.filter((r) => r.src === 'main.js').length}／inject-click ${REGISTRY.filter((r) => r.src !== 'main.js').length}）；豁免绑定 ${EXEMPT_BINDINGS.size}；豁免契约 ${EXEMPT_CONTRACT.size}；契约成员提取 ${contract.size} 个`);
console.log(`真源提取：main.js ${mainExt.map.size} 个绑定（.func( 共 ${mainExt.total} 处全解析）／inject-click ${injectExt.map.size} 个（共 ${injectExt.total} 处全解析）`);
if (fails.length) {
  console.error(`✗ 契约⇄真源接线闸 ${fails.length} 失败（断言 ${total} 条）：`);
  for (const f of fails) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`PASS ${total}/${total}（A0 完备性+正向对照 ${assertCount.a0}／A2 登记表↔真源 ${assertCount.a2}／A3 真源↔登记表 ${assertCount.a3}／B2 登记表↔契约 ${assertCount.b2}／B3 契约↔登记表 ${assertCount.b3}）——契约与绑定双向相等（票 14-M 任务 4b）`);
