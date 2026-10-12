// @runtime: ci —— CI 强制层判据件：命中区判据 vm 回归，纯 node，执行面在 run-ci.js
// 「被吞点击」判据件（票 11-J 任务 1，2026-10-05；纯 node 零依赖，进 CI）
//
// 要防的故障：桌宠把本该给桌面的点击吃掉——透明空隙与元素外侧的余量环都算「可交互」，
// 点在其上表现为「什么都没发生」（用户现场：同一位置连点 10 次全被 pet-root 吞，
// 全天 27 次盒外被吞；吞点击面积达元素真实面积的 2.0 倍）。
//
// 本件不复制实现：从 renderer/pet.js 提取 interactiveBox()（可交互区真源），BOX_PAD 自票 0a-2 起
// require core/interactive-box.js 取数值（改前根无 core/ 时回退从 pet.js 提取），命中判定
// require core/geometry.js 的 pointInBoxes（票 12-A 起为真源；被测根无 core/ 时回退从 main.js
// 提取，1.0.59 前是 syncPetPassThrough 里的内联 inside 段），JITTER_PAD 仍从 main.js 提取，在桩
// DOM 上喂现场 3 的真实元素矩形（隔离实例 scale=1 空闲态离线实测），断言：
//   ① 各元素本体上的点判「区内」；
//   ② 两个元素之间的透明空隙点判「区外」（改前语义在这里红——判别性所在）；
//   ③ 上报盒外 ≥17px 的点判「区外」；
//   ④ 正向对照：#pet-face 本体必须判「区内」（防「为了放行把桌宠也点不中了」）；
//   ⑤ 量化红线：吞点击区域（上报盒再套主进程余量后的并集）÷ 元素真实面积 ≤ 1.2。
//   ⑥ JITTER_PAD 边界点对（票 12-A 补）：距脸盒右缘「恰好 =JITTER_PAD」与「+1px」两点，一内一外，
//      钉住命中判定的余量维度（原夹具在 pad 上无点：`+ pad` 改成 `+ pad * 2` 新旧两版件同绿）。
//
// 判别性自证（票面验收 ★a）：对 `git show 6df494f:…` 的改前副本（renderer/pet.js + main.js
// 按同布局放进一个目录后把该目录当 argv[2] 传入）→ 必须 exit 1（② 与 ⑤ 都过不了旧语义）；
// 对当前源码 → exit 0。
//
// 用法：node tools/verify-hit-region.js [仓库根]
// 退出码：0 = 断言全绿（末尾 PASS n/N）；1 = 断言不过或提取失败；脚本自身异常落 1 且
//         stderr 打「脚本异常：<原因>」与断言失败区分（铁律 3）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const petPath = path.join(root, 'renderer', 'pet.js');
const mainPath = path.join(root, 'main.js');

// ---- 现场 3 的真实元素矩形（2026-10-04 离线实测：隔离实例 scale=1、空闲态）----
// 这是判据夹具，不许改成"看起来更合理"的数——判别力来自它是真机读数。
// 另附三个 rect 为 0 的隐藏元素（bubble/zzz/scale-handle），顺带考实现「隐藏元素不计入」的路径。
const ELEMENTS = [
  { id: 'pet-face', x: 395, y: 454, width: 110, height: 110 },
  { id: 'admin-lamp', x: 379, y: 575, width: 12, height: 12 },
  { id: 'counter', x: 399, y: 571, width: 89, height: 21 },
  { id: 'menu-gear', x: 495, y: 568, width: 26, height: 26 },
];
const HIDDEN = [
  { id: 'bubble', x: 0, y: 0, width: 0, height: 0 },
  { id: 'zzz', x: 0, y: 0, width: 0, height: 0 },
  { id: 'scale-handle', x: 0, y: 0, width: 0, height: 0 },
];
const ELEMENT_AREA = ELEMENTS.reduce((s, r) => s + r.width * r.height, 0); // 四元素两两不重叠，和=并集

