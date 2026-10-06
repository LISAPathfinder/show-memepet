// 「走过去」纯逻辑的自测（纯 node，不需要 electron / 不需要真实点击）：
//   node tools/verify-walk.js
// 覆盖三击判定（慢三击 / 三次分散 / 冷却 / OS 连击计数路径）、路径规划（速度/时长钳制）、
// 按进度取点、朝向判定，以及落点居中 + 三面钳制（左上、右下、副屏负坐标）。
const walk = require('../walk');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

const PET = { width: 260, height: 300 };
const WA = { x: 0, y: 0, width: 1920, height: 1040 };

// ---- 三击判定：自攒路径（clicks 传 0 = OS 未填充 / 不可用）----
console.log('三击判定 · 自攒路径');
{
  const d = walk.createTripleClickDetector();
  check('第 1、2 击不触发', [d.push({ x: 500, y: 500, clicks: 0 }, 1000), d.push({ x: 500, y: 500, clicks: 0 }, 1200)], [false, false]);
  check('第 3 击（间隔 200ms、同点）触发', d.push({ x: 500, y: 500, clicks: 0 }, 1400), true);
  check('同一次手势不会重复触发（冷却内）', d.push({ x: 500, y: 500, clicks: 0 }, 1450), false);
}
{
  const d = walk.createTripleClickDetector();
  d.push({ x: 300, y: 300, clicks: 0 }, 1000);
  d.push({ x: 300, y: 300, clicks: 0 }, 1800); // 间隔 800ms > 500ms，串断了
  check('慢三击不触发（间隔超限，重新起串）', d.push({ x: 300, y: 300, clicks: 0 }, 2100), false);
}
{
  const d = walk.createTripleClickDetector();
  d.push({ x: 300, y: 300, clicks: 0 }, 1000);
  d.push({ x: 360, y: 300, clicks: 0 }, 1200); // 位移 60px > 8px，串断了
  check('三次分散在不同位置不触发', d.push({ x: 300, y: 300, clicks: 0 }, 1400), false);
}
{
  const d = walk.createTripleClickDetector();
  const r = [
    // 第一串：1000 / 1200 / 1400 → 第三击触发
    d.push({ x: 700, y: 700, clicks: 0 }, 1000),
    d.push({ x: 700, y: 700, clicks: 0 }, 1200),
    d.push({ x: 700, y: 700, clicks: 0 }, 1400),
    // 第二串：距上次触发仅 300ms，整串被冷却丢弃
    d.push({ x: 700, y: 700, clicks: 0 }, 1500),
    d.push({ x: 700, y: 700, clicks: 0 }, 1600),
    d.push({ x: 700, y: 700, clicks: 0 }, 1700),
    // 第三串：距上次触发 1.2s，冷却已过 → 恢复触发
    d.push({ x: 700, y: 700, clicks: 0 }, 2400),
    d.push({ x: 700, y: 700, clicks: 0 }, 2500),
    d.push({ x: 700, y: 700, clicks: 0 }, 2600),
  ];
  check('冷却期内的整串被丢弃、冷却过后恢复', r, [false, false, true, false, false, false, false, false, true]);
  check('最后一次是成功触发 → lastSuppressed=false', d.lastSuppressed, false);
}
{
  const d = walk.createTripleClickDetector();
  d.push({ x: 700, y: 700, clicks: 0 }, 1000);
  d.push({ x: 700, y: 700, clicks: 0 }, 1200);
  d.push({ x: 700, y: 700, clicks: 0 }, 1400); // 触发
  d.push({ x: 700, y: 700, clicks: 0 }, 1450);
  d.push({ x: 700, y: 700, clicks: 0 }, 1550);
  d.push({ x: 700, y: 700, clicks: 0 }, 1650); // 距触发 250ms → 冷却
  check('冷却丢弃时 lastSuppressed=true 且带间隔毫秒', [d.lastSuppressed, d.lastGapMs], [true, 250]);
}
{
  const d = walk.createTripleClickDetector();
  d.push({ x: 400, y: 400, clicks: 0 }, 1000);
  d.push({ x: 400, y: 400, clicks: 0 }, 1200);
  d.reset(); // 不带修饰键的点击会把串断掉
  check('reset 后不接着累加', d.push({ x: 400, y: 400, clicks: 0 }, 1300), false);
}

