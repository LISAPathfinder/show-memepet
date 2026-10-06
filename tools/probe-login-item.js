// 只读三源对照探针（票 11-D 任务 2）：定性 11-C 复查假阴性的机制——
//   (a) 裸 getLoginItemSettings() 与写入时带的 --autostart 不匹配 → 恒 false；
//   (b) 同进程 set 之后立刻 get 的时序问题。
// 做法：spawn 一个最小 Electron 探针 app（目录 tools/tmp-probe-login-item/，跑完删掉——
// 从 %TEMP% 起 Electron 起不来，11-C 校验轮实测），对照三源：
//   ① 裸 getLoginItemSettings().openAtLogin
//   ② getLoginItemSettings({ args: ['--autostart'] }).openAtLogin
//   ③ reg query 直读 'electron.app.' + app.getName()（解析复用 autostart-migration.findRunEntry，
//      不写第二套解析）
// 纪律：探针 app 只 get。本件在 spawn 前自查探针源码，出现 setLoginItemSettings / reg delete /
//   reg add / WriteValue / DeleteValue 即拒绝执行（越界防线）；spawn 时删掉 ELECTRON_RUN_AS_NODE
//   （PITFALLS §4.6）并把 PET_USER_DATA_DIR 指到临时目录（§65 子坑 1，不撞在跑实例）。
// exit：三源一致=0；不一致=1 并打印差在哪一源；探针本身起不来=2。
// 用法：node tools/probe-login-item.js
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronExe = require('electron'); // 普通 node 下 electron 包导出 dist\electron.exe 路径
const { findRunEntry, commandImageBasename } = require('../autostart-migration');

const PROBE_DIR = path.join(__dirname, 'tmp-probe-login-item');
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; // 与 main.js RUN_KEY_PATH 同值（main.js 不可 require，只读使用处各自定义）
const AUTOSTART_ARG = '--autostart'; // 与 autostart-elevation.AUTOSTART_ARG 同值

// JSON.stringify 把反斜杠转成 \\ 源码形态，正好是 probe-main.js 里字符串字面量需要的转义
const RUN_KEY_LITERAL = JSON.stringify(RUN_KEY_PATH);
const AUTOSTART_LITERAL = JSON.stringify(AUTOSTART_ARG);

const PROBE_MAIN = `'use strict';
// 最小只读探针 app（由 tools/probe-login-item.js 生成、跑完即删）：只 get，不 set，不开窗口。
const { app } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const { findRunEntry, commandImageBasename } = require('../../autostart-migration');

if (process.env.PET_USER_DATA_DIR) app.setPath('userData', process.env.PET_USER_DATA_DIR);

app.whenReady().then(() => {
  const valueName = 'electron.app.' + app.getName();
  const bare = app.getLoginItemSettings();
  const withArgs = app.getLoginItemSettings({ args: [${AUTOSTART_LITERAL}] });
  execFile('reg', ['query', ${RUN_KEY_LITERAL}], { windowsHide: true }, (qErr, qOut) => {
    const entry = qErr || !qOut ? null : findRunEntry(String(qOut), valueName);
    const payload = {
      getName: app.getName(),
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      bare: { openAtLogin: bare.openAtLogin, executableWillLaunchAtLogin: bare.executableWillLaunchAtLogin, path: bare.path, args: bare.args },
      withArgs: { openAtLogin: withArgs.openAtLogin, executableWillLaunchAtLogin: withArgs.executableWillLaunchAtLogin, path: withArgs.path, args: withArgs.args },
      reg: {
        queryError: qErr ? String(qErr.message) : null,
        valueName,
        found: !!entry,
        command: entry ? entry.command : null,
        commandBasename: entry ? commandImageBasename(entry.command) : null,
        execPathBasename: path.basename(process.execPath).toLowerCase(),
      },
    };
    payload.reg.basenameMatch = !!(entry && payload.reg.commandBasename === payload.reg.execPathBasename);
    console.log('@PROBE@' + JSON.stringify(payload));
    app.exit(0);
  });
});
`;

const FORBIDDEN = ['setLoginItemSettings', 'reg delete', 'reg add', 'WriteValue', 'DeleteValue'];

