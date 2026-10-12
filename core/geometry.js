// 桌宠几何纯函数（票 12-A 从 main.js 搬出）。纯度是本文件的立身之本：
// 零依赖——不 require electron/config/fs/child_process，不读 process.env、不用 Date.now、
// 无任何 IO 与模块级可变状态，同输入必同输出；因此判据件能 `require` 真函数而不是从源码
// 抽函数体丢进 vm 求值（tools/verify-build-files.js 的 core 纯度闸守这条）。
// 红线：摆放类用内容矩形（contentSize/petContentRect），命中/避让/兜底盒用视觉矩形
// （visualSize/petVisualRect），两套口径故意分开，不许「顺手统一」。
'use strict';

// F1 桌宠窗：固定 600×600（= 基准 300 × 缩放上限 2）、透明、无边框、置顶、不进任务栏
const PET_SIZE = { width: 300, height: 300 };

// 桌宠整体缩放（1.0.30 引入；1.0.31 Ctrl+拖拽，1.0.39 起 Ctrl 手柄拖动）：1.0.51 前窗口尺寸 =
// 基准 × scale；1.0.52 起窗口固定 600×600、scale 只驱动渲染端 transform（见 PET_WINDOW_SIZE）。
// clamp 上限 2.0（再大形象超出典型工作区高度一半以上，且固定窗尺寸随上限翻倍）、下限 0.5（再小点不中）。
const PET_SCALE_MIN = 0.5;
const PET_SCALE_MAX = 2;

// 桌宠窗固定尺寸（1.0.52）：透明窗每次 setBounds（改尺寸/挪原点）都会让 OS 把陈旧帧先拉伸/
// 错位显示 1~2 帧再回弹——1.0.51 的右下角锚定使每步缩放都挪原点，放大缩小全程抽搐。窗口从此
// 不再随缩放变，缩放 = 纯 CSS transform（#pet-root 钉窗口右下角 + origin 右下），拖拽全程零原生操作。
// 改 PET_SCALE_MAX 时这里必须跟着改（固定窗必须装得下上限缩放）
const PET_WINDOW_SIZE = { width: 600, height: 600 };

// 桌宠视觉尺寸（基准 × scale）：视觉矩形右下角 == 窗口右下角（#pet-root 钉窗口右下角 +
// transform-origin 右下），所以视觉矩形 = 窗口矩形左/上各内收 offset。「桌宠看得见/避让」
// 的判据要用视觉矩形——整窗判据会让桌宠在 scale<2 时永远靠不近屏幕左/上边缘
function visualSize(s) {
  return { width: Math.round(PET_SIZE.width * s), height: Math.round(PET_SIZE.height * s) };
}

// 视觉矩形相对窗口矩形的左/上内收量（右下角对齐）
function petVisualOffset(s) {
  return PET_WINDOW_SIZE.width - Math.round(PET_SIZE.width * s);
}

// 桌宠视觉矩形（屏幕坐标）：origin 是窗口原点
function petVisualRect(origin, s) {
  const off = petVisualOffset(s);
  const size = visualSize(s);
  return { x: origin.x + off, y: origin.y + off, width: size.width, height: size.height };
}

// 桌宠「可见内容」矩形（1.0.64 判据收紧）：300×300 视觉矩形顶部是 ~154px 的气泡预留位
// （说话气泡/💤，平时不可见），按视觉矩形做贴边判据会让脸永远贴不到屏幕上缘。摆放类判据
// （贴边回挪/拖拽钳制/走过去/让开/缩放回挪）改用内容矩形：底边与视觉矩形齐平（脸 110 +
// 底行 ~30 + padding 6 ≈ 146，留 💤 溢出余量取 160），宽度保持全宽（底行计数 pill 是最宽
// 可见物，左右语义不变）。命中/避让/兜底盒仍是视觉矩形口径（layoutMenu/petCovered/
// petFallbackBox 各自已按票校准，不随动）。贴顶说话时气泡被屏幕上缘裁一块，属接受代价。
const PET_CONTENT_HEIGHT = 160;
function contentSize(s) {
  return { width: visualSize(s).width, height: Math.round(PET_CONTENT_HEIGHT * s) };
}
function petContentOffset(s) {
  return {
    x: PET_WINDOW_SIZE.width - contentSize(s).width,
    y: PET_WINDOW_SIZE.height - contentSize(s).height,
  };
}
function petContentRect(origin, s) {
  const off = petContentOffset(s);
  const size = contentSize(s);
  return { x: origin.x + off.x, y: origin.y + off.y, width: size.width, height: size.height };
}

