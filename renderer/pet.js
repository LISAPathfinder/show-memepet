// 渲染端异常上报：pet.js 顶层一旦抛错，后面的处理器注册会全部中断（表现就是"点不动、
// 菜单打不开"），而打包版没有控制台，这类错误就完全看不见了。所以在最前面挂一个错误出口。
window.addEventListener('error', (e) => {
  try {
    window.petAPI.reportClientError(`pet.js: ${e.message} @${e.lineno}:${e.colno}`);
  } catch {
    // 上报本身失败就算了
  }
});

// ===== 窗口标题（票 11-A）：单一真源在 identity.js，html 里不写死 =====
// 顶层 once：失败静默——title 拿不到只影响极少数可见面（桌宠窗不进任务栏/Alt-Tab），不能影响计数主流程
try {
  window.petAPI.getWindowTitle().then((t) => { document.title = t; }).catch(() => {});
} catch {
  // petAPI 不存在时（异常场景）本来就活不到这里
}

// ===== 皮肤配置（F2 动画层素材无关）=====
// v1 用 emoji 帧；换像素皮时把 type 改 'image'、帧换成 assets/skins/<name>/ 图片路径，
// 状态机与播放器零改动
const SKIN = {
  type: 'emoji',
  frameMs: 400, // emoji 多帧步进间隔
  imageFrameMs: 1600, // 图片皮肤多帧步进间隔（GIF 自身会动，步进只发生在多帧状态）
  frames: {
    idle: ['🐱'],
    blink: ['😸'],
    happy: ['🤩'],
    sleep: ['😴'],
    wow: ['😮'],
    remind: ['🥺'],
    drag: ['😻'],
    move: ['🐈'], // 走过去时的状态（图片皮肤没给 move 就回退 idle 图）
  },
};

const EMOJI_FRAMES = JSON.parse(JSON.stringify(SKIN.frames)); // emoji 原始帧留底，换回 emoji 时还原

const faceEl = document.getElementById('pet-face');
const bubbleEl = document.getElementById('bubble');
const counterEl = document.getElementById('counter');

// ===== 帧序列播放器：只消费帧数组，逐帧显示并循环 =====
const player = {
  frames: SKIN.frames.idle,
  index: 0,
  timer: null,
  play(frames) {
    this.stop();
    // 防御：单帧传成字符串时包装为数组（帧序列契约统一为字符串数组）
    if (typeof frames === 'string') frames = [frames];
    this.frames = frames && frames.length ? frames : SKIN.frames.idle;
    this.index = 0;
    if (this.frames.length > 1) {
      const step = SKIN.type === 'image' ? SKIN.imageFrameMs : SKIN.frameMs;
      this.timer = setInterval(() => this.advance(), step);
    }
    this.advance();
  },
  advance() {
    const frame = this.frames[this.index % this.frames.length];
    if (SKIN.type === 'image') {
      faceEl.textContent = '';
      // 同一张图不重设背景：重设会让 GIF 从第 0 帧重新播（“动图没播完就被切换”的根源）
      const url = `url("${frame}")`;
      if (faceEl.style.backgroundImage !== url) faceEl.style.backgroundImage = url;
    } else {
      faceEl.style.backgroundImage = 'none';
      faceEl.textContent = frame;
    }
    this.index += 1;
  },
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },
};

// ===== 状态机 =====
// blink 300ms / happy 1.5s / wow 2s 自动回 idle（image 皮肤加倍，见 stateDuration）；
// sleep 由主进程在键鼠活动恢复时推 idle 唤醒；remind 由气泡消失退出

const stateMachine = {
  current: 'idle',
  exitTimer: null,
  to(name) {
    if (!SKIN.frames[name] || this.current === name) return;
    clearTimeout(this.exitTimer);
    this.exitTimer = null;
    this.current = name;
    document.body.dataset.state = name;
    player.play(SKIN.frames[name]);
    faceEl.classList.remove('pop');
    void faceEl.offsetWidth; // 重置动画
    faceEl.classList.add('pop');
    const duration = stateDuration(name);
    if (duration) {
      this.exitTimer = setTimeout(() => this.to('idle'), duration);
    }
  },
};

// 临时状态的停留时长：image 皮肤下切状态等于换图，拉长一倍让 GIF 先播完
const STATE_DURATION = { blink: 300, happy: 1500, wow: 2000 };

