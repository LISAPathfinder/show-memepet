// 对任意 hwnd 打印扩展样式与分层属性读数（GLWA），用于 petCovered 按 alpha 判定（票 5）的取证。
// 用法：node tools/probe-layered-attr.js <hwnd> [hwnd2 ...]   （0x40848 或十进制均可）
// 输出：每窗一段——IsWindow / 类名 / EXSTYLE（标注 LAYERED、TRANSPARENT 位）/ GLWA 读数
//       （ret、crKey、bAlpha、flags，标注 LWA_COLORKEY、LWA_ALPHA；ret=false 时出参保持
//       哨兵原样 = 「零写入」）。ret/key/alpha/flags 的组合含义见 main.js 的
//       layeredVisuallyTransparent 注释（判据来源 PITFALLS §61 子坑 4 的 ★3/★4）。
// 退出码：0 = 全部窗口读数完成；1 = 含无效 hwnd（读数失败）；2 = 未传参数——
//       作为回归件被别的脚本调用时「忘传参数」必须不算成功，且与读数失败区分开。
// 纯 node + koffi，不引入 Electron 依赖（铁律 5）。
// 声明口径照 findings 第六节实测件：声明式原型必须整串传（把返回类型当第二个实参会报
// Unexpected character '(' in type specifier）；out 参 Buffer 预填哨兵，才能区分
// 「ret=true 写了 0」与「ret=false 什么都没写」。
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const IsWindow = user32.func('IsWindow', 'bool', ['uintptr']);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr', 'void *', 'int']);
const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr', 'void *']);
// 照抄 findings 第六节（勿改参数形式）
const GLWA = user32.func('bool __stdcall GetLayeredWindowAttributes(uintptr hwnd, uint32 *pKey, uint8 *pAlpha, uint32 *pFlags)');

const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TRANSPARENT = 0x00000020;
const LWA_COLORKEY = 0x00000001;
const LWA_ALPHA = 0x00000002;
const SENTINEL_KEY = 0xcdabcd00;
const SENTINEL_ALPHA = 0xcd;
const SENTINEL_FLAGS = 0xffffffff;

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: node tools/probe-layered-attr.js <hwnd> [hwnd2 ...]   （如 0x40848，十进制亦可）');
  process.exit(2);
}

let bad = false;
for (const raw of args) {
  let h;
  try {
    h = Number(BigInt(raw));
  } catch {
    console.error(`✗ "${raw}" 不是合法的 hwnd 数值`);
    bad = true;
    continue;
  }
  if (!IsWindow(h)) {
    console.error(`✗ HWND 0x${h.toString(16)} 无效（IsWindow=false）`);
    bad = true;
    continue;
  }
  const clsBuf = Buffer.alloc(512);
  const clsN = GetClassNameW(h, clsBuf, 256);
  const cls = clsN > 0 ? clsBuf.toString('utf16le', 0, clsN * 2) : '(取不到)';
  const ex = Number(BigInt(GetWindowLongPtrW(h, GWL_EXSTYLE)) & 0xffffffffn);
  const rect = Buffer.alloc(16);
  GetWindowRect(h, rect);
  const r = { l: rect.readInt32LE(0), t: rect.readInt32LE(4), r: rect.readInt32LE(8), b: rect.readInt32LE(12) };

  // out 参预填哨兵
  const k = Buffer.alloc(4), a = Buffer.alloc(1), f = Buffer.alloc(4);
  k.writeUInt32LE(SENTINEL_KEY); a[0] = SENTINEL_ALPHA; f.writeUInt32LE(SENTINEL_FLAGS);
  const ret = GLWA(h, k, a, f);

  console.log(`HWND 0x${h.toString(16)}  类名=${cls}  矩形=(${r.l},${r.t})-(${r.r},${r.b})`);
  console.log(`  EXSTYLE = 0x${ex.toString(16).padStart(8, '0')}  (LAYERED: ${ex & WS_EX_LAYERED ? '有' : '无'} | TRANSPARENT: ${ex & WS_EX_TRANSPARENT ? '有' : '无'})`);
  if (!ret) {
    console.log(`  GLWA    = ret=false → 出参零写入（哨兵原样：key=0x${k.readUInt32LE(0).toString(16)} alpha=0x${a[0].toString(16)} flags=0x${f.readUInt32LE(0).toString(16)}）`);
    console.log(`            含义：未用 SetLayeredWindowAttributes 设过属性——per-pixel/DComp 分层窗（真 Electron 窗、BongoCat）或非分层窗`);
  } else {
    const key = k.readUInt32LE(0), alpha = a[0], flags = f.readUInt32LE(0);
    const fl = [];
    if (flags & LWA_COLORKEY) fl.push('LWA_COLORKEY');
    if (flags & LWA_ALPHA) fl.push('LWA_ALPHA');
    if (!fl.length) fl.push('(无属性位)');
    console.log(`  GLWA    = ret=true  crKey=0x${key.toString(16)}  bAlpha=${alpha}  flags=0x${flags.toString(16)} (${fl.join('|')})`);
  }
  console.log('');
}
process.exit(bad ? 1 : 0);
