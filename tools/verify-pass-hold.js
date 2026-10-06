// 穿透判定的纯逻辑回归（1.0.59 票 11-J 任务 2/3/4 重写判定内核后整件同步；#43 纪律）：
// 验证「交互区边界抖动」不会造成穿透状态来回翻，且「真离开」不再吃 600ms 保持。
//
// 判定内核与 main.js syncPetPassThrough 保持一致（改动那边请同步这里）：
//   · 命中判定 pointInBoxes：任一小盒外扩 JITTER_PAD 含指针 → inside（1.0.59 起盒是离散数组）；
//   · 在辖区内 → 立即「可交互」（进入即响应）；
//   · 在辖区外、但指针仍在任一小盒 ∪ FAST_EXIT_PAD 内 → 连续在外满 PASS_HOLD_MS 才「穿透」
//     （贴着元素的离开可能是盒漂动假象，§52 防线）；
//   · 在所有小盒 ∪ FAST_EXIT_PAD 之外 → 快速离开通道：本拍即「穿透」，不吃保持
//     （FAST_EXIT_PAD ≥ 漂浮摆幅 + JITTER_PAD，静止贴盒指针不会被周期性送进来）；
//     原 DISTANT_MOVE_PX=40「大幅移动」通道被本通道覆盖，随 1.0.59 退役；
//   · petKeepInteractive（拖拽/玻璃）→ 始终「可交互」。
//
// 用法：node tools/verify-pass-hold.js
const PASS_HOLD_MS = 600;
const POLL_MS = 120; // 主进程轮询间隔
const JITTER_PAD = 1; // 与 main.js 的 JITTER_PAD 保持一致（票 11-J 任务 3）
const FAST_EXIT_PAD = 8; // 与 main.js 的 FAST_EXIT_PAD 保持一致（票 11-J 任务 4）

function pointInBoxes(rects, x, y, pad) {
  if (!Array.isArray(rects)) rects = rects ? [rects] : [];
  for (const r of rects) {
    if (!r || !(r.width > 0) || !(r.height > 0)) continue;
    if (x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad) return true;
  }
  return false;
}

function createJudge() {
  let petOutsideSince = 0;
  let petIgnoreSent = null;
  let flips = 0;
  let lastIgnore = null;
  const history = [];
  return {
    get flips() {
      return flips;
    },
    get ignore() {
      return lastIgnore;
    },
    history,
    step(rects, cursor, now, keepInteractive = false) {
      const inside = pointInBoxes(rects, cursor.x, cursor.y, JITTER_PAD);
      if (inside) {
        petOutsideSince = 0;
      } else if (!petOutsideSince) {
        petOutsideSince = now;
      }
      let ignore;
      if (keepInteractive) {
        ignore = false;
      } else if (inside) {
        ignore = false;
      } else if (petIgnoreSent === null) {
        // 首轮无延续状态：按实时结果下发（与 main.js 一致）
        ignore = true;
      } else if (!pointInBoxes(rects, cursor.x, cursor.y, FAST_EXIT_PAD)) {
        // 快速离开通道：所有小盒 ∪ FAST_EXIT_PAD 之外 → 真实离开，本拍即穿透（与 main.js 一致）
        ignore = true;
      } else {
        ignore = now - petOutsideSince >= PASS_HOLD_MS ? true : petIgnoreSent === true;
      }
      if (ignore !== petIgnoreSent) {
        // 首次下发（null → 具体值）不算「翻转」：那是窗口初值落定，不是来回翻
        if (petIgnoreSent !== null) flips += 1;
        history.push({ now, from: petIgnoreSent, to: ignore, inside });
        petIgnoreSent = ignore;
        lastIgnore = ignore;
      }
      return ignore;
    },
  };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}
function shortReversals(j) {
  const out = [];
  for (let i = 1; i < j.history.length; i++) {
    const dt = j.history[i].now - j.history[i - 1].now;
    if (dt < PASS_HOLD_MS) out.push(`${dt}ms(${j.history[i - 1].to ? '穿透' : '可交互'}→${j.history[i].to ? '穿透' : '可交互'})`);
  }
  return out;
}

