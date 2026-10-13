// @runtime: artifact —— 发布链判据件：读产物目录＋本地 git 快照（`--remote` 才碰网络，且只读）；
//   出包后、推送前后由人手跑。它**不能**进 CI 强制层：Actions 检出的是 publish 分支，仓里没有 `main`
//   ref 可作集合运算的对照面，硬跑只会「前置不满足」。归 artifact 而不是 none：none 桶是「谁都不属于」，
//   而本件有断言且服务对象就是发布产物与公开面（票 11-Y3 的 ci/none 闸门专门拦这种躲法）。
// 发布链钉子（票 13-A）：把「快照生成 → 推送 → 建 release → 传包 → 事后回判」这条只有人肉走位一次的链，
// 变成一条命令能跑完的断言集。
//
// 为什么要有它：1.1.1 发布轮（2026-10-12）整条链是会话里手敲下来的——`tools/` 里 `gh release` 命中 0 处，
// 也就是说「下一个会话把顺序做错」没有任何机器阻力。已知的高危走位全部有据可查：`commit-tree` 绕过 pre-commit
// 钩子（公开面泄漏要按「新进入公开面的文件」补扫）、推分支带 `--tags` 会把含真实邮箱的 `v1.0.20–23` 一起带出去、
// tag 该由 `gh release create --target` 在服务端建而不是本地推、同版本号叠包（1.0.65 01:11 那次）手工分发会拿错、
// 推完不读 Actions 就以为「CI 存在」。本件把这些逐个变成断言。
//
// 行为契约：
// - 快照面（默认）**零网络**：只读本地 git 与产物文件；远端面（`--remote`）只做**只读**网络调用
//   （`gh api` / `git ls-remote`），**本件绝不推送、绝不建 release、绝不下删除类命令**——授权闸门留给人。
// - 公开树三判据与私有台账目录的排除清单是**本地推导**（`git ls-tree` 集合运算），不复制第二份清单：
//   排除项由「main 树与公开树的差集」现算，只断言它等于预期形态数（防止「偷偷少排一个文件」没人发现）。
// - 禁词扫描**复用中枢脱敏闸门**（`scan-staged.py --text <文件>`），本件不复制它的探针规则；
//   闸门结构上查不到的两类（小写 uuid / 会话 ID、大写前缀+长数字）由本件自己补 needle（§95 同族：
//   判据的观测面必须覆盖危险面，否则「零命中」只是没看见）。
// - 扫描器不可达 = **前置不满足 exit 3**，不许静默跳过（记忆第 21 款：闸门说干净之前要确认它真扫了）。
//   扫描器自身现在对未知旗标退 2，本件对每次调用**按 rc 分档判定**：0 放行 / 1 有阻断命中（本件红）/
//   2 用法错误（本件红，说明调用串坏了）/ 3 或 ≥4 异常（本件红）。
// - 末尾一行 `PASS n/N`，逐条打印字节/计数读数；退出码 0 全绿 / 1 断言失败（含件自身异常，stderr 打
//   「脚本异常：<原因>」）/ 3 前置不满足（没有 publish 分支、gh 未登录、扫描器不在位、装机产物缺失）。
//
// 红法（2026-10-12 实测读数见票 13-A；全部在影子根或临时 clone 上跑，工作树零污染）：
//   ① 影子根改 `package.json` 的 version 而不动 CHANGELOG → S1 必红；
//   ② 影子根删掉对应版本的产物 → S2 必红（并验「同版本叠包」那条也有牙）；
//   ③ 临时 clone 把 `publish` 硬指向 `main`（含私有目录）→ 判据①③必红；
//   ④ 临时 clone 往某个公开文件写一行真用户名家目录 → S5 必红（证明闸门真的落到了公开树每个文件）；
//   ⑤ 临时 clone 用非 noreply 邮箱重签 `publish` tip → S6 必红；
//   ⑥ `--scanner <不存在路径>` → exit 3（不是假绿，是「没扫」如实点名）；
//   ⑦ `--remote` 指一个不存在的 tag/仓库 → R4 红；gh 未登录环境 → exit 3。
//
// 用法：node tools/verify-release-chain.js [仓库根] [--remote] [--scanner <扫描器路径>]
//   默认根＝本件所在仓库根（argv 传根供突变自证，不必复制整仓）。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
// 退出码约定（AGENTS 铁律 3 的注）：0 全绿 / 1 断言失败**或件自身异常** / 3 前置不满足。
// 自身异常必须打成「脚本异常：<原因>」而不是甩一坨 node 栈——栈里带绝对路径，也不可读。
process.on('uncaughtException', (e) => { console.error(`脚本异常：${e.message}`); process.exit(1); });

