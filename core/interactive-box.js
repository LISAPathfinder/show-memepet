// 可交互盒上报的纯函数（票 0a-2 从 renderer/pet.js 搬出，0a 第一刀「渲染端三件套」里唯一纯的那一段）。
// 与 core/geometry.js 同一条纯度约束：零依赖、不碰 DOM、不读环境、不用时间源、无模块级可变状态；
// 判据件因此可以 require 真函数而不是从 pet.js 抽函数体进 vm（tools/verify-build-files.js (5) 守这条）。
// 双形态装载：渲染端没有 CommonJS（pet 窗只给 preload、sandbox 下连 preload 都不能 require 本地模块），
// 所以本文件由 renderer/pet.html 用 <script src="../core/interactive-box.js"> 先于 pet.js 加载——
// 经典脚本的顶层 const/function 进全局词法作用域，pet.js 里的 interactiveBox / reportInteractiveBox
// 原样看得见这两个符号；node 侧（判据件）走下面那句守卫过的 module.exports。
// 留在 pet.js 的是搬不动的两半：interactiveBox（document/getBoundingClientRect + drag/glass 状态）
// 与 reportInteractiveBox（window.petAPI IPC + 模块级 lastBoxSig 去重态）。
'use strict';

// 余量（票 11-J 任务 3 重估，6 → 2）：量化红线 = 吞点击区域 ≤ 元素真实面积的 1.2 倍
// （tools/verify-hit-region.js ⑤ 实算）。总环宽 = 本值 + 主进程 JITTER_PAD(1) = 3px/边；
// 票面先验猜的 4px/边实算 1.22× 超线，故取 3px。漂浮动画（translateY 0→-6）造成的盒体
// 边界抖动不再靠渲染端 pad 吸收——主进程用快速离开通道的 FAST_EXIT_PAD 区分「贴着元素」
// 与「真离开」（见 main.js syncPetPassThrough），这里只留上报离散化的最小贴边。
const BOX_PAD = 2;

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

// 浏览器里 module 未定义（守卫而不是裸赋值，否则 pet.html 加载本文件当场 ReferenceError，
// 上报链整条断掉）；node/判据件走这条。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BOX_PAD, BOX_EPSILON, boxSignature };
}
