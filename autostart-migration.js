// Run 键读回 / StartupApproved 解析的纯逻辑（票 11-C 任务 1a / 票 11-D 任务 1a 抽出）。
// 纯逻辑、零依赖：main.js 引用，tools/verify-autostart-migration.js 直接 require 测真函数，
// 不做镜像断言（与 autostart-elevation.js 同形态）。
// 背景（票 11-B 校验结论）：实机 `reg query` 每行行首是 4 个空格，行解析必须容忍行首空白——
// 11-B 版正则不容空白、对实机 dump 命中 0 行，是「自启清理静默空转」的根因；这条教训现已
// 落在 verify-autostart-migration 的回归基线上（旧缺陷正则命中 0 / 活判据 findRunEntry 命中 1）。
// 旧键匹配 pickLegacyRunEntries 已随票 11-Q 退休（④：自启旧值名清理段撤除），本件不再收旧名。

// reg query 输出一行的统一解析（票 11-D 1a：旧名匹配与新键读回共用同一套规则，不写第二个正则）。
// 实机 reg query 每行行首 4 个空格，必须容忍行首空白（票 11-B 空转根因）。
// 返回 { valueName, type, command }（command 已 trim、type 归一成大写）；
// 表头行 / 空行 / 不成形行返回 null。
// 限制（与 11-C 版正则一致并在此显式登记）：值名含空格的行解析不了——Electron 派生名不含空格，
// 本项目判据只处理无空格值名。
const RUN_LINE_RE = /^\s*(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/i;

function parseRunLine(line) {
  const m = String(line || '').match(RUN_LINE_RE);
  if (!m) return null;
  return { valueName: m[1], type: m[2].toUpperCase(), command: m[3].trim() };
}

// 从命令串取映像名基名（小写）。优先取第一个带引号的 token（Run 键值的标准形态
// `"D:\path\to\app.exe" --args`），无引号则取首个空白前的 token。
// 用「基名全等」而不是子串包含：目录名里含旧名但映像名不同（如 <安装目录>\bin\helper.exe）
// 不算命中——判据是「指向旧 exe」（票 11-B 第 4 条防误删条款：用户手工改过指向的键不动）。
function commandImageBasename(command) {
  const s = String(command || '').trim();
  if (!s) return '';
  const quoted = s.match(/^"([^"]+)"/);
  const exePath = quoted ? quoted[1] : s.split(/\s+/)[0];
  const base = exePath.slice(Math.max(exePath.lastIndexOf('\\'), exePath.lastIndexOf('/')) + 1);
  return base.toLowerCase();
}

// 从 reg query 输出里按值名精确找 Run 键条目（票 11-D 任务 1a）：迁移后「新键到底在不在」的注册表直读判据。
// 注册表值名大小写不敏感（Windows 语义），比对按小写、返回值保留注册表里的原样大小写。
// 类型不限：REG_SZ / REG_EXPAND_SZ 等都算「值存在」（Run 键自启读取不挑类型）；
// command 是否指向当前 exe 由调用方用 commandImageBasename 复核（main.js 1b 的第二判据）。
function findRunEntry(regQueryText, valueName) {
  if (!regQueryText || !valueName) return null;
  const want = String(valueName).toLowerCase();
  for (const line of String(regQueryText).split(/\r?\n/)) {
    const parsed = parseRunLine(line);
    if (!parsed) continue;
    if (parsed.valueName.toLowerCase() === want) {
      return { valueName: parsed.valueName, command: parsed.command };
    }
  }
  return null;
}

// StartupApproved\Run 二进制的禁用态解析（票 11-F，用户裁决：任务管理器禁用 = 意图不自启）。
// 实机实证形态（2026-10-04 读数）：首字节 01 = 用户在任务管理器禁用（后 8 字节为禁用时刻
// FILETIME，如 EADM=0100000009A408A7…）；02 / 03 = 启用（02 常为全零尾，03 带时间戳尾）。
// 无条目 = 任务管理器「未计量」= 启用。输入取 reg query StartupApproved\Run 的输出文本，
// 行解析复用 findRunEntry（同一套规则，不写第二个正则——REG_BINARY 行与 REG_SZ 行同构）。
// 返回：true = 启用；false = 禁用（首字节 01）；null = 文本里找不到该值名（调用方按启用处理）。
function isStartupApprovedEnabled(approvedQueryText, valueName) {
  const entry = findRunEntry(approvedQueryText, valueName);
  if (!entry) return null;
  const hex = String(entry.command).replace(/\s+/g, '');
  const first = parseInt(hex.slice(0, 2), 16);
  return Number.isFinite(first) ? first !== 1 : null;
}

module.exports = { findRunEntry, commandImageBasename, isStartupApprovedEnabled };