// ---- 三击判定：OS 连击计数路径 ----
console.log('三击判定 · OS 连击计数路径');
{
  const d = walk.createTripleClickDetector();
  const r = [1, 2, 3].map((c, i) => d.push({ x: 800, y: 800, clicks: c }, 2000 + i * 700));
  check('clicks=1/2/3 时只有第三击触发（间隔放宽到 700ms 也认）', r, [false, false, true]);
  check('触发来源标记为 os', d.lastPath, 'os');
}
{
  const d = walk.createTripleClickDetector();
  const r = [1, 2, 3].map((c, i) => d.push({ x: 800, y: 800, clicks: c }, 5000 + i * 100));
  check('两条路同时满足也只触发一次', r, [false, false, true]);
  check('来源优先记 os', d.lastPath, 'os');
}
{
  const d = walk.createTripleClickDetector();
  // 真机回归（2026-09-22 实测）：用户连试三次 Ctrl+三击，间隔约 1.3s，
  // 初版 1500ms 冷却把中间那次吃掉了 → 收到 400ms 后这个节奏必须通过
  d.push({ x: 900, y: 900, clicks: 1 }, 1000);
  d.push({ x: 900, y: 900, clicks: 2 }, 1150);
  const first = d.push({ x: 900, y: 900, clicks: 3 }, 1300);
  const second = [
    d.push({ x: 900, y: 900, clicks: 1 }, 1900),
    d.push({ x: 900, y: 900, clicks: 2 }, 2050),
    d.push({ x: 900, y: 900, clicks: 3 }, 2200), // 距上次触发 900ms → 冷却已过，应触发
  ];
  check('真机节奏：连续两次 Ctrl+三击都触发', [first, ...second], [true, false, false, true]);
  // 同一次连击（计数累加到 6）只应触发一次：clicks===3 触发后，第 4~6 下既不重复触发、
  // 也不该被自攒路径补一次（OS 计数可用时自攒整条停用）
  const d3 = walk.createTripleClickDetector();
  const burst = [1, 2, 3, 4, 5, 6].map((c, i) => d3.push({ x: 900, y: 900, clicks: c }, 5000 + i * 150));
  check('连点六下只触发一次（自攒不并行）', burst, [false, false, true, false, false, false]);
  check('后续几下不算被冷却丢弃', d3.lastSuppressed, false);
}

// ---- 路径规划：时长随距离，上下限钳制 ----
console.log('路径规划（速度恒定 + 时长钳制）');
const planNear = walk.planWalk({ x: 0, y: 0 }, { x: 460, y: 0 });
check('460px → 2s（速度 230px/s）', [planNear.distance, planNear.durationMs], [460, 2000]);
check('帧数 = 时长 / 8ms', planNear.frames, Math.round(2000 / 8));
check('近距离钳到下限 500ms', walk.planWalk({ x: 0, y: 0 }, { x: 50, y: 0 }).durationMs, 500);
check('横穿屏幕钳到上限 6000ms', walk.planWalk({ x: 0, y: 0 }, { x: 3000, y: 0 }).durationMs, 6000);
check('斜向距离按勾股算', walk.planWalk({ x: 0, y: 0 }, { x: 300, y: 400 }).distance, 500);

// ---- 按进度取点 ----
console.log('按进度取点');
const A = { x: 100, y: 200 };
const B = { x: 500, y: 100 };
check('t=0 在起点', walk.stepPosition(A, B, 0), { x: 100, y: 200 });
check('t=1 在终点', walk.stepPosition(A, B, 1), { x: 500, y: 100 });
check('t=0.5 在中点', walk.stepPosition(A, B, 0.5), { x: 300, y: 150 });
check('t 超范围被钳住（末帧必落终点）', walk.stepPosition(A, B, 1.5), { x: 500, y: 100 });

// ---- 朝向 ----
console.log('朝向判定');
check('向左走 → -1', walk.walkDirection({ x: 500, y: 0 }, { x: 100, y: 0 }), -1);
check('向右走 → 1', walk.walkDirection({ x: 100, y: 0 }, { x: 500, y: 0 }), 1);
check('只横向挪 3px 仍算向右（不翻转）', walk.walkDirection({ x: 500, y: 0 }, { x: 497, y: 0 }), 1);
check('原地不动 → 1', walk.walkDirection({ x: 500, y: 0 }, { x: 500, y: 0 }), 1);