function cleanup(userDataDir) {
  try { fs.rmSync(PROBE_DIR, { recursive: true, force: true }); } catch {}
  if (userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}

for (const w of FORBIDDEN) {
  if (PROBE_MAIN.includes(w)) {
    console.error(`[FAIL] 探针源码含禁词「${w}」（探针只许 get）`);
    cleanup(null);
    process.exit(2);
  }
}

// 生成探针 app
fs.mkdirSync(PROBE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(PROBE_DIR, 'package.json'),
  JSON.stringify({ name: 'showcase', productName: 'Showcase', main: 'probe-main.js' }, null, 2) + '\n'
);
fs.writeFileSync(path.join(PROBE_DIR, 'probe-main.js'), PROBE_MAIN);

const userDataDir = path.join(os.tmpdir(), 'showcase-login-probe-' + Date.now());
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // §4.6：宿主 shell 带着它会把 electron.exe 变纯 node
env.PET_USER_DATA_DIR = userDataDir; // §65 子坑 1：隔离 userData，不撞在跑实例

console.log('探针身份：app dir=' + PROBE_DIR + '（package.json name=showcase / productName=Showcase，只 get）');
console.log('electron.exe = ' + electronExe);

const child = spawn(electronExe, [PROBE_DIR], { cwd: PROBE_DIR, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let err = '';
const timer = setTimeout(() => {
  console.error('[FAIL] 探针 30s 无输出（stderr 见下）');
  if (err) console.error(err);
  child.kill();
  cleanup(userDataDir);
  process.exit(2);
}, 30000);

child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
child.on('exit', () => {
  clearTimeout(timer);
  try {
    const line = out.split(/\r?\n/).find((l) => l.startsWith('@PROBE@'));
    if (!line) {
      console.error('[FAIL] 探针未产出读数。stdout=\n' + out + '\nstderr=\n' + err);
      cleanup(userDataDir);
      process.exit(2);
    }
    const d = JSON.parse(line.slice('@PROBE@'.length));
    const regFound = d.reg.found === true;
    const bare = d.bare.openAtLogin === true;
    const withArgs = d.withArgs.openAtLogin === true;

    console.log('\n== 三源对照原始读数 ==');
    console.log(`app.getName()=${JSON.stringify(d.getName)}  isPackaged=${d.isPackaged}`);
    console.log(`process.execPath=${d.execPath}`);
    console.log(`源① 裸 getLoginItemSettings().openAtLogin = ${d.bare.openAtLogin}（path=${JSON.stringify(d.bare.path)}, args=${JSON.stringify(d.bare.args)}, willLaunch=${d.bare.executableWillLaunchAtLogin}）`);
    console.log(`源② getLoginItemSettings({args:['--autostart']}).openAtLogin = ${d.withArgs.openAtLogin}（path=${JSON.stringify(d.withArgs.path)}, args=${JSON.stringify(d.withArgs.args)}, willLaunch=${d.withArgs.executableWillLaunchAtLogin}）`);
    console.log(`源③ reg query 直读 ${d.reg.valueName}：found=${d.reg.found}${d.reg.command ? ` command=${d.reg.command}（基名 ${d.reg.commandBasename}，与探针 execPath 基名相等=${d.reg.basenameMatch}）` : ''}${d.reg.queryError ? ` queryError=${d.reg.queryError}` : ''}`);

    console.log('\n== 一致性裁决 ==');
    if (bare === withArgs && withArgs === regFound) {
      console.log(`三源一致（都=${bare}）。`);
      console.log('判读：裸调用此刻与注册表一致 → 11-C 的假阴性更符合候选 (b)（set 后那一瞬的时序），而不是裸调用恒错。');
      cleanup(userDataDir);
      process.exit(0);
    }
    console.log('不一致，差在：');
    if (bare !== regFound) console.log(`  源①（裸调用 ${bare}）与源③（注册表 ${regFound}）不一致`);
    if (withArgs !== regFound) console.log(`  源②（带 args ${withArgs}）与源③（注册表 ${regFound}）不一致`);
    if (bare !== withArgs) console.log(`  源①（裸 ${bare}）与源②（带 args ${withArgs}）不一致`);
    if (!bare && withArgs && regFound) {
      console.log('  → 形态与票面候选 (a) 一致：带 args 的 get 与注册表一致、裸 get 恒 false。');
    } else if (!bare && !withArgs && regFound) {
      console.log('  → 票面 (a)/(b) 两者都不成立（两个 get 都读不到而注册表有）：停下，回报原始读数，不要继续改。');
    }
    cleanup(userDataDir);
    process.exit(1);
  } catch (e) {
    console.error('[FAIL] 解析探针输出失败: ' + e.message + '\nstdout=\n' + out + '\nstderr=\n' + err);
    cleanup(userDataDir);
    process.exit(2);
  }
});