// 空隙点：都在改前「并集包围盒 (379,454 142x140)」之内、但距任何元素本体 >10px——
// 改前语义（包围盒 ∪ 16px 环）把它们判成可交互 = 11-J 的被吞点击；改后必须放行。
const GAP_POINTS = [
  { x: 385, y: 500, why: '脸左侧空隙（旧并集内、距脸左缘 10px）' },
  { x: 515, y: 556, why: '脸右下/齿轮上方空隙' },
  { x: 383, y: 545, why: 'lamp 上方空隙' },
];
// 上报盒外 ≥17px 的远点（窗口左上透明区）：改前改后都必须放行（正向护栏，防过紧）
const FAR_POINT = { x: 200, y: 300, minDist: 17 };
// 元素本体点（中心）：改前改后都必须命中（① 与 ④）
const BODY_POINTS = ELEMENTS.map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2, id: r.id }));
const FACE_POINT = BODY_POINTS[0];

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  return null;
}
function extractNumberConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = ([0-9.]+);`));
  return m ? Number(m[1]) : null;
}

let total = 0;
let failed = 0;
function check(name, ok, detail) {
  total++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

// 矩形并集面积：坐标压缩 + 网格中心采样（矩形 ≤8 个，O(n³) 无所谓）
function unionArea(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.width]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.height]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (rects.some((r) => cx > r.x && cx < r.x + r.width && cy > r.y && cy < r.y + r.height)) {
        area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      }
    }
  }
  return area;
}
const expand = (r, pad) => ({ x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 });
const bboxOf = (rects) => {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};
const distOut = (p, rects) => {
  // 点到任一矩形外部的距离（在矩形内为 0/负）
  let d = Infinity;
  for (const r of rects) {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
    d = Math.min(d, Math.hypot(dx, dy));
  }
  return d;
};

try {
  console.log(`被测源码：${petPath}\n          ${mainPath}\n`);
  const petSrc = fs.readFileSync(petPath, 'utf8');
  const mainSrc = fs.readFileSync(mainPath, 'utf8');

  // ---- 提取（正向对照：缺任一段就红，防「读不到打绿灯」）----
  // BOX_PAD 真源自票 0a-2 起在 core/interactive-box.js（require 数值），改前根没有 core/ 时
  // 回退从 pet.js 提取——interactiveBox 的桩求值仍需要一个 BOX_PAD 绑定，两条路都给齐。
  const boxCorePath = path.join(root, 'core', 'interactive-box.js');
  const boxCore = fs.existsSync(boxCorePath) ? require(boxCorePath) : null;
  const boxPad = boxCore ? boxCore.BOX_PAD : extractNumberConst(petSrc, 'BOX_PAD');
  const boxFn = extractFn(petSrc, 'interactiveBox');
  check(
    '提取到 interactiveBox() 与 BOX_PAD（可交互区真源在位，BOX_PAD 取自' + (boxCore ? 'core/interactive-box.js' : 'pet.js（改前根）') + '）',
    !!boxFn && boxPad !== null && boxPad !== undefined,
    `BOX_PAD=${boxPad}`
  );

  // 命中判定：真源是 core/geometry.js 的具名 pointInBoxes（票 12-A 从 main.js 搬出），直接
  // require 真函数；被测根没有 core/（改前副本自证，见文件头 ★a）时回退按旧形态提取——
  // 优先 main.js 具名 pointInBoxes，再回退 syncPetPassThrough 的内联段（6df494f 及更早形态）。
  const geoPath = path.join(root, 'core', 'geometry.js');
  const geo = fs.existsSync(geoPath) ? require(geoPath) : null;
  if (geo && typeof geo.pointInBoxes !== 'function') {
    throw new Error(`core/geometry.js 导出的 pointInBoxes 不是函数（真源改名或签名变了）`);
  }
  const named = geo ? '__from_core__' : extractFn(mainSrc, 'pointInBoxes');
  const namedPad = named ? extractNumberConst(mainSrc, 'JITTER_PAD') : null;
  const inlineM = !named ? mainSrc.match(/const JITTER_PAD = (\d+);[\s\S]{0,200}?const inside =([\s\S]*?);/) : null;
  check(
    '提取到命中判定段（core/geometry.js 的 pointInBoxes，改前根回退 main.js 具名/内联段）+ JITTER_PAD',
    !!named ? namedPad !== null : !!inlineM,
    named ? `${geo ? 'core/geometry.js require' : 'main.js 具名 pointInBoxes'}，JITTER_PAD=${namedPad}` : inlineM ? `内联段，JITTER_PAD=${inlineM[1]}` : '两式都没提不到'
  );

  const jitterPad = named ? namedPad : inlineM ? Number(inlineM[1]) : null;
  let hitTest = null;
  if (named && namedPad !== null) {
    hitTest = geo
      ? (rects, x, y) => geo.pointInBoxes(rects, x, y, namedPad)
      : new Function('rects', 'x', 'y', `${named}\nreturn pointInBoxes(rects, x, y, ${namedPad});`);
  } else if (inlineM) {
    // 旧 main 消费的是「单一包围盒」：数组先并成包围盒再进旧表达式（这正是被考的旧语义）
    const expr = inlineM[2];
    hitTest = (rects, x, y) => new Function('box', 'x', 'y', `const JITTER_PAD = ${inlineM[1]}; return (${expr});`)(bboxOf(rects), x, y);
  }

  // ---- 跑渲染端真源（桩 DOM：现场 3 矩形 + 三个隐藏元素）----
  // interactiveBox 的函数体引用两个模块级常量：BOX_PAD（数值真源 core/interactive-box.js，本件取
  // require 到的值注入；改前根回退源码提取）与 INTERACTIVE_SELECTOR（桩 querySelectorAll 不看选择器，
  // 提取不到说明实现改形，判据该红）
  let reported = null;
  if (boxFn && boxPad !== null) {
    const sel = (petSrc.match(/const INTERACTIVE_SELECTOR = '([^']*)';/) || [])[1];
    check('renderer/pet.js 提取到 INTERACTIVE_SELECTOR', typeof sel === 'string', `selector=${sel}`);
    const sandbox = {
      document: {
        querySelectorAll: () =>
          [...ELEMENTS, ...HIDDEN].map((el) => ({
            id: el.id,
            getBoundingClientRect: () => ({
              left: el.x,
              top: el.y,
              right: el.x + el.width,
              bottom: el.y + el.height,
              width: el.width,
              height: el.height,
            }),
          })),
      },
      window: { innerWidth: 600, innerHeight: 600 },
      drag: { active: false },
      glass: { on: false },
    };
    vm.createContext(sandbox);
    vm.runInContext(`const BOX_PAD = ${boxPad};\nconst INTERACTIVE_SELECTOR = ${JSON.stringify(sel)};\n${boxFn}`, sandbox);
    reported = vm.runInContext('interactiveBox()', sandbox);
  }
  const asRects = (b) => (Array.isArray(b) ? b.filter((r) => r && r.width > 0 && r.height > 0) : b && b.width > 0 && b.height > 0 ? [b] : []);
  const rects = asRects(reported);
  check(
    '渲染端上报非空且形状合法（单盒或数组，正宽高；隐藏元素已被实现自身滤掉）',
    rects.length > 0,
    `上报=${JSON.stringify(reported)}`
  );

  if (hitTest && rects.length) {
    // ---- 吞点击面积（上报盒再套主进程 JITTER_PAD 后的并集）÷ 元素真实面积 ----
    const swallowed = rects.map((r) => expand(r, jitterPad));
    const ratio = unionArea(swallowed) / ELEMENT_AREA;
    console.log(
      `  · 实测：BOX_PAD=${boxPad}（渲染端）+ JITTER_PAD=${jitterPad}（主进程）；吞点击区域 ${unionArea(swallowed)}px² ÷ 元素真实面积 ${ELEMENT_AREA}px² = ${ratio.toFixed(3)}×`
    );
    console.log(`  · 上报盒（吞点击前）：${rects.map((r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`).join(' | ')}`);

    // ① 元素本体上的点判「区内」
    const bodyMiss = BODY_POINTS.filter((p) => !hitTest(rects, p.x, p.y));
    check('① 各元素本体中心判「区内」', bodyMiss.length === 0, bodyMiss.length ? `漏了 ${bodyMiss.map((p) => p.id).join('/')}` : '4/4');

    // ④ 正向对照：脸本体必须判「区内」（防「为了放行把桌宠也点不中了」）
    check('④ 正向对照：#pet-face 本体判「区内」', hitTest(rects, FACE_POINT.x, FACE_POINT.y), `点 ${FACE_POINT.x},${FACE_POINT.y}`);

    // ② 元素之间的透明空隙点判「区外」——改前语义在这里红（判别性所在）
    const gapLeak = GAP_POINTS.filter((p) => hitTest(rects, p.x, p.y));
    check(
      '② 元素之间的透明空隙点判「区外」',
      gapLeak.length === 0,
      gapLeak.length ? `${gapLeak.length}/3 被吞：${gapLeak.map((p) => `${p.x},${p.y}（${p.why}）`).join('；')}` : '3/3 放行'
    );

    // ③ 上报盒外 ≥17px 的点判「区外」（先核点确实离上报盒足够远，防夹具自身漂移）
    const farDist = distOut(FAR_POINT, rects);
    check('③ 夹具远点确实在上报盒外 ≥17px（前置）', farDist >= FAR_POINT.minDist, `距离=${farDist}px`);
    check('③ 上报盒外 ≥17px 的点判「区外」', farDist < FAR_POINT.minDist || !hitTest(rects, FAR_POINT.x, FAR_POINT.y), `点 ${FAR_POINT.x},${FAR_POINT.y}`);

    // ⑤ 量化红线：吞点击区域 ≤ 元素真实面积的 1.2 倍（票 11-J 任务 3 目标；改前 2.02×）
    check('⑤ 吞点击面积 ÷ 元素真实面积 ≤ 1.2', ratio <= 1.2, `实测 ${ratio.toFixed(3)}×`);

    // ⑥ JITTER_PAD 边界点对（票 12-A 补）：把 pointInBoxes 的余量维度钉住。红法 R1 实测原夹具
    //   在 pad 上无点——`+ pad` 改成 `+ pad * 2` 后新旧两版件逐字节同绿（对照组读数一致），
    //   因为 ①②③④ 用的点距元素都 ≥1px 或 ≤ 本体中心，放大余量看不出来。
    //   两点按 jitterPad 取值（不按字面量 1/2），产品有意调 JITTER_PAD 时跟着平移、不误伤；
    //   而实现里把 pad 悄悄加大/缩小（本刀的突变形态）必红其中一侧。
    const faceR = rects[0]; // 桩里 rects 顺序 == ELEMENTS 顺序，[0] 是脸
    const padIn = { x: faceR.x + faceR.width + jitterPad, y: faceR.y + faceR.height / 2 };
    const padOut = { x: faceR.x + faceR.width + jitterPad + 1, y: faceR.y + faceR.height / 2 };
    check(
      `⑥ 右缘外 ${jitterPad}px（== JITTER_PAD）判「区内」（余量下界不被缩小）`,
      hitTest(rects, padIn.x, padIn.y),
      `点 ${padIn.x},${padIn.y}`
    );
    check(
      `⑥ 右缘外 ${jitterPad + 1}px（> JITTER_PAD）判「区外」（余量不被放大）`,
      !hitTest(rects, padOut.x, padOut.y),
      `点 ${padOut.x},${padOut.y}`
    );
  } else {
    check('命中判定与上报任缺其一，无法继续断言', false, '提取失败见上');
  }

  console.log(`\nPASS ${total - failed}/${total}`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exit(1);
}