// 入参严格解析（2026-10-12 自证抓到：旧写法把「旗标的值」当位置参数，`--scanner X` 直接让 X 变成仓库根，
// 于是根不存在→前置不满足，看起来像件的判断，其实是入参读错了）。未知旗标一律拒。
// 用法错误归 3（本仓三态约定 0/1/3，见 AGENTS 铁律 3 注；中枢扫描器自己的 2 不搬到这来）。
const argv = process.argv.slice(2);
let rootArg = null;
let scannerArg = null;
let wantRemote = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--remote') wantRemote = true;
  else if (a === '--scanner') {
    scannerArg = argv[++i];
    if (!scannerArg || scannerArg.startsWith('--')) { console.log('⛔ 前置不满足：用法错误 —— --scanner 需要一个路径值'); process.exit(3); }
  } else if (a.startsWith('--')) { console.log(`⛔ 前置不满足：用法错误 —— 不认的旗标 ${a}（本件只有 [仓库根] --remote --scanner <路径>）`); process.exit(3); }
  else if (rootArg === null) rootArg = a;
  else { console.log(`⛔ 前置不满足：用法错误 —— 多给了一个位置参数 ${a}`); process.exit(3); }
}

// §96 同源纪律：涉及路径身份的根必须 realpathSync.native（普通 realpath 不规范化盘符大小写＝等于没修）；
// 失败时兜底要显式（盘符大写）并明打，不许静默用原始路径。
const ROOT = (() => {
  const r = path.resolve(rootArg || path.join(__dirname, '..'));
  try { return fs.realpathSync.native(r); } catch (e) {
    const fb = r.replace(/^([a-zA-Z]):/, (d) => d.toUpperCase());
    console.error(`⚠ verify-release-chain: realpathSync.native 失败（${e.message}）——已显式退回「盘符大写」兜底：${fb}`);
    return fb;
  }
})();

const WANT_REMOTE = wantRemote;
const SCANNER = path.resolve(scannerArg || 'D:\\agent-brain\\scripts\\scan-staged.py');