function stateDuration(name) {
  const base = STATE_DURATION[name] || 0;
  if (SKIN.type !== 'image') return base;
  // 导入皮肤的眨眼图多是 1 秒以上的 GIF：沿用 600ms（base*2）会播一半就被切走，
  // 所以单独给足时长；GIF 更短也只是多停一会儿，比半截硬切自然
  if (name === 'blink') return 1600;
  return base * 2;
}

// idle 时随机眨眼：emoji 皮肤 3~6 秒一次；导入的图片皮肤只要提供了 blink 帧也参与，
// 间隔稍长一些（GIF 自带动作，眨眼只是偶尔插一下）——之前直接跳过 image 皮肤，导入皮肤永远不眨眼
function scheduleBlink() {
  const isEmoji = SKIN.type === 'emoji';
  setTimeout(() => {
    if (SKIN.frames.blink && stateMachine.current === 'idle') stateMachine.to('blink');
    scheduleBlink();
  }, isEmoji ? 3000 + Math.random() * 3000 : 4000 + Math.random() * 5000);
}

// ===== 说话气泡（F3/F4）：主进程推送与本地触发共用；remind/wow 随气泡消失回 idle =====
let bubbleTimer = null;

function showBubble(text, durationMs = 4500, state = null) {
  bubbleEl.textContent = text;
  bubbleEl.classList.remove('hidden');
  if (state) stateMachine.to(state);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubbleEl.classList.add('hidden');
    if (state && stateMachine.current === state) stateMachine.to('idle');
  }, durationMs);
}

// ===== 爱心粒子（F3 摸头）：脚下飘出 3~5 个 💕，飘起淡出 =====
function spawnHearts() {
  const count = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('span');
    el.className = 'particle';
    el.textContent = '💕';
    el.style.left = 30 + Math.random() * 50 + 'px';
    el.style.animationDelay = Math.random() * 0.2 + 's';
    document.querySelector('.pet-body').appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }
}

// ===== 鼠标穿透（F1）：指针在形象/气泡/计数/灯/齿轮/缩放手柄上才可交互，其余透明区穿透并转发 =====
const INTERACTIVE_SELECTOR = '#pet-face, #bubble, #counter, #zzz, #admin-lamp, #menu-gear, #scale-handle';

// F3 拖拽状态：位移阈值 5px 区分点击；拖拽中窗口保持可交互，防止指针滑出形象后被穿透断连
const drag = { active: false, moved: false, startX: 0, startY: 0 };

// 穿透状态**只由主进程**判定与下发（渲染端的定时器在锁屏/长时间无操作时会被 Chromium 节流到
// 每分钟一次，靠它兜底会卡在穿透上点不动）。这里只负责上报「可交互区域」——**各交互元素
// 各自的离散矩形**（1.0.59 票 11-J 任务 2：不再并成包围盒——并集里的透明空隙占了 25.6%，
// 点在那里的文件被 pet-root 静默吃掉；离散小盒让空隙天然落到区外）；拖拽/玻璃特效期间
// 上报整窗单盒，保证拖到形象外面也不会被设回穿透。
//
// ★ 渲染端没有穿透写入口（1.0.57 起）：`petAPI.setIgnoreMouseEvents` 与主进程那条
//   `pet:set-ignore-mouse-events` 处理器都已删除，`WS_EX_TRANSPARENT` 只由主进程写。
//   历史上这里能直接写，而主进程的记账（petIgnoreSent）不知道渲染端写了什么 →
//   轮询算出「该可交互」时会因「值没变」直接 return，窗口永久卡在穿透上、点击全被转发到
//   下层（表现：点不动，但计数/悬停都正常；2026-09-22 实测复现并修过记账，见 §52）。
//   判据：tools/verify-single-writer.js（静态）+ tools/verify-passthrough-desync.js（运行时）。
// 余量（票 11-J 任务 3 重估，6 → 2）：量化红线 = 吞点击区域 ≤ 元素真实面积的 1.2 倍
// （tools/verify-hit-region.js ⑤ 实算）。总环宽 = 本值 + 主进程 JITTER_PAD(1) = 3px/边；
// 票面先验猜的 4px/边实算 1.22× 超线，故取 3px。漂浮动画（translateY 0→-6）造成的盒体
// 边界抖动不再靠渲染端 pad 吸收——主进程用快速离开通道的 FAST_EXIT_PAD 区分「贴着元素」
// 与「真离开」（见 main.js syncPetPassThrough），这里只留上报离散化的最小贴边。
const BOX_PAD = 2;

