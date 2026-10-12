// @runtime: ci —— CI 强制层判据件：兜底盒派生回归，纯 node，执行面在 run-ci.js
// 兜底可交互区派生纯逻辑回归（票 11-G 任务 3，铁律 3：真断言 + 非零退出码；票 0a-3 去 vm 化）。
//
// 背景：main.js 的 petBoxInUse() 在渲染端首次上报之前用兜底盒。1.0.55 及以前兜底盒是写死常量
// {x:40,y:140,200x155}——1.0.51 前「窗口=基准×scale」坐标系的值；1.0.52 起窗口固定 600×600、
// #pet-root 钉右下角，那个常量落在窗口的空白左上角（锁屏解锁后第一次点击可能点不中）。
// 修法 = petFallbackBox(s) 按 petVisualOffset/visualSize 从视觉矩形在窗口内的偏移派生。
//
// 本件不再抽函数体进 vm：petFallbackBox 自票 0a-3 起真源在 core/geometry.js，直接 require 真函数
// 求值（改这里的公式，本件跟着动；文本抽取那一层脆性就此消失）。断言：
//   1) 兜底盒真源在位（core/geometry.js 导出 petFallbackBox 为函数）；
//   2) 兜底盒右下角必须贴住窗口右下角 (600,600)（视觉矩形右下对齐语义；旧常量右下角是
//      (240,295) → 红）；
//   3) scale=1 时盒中心落在 [300..600] 区间（形象半区，票面指定判据；旧常量中心 ~140 → 红）；
//   4) scale=0.5 / 1 / 2 全档盒非空且完全在窗口内；
//   5) **口径交叉核对**（红线①）：兜底盒必须仍从**视觉**矩形派生——盒宽高 == visualSize(s)、
//      原点 == petVisualOffset(s)。这条不是冗余：把 petFallbackBox 改用 contentSize（内容矩形
//      300×160 @ (300,440)）时，②③④ 四条全部照过（右下角仍 (600,600)、中心仍在半区、仍在窗内），
//      没有这条就是「两套口径被偷偷合并」在兜底盒上无牙（红法 F3 实测）。
//   6) 写死常量不得复活：PET_FALLBACK_BOX = 赋值形态在 **core/geometry.js 与 main.js 两个面**
//      任一命中即红（真源已搬到 core，只扫 main.js 会漏掉新面——PITFALLS §97「特征扫描要写明
//      扫哪些文件面」）。
//
// 判别性自证（改完本件后重验，勿信口头）：往影子根的 core/geometry.js 里把 petFallbackBox 打回
// 旧常量 {x:40,y:140,width:200,height:155} → 本件必须 exit 1（②③④⑤ 一起红）；只把行尾改成 CRLF
// 或把公式写成等价形式 → 必须仍 exit 0。影子根工艺见票 12-A §8（禁原地改跟踪件，autocrlf 造字节假红）。
//
// 用法：node tools/verify-fallback-box.js [仓库根，默认本件所在仓的根]
//       （票 0a-3 起第二参数语义是**仓库根**，不再是 main.js 路径——本件已不读 main.js 的函数体）
// 退出码：0 = 断言全绿（末尾 PASS n/N）；1 = 断言不过；3 = 前置不满足（core/geometry.js 读不到
//         或没导出 petFallbackBox）；1 + 「脚本异常：」行 = 本件自身出错（与断言失败区分）。
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const geoPath = path.join(root, 'core', 'geometry.js');
if (!fs.existsSync(geoPath)) {
  console.error(`前置不满足（exit 3）：core/geometry.js 不存在于 ${geoPath}——兜底盒真源`);
  process.exit(3);
}
let geo;
try {
  geo = require(geoPath);
} catch (e) {
  console.error(`前置不满足（exit 3）：require('${geoPath}') 失败（${(e && e.message) || e}）`);
  process.exit(3);
}

let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

try {
  check('core/geometry.js 导出 petFallbackBox（兜底盒不再写死在 main.js）',
    typeof geo.petFallbackBox === 'function',
    typeof geo.petFallbackBox);
  check('core/geometry.js 同时导出 visualSize / petVisualOffset（口径交叉核对要用）',
    typeof geo.visualSize === 'function' && typeof geo.petVisualOffset === 'function',
    `visualSize=${typeof geo.visualSize}, petVisualOffset=${typeof geo.petVisualOffset}`);

  // 特征扫描的两面（§97）：真源文件与旧的 main.js 都要扫——只扫一面就是半张网
  const scanFaces = [geoPath, path.join(root, 'main.js')].filter((p) => fs.existsSync(p));
  const faceText = scanFaces.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  check('写死常量形态没有复活（PET_FALLBACK_BOX = 赋值，扫 core/geometry.js + main.js 两面）',
    !/PET_FALLBACK_BOX\s*=/.test(faceText),
    `扫描面=${scanFaces.map((p) => path.basename(p)).join('+')}`);

  for (const s of [0.5, 1, 2]) {
    const box = geo.petFallbackBox(s);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const tag = `scale=${s} → 兜底盒 {x:${box.x}, y:${box.y}, ${box.width}x${box.height}}`;
    check(`${tag} 右下角贴住 (600,600)`, box.x + box.width === 600 && box.y + box.height === 600,
      `右下角 (${box.x + box.width},${box.y + box.height})`);
    if (s === 1) {
      check(`${tag} 盒中心落在 [300..600]（票面判据）`, cx >= 300 && cx <= 600 && cy >= 300 && cy <= 600,
        `中心 (${cx},${cy})`);
    }
    check(`${tag} 非空且完全在窗口内`,
      box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 &&
      box.x + box.width <= 600 && box.y + box.height <= 600);
    // ⑤ 口径交叉核对：兜底盒 = 视觉矩形在窗口内的偏移（不是内容矩形、也不是写死常量）
    const vis = geo.visualSize(s);
    const off = geo.petVisualOffset(s);
    check(`${tag} 仍从视觉矩形派生（宽高==visualSize、原点==petVisualOffset）`,
      box.width === vis.width && box.height === vis.height && box.x === off && box.y === off,
      `visual=${vis.width}x${vis.height}, off=${off}`);
  }
} catch (e) {
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exit(1);
}

console.log(`PASS ${total - failed}/${total}`);
process.exit(failed ? 1 : 0);
