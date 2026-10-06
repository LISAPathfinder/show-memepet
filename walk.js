// 桌宠「走过去」的纯逻辑（不依赖 electron，便于 tools/verify-walk.js 用纯 node 直接测）：
//   ① 三击判定：优先吃 OS 连击计数（libuiohook 的 clicks，最准、天然贴合系统的双击速度设置），
//      拿不到就自攒「间隔 ≤500ms 且位移 ≤8px 的连续三次」——两条路共用冷却，保证一次手势只触发一次。
//   ② 落点与路径：点击点对准宠物中心并钳进工作区；再按距离算出移动时长（速度恒定 = 走路感），
//      由主进程按帧沿直线推进窗口位置。

const DEFAULTS = {
  intervalMs: 500, // 自攒路径的相邻两击最大间隔
  distancePx: 8, // 自攒路径的相邻两击最大位移（手抖容忍）
  // 触发后的冷却：只用来挡「同一手势重复触发」。OS 连击计数要归零得停 ~500ms，
  // 所以 800ms 会连用户正常节奏的下一次三击一起挡掉（真机复现过）→ 400ms 够用。
  cooldownMs: 400,
};

// 走路参数：速度恒定 → 时长随距离变；钳上下限避免「两步路走一眨眼」和「横穿屏幕走半天」
// 注意 frameMs：主进程定时器在 Windows 上被量化到约 15.6ms（实测见 tools/measure-walk-perf.js），
// 请求 33ms 实际只跑到约 24Hz（每步跨 20px，肉眼就是阶梯感）→ 改成 8ms，实测约 63Hz、每步 3.5px。
const WALK = {
  speedPxPerSec: 230, // 第一版 420 被用户反馈「有点快」，按约 55% 收回
  minMs: 500,
  maxMs: 6000,
  frameMs: 8, // 主进程推进窗口位置的帧间隔（实测约 63Hz）
};

function createTripleClickDetector(options) {
  const opt = { ...DEFAULTS, ...(options || {}) };
  let count = 0;
  let lastAt = 0;
  let lastX = 0;
  let lastY = 0;
  // 初值取负无穷：firedAt=0 会让「还没触发过」的第一次三击被冷却判断误挡（自测抓到的）
  let firedAt = Number.NEGATIVE_INFINITY;
  let lastPath = '';
  let suppressed = false; // 本次手势是否被冷却丢掉（上层据此记日志，区分「没触发」和「被冷却吃了」）
  let lastGapMs = 0; // 被冷却丢掉时，距上次触发过了多久

  const api = {
    // push({ x, y, clicks }) → 是否构成一次三击（同一手势只会返回一次 true）
    push(evt, now = Date.now()) {
      const osAvailable = typeof evt.clicks === 'number' && evt.clicks >= 1;
      // 必须「恰好等于 3」而不是「>=3」：OS 的连击计数是累加的，连点六下会依次报 1…6，
      // 用 >=3 会把第 4~6 下也当成新的三击（真机日志里刷了一片「移动跳过」、
      // 还在走路中途反复改目标）。等于 3 时一次连击只触发一次。
      const byOs = osAvailable && evt.clicks === 3;

      // 自攒只作为「OS 连击计数不可用」时的兜底：两条路同时跑会把同一次六连点算成两次三击
      let bySeq = false;
      if (!osAvailable) {
        const broken =
          now - lastAt > opt.intervalMs ||
          Math.abs(evt.x - lastX) > opt.distancePx ||
          Math.abs(evt.y - lastY) > opt.distancePx;
        if (broken) count = 0;
        count += 1;
        bySeq = count >= 3;
      }
      lastAt = now;
      lastX = evt.x;
      lastY = evt.y;

      if (!byOs && !bySeq) return false;

      count = 0;
      if (now - firedAt < opt.cooldownMs) {
        suppressed = true;
        lastGapMs = now - firedAt;
        return false;
      }
      suppressed = false;
      lastGapMs = 0;
      firedAt = now;
      lastPath = byOs ? 'os' : 'seq';
      return true;
    },
    reset() {
      count = 0;
    },
    // 最近一次触发走的是哪条路（os=OS 连击计数 / seq=自攒），用于日志与探针结论
    get lastPath() {
      return lastPath;
    },
    // 刚结束的这串手势是不是被冷却丢掉的（配合 lastGapMs 能看出差了多少毫秒）
    get lastSuppressed() {
      return suppressed;
    },
    get lastGapMs() {
      return lastGapMs;
    },
  };

  return api;
}

