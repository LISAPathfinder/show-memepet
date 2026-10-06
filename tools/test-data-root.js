// config.js 数据根定位单测：用假 electron 模块驱动 app.isPackaged / app.getPath('exe')，
// 覆盖新结构（程序在 <容器>\bin\ 下）、旧结构（安装目录同级 -data）、写失败回退、dev 四种分支，
// 外加环境变量覆盖的行为级对拍（⑤，票 11-R：⑥ 退休的退出码牙齿——旧名必须被忽略、新名必须生效）。
// 用法：node tools/test-data-root.js
const fs = require('fs');
const path = require('path');
const Module = require('module');

delete process.env.SHOWCASE_DATA_DIR; // 环境变量接缝会干扰本测试（旧名 DESKTOP_PET_DATA_DIR 的回落已随票 11-Q 退休，不再需要清）

const origLoad = Module._load;
let fakeElectron = null;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

const CONFIG = path.join(__dirname, '..', 'config.js');
function withFake(exePath, userDataDir) {
  fakeElectron = { app: { isPackaged: true, getPath: (k) => (k === 'exe' ? exePath : userDataDir) } };
  delete require.cache[require.resolve(CONFIG)];
  return require(CONFIG);
}

const TMP = path.join(process.env.TEMP || process.env.TMP || '.', 'pet-dataroot-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n    got      ${actual}\n    expected ${expected}`);
  }
}

console.log('== ① 新结构：程序在 <容器>\\bin\\ 下 ==');
{
  const container = path.join(TMP, 'app');
  fs.mkdirSync(path.join(container, 'bin'), { recursive: true });
  const c = withFake(path.join(container, 'bin', 'Showcase.exe'), path.join(TMP, 'userdata'));
  check('数据根 = 容器', c.USER_DATA_ROOT, container);
  check('DATA_DIR = <容器>\\data', c.DATA_DIR, path.join(container, 'data'));
  check('SKIN_ROOT = <容器>\\skin', c.SKIN_ROOT, path.join(container, 'skin'));
  check('探测时已建好 data 目录', fs.existsSync(path.join(container, 'data')), true);
}

console.log('== ② 旧结构：程序直接装在安装目录下 ==');
{
  const installDir = path.join(TMP, 'legacy', 'showcase');
  fs.mkdirSync(installDir, { recursive: true });
  const c = withFake(path.join(installDir, 'Showcase.exe'), path.join(TMP, 'userdata'));
  check('数据根 = 同级 <安装目录名>-data', c.USER_DATA_ROOT, path.join(TMP, 'legacy', 'showcase-data'));
}

console.log('== ③ 容器不可写（用文件占位）→ 回退 userData ==');
{
  const blocker = path.join(TMP, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const c = withFake(path.join(blocker, 'bin', 'Showcase.exe'), path.join(TMP, 'userdata'));
  check('回退 userData', c.USER_DATA_ROOT, path.join(TMP, 'userdata'));
}

console.log('== ④ dev（isPackaged=false）==');
{
  fakeElectron = { app: { isPackaged: false, getPath: () => '' } };
  delete require.cache[require.resolve(CONFIG)];
  const c = require(CONFIG);
  check('数据根 = 项目根', c.USER_DATA_ROOT, path.join(__dirname, '..'));
}

console.log('== ⑤ 环境变量覆盖对拍（票 11-R 任务 1：⑥ 退休的退出码牙齿）==');
// 判据落在行为层（config.js 真 require 出来的 DATA_DIR），不是搜字符串：谁把旧名回落改回
// config.js（process.env.SHOWCASE_DATA_DIR || process.env.DESKTOP_PET_DATA_DIR），(a) 必红。
{
  // (a) 只设旧名 DESKTOP_PET_DATA_DIR、不设新名 ⇒ 旧名被静默忽略，DATA_DIR 落回默认根
  const dirA = path.join(TMP, 'legacy-env-a');
  process.env.DESKTOP_PET_DATA_DIR = dirA;
  delete process.env.SHOWCASE_DATA_DIR;
  const ca = withFake(path.join(TMP, 'app', 'bin', 'Showcase.exe'), path.join(TMP, 'userdata'));
  check('旧名 DESKTOP_PET_DATA_DIR 被忽略（DATA_DIR 不得等于旧名目录）', ca.DATA_DIR === dirA, false);
  check('  且落回默认根 <容器>\\data', ca.DATA_DIR, path.join(TMP, 'app', 'data'));

  // (b) 设新名 SHOWCASE_DATA_DIR ⇒ 必须正是它（正向对照：证明 (a) 不是"env 根本没接上"的假绿）
  const dirB = path.join(TMP, 'new-env-b');
  delete process.env.DESKTOP_PET_DATA_DIR;
  process.env.SHOWCASE_DATA_DIR = dirB;
  const cb = withFake(path.join(TMP, 'app', 'bin', 'Showcase.exe'), path.join(TMP, 'userdata'));
  check('新名 SHOWCASE_DATA_DIR 生效（DATA_DIR = 新名目录）', cb.DATA_DIR, dirB);

  delete process.env.SHOWCASE_DATA_DIR; // 还原现场，别让接缝漏到进程外
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
