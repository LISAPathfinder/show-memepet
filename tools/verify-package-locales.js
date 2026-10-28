// @runtime: artifact —— 校验出包产物的 locales 集合（win-unpacked），出包后、安装前必跑；
//   不进 CI 强制层：Actions/纯逻辑环境里没有 win-unpacked，硬跑只会「前置不满足」——
//   同 verify-release-chain 选 artifact 的理由（票 14-T；票面曾写 @runtime: ci，但「声明 ci 就必须
//   真在 ci.yml 里」是双向闸门，而 ci.yml 环境永远没有构建产物，两者结构性冲突——按可成立的一侧
//   落 artifact，出入包链，见票面执行记录）。
//
// locales 白名单判据（票 14-T）：断言产物 `win-unpacked/locales/*.pak` 的集合 == 声明的白名单。
// 为什么判产物不判配置：`build.electronLanguages` 拼写错或层级写错（如放进 build.nsis——那里
//   不是合法位置）时，electron-builder **构建照样成功、locales 一个不少**，是典型的静默假阴性；
//   「配置里有这个键」这类断言拦不住任何一种写法错误（红法 T-a/T-b/T-c，读数见票面）。
// 三锚点棘轮（verify-koffi-contract 同款纪律，§91 同族）：白名单改值/改形态必须同时动
//   package.json 的声明与本件 PINNED——只改声明时「声明↔产物」两两比对恒绿（同源恒真），
//   第三锚点才红。改白名单是有意决策，须连票 14-T 一起改。
//
// 退出码优先级：断言红 > 前置缺——先红的断言不许被后到的「产物不在」掩码成 3
//   （铁律 3 同族：把失败读成环境问题，全绿照旧的假象就是这么造出来的）。
//   0 全绿 / 1 有断言红（含脚本异常，stderr 打「脚本异常：」）/ 3 前置不满足（配置或产物读不到且无红）。
//
// 用法：
//   node tools/verify-package-locales.js                                出包链标准跑法（默认路径）
//   node tools/verify-package-locales.js <win-unpacked 或 locales 目录> [仓库根]
//   两个参数供 %TEMP% 影子根红法（不碰工作树，§72；影子根一律绝对路径——§96 同族教训）。
//   locales 目录只按目录名 `locales` 认（win-unpacked 根下另有 chrome_*.pak/resources.pak，
//   按「含 .pak 就当 locales」猜必然认错对象）。
const fs = require('fs');
const path = require('path');
const { BUILD_DIR_NAME } = require('../identity');

// 白名单钉死值（票 14-T 定稿）：zh-CN = 产品语言；en-US = 兜底（未预期回退落在英文而不是「文件不存在」）。
const PINNED = ['zh-CN', 'en-US'];

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.resolve(process.argv[3] || REPO_ROOT);

const problems = [];
let preconditionsMissing = 0;
function fail(msg) {
  problems.push(msg);
  console.error(`[FAIL] ${msg}`);
}
function precondition(msg) {
  preconditionsMissing += 1;
  console.error(`前置不满足：${msg}`);
}

