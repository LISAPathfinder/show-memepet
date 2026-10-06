// 穿透「单写入者」静态守卫（1.0.57 加固轮；纯 node 零依赖，CI 可跑）：
//   断言渲染端在源码层面已经没有任何途径能写 WS_EX_TRANSPARENT，而不是只靠"约定"。
//   运行时侧的同族判据 = tools/verify-passthrough-desync.js 的断言 A/B。
//
// 为什么要有第 4 条正向对照：一个只写「搜不到 X」的件，会因为文件改名、路径写错、
//   编码读坏而**结构上永远绿**（§72 的自启清理空转、§63 的恒 exit 0 同型事故）。
//   所以这里必须先证明"正例在位"（主进程确实还有那唯一的写入者），否定式断言才有意义。
//
// 用法：node tools/verify-single-writer.js [仓库根]   （传别的根可对 git 历史副本做判别性自证，不动跟踪文件）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
};
// 只看代码行：整行注释（含 * / 引导的续行）豁免——与 verify-identity 的裸产品名扫描同一条规则
const codeLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

let pass = 0;
const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (ok) pass++;
};

const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const rendererFiles = (() => {
  try {
    return fs
      .readdirSync(path.join(ROOT, 'renderer'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => ['renderer/' + f, read('renderer/' + f)]);
  } catch {
    return [];
  }
})();

const missing = [];
if (mainSrc === null) missing.push('main.js');
if (preloadSrc === null) missing.push('preload.js');
if (!rendererFiles.length) missing.push('renderer/*.js');
if (missing.length) {
  console.error(`✗ 读不到源码：${missing.join(' / ')}（根=${ROOT}）`);
  console.error('  判据拒绝在"读不到"上打绿灯——读不到不等于不存在（§72/§63 同型）。');
  process.exit(1);
}

// ① 正向对照：主进程里那个唯一写入者必须在位
const hasNativeWriter = /function nativeSetIgnoreMouseEvents\s*\(/.test(mainSrc);
const hasPollWriter = /syncPetPassThrough/.test(mainSrc) && /nativeSetIgnoreMouseEvents\(petWindow/.test(mainSrc);
record('main.js 仍定义唯一写入者 nativeSetIgnoreMouseEvents', hasNativeWriter, hasNativeWriter ? '函数在位' : '没找到定义：文件被改名/截断，本件其余否定式断言全部失效');
record('main.js 仍由 syncPetPassThrough 下发到桌宠窗', hasPollWriter, hasPollWriter ? '下发点在位' : '没找到 petWindow 下发点：同上');

// ② 渲染端接口层：preload 不再暴露写入口
const preloadHits = codeLines(preloadSrc).split('\n').filter((l) => /setIgnoreMouseEvents/.test(l));
record('preload.js 无 setIgnoreMouseEvents 暴露', preloadHits.length === 0, preloadHits.length ? preloadHits[0].trim().slice(0, 90) : '代码行零命中');

// ③ 通道层：主进程不再挂那条 ipc 处理器（没人发送的死通道也一并删掉）
const handlerHits = codeLines(mainSrc).split('\n').filter((l) => /ipcMain\.(on|handle)\(\s*'pet:set-ignore-mouse-events'/.test(l));
record('main.js 无 pet:set-ignore-mouse-events 处理器', handlerHits.length === 0, handlerHits.length ? handlerHits[0].trim().slice(0, 90) : '代码行零命中');

// ④ 调用方层：renderer 里没有任何代码（非注释）引用这个 API
const rendererHits = [];
for (const [file, text] of rendererFiles) {
  if (text === null) continue;
  codeLines(text)
    .split('\n')
    .forEach((l, i) => {
      if (/setIgnoreMouseEvents/.test(l)) rendererHits.push(`${file}:${i + 1} ${l.trim().slice(0, 70)}`);
    });
}
record(`renderer/ 无 setIgnoreMouseEvents 调用（扫 ${rendererFiles.length} 个文件）`, rendererHits.length === 0, rendererHits.length ? rendererHits[0] : '零命中');

for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name} —— ${c.detail}`);
const failed = checks.length - pass;
console.log(`PASS ${pass}/${checks.length}`);
process.exit(failed ? 1 : 0);