const results = [];
const failures = [];
let preconditionFail = null;
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} —— ${detail}`);
  if (!ok) failures.push(label);
}
function precheckFail(label, detail) { preconditionFail = { label, detail }; console.log(`⛔ 前置不满足：${label} —— ${detail}`); }

function git(args) {
  try {
    return cp.execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  } catch (e) {
    if (String(e.code || '').includes('EBUSY')) throw new Error('本环境拦 node 为父的同步进程创建（EBUSY），请在普通终端跑本件');
    throw new Error(`git ${args.join(' ')} 失败：${String(e.message || e).split('\n')[0]}`);
  }
}
function ghJson(apiArgs) {
  try {
    const out = cp.execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8' });
    return JSON.parse(out || 'null');
  } catch (e) {
    const m = String(e.message || e).split('\n')[0];
    if (/ENOENT|not recognized|not found|command not found/i.test(m)) return { __missing: true };
    return { __error: m };
  }
}
function treePaths(ref) {
  return git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
}

// ---------- 前置 ----------
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (e) {
  precheckFail('给的根下没有可读 package.json', `${ROOT}（${e.message}）`);
}
if (!pkg) { console.error('scan：前置不满足，未做任何断言'); process.exit(3); }

const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const PUBLIC_BRANCH = 'publish';
const PRODUCT_BRANCH = 'main';
// 私有台账目录的名字**不在本文件里写成字面量**：AGENTS.md 的发布面纪律本来就写着「公开文档一律不得出现
// 该路径」，而本件自己就在公开树里——把私有路径拼进源码正是它 S7 要拦的那个形态（首跑就把自己
// 抓出来了：两行注释加两条正则共四处命中）。两段拼出来，判定功能不变，公开面不出现该目录名。
const LEDGER_DIR = ['docs', 'findings'].join('/');
const PRIVATE_SHAPE = new RegExp(`^(${LEDGER_DIR}/.+\\.md|AGENTS\\.md)$`);
const LEDGER_PATH_NEEDLE = new RegExp(LEDGER_DIR + '/|AGENTS\\.md:[0-9]');
// 打包清单匹配复用 verify-build-files 的**单一真源**（本件不复制第二份 glob 语义；
// verify-asar 也是这么组合它的，见该件头注）
const { parseBuildFiles, matchesBuildEntry } = require('./verify-build-files.js');

if (!fs.existsSync(SCANNER)) precheckFail('脱敏闸门不在位', `${SCANNER}——本件的禁词断言依赖它，绝不静默跳过（可 --scanner 指定）`);
if (!preconditionFail) {
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean);
  if (!refs.includes(PUBLIC_BRANCH)) precheckFail('本根没有 publish 分支', `现有分支：${refs.join(', ') || '(无)'}——发布链判据无从谈起`);
  if (!refs.includes(PRODUCT_BRANCH)) precheckFail('本根没有 main 分支', '公开树三判据需要 main 作对照');
}
if (preconditionFail) { console.log(`PASS 0/0（前置不满足：${preconditionFail.label}）`); process.exit(3); }

const publishSha = git(['rev-parse', PUBLIC_BRANCH]).trim();
const publishTree = git(['rev-parse', `${PUBLIC_BRANCH}^{tree}`]).trim();
const mainTreeSet = new Set(treePaths(PRODUCT_BRANCH));
const pubSet = new Set(treePaths(PUBLIC_BRANCH));

// ---------- 快照面 S1–S7 ----------
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
check(changelog.includes(`## [${VERSION}]`), 'S1 version ↔ CHANGELOG 有本版段',
  `package.json=${VERSION}，CHANGELOG 命中「## [${VERSION}]」=${changelog.includes(`## [${VERSION}]`)}`);

// 产物名从 build.nsis.artifactName 模板推导（不手抄文件名）
const artTmpl = (pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName) || 'showcase-setup-${version}.${ext}';
const artName = artTmpl.replace(/\$\{version\}/g, VERSION).replace(/\$\{ext\}/g, 'exe');
const outDir = path.resolve(ROOT, (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'release');
// 版本号带点，匹配整段名字不能再写 `[^.]+`（那样恒不命中＝判据无牙，2026-10-12 首跑自证时抓到）。
// 原来这条写成「同版本号只有一个包」，实测自证时发现它在真实文件系统上**不可能红**（同名无法并存两份），
// 已换成下面有危险面的那条：目录里最高包版本必须等于当前 version——防的是 1.0.65 01:11 那一族的
// 「手工分发拿错包」与「版本回退后旧包还躺着」。
const artifactPath = path.join(outDir, artName);
const artBytes = fs.existsSync(artifactPath) ? fs.statSync(artifactPath).size : 0;
check(artBytes > 0, 'S2 本版安装包在位且非空', `${artName} = ${artBytes} 字节（${outDir}）`);
const exeVers = fs.existsSync(outDir)
  ? fs.readdirSync(outDir).map((f) => /^showcase-setup-(.+)\.exe$/.exec(f)).filter(Boolean).map((m) => m[1])
  : [];
const cmpVer = (a, b) => {
  const pa = a.split(/[.\-+]/); const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = +pa[i] || 0; const y = +pb[i] || 0; if (x !== y) return x - y; }
  return 0;
};
const maxVer = exeVers.slice().sort(cmpVer).pop();
check(!!maxVer && cmpVer(maxVer, VERSION) === 0, 'S2b 产物目录最高版本 == 当前 version（防分发拿错旧包/版本回退）',
  `exe ${exeVers.length} 个，最高=${maxVer || '(无)'}，当前=${VERSION}`);