// 返回离散矩形数组（各元素自带 BOX_PAD 余量）；拖拽/玻璃期间是整窗单盒数组；
// 无可见交互元素（全隐藏）返回 null，主进程按兜底区域判定（票 11-J 任务 2）
function interactiveBox() {
  if (drag.active || glass.on) {
    return [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }];
  }
  const els = document.querySelectorAll(INTERACTIVE_SELECTOR);
  const rects = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue; // 隐藏元素 rect 为 0
    rects.push({
      x: r.left - BOX_PAD,
      y: r.top - BOX_PAD,
      width: r.width + BOX_PAD * 2,
      height: r.height + BOX_PAD * 2,
    });
  }
  return rects.length ? rects : null;
}

// 票 11-L（11-J 任务 2b）：比对键用 3px 量化签名，而非精确 JSON。原因：漂浮动画（float 3s，
// translateY 0→-6）让脸/zzz 盒每帧都在动（峰值 ~6px/s），精确比对会让 rAF 循环每帧都 IPC——
// 而 ≤3px 的连续漂移本来就由主进程判定带（JITTER_PAD / FAST_EXIT_PAD + 保持期）吸收，不需要
// 主进程知道。3px 量化后：连续漂移几乎不上报（过量化边界才报一次），显隐/scale 弹跳/拖拽玻璃
// 进出等**离散突变**（差 >> 3px）必然触发。上报的数据仍是精确盒，量化的只是「要不要报」的判据。
const BOX_EPSILON = 3;
function boxSignature(box) {
  if (!box) return 'null';
  return box
    .map((r) =>
      `${Math.round(r.x / BOX_EPSILON)},${Math.round(r.y / BOX_EPSILON)},${Math.round(r.width / BOX_EPSILON)},${Math.round(r.height / BOX_EPSILON)}`
    )
    .join('|');
}

let lastBoxSig = '';
function reportInteractiveBox() {
  const box = interactiveBox();
  const sig = boxSignature(box);
  if (sig === lastBoxSig) return;
  lastBoxSig = sig;
  window.petAPI.setInteractiveBox(box);
}

// 区域变化（换皮、计数/气泡显隐、拖拽/玻璃进出）要立刻上报，别等下一次轮询。
// 注意：首次上报**不能放在这里**——本函数体里会读后面才声明的 glass/drag，
// 顶层立即调用会触发 TDZ ReferenceError，把后面所有事件处理器的注册一起打断。
// 首次上报放在文件末尾（所有声明都初始化之后），setInterval 的首次回调也在那之后才可能触发。
// 票 11-L：rAF 每帧驱动「变化才上报」——盒突变（显隐/弹跳/拖拽进出）从最多陈旧 1s 缩到一帧
// （≈16ms），第四层根因（主进程手里的盒可陈旧约 1s）就此治掉。rAF 被页面节流（遮挡/后台）时
// 下面这条 1s 定时器兜底仍在；onReportBox/onPing 点名通道不变。
function boxReportLoop() {
  reportInteractiveBox();
  requestAnimationFrame(boxReportLoop);
}
if (typeof requestAnimationFrame === 'function') requestAnimationFrame(boxReportLoop);
setInterval(reportInteractiveBox, 1000);
// 锁屏解锁/唤醒后主进程会点名要一次：那时页面定时器可能正被 Chromium 节流
window.petAPI.onReportBox(() => reportInteractiveBox());
// 主进程的存活探测：立刻回一声（顺带把区域一并刷新，解锁后的一轮总是最新的）
window.petAPI.onPing(() => {
  reportInteractiveBox();
  window.petAPI.pong();
});

// 点击探针：任何落在本窗口的按下都记一条（包含点到了哪个元素）。
// 排查「点不动」时这是第一判据：有记录 = 点击到了窗口，问题在处理逻辑；没记录 = 点击没到窗口。
document.addEventListener(
  'mousedown',
  (e) => {
    const t = e.target;
    const what = t && t.id ? t.id : t && t.className ? String(t.className) : 'unknown';
    window.petAPI.clickProbe(`${what} button=${e.button} @${Math.round(e.clientX)},${Math.round(e.clientY)}`);
  },
  true
);