function main() {
  // ① 配置面：package.json 可解析（读不到=前置；后面没有可判对象了，直接走收尾）
  const pkgPath = path.join(SRC_ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    precondition(`${pkgPath} 不存在——影子根/仓库根传错？`);
    return finish(null);
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    precondition(`package.json 不是合法 JSON：${e.message}`);
    return finish(null);
  }

  const declaredRaw = pkg.build ? pkg.build.electronLanguages : undefined;
  const misplaced = pkg.build && pkg.build.nsis && pkg.build.nsis.electronLanguages;
  const declaredValid = Array.isArray(declaredRaw) &&
    declaredRaw.length > 0 && declaredRaw.every((x) => typeof x === 'string');

  // ② 白名单必须在 build 顶层、且是「非空字符串数组」形态（钉形态；单串/其他写法=红，
  //    改形态属有意决策须连本件一起改）。层级写错（build.nsis 下）是最容易犯的位置错（票 14-T T-c）。
  if (declaredValid) {
    console.log(`[ok] build.electronLanguages 在 build 顶层声明为字符串数组：[${declaredRaw.join(', ')}]`);
  } else {
    fail(`build.electronLanguages 未在 build 顶层声明为非空字符串数组（实读 ${JSON.stringify(declaredRaw)}）` +
      (misplaced ? `；检测到它被放进了 build.nsis 下（${JSON.stringify(misplaced)}）——electron-builder 只认 build 顶层，nsis 段不是合法位置（本机 26.15.3 配置校验会直接拦，读数见票 14-T T-c）` : ''));
  }

  // ③ 第三锚点：声明值必须等于钉死值。只改声明不改本件时，「声明↔产物」比对恒绿，这条才拦得住。
  const declared = declaredValid ? [...declaredRaw].sort() : null;
  const pinnedSorted = [...PINNED].sort();
  if (declared && JSON.stringify(declared) === JSON.stringify(pinnedSorted)) {
    console.log(`[ok] 声明白名单 == 钉死值 [${PINNED.join(', ')}]`);
  } else {
    fail(`白名单漂移：现声明 ${declared ? `[${declared.join(', ')}]` : '（无法解析）'} ≠ 钉死值 [${pinnedSorted.join(', ')}]——` +
      '改白名单必须连本件 PINNED 与票 14-T 一起改（三锚点棘轮）');
  }
  if (misplaced && declaredValid) {
    fail('build.nsis 下出现多余的 electronLanguages 副本——两处并存时真源不明，删掉 nsis 段里那份');
  }

  // ④ 产物面：locales 目录定位（参数可传 win-unpacked 或它的 locales 子目录）
  let localesDir = path.resolve(process.argv[2] || path.join(REPO_ROOT, '..', BUILD_DIR_NAME, 'release', 'win-unpacked'));
  if (path.basename(localesDir) !== 'locales') localesDir = path.join(localesDir, 'locales');
  if (!fs.existsSync(localesDir)) {
    precondition(`产物 locales 目录不存在：${localesDir}——先出包（ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist），或把 win-unpacked/locales 目录当第一个参数传入`);
    return finish(null);
  }

  // ⑤ 集合断言：产物 *.pak 集合 == 声明白名单（多一个少一个都红）。
  //    白名单声明不可用时红已记在 ②③，产物侧没有可比对象，明打跳过原因继续收尾（不许静默）。
  const entries = fs.readdirSync(localesDir);
  const pakFiles = entries.filter((f) => f.endsWith('.pak'));
  const actual = new Set(pakFiles);

  if (pakFiles.length > 0) {
    console.log(`[ok] 产物 locales 共 ${pakFiles.length} 个 .pak（目录共 ${entries.length} 项）`);
  } else {
    fail(`产物 locales 目录没有任何 .pak：${localesDir}（共 ${entries.length} 项）——产物异常`);
  }

  if (declaredValid) {
    const expected = new Set(declaredRaw.map((x) => `${x}.pak`));
    const extras = [...actual].filter((f) => !expected.has(f)).sort();
    const missing = [...expected].filter((f) => !actual.has(f)).sort();
    if (expected.size > 0 && extras.length === 0 && missing.length === 0) {
      let total = 0;
      for (const f of pakFiles) total += fs.statSync(path.join(localesDir, f)).size;
      console.log(`[ok] 产物集合 == 白名单：${[...actual].sort().join(' + ')}（合计 ${total} B）`);
    } else {
      if (extras.length) fail(`产物多出白名单外的语言包 ${extras.length} 个：${extras.join('、')}`);
      if (missing.length) fail(`白名单声明的语言包在产物里缺失 ${missing.length} 个：${missing.join('、')}` +
        '——白名单没被产物兑现（值拼错时构建静默放过：T-b 实测不存在的 locale 无声缺席，且白名单整体替换默认集合、未声明的 en-US 一并被顶掉，见票 14-T）');
    }
  } else {
    console.log('[skip] 白名单声明不可用，产物集合比对无从做起（红已记在配置面断言 ②③）');
  }

  finish(localesDir);
}

function finish(localesDir) {
  const reds = problems.length;
  if (reds > 0) {
    console.error(`FAIL——locales 判据 ${reds} 处红，出包链不许放行${localesDir ? '' : '（产物/配置面有未完成项，见上文前置行）'}`);
    process.exit(1);
  }
  if (preconditionsMissing > 0) {
    console.error('PASS 0/5——前置不满足不算通过（rc=3）');
    process.exit(3);
  }
  console.log('PASS 5/5');
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(`脚本异常：${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  process.exit(1);
}
