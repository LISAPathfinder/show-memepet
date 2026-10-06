// 迁移期兼容层六件的**只读状态探针**（1.0.57 立件；票 11-Q 起语义升级为「退休状态」探针）：
//   六件先探「接缝还在不在」——接缝不在＝已撤，报退休记录；接缝在＝按到期判据给机器读数。
//   这样同一件既能当"撤前到期巡检"用（接缝全在时），也能当"撤后守卫"用（谁把退休的代码改回来，
//   对应行立刻从「已撤」翻回读数/未撤——突变自证已验，见 findings 票 11-Q 执行记录）。
//   本件**绝不写注册表、绝不删任何文件**——它只读，然后告诉你哪一件什么状态。
//
// 退出码语义（与全项目诊断件一致）：
//   0 = 本轮需要的所有数据源都取到了（状态与否另看各行判定）
//   1 = 至少一个**需要**的源取不到数——**判据拒绝在"读不到"上打绿灯**（读不到 ≠ 不存在，§72 同型）
//   已撤行的接缝判据（源码/identity 读数）取不到＝硬错误，同样落 1。
//
// 用法：node tools/probe-compat-layer-state.js
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const identity = require('../identity');
const PKG = require('../package.json');

const ROOT = path.join(__dirname, '..');

// identity 的真源字段名以实际导出为准。本件**不写死旧名字面量**：旧 exe 名/旧日志名从
// identity 名单里「挑非当前名的那个」派生；接缝撤除后派生结果为空＝已撤的证据，不是错误
// （票 11-Q 前：取不到真源直接 exit 1；票 11-Q 起：取不到＝该件已退休，这正是要报告的状态）。
const CURRENT_EXE = String(identity.PRODUCT_NAME).toLowerCase() + '.exe';
const LEGACY_EXE = (identity.EXE_BASENAMES || []).find((n) => n.toLowerCase() !== CURRENT_EXE);
const LEGACY_LOG = (identity.LOG_CANDIDATES || []).find((n) => n !== identity.LOG_NAME);
// guid 真源 = package.json 的 build.nsis.guid（verify-identity 把它钉成字面值），本件不再抄一遍
const INSTALL_GUID = PKG.build && PKG.build.nsis && PKG.build.nsis.guid;