// 救援热键（主进程 Ctrl→Alt→P）：强制回到可交互并弹出菜单。
// 强制下发那一步由主进程做（它是穿透状态的唯一写入者，且能同步自己的记账）；这里只负责弹菜单。
window.petAPI.onForceInteractive(() => {
  const g = document.getElementById('menu-gear').getBoundingClientRect();
  window.petAPI.openMenuAt(Math.round(g.right + 8), Math.round(g.top - 8));
});

// ===== 摸头 / 连点 / 拖拽（F3）=====
const CLICK_COMBO_WINDOW = 10000;
const CLICK_COMBO_COUNT = 5;
let clickTimes = [];
let suppressNextClick = false;

faceEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  window.petAPI.keepInteractive(true); // 按住期间整窗保持可交互（指针可能被拖到窗口外）
  window.petAPI.pressing(true); // 正按着：主进程据此不触发「鼠标停留 5 秒自动让开」
  // 按住脸拖动 = 拖拽移动。缩放手势在 1.0.39 移交给了 Ctrl 手柄（#scale-handle）：
  // 原先的 Ctrl+按脸拖动缩放分支已删，按住 Ctrl 拖脸现在就是普通移动
  drag.active = true;
  drag.moved = false;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  reportInteractiveBox(); // 按住期间整窗可交互，立刻让主进程知道
});

document.addEventListener('mousemove', (e) => {
  // 快速甩动时指针可能带着按下状态离开窗口（mouseup 丢失），松键即结束拖拽
  if (drag.active && e.buttons === 0) endDrag(false);
  if (scaleDrag.active && e.buttons === 0) endScaleDrag();
  if (scaleDrag.active) {
    // 每 200px 拖动 = 一个 0.5~2.0 量程的一半，够细腻也不会一抖就顶格。
    // 视觉缩放即时应用（固定窗下没有窗口操作可等），手柄跟着脸的左上角走全程贴合
    const raw = scaleDrag.startScale + (scaleDrag.startY - e.clientY) * 0.005;
    const next = clampScale(raw);
    if (Math.abs(next - scaleDrag.startScale) >= 0.01) scaleDrag.changed = true;
    // 顶格反馈（1.0.41）：拖过量程边界后三角形变红常亮，拖回量程内复原
    handleEl.classList.toggle('limit', raw > SCALE_MAX || raw < SCALE_MIN);
    applyPetScale(next);
    positionScaleHandle();
    return;
  }
  if (!drag.active) return;
  const travel = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
  if (!drag.moved && travel < 5) return;
  drag.moved = true;
  stateMachine.to('drag'); // 拖拽中展示 drag 帧（未映射时回退 idle），松手回 idle
  window.petAPI.moveBy(e.movementX, e.movementY);
});

document.addEventListener('mouseup', () => {
  window.petAPI.pressing(false); // 松开：允许「鼠标停留 5 秒自动让开」重新计时
  if (scaleDrag.active) endScaleDrag();
  endDrag(true);
});

// ===== Ctrl+拖拽缩放（1.0.31）：拖拽中只动 CSS transform，松手 scaleEnd 带值持久化 =====
// 1.0.52 固定窗：窗口恒 600×600、#pet-root 钉窗口右下角（transform-origin 右下），拖拽全程
// 零原生窗口操作，transform 指针驱动即时应用——想抽搐都没有载体（透明窗每改一次窗口就会
// 闪陈旧帧，1.0.41 的「transform 对齐窗口」方案反而把错位帧变成每步必现，已废）。
// 视觉右下角永远钉在窗口右下角，桌宠朝手柄方向伸缩、原地缩放
const SCALE_MIN = 0.5;
const SCALE_MAX = 2;
const petRootEl = document.getElementById('pet-root');
let petScaleNow = 1;
const scaleDrag = { active: false, startY: 0, startScale: 1, changed: false };

function clampScale(v) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v));
}

function endScaleDrag() {
  scaleDrag.active = false;
  handleEl.classList.remove('limit'); // 顶格红显只在拖动中有意义，松手复原
  window.petAPI.keepInteractive(false); // 松手后交回按元素判定
  updateScaleHandle(); // 拖拽中 Ctrl 若已松开，这时手柄才能跟着隐藏
  if (scaleDrag.changed) {
    suppressNextClick = true; // 拖完松手不触发摸头
    window.petAPI.scaleEnd(Math.round(petScaleNow * 100) / 100);
  }
}