// 现场 3 的真实几何（隔离实例 scale=1 空闲态）+ 漂浮两态（.pet-body translateY 0→-6，
// 脸/zzz 盒随之整体上移 6px；底部行不漂）。盒已含渲染端 BOX_PAD=2。
const FACE_A = { x: 393, y: 452, width: 114, height: 114 }; // ty=0
const FACE_B = { x: 393, y: 446, width: 114, height: 114 }; // ty=-6
const COUNTER = { x: 397, y: 569, width: 93, height: 25 };
const GEAR = { x: 493, y: 566, width: 30, height: 30 };
const LAMP = { x: 377, y: 573, width: 16, height: 16 };
const boxesAt = (i) => [Math.floor((i * POLL_MS) / 1000) % 2 ? FACE_B : FACE_A, COUNTER, GEAR, LAMP]; // 盒每 ~1s 换（渲染端 1s 上报）
const FACE_CENTER = { x: 450, y: 509 };

// 场景 1：光标停在脸中心，脸盒 ±3px 漂动（两态交替），持续 10 秒 → 状态不得翻
console.log('场景 1：光标停在脸中心，脸盒漂动（0/-6px 两态），持续 10 秒');
{
  const j = createJudge();
  const t0 = 1000000;
  const beats = Math.ceil(10000 / POLL_MS);
  for (let i = 0; i < beats; i++) j.step(boxesAt(i), FACE_CENTER, t0 + i * POLL_MS);
  const bad = shortReversals(j);
  check('无短于 600ms 的反转', bad.length === 0, bad.length ? `${bad.length} 次，例: ${bad.slice(0, 3).join(' ')}` : '');
  check('全程保持可交互（无任何切换）', j.flips === 0, `切换 ${j.flips} 次`);
}

// 场景 2：光标从脸移到紧邻「图标位」（距所有小盒 > FAST_EXIT_PAD）→ 下一拍即穿透
// （票 11-J 现场 2 的主体形态：离开→转穿透不吃 600ms 保持）
console.log('场景 2：移到紧邻图标位（FAST_EXIT_PAD 外）→ 1 拍内穿透');
{
  const j = createJudge();
  const t0 = 2000000;
  for (let i = 0; i < 8; i++) j.step(boxesAt(i), FACE_CENTER, t0 + i * POLL_MS);
  j.step(boxesAt(8), { x: 360, y: 520 }, t0 + 8 * POLL_MS); // 距脸盒左缘 33px、距 lamp 40px+
  check('大幅/中幅离开后 1 拍内即穿透', j.ignore === true, `ignore=${j.ignore}`);
}

// 场景 3：光标微移出界、但仍在 FAST_EXIT_PAD 环内（距脸盒右缘 4px）→ 保持期满才穿透
console.log('场景 3：微移出界（FAST_EXIT_PAD 环内）→ 保持 600ms 才穿透');
{
  const j = createJudge();
  const box = [FACE_A, COUNTER, GEAR, LAMP];
  const t0 = 3000000;
  j.step(box, FACE_CENTER, t0);
  j.step(box, { x: 511, y: 509 }, t0 + POLL_MS); // 距脸盒右缘 507 约 4px，位移 61px 但仍在环内
  check('约 500ms 时仍可交互', j.ignore === false, `ignore=${j.ignore}`);
  j.step(box, { x: 511, y: 509 }, t0 + 800);
  check('满 600ms 后变穿透', j.ignore === true, `ignore=${j.ignore}`);
}

// 场景 4：微移出界不足 600ms 又回到区内 → 不得变穿透
console.log('场景 4：微移出界 300ms 又回到区内');
{
  const j = createJudge();
  const box = [FACE_A, COUNTER, GEAR, LAMP];
  const t0 = 4000000;
  j.step(box, FACE_CENTER, t0);
  j.step(box, { x: 511, y: 509 }, t0 + POLL_MS);
  j.step(box, { x: 511, y: 509 }, t0 + 300);
  j.step(box, FACE_CENTER, t0 + 400);
  check('全程未变穿透', j.flips === 0, `切换 ${j.flips} 次`);
  check('回到区内为可交互', j.ignore === false, `ignore=${j.ignore}`);
}

// 场景 5：首轮判定 —— 光标已在区内必须立刻可交互（关键路径）
console.log('场景 5：首轮判定、光标已在区内 → 立刻可交互');
{
  const j = createJudge();
  j.step([FACE_A, COUNTER, GEAR, LAMP], FACE_CENTER, 5000000);
  check('首轮即下发可交互', j.ignore === false, `ignore=${j.ignore}`);
}
console.log('场景 6：首轮判定、光标在区外（FAST_EXIT_PAD 外）→ 直接穿透');
{
  const j = createJudge();
  j.step([FACE_A, COUNTER, GEAR, LAMP], { x: 300, y: 400 }, 6000000);
  check('首轮即下发穿透', j.ignore === true, `ignore=${j.ignore}`);
}

