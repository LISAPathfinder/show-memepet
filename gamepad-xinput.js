// 手柄轮询：XInput（xinput1_4.dll）覆盖 Xbox 协议手柄及 Steam Input 映射的手柄。
// 不用 renderer 的 Gamepad API——它要求页面持有焦点时手柄才可见，桌宠常驻无焦点收不到。
const koffi = require('koffi');

const BUTTONS = [
  [0x0001, 'Up'],
  [0x0002, 'Down'],
  [0x0004, 'Left'],
  [0x0008, 'Right'],
  [0x0010, 'Start'],
  [0x0020, 'Select'],
  [0x0040, 'LS'],
  [0x0080, 'RS'],
  [0x0100, 'LB'],
  [0x0200, 'RB'],
  [0x1000, 'A'],
  [0x2000, 'B'],
  [0x4000, 'X'],
  [0x8000, 'Y'],
];

const TRIGGER_THRESHOLD = 30;
// 摇杆死区用 XInput 官方值（左 7849 / 右 8689），只在"从死区内推出去"的上升沿算一次拨动
const STICK_DEADZONE = { left: 7849, right: 8689 };

let getXinputState = null;
let startError = null;
let prevButtons = [0, 0, 0, 0];
let prevTriggers = [0, 0, 0, 0];
let prevSticks = [0, 0, 0, 0];

function start() {
  if (getXinputState) return;
  // xinput1_4 是 Win8+ 标配；老系统回退 xinput9_1_0（导出相同）
  try {
    const xinput = koffi.load('xinput1_4.dll');
    const XINPUT_STATE = koffi.struct('XINPUT_STATE', {
      packet: 'uint32',
      wButtons: 'uint16',
      leftTrigger: 'uint8',
      rightTrigger: 'uint8',
      thumbLX: 'int16',
      thumbLY: 'int16',
      thumbRX: 'int16',
      thumbRY: 'int16',
    });
    getXinputState = xinput.func('XInputGetState', 'int32', [
      'uint32',
      koffi.out(koffi.pointer(XINPUT_STATE)),
    ]);
  } catch (err) {
    startError = err.message;
    try {
      const xinput = koffi.load('xinput9_1_0.dll');
      const XINPUT_STATE = koffi.struct('XINPUT_STATE_9', {
        packet: 'uint32',
        wButtons: 'uint16',
        leftTrigger: 'uint8',
        rightTrigger: 'uint8',
        thumbLX: 'int16',
        thumbLY: 'int16',
        thumbRX: 'int16',
        thumbRY: 'int16',
      });
      getXinputState = xinput.func('XInputGetState', 'int32', [
        'uint32',
        koffi.out(koffi.pointer(XINPUT_STATE)),
      ]);
      startError = null;
    } catch (err2) {
      startError = err2.message;
    }
  }
}

let anyConnected = false;

// 'unavailable' 组件加载失败 | 'connected' 有手柄在线 | 'none' 在线但没设备 | 'not-started' 未启动
function getStatus() {
  if (startError) return 'unavailable';
  if (!getXinputState) return 'not-started';
  return anyConnected ? 'connected' : 'none';
}

// 轮询一次 4 个手柄槽位，返回 { pressed: 本次新按下的按键名数组, stickMove: 是否有摇杆新拨动 }
function poll() {
  if (!getXinputState) return { pressed: [], stickMove: false };
  const pressed = [];
  let stickMove = false;
  for (let i = 0; i < 4; i++) {
    const state = {};
    if (getXinputState(i, state) !== 0) {
      prevButtons[i] = 0;
      prevTriggers[i] = 0;
      prevSticks[i] = 0;
      continue;
    }
    anyConnected = true;
    const w = state.wButtons;
    if (w !== prevButtons[i]) {
      for (const [mask, name] of BUTTONS) {
        if (w & mask && !(prevButtons[i] & mask)) pressed.push(name);
      }
      prevButtons[i] = w;
    }
    const triggers =
      (state.leftTrigger > TRIGGER_THRESHOLD ? 1 : 0) |
      (state.rightTrigger > TRIGGER_THRESHOLD ? 2 : 0);
    if (triggers !== prevTriggers[i]) {
      if (triggers & 1 && !(prevTriggers[i] & 1)) pressed.push('LT');
      if (triggers & 2 && !(prevTriggers[i] & 2)) pressed.push('RT');
      prevTriggers[i] = triggers;
    }
    const sticks =
      (Math.abs(state.thumbLX) > STICK_DEADZONE.left ||
      Math.abs(state.thumbLY) > STICK_DEADZONE.left ? 1 : 0) |
      (Math.abs(state.thumbRX) > STICK_DEADZONE.right ||
      Math.abs(state.thumbRY) > STICK_DEADZONE.right ? 2 : 0);
    if (sticks !== prevSticks[i]) {
      if (sticks & 1 && !(prevSticks[i] & 1)) stickMove = true;
      if (sticks & 2 && !(prevSticks[i] & 2)) stickMove = true;
      prevSticks[i] = sticks;
    }
  }
  return { pressed, stickMove };
}

module.exports = { start, poll, getStatus, isConnected: () => anyConnected };