function endDrag(moved) {
  if (!drag.active) return;
  drag.active = false;
  window.petAPI.keepInteractive(false); // 松手后交回按元素判定
  updateScaleHandle(); // 移动拖拽期间手柄被压住，松手按 Ctrl 态重算显隐
  reportInteractiveBox(); // 回到按元素判定的区域
  if (drag.moved) {
    suppressNextClick = true;
    if (stateMachine.current === 'drag') stateMachine.to('idle');
    if (moved) window.petAPI.dragEnd();
  }
}

// ===== 缩放手柄（1.0.39）：按住 Ctrl，桌宠视觉区左上方出现发光三角，拖它缩放 =====
// 显隐由主进程全局钩子推的 Ctrl 状态驱动（pet:ctrl / pet:config.ctrlDown 快照）；
// 缩放管线：拖拽中即时改 transform（1.0.52 固定窗，无窗口操作），松手 scaleEnd 带值持久化。
const handleEl = document.getElementById('scale-handle');

function positionScaleHandle() {
  // 边长 = 底部计数栏高度 × 0.65（1.0.41：用户要求比计数图标小一圈；1.0.40 曾与计数同高）；
  // 计数还没推送过（hidden、rect 为 0）时回退 20px 基准，同样按 0.65 缩
  const cr = counterEl.getBoundingClientRect();
  const size = Math.round((cr.height > 0 ? cr.height : 20) * 0.65);
  handleEl.style.width = size + 'px';
  handleEl.style.height = size + 'px';
  // 锚定脸 rect 的左上方。拖拽缩放中随 mousemove 重算（跟着缩放走，永不脱离）；
  // 非拖拽态只在显示那一刻定位一次（跟随漂浮动画会自己抖）
  const r = faceEl.getBoundingClientRect();
  const x = Math.max(4, Math.min(r.left - size - 8, window.innerWidth - size - 4));
  const y = Math.max(4, Math.min(r.top - size - 8, window.innerHeight - size - 4));
  handleEl.style.left = x + 'px';
  handleEl.style.top = y + 'px';
}

function updateScaleHandle() {
  // 移动拖拽中不显示（endDrag 回来再按 Ctrl 态重算）；缩放拖拽中即使 Ctrl 已松也保持，
  // 否则拖到一半手柄在指针底下消失很怪
  const show = (petCtrlDown || scaleDrag.active) && !drag.active;
  if (show) positionScaleHandle();
  handleEl.classList.toggle('hidden', !show);
  reportInteractiveBox(); // 显隐改变可交互区域，立刻重报（不等 1s 轮询）
}

let petCtrlDown = false;
window.petAPI.onCtrl(({ down }) => {
  petCtrlDown = !!down;
  updateScaleHandle();
});

handleEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  scaleDrag.active = true;
  scaleDrag.startY = e.clientY;
  scaleDrag.startScale = petScaleNow;
  scaleDrag.changed = false;
  window.petAPI.keepInteractive(true); // 拖动中指针可能被甩出窗口
  window.petAPI.pressing(true); // 手柄在桌宠窗口内，按住期间同样不让「自动让开」触发
  reportInteractiveBox();
});

faceEl.addEventListener('click', () => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  stateMachine.to('happy');
  spawnHearts();
  const now = Date.now();
  clickTimes.push(now);
  clickTimes = clickTimes.filter((t) => now - t <= CLICK_COMBO_WINDOW);
  if (clickTimes.length >= CLICK_COMBO_COUNT) {
    clickTimes = [];
    showBubble('别戳啦！', 2500);
  }
});

// F7 双击桌宠打开统计面板（可在菜单里关掉，默认关）
let dblclickStats = false;
window.petAPI.onConfig((cfg) => {
  if (cfg && typeof cfg.dblclickStats === 'boolean') dblclickStats = cfg.dblclickStats;
  // 管理员指示灯：主进程 fltmc 探测完会补推一次（探测是异步的，页面加载完的首次推送可能还是旧值）
  if (cfg && typeof cfg.isAdmin === 'boolean') {
    const lamp = document.getElementById('admin-lamp');
    lamp.classList.toggle('on', cfg.isAdmin);
    lamp.title = cfg.isAdmin ? '正在以管理员权限运行' : '普通权限运行（管理员游戏内不计数）';
  }
  // 缩放恢复/变更：主进程改完窗口尺寸后推送（含启动、重载两条来路；拖拽缩放是渲染端
  // 发起，本地已实时应用，收到的推送值一致、幂等）
  if (cfg && Number.isFinite(Number(cfg.petScale))) applyPetScale(Number(cfg.petScale));
  // Ctrl 快照：页面重载时主进程不会重发 pet:ctrl（只在状态翻转时推），靠这里恢复手柄显隐
  if (cfg && typeof cfg.ctrlDown === 'boolean' && cfg.ctrlDown !== petCtrlDown) {
    petCtrlDown = cfg.ctrlDown;
    updateScaleHandle();
  }
});

