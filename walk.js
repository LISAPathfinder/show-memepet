// 桌宠「走过去」的纯逻辑（不依赖 electron，便于 tools/verify-walk.js 用纯 node 直接测）：
//   ① 三击判定：优先吃 OS 连击计数（libuiohook 的 clicks，最准、天然贴合系统的双击速度设置），
//      拿不到就自攒「间隔 ≤500ms 且位移 ≤8px 的连续三次」——两条路共用冷却，保证一次手势只触发一次。
//   ② 落点与路径：点击点对准宠物中心并钳进工作区；再按距离算出移动时长（速度恒定 = 走路感），
//      由主进程按帧沿直线推进窗口位置。
//   ③ 未成留痕（票 14-U）：三击没成时要能说清是哪条路径吃掉的（MISS_REASONS + createGestureTrace），
//      否则真人报「不灵」而日志零行，归因只能靠猜。

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

// 三击「没成」的原因枚举（票 14-U 任务 A）。真源在这里：main.js 与判据件都取这份，
// 别在各处写死字面量（同 identity.js 那条「名字一律 require 它取」的规矩）。
// 本枚举只用于留痕与归因，**不参与任何触发判定**。
const MISS_REASONS = {
  NOT_OS_3: 'not-os-3', // OS 给了连击计数，但不是恰好 3（此刻自攒兜底整条停用，见 push 内注释）
  SEQ_BROKEN: 'seq-broken', // OS 计数不可用，自攒串被间隔或位移打断
  SEQ_INCOMPLETE: 'seq-incomplete', // OS 计数不可用，串没断但还没攒到三下
  COOLDOWN: 'ok-but-cooldown', // 手势本身成立，被冷却吃掉（与 lastSuppressed 同义，已由「移动跳过」行留痕）
  CTRL_DROP: 'ctrl-drop', // 序列中某一击没被认到 Ctrl（上层在 push 之前就 return 了）
  IN_WINDOW: 'in-window', // 点中桌宠互动盒（宠身），整串作废（不触发走过去）。名字是 14-U 的历史口径：
  // 14-V 起判的是互动盒而不是 600×600 整窗——窗口里 75% 是透明区，按整窗判会把桌面上的点击整串吞掉
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
  let missReason = ''; // 最近一次 push 返回 false 的原因（票 14-U 任务 A：把「为什么没成」变成读数）

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
      let broken = false;
      if (!osAvailable) {
        broken =
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

      if (!byOs && !bySeq) {
        missReason = osAvailable ? MISS_REASONS.NOT_OS_3 : broken ? MISS_REASONS.SEQ_BROKEN : MISS_REASONS.SEQ_INCOMPLETE;
        return false;
      }

      count = 0;
      if (now - firedAt < opt.cooldownMs) {
        suppressed = true;
        lastGapMs = now - firedAt;
        missReason = MISS_REASONS.COOLDOWN;
        return false;
      }
      suppressed = false;
      lastGapMs = 0;
      firedAt = now;
      lastPath = byOs ? 'os' : 'seq';
      missReason = '';
      return true;
    },
    reset() {
      count = 0;
    },
    // 最近一次触发走的是哪条路（os=OS 连击计数 / seq=自攒），用于日志与探针结论
    get lastPath() {
      return lastPath;
    },
    // 最近一次「返回 false」是哪条路径吃掉的（MISS_REASONS 之一；成功触发时为空串）
    get lastReason() {
      return missReason;
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

// 一次「Ctrl+三击」尝试的留痕状态机（票 14-U 任务 A：21 次丢弃在日志里一行都不留）。
// 为什么放 walk.js 而不是写进 main.js：「什么时候成一行、一行里写什么」是判据要考的东西，
// 只有留在纯逻辑里才能被真驱动（红法 U-a 喂 clicks=[1,2,4] 必须指认成 not-os-3、
// U-c 摘掉这行留痕判据必须红）；main.js 只负责把行交给 logLine。
// 限流口径（票面明令「别把 30 次尝试刷成 90 行」）＝**一次手势最多一行**：
//   · take() 只在攒满三击时才成行（前两击没成是过程，不是失败尝试）；
//   · drop() 只在串里已有 ≥2 击时才成行（单次 Ctrl+点击后改主意不该刷日志）；
//     例外一条（复测轮修正，见下面 drop() 的注释）：**in-window 且带 Ctrl** 无条件成行——
//     这类点击每击一行（不是一手势一行），因为那一串根本走不到 take()，逐击留痕是它唯一的可见方式；
//     不带 Ctrl 的摸头桌宠仍然一行都不留，防噪初衷不变。
//   · 成功触发后，冷却窗内的连点尾巴不记账（那几下已由「走过去」那一行留痕）。
// ★ 能力边界（写给下一个读这段的人，别把本状态机读成「所有丢弃都有行」）：用户只点了两下就停手、
//   或钩子根本没送到第三击 ⇒ 没有事件就没有结清点，这里一行都不会有。为它加定时器去猜「串断了」
//   会把成功的慢三击（OS 路径不看 intervalMs，实测 700ms 间隔也认）谎报成未成，故有意不做。
//   因此真人复测的数法是「未成行数 ≤ 尝试次数」，缺的那部分就是这条边界，不是判据坏了。
function createGestureTrace(options) {
  const opt = { log: () => {}, cooldownMs: DEFAULTS.cooldownMs, ...(options || {}) };
  let entries = [];
  let firedAt = Number.NEGATIVE_INFINITY;

  const line = (reason) => {
    const clicks = entries.map((e) => (typeof e.clicks === 'number' ? String(e.clicks) : '-')).join(',');
    const ctrl = entries.map((e) => (e.ctrl ? 1 : 0)).join(',');
    return `三击未成(${reason}): 序列 clicks=[${clicks}] ctrl=[${ctrl}]`;
  };

  return {
    // 记一参与击：clicks 是 OS 连击计数原值（可能是 undefined=不可用），ctrl 是上层拿到的修饰键判定
    note(clicks, ctrl, now = Date.now()) {
      if (now - firedAt < opt.cooldownMs) return; // 上一次成事的冷却窗内：连点尾巴不重复记账
      entries.push({ clicks, ctrl: !!ctrl });
    },
    // push() 返回 false 之后结清这一串（reason 取 tripleClick.lastReason）
    take(reason) {
      if (reason === MISS_REASONS.COOLDOWN) {
        entries = []; // 手势成立但被冷却吃掉：「移动跳过」那一行已经留痕，不再补一行
        return;
      }
      if (entries.length < 3) return;
      const text = line(reason);
      entries = [];
      opt.log(text);
    },
    // 上层静默出口（Ctrl 掉一拍 / 点在桌宠窗口里）打断当前串。
    // 门槛口径（票 14-U 复测轮修正）：默认「串里 ≥2 击才成行」，它防的是**正常摸头桌宠**刷屏；
    // 但 in-window 这条出口在 main.js 里位于 `push()` **之前**、每击都立刻 `reset()`，串永远凑不到 2
    // ⇒ 「按住 Ctrl 点在桌宠身上」这一整类失败在日志里完全隐形（真人定向组实测：4 下点宠身 ⇒ 0 行）。
    // 带 Ctrl 就说明用户在做手势意图，与「防正常摸头刷屏」不冲突 ⇒ 这种情况无条件成行。
    drop(reason, ctrl = false) {
      const intent = reason === MISS_REASONS.IN_WINDOW && ctrl === true;
      if (entries.length < 2 && !intent) {
        entries = [];
        return;
      }
      const text = line(reason);
      entries = [];
      opt.log(text);
    },
    // 触发成功：结清这一串，并开一段冷却窗（连点尾巴不再记账）
    fired(now = Date.now()) {
      entries = [];
      firedAt = now;
    },
    clear() {
      entries = [];
    },
    get pending() {
      return entries.length;
    },
  };
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

// 内容矩形左上角 → 窗口原点（票 14-U 任务 B）：内收量 = **真实窗口尺寸** − 内容尺寸。
// 为什么必须吃真实尺寸，而不是 core/geometry 的常量模型：固定窗名义 600，本机 113% 缩放下
// getBounds() 的 DIP 回读是 605（PITFALLS §105），按常量 600 推内收量就少算 5px，于是贴右/下缘
// 时可见内容被顶出工作区那 5px——与 §98/票 14-B「窗口抖多少、内容就出屏多少」同族，只是那条
// 修的是拖拽通道（clampPetOriginToWorkArea 收 winSize），走过去这条没跟上。
// 装机日志里贴左缘那三条「窗口 -300」数值本身没有错（内容钳到 workArea.x=0 后减内收量 300），
// 错在那个 300 比本机真实的 305 少 5。
function contentToOrigin(contentTopLeft, winSize, contentSize) {
  return {
    x: Math.round(contentTopLeft.x - (winSize.width - contentSize.width)),
    y: Math.round(contentTopLeft.y - (winSize.height - contentSize.height)),
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
  createGestureTrace,
  computeWalkTarget,
  contentToOrigin,
  planWalk,
  stepPosition,
  walkDirection,
  planFlee,
  cursorOverPet,
  DEFAULTS,
  MISS_REASONS,
  WALK,
};