// reg 直读：**数组形式 execFile**（不经 shell，无注入面，也不吃 MSYS 开关改写）。
// 两个本机实测坑（首跑就是被这两条打了回枪）：
//   1) reg.exe 在中文 Windows 上按 **OEM 码页（936/GBK）** 输出，按 utf8 读会成乱码，
//      于是任何依赖错误文案的判定都失效 → 这里用 TextDecoder('gbk')，取不到再退回 utf8；
//   2) 「键不存在」与「命令失败」在 exit code 上不分（都是 1），文案又是本地化中文 →
//      **不靠文案分类**，靠 ASCII 标记：有值必然出现 `REG_SZ`/`REG_BINARY` 这类类型名，
//      没有标记且输出含 "ERROR" = 明确的「该键无值/不存在」。真正的执行异常（reg 找不到等）另抛。
const decode = (buf) => {
  if (!buf) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  for (const enc of ['gbk', 'utf8']) {
    try {
      return new TextDecoder(enc).decode(b);
    } catch {}
  }
  return b.toString('latin1');
};
// 「找不到键」与「命令本身跑不起来」必须分开：前者是明确的读数（该键无），后者是取不到数（exit 1）。
// reg.exe 把错误写到 **stderr**，且中文 Windows 上是 GBK；execFileSync 抛错时 e.stdout/e.stderr 都带上。
const NOT_FOUND = /找不到|cannot find|unable to save|ERROR.*(1860|2)\b/i;
const regQuery = (key) => {
  let out = '';
  try {
    const r = execFileSync('reg', ['query', key], { maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    out = decode(r);
  } catch (e) {
    out = decode(e.stdout) + '\n' + decode(e.stderr);
    if (!NOT_FOUND.test(out)) throw new Error(`reg query ${key} 异常（非"键不存在"）：${out.trim().slice(0, 120) || e.message}`);
    return null; // 明确的「该键不存在」
  }
  return /\bREG_[A-Z]+\b/.test(out) ? out : null; // 有值才返回文本；无值按「不存在」处理
};

const problems = [];
const rows = [];
const decide = (item, verdict, evidence) => rows.push({ item, verdict, evidence });

// ---- 接缝判据要读的三个源码文件（读不到 = 硬错误，拒绝猜）----
const readSource = (rel, label) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (e) {
    problems.push(`${label} 读不到: ${e.message}`);
    return null;
  }
};
const mainSrc = readSource('main.js', 'main.js');
const configSrc = readSource('config.js', 'config.js');
const nshSrc = readSource(path.join('resources', 'installer.nsh'), 'installer.nsh');
// 代码行匹配：注释行（行首 //、/*、*）豁免——本票在源码里留了「××已随票 11-Q 退休」的
// 退休记录注释，朴素 includes 会把注释当接缝（首跑实测自伤，④⑥ 都因此误报「接缝在位」）。
// 行前缀判定与 verify-identity ④ 组同规则，宁可对罕见形态少豁免也不给代码行留口子。
const codeHits = (src, needle) =>
  src === null
    ? null
    : src
        .split('\n')
        .filter((l) => {
          const s = l.trim();
          return !(s.startsWith('//') || s.startsWith('/*') || s.startsWith('*'));
        })
        .filter((l) => l.includes(needle)).length;

// ---- 定位实机容器：优先 InstallLocation，缺失就从 UninstallString / DisplayIcon 反推 ----
// （只有还需要文件系统/注册表读数的在位项才依赖它；全撤后只剩 ② 用）
let installLocation = null;
let dataDir = null;
let containerFrom = null;
const needContainer = LEGACY_LOG != null; // 目前只有 ②（旧日志回落）需要容器定位
if (!INSTALL_GUID) {
  if (needContainer) problems.push('package.json 缺 build.nsis.guid：身份键无从定位');
} else if (needContainer) {
  const un = regQuery(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${INSTALL_GUID}`);
  if (un === null) {
    problems.push(`卸载键不存在或无值（guid=${INSTALL_GUID}）`);
  } else {
    const pick = (name) => {
      const m = un.match(new RegExp('^\\s*' + name + '\\s+REG_SZ\\s+(.+)$', 'm'));
      return m ? m[1].trim() : null;
    };
    installLocation = pick('InstallLocation');
    containerFrom = 'InstallLocation';
    if (!installLocation) {
      // 实测：这台机器的卸载键里没有 InstallLocation，但 UninstallString 带着容器路径
      const s = pick('UninstallString') || pick('DisplayIcon') || '';
      const m = s.match(/^"?(.*?\\)bin\\([^"\\]+)/i);
      if (m) {
        installLocation = m[1].replace(/\\+$/, '');
        containerFrom = 'UninstallString 反推';
      }
    }
    if (installLocation) dataDir = path.join(installLocation, 'data');
    else problems.push('卸载键里既无 InstallLocation，也无法从 UninstallString 反推容器路径');
  }
}

// ---- ① 旧 exe 名双认（EXE_BASENAMES）/ ③ 安装器对旧映像名的 taskkill ----
// 接缝判据：①=EXE_BASENAMES 里有非当前产品名条目；③=installer.nsh 的 petKillImage 调用 >1 处
// （第二杀就是旧映像名字面量——NSIS 引用不了 identity.js，本件也从真源派生不出已撤的名字，
//   所以用「调用处数」当接缝读数，不抄字面量）。
// 读数（仅在接缝在位时才取，懒加载 lib-occupancy→koffi，退休世界不再为此拉原生依赖）：
// 旧名进程数 + 容器 bin 内旧 exe 文件。
let runningLegacy = null;
let hitsTotal = null;
let legacyOnDisk = null;
const grabProcessReadings = () => {
  if (runningLegacy !== null) return;
  if (LEGACY_EXE == null) {
    // ① 已撤、③ 却在位的混合态：旧名真源已不可派生，读数无从谈起（不崩溃，落问题清单）
    problems.push('EXE_BASENAMES 已无旧名可派生：③ 的进程/bin 读数取不到');
    return;
  }
  try {
    // 懒加载：接缝全撤后本件不再 require koffi（lib-occupancy 的唯一重依赖）
    const { findBlockingInstances } = require('./lib-occupancy');
    const hits = findBlockingInstances();
    if (hits === null) throw new Error('进程枚举不可用');
    hitsTotal = hits.length;
    runningLegacy = hits.filter((h) => h.name.toLowerCase() === LEGACY_EXE.toLowerCase()).length;
  } catch (e) {
    problems.push('进程枚举: ' + e.message);
    runningLegacy = null;
  }
};
if (LEGACY_EXE == null) {
  decide(
    '① EXE_BASENAMES 里的旧映像名双认',
    '已撤（票 11-Q，2026-10-06）',
    `EXE_BASENAMES = ${JSON.stringify(identity.EXE_BASENAMES)}，只含当前产品名派生映像名；旧名进程不再被认作桌宠`
  );
} else {
  grabProcessReadings();
  if (installLocation) {
    try {
      legacyOnDisk = fs.readdirSync(path.join(installLocation, 'bin')).some((f) => f.toLowerCase() === LEGACY_EXE.toLowerCase());
    } catch (e) {
      problems.push('容器 bin 目录: ' + e.message);
    }
  } else {
    problems.push('容器未定位：① 的容器 bin 读数取不到');
  }
  decide(
    `① EXE_BASENAMES 里的旧映像名 ${LEGACY_EXE}（接缝在位）`,
    runningLegacy === 0 && legacyOnDisk === false ? '可撤' : '未到期',
    `桌宠进程共 ${hitsTotal === null ? '未取到' : hitsTotal} 个，其中旧名 ${runningLegacy === null ? '未取到' : runningLegacy} 个；容器 bin 内旧 exe 文件=${
      legacyOnDisk === null ? '未取到' : legacyOnDisk ? '存在' : '不存在'
    }`
  );
}
const killCalls = nshSrc === null ? null : (nshSrc.match(/!insertmacro petKillImage /g) || []).length; // 只数调用处，宏定义不算
if (killCalls === null) {
  // nshSrc 读不到已进 problems；这里不再重复判
} else if (killCalls <= 1) {
  decide(
    '③ 安装器对旧映像名的 taskkill（第二杀）',
    '已撤（票 11-Q，2026-10-06）',
    `installer.nsh 仅 ${killCalls} 处 petKillImage（= productName 派生的新名那一处）；升级遇旧名进程残留须手工结束`
  );
} else {
  grabProcessReadings();
  decide(
    '③ 安装器对旧映像名的 taskkill（第二杀，接缝在位）',
    runningLegacy === 0 && legacyOnDisk === false ? '可撤' : '未到期',
    `installer.nsh 有 ${killCalls} 处 petKillImage；旧名进程 ${runningLegacy === null ? '未取到' : runningLegacy} 个、容器 bin 内旧 exe=${
      legacyOnDisk === null ? '未取到' : legacyOnDisk ? '存在' : '不存在'
    }`
  );
}

// ---- ② 旧日志名回落（LOG_CANDIDATES 里那一代）——票 11-Q 唯一留置项 ----
// 判据不是"存在就可撤、不存在就撤"，而是**谁还在被写**：当前写用名文件活跃（10 分钟内有 mtime）
// 而旧名文件已长期静止 → 说明运行期不再产生旧名，回落只服务"回看改名前的历史日志"。
const mtimeOf = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};
const fmt = (ms) => (ms === null ? '(不存在)' : new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' 本地');
if (LEGACY_LOG == null) {
  decide('② 旧日志名回落', '已撤（LOG_CANDIDATES 已无回落名）', 'LOG_CANDIDATES = ' + JSON.stringify(identity.LOG_CANDIDATES));
} else {
  const legacyLogMs = dataDir ? mtimeOf(path.join(dataDir, LEGACY_LOG)) : null;
  const currentLogMs = dataDir ? mtimeOf(path.join(dataDir, identity.LOG_NAME)) : null;
  const currentActive = currentLogMs !== null && Date.now() - currentLogMs < 10 * 60 * 1000;
  const legacyIdleDays = legacyLogMs === null ? null : Math.floor((Date.now() - legacyLogMs) / 86400000);
  decide(
    `② 旧日志名回落（读 ${LEGACY_LOG}）——留置项（票 11-Q：留到旧日志归档或 v1.1.x）`,
    !dataDir
      ? '取不到数（容器未定位）'
      : legacyLogMs === null
        ? '可撤（旧名日志已不在，双认回落读不到任何东西）'
        : currentActive && legacyIdleDays > 60
          ? '可撤（当前名活跃、旧名静止 >60 天）'
          : '未到期（旧名近期仍被写或静止不足）',
    `旧名 mtime=${fmt(legacyLogMs)}；当前名 mtime=${fmt(currentLogMs)}${currentActive ? '（活跃）' : '（不活跃）'}——` +
      `判据看"谁还在被写"。本机改名发生在 1.0.49（2026-10-04），旧名日志在改名前那一刻仍有 mtime 属正常，` +
      `要等它静止过 60 天才谈得上撤回落。`
  );
}

// ---- ④ 自启旧 Run 键清理段 ----
// 接缝判据：main.js 是否还有 pickLegacyRunEntries 调用（清理段撤除后该函数在生产侧零调用）。
if (mainSrc === null) {
  // problems 已记
} else if (!(codeHits(mainSrc, 'pickLegacyRunEntries') > 0)) {
  decide(
    '④ 自启旧值名清理段（electron.app.* 两代形态）',
    '已撤（票 11-Q，2026-10-06）',
    'main.js 已无 pickLegacyRunEntries 调用（意图补齐 ensureAutostartIntent 保留）；残留旧 Run 键须手工删注册表值'
  );
} else {
  let legacyRunPresent = null;
  let currentRunPresent = null;
  const runText = regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  if (runText === null) {
    problems.push('Run 键取不到数（不存在或异常）');
  } else {
    const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    // 行首有空白是 reg query 的固有形态（§72 那条坑：漏了 ^\s* 就整条静默空转）
    const legacySlug = identity.LEGACY_SLUG;
    if (!legacySlug) problems.push('identity.LEGACY_SLUG 取不到：④ 的旧值名读数无法派生');
    else legacyRunPresent = new RegExp('^\\s*' + esc('electron.app.' + legacySlug) + '\\s+REG_SZ', 'm').test(runText);
    currentRunPresent = new RegExp('^\\s*' + esc(identity.RUN_VALUE_NAME) + '\\s+REG_SZ', 'm').test(runText);
  }
  decide(
    '④ 自启旧值名清理段（接缝在位）',
    legacyRunPresent === null
      ? '取不到数'
      : legacyRunPresent
        ? '未到期（旧值名仍在位）'
        : '作者机器已完成使命（新用户可能从 1.0.x 直升 → 撤销仍依赖发布链）',
    `旧值名在位=${legacyRunPresent === null ? '未取到' : legacyRunPresent}；当前值名 ${identity.RUN_VALUE_NAME} 在位=${currentRunPresent}`
  );
}

// ---- ⑤ 旧 AUMID 键清理 + LEGACY_APP_ID ----
if (!('LEGACY_APP_ID' in identity) || identity.LEGACY_APP_ID == null) {
  decide(
    '⑤ 旧 AUMID 键清理段 + identity.LEGACY_APP_ID',
    '已撤（票 11-Q，2026-10-06）',
    'identity.js 已不导出 LEGACY_APP_ID，main.js 清理段已删；残留旧 AUMID 键（若某机器有）须 reg delete 手工清'
  );
} else {
  let legacyAumidPresent = null;
  try {
    legacyAumidPresent = regQuery('HKCU\\Software\\Classes\\AppUserModelId\\' + identity.LEGACY_APP_ID) !== null;
  } catch (e) {
    problems.push('旧 AUMID 键: ' + e.message);
  }
  decide(
    `⑤ 旧 AUMID 键清理段 + identity.LEGACY_APP_ID（${identity.LEGACY_APP_ID}，接缝在位）`,
    legacyAumidPresent === null ? '取不到数' : legacyAumidPresent ? '未到期（键仍在）' : '可撤（键已无，清理段本机已执行完）',
    `该键=${legacyAumidPresent === null ? '未取到' : legacyAumidPresent ? '仍在' : '已无'}`
  );
}

// ---- ⑥ config.js 对旧名环境变量的回落 ----
const legacyEnv = 'DESKTOP_PET_DATA_DIR'; // env 变量名不是产品名面量，接缝判据需要它
if (configSrc === null) {
  // problems 已记
} else if (!(codeHits(configSrc, legacyEnv) > 0)) {
  decide(
    `⑥ config.js 对 ${legacyEnv} 的回落读取`,
    '已撤（票 11-Q，2026-10-06）',
    `config.js 已无该回落（只认 SHOWCASE_DATA_DIR）；仍按旧名传参的外部命令会被静默忽略、数据落回默认根`
  );
} else {
  decide(
    `⑥ config.js 对 ${legacyEnv} 的回落读取（接缝在位）`,
    '依赖发布链（探针不给"可撤"）',
    `config.js 仍有该回落；本进程环境里${process.env[legacyEnv] ? '有' : '没有'}该变量；它服务"外部脚本仍按旧名传参"`
  );
}

// ---- 输出 ----
console.log(`兼容层状态探针（只读，${new Date().toISOString()}）——票 11-Q 起逐项报「已撤/在位」`);
console.log(`容器 = ${installLocation || '(未取到)'}${containerFrom ? '（来源：' + containerFrom + '）' : ''}   数据根 = ${dataDir || '(未取到)'}`);
console.log(
  `名字真源：APP_ID=${identity.APP_ID} RUN_VALUE_NAME=${identity.RUN_VALUE_NAME} EXE=${JSON.stringify(identity.EXE_BASENAMES)} LEGACY_SLUG=${
    identity.LEGACY_SLUG == null ? '(无)' : identity.LEGACY_SLUG
  }（数据根解析链，不在六件） guid=${INSTALL_GUID}`
);
for (const r of rows) console.log(`\n[${r.verdict}] ${r.item}\n         证据：${r.evidence}`);
const retired = rows.filter((r) => r.verdict.startsWith('已撤')).length;
const kept = rows.length - retired;
console.log(`\n小结：已撤 ${retired} / ${rows.length} 行；在位（含留置）${kept} 行。退休凭据与反向验收见 findings 票 11-Q 执行记录。`);

if (problems.length) {
  console.error(`\n✗ 有 ${problems.length} 个数据源取不到数，本次判定不完整（拒绝打绿灯）：`);
  for (const p of problems) console.error('   - ' + p);
  process.exit(1);
}
process.exit(0);