function applyPetScale(s) {
  petScaleNow = s;
  petRootEl.style.transform = `scale(${s})`;
  reportInteractiveBox(); // 尺寸变了立刻重报交互区（不等 1s 轮询）
}
faceEl.addEventListener('dblclick', () => {
  if (dblclickStats) window.petAPI.openStats();
});

// 菜单入口：桌宠下方齿轮（替代右键，避免全屏/穿透场景右键不可靠）
const gearEl = document.getElementById('menu-gear');
gearEl.addEventListener('click', () => {
  const r = gearEl.getBoundingClientRect();
  window.petAPI.openMenuAt(Math.round(r.right + 8), Math.round(r.top - 8));
});

// ===== 悬浮计数（F5/F8）：「⌨ N · 🖱 M · 🎮 G」三段式，数字变化时轻微弹跳 =====
let lastCounter = { keys: -1, mouse: -1, gamepad: -1 };

function counterSeg(icon, value, changed) {
  return `<span class="seg${changed ? ' bump' : ''}">${icon} ${value}</span>`;
}

window.petAPI.onCounter(({ keys, mouse, gamepad }) => {
  const kChanged = lastCounter.keys !== -1 && keys !== lastCounter.keys;
  const mChanged = lastCounter.mouse !== -1 && mouse !== lastCounter.mouse;
  const gChanged = lastCounter.gamepad !== -1 && gamepad !== lastCounter.gamepad;
  counterEl.classList.remove('hidden');
  let html = `${counterSeg('⌨', keys, kChanged)}<span class="dot">·</span>${counterSeg('🖱', mouse, mChanged)}`;
  // 手柄段只在今日真的用过手柄时出现，避免对无手柄用户造成干扰
  if (gamepad > 0 || lastCounter.gamepad > 0) {
    html += `<span class="dot">·</span>${counterSeg('🎮', gamepad, gChanged)}`;
  }
  counterEl.innerHTML = html;
  lastCounter = { keys, mouse, gamepad };
});

// ===== 手柄按键统计：由主进程 XInput 轮询计数，本页不再用 Gamepad API（无焦点收不到）=====

// ===== 拖拽导入：图片/表情包拖到桌宠身上即可（透明区域穿透收不到，属正常）=====
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  glassEnd();
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!files.length) return;
  const paths = files.map((f) => window.petAPI.getPathForFile(f)).filter(Boolean);
  if (paths.length) window.petAPI.dropImport(paths);
});

// ===== 拖文件悬停玻璃特效：dragover 一到就点亮玻璃层，
// 玻璃只罩住脸部附近一小圈（红框范围），透明度按指针到脸心的距离取值；
// 250ms 无事件或落下/拖离即熄灭 =====
const glassEl = document.getElementById('glass');
const GLASS_PAD = 24; // 脸部四周的玻璃外扩
const GLASS_RADIUS = 110; // 亮度衰减半径：脸心最亮，到玻璃边缘基本消失
const glass = { on: false, timer: null };

function glassStrength(x, y) {
  const r = faceEl.getBoundingClientRect();
  const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
  return Math.max(0.12, Math.min(1, 1 - d / GLASS_RADIUS));
}

function glassUpdate(x, y) {
  if (!glass.on) {
    glass.on = true;
    window.petAPI.keepInteractive(true); // 玻璃特效期间整窗保持可交互（指针可能在窗口外）
    reportInteractiveBox();
  }
  // 脸有漂浮动画，玻璃随它的实时位置移动
  const r = faceEl.getBoundingClientRect();
  glassEl.style.left = r.left - GLASS_PAD + 'px';
  glassEl.style.top = r.top - GLASS_PAD + 'px';
  glassEl.style.width = r.width + GLASS_PAD * 2 + 'px';
  glassEl.style.height = r.height + GLASS_PAD * 2 + 'px';
  glassEl.style.opacity = glassStrength(x, y).toFixed(3);
  clearTimeout(glass.timer);
  glass.timer = setTimeout(glassEnd, 250);
}

