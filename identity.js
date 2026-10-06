'use strict';
const path = require('node:path');
// 产品名的单一真源（票 11-A）。
// 此前「名字」散落 main.js / renderer / tools 共 32+ 处字面量：改名改一半时，
// 诊断脚本读不到新日志名会让「零候选零重申」这类断言因读不到任何行而判通过（假绿）。
// 收敛规则：运行期与工具一律 require 本文件取常量，不写字面量；package.json 是 JSON
// 引用不了 JS，由 tools/verify-identity.js 做逐项比对兜底（漏改一处 = CI 必红）。
// 纯 node、零第三方依赖：main 进程与 tools/ 诊断脚本共用（铁律 5）。
// 票 11-B（2026-10-04）已切值：desktop-pet → showcase/Showcase，旧名曾进各双认/回落名单。
// 票 11-Q（2026-10-06）退休迁移期兼容层五件：①EXE_BASENAMES 旧 exe 名、③安装器旧名 taskkill、
// ④自启旧值名清理、⑤LEGACY_APP_ID、⑥DESKTOP_PET_DATA_DIR 回落（公开面 orphan 首发、外部无 1.0.x
// 用户，凭据=probe-compat-layer-state 读数，见 findings 票 11-Q 执行记录）；②旧日志名回落留到
// v1.1.x（本机旧日志仍被诊断件回看）；LEGACY_SLUG（数据根目录名解析）不在六件清单、继续保留。

