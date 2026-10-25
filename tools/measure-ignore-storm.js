// @runtime: shared —— 高频采样穿透位与命中路由，attach 调试端口判据件（lib-occupancy 自检）
// 量化验证：宠物脸上的鼠标移动/拖拽期间，桌宠窗口的穿透状态会被翻转多少次。
// 红线（延续原「200 次移动 → 0~2 次」口径）：200 次合成 mousemove 期间，以约 20Hz 采样
// 「穿透位(ex&0x20) + 命中路由(WindowFromPoint 归属)」组合状态，任一场景翻转 >2 次判失败。
// 口径沿革：旧版数 pet:set-ignore-mouse-events IPC，该口径 1.0.0（897ffd7）起已无渲染端
// 生产者、1.0.25（koffi 直写）后连主进程侧消费者一并消失，恒 0 空转；本轮改采窗口真实状态。
// 瞬态说明：20Hz（50ms）采样会漏掉短于采样间隔的状态变化，报出的翻转次数是下界——
// 启动时先实测 500ms 内采样循环实际触发次数并写进输出（轮询驱动的主进程写入有 120ms
// 轮询周期 + 600ms 保持垫底，50ms 采样对它们足够密；纯瞬态翻转不在本工具覆盖内）。
// 判定形态（票 14-R 任务 1，阈值数字不动）：每场景重复 n 次、红线挂 k-of-n——n 次里 ≥k 次
// 翻转 >2 才判失败。缘起：14-M 归因续跑三轮 9 个场景读数最大 2、其中 3 个恰好 ==2，加立票时点
// 2/2 红与累计 0/8 轮红样本 ⇒ 本件工作点就贴在 1–2，越线是同一分布的尾部、不是另一个机理；
// 「单次越线即红」会把尾部噪声当回归，而 14-M 任务 2a 的「复跑取最坏」又把整件变红概率从 q
// 抬到约 1−(1−q)²。k-of-n 与复跑取最坏**只能留一套**：本件选 k-of-n，2a 机制整体摘除（不叠乘）。
// 临界显形（票 14-M 任务 2b，保留）：任一次 ==2 ⇒ 明打「临界（==红线上限 2，绿≠有余量）」——
// 绿不伪装成有余量（实测绿面 0/2/0、离红只差 1）。逐次读数全落盘的性质由"每场景 n 个值"继承。
// 用法：npx electron --inspect=9229 --remote-debugging-port=9333 . 起进程后
//   node tools/measure-ignore-storm.js
// 退出码：0 = 每场景 n 次中翻转 >2 的次数 < k；1 = 有场景 ≥k 或环境不满足（实测读数见输出）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const identity = require('../identity');
const thisDir = path.dirname(fileURLToPath(import.meta.url));
require('./lib-occupancy').warnBlockingInstances(); // 测量件只警告不拦（票 11-G 任务 4）
function connectTarget(target) {
  return (async () => {
    if (!target) throw new Error('CDP 目标不存在');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    const evaluate = (expression) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (msg.result && msg.result.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluate 失败'));
            return;
          }
          resolve(msg.result.result.value);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
    return { evaluate };
  })();
}
const pickTarget = async (port, pick) => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = pick(targets);
  if (!t) throw new Error(`端口 ${port} 上找不到目标：` + targets.map((x) => x.url).join(' | '));
  return t;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 命中路由层观测（统一口径，koffi 范式照 probe-window-style.js / probe-click-target.js）=====