function glassEnd() {
  clearTimeout(glass.timer);
  if (!glass.on) return;
  glass.on = false;
  window.petAPI.keepInteractive(false);
  glassEl.style.opacity = '0';
  reportInteractiveBox(); // 回到按元素判定的区域
}

document.addEventListener('dragover', (e) => glassUpdate(e.clientX, e.clientY));
document.addEventListener('dragleave', (e) => {
  // relatedTarget 为空说明指针已离开整个窗口
  if (!e.relatedTarget) glassEnd();
});

// ===== 主进程推送：气泡（随机台词/手速/久坐提醒）与睡眠状态 =====
window.petAPI.onBubble(({ text, durationMs, state }) => showBubble(text, durationMs, state));

// 走过去（move 状态）由主进程在开始/结束时推送：开始切 move 帧并按方向翻转，
// 结束回 idle（若这段时间里用户点了它、正在 happy，就让它自己按 happy 的时长回 idle）
window.petAPI.onWalk(({ active, direction }) => {
  faceEl.classList.toggle('flip', !!active && direction < 0);
  if (active) {
    stateMachine.to('move');
  } else if (stateMachine.current === 'move') {
    stateMachine.to('idle');
  }
});

window.petAPI.onState((state) => {
  if (state === 'sleep') {
    stateMachine.to('sleep');
  } else if (state === 'happy') {
    // 主进程推送的开心（摇杆拨动触发）；睡觉时不打断，和点击脸部的效果一致
    if (stateMachine.current !== 'sleep') {
      stateMachine.to('happy');
      spawnHearts();
    }
  } else if (state === 'idle' && stateMachine.current === 'sleep') {
    stateMachine.to('idle');
  }
});

// ===== 换皮（F2）：收到皮肤数据后重建帧源；缺失状态回退 idle 图 =====
function applySkin(skin) {
  if (skin && skin.type === 'image' && skin.frames && skin.frames.idle) {
    SKIN.type = 'image';
    for (const state of Object.keys(SKIN.frames)) {
      // 帧序列契约：每个状态是帧数组；图片皮肤单帧成组，缺失状态回退 idle 图
      SKIN.frames[state] = [skin.frames[state] || skin.frames.idle];
    }
  } else if (skin && skin.type === 'emoji') {
    // emoji 皮肤：默认帧打底，emoji-skin.json 映射过的状态用映射字符覆盖
    SKIN.type = 'emoji';
    SKIN.frames = JSON.parse(JSON.stringify(EMOJI_FRAMES));
    if (skin.frames) {
      for (const state of Object.keys(SKIN.frames)) {
        if (typeof skin.frames[state] === 'string' && skin.frames[state]) {
          SKIN.frames[state] = [skin.frames[state]];
        }
      }
    }
  } else {
    SKIN.type = 'emoji';
    SKIN.frames = JSON.parse(JSON.stringify(EMOJI_FRAMES));
  }
  player.play(SKIN.frames[stateMachine.current]);
}

window.petAPI.onSkin(applySkin);

// ===== 右键置底穿透 2 秒（参考 Bongo Cat 的「让一让」）=====
// 主进程负责穿透/置底（单写入者），这里只发请求 + 做变暗的视觉反馈。
// 放在文件末段：回调解引用的 drag/scaleDrag/glass 此刻都已初始化（顶层立即执行过一次的
// 教训见上方 boxReportLoop 注释——本块只注册监听、不顶层调用，属防御性摆放）
document.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;
  if (drag.active || scaleDrag.active || glass.on) return; // 拖拽/缩放/玻璃期间整窗可交互有各自语义，别打断
  window.petAPI.peekRequest();
});
// 右键已是功能入口，吞掉默认行为（Electron 无默认菜单，防御性写法）
document.addEventListener('contextmenu', (e) => e.preventDefault());
window.petAPI.onPeek((on) => document.body.classList.toggle('peek', on));

// 所有监听器注册完毕：通知主进程重放就绪前的推送
window.petAPI.ready();

// 启动：初始穿透状态由主进程设定（它开窗时就下发 setIgnoreMouseEvents(true)），
// 指针移入形象后由主进程轮询翻成可交互 —— 渲染端不参与写入
player.play(SKIN.frames.idle);
scheduleBlink();

// 首次上报可交互区域（放这里：所有声明都已初始化，不会踩 TDZ）
reportInteractiveBox();
