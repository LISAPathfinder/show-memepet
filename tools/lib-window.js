// @runtime: none —— 共享库（原生窗口摆放/尺寸读数），被运行时判据件与装置 require，不独立执行
// 票 14-I：Electron 的 `setPosition` 在非整数 DIP 缩放下会**改窗口尺寸**（§98 产品侧已因此改
// `SetWindowPos(SWP_NOSIZE)`，见 main.js movePetWindowTo）。判据件与装置复位拍当时没跟上——
// 2026-10-23 实测（本机 DSF 1.13）：setPosition 往返 12 轮，窗口 605×605 → 638×635（+33px，
// 每轮 +2~3px）；同场地 SetWindowPos(SWP_NOSIZE) 12 轮恒定。
// 后果不是「差几像素」：复位拍本是每件前把脏场地写回默认的动作，用 setPosition 等于**每一次修复
// 都在把窗口往大推**，共享批越靠后的件场地越离谱——这就是「件间连锁污染」的机制。
//
// 用法（坐标一律**物理像素**；件里的几何通常是 DIP，换算走 lib-cursor 或产品自己的 dipToScreenPoint）：
//   placeWindow(hwnd, x, y)                        // 只移动，尺寸零改动（SWP_NOSIZE）
//   placeWindow(hwnd, x, y, { width, height })     // 移动 + 改尺寸——**只对可缩放窗口有效**：
//                                                  //   桌宠窗 resizable:false，带 cx/cy 会被 WM_GETMINMAXINFO
//                                                  //   钳在现值（ret=true 而尺寸不动），给它改尺寸只能走 setBounds
//   windowSize(hwnd) → { width, height }           // GetWindowRect 的物理尺寸
'use strict';
const path = require('node:path');
const koffi = require(path.join(__dirname, '..', 'node_modules', 'koffi'));

const user32 = koffi.load('user32.dll');
const SetWindowPos = user32.func('SetWindowPos', 'bool', ['uintptr', 'uintptr', 'int', 'int', 'int', 'int', 'uint32']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);
const FindWindowExW = user32.func('FindWindowExW', 'uintptr', ['uintptr', 'uintptr', 'void *', 'void *']);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr']);
const wstr = (s) => Buffer.from(s + '\0', 'utf16le');

const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;

// hwnd 接受三种形态（调用方常直接从 CDP 拿十进制字符串）：Number / BigInt / 十进制字符串。
// 返回 false = 调用失败（句柄失效/权限），调用方决定是断言还是告警——不静默吞。
function asHwnd(hwnd) {
  if (typeof hwnd === 'number') return hwnd;
  if (typeof hwnd === 'bigint') return Number(hwnd);
  const n = Number(hwnd);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`窗口句柄无法转成数值：${String(hwnd)}`);
  return n;
}

function placeWindow(hwnd, x, y, size) {
  const cx = size && Number.isFinite(size.width) ? Math.round(size.width) : 0;
  const cy = size && Number.isFinite(size.height) ? Math.round(size.height) : 0;
  const flags = SWP_NOZORDER | SWP_NOACTIVATE | (size ? 0 : SWP_NOSIZE);
  return !!SetWindowPos(asHwnd(hwnd), 0, Math.round(x), Math.round(y), cx, cy, flags);
}

function windowSize(hwnd) {
  const b = Buffer.alloc(16);
  if (!GetWindowRect(asHwnd(hwnd), b)) return null;
  return { width: b.readInt32LE(8) - b.readInt32LE(0), height: b.readInt32LE(12) - b.readInt32LE(4) };
}

// 渲染子窗口（真正接收鼠标消息的那个）。票 14-I：场地卫生的「第三层读数」——
// 外壳窗口 visible=true、EXSTYLE 正常，但只要这个子窗被藏起来，点击就全丢（§101 的坏态）。
// 同句柄 hide→showInactive 重显就稳定产出这个形态（§95），而件里还有不少这种收场方式。
function childByClass(hwnd, className) {
  const h = asHwnd(hwnd);
  const child = Number(FindWindowExW(h, 0, wstr(className), null));
  if (!child) return { hwnd: 0, visible: false, exists: false };
  return { hwnd: child, visible: !!IsWindowVisible(child), exists: true };
}

function isVisible(hwnd) {
  return !!IsWindowVisible(asHwnd(hwnd));
}

module.exports = { placeWindow, windowSize, childByClass, isVisible, SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE };
