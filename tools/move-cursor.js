// 一次性把光标移到指定坐标（用于配合 probe-window-style 读「光标在桌宠身上」时的真实样式）
// 用法：node tools/move-cursor.js <x> <y>
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const x = Number(process.argv[2]);
const y = Number(process.argv[3]);
if (!Number.isFinite(x) || !Number.isFinite(y)) {
  console.error('用法: node tools/move-cursor.js <x> <y>');
  process.exit(2);
}
console.log('SetCursorPos', x, y, '->', SetCursorPos(x, y));
