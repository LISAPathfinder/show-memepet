// @runtime: none —— 共享库（DIP→物理坐标换算 + 光标注入），被 shared 判据件 require，不独立执行
// 票 14-G：判据件的坐标口径全是 DIP（窗口 getBounds / 渲染端 getBoundingClientRect /
// 主进程 screen.getCursorScreenPoint 都是 DIP），而 SetCursorPos 吃**物理像素**。两者只在
// 100% 缩放下相等；本机 scaleFactor 1.13 时，件算出的脸中心喂进去后落点偏 13%，
// 于是「应可交互」类断言全体假红（现象与定性见 PITFALLS §102）。
//
// 本库只做换算与回读，**不做断言**：断言仍留在各件，退出码语义不变。
//
// 为什么从主进程读 scaleFactor，而不是 GetDpiForSystem/GetDpiForMonitor：
// 后者在普通 node 进程里会回落 96（DPI awareness 并不生效，PITFALLS §102 实测被骗过一次），
// 拿它算等于没换。screen.getPrimaryDisplay().scaleFactor 正是产品判定命中区时用的同一个值。
//
// 用法（shared 件，main 是已连上的 9229 CDP 通道）：
//   const { readDipScale, moveCursorDip } = require('./lib-cursor');
//   const SCALE = await readDipScale(main);
//   const r = moveCursorDip(face.x, face.y, SCALE);   // 入参是 DIP
//
// 边界：installed 类件读的是 GetWindowRect（物理）与真实窗口，本来就在物理坐标里，**不要**套本库。

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const GetCursorPos = user32.func('GetCursorPos', 'bool', ['void *']);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);

/** 从主进程读 DIP 缩放比（CDP：9229 主进程通道）。读不到就抛，不静默退回 1.0。
 *  ⚠ 各件的 CDP 通道形态有两种：`connect()` 返回 `{ evaluate }` 对象，或直接返回可调用函数
 *  （verify-flee-interaction / verify-hide-show-input / verify-passthrough-desync 就是后者）。
 *  两种都得支持，否则会炸成「main.evaluate is not a function」——那类"脚本异常"在装置里
 *  与断言失败同形（rc=1），很容易被误读成产品红。 */
async function readDipScale(main) {
  const expr = `JSON.stringify(process.mainModule.require('electron').screen.getPrimaryDisplay().scaleFactor)`;
  const raw = typeof main === 'function' ? await main(expr) : await main.evaluate(expr);
  const s = Number(JSON.parse(raw));
  if (!(s > 0)) throw new Error(`读不到有效的 scaleFactor：${raw}`);
  return s;
}

/** 兜底算法：窗口物理宽 ÷ DIP 宽（没有主进程通道时可用；两者应互为印证）。 */
function dipScaleFromWindow(hwnd, dipBounds) {
  if (!hwnd || !dipBounds || !dipBounds.width) throw new Error('dipScaleFromWindow 需要 hwnd 与 DIP bounds');
  const buf = Buffer.alloc(16);
  if (!GetWindowRect(hwnd, buf)) throw new Error('GetWindowRect 失败');
  const physW = buf.readInt32LE(8) - buf.readInt32LE(0);
  const s = physW / dipBounds.width;
  if (!(s > 0)) throw new Error(`物理宽 ${physW} / DIP 宽 ${dipBounds.width} 不是有效缩放比`);
  return s;
}

const dipToPhysical = (v, scale) => Math.round(v * scale);

function cursorPhysical() {
  const b = Buffer.alloc(8);
  GetCursorPos(b);
  return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
}

/**
 * 把真实光标移到 DIP 坐标（入参 DIP）。回读到的物理值直接与物理目标比，容差按 DIP 折算。
 * 返回 { ok, physical, actual }：physical 是实际下发的物理坐标，actual 是回读结果，
 * 由调用方决定把哪个放进断言读数（保持各件现有文案与判据口径）。
 */
function moveCursorDip(x, y, scale, toleranceDip = 5) {
  const px = dipToPhysical(x, scale);
  const py = dipToPhysical(y, scale);
  const tol = Math.max(1, Math.round(toleranceDip * scale));
  let actual = cursorPhysical();
  for (let i = 0; i < 2; i++) {
    SetCursorPos(px, py);
    actual = cursorPhysical();
    if (Math.abs(actual.x - px) <= tol && Math.abs(actual.y - py) <= tol) {
      return { ok: true, physical: { x: px, y: py }, actual };
    }
  }
  return { ok: false, physical: { x: px, y: py }, actual };
}

/**
 * 把一个「吃 DIP 的 SetCursorPos」交回给件用：件里的调用点全都不动，只把常量定义行换成
 *   const SetCursorPos = dipSetter(() => SCALE);
 * 即可让这批调用自动换算。getScale 用函数而不是数值，是为了让 SCALE 可以在 main 通道
 * 连上之后再定义（调用发生在之后，不存在时也不会读到 undefined 而不报错——见下方断言）。
 *
 * ⚠ 只对「入参是 DIP」的件成立。件里若有真·物理坐标来源（例如 getCursor() 的回读值要还原），
 * 那几处必须用原始 SetCursorPos，不能走这个包装（verify-flee 的「还原光标」就是这种）。
 */
function dipSetter(getScale) {
  return (x, y) => {
    const s = getScale();
    if (!(s > 0)) throw new Error(`dipSetter: scale 未就绪（${s}）——SCALE 必须在调用前用 readDipScale 取到`);
    return SetCursorPos(Math.round(x * s), Math.round(y * s));
  };
}

module.exports = { readDipScale, dipScaleFromWindow, dipToPhysical, cursorPhysical, moveCursorDip, dipSetter };
