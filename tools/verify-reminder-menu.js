// @runtime: self-launch —— 件内 spawn 带调试端口的隔离实例（9229 主进程 inspector + 9333 渲染端 CDP）
// 久坐提醒三态的**真机渲染取证**（票 13-C）：verify-reminder-mode 判的是纯函数与结构对齐，本件判的是
// 「用户实际打开菜单时看到的东西」——三级证据链的最后一环：
//   ①主列表里「久坐提醒」是带 › 的导航项，且**旧的两个勾已经不在**（残留必红）
//   ②子菜单三行文案与顺序 == 关闭／仅桌宠气泡／同时发 Windows 通知，且**恰有一行打 ✓**，
//     ✓ 落在第几行由主进程真源当前值决定（派生断言，不硬编码「第一项」）
//   ③点一行真的改状态：主进程 config 读到新值、应用日志出现「久坐提醒显示方式改为 X」、菜单窗口按
//     「动作后关闭」的设计收起；再点**已勾着的那行** ⇒ 状态不变且日志不增（setReminderMode 的无副作用分支）
// 为什么必须实机：这段链上有三处只有跑起来才知道——菜单窗口是**动作后自动关闭**的（要重开才能看新勾态）、
// 齿轮是开关且有 300ms blur 防抖（`menu:open-at` 里 `lastMenuCloseAt`，重开太早会被吞，届时本件报的
// 就不是「渲染错」而是「没等到」——所以每一步都有明打的等待与独立的失败文案）、子菜单导航是渲染端本地
// 状态（`level = item`，不走 IPC）。静态判据看不见这三条中的任何一条。
//
// 前置与自清理：两个端口任一被占 → exit 3（要求独占，不与别的实例混跑）；全局看门狗 150s 超时 →
// 明打「超时」并按 1 退出；结束无论成败都 app.quit() + 轮询 tasklist 自证 electron.exe 计数归零 +
// 删临时数据根（§57 那族「探针挂死留一桌 electron.exe」的教训）。
// 用法：node tools/verify-reminder-menu.js [仓库根]
// 退出码：0 全绿 / 1 断言失败或件异常 / 3 前置不满足。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { spawn } = require('child_process');
const electronExe = require('electron');

const ROOT = (() => {
  const r = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  try { return fs.realpathSync.native(r); } catch (e) {
    const fb = r.replace(/^([a-zA-Z]):/, (d) => d.toUpperCase());
    console.error(`⚠ verify-reminder-menu: realpathSync.native 失败（${e.message}）——显式退回盘符大写：${fb}`);
    return fb;
  }
})();
// §96：CDP 里 require 产品模块必须用规范化绝对路径，否则与产品 config 分裂成第二个缓存副本
const CFG_REQ = `process.mainModule.require(${JSON.stringify(path.join(ROOT, 'config.js'))})`;
const PORT_MAIN = 9229;
const PORT_PAGE = 9333;
const MODES = ['off', 'bubble', 'notify'];
const LABELS = { off: '关闭', bubble: '仅桌宠气泡', notify: '同时发 Windows 通知' };

let failed = 0;
let aborted = null;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`${what} 超时（${ms}ms）`);
    await sleep(250);
  }
}

