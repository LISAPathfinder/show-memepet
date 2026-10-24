// @runtime: none —— 共享库（真入口「显示桌宠」：起第二实例 → second-instance → showPet 重建），被运行时件 require
// 票 14-I：产品 1.0.71 起显示桌宠只走「重建窗口」这一条路（PITFALLS §95）——同句柄
// `showInactive()` 重显会把渲染端冻住：外壳 visible=true、子窗被 Chromium 藏起来，点击全丢。
// 判据件若拿它收场，就等于**自己把场地弄成 §101 的坏态**再留给下一件（实测 verify-hide 之后
// verify-input-route-heal 必红，且产品自检为救场触发一次重建、留下 30s 冷却窗，把再下一件的
// 自愈判据也带红）。这里统一走用户真入口：再起一个实例撞单实例锁 → second-instance → showPet()。
//
// 前提：调用方进程的 env 里要有 PET_USER_DATA_DIR（装置/隔离 runner 都会传）——第二实例必须
// 撞同一把锁，否则起的是第二个应用而不是一次「显示」。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { LOG_CANDIDATES } = require('../identity');

const SHOW_LOG_RE = /显示桌宠（已重建窗口句柄/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logPathOf(dataDir) {
  for (const name of LOG_CANDIDATES) {
    const p = path.join(dataDir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return path.join(dataDir, LOG_CANDIDATES[0]);
}

const readLines = (p) => {
  try {
    const arr = fs.readFileSync(p, 'utf8').split('\n');
    while (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr;
  } catch {
    return [];
  }
};

function electronExeOf(root) {
  const e = (() => { try { return require(path.join(root, 'node_modules', 'electron')); } catch { return ''; } })();
  return typeof e === 'string' && e ? e : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
}

// 返回 { ok, ms, logPath }。ok=false 时调用方按「前置不满足」处理并在 stderr 点名——
// 不许把它当断言失败（真入口走不通是装置/场地问题，不是产品行为不符预期）。
async function showPetBySecondInstance({ repoRoot, timeoutMs = 15_000 } = {}) {
  const root = repoRoot || path.join(__dirname, '..');
  const dataDir = process.env.SHOWCASE_DATA_DIR || path.join(root, 'data');
  const logPath = logPathOf(dataDir);
  const before = readLines(logPath).length;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 置空串不算，Electron 只查存在性（§64 子坑 1）
  const child = spawn(electronExeOf(root), [root], { env, stdio: 'ignore', detached: true });
  child.unref();
  const t0 = Date.now();
  for (;;) {
    await sleep(300);
    if (readLines(logPath).slice(before).some((l) => SHOW_LOG_RE.test(l))) {
      return { ok: true, ms: Date.now() - t0, logPath };
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, logPath };
  }
}

module.exports = { showPetBySecondInstance, SHOW_LOG_RE };