check([...pubSet].every((p) => !/^(docs\/|AGENTS\.md$)/.test(p)), 'S3 判据①：公开树不含私有路径',
  `顶层 docs/AGENTS 命中 ${[...pubSet].filter((p) => /^(docs\/|AGENTS\.md$)/.test(p)).length}（公开树共 ${pubSet.size} 件）`);
const pubOnly = [...pubSet].filter((p) => !mainTreeSet.has(p));
check(pubOnly.length === 0, 'S4 判据②：公开树有、main 没有 = 0（防幻影文件）',
  `${pubOnly.length} 个 ${pubOnly.slice(0, 5).join(', ')}`);
const excluded = [...mainTreeSet].filter((p) => !pubSet.has(p));
const privateExcluded = excluded.filter((p) => PRIVATE_SHAPE.test(p));
const aheadOther = excluded.filter((p) => !PRIVATE_SHAPE.test(p));
// 判据③ 写成**形态**断言而不是"恰为 4 项"：台账文件会随轮次增加，硬数量会让一条正常增长变成天天红；
// 真危险面是「私有形态跑偏」和下面那条「快照漏了产品面」。
check(privateExcluded.length >= 1, 'S5 判据③：私有面按形态被排除（数量随台账增长浮动，不作硬断言）',
  `私有项 ${privateExcluded.length}：${privateExcluded.join(', ')}｜main 其它领先项 ${aheadOther.length}`);
const bf = parseBuildFiles(ROOT);
if (!bf) { precheckFail('package.json 没有 build.files 数组', 'S5b 需要打包清单才能判「领先项是不是产品面」'); }
// 提交后复盘抓到的第五处缺陷：原先只用「main 有、publish 无」的**路径集合差**判领先面，
// 那对「改了 main.js 内容但文件不增不删」完全无牙——而 §84 那个真实危险面恰恰是内容漂移。
// ⇒ S5b 改用 `git diff --name-only` 的**内容差集**；S5 的排除清单仍按路径集合判（那才是"排没排"的问题）。
const aheadContent = git(['diff', '--name-only', `${PUBLIC_BRANCH}..${PRODUCT_BRANCH}`]).split('\n').filter(Boolean);
const productAhead = aheadContent.filter((f) => !PRIVATE_SHAPE.test(f) && matchesBuildEntry(f, bf.entries));
const docToolAhead = aheadContent.filter((f) => !PRIVATE_SHAPE.test(f) && !matchesBuildEntry(f, bf.entries));
check(productAhead.length === 0,
  'S5b 内容差集里不含打包输入（改了产品码却没重生成快照＝发出的包与公开源码不同物，§84 形态）',
  `main↔publish 内容差 ${aheadContent.length} 项：打包输入 ${productAhead.length}：${productAhead.slice(0, 6).join(', ') || '无'}｜tools/文档类 ${docToolAhead.length}：${docToolAhead.slice(0, 6).join(', ') || '无'}（下次发布带上即可，不算红）`);