// 兜底可交互区：渲染端还没上报（页面刚加载、或锁屏解锁后渲染端一时不响应）时用，
// 不能默认「整窗穿透」——那会让桌宠在可见的情况下完全点不动。
// 按当前 scale 从视觉矩形**在窗口内的偏移**派生（复用 petVisualOffset/visualSize，两者都是
// 窗口内坐标）：视觉矩形右下角对齐窗口右下角 (600,600)，覆盖形象/计数/齿轮。
// 1.0.55 及以前是写死常量 {x:40,y:140,200x155}——1.0.51 前「窗口=基准×scale」坐标系的值，
// 固定窗后兜底命中区落到窗口空白左上角（票 11-G 任务 3；纯逻辑判据 tools/verify-fallback-box.js）。
function petFallbackBox(s) {
  const off = petVisualOffset(s);
  const size = visualSize(s);
  return { x: off, y: off, width: size.width, height: size.height };
}

// 离散矩形数组的总面积（宽限期「面积变大」判据用；票 11-J 任务 2 起上报是数组）
function boxesArea(rects) {
  if (!Array.isArray(rects)) return 0;
  return rects.reduce((s, r) => s + (r && r.width > 0 && r.height > 0 ? r.width * r.height : 0), 0);
}

// 宽限期是否提前结束：收到一次「面积变大」的上报 = 残缺的那截元素（计数 chip 等）已渲染出来
function graceEndsOnReport(prev, next, now, until) {
  if (!prev || !next) return false;
  if (!(now < until)) return false;
  return boxesArea(next) > boxesArea(prev);
}

// 重建后首次同步的判定盒（票 11-I 宽限 ∪ 票 11-J 任务 4 收口）：上报数组 ∪ 兜底视觉矩形，
// **离散并排**（不合成包围盒——并集把空隙重新吞回来）。只在 petSyncAfterRebuild 那一次
// （重建后第一次 force 同步）生效；core/geometry.js 是判据件的真源，勿改签名。
function graceJudgeBoxes(report, scale) {
  const fb = petFallbackBox(scale);
  return [...(Array.isArray(report) ? report : report ? [report] : []), fb];
}

// 任一小盒（外扩 pad）含点即命中（票 11-J 任务 2）：命中判定落在离散矩形上，
// 不再并成包围盒——并集包围盒里的透明空隙（现场 3 实测占 25.6%）不该算桌宠本体。
// core/geometry.js 是判据件的真源，勿改签名。
function pointInBoxes(rects, x, y, pad) {
  if (!Array.isArray(rects)) rects = rects ? [rects] : [];
  for (const r of rects) {
    if (!r || !(r.width > 0) || !(r.height > 0)) continue;
    if (x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad) return true;
  }
  return false;
}

module.exports = {
  PET_SIZE,
  PET_SCALE_MIN,
  PET_SCALE_MAX,
  PET_WINDOW_SIZE,
  PET_CONTENT_HEIGHT,
  visualSize,
  petVisualOffset,
  petVisualRect,
  contentSize,
  petContentOffset,
  petContentRect,
  petFallbackBox,
  boxesArea,
  graceEndsOnReport,
  graceJudgeBoxes,
  pointInBoxes,
};
