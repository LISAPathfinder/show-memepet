// @runtime: none —— 共享库（瞄点+落点前置），被判据件 require，不独立执行
// 瞄点共享库（票 11-S 任务 2）：verify-click-after / verify-flee-interaction / verify-hide-show-input
// 三件运行时判据的瞄点基准换轨 + 「落点必须在形象上」前置断言。
//
// 口径照 verify-flee.js:137-141：从渲染端 interactiveBox() 上报盒取最大盒（脸）中心，且每步重取——
// 固定 600×600 窗后「窗口几何中心」不是桌宠（§76）；1.0.64 内容矩形模型下窗体上部是气泡预留区，
// 几何中心+20~30px 落在透明区、点击落空，件却照样报通过。
//
// 前置断言（本任务真正的产品）：点击前校验落点 ∈（上报盒 ∪ 兜底盒 ∪ 内容矩形），
// 不满足抛 PreconditionError（调用方统一 exit 3 并打印「落点不在形象上：…」）——不许静默瞄空后报通过。
// 没有这条，换轨只是把一次巧合改成下一次会漂移的巧合。红法两向：瞄点退回几何中心必须 exit 3；
// 正常跑通时与 probe-click-target 对账落点归属。
//
// 兜底盒/内容矩形不经手抄，也不在文本里抽函数体：真源是 core/geometry.js（票 12-A 搬内容/视觉两族
// 与 pointInBoxes，票 0a-3 搬 petFallbackBox / boxesArea / graceEndsOnReport / graceJudgeBoxes），
// 本件直接 require 真函数——产品改公式这里自动跟随，而「main.js 加一个顶层变量就把本件搞红」
// 那一类脆弱（PITFALLS 记过同型事故）从此不再存在。require 失败/导出缺项 = 前置不满足（exit 3）。
const fs = require('fs');
const path = require('path');

// §96（2026-10-10 票）：require cache 按解析路径字符串大小写分副本——CDP 表达式里 require 配置模块
// 必须用绝对路径，且大小写与产品解析一致，否则写/读落在第二个副本上（petScale 读错 ⇒ 瞄点错，
// 下游判据件带着错瞄点自洽假绿，是最毒的通道）。只能 realpathSync.native（普通 realpath 不规范
// 化盘符大小写，等于没修）；native 失败的兜底必须显式（盘符大写 + 明打），不许静默用原始路径。
const ROOT = (() => {
  const r = path.resolve(__dirname, '..');
  try { return fs.realpathSync.native(r); } catch (e) {
    const fb = r.replace(/^([a-zA-Z]):/, (d) => d.toUpperCase()); // 回调收到的是全匹配（含冒号），不能再加 ':'
    console.error(`⚠ lib-aim: realpathSync.native 失败（${e.message}）——已显式退回「盘符大写」兜底：${fb}`);
    return fb;
  }
})();
const CFG_REQ = `process.mainModule.require(${JSON.stringify(path.join(ROOT, 'config.js'))})`;

class PreconditionError extends Error {}

// 矩形派生公式与兜底盒的真源都是 core/geometry.js（票 12-A 搬内容/视觉两族，票 0a-3 搬兜底盒与宽限
// 判定）：本件全走 require 真函数，**不再抽 main.js 函数体进 vm**——这是全仓最脆的一层里第一个
// 彻底脱离文本抽取的共用库。scale 钳制在本地用 core 的上下限常量实现，保持与 main.js petScale()
// 同语义（config 读取仍留给调用方——scale 值经主进程 CDP 读回）。
function loadRectMath(repoRoot) {
  const geoPath = path.join(repoRoot, 'core', 'geometry.js');
  let geo;
  try {
    geo = require(geoPath);
  } catch (e) {
    throw new PreconditionError(`require('${geoPath}') 失败（${(e && e.message) || e}）——core/geometry.js 是几何公式真源`);
  }
  // 正向对照：导出必须齐（改名/删函数在这里点名，不许 require 到半个对象照样跑）
  const NEED = ['PET_SIZE', 'PET_SCALE_MIN', 'PET_SCALE_MAX', 'PET_WINDOW_SIZE', 'PET_CONTENT_HEIGHT',
    'visualSize', 'petVisualOffset', 'contentSize', 'petContentOffset', 'petContentRect', 'petFallbackBox'];
  const missing = NEED.filter((k) => geo[k] === undefined);
  if (missing.length) throw new PreconditionError(`core/geometry.js 导出缺 ${missing.join('/')}（改名或删除要同步本件）`);
  const clampPetScale = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(geo.PET_SCALE_MAX, Math.max(geo.PET_SCALE_MIN, n)) : 1;
  };
  return Object.assign({}, geo, { clampPetScale });
}

