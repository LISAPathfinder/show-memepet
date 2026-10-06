// 验证「开机自启时以管理员身份运行」的 Run 键方案（1.0.32，替代任务计划方案）。
// 可自动化部分：
//   ① 判定纯函数 shouldRequestElevationOnBoot 的真值表（require 真模块，非镜像）
//   ② 行为级：带 --autostart 标记的隔离实例正常启动、标记确实到达主进程 argv、
//      autoStartAdmin=false 时**不**发起提权（日志无提权请求行，进程存活）
// 不可自动化部分（弹真 UAC，留用户实机验收）：勾选菜单 → 重启机器 → UAC 弹窗 →
//   提权拉起；UAC 取消 → 降级普通权限继续跑。
// 用法：node tools/verify-autostart-elevation.js  （前置：无其它实例占用 9229）
// 断言不符 exit 1；端口被占 exit 3。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electronExe = require('electron'); // electron 包在普通 node 下导出 dist\electron.exe 的绝对路径

const { AUTOSTART_ARG, ELEVATED_AUTOSTART_ARG, shouldRequestElevationOnBoot } = require('../autostart-elevation');

let failed = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inspectorEvaluate(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = targets.find((x) => x.type === 'node') || targets[0];
  if (!t) throw new Error(`端口 ${port} 无 inspector 目标`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const r = await new Promise((resolve, reject) => {
    const id = 1;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  ws.close();
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 失败');
  return r.result.value;
}

async function main() {
  console.log('① 判定纯函数真值表（autostart-elevation.js）');
  check('开机标记 + 配置开 → 提权', shouldRequestElevationOnBoot([AUTOSTART_ARG], true), true);
  check('开机标记 + 配置关 → 不提权', shouldRequestElevationOnBoot([AUTOSTART_ARG], false), false);
  check('手动启动（无标记）→ 永不提权', shouldRequestElevationOnBoot([], true), false);
  check('提权产物实例（ELEVATED 标记）→ 跳过（防 UAC 循环）', shouldRequestElevationOnBoot([AUTOSTART_ARG, ELEVATED_AUTOSTART_ARG], true), false);
  check('仅 ELEVATED 标记（无开机标记）→ 不提权', shouldRequestElevationOnBoot([ELEVATED_AUTOSTART_ARG], true), false);
  check('config 假值形态（0/空串）→ 不提权', [shouldRequestElevationOnBoot([AUTOSTART_ARG], 0), shouldRequestElevationOnBoot([AUTOSTART_ARG], '')], [false, false]);

  console.log('② 行为级（隔离实例 + --autostart，autoStartAdmin=false）');
  const portBusy = await (async () => {
    try { await fetch('http://127.0.0.1:9229/json/list'); return true; } catch { return false; }
  })();
  if (portBusy) {
    console.error('  9229 被占用（有别的实例在跑），本件要求独占 → exit 3');
    process.exit(3);
  }
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-elev-'));
  // 数据根隔离（票 11-B 第 5c 条引入）。旧名 DESKTOP_PET_DATA_DIR 双传已随票 11-Q 退休（⑥，
  // config.js 不再读旧名）——只传新名即可；PET_USER_DATA_DIR 是另一条接缝（Chromium userData），原样保留
  const childEnv = {
    ...process.env,
    PET_USER_DATA_DIR: tmpData,
    SHOWCASE_DATA_DIR: tmpData,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE; // 宿主注入的该变量会让 electron 以 node 模式启动（bad option 坑）
  const child = spawn(electronExe, ['.', '--inspect=9229', AUTOSTART_ARG], { env: childEnv, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 25 && !up; i += 1) {
      try { await fetch('http://127.0.0.1:9229/json/list'); up = true; } catch { await sleep(1000); }
    }
    if (!up) throw new Error('隔离实例 25s 内 inspector 未就绪');
    await sleep(2500); // 给 bootApp 完整跑完（含提权判定的时机窗口）

    const inArgv = await inspectorEvaluate(9229, `process.argv.includes(${JSON.stringify(AUTOSTART_ARG)})`);
    check('Run 键 args 标记到达主进程 argv（setLoginItemSettings 同款传递路径）', inArgv, true);
  const flag = await inspectorEvaluate(9229, `process.mainModule.require('./config').get('autoStartAdmin')`);
  check('隔离实例 autoStartAdmin 默认关', flag, false);
    // 本件读的是自己隔离实例刚写的日志，写用名恒为 identity.LOG_NAME，无需候选回落（票 11-A）
    const { LOG_NAME } = require('../identity');
    const appLogPath = path.join(tmpData, LOG_NAME);
    const logText = fs.existsSync(appLogPath)
      ? fs.readFileSync(appLogPath, 'utf8')
      : '';
    check('未发起提权（日志无提权请求行）', /按配置请求管理员权限/.test(logText), false);
    check('带标记实例正常存活（未被提权流程打断）', !child.killed && child.exitCode === null, true);
  } finally {
    try {
      await inspectorEvaluate(9229, `process.mainModule.require('electron').app.quit()`);
    } catch {
      child.kill();
    }
    await sleep(1500);
    fs.rmSync(tmpData, { recursive: true, force: true });
  }

  console.log(failed === 0 ? '\n✓ 开机自启提权判定链路全部通过' : `\n✗ ${failed} 项断言不过`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验证失败:', err.message);
  process.exit(1);
});
