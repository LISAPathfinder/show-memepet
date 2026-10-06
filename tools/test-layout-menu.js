// menu-layout.js 单测：覆盖四角/边缘/遮挡推离的边界情形（纯 node，直接跑）
// 布局优先级：①贴桌宠左右侧翼（最高）②锚点右侧→左侧 ③与桌宠重叠垂直推上/下
const { menuLayout } = require('../menu-layout');

// 1920×1080 工作区（无任务栏偏移的简化模型）
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const MENU = { W: 250, H: 480 };
let pass = 0;
let fail = 0;

function inWorkArea(r) {
  return r.x >= WA.x && r.y >= WA.y && r.x + MENU.W <= WA.x + WA.width && r.y + MENU.H <= WA.y + WA.height;
}
function overlaps(r, pet, W, H) {
  W = W || MENU.W; H = H || MENU.H;
  return r.x < pet.x + pet.width && r.x + W > pet.x && r.y < pet.y + pet.height && r.y + H > pet.y;
}
function test(name, anchor, pet, check, wa) {
  const workArea = wa || WA;
  const r = menuLayout({ anchorX: anchor[0], anchorY: anchor[1], W: MENU.W, H: MENU.H, workArea, petBounds: pet });
  const problems = [];
  if (r.x < workArea.x || r.y < workArea.y || r.x + MENU.W > workArea.x + workArea.width || r.y + MENU.H > workArea.y + workArea.height) problems.push('超出工作区');
  if (pet && overlaps(r, pet)) problems.push('与桌宠重叠');
  const ok = problems.length === 0 && (check ? check(r) : true);
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' -> ' + JSON.stringify(r) + (problems.length ? ' [' + problems.join(',') + ']' : '')); }
}

console.log('== 无桌宠（petBounds=null）==');
// 屏幕中央：菜单出现在锚点右侧
test('中央 anchor 正常右侧展开', [960, 500], null, (r) => r.x === 968 && r.y === 500);
// 靠右缘：翻转到左侧
test('右缘翻转到左侧', [1900, 500], null, (r) => Math.abs(r.x - (1900 - 250 - 8)) <= 1);
// 靠下缘：y 上移钳制到工作区底
test('下缘上移钳制', [960, 1000], null, (r) => r.y === WA.height - MENU.H);
// 左上角：位置就是左上
test('左上角原位', [0, 0], null, (r) => r.x === 8 && r.y === 0);
// 副屏负坐标（假设屏在 -1920 起）：锚点 -100 距副屏右缘(0)只剩 92px < 菜单宽 → 翻转左侧
{
  const wa2 = { x: -1920, y: 0, width: 1920, height: 1040 };
  const r = menuLayout({ anchorX: -100, anchorY: 500, W: MENU.W, H: MENU.H, workArea: wa2, petBounds: null });
  const ok = r.x === -358 && r.y === 500;
  if (ok) { pass++; console.log('  PASS 副屏负坐标（右缘放不下翻左侧）'); }
  else { fail++; console.log('  FAIL 副屏负坐标 -> ' + JSON.stringify(r)); }
}

console.log('== 贴桌宠左右侧翼优先（桌宠 260×300）==');
const PET_CENTER = { x: 900, y: 400, width: 260, height: 300 };
// 锚点在桌宠左部：即使锚点右侧本身放得下（旧逻辑会先落锚点右侧），也必须贴桌宠右侧翼
test('锚点在桌宠左部 → 贴右翼（不跟随锚点）', [800, 500], PET_CENTER,
  (r) => r.x === PET_CENTER.x + PET_CENTER.width + 8 && r.y === 500);
// 锚点就在桌宠身上 → 贴右翼
test('中央桌宠贴右翼', [950, 500], PET_CENTER, (r) => r.x === PET_CENTER.x + PET_CENTER.width + 8);
// 桌宠贴右缘（右翼放不下）→ 贴左翼
const PET_RIGHT = { x: 1650, y: 400, width: 260, height: 300 };
test('右缘桌宠贴左翼', [1800, 500], PET_RIGHT, (r) => r.x === PET_RIGHT.x - MENU.W - 8);
// 桌宠贴左缘（左翼放不下、右翼可放）→ 贴右翼
const PET_LEFT = { x: 0, y: 400, width: 260, height: 300 };
test('左缘桌宠贴右翼', [100, 500], PET_LEFT, (r) => r.x === PET_LEFT.x + PET_LEFT.width + 8);
// 竖屏（1080×1900）：桌宠中部，右翼放得下 → 贴右翼（用户竖屏场景）
{
  const waPortrait = { x: 0, y: 0, width: 1080, height: 1900 };
  const pet = { x: 400, y: 800, width: 260, height: 300 };
  const r = menuLayout({ anchorX: 520, anchorY: 900, W: MENU.W, H: MENU.H, workArea: waPortrait, petBounds: pet });
  const ok = r.x === pet.x + pet.width + 8 && r.y === 900;
  if (ok) { pass++; console.log('  PASS 竖屏贴右翼'); }
  else { fail++; console.log('  FAIL 竖屏贴右翼 -> ' + JSON.stringify(r)); }
}
// 桌宠 y 位置极端靠下：贴右翼时 y 从锚点向下钳制，仍不与桌宠重叠（水平分离）
{
  const pet = { x: 900, y: 700, width: 260, height: 300 };
  const r = menuLayout({ anchorX: 1000, anchorY: 1030, W: MENU.W, H: MENU.H, workArea: WA, petBounds: pet });
  const ok = r.x === pet.x + pet.width + 8 && r.y === WA.height - MENU.H && !overlaps(r, pet);
  if (ok) { pass++; console.log('  PASS 贴右翼时底部钳制'); }
  else { fail++; console.log('  FAIL 贴右翼时底部钳制 -> ' + JSON.stringify(r)); }
}

console.log('== 降级：窄屏左右翼都放不下 → 垂直推离 ==');
// 构造窄工作区（500 宽）：右翼 (388+250=638>500) 失败、左翼 (120-258=-138 钳到 0，0<=-137 不成立) 失败
// → 降级锚点右侧 x=208 与桌宠重叠 → 垂直推离。桌宠靠下（600..900）：下方放不下 → 推上方 y=112
{
  const waNarrow = { x: 0, y: 0, width: 500, height: 1040 };
  const pet = { x: 120, y: 600, width: 260, height: 300 };
  const r = menuLayout({ anchorX: 200, anchorY: 700, W: MENU.W, H: MENU.H, workArea: waNarrow, petBounds: pet });
  const ok = !overlaps(r, pet) && r.x >= 0 && r.x + MENU.W <= 500 && r.y === pet.y - MENU.H - 8;
  if (ok) { pass++; console.log('  PASS 窄屏翼放不下 → 垂直推到上方'); }
  else { fail++; console.log('  FAIL 窄屏翼放不下 → 垂直推到上方 -> ' + JSON.stringify(r)); }
}
// 垂直推离选下方：桌宠靠上时下方空间足够
{
  const waNarrow = { x: 0, y: 0, width: 500, height: 1040 };
  const pet = { x: 120, y: 200, width: 260, height: 300 };
  const r = menuLayout({ anchorX: 200, anchorY: 300, W: MENU.W, H: MENU.H, workArea: waNarrow, petBounds: pet });
  const ok = !overlaps(r, pet) && r.y === pet.y + pet.height + 8;
  if (ok) { pass++; console.log('  PASS 窄屏垂直推离优先下方'); }
  else { fail++; console.log('  FAIL 窄屏垂直推离优先下方 -> ' + JSON.stringify(r)); }
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