// 1.0.25 实测（2026-10-02）：桌宠顶层窗穿透态 ex=0x080000a8（带 WS_EX_TRANSPARENT、无 LAYERED），
// 但整块 300x300 上 WindowFromPoint 仍返回 Chrome_RenderWidgetHostHWND（桌宠渲染子窗）——
// 「样式位挂着但点不穿」是被测对象的真 bug，单看 ex 位会漏报，故组合状态含命中路由。
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
// WindowFromPoint 的 POINT 按值传：按 int64 传，低 32 位 x / 高 32 位 y；传 void* 会恒为 0。
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr', ['int64']);
const GetAncestor = user32.func('GetAncestor', 'uintptr', ['uintptr', 'uint32']);
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr']);
const GWL_EXSTYLE = -20;
const GA_ROOT = 2;
const packPoint = (x, y) => (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
const rootOf = (h) => (h ? Number(GetAncestor(h, GA_ROOT)) : 0);
const hitAt = (x, y) => Number(WindowFromPoint(packPoint(x, y)));
const cursorPos = () => {
  const b = Buffer.alloc(8);
  GetCursorPos(b);
  return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = await connectTarget(await pickTarget(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]));

// 兜底：页面可能被 verify-main-passthrough 的上一轮运行留在 about:blank；不在就把 pet.html 装回去
const petTarget = async () => {
  const ts = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  return ts.find((t) => t.url && t.url.endsWith('pet.html')) || null;
};
let pt = await petTarget();
if (!pt) {
  console.log('渲染端不是 pet.html（可能被上一轮 verify-main-passthrough 换成 about:blank），恢复中…');
  await main.evaluate(`
    (() => {
      const { BrowserWindow, app } = process.mainModule.require('electron');
      const path = process.mainModule.require('node:path');
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL() === 'about:blank');
      if (!w) return 'no blank window';
      w.loadFile(path.join(app.getAppPath(), 'renderer', 'pet.html'));
      return 'restored';
    })()
  `);
  await wait(2000);
  pt = await petTarget();
  if (!pt) {
    console.error('恢复 pet.html 失败');
    process.exit(1);
  }
}
const pet = await connectTarget(pt);

const petHwnd = parseInt(
  await main.evaluate(`
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('pet.html'));
    if (!w) return '';
    return '0x' + w.getNativeWindowHandle().readBigUInt64LE(0).toString(16);
  })()
`),
  16
);
if (!petHwnd || !IsWindow(petHwnd)) {
  console.error('拿不到有效的桌宠窗口句柄（桌宠没起来？）');
  process.exit(1);
}
const petRoot = rootOf(petHwnd);

// ===== 前置读数（票 14-M 任务 3：批跑形态依赖归因）=====
// 只读约定：本块不做任何写动作（不碰 config、不碰注册表、不写文件）——只把「风暴件开场那一刻
// 的场地时序」摆进读数面，供 3 轮全量跑相关性（结论只许「变量 X 与越线相关」或「未定位」，
// 不许在无读数支撑下写机理链——立票那轮就是栽在把时间重合当成机理）。任何一项拿不到都降级为
// 「不可得」并明打，绝不影响本件判据与退出码：它是归因读数，不是断言。
const prereadNotes = [];
const prereadLines = [];
try {
  const uptimeSec = await main.evaluate('process.uptime()');
  prereadLines.push(`  实例已存活 ${Number(uptimeSec).toFixed(1)}s（主进程 process.uptime）`);
} catch (e) {
  prereadNotes.push(`实例存活秒数不可得（${(e && e.message) || e}）`);
}
try {
  // 常量现算自产品源（数字一律现算，不手抄——产品改值时读数面自己跟着走）
  const mainSrc = fs.readFileSync(path.join(thisDir, '..', 'main.js'), 'utf8');
  const graceMs = Number((mainSrc.match(/REBUILD_GRACE_MS\s*=\s*(\d+)/) || [])[1]);
  const coolMs = Number((mainSrc.match(/PET_ROUTE_HEAL_COOLDOWN_MS\s*=\s*(\d+)/) || [])[1]);
  const dataDir = process.env.SHOWCASE_DATA_DIR || '';
  if (!dataDir) throw new Error('SHOWCASE_DATA_DIR 未设（非装置环境，重建日志不可定位）');
  const logFile = path.join(dataDir, identity.LOG_NAME);
  const logText = fs.readFileSync(logFile, 'utf8');
  // 重建行锚（main.js 现行四条重建路径的日志原文；产品改文案要同步这里——这是读数面不是判据）。
  // 日志时间戳是 UTC（尾缀 Z），本机 +8——距今秒数用 Date.parse 差值算，不受时区写法影响。
  const REBUILD_PATTERNS = [
    ['14-E 自检重建', /输入通道自检：.*→ 重建窗口/],
    ['显式重建(确保输入恢复)', /：重建桌宠窗口以确保输入恢复/],
    ['隐藏重建(已重建窗口句柄)', /已重建窗口句柄/],
    ['重建失败', /重建桌宠窗口失败/],
  ];
  const now = Date.now();
  const found = [];
  for (const [label, re] of REBUILD_PATTERNS) {
    let last = null;
    for (const line of logText.split('\n')) {
      const m = line.match(/^\[([^\]]+)\] (.*)$/);
      if (m && re.test(m[2])) last = { at: m[1], text: m[2].trim().slice(0, 70) };
    }
    if (last) {
      const ageSec = Math.max(0, (now - Date.parse(last.at)) / 1000);
      found.push({ label, ageSec });
      prereadLines.push(`  ${label}：最近 ${last.at}（距今 ${ageSec.toFixed(1)}s）——${last.text}`);
    } else {
      prereadLines.push(`  ${label}：无（本轮日志无此行）`);
    }
  }
  prereadLines.push(`  （常量现算自 main.js：REBUILD_GRACE_MS=${graceMs || '?'}，PET_ROUTE_HEAL_COOLDOWN_MS=${coolMs || '?'}）`);
  const heal = found.find((f) => f.label === '14-E 自检重建');
  if (heal && coolMs) {
    const left = (coolMs - heal.ageSec * 1000) / 1000;
    prereadLines.push(`  heal 冷却剩余 ${left > 0 ? `${left.toFixed(1)}s（冷却中）` : '0s（已过期）'}——锚＝最近一条 14-E 自检重建行（petRouteHealAt 同拍落日志）`);
  } else {
    prereadLines.push('  heal 冷却剩余：不可得（无 14-E 自检重建行或常量没取到）');
  }
  const nearest = found.length ? found.reduce((a, b) => (a.ageSec <= b.ageSec ? a : b)) : null;
  if (nearest && graceMs) {
    const left = (graceMs - nearest.ageSec * 1000) / 1000;
    prereadLines.push(`  重建宽限剩余 ${left > 0 ? `${left.toFixed(1)}s` : '0s（已过期）'}（以最近重建行为起点近似——宽限真起点在 createPetWindow，日志只有重建完成时刻）`);
  } else {
    prereadLines.push('  重建宽限剩余：不可得（无重建行或常量没取到）');
  }
} catch (e) {
  prereadNotes.push(`重建/冷却读数不可得（${(e && e.message) || e}）`);
}
console.log('前置读数（票 14-M 任务 3，只读）：');
for (const l of prereadLines) console.log(l);
for (const n of prereadNotes) console.log(`  ⚠ ${n}`);
console.log('');

