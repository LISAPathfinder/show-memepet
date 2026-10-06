// 兜底可交互区派生纯逻辑回归（票 11-G 任务 3，铁律 3）：
// main.js 的 petBoxInUse() 在渲染端首次上报之前用兜底盒。1.0.55 及以前兜底盒是写死常量
// {x:40,y:140,200x155}——1.0.51 前「窗口=基准×scale」坐标系的值；1.0.52 起窗口固定 600×600、
// #pet-root 钉右下角，那个常量落在窗口的空白左上角（锁屏解锁后第一次点击可能点不中）。
// 修法 = petFallbackBox(s) 按 petVisualOffset/visualSize 从视觉矩形在窗口内的偏移派生。
//
// 本件从 main.js 源码里提取 PET_SIZE / PET_WINDOW_SIZE / visualSize / petVisualOffset /
// petFallbackBox 五段定义，在 vm 沙箱求值后断言派生语义（不复制实现——main.js 改了这里跟着变）：
//   1) 提取得到 petFallbackBox 函数（旧版 main.js 没有它 → 红，即「改前」形态）；
//   2) 兜底盒右下角必须贴住窗口右下角 (600,600)（视觉矩形右下对齐语义；旧常量右下角
//      是 (240,295) → 红）；
//   3) scale=1 时盒中心落在 [300..600] 区间（形象半区，票面指定判据；旧常量中心 ~140 → 红）；
//   4) scale=0.5 / 1 / 2 全档盒非空且完全在窗口内。
//
// 判别性自证（做过，勿信口头）：把 main.js 复制到 %TEMP% 把 petFallbackBox 函数体打回旧常量
// → 本件必须 exit 1（不在跟踪文件上原地 sed——autocrlf 会造字节假红，PITFALLS §72）；
// 对 git show HEAD:main.js 的副本（无 petFallbackBox 的旧形态）跑也必须 exit 1。
//
// 用法：node tools/verify-fallback-box.js [main.js 路径，默认仓库根 main.js]
// 退出码：0 = 断言全绿（PASS n/N）；1 = 断言不过（含提取不到 petFallbackBox）；
//         1 + 「脚本异常：」行 = 本件自身出错（与断言失败区分，票 11-G 任务 4 语义）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'main.js'));

// 从源码提取一段函数定义（锚定声明行 + 大括号配对；这几个函数体内无裸花括号/模板串，配对安全）
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
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{[^}]*\\};`));
  return m ? m[0] : null;
}

let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

try {
  const src = fs.readFileSync(mainPath, 'utf8');
  const petSize = extractConst(src, 'PET_SIZE');
  const winSize = extractConst(src, 'PET_WINDOW_SIZE');
  const visualSize = extractFn(src, 'visualSize');
  const petVisualOffset = extractFn(src, 'petVisualOffset');
  const petFallbackBox = extractFn(src, 'petFallbackBox');

  // 判据 0：main.js 里必须存在 petFallbackBox（旧常量形态没有它——改前形态在这里变红）
  check(
    'main.js 含 petFallbackBox 派生函数（兜底盒不再写死）',
    !!petFallbackBox,
    petFallbackBox ? `从 ${path.basename(mainPath)} 提取 ${petFallbackBox.length} 字节` : '提取不到 function petFallbackBox —— 兜底盒还是旧常量形状或已改名'
  );
  check(
    'main.js 不再包含写死的 PET_FALLBACK_BOX 常量',
    !/PET_FALLBACK_BOX\s*=/.test(src),
    /PET_FALLBACK_BOX\s*=/.test(src) ? '发现 PET_FALLBACK_BOX = 赋值（旧形态残留）' : '无残留'
  );

  if (petFallbackBox) {
    // 沙箱求值：提取的切片拼起来跑，返回各 scale 的派生结果（JSON 串隔离沙箱对象）
    const code = [petSize, winSize, visualSize, petVisualOffset, petFallbackBox].filter(Boolean).join('\n');
    const out = vm.runInNewContext(
      `(() => { ${code}; return JSON.stringify([0.5, 1, 2].map((s) => ({ s, box: petFallbackBox(s) }))); })()`,
      {},
      { timeout: 1000 }
    );
    const rows = JSON.parse(out);
    for (const { s, box } of rows) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const tag = `scale=${s} → 兜底盒 {x:${box.x}, y:${box.y}, ${box.width}x${box.height}}`;
      check(`${tag} 右下角贴住 (600,600)`, box.x + box.width === 600 && box.y + box.height === 600, `右下角 (${box.x + box.width},${box.y + box.height})`);
      if (s === 1) {
        check(`${tag} 盒中心落在 [300..600]（票面判据）`, cx >= 300 && cx <= 600 && cy >= 300 && cy <= 600, `中心 (${cx},${cy})`);
      }
      check(`${tag} 非空且完全在窗口内`, box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= 600 && box.y + box.height <= 600);
    }
  }
} catch (e) {
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exit(1);
}

console.log(`PASS ${total - failed}/${total}`);
process.exit(failed ? 1 : 0);
