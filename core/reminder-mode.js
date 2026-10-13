// 久坐提醒的显示方式（票 13-B）。零依赖纯函数——不 require electron/config/fs/child_process、
// 不读 process.env、不用 Date.now，同输入必同输出，因此判据件直接 require 真函数求值
// （tools/verify-build-files.js 的 core 纯度闸守这条，tools/verify-reminder-mode.js 是真值表判据）。
// 立身之本：三态是**单一真源**，不再用「开关 + 是否发通知」两个布尔——那两个布尔能组成
// 「关着但仍发通知」这种无意义态，旧版靠嵌套 if 掩盖它，菜单也因此在同一件事上放两个勾。
'use strict';

const OFF = 'off';
const BUBBLE = 'bubble';
const NOTIFY = 'notify';

// 顺序即菜单自上而下的顺序（关闭／仅桌宠气泡／同时发 Windows 通知）。
const REMINDER_MODES = [OFF, BUBBLE, NOTIFY];

// 全新安装（没有任何旧键）时的默认显示方式 = 气泡 + Windows 通知。
// 沿用 1.0.53 起的旧默认（reminderEnabled=true 且 reminderNotifyWindows=true），改交互不改默认行为。
const DEFAULT_MODE = NOTIFY;

function isMode(v) {
  return typeof v === 'string' && REMINDER_MODES.indexOf(v) >= 0;
}

// 读到非法值（手改配置、旧版本写坏、拼写错）时退回**调用方给的兜底**，本模块不自作主张修正。
function normalize(v, fallback) {
  return isMode(v) ? v : fallback;
}

function showsBubble(mode) {
  return mode === BUBBLE || mode === NOTIFY;
}

function showsToast(mode) {
  return mode === NOTIFY;
}

// 旧两键 → 三态（迁移真源）。enabled=false 时 notify 一律作废——旧代码里 toast 就嵌在
// `if (reminderEnabled)` 里面，所以「enabled=false 且 notify=true」的既有读数本来就是 OFF，
// 这里不是在改行为，是在把那个被嵌套掩盖的组合摊平成一个值。
// 两键都缺席 = 没有旧配置 ⇒ 用调用方给的 fallback（不在这伪造 DEFAULTS，避免第二份默认值）。
function fromLegacy(enabled, notify, fallback) {
  if (enabled === undefined && notify === undefined) return fallback;
  if (!enabled) return OFF;
  return notify ? NOTIFY : BUBBLE;
}

// 菜单三项的勾选态：一个 mode 进来，三个 which 出去，恒恰有一项为真（互斥由这里保证，
// main.js 不再自己写布尔组合——「参考开机自启」要的是同一件事只有一处判定）。
function checkedFor(mode, which, fallback) {
  return normalize(mode, fallback) === which;
}

module.exports = {
  OFF,
  BUBBLE,
  NOTIFY,
  DEFAULT_MODE,
  REMINDER_MODES,
  isMode,
  normalize,
  showsBubble,
  showsToast,
  fromLegacy,
  checkedFor,
};