// 采样器：脚本进程本地 koffi 直读（不经 CDP，单次读是同步 user32 调用，微秒级）
const SAMPLE_MS = 50; // 目标 ≈20Hz
const samples = [];
let sampling = true;
const sampleOnce = () => {
  if (!IsWindow(petHwnd)) return null;
  const c = cursorPos();
  const hit = hitAt(c.x, c.y);
  const ex = Number(BigInt(GetWindowLongPtrW(petHwnd, GWL_EXSTYLE)) & 0xffffffffn);
  const transparent = !!(ex & 0x20);
  const hitPet = hit !== 0 && rootOf(hit) === petRoot;
  return { ex, transparent, hitPet, hit };
};
const timer = setInterval(() => {
  if (!sampling) return;
  const s = sampleOnce();
  if (s) samples.push({ t: Date.now(), s });
}, SAMPLE_MS);

// 采样频率基准（待核 ○ 的落实：把实测数字写进输出）
const freq = await new Promise((resolve) => {
  let n = 0;
  const t0 = Date.now();
  const iv = setInterval(() => {
    n++;
    if (Date.now() - t0 >= 500) {
      clearInterval(iv);
      resolve(n);
    }
  }, SAMPLE_MS);
});
console.log(`采样频率基准：目标间隔 ${SAMPLE_MS}ms，500ms 实测触发 ${freq} 次 ≈ ${Math.round((freq / 500) * 1000)}Hz`);
console.log(`桌宠 HWND=0x${petHwnd.toString(16)} 根窗口=0x${petRoot.toString(16)}\n`);

