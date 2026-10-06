// 安装容器定位共享库（票 11-R 任务 2 抽件）：从 HKCU 卸载键反推装机容器与数据根，
// 供探针/判据件读「装机日志目录」用——替代散落在各件里的本机绝对路径字面量（公开面脱敏）。
// 口径照 probe-compat-layer-state.js 已实跑通的那套：
//   guid 真源 = package.json 的 build.nsis.guid（verify-identity 把它钉成字面值）；
//   优先 InstallLocation，缺失从 UninstallString / DisplayIcon 反推（`<容器>\bin\...` → <容器>），
//   数据根 = <容器>\data（config.js 新结构同款口径）。
// reg 直读的两个本机实测坑（同 probe 的处理，别在新调用方再踩一遍）：
//   1) reg.exe 中文 Windows 按 OEM 码页（936/GBK）输出，按 utf8 读成乱码 → TextDecoder('gbk') 兜底；
//   2) 「键不存在」与「命令跑不起来」exit code 不分（都 1）→ 靠 ASCII 类型名标记（REG_SZ 等）区分，
//      真正的执行异常向上抛，由 installContainer() 捕获记入 lastError()。
// 纯 node 零原生依赖（铁律 5）。
// ⚠ 取不到时 installedDataRoot() 返回 null——调用方必须显式打「未取到安装容器，本件只查了 dev 目录」
//   并**不得据此打绿灯**：装机日志读不到 ≠ 没有候选，零候选 ≠ 通过（判据拒绝在"读不到"上放行）。
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const PKG = require('../package.json');

const decode = (buf) => {
  if (!buf) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  for (const enc of ['gbk', 'utf8']) {
    try {
      return new TextDecoder(enc).decode(b);
    } catch {}
  }
  return b.toString('latin1');
};
const NOT_FOUND = /找不到|cannot find|unable to save|ERROR.*(1860|2)\b/i;
const regQuery = (key) => {
  let out = '';
  try {
    const r = execFileSync('reg', ['query', key], { maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    out = decode(r);
  } catch (e) {
    out = decode(e.stdout) + '\n' + decode(e.stderr);
    if (!NOT_FOUND.test(out)) throw new Error(`reg query ${key} 异常（非"键不存在"）：${out.trim().slice(0, 120) || e.message}`);
    return null; // 明确的「该键不存在」
  }
  return /\bREG_[A-Z]+\b/.test(out) ? out : null; // 有值才返回文本；无值按「不存在」处理
};

let lastErr = null;
let cached; // undefined=未查过；null=取不到；对象=结果（本进程内 memo，reg query 不便宜）

/**
 * 反推装机容器。取到返回 { container, from }；取不到返回 null（原因看 lastError()）。
 */
function installContainer() {
  if (cached !== undefined) return cached;
  cached = null;
  const guid = PKG.build && PKG.build.nsis && PKG.build.nsis.guid;
  if (!guid) {
    lastErr = 'package.json 缺 build.nsis.guid：卸载键无从定位';
    return cached;
  }
  let un;
  try {
    un = regQuery(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`);
  } catch (e) {
    lastErr = e.message;
    return cached;
  }
  if (un === null) {
    lastErr = `卸载键不存在或无值（guid=${guid}）——装机版未安装或已被卸载`;
    return cached;
  }
  const pick = (name) => {
    const m = un.match(new RegExp('^\\s*' + name + '\\s+REG_SZ\\s+(.+)$', 'm'));
    return m ? m[1].trim() : null;
  };
  let loc = pick('InstallLocation');
  let from = 'InstallLocation';
  if (!loc) {
    // 实测形态：卸载键里没有 InstallLocation，但 UninstallString 带着容器路径
    const s = pick('UninstallString') || pick('DisplayIcon') || '';
    const m = s.match(/^"?(.*?\\)bin\\([^"\\]+)/i);
    if (m) {
      loc = m[1].replace(/\\+$/, '');
      from = 'UninstallString 反推';
    }
  }
  if (!loc) {
    lastErr = '卸载键里既无 InstallLocation，也无法从 UninstallString/DisplayIcon 反推容器路径';
    return cached;
  }
  cached = { container: loc, from };
  return cached;
}

/**
 * 装机数据根 = <容器>\data。取到返回 { container, from, dataDir }；取不到返回 null。
 * 调用方契约：null 时必须显式打「未取到安装容器，本件只查了 dev 目录」，且不得据此打绿灯。
 */
function installedDataRoot() {
  const c = installContainer();
  return c ? { container: c.container, from: c.from, dataDir: path.join(c.container, 'data') } : null;
}

/** 取不到时的原因（null 表示没有记录过失败）。 */
function lastError() {
  return lastErr;
}

module.exports = { installContainer, installedDataRoot, lastError };