async function evalOn(port, pick, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = pick(targets);
  if (!t) throw new Error(`端口 ${port} 上找不到目标`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const r = await new Promise((resolve, reject) => {
    const id = 1;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'evaluate 失败');
  return r.result.value;
}
const mainEval = (expr) => evalOn(PORT_MAIN, (ts) => ts.find((x) => x.type === 'node') || ts[0], expr);
const pageEval = (needle, expr) => evalOn(PORT_PAGE, (ts) => ts.find((x) => x.type === 'page' && (x.url || '').includes(needle)), expr);

// 菜单 DOM 快照：每行的文本/勾字符/是否有 ›，外加当前层级标题（区分主列表与子菜单）
const DUMP = `(() => {
  const rows = [...document.querySelectorAll('#items .item')].map((r) => ({
    label: (r.children[1] ? r.children[1].textContent : '').trim(),
    mark: (r.children[0] ? r.children[0].textContent : '').trim(),
    arrow: !!r.querySelector('.arrow'),
  }));
  const bar = document.getElementById('level-bar');
  return JSON.stringify({
    rows,
    inSubmenu: !!bar && !bar.classList.contains('hidden'),
    title: (document.getElementById('level-title') || {}).textContent || '',
  });
})()`;
// 按文本点某一行（真入口：走渲染端自己的 click 监听，不碰主进程内部函数）
const clickRow = (label) => `(() => {
  const r = [...document.querySelectorAll('#items .item')]
    .find((x) => (x.children[1] ? x.children[1].textContent : '').trim() === ${JSON.stringify(label)});
  if (!r) return 'NO-ROW';
  r.click();
  return 'CLICKED';
})()`;

// 菜单窗口 target 出现 ≠ 页面渲染完成：menu.js 是 `getMenuData().then(render)`（异步 IPC），
// 只等 target 会把前几次查询打在空白 DOM 上——首跑就是这么连锁红的（不是产品问题）。
// 因此每次开窗/进子菜单都必须轮询到**结构本身到位**。
async function dumpMenu() { return JSON.parse(await pageEval('menu.html', DUMP)); }
async function waitMenu(what, pred, ms = 12000) {
  const d = await until(async () => { const x = await dumpMenu(); return pred(x) ? x : null; }, ms, what);
  return d;
}
async function openMenu(tag) {
  await pageEval('pet.html', `window.petAPI.openMenuAt(120, 120); ${JSON.stringify(tag)}`);
  await until(async () => { const t = await (await fetch(`http://127.0.0.1:${PORT_PAGE}/json/list`)).json(); return t.some((x) => (x.url || '').includes('menu.html')) || null; }, 12000, `菜单窗口出现（${tag}）`);
  return waitMenu(`菜单渲染完成（${tag}）`, (x) => x.rows.length >= 8);
}
async function enterSubmenu() {
  check('点「久坐提醒」进入子菜单', await pageEval('menu.html', clickRow('久坐提醒')), 'CLICKED');
  return waitMenu('已切到子菜单', (x) => x.inSubmenu === true && x.rows.length === MODES.length);
}

function electronProcCount() {
  try {
    const out = cp.execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], { encoding: 'utf8' });
    return out.split('\n').filter((l) => /^\s*electron\.exe\s/i.test(l)).length;
  } catch (e) {
    return -1;
  }
}