const N = 200;
const scenes = {
  '场景一 脸上移动': `
    const face = document.querySelector('#pet-face');
    const r = face.getBoundingClientRect();
    for (let i = 0; i < ${N}; i++) {
      face.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: r.left + r.width / 2 + (i % 3), clientY: r.top + r.height / 2 + (i % 3), buttons: 0,
      }));
    }`,
  '场景二 拖拽桌宠': `
    const face = document.querySelector('#pet-face');
    const r = face.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    face.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy, buttons: 1, button: 0 }));
    for (let i = 0; i < ${N}; i++) {
      face.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + i, clientY: cy + i, buttons: 1, button: 0 }));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx + ${N}, clientY: cy + ${N}, buttons: 0, button: 0 }));`,
  '场景三 透明区移动': `
    for (let i = 0; i < ${N}; i++) {
      document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: i % 5, clientY: i % 5, buttons: 0 }));
    }`,
};

let ok = true;
const RED_LINE = 2; // 既有红线（§52 链的口径，200 次移动翻转 ≤2）；票 14-R 不改这个数，改的是"判几次、怎么判"
// 判定形态参数（票 14-R 任务 1）：k-of-n。定稿依据 = W1 未突变实测分布（票面 §九），分布工作点
// 1–2、越线属尾部 ⇒ n=3/k=2 让"单次瞬时越线"不再红、"n 次里 ≥2 次越线"的持续形态仍在拦。
const SCENE_REPEATS = 3; // n
const RED_K = 2; // k：n 次里 ≥k 次 >RED_LINE 才判失败（与 14-M 2a 复跑取最坏不叠乘——后者已摘除）

// 单次测量（一个场景跑一遍）。样本窗按绝对时间过滤，n 次重复共用采样器互不干扰。
const runSceneOnce = async (name, body) => {
  const t0 = Date.now();
  const moved = await pet.evaluate(`(() => { ${body} return ${N}; })()`);
  await sleep(1500); // 尾巴：渲染端上报 + 主进程 120ms 轮询写入落地
  const t1 = Date.now();
  const win = samples.filter((p) => p.t >= t0 - 80 && p.t <= t1); // 80ms 容差带住场景开始前最后一个样本
  let flips = 0;
  let desync = 0; // 失谐样本：穿透位与命中路由矛盾（bug 形态），不计入翻转但单独报
  const flipLog = [];
  for (let i = 1; i < win.length; i++) {
    const a = win[i - 1].s;
    const b2 = win[i].s;
    if (a.transparent !== b2.transparent || a.hitPet !== b2.hitPet) {
      flips++;
      flipLog.push(
        `    ${new Date(win[i].t).toLocaleTimeString()} → EXSTYLE=0x${b2.ex.toString(16).padStart(8, '0')} ` +
          `穿透位=${b2.transparent ? '挂' : '无'} 命中桌宠=${b2.hitPet ? '是' : '否'}`
      );
    }
    if (b2.transparent !== !b2.hitPet) desync++;
  }
  return { moved, flips, desync, flipLog };
};