// 点击点 → 桌宠窗口左上角：居中对准，再钳进工作区（工作区比宠物还小的极端情况取左上角）
function computeWalkTarget(point, workArea, petSize) {
  const maxX = workArea.x + workArea.width - petSize.width;
  const maxY = workArea.y + workArea.height - petSize.height;
  const x = Math.round(point.x - petSize.width / 2);
  const y = Math.round(point.y - petSize.height / 2);
  return {
    x: Math.min(Math.max(x, workArea.x), Math.max(maxX, workArea.x)),
    y: Math.min(Math.max(y, workArea.y), Math.max(maxY, workArea.y)),
  };
}

// 起点与终点 → 走多久、多少帧（速度恒定，走路感；上限 3s 避免长距离等太久）
function planWalk(from, to, options) {
  const opt = { ...WALK, ...(options || {}) };
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const rawMs = (distance / opt.speedPxPerSec) * 1000;
  const durationMs = Math.min(Math.max(Math.round(rawMs), opt.minMs), opt.maxMs);
  return { distance: Math.round(distance), durationMs, frames: Math.max(1, Math.round(durationMs / opt.frameMs)) };
}

// 按进度取位置（t: 0→1，线性推进；超出范围会被钳住，所以末帧一定落在终点）
function stepPosition(from, to, t) {
  const k = Math.min(Math.max(t, 0), 1);
  return {
    x: Math.round(from.x + (to.x - from.x) * k),
    y: Math.round(from.y + (to.y - from.y) * k),
  };
}

// 朝向：向左走时渲染端水平翻转（图片皮肤才明显，emoji 也无妨）；横向几乎不动就算向右
function walkDirection(from, to) {
  return to.x < from.x - 4 ? -1 : 1;
}

// 鼠标赖在身上不走时往哪让开（「移到接触范围外」）：
//   向下与左右**不互斥**——向下优先（能往下挪就挪到极限），一次不够离开光标时再由左右补上，
//   于是经常表现为「斜着往下-侧挪」；左右之间取挪得少的一侧。
//   只有左右都放不下、且向下也补不齐时才返回 null（原地不动，别白挪）。
// 目标位置必须完整落在工作区内 —— 桌宠平时就贴着屏幕下沿，所以「向下」的余量常常是 0，
// 这时就纯靠左右离开，仍然是先尝试向下（挪 0px 也算试过）。
function planFlee(bounds, cursor, workArea, petSize, margin = 12) {
  const maxTop = workArea.y + workArea.height - petSize.height;
  const maxLeft = workArea.x + workArea.width - petSize.width;

  // 向下：挪到「宠物顶边落到光标下方」所需的量，但不超过工作区给的空间
  const neededDown = cursor.y + margin - bounds.y;
  const down = Math.max(0, Math.min(neededDown, maxTop - bounds.y));
  const y = bounds.y + down;

  // 光靠向下就离开了：不用左右挪
  if (down >= neededDown) {
    return { x: bounds.x, y, label: '下', axes: ['down'], movedPx: down };
  }

  // 向下已到极限仍不够 → 左右补：目标同样要完整落在工作区内
  const sides = [
    { dir: 'left', label: '左', x: cursor.x - margin - petSize.width },
    { dir: 'right', label: '右', x: cursor.x + margin },
  ].filter((s) => s.x >= workArea.x && s.x <= maxLeft);
  if (!sides.length) return null;
  // 左右都放得下时选挪动少的
  sides.sort((a, b) => Math.abs(a.x - bounds.x) - Math.abs(b.x - bounds.x));
  const pick = sides[0];
  const label = down > 0 ? `下+${pick.label}` : pick.label;
  return {
    x: pick.x,
    y,
    label,
    axes: down > 0 ? ['down', pick.dir] : [pick.dir],
    movedPx: Math.round(Math.hypot(pick.x - bounds.x, y - bounds.y)),
  };
}

// 光标是否落在宠物身上（box 是渲染端上报的「可交互区」，窗口内坐标）。
// 1.0.59 票 11-J 任务 2 起上报是离散矩形数组——任一小盒含光标即算在身上；
// 兼容旧的单盒调用方（tools/verify-walk.js 仍传单盒对象）。
function cursorOverPet(bounds, cursor, box) {
  const rects = Array.isArray(box) ? box : [box];
  return rects.some(
    (r) =>
      r &&
      cursor.x >= bounds.x + r.x &&
      cursor.x <= bounds.x + r.x + r.width &&
      cursor.y >= bounds.y + r.y &&
      cursor.y <= bounds.y + r.y + r.height
  );
}

module.exports = {
  createTripleClickDetector,
  computeWalkTarget,
  planWalk,
  stepPosition,
  walkDirection,
  planFlee,
  cursorOverPet,
  DEFAULTS,
  WALK,
};
