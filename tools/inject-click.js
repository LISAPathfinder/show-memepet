// 用 SendInput 注入一次真实鼠标点击（比 mouse_event 更现代，行为更接近真手）。
// 用法：node tools/inject-click.js <x> <y> [按住毫秒]
// 为什么要按住毫秒：down/up 相隔微秒时，某些窗口只会把 up 送到页面（mousedown 丢失），
// 量「点不动」类问题必须给足按下时长，否则测出来的是注入伪影。
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});
const INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT });
const SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const keybd_event = user32.func('void __stdcall keybd_event(uint8, uint8, uint32, uintptr)');
const VK_CONTROL = 0x11;
const KEYEVENTF_KEYUP = 2;

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_MOVE = 0x0001;

// --ctrl-triple 分支必须先判：下面 x/y 的 Number() 对 '--ctrl-triple' 是 NaN，
// 守卫会先 usage 退出，文档写法的 --ctrl-triple 永远到不了分支（票 11-R 任务 4 实测踩出）
const isCtrlTriple = process.argv[2] === '--ctrl-triple';
const x = Number(process.argv[2]);
const y = Number(process.argv[3]);
const holdMs = Number(process.argv[4]) || 60;
if (!isCtrlTriple && (!Number.isFinite(x) || !Number.isFinite(y))) {
  console.error('用法: node tools/inject-click.js <x> <y> [按住毫秒]');
  process.exit(2);
}

const send = (flags) => {
  const input = { type: 0, mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } };
  const n = SendInput(1, [input], koffi.sizeof(INPUT));
  if (!n) console.error(`SendInput(0x${flags.toString(16)}) 返回 0（被拦或被拒）`);
  return n;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --ctrl-triple：按住 Ctrl 连点三下（走的是真实全局钩子路径 → 触发「走过去」），
// 用于在没有真人操作时驱动移动功能做验证。
async function ctrlTriple(x, y, gapMs = 150) {
  keybd_event(VK_CONTROL, 0, 0, 0);
  await sleep(60);
  for (let i = 0; i < 3; i++) {
    SetCursorPos(x, y);
    send(MOUSEEVENTF_MOVE);
    send(MOUSEEVENTF_LEFTDOWN);
    await sleep(50);
    send(MOUSEEVENTF_LEFTUP);
    if (i < 2) await sleep(gapMs);
  }
  await sleep(60);
  keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  console.log(`已在 ${x},${y} 注入 Ctrl+三击`);
}

if (process.argv[2] === '--ctrl-triple') {
  const cx = Number(process.argv[3]);
  const cy = Number(process.argv[4]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    console.error('用法: node tools/inject-click.js --ctrl-triple <x> <y>');
    process.exit(2);
  }
  ctrlTriple(cx, cy).then(() => process.exit(0));
} else {
  SetCursorPos(x, y);
  send(MOUSEEVENTF_MOVE); // 先让窗口收到一次 move（穿透判定要靠它）
  send(MOUSEEVENTF_LEFTDOWN);
  const end = Date.now() + holdMs;
  while (Date.now() < end) {
    /* 忙等保持按下 */
  }
  send(MOUSEEVENTF_LEFTUP);
  console.log(`已在 ${x},${y} 注入 SendInput 点击（按住 ${holdMs}ms）`);
}