const sceneVerdicts = [];
console.log(`\n── 判定测量（每场景 ×${SCENE_REPEATS} 次，红线挂 k-of-n：≥${RED_K}/${SCENE_REPEATS} 次翻转 >2 才红；票 14-R 任务 1）──`);
for (const [name, body] of Object.entries(scenes)) {
  const runs = [];
  for (let r = 1; r <= SCENE_REPEATS; r++) {
    runs.push({ r, ...(await runSceneOnce(name, body)) });
  }
  const vals = runs.map((x) => x.flips);
  const exceed = vals.filter((v) => v > RED_LINE).length;
  const critical = vals.filter((v) => v === RED_LINE).length;
  const desyncSum = runs.reduce((a, x) => a + x.desync, 0);
  const red = exceed >= RED_K;
  sceneVerdicts.push({ name, vals, exceed, critical, desyncSum, red, runs });
  // 逐次值全部显形（票 14-R：读数面只增不减）；越线值打 ✗、临界值打 ⚠；
  // W3 口径：越线非零但 <k 时明打「判绿」，不许把尾部越线静默成干净绿。
  const valText = vals.map((v) => (v > RED_LINE ? `${v}✗` : v === RED_LINE ? '⚠2' : String(v))).join('/');
  console.log(
    `${name} x${runs[0].moved} ×${SCENE_REPEATS} 次 → 翻转逐次 ${valText}` +
      `（>2 共 ${exceed} 次／==2 临界共 ${critical} 次）→ ` +
      (red ? `✗ FAIL（${exceed} ≥ k=${RED_K}）` : exceed > 0 ? `⚠ 判绿（${exceed} < k=${RED_K}——越线非零，单次瞬时/分布尾部形态）` : `✓ PASS（${exceed} < k=${RED_K}）`) +
      (desyncSum ? `（另有 ${desyncSum} 个失谐样本：穿透位与命中路由矛盾）` : '')
  );
  if (critical) console.log(`  ⚠ 临界（==红线上限 2，绿≠有余量）出现 ${critical}/${SCENE_REPEATS} 次——票 14-M 任务 2b 性质保留`);
  for (const run of runs.filter((x) => x.flips > RED_LINE)) {
    console.log(`  第 ${run.r} 次越线明细：`);
    for (const l of run.flipLog.slice(0, 12)) console.log(l);
    if (run.flipLog.length > 12) console.log(`    …共 ${run.flipLog.length} 次`);
  }
}
ok = sceneVerdicts.every((s) => !s.red);
// 票 14-M §四 任务 3 的读数面补丁：归因读数必须**与 rc 无关地留下一份**——批跑只对失败件落 stdout、
// 全绿轮的留场根还会自删（PITFALLS §109/§111 同族），否则绿轮连"当时实例多大年纪、有没有刚重建"都读不到，
// 3 轮相关性就没有可对齐的样本。只追加、不参与判定、写失败不改退出码；轮次跑完由执行人删除该文件。
// 票 14-R：每场景记 n 次逐次值（绿轮也写——那是攒红样本的唯一通道），替代旧 p1/p2/最坏 三元组。
try {
  const rec = [
    `── ${new Date().toISOString()} storm 归因读数 rc=${ok ? 0 : 1} 判定=${ok ? 'PASS' : 'FAIL'}（判定形态 k-of-n：n=${SCENE_REPEATS} k=${RED_K}，票 14-R 任务 1）`,
    ...prereadLines.map((l) => l.trim()),
    ...sceneVerdicts.map((s) => `场景 ${s.name}：逐次 ${s.vals.join('/')} → >2 共 ${s.exceed} 次（k=${RED_K}，${s.red ? 'FAIL' : '未达'}）／==2 临界 ${s.critical} 次`),
    '',
  ];
  fs.appendFileSync(path.join(os.tmpdir(), 'showcase-rtci-storm-readout.log'), rec.join('\n'), 'utf8');
} catch (e) {
  console.log(`  ⚠ 归因读数落盘失败（不影响判定与退出码）：${e.message}`);
}
clearInterval(timer);
sampling = false;
if (!ok) {
  console.log(`\n结论：FAIL（判定形态 k-of-n：${SCENE_REPEATS} 次里 ≥${RED_K} 次翻转 >2 的场景见上——逐次读数已全部落盘归因文件）`);
  for (const s of sceneVerdicts.filter((x) => x.red)) {
    const worstRun = s.runs.filter((x) => x.flips > RED_LINE).sort((a, b) => b.flips - a.flips)[0];
    console.log(`  ${s.name} 越线 ${s.exceed}/${SCENE_REPEATS} 次；最坏一次（第 ${worstRun.r} 次，翻转 ${worstRun.flips} 次）的明细：`);
    for (const l of worstRun.flipLog.slice(0, 12)) console.log(l);
    if (worstRun.flipLog.length > 12) console.log(`    …共 ${worstRun.flipLog.length} 次`);
  }
  process.exit(1);
}
const critScenes = sceneVerdicts.filter((s) => s.critical > 0).map((s) => `${s.name}（${s.critical}/${SCENE_REPEATS} 次）`);
const exceedScenes = sceneVerdicts.filter((s) => s.exceed > 0);
console.log(
  `\n结论：PASS（判定形态 k-of-n：每场景 ×${SCENE_REPEATS} 次、>2 均 < k=${RED_K}` +
    `${exceedScenes.length ? `；越线非零 ${exceedScenes.length} 场（单次瞬时/尾部噪声形态，已逐场明打）` : ''}` +
    `${critScenes.length ? `；临界 ==红线上限 ${critScenes.length} 场：${critScenes.join('、')}——绿≠有余量（票 14-M 任务 2b 性质保留）` : ''}）`
);
process.exit(0);