// 场景 7：拖拽/玻璃期间点名保持可交互 —— 光标在窗外也必须可交互；释放后 1 拍内回穿透
console.log('场景 7：keepInteractive 期间光标在窗外，释放后快速回穿透');
{
  const j = createJudge();
  const box = [FACE_A, COUNTER, GEAR, LAMP];
  const t0 = 7000000;
  j.step(box, FACE_CENTER, t0);
  j.step(box, { x: 900, y: 900 }, t0 + POLL_MS, true);
  j.step(box, { x: 900, y: 900 }, t0 + 5000, true);
  check('拖拽期间始终可交互', j.ignore === false, `ignore=${j.ignore}`);
  j.step(box, { x: 900, y: 900 }, t0 + 5120, false);
  check('释放后 1 拍内回穿透（快速通道）', j.ignore === true, `ignore=${j.ignore}`);
}

// 场景 8：长时间真实停留后离开 —— 快速通道放行（余量不能把真实离开挡在保持期里）
console.log('场景 8：在区内停留后真实离开');
{
  const j = createJudge();
  const box = [FACE_A, COUNTER, GEAR, LAMP];
  const t0 = 8000000;
  for (let i = 0; i < 30; i++) j.step(box, FACE_CENTER, t0 + i * POLL_MS);
  const tLeave = t0 + 30 * POLL_MS;
  j.step(box, { x: 900, y: 900 }, tLeave + POLL_MS);
  check('离开后 1 拍内变穿透', j.ignore === true, `ignore=${j.ignore}`);
}

// 场景 9（§52 防线新形态）：静止指针距脸盒 5px（FAST_EXIT_PAD 环内、JITTER_PAD 外），
// 盒漂两态反复把距离推到 5~11px——inside 恒假，600ms 保持后**稳定穿透、不再翻回**
// （旧 16px 环下同位置是「反复进出、petOutsideSince 一直被清零」的长尾来源，票 11-J 现场 2）
console.log('场景 9：指针先在脸上，移到 FAST_EXIT_PAD 环内（距盒 5px）停住 + 盒漂动 → 稳定穿透，无振荡');
{
  const j = createJudge();
  const t0 = 9000000;
  for (let i = 0; i < 8; i++) j.step(boxesAt(i), FACE_CENTER, t0 + i * POLL_MS); // 先在区内
  const beats = Math.ceil(10000 / POLL_MS);
  for (let i = 0; i < beats; i++) j.step(boxesAt(i), { x: 512, y: 509 }, t0 + 8 * POLL_MS + i * POLL_MS); // 停在距脸盒右缘 5px 处
  check('进入环内后 600ms 保持翻穿透', j.history.some((h) => h.from !== null && h.from === false && h.to === true), '有「可交互→穿透」翻转');
  const last = j.history[j.history.length - 1];
  check('终态为穿透（不因盒漂回而振荡回可交互）', last && last.to === true, `末次=${JSON.stringify(last)}`);
  check('全程仅 1 次翻转（进入穿透那一次）', j.flips === 1, `切换 ${j.flips} 次`);
  const bad = shortReversals(j);
  check('无短于 600ms 的反转', bad.length === 0, bad.length ? `${bad.length} 次` : '');
}

// 场景 10：拖放桌宠后点击被盖住的文件（2026-10-02 用户实测场景，快速通道承载）
console.log('场景 10：拖放后大幅移动到被盖文件 → 1 拍内穿透');
{
  const j = createJudge();
  const box = [FACE_A, COUNTER, GEAR, LAMP];
  const t0 = 10000000;
  j.step(box, FACE_CENTER, t0); // 拖着桌宠（光标在形象上）
  j.step(box, { x: 452, y: 511 }, t0 + POLL_MS, true); // 拖拽中（keepInteractive）
  j.step(box, { x: 452, y: 511 }, t0 + 2 * POLL_MS); // 松手：光标仍在区内 → 可交互
  j.step(box, { x: 200, y: 300 }, t0 + 3 * POLL_MS); // 移到被盖文件（透明区）
  check('拖放后大幅移动 → 1 拍内穿透', j.ignore === true, `ignore=${j.ignore}`);
}

console.log('');
if (failed) {
  console.error(`✗ ${failed} 项未通过`);
  process.exit(1);
}
console.log('✓ 全部通过：抖动不再翻转穿透状态，FAST_EXIT_PAD 外真离开 1 拍穿透，环内微移出界仍守保持时间');