// 主进程侧一次读全：窗口 bounds + 可见性 + petScale 配置值（找不到窗 = 前置不满足）
const PET_INFO_EXPR = `
  (() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    if (!w) return JSON.stringify({ error: 'pet-window-not-found' });
    const b = w.getBounds();
    const scaleCfg = ${CFG_REQ}.get('petScale');
    return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, visible: w.isVisible(), scaleCfg });
  })()`;

// 渲染端上报盒（窗口内坐标，过滤零面积；拖拽/玻璃期间是整窗单盒，同为合法上报）
const BOXES_EXPR = `(() => { const b = interactiveBox(); const arr = Array.isArray(b) ? b : b ? [b] : []; return JSON.stringify(arr.filter((r) => r && r.width > 0 && r.height > 0)); })()`;

async function readReportBoxes(renderer) {
  let raw;
  try {
    raw = JSON.parse(await renderer(BOXES_EXPR));
  } catch (e) {
    throw new PreconditionError('渲染端上报盒读不到（' + (e && e.message) + '）');
  }
  if (!Array.isArray(raw) || !raw.length) {
    throw new PreconditionError('渲染端上报盒读不到（interactiveBox 为空）——页面未就绪或没有可见交互元素');
  }
  return raw;
}

// 组装瞄点上下文（不判前置）：窗口 bounds + scale（主进程）+ 上报盒（渲染端，每步重取）
// + 兜底盒/内容矩形（源码公式）。aim = 最大盒（脸）中心 + 窗口原点，屏幕坐标。
async function computeAim({ mainProc, renderer, rectMath, label = '' }) {
  let info;
  try {
    info = JSON.parse(await mainProc(PET_INFO_EXPR));
  } catch (e) {
    throw new PreconditionError('主进程调试通道读不到窗口（' + (e && e.message) + '）');
  }
  if (info.error === 'pet-window-not-found') throw new PreconditionError('主进程里找不到 pet.html 窗口');
  const boxes = await readReportBoxes(renderer);
  const face = boxes.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const scale = rectMath.clampPetScale(info.scaleCfg);
  const aim = {
    x: Math.round(info.x + face.x + face.width / 2),
    y: Math.round(info.y + face.y + face.height / 2),
  };
  return {
    label,
    aim,
    info,
    scale,
    boxes, // 窗口内坐标（原样上报）
    face, // 最大盒（脸）——窗口内坐标，调用方日志用
    fallback: rectMath.petFallbackBox(scale), // 窗口内坐标
    content: rectMath.petContentRect({ x: info.x, y: info.y }, scale), // 屏幕坐标
  };
}

// 盒边界不含（严格内）：合法瞄点取的是盒中心、永远在内部；边界命中只会是几何中心这类巧合点。
// 预防性说明：600×600 窗的几何中心 (300, y) 恰落在兜底盒左缘（视觉 300×300 右下对齐 → off.x=300），
// 含边界会把「瞄点退回几何中心」的红法放成绿灯，所以必须严格内。
function pointInRect(p, r) {
  return p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
}

// 前置断言：落点 ∈（上报盒 ∪ 兜底盒 ∪ 内容矩形）（统一屏幕坐标后判定）。
// 不满足抛 PreconditionError，消息以「落点不在形象上」开头并附全部矩形（可对账）。
function assertPointOnPet(ctx) {
  const p = ctx.aim;
  const reportS = ctx.boxes.map((r) => ({ x: ctx.info.x + r.x, y: ctx.info.y + r.y, width: r.width, height: r.height }));
  const fallbackS = {
    x: ctx.info.x + ctx.fallback.x,
    y: ctx.info.y + ctx.fallback.y,
    width: ctx.fallback.width,
    height: ctx.fallback.height,
  };
  const hit =
    reportS.some((r) => pointInRect(p, r)) || pointInRect(p, fallbackS) || pointInRect(p, ctx.content);
  if (!hit) {
    throw new PreconditionError(
      `落点不在形象上：aim=${p.x},${p.y} 窗口=${ctx.info.x},${ctx.info.y} scale=${ctx.scale} ` +
        `上报盒=${JSON.stringify(reportS)} 兜底盒=${JSON.stringify(fallbackS)} 内容矩形=${JSON.stringify(ctx.content)}`
    );
  }
  return true;
}

// 瞄点 + 前置断言一步到位（三件的每个瞄点处调一次 = 每步重取）。aimAt 不返回 null：够不到
// 窗 / 读不到盒 / 落点不在形象上，一律抛 PreconditionError，由调用方统一 exit 3。
async function aimAt(opts) {
  const ctx = await computeAim(opts);
  assertPointOnPet(ctx);
  return ctx;
}

module.exports = { PreconditionError, loadRectMath, computeAim, aimAt, assertPointOnPet, pointInRect };