async function main() {
  for (const p of [PORT_MAIN, PORT_PAGE]) {
    let free = false;
    try { await fetch(`http://127.0.0.1:${p}/json/list`); } catch { free = true; }
    if (!free) { console.error(`前置不满足：端口 ${p} 已被占用（本件要求独占调试端口，请先关掉其它实例）`); process.exit(3); }
  }

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-menu-'));
  const { LOG_NAME } = require('../identity');
  const logPath = path.join(tmpData, LOG_NAME);
  const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
  const env = { ...process.env, PET_USER_DATA_DIR: tmpData, SHOWCASE_DATA_DIR: tmpData };
  delete env.ELECTRON_RUN_AS_NODE; // 宿主注入会让 electron 以 node 模式起（PITFALLS §4.9 那一族）
  const child = spawn(electronExe, ['.', `--inspect=${PORT_MAIN}`, `--remote-debugging-port=${PORT_PAGE}`],
    { env, cwd: ROOT, stdio: 'ignore' });
  const watchdog = setTimeout(() => { aborted = '全局看门狗 150s 超时'; try { child.kill(); } catch {} }, 150000);

  try {
    await until(async () => { try { await fetch(`http://127.0.0.1:${PORT_MAIN}/json/list`); return 1; } catch { return 0; } }, 40000, '主进程 inspector 就绪');
    await until(async () => { try { const t = await (await fetch(`http://127.0.0.1:${PORT_PAGE}/json/list`)).json(); return t.some((x) => (x.url || '').includes('pet.html')) || null; } catch { return 0; } }, 40000, '渲染端 pet.html 目标就绪');
    await sleep(2500); // bootApp 完整跑完（含托盘与定时器）

    console.log('① 起点状态与主列表结构');
    const startMode = await mainEval(`${CFG_REQ}.get('reminderMode')`);
    check('隔离实例默认三态 = notify（沿用 1.0.53 起的默认）', startMode, 'notify');
    check('旧两键不在产品 config 真源里（不留双真源）',
      [await mainEval(`${CFG_REQ}.get('reminderEnabled')`), await mainEval(`${CFG_REQ}.get('reminderNotifyWindows')`)],
      [null, null]); // CDP 的 returnByValue 把 undefined 序列化成 null，期望值按线上形态写

    const main0 = await openMenu('第一次');
    const navRow = main0.rows.find((r) => r.label === '久坐提醒');
    check('主列表有「久坐提醒」导航项且带 ›', !!navRow && navRow.arrow, true);
    check('导航父项自身不带勾（开关职责在子菜单，照「开机自启」形态）', navRow && navRow.mark, '');
    check('主列表已无旧的第二勾', main0.rows.some((r) => r.label === LABELS.notify), false);
    check('主列表不含子菜单项（未进子菜单前不得出现「关闭」这类行）',
      main0.rows.some((r) => Object.values(LABELS).includes(r.label) && r.label !== '同时发 Windows 通知'), false);

    console.log('② 进子菜单：三行文案、顺序与唯一勾态');
    const sub0 = await enterSubmenu();
    check('子菜单标题＝久坐提醒（真的两级导航）', sub0.title, '久坐提醒');
    check('三行文案与顺序', sub0.rows.map((r) => r.label), MODES.map((m) => LABELS[m]));
    // 勾态判定统一走这个函数（曾经把箭头函数本身拿去和 0 比较 ⇒ 一条永远红的判据，2026-10-13 抓到）
    const checkedIndexOf = (rows) => rows.map((r) => r.mark).findIndex((m) => m === '✓');
    const checkedCount = (rows) => rows.filter((r) => r.mark === '✓').length;
    const firstIdx = checkedIndexOf(sub0.rows);
    check('恰有一行打勾', [firstIdx >= 0, checkedCount(sub0.rows)], [true, 1]);
    check('✓ 落在与主进程真源当前值一致的那一行（派生断言，不硬编码第一项）', MODES[firstIdx], startMode);

    console.log('③ 点「仅桌宠气泡」：状态、日志、动作后菜单收起');
    check('点子项', await pageEval('menu.html', clickRow(LABELS.bubble)), 'CLICKED');
    await sleep(800);
    check('主进程 config 读到 bubble', await mainEval(`${CFG_REQ}.get('reminderMode')`), 'bubble');
    check('应用日志有本次改动锚点', /久坐提醒显示方式改为 bubble/.test(readLog()), true);
    const closed = await until(async () => { const t = await (await fetch(`http://127.0.0.1:${PORT_PAGE}/json/list`)).json(); return !t.some((x) => (x.url || '').includes('menu.html')) || null; }, 8000, '动作后菜单窗口关闭');
    check('菜单窗口在动作后关闭（不是靠件自己关的）', !!closed, true);

    console.log('④ 重开并核对新勾态（含 300ms 开关防抖的等待）');
    await sleep(600); // 齿轮是开关且 open-at 有 300ms blur 防抖：太早重开会「没等到」而不是「渲染错」
    await openMenu('第二次');
    const sub1 = await enterSubmenu();
    check('重开后 ✓ 已移到「仅桌宠气泡」，且仍恰一项',
      [MODES[checkedIndexOf(sub1.rows)], checkedCount(sub1.rows)], ['bubble', 1]);

    console.log('⑤ 关闭态与「点已勾项无副作用」');
    check('点「关闭」', await pageEval('menu.html', clickRow(LABELS.off)), 'CLICKED');
    await sleep(800);
    check('主进程 config 读到 off', await mainEval(`${CFG_REQ}.get('reminderMode')`), 'off');
    await sleep(600);
    await openMenu('第三次');
    const sub2 = await enterSubmenu();
    check('off 状态下 ✓ 在第一行', [MODES[checkedIndexOf(sub2.rows)], checkedCount(sub2.rows)], ['off', 1]);
    const before = readLog().split('\n').length;
    check('再点已勾着的「关闭」这一行', await pageEval('menu.html', clickRow(LABELS.off)), 'CLICKED');
    await sleep(900);
    check('点已勾项后状态不变', await mainEval(`${CFG_REQ}.get('reminderMode')`), 'off');
    check('点已勾项不写日志（无副作用分支真的走通了 return）', readLog().split('\n').length, before);

    console.log('⑥ 落盘形态与实例健康');
    const cfgFile = JSON.parse(fs.readFileSync(path.join(tmpData, 'config.json'), 'utf8'));
    check('config.json 落盘的就是 reminderMode', cfgFile.reminderMode, 'off');
    check('落盘文件里没有旧两键', ['reminderEnabled', 'reminderNotifyWindows'].filter((k) => k in cfgFile), []);
    check('实例全程存活（菜单链上没崩）', [!child.killed, child.exitCode], [true, null]);
    check('本实例日志 uncaughtException 增量 = 0', (readLog().match(/uncaughtException/g) || []).length, 0);
  } finally {
    clearTimeout(watchdog);
    try { await mainEval(`process.mainModule.require('electron').app.quit()`); }
    catch (e) { console.log('  （app.quit 未接上，改为强杀：' + e.message.slice(0, 60) + '）'); try { child.kill(); } catch {} }
    await sleep(2500);
    let n = electronProcCount();
    for (let i = 0; i < 8 && n !== 0; i += 1) { await sleep(1000); n = electronProcCount(); }
    console.log(`  收尾自证：残留 electron.exe 进程数 = ${n}（应为 0）`);
    if (n !== 0) failed += 1;
    fs.rmSync(tmpData, { recursive: true, force: true });
  }

  if (aborted) { console.error(`✗ ${aborted}`); process.exit(1); }
  console.log(failed === 0 ? '\n✓ 久坐提醒三态的真机渲染取证全部通过' : `\n✗ ${failed} 项断言不过`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('验证失败:', String(err.message || err).slice(0, 200)); process.exit(1); });