// npm name / 路径用名（全小写；对应 package.json name）
const APP_SLUG = 'showcase';
// 显示名：exe 名 / 卸载列表 / 快捷方式名（对应 build.productName，决定映像名）。
// 只有它用大写；产物名/日志名/构建目录全小写（verify-identity 钉死由 APP_SLUG 派生）
const PRODUCT_NAME = 'Showcase';
// 按映像名认进程的候选（大小写不敏感）。票 11-Q（2026-10-06）起只认当前产品名：
// 迁移期旧名双认（desktop-pet.exe）已撤——探针实测旧名进程 0 个、容器 bin 内无旧 exe，
// 公开面 orphan 首发后不存在仍以旧名运行的 1.0.x 用户。
// 反向验收（票 11-Q §六）：仍以 desktop-pet.exe 运行的实例不再被认作桌宠——
// 占用自检（lib-occupancy）与进程探针不会再拦/认它；装机升级遇旧名进程残留则由用户手工处理。
const EXE_BASENAMES = ['Showcase.exe'];
// dev 模式 electron.exe 的识别主干（isAppImage 的 electron.exe 分支用）：锚「本仓检出目录名」，
// 由 __dirname 运行时派生、不写字面量——目录改名后自动跟随。票 11-Q 之前这个分支搭
// EXE_BASENAMES 双认的车（路径含 desktop-pet / showcase 主干即认）；旧映像名退休后改挂
// 检出位置这个真锚，另加 APP_SLUG 覆盖「检出目录已随产品改名」的未来形态。
// 两个主干都命不中的 electron.exe 一律不认（防别的项目的 Electron 混进进程自检）。
const DEV_PATH_STEMS = [path.basename(__dirname).toLowerCase(), APP_SLUG];
// 当前写用日志名（main.js 落盘用；tools 读取请用 LOG_CANDIDATES）
const LOG_NAME = 'showcase.log';
// 提权重启的 %TEMP% 日志名（main.js relaunchAsAdmin）
const ADMIN_LOG_NAME = 'showcase-admin.log';
// 显隐请求哨兵文件名（数据根下；1.0.71 第二实例兜底通道）。提权首实例收不到 second-instance
// （Windows 完整性策略 no-write-up：Medium 进程写不进 High 进程持有的单实例锁对象），
// 普通第二实例抢锁失败退出前写它，首实例 fs.watch 到后补走 showPet。
const SHOW_REQUEST_NAME = 'show-request.json';
// 迁移期读取回落名：LOG_CANDIDATES 之外的候选。11-B 改名后实机旧版还在写旧名，
// 「写新读旧」保证过渡期诊断脚本读得到旧日志（票 11-A 注释的语义在改名后翻转）。
// 票 11-Q（2026-10-06）**留置**（六件里唯一没撤的）：本机数据根还躺着 1.7MB 旧日志，
// measure-swallow-clicks 等件回看历史段仍靠它；撤的条件＝旧日志归档到仓库外或 v1.1.x（先到者）。
const LOG_FALLBACK_NAMES = ['desktop-pet.log'];
// 构建产物输出目录名（仓外；对应 build.directories.output = ../<BUILD_DIR_NAME>/release）
const BUILD_DIR_NAME = 'showcase-build';
// 安装身份（票 11-B 第 2b 条）：APP_ID 由 slug 派生（§1.1 候选 A 选它的理由：改名不会漏改）。
// 上一版值 LEGACY_APP_ID（com.desktoppet.app）与旧 AUMID 键清理段已随票 11-Q 退休（⑤）：
// 本机该注册表键实测已无、公开面无 1.0.x 用户；反向验收=某机器若残留旧键会一直占着通知归属，
// 只能手工删（读数：本机已无该键）。若日后 APP_ID 换成不能派生的值（findings §1.1 的 B/C 候选），
// 把 APP_ID 改成字面量并注明它不派生自 slug。
const APP_ID = 'com.' + APP_SLUG + '.app';
// 自启 Run 键值名（票 11-F 方案 B，PITFALLS §75）：钉死 = APP_ID。Electron
// setLoginItemSettings 的默认值名跟随当前 AUMID（官方文档实锤），1.0.53 设了 APP_ID 后
// 默认值名从 electron.app.<name> 漂移成 com.showcase.app、写出两条键——1.0.55 起 Run 键
// 改注册表直写，值名由本常量唯一决定，写路径与 findRunEntry 判据同源不再依赖默认值。
// 派生自 APP_ID：将来换 appId 时这里跟着换，迁移代码按旧值清理（与 LEGACY_* 同一模式）。
const RUN_VALUE_NAME = APP_ID;
// 旧产品的 npm name（= 旧 Chromium userData 目录名 %APPDATA%\<LEGACY_SLUG>，票 11-B 第 5 条
// 数据兜底用）。不在六件清单（票 11-Q 硬约束）：它锚的是用户数据定位，撤它＝动数据根解析，要单独论证。
const LEGACY_SLUG = 'desktop-pet';
// 托盘 tooltip 与渲染端 <title>：跟显示名走（派生自 PRODUCT_NAME，改名时无需单独记）。
// 未来若要显示名与 tooltip 分化，再把这里拆成独立字面量。
const TRAY_TITLE = PRODUCT_NAME;
const WINDOW_TITLE = PRODUCT_NAME;
// tools 读日志的候选序：当前写用名在前，回落名在后（按序取第一个存在的文件）。
const LOG_CANDIDATES = [LOG_NAME, ...LOG_FALLBACK_NAMES];

// 映像名或映像全路径是否属于本应用进程（大小写不敏感）。
// - 安装版：basename 命中 EXE_BASENAMES 即认（票 11-Q 起只认 Showcase.exe）；
// - dev 的 electron.exe：仅当全路径含任一 dev 识别主干（检出目录名 / showcase，见 DEV_PATH_STEMS）
//   才认——单独传入 'electron.exe' 不成立，否则别的项目的 Electron 会混进来。
function isAppImage(nameOrPath) {
  const s = String(nameOrPath || '').toLowerCase();
  if (!s) return false;
  const base = s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1);
  if (EXE_BASENAMES.some((n) => n.toLowerCase() === base)) return true;
  if (base === 'electron.exe') {
    return DEV_PATH_STEMS.some((n) => s.includes(n));
  }
  return false;
}

module.exports = {
  APP_SLUG,
  PRODUCT_NAME,
  APP_ID,
  RUN_VALUE_NAME,
  LEGACY_SLUG,
  EXE_BASENAMES,
  DEV_PATH_STEMS,
  LOG_NAME,
  ADMIN_LOG_NAME,
  SHOW_REQUEST_NAME,
  LOG_CANDIDATES,
  BUILD_DIR_NAME,
  TRAY_TITLE,
  WINDOW_TITLE,
  isAppImage,
};