// ---- 鼠标赖着不走时的让开方向（向下与左右可叠加，向下优先）----
console.log('让开方向（向下优先，可与左右同时进行）');
{
  const b = { x: 800, y: 400, width: 260, height: 300 }; // 屏幕中间，下方空间充足
  const r = walk.planFlee(b, { x: 930, y: 550 }, WA, PET);
  check('下方空间够 → 只向下，顶边落到光标下方', [r.label, r.x, r.y], ['下', 800, 562]);
  check('向下后光标不在宠物上', walk.cursorOverPet({ ...b, y: r.y }, { x: 930, y: 550 }, { x: 0, y: 0, width: 260, height: 300 }), false);
}
{
  // 下方只剩 40px、补不齐「离开光标」所需的 162px → 向下挪到极限 + 左右补（斜着让）
  const b = { x: 800, y: 700, width: 260, height: 300 };
  const r = walk.planFlee(b, { x: 930, y: 850 }, WA, PET);
  check('向下不够 → 下移到极限后由左右补（下+左）', [r.label, r.x, r.y], ['下+左', 658, 740]);
  check('叠加让开后光标不在宠物上', walk.cursorOverPet({ x: r.x, y: r.y, width: 260, height: 300 }, { x: 930, y: 850 }, { x: 0, y: 0, width: 260, height: 300 }), false);
  check('两个轴都动了', r.axes, ['down', 'left']);
}
{
  const bottom = { x: 800, y: 740, width: 260, height: 300 }; // 贴着工作区下沿（默认位置就是这样）
  const r = walk.planFlee(bottom, { x: 930, y: 900 }, WA, PET);
  check('下方完全没有余量 → 纯左右让开，y 不变', [r.y, ['左', '右'].includes(r.label)], [740, true]);
  check('左右让开后光标不在宠物上', walk.cursorOverPet({ ...bottom, x: r.x }, { x: 930, y: 900 }, { x: 0, y: 0, width: 260, height: 300 }), false);
}
{
  const left = { x: 0, y: 740, width: 260, height: 300 }; // 贴左沿 + 下沿：只能向右
  const r = walk.planFlee(left, { x: 100, y: 900 }, WA, PET);
  check('左右夹住时选唯一可行的方向', [r.label, r.x], ['右', 112]);
}
{
  const right = { x: 1660, y: 740, width: 260, height: 300 }; // 贴右沿 + 下沿：只能向左
  const r = walk.planFlee(right, { x: 1780, y: 900 }, WA, PET);
  // 左移目标 = 光标x - 边距 - 宠物宽 = 1780 - 12 - 260
  check('右侧贴边时向左让开', [r.label, r.x], ['左', 1508]);
}
{
  const tiny = { x: 0, y: 0, width: 300, height: 300 }; // 工作区比宠物大不了多少
  check('左右都放不下且向下补不齐 → null（保持原位）', walk.planFlee({ x: 10, y: 10, width: 260, height: 300 }, { x: 100, y: 100 }, tiny, PET), null);
}
{
  const b = { x: 800, y: 400, width: 260, height: 300 };
  const box = { x: 40, y: 140, width: 200, height: 155 }; // 屏幕上 = x 840~1040 / y 540~695
  check('光标在形象区内', walk.cursorOverPet(b, { x: 900, y: 600 }, box), true);
  check('光标在窗口内但不在形象区（透明区）不算', walk.cursorOverPet(b, { x: 805, y: 405 }, box), false);
}

// ---- 落点计算 ----
console.log('落点计算（居中 + 钳制）');
check('屏幕中央：点击点对准窗口中心', walk.computeWalkTarget({ x: 960, y: 520 }, WA, PET), { x: 830, y: 370 });
check('左上角外：钳进工作区', walk.computeWalkTarget({ x: 5, y: 5 }, WA, PET), { x: 0, y: 0 });
check('右下角外：整体不越界', walk.computeWalkTarget({ x: 1918, y: 1035 }, WA, PET), { x: 1660, y: 740 });
const WA2 = { x: -1920, y: 0, width: 1920, height: 1040 }; // 左侧副屏（负坐标）
check('副屏（负坐标工作区）落点正确', walk.computeWalkTarget({ x: -1800, y: 100 }, WA2, PET), { x: -1920, y: 0 });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