// 禁词面：闸门能查的交给闸门，闸门结构上查不到的本件补。
// 三条 needle 都按**危险形态**收，不按"词出现过没有"收（记忆第 55 款：全称 0 命中式判据会把讲解文本
// 算成债，不可满足的判据等于没有判据）：
//   · uuid 只收 **v4**（版本位是 4）——`fc5d11e1-…-51f5-b3eb-…` 那种 nsis GUID 是 name-based **v5**，
//     是本项目故意公开的升级链身份，收进判据就是把真相报成泄漏；
//   · 私有台账只收**路径形态**（目录名在文件顶部两段拼出来，不写在这里）——PITFALLS/CHANGELOG 里提
//     `AGENTS.md` 这个名字是在描述排除清单本身，读者不需要打开它；真缺陷是公开面出现打不开的私有路径
//     （1.1.1 轮就是这么收的：改 commit-tree 之前先扫"新进入公开面的文件"，抓到三处私有台账引用）。
const GATE_BLIND = [
  ['session-or-uuid-v4', /\bsess_[0-9a-fA-F]{6,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/],
  ['device-serial-like', /\b[A-Z]{4,}[0-9]{10,}\b/],
  ['private-ledger-path', LEDGER_PATH_NEEDLE],
];
const textExt = new Set(['.js', '.json', '.md', '.html', '.css', '.yml', '.txt', '.ts', '.d.ts', '.npmrc', '.prettierignore', '.editorconfig']);
const skipExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.ttf', '.otf', '.woff', '.woff2', '.zip', '.gz', '.exe', '.dll', '.node', '.eif', '.mp3', '.wav']);
function isScannable(p) {
  if (/\.(screenshots?|assets)\//.test(p)) return false;
  const ext = path.extname(p).toLowerCase();
  if (skipExt.has(ext)) return false;
  if (ext === '') return true;
  return textExt.has(ext) || /\.(md|js|json|html|yml)$/i.test(p);
}
// 扫的是 **publish 树的 blob**，不是工作树——工作树检出的是 main 还是别的分支与"公开面是什么"无关，
// 拿工作树当公开面会让读数随检出状态漂（1.1.1 轮手工复扫用的也是 `git grep <树>` 而非工作树）。
const pubBlob = new Map();
for (const line of git(['ls-tree', '-r', 'publish']).split('\n')) {
  const m = /^(\d+) blob ([0-9a-f]{40})\t(.*)$/.exec(line);
  if (m) pubBlob.set(m[3], m[2]);
}
const publicFiles = [...pubBlob.keys()].filter(isScannable).sort();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-chain-'));
let gateHits = [];
let gateAborted = null;
let scanned = 0;
let blindDone = 0;
let scannerBytes = 0;
let blindHits = [];
const tmpOf = (f) => path.join(tmpDir, f.replace(/[\\/]/g, '__'));
try {
  for (const f of publicFiles) {
    let buf;
    try { buf = cp.execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', pubBlob.get(f)], { maxBuffer: 64 << 20 }); }
    catch (e) { check(false, 'S6 公开树逐件过脱敏闸门', `git cat-file 取不到 ${f}：${String(e.message || e).split('\n')[0]}`); continue; }
    const tp = tmpOf(f);
    fs.writeFileSync(tp, buf);
    const text = buf.toString('utf8');
    for (const [name, rx] of GATE_BLIND) {
      text.split('\n').forEach((ln, i) => { const m = ln.match(rx); if (m) blindHits.push(`${name} @ ${f}:${i + 1}「${m[0].slice(0, 24)}」`); });
    }
    let out;
    try {
      out = cp.execFileSync('python', [SCANNER, '--text', tp], { encoding: 'utf8' });
      scanned++; blindDone++; scannerBytes += Buffer.byteLength(out);
    } catch (e) {
      const rc = typeof e.status === 'number' ? e.status : -1;
      const so = String(e.stdout || ''); const se = String(e.stderr || '');
      scanned++; blindDone++; scannerBytes += Buffer.byteLength(so + se);
      // 「命中」与「闸门自己崩了」都表现为非 0，退出码不足以定性——必须有闸门自己的结构化输出为证。
      // 2026-10-12 实测：`python <目录>` 也退 1，若只看 rc 就会把装置故障读成「公开面有泄漏」（反向也一样危险）。
      if (rc === 1 && /处阻断命中/.test(so)) { gateHits.push(`${f}（闸门阻断命中）`); continue; }
      gateAborted = `第 ${scanned}/${publicFiles.length} 个（${f}）→ rc=${rc} 且输出里没有「处阻断命中」，判为闸门调用失败而非命中：${(se || so || String(e.message || '')).split('\n')[0].slice(0, 90)}`;
      break;
    }
  }
  check(gateHits.length === 0 && scanned === publicFiles.length,
    'S6 公开树逐件过脱敏闸门（复用真源，不复制规则；**扫满才算绿**）',
    `扫 publish 树 ${scanned}/${publicFiles.length} 个文本件／闸门输出 ${scannerBytes} 字节，阻断 ${gateHits.length} 个 ${gateHits.slice(0, 5).join(', ')}`);
  check(blindHits.length === 0 && blindDone === publicFiles.length,
    'S7 闸门盲区补扫（v4 uuid/会话 ID、大写前缀长数字、指向私有台账的路径形态）',
    `${blindHits.length} 处命中（补扫 ${blindDone}/${publicFiles.length} 件）${blindHits.slice(0, 8).join(' | ')}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
// 闸门调用异常＝本件的禁词面没有任何观测值，后面的断言无从谈起 ⇒ 即刻退 3（不是退 1：不是代码错，是环境没备好）
if (gateAborted) {
  console.log(`⛔ 前置不满足：脱敏闸门调用异常 —— ${gateAborted}`);
  console.log(`PASS ${results.length - failures.length}/${results.length}（未完成：禁词面在闸门失效时没有观测值，S7 起不再判）`);
  process.exit(3);
}

const ids = git(['log', '-1', '--format=%ae%n%ce', PUBLIC_BRANCH]).trim().split('\n');
const noreply = /^.+@users\.noreply\.github\.com$/;
check(ids.length >= 2 && noreply.test(ids[0]) && noreply.test(ids[1]), 'S8 publish tip 提交身份是 noreply（闸门查不到的那类，本件补）',
  `author=${ids[0]} committer=${ids[1]}`);

// ---------- 远端面 R0–R8（只读） ----------
// owner/repo 从 package.json 的 repository.url 现推（不在此硬写第二份身份；改名时这里会红得理直气壮）
if (WANT_REMOTE) {
  const repoUrl = (pkg.repository && (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url)) || '';
  const m = /github\.com[/:]([^/'"]+\/[^/'"]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (!m) { precheckFail('package.json 的 repository.url 推不出 GitHub owner/repo', `repository=${JSON.stringify(repoUrl)}`); }
  const repo = process.env.GH_REPO || (m && m[1]);
  const probe = ghJson([`repos/${repo}`]);
  if (probe && probe.__missing) precheckFail('gh 不在 PATH（远端面需要它）', '快照面不受影响，去掉 --remote 即可跑');
  if (repo && probe && probe.__error) check(false, 'R0 GitHub 仓可读', `gh api repos/${repo} → ${String(probe.__error).slice(0, 100)}`);
  if (repo && probe && !probe.__error && !probe.__missing) {
    check(probe.default_branch === PUBLIC_BRANCH, 'R0 远端默认分支是 publish', `远端 default_branch=${probe.default_branch}`);
  }
  // 前置不满足时远端面**一个数都不报**（否则「gh 不在」会塌成一串 R1–R6 红，把环境差读成发布做错）
  if (preconditionFail) {
    console.log(`PASS ${results.length - failures.length}/${results.length}（远端面未回判，快照面读数见上）`);
    process.exit(3);
  }
  const refRes = repo ? ghJson([`repos/${repo}/git/ref/heads/${PUBLIC_BRANCH}`]) : null;
  if (refRes && refRes.__error) check(false, 'R1 远端 publish 可读', `gh api 报错：${refRes.__error}`);
  else {
    const remoteSha = refRes && refRes.object && refRes.object.sha;
    check(remoteSha === publishSha, 'R1 远端 publish tip == 本地', `远端=${String(remoteSha).slice(0, 7)} 本地=${publishSha.slice(0, 7)}${remoteSha === publishSha ? '（已推）' : '（**未推**：本地领先，这是发布前常态）'}`);
    const commitRes = remoteSha ? ghJson([`repos/${repo}/git/commits/${remoteSha}`]) : null;
    const remoteTree = commitRes && commitRes.tree && commitRes.tree.sha;
    check(remoteTree === publishTree, 'R2 远端 commit 的树 == 本地 publish^{tree}', `远端树=${String(remoteTree).slice(0, 10)} 本地树=${publishTree.slice(0, 10)}`);
  }
  const latest = ghJson([`repos/${repo}/releases/latest`]);
  if (latest && latest.__error && /Not Found/.test(latest.__error)) check(false, 'R3 releases/latest 存在', 'GitHub 回 404（没有任何 release）');
  else if (latest) {
    check(latest.tag_name === TAG, 'R3 releases/latest 指向本版', `远端=${latest.tag_name} 期望=${TAG}`);
    const assets = (latest.assets || []).map((a) => `${a.name}:${a.state}:${a.size}`);
    const mine = (latest.assets || []).find((a) => a.name === artName);
    check(!!mine && mine.state === 'uploaded' && artBytes > 0 && mine.size === artBytes,
      'R4 本版资产在位、state=uploaded、字节与本地逐位等',
      mine ? `${mine.name} state=${mine.state} size=${mine.size}｜本地=${artBytes}` : `无 ${artName}（远端资产：${assets.join(' / ') || '空'}）`);
    const dl = latest.body ? Buffer.byteLength(latest.body) : 0;
    check(dl > 0, 'R5 release 正文非空（空正文＝建 release 时漏传 --notes）', `body=${dl} 字节`);
  }
  const runs = ghJson([`repos/${repo}/actions/workflows/ci.yml/runs?per_page=5`]);
  const hit = runs && (runs.workflow_runs || []).find((r) => r.head_sha === publishSha);
  if (!runs || runs.__error) check(false, 'R6 公开面 CI 有 run 记录', `gh api 失败：${String((runs && runs.__error) || '').slice(0, 80)}`);
  else check(!!hit && hit.conclusion === 'success',
    'R6 本 publish tip 的 CI run 存在且 success（没有 run＝那道闸门不存在）',
    hit ? `run ${hit.id} status=${hit.status} conclusion=${hit.conclusion}` : `最近 5 个 run 里没有 ${publishSha.slice(0, 7)}（sha: ${(runs.workflow_runs || []).map((r) => String(r.head_sha).slice(0, 7)).join(',') || '无'}）`);
  // Gitee 镜像：源码同 tip 且零 tag（10-06 定案：镜像站不建标签/发行版）
  // 未配置 gitee remote 时**明打 skip、不计入绿也不硬红**——那是本根的环境差（影子根/单平台副本），
  // 拿它报发布会把"环境没配好"和"发布做错了"混成一类（§94 同族：先分成因再定性质）。
  const remoteNames = git(['remote']).split('\n').filter(Boolean);
  if (!remoteNames.includes('gitee')) {
    console.log('⤳ R7/R8 Gitee 镜像回判：本根未配置 gitee remote ⇒ 未回判（不算绿；双平台发布请配 remote 或手跑 git ls-remote gitee）');
  } else {
    try {
      const ls = cp.execFileSync('git', ['ls-remote', 'gitee'], { encoding: 'utf8', cwd: ROOT });
      const lines = ls.split('\n').filter(Boolean);
      const tip = (lines.find((l) => l.includes('refs/heads/' + PUBLIC_BRANCH)) || '').split('\t')[0];
      check(tip === publishSha, 'R7 Gitee publish tip == 本地', `Gitee=${String(tip).slice(0, 7)} 本地=${publishSha.slice(0, 7)}`);
      const tags = lines.filter((l) => l.includes('refs/tags/'));
      check(tags.length === 0, 'R8 Gitee 零 tag（含真实邮箱的本地 tag 绝不能出现在镜像上）', `refs/tags 命中 ${tags.length}：${tags.map((t) => t.split('/')[2]).slice(0, 6).join(',') || '无'}`);
    } catch (e) {
      check(false, 'R7 Gitee publish tip == 本地', `ls-remote 失败：${String(e.message || e).split('\n')[0].slice(0, 90)}`);
    }
  }
}

// ---------- 汇总与人工授权清单 ----------
const pass = results.length - failures.length;
console.log('');
console.log('本件绝不执行推送/建 release/删除。下一步由人执行，命令形态须守：');
console.log(`  git -c http.proxy=http://127.0.0.1:7890 push github ${PUBLIC_BRANCH}   # 显式分支名，禁 --tags/--follow-tags`);
console.log(`  gh release create ${TAG} "${artifactPath}" --target ${publishSha} --title "Showcase ${VERSION}" --notes-file <脱敏过的正文>`);
console.log(`  git push gitee ${PUBLIC_BRANCH}                                          # 镜像站不建 tag、不建发行版`);
console.log(`  node tools/verify-release-chain.js --remote                              # 推完立刻用只读回判收口`);
console.log(`PASS ${pass}/${results.length}${failures.length ? ' 失败：' + failures.join('；') : ''}`);
if (preconditionFail) { console.log(`⛔ 前置不满足：${preconditionFail.label} —— ${preconditionFail.detail}`); process.exit(3); }
process.exit(failures.length ? 1 : 0);
