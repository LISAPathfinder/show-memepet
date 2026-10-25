// @runtime: none —— 运行时判据强制层装置自身，从全集排除（不在自己的执行面）
// 运行时判据强制层装置（2026-10-08 立）：把「守卫在、没人跑」变成「装置拦得住」。
// 背景（§83 实录）：verify-flee.js 从 7aaa28f 就在、断言是对的、跑一次必红，
// 但「强制」只覆盖 ci.yml 那 13 件纯逻辑件——运行时件（attach/自起实例那批）全靠会话自觉，
// 1.0.64「鼠标久留自动让开」100% 失效整整一版没红，因为没人跑它的判据件。
// 本装置与 tools/run-ci.js（出包闸门，纯逻辑层）互补：
//   - run-ci.js      ：CI 强制集（ci.yml 动态解析），纯 node、不起实例。
//   - run-runtime-ci.js（本件）：运行时件全集，起隔离 dev 实例逐件跑，聚合退出码 + uncaughtException 硬断言。
//
// 件清单动态求（禁止手抄）：
//   全集   = <根>/tools/*.js
//   强制集 = .github/workflows/ci.yml 里 `run: node tools/…`（解析复用 tools/run-ci.js 的 parseCiItems，全仓只此一份）
//   排除   = tools/lib-*.js（共享库）+ 装置自身
//   归类   = 每件件头 `// @runtime: <类> —— <理由>` 声明（2026-10-09 起），装置按声明编排；
//            曾用内容正则 /9229|9333|lib-occupancy|CDP|remote-debugging/ 猜归类——16 件无标记件
//            成了「没被任何一层认领」的黑洞（装机层探针/自宿主件/日志尺/工具混在一桶、逐件理由为零），
//            正则已降级：只做「声明缺失时的告警源」+ shared/self-launch 的特征一致性校验，不再决定归属。
//
// 八类归属（件头声明，铁律 5：新增诊断件必须带声明，否则零未分类闸门必红）：
//   shared     ：attach 9229/9333 的共享 dev 隔离实例判据件（共享批）
//   self-launch：件自己 spawn 带调试端口的隔离实例（自起批，先行）
//   installed  ：面向装机产物/真实窗口（读装机容器/真实窗口，不碰调试端口；--installed 装机轮执行）
//   self-host  ：件的执行需要 Electron 运行时（自身即宿主，或 spawn 独立 Electron 探针）——装置不编排
//   log-only   ：只读日志尺（无实例依赖）——装置不编排
//   artifact   ：需要构建产物（app.asar 等）——装置不编排
//   ci         ：CI 强制层的判据件（执行面在 run-ci.js / npm run ci）——必须真的出现在 ci.yml
//   none       ：无底洞，只允许 NONE_ALLOWLIST 里逐件点名的对象（共享库 lib-* / 两个装置自身 /
//                无断言的工具·夹具·生成器）。**不许有断言能力的判据件躲在这里**（票 11-Y3 T3-①：
//                原先 15 件 CI 强制件全声明成 none，使「有 35 条断言的件」和「一个 SetCursorPos 工具」
//                混在同一桶里，新写的判据件可以悄悄声明 none 躲过所有执行面——正是 §91 那个形状）
//
// 零未分类硬闸门（铁律 3 意义上的真断言，非打印）：起手断言全集每件都有八类之一的有效声明，
//   缺声明/声明不在取值内 ⇒ exit 1 逐件点名；八类计数求和 ≠ 全集数 ⇒ exit 1（N2 拦截面）。
//   声明为 shared/self-launch 的件源码必须命中运行时标记（这两类本质=调试端口面），否则按
//   「声明矛盾」exit 1 点名（N1 拦截面：installed 件误声明成 shared 时，不许混进共享批假绿）。
//   ci/none 归类闸门（T3-①）：声明 ci 却不在 ci.yml ⇒ 红；在 ci.yml 却声明 none ⇒ 红；
//   声明 none 但不在 NONE_ALLOWLIST ⇒ 红（要新增豁免必须同时改装置，逼出一次 review）。
//
// 装机轮（--installed，2026-10-09 立，installed 类单独成批）：
//   - 前置与共享轮互斥：装机轮要求装机版在跑（进程内枚举计数 > 0，不用 tasklist //FI——§65 子坑 7）；
//     共享轮要求装机版不在跑（assertNoBlockingInstances exit 3）。两批各自明打「本轮对象」。
//   - 读数是现状快照不是历史事件（§40 族）：每件输出带取样时刻，不与共享轮（dev 隔离实例）读数混比大小。
//   - 会注入真实点击/移动真实光标的件（REAL_INPUT_TOOLS 名单）沿用 verify-click-passthrough 的
//     真人授权闸门：无 --i-accept-real-input 必 skip（rc=3）并点名，不代签。
//   - 需要命令行传参才能跑的取证探针（MANUAL_TOOLS 名单，如 probe-layered-attr 要 hwnd）走**人工参数
//     闸门**：装置自动批跑无从传参，记 skip（rc=3）并点名「取证请手跑」，不计绿也不计红。
//     为什么不改成 none 归类：这类件在参数无效时有真断言（铁律 3），改 none 会让它彻底离开执行面；
//     2026-10-12 装机轮首次全量跑到时它就是每轮必红的那颗钉子（§91 同族：守卫在、没人跑）。
//
// 起隔离 dev 实例的四条实测契约（缺一条会拿到假失败，来源 §64/§65 子坑6/§79/§89）：
//   ① 用 require('node_modules/electron') 返回的 dist/electron.exe 全路径，经 PowerShell
//      Start-Process 起（Git Bash 后台直调 node_modules/.bin/electron 会静默不启动）。
//   ② ELECTRON_RUN_AS_NODE 必须从子环境**删除**（置空串不算，Electron 的 HasVar 只查存在性）。
//      注意：`env -u` 包装纯 node 件在 Git Bash 下会吞 stdout/stderr 并伪造 exit 0（§79）——
//      本装置全程异步 spawn、在代码里构造子环境，不走 shell 前缀。
//   ③ PET_USER_DATA_DIR 与 SHOWCASE_DATA_DIR 同时传（单实例锁活在 Chromium userData 里，
//      只搬数据根不够）；日志落点只认 SHOWCASE_DATA_DIR（identity.LOG_NAME）。
//   ④ 带 --inspect=9229 --remote-debugging-port=9333（attach 判据件从这两个口连主进程/渲染端）。
//
// 两阶段编排：件内同时出现 spawn( 与 electron 的是「自起实例的独占件」（如 verify-petcovered-alpha
// 的全量占用自检、verify-autostart-elevation 的 9229 门槛）——它们必须趁共享实例还没起时先跑；
// 其余 attach 件共享一个长住隔离实例。误判的失败模式是优雅的：端口被占/实例在场 → 件自报 exit 3 → skip。
// verify-quit 会终结共享实例，固定排在共享实例批最后；其余件跑前经 ensureInstance 自愈重启。
//
// 聚合与退出码（0 全绿 / 1 断言失败或脚本异常（打「脚本异常：」）/ 3 前置不满足）：
//   - 逐件记录 rc + stdout+stderr 的 Buffer.byteLength（不许 String.length，中文虚低近 2 倍）；
//     零字节＝没跑，不算通过。
//   - 失败件 stdout+stderr 全量落留场根 failed/<件名>.log，汇总「失败件」行同步打该文件**绝对路径**
//     （票 14-M 任务 1：批跑此前只打首行，风暴件的判据原文被 node 警告顶丢、归因做不完）。
//     「首行」机制保留为兜底读数面（无留场根/落盘失败时仍有读数），不再是唯一读数面。
//   - rc=3 重试 1 次（verify-peek 这类前置竞态件）；仍 3 记 skip 并明打原因。
//     skip 的聚合口径（票 14-K 收紧，此前「skip 一律不计入绿」）：合法 skip **白名单化**
//     （LEGIT_SKIP_SHARED / LEGIT_SKIP_INSTALLED，逐件注明为什么算合法）——verify-click-passthrough
//     的真人授权闸门（无 --i-accept-real-input 必 3）与 instrument-pet-mouse 的人工参数闸门
//     （票 14-N：共享批预防性 skip，先于 ensureInstance/复位拍）都是常态存在的前置不满足，
//     若让它们把整轮拖成 3，
//     装置就永远亮不了绿灯；但白名单之外的任何单件 skip 都意味着「该件没跑成」（14-J ★4b 实测：
//     1 件绿＋6 件 skip 报 PASS 1/1 rc=0；更常见的形态是复位拍拦下的件从 PASS 分母里减掉，其余
//     全绿照报 30/30）⇒ 名单外 skip 整轮 rc=1 并逐件打「件名＋原因分类＋原因首行」，
//     汇总行前缀「本轮不合格：m 件没跑」。除 skip 外取最坏值（失败→1），与 run-ci.js 契约一致。
//     ⚠ 分界（写死防手滑）：整轮级前置（占用闸门拦下、调试端口没起、双副本自检不过、所有件全
//     skip）**仍 exit 3**，不在本规则内——本票只把「单件级 skip」计入红，别把占用闸门改成 1。
//   - 整轮硬断言：实例日志（SHOWCASE_DATA_DIR 下）跑前取 statSync().size **字节**偏移，跑后按字节
//     切增量再 utf8 解码（§64 子坑 2：字节基线不许配字符切片），断 `uncaughtException` 增量 == 0。
//     断言自检行必打：已执行/未生效两种输出——注掉断言后输出必须变化（判别性，M3）。
//   - 物理鼠标干扰：跑前置 cursorFleeEnabled=false（config.js 现有键，不新增）。件头声明
//     「必须开着让开跑」的件（FLEE_TRUE 登记）经 CDP config.set 临时翻 true、跑完翻回。
//   - 收尾只按启动时记录的 pid 杀自己起的实例（taskkill /T /F 按 PID）；进程存在性用
//     Get-Process，不用 tasklist //FI（§65 子坑 7：过滤器静默返回空＝假阴性）。
//
// 场地卫生（2026-10-08 立，消除件间状态泄漏的假红）：共享实例跨件存活，前一件留下的场地会让
//   后面的件带着脏场起跑——2026-10-06 首轮 5 红里 4 红疑于此（残留隔离根 3 个 petPosition 停在
//   屏外 -150,-200、2 个 pos=null；批内 verify-scale 4.7s 早夭、根日志缩放行 0 而单跑 6 行）。
//   判据＝五读数（票 14-I 起加窗口物理尺寸）：petPosition 在屏内且==票面默认、petScale===1、
//   petWindow.isVisible()===true、cursorFleeEnabled===false、**窗口物理尺寸==首启基线**。
//   第五条的由来（14-I 实测，本机 DSF 1.13）：`setPosition` 每次往返把窗口尺寸涨 2~3px
//   （605×605 → 638×635 / 12 轮），而复位拍原先正是用它写回——**每一次修复都在恶化场地**，
//   共享批越靠后的件越离谱，这正是「件间连锁污染」的机制。写回改 `SetWindowPos`（位置
//   SWP_NOSIZE、尺寸脏了按基线物理值显式重设），并把这个读数纳入判据，否则同类漂移继续隐身。
//   两层防线，只做在共享批（自起批的场地是件自己的根，无跨件泄漏）：
//   ① 复位拍（每件开始前）：读数→有脏经 SetWindowPos + CDP 写回默认→复读；写回失败该件 exit 3
//     并打「场地被前一件 <件名> 污染：<实测读数>」，不许静默继续跑。
//   ② 净场断言（每件结束后，只读不修——写回是下一件复位拍的职责）：有脏在汇总「场地污染点名」
//     节记该件名（谁留下脏场地）。
//   「票面默认」不手抄产品常量：装置写根时 petPosition 恒为 null，首启产品自己把它落到
//   petDefaultPosition——首启 bounds 即默认位，产品改落位公式装置自动跟随。基线采集即验根：
//   pos 非 null / scale≠1 / flee≠false ＝ 根在启动前被外部改写 → 首个共享件 exit 3 点名
//   「（根初值/轮外）」，同时置 null 并重启实例让产品重新落位（基线不可信时不把首件放过去）。
//   隔离根前缀带 pid 唯一化（showcase-rtci-<pid>-）：%TEMP% 同前缀混过人工件
//   （runtime-ci-commit-msg.txt / runtime-ci-final.log），按前缀扫描对非目录条目 ENOTDIR 崩过
//   → 起手残留盘点走 readdirSync(withFileTypes)+isDirectory() 守卫，跳过条目计数打印。
//   保留策略：只保留失败件的隔离根——全绿轮装置件尾自删（根内纯文件、无 junction），有失败件
//   原样保留供查证。
// 突变自证（改装置或 ci.yml 后应重验；一律在 %TEMP% 副本或 argv 传入的根上做，禁止原地改跟踪件）：
//   M1 删 ci.yml 一行 run → 强制件数必须跟着变（证明动态解析，不是手抄）；
//   M2 某件 rc 伪造成 1 → 整轮聚合必须非 0；
//   M3 注掉 uncaughtException 增量断言 → 整轮仍绿但输出必须明打「该断言已禁用」；
//      注掉后输出若不变，说明断言无牙，当场改正再报；
//   M4 让某件不存在 → 必须按失败件报告，不许当跳过。
//   场地卫生红法（同样只动副本）：
//   R1 手工把隔离根的 petPosition 写成 -150,-200 再跑 → 首个共享件必须 exit 3 且点名污染源；
//   R2 注掉复位拍 → 批量 5 红原形态必须复现（证明复位拍就是那批红的因）；
//   R3 让某件中途抛异常退出 → 下一件复位拍必须仍把场地写回默认（否则 finally 语义没落地）。
//   R4（票 14-I 立、票 14-J 受控开火并更正）把共享实例窗口尺寸撑到基线+20 → 下一件复位拍必须
//      报「窗口尺寸 … ≠ 基线 …」并写回，输出「已写回默认，本件继续」。**造脏只能用 Electron
//      `setBounds`**：桌宠窗 `resizable:false`，`SetWindowPos` 带 cx/cy 被 WM_GETMINMAXINFO 钳死
//      （实测 ret=true 而尺寸纹丝不动，lib-window 注释同款），原先写在这儿的 `SetWindowPos` 是错的。
//      **红法读数（14-J 实测）**：撑到物理 707×707 → 点名 + 写回 + 重启计数 0 + 件 rc=0；
//      副本里把尺寸判据整块注掉 → 点名行消失、件带着 626×627 的脏窗口跑完全绿（脏场隐身）。
//      写回若仍用 setPosition，复读会更大 ⇒ 走「写回后仍脏」分支 exit 3（这一条就是旧实现的形态）。
//   声明式归类红法（2026-10-09 起，同样只动副本；跑不动的明确标注未做，不许写「应通过」）：
//   N0 临时摘掉任意 3 件的 @runtime 行 → 装置必须 exit 1 并逐件列出（零未分类闸门生效）；
//   N1 把某 installed 件（probe-window-style）声明改成 shared → 必须按「声明矛盾」exit 1 点名，
//      不许混进共享批假绿；
//   N2 把某件声明改成八类取值外的值（八类计数求和≠全集）→ 必红；
//   N3 注掉 --plan 的可跑性断言（PLAN_RUNNABILITY_ASSERT=false）→ plan 仍 exit 0 但必须明打
//      「该断言已禁用」（与 §94 的 M3 同口径：注掉后输出不变即说明无牙）；
//   N4 装机版在跑时直跑（强行要求共享批）→ 必须 exit 3（回归位，防复位拍把闸门改掉）。
//
// 台账重生：`node tools/run-runtime-ci.js --ledger [仓库根]`——扫描文档语料按机器判据重算
// 「有读数」并重写运行时判据件台账（LEDGER_NAME 指向的那本，本机维护、不随公开版发布）的表格
// （列不变），自带一正一反自证，见 ledgerMode 注释。
//
// 用法：
//   node tools/run-runtime-ci.js [仓库根] [--plan]      # --plan 只做清单推导、归类与前置自检，不起实例
//   node tools/run-runtime-ci.js [仓库根] --installed [--i-accept-real-input]
//                                                       # 装机轮：只跑 installed 类（装机版需在场）
//   node tools/run-runtime-ci.js --ledger [仓库根]      # 台账重生模式
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { assertNoBlockingInstances, findBlockingInstalledInstances } = require('./lib-occupancy');
const { placeWindow, windowSize, childByClass } = require('./lib-window'); // 票 14-I：摆位走 SetWindowPos，别用 setPosition
const identity = require('../identity');
const { parseCiItems } = require('./run-ci');

// 八类归属取值（与文件头「八类归属」注释一一对应；件头声明必须在取值内，否则零未分类闸门红）
const RUNTIME_CLASSES = ['shared', 'self-launch', 'installed', 'self-host', 'log-only', 'artifact', 'ci', 'none'];
// 降级后的运行时标记：不再决定归属，只做两件事——
//   ① 声明缺失时的告警源（缺声明的件若命中它，提示「疑似漏声明的运行时件」）；
//   ② shared/self-launch 的特征一致性校验（这两类本质=调试端口面，源码必须命中，N1 拦截面）。
const RUNTIME_MARKER = /9229|9333|lib-occupancy|CDP|remote-debugging/;
// 件头声明解析：`// @runtime: <类> —— <理由>`（理由同行为审计面，plan/台账逐件打印）
const RUNTIME_DECL_RE = /(?:^|\n)[ \t]*\/\/[ \t]*@runtime:[ \t]*([a-z-]+)([^\n]*)/;
const RUNTIME_REASON_RE = /(?:^|\n)[ \t]*\/\/[ \t]*@runtime:[ \t]*([^\n]*)/;
// 会注入真实点击/移动真实光标的件——装机轮授权闸门名单（verify-click-passthrough 同口径：无授权必 skip，不代签）。
// inject-click / move-cursor 本身是 none 类不进执行面，登记在此是防御：谁日后把它们改挂进装机轮，闸门先拦。
const REAL_INPUT_TOOLS = new Set(['probe-click-target.js', 'inject-click.js', 'move-cursor.js']);
// 人工参数闸门（票 0a-3 之后补，2026-10-12 装机轮首次全量跑到才撞出来）：这类件**必须命令行传参**
// 才有意义（如 probe-layered-attr.js 要 hwnd），无参时它自己 exit 3（前置不满足，票 14-N 收敛口径；
// 出生时按票 7 落的是 2，与判定面「前置不满足」语义不符已归位）拒绝打绿灯——
// 于是被装置自动批跑时**每轮必红**，而红的是"装置不该自动跑它"，不是产品坏。
// 处置＝记 skip 并点名原因（同 REAL_INPUT_TOOLS 的形状：不计绿也不计红，读数留痕），
// **不**把它偷偷改成 none 归类：它在无效 hwnd 时有真断言（铁律 3），装机的取证还得靠人工带参跑，
// 留在 installed 面里可见才是诚实的记账。
const MANUAL_TOOLS = new Set(['probe-layered-attr.js']);
// 合法 skip 白名单（票 14-K 任务 2）：聚合口径从「skip 一律不计入绿」收紧为「白名单外 skip ⇒ rc=1」。
// 名单逐件注明为什么它算合法 skip——这些都是**闸门设计如此**的常态前置不满足（不代签/无从传参），
// 让它们把整轮拖红，装置就永远亮不了绿灯；名单之外的任何 skip 都意味着「该件没跑成」
// （14-J ★4b：1 件绿＋6 件 skip 报 PASS 1/1 rc=0；复位拍拦下的件也从 PASS 分母里减掉），整轮必须红。
// ⚠ 整轮级前置（占用闸门拦下、调试端口没起、双副本自检不过、所有件全 skip）**仍 exit 3**，
// 不在本规则内——本票只把「单件级 skip」计入红，别顺手把占用闸门改成 1。
// 共享轮「人工参数闸门」名单（票 14-N）：这类件要**人工操作/带参**才有读数，装置自动批跑无从满足
// ⇒ 共享批跑前**预防性 skip**（先于 ensureInstance/复位拍，不碰共享实例），不计绿也不计红。
// 单一真源约束：预防性 skip 的判断与 LEGIT_SKIP_SHARED 共用这一份（后者由它展开）——谁日后往共享
// 批里加闸门件，只改这里一处；若实现漂移成两份名单且只改了一处，14-K 聚合闸当场红（红法 G7 的牙）。
const MANUAL_GATE_SHARED = new Set([
  // 批跑默认 dump 且无人装记录器 ⇒ 输出恒「"未安装记录器"」21 字节 rc=0＝零读数面的假绿
  // （票 14-M 待查读数已核：件本来就短、非半途静默）；取证必须人工 install→真实操作→dump。
  'instrument-pet-mouse.js',
]);
const LEGIT_SKIP_SHARED = new Set([
  'verify-click-passthrough.js', // 真人授权闸门：会注入真实点击，无 --i-accept-real-input 必 rc=3，不代签（既有设计）
  ...MANUAL_GATE_SHARED, // 人工参数闸门（票 14-N）：自动批跑无从满足的人工前置，预防性 skip——单一真源在上面的名单
]);
// 装机轮（--installed）的合法 skip＝两个人工闸门名单的并集；新增成员改 MANUAL_TOOLS/REAL_INPUT_TOOLS 即自动跟随。
const LEGIT_SKIP_INSTALLED = new Set([...MANUAL_TOOLS, ...REAL_INPUT_TOOLS]);
// --plan 可跑性断言开关（任务 4：plan 不许恒 0 的打印式恒绿）。N3 红法口径：置 false（注掉）后
// plan 仍 exit 0，但输出必须出现「已禁用」行——注掉后输出不变即说明断言无牙，当场改正再报。
const PLAN_RUNNABILITY_ASSERT = true;
const SELF_NAME = 'run-runtime-ci.js';
const LEDGER_NAME = '2026-10-05-runtime-judge-ledger.md';
const PORT_MAIN = 9229;
const PORT_RENDERER = 9333;
const READY_TIMEOUT_MS = 60_000;
const FILE_TIMEOUT_MS = 10 * 60_000; // 慢件（measure 系列 / 37 断言的 scale）兜底；卡死=异常不等于通过
const MAX_RELAUNCH = 5;
// 件头声明「必须开着让开跑」的件（现有键 cursorFleeEnabled 的按件策略，不新增配置项）：
// - verify-flee：件头明写「必须留着 cursorFleeEnabled=true 跑（跑前自查，false exit 3）」；
// - verify-flee-interaction：测「点击打断计时后重新让开」，开关关着=refire 断言恒空转（该件无自查门）。
// 新件若要求 flee=true，在此登记；登记了却不在执行面的件会在计划阶段告警。
const FLEE_TRUE = new Set(['verify-flee.js', 'verify-flee-interaction.js', 'verify-click-after.js']);
// 文档化调用形态必须按原文跑（§85：分支可达性只有实跑能验证）：
// - verify-cursor-sync：无 --face 是用法错误 exit 1（§77 实录的假红），--face 才是被测形态。
const ARGS_TABLE = { 'verify-cursor-sync.js': ['--face'] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`脚本异常：${msg}`); process.exit(1); };

// 任务 1（§96 修复）：仓库根单一真源。require cache 按解析后的路径字符串大小写分副本——
// root 必须一次性规范成文件系统真实大小写并全程使用（spawn/Start-Process 的 app 路径、
// -WorkingDirectory、日志/数据根、--ledger、--plan 打印、CDP 绝对路径 require 全部从它出）。
// 只能 realpathSync.native：普通 realpathSync 不规范化盘符大小写（实测 d:/users/… → d:\users\…），
// 用错一个后缀等于没修。native 抛异常的兜底必须显式：退回「盘符大写」并明打，不许静默用原始字符串。
let ROOT = path.join(__dirname, '..'); // 入口 normalizeRoot 后立即赋值；模块级 CDP eval（setFlee）引用它

function normalizeRoot(p) {
  let s = p ? String(p) : path.join(__dirname, '..');
  const m = s.match(/^\/([a-z])\/(.*)/i); // MSYS 形态 /d/... → D:/...
  if (m) s = `${m[1].toUpperCase()}:/${m[2]}`;
  s = path.resolve(s);
  try {
    return fs.realpathSync.native(s);
  } catch (e) {
    const fb = s.replace(/^([a-zA-Z]):/, (d) => d.toUpperCase()); // 回调收到的是全匹配（含冒号），不能再加 ':'
    console.error(`⚠ realpathSync.native 失败（${e.message}）——已显式退回「盘符大写」兜底：${fb}（原始传入 ${s}）；若与仓库真实大小写仍不一致，CDP 配置写会分裂 require 副本（§96）`);
    return fb;
  }
}

// 残留隔离根盘点（只读，每轮起手一次）：硬崩（kill -9/断电）会留根，起手扫一遍留名，人工清理
// 前先知道有什么。%TEMP% 同前缀混着人工件（runtime-ci-commit-msg.txt 等），按前缀拿路径直接
// stat 会 ENOTDIR 崩过——readdirSync(withFileTypes) + isDirectory() 守卫，跳过条目计数打印。
function scanLeftoverRoots() {
  const PREFIXES = ['showcase-rtci-', 'runtime-ci-'];
  try {
    const dirs = [];
    let skipped = 0;
    for (const e of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
      if (!PREFIXES.some((p) => e.name.startsWith(p))) continue;
      if (!e.isDirectory()) { skipped += 1; continue; }
      dirs.push(e.name);
    }
    if (dirs.length || skipped) {
      const head = dirs.slice(0, 5).join('、') + (dirs.length > 5 ? ` 等 ${dirs.length} 个` : '');
      console.log(`%TEMP% 残留盘点：同前缀隔离根 ${dirs.length} 个${dirs.length ? `（${head}）` : ''}；非目录条目跳过 ${skipped} 个（isDirectory() 守卫）`);
    }
  } catch (e) {
    console.log(`（%TEMP% 残留盘点失败，不影响主流程：${e.message}）`);
  }
}

// ---------- 异步进程原语（会话沙箱拦「node 为父的同步 spawn」，一律异步，§83/工作区实录） ----------
function runCapture(cmd, args, { env, cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: env || process.env, cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
    const out = []; const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => finish(1, null, `spawn 失败：${e.message}`));
    // 'close' = 进程退出 **且** stdio 流关闭——Start-Process 起的 GUI 子进程会继承 powershell 的
    // 管道句柄且长期不关，'close' 永远不来（M3 冒烟实卡 3 分钟的根因）。'exit' 先到 + 400ms
    // 宽限兜底；正常情况 'close' 先到、用它的完整流。
    p.on('exit', (code, signal) => setTimeout(() => finish(code, signal, code === null ? `被信号终止：${signal}` : ''), 400));
    p.on('close', (code, signal) => finish(code, signal, code === null ? `超时(${timeoutMs}ms)/被信号终止：${signal}` : ''));
    let settled = false;
    function finish(code, signal, note) {
      if (settled) return; settled = true;
      resolve({ code: code === null ? 1 : code, out: Buffer.concat(out), err: Buffer.concat(err), note });
    }
  });
}

// 「首行」＝第一条**真实内容**行（票 14-R 任务 2b）：此前不辨噪音，ESM 件（现 9 件、全在 shared
// 执行面）的 stderr 首行固定是 node 的 MODULE_TYPELESS_PACKAGE_JSON 警告块——14-M 立票时风暴件
// 的判据原文就是被它顶掉的。跳行过滤只写在这一处定义里（三处调用 :launchInstance 诊断/:615 装机轮/
// :1221 批跑 同治），**禁止在调用点各写一份**。只认 node 自身警告块的固定句式（本机 node v24 实测
// 四行：首行 + Reparsing… + To eliminate… + (Use `node --trace-warnings …`)）＋ ExperimentalWarning；
// 其余一律当真实内容。全件输出只剩噪音 ⇒ 返回空 ⇒ 走既有的「零输出」分支，不伪造首行。
const STDERR_NOISE_RE = /^(?:\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\] Warning:|\(node:\d+\) ExperimentalWarning:|Reparsing as ES module because module syntax was detected\.|To eliminate this warning, add "type": "module" to |\x28Use `node --trace-warnings )/;
const firstLine = (buf) => {
  if (!buf || !buf.length) return '';
  const line = buf.toString('utf8').split(/\r?\n/).find((l) => l.trim() && !STDERR_NOISE_RE.test(l.trim()));
  return line ? line.trim().slice(0, 180) : '';
};

async function psEval(script, timeoutMs = 30_000, env) {
  // env 必须由调用方显式传入——起 electron 的那条链若漏传，宿主的 ELECTRON_RUN_AS_NODE=1
  // 会原样经 powershell 继承给 electron（§89 症状 1：bad option --remote-debugging-port）
  const r = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs, env });
  return { ...r, text: r.out.toString('utf8') };
}

async function psAlive(pid) {
  const r = await psEval(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'DEAD' }`, 15_000);
  return r.text.includes('ALIVE');
}

async function killTree(pid) {
  const r = await runCapture('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 20_000 });
  return r.code === 0;
}

// ---------- 归类解析 ----------
// 每件的八类归属来自件头声明，装置不猜。声明缺失/取值外 = 未分类，零未分类闸门必红。
function declaredClass(src) {
  const m = RUNTIME_DECL_RE.exec(src || '');
  return m ? m[1] : null;
}

// 声明行的理由段（去掉类名前缀，审计面用；类名在打印处单独呈现）
function declaredReason(src) {
  const m = RUNTIME_REASON_RE.exec(src || '');
  return m ? m[1].trim().replace(/^[a-z-]+\s*——\s*/, '') : '';
}

// ---------- 清单推导 ----------
// 全集枚举单一真源（票 14-R 任务 2a）：`*.js` 这份谓词此前在 buildPlan 与 --ledger 各写一份，
// 一旦有人把执行面件改成 .mjs（比如为消 node 的 MODULE_TYPELESS 警告），它们会**同时**离开全集
// 与执行面，而唯一的自证「八类计数求和 == 全集」两边同步变少、照样成立 ⇒ 零红（§91 的批量形态，
// 且落在穿透链与恢复链的 shared 守卫上）。本 helper 是唯一枚举点，返回两份清单：
//   js         = 装置编队的全集（.js，排序稳定）；
//   suspicious = 非 .js 却带 @runtime 声明的文件——哨兵对象。判据是「件头有没有 @runtime: 声明」，
//                不是扩展名白名单：纯夹具/文档（README、lib 说明等）不带声明，不在哨兵范围（W6 边界）。
function listToolEntries(toolsDir) {
  const entries = fs.readdirSync(toolsDir).sort();
  const js = entries.filter((f) => f.endsWith('.js'));
  const suspicious = [];
  for (const f of entries) {
    if (f.endsWith('.js')) continue;
    let s = null;
    try { s = fs.readFileSync(path.join(toolsDir, f), 'utf8'); } catch { s = null; }
    if (s !== null && declaredClass(s) !== null) suspicious.push(f);
  }
  return { js, suspicious };
}

// 静默漏过哨兵（票 14-R 任务 2a）：非 .js 的 @runtime 件会被 `*.js` 全集枚举静默漏过——
// 装置在编队起手 exit 1 逐件点名，让这类改名**必红**。不替改名铺路：不许把件改 .mjs，
// 也不许让 glob 认 .mjs；真要豁免必须改本装置显式登记（同 NONE_ALLOWLIST 的"逼出 review"形态）。
function assertNoSilentDrop(suspicious) {
  if (!suspicious.length) return;
  console.error(`✗ 静默漏过哨兵（票 14-R）：tools/ 下 ${suspicious.length} 个非 .js 文件带 @runtime 声明，会被 *.js 全集枚举静默漏过（执行面与八类求和自证两边同时变少、不会红）：`);
  for (const f of suspicious) console.error(`   ${f} — 它会被 *.js 枚举静默漏过——要么改回 .js，要么显式登记豁免并说明理由`);
  process.exit(1);
}

function buildPlan(root) {
  const toolsDir = path.join(root, 'tools');
  const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');
  if (!fs.existsSync(ciPath)) fail(`仓库根里没有 ${path.join('.github', 'workflows', 'ci.yml')}：${root}`);
  if (!fs.existsSync(toolsDir)) fail(`仓库根里没有 tools/：${root}`);

  const { js: all, suspicious } = listToolEntries(toolsDir);
  assertNoSilentDrop(suspicious);
  const forced = parseCiItems(fs.readFileSync(ciPath, 'utf8')).map((p) => path.basename(p));
  const srcOf = (name) => { try { return fs.readFileSync(path.join(toolsDir, name), 'utf8'); } catch { return null; } };

  const libs = all.filter((f) => /^lib-/.test(f));
  const forcedSet = new Set(forced);

  // ---- 零未分类硬闸门（真断言，非打印；plan 与直跑都过这道）----
  // 全集每件必须有八类之一的有效声明；缺声明/取值外 → exit 1 逐件点名。
  const decl = new Map(); // name -> class
  const unclassified = []; // { name, why }
  for (const f of all) {
    const s = srcOf(f);
    if (s === null) { unclassified.push({ name: f, why: '源码读不到' }); continue; }
    const c = declaredClass(s);
    if (!c) {
      unclassified.push({ name: f, why: RUNTIME_MARKER.test(s) ? '缺 @runtime 声明（源码含运行时标记，疑似漏声明的运行时件）' : '缺 @runtime 声明' });
    } else if (!RUNTIME_CLASSES.includes(c)) {
      unclassified.push({ name: f, why: `声明「${c}」不在八类取值内（${RUNTIME_CLASSES.join('/')}）` });
    } else {
      decl.set(f, c);
    }
  }
  if (unclassified.length) {
    console.error(`✗ 零未分类闸门：${unclassified.length} 件缺有效 @runtime 声明（取值：${RUNTIME_CLASSES.join('/')}）：`);
    for (const u of unclassified) console.error(`   ${u.name} — ${u.why}`);
    process.exit(1);
  }
  // N2 拦截面：八类计数求和必须 == 全集数（闸门之上恒真的防御断言——归类表/解析被改坏时在此红）
  const classCounts = {};
  for (const c of RUNTIME_CLASSES) classCounts[c] = 0;
  for (const c of decl.values()) classCounts[c] += 1;
  const classSum = RUNTIME_CLASSES.reduce((a, c) => a + classCounts[c], 0);
  if (classSum !== all.length) {
    console.error(`✗ 八类计数求和 ${classSum} ≠ 全集 ${all.length}——归类计数被改坏（N2 拦截面）`);
    process.exit(1);
  }
  // N1 拦截面：shared/self-launch 的本质=调试端口面，源码必须命中运行时标记——
  // installed 件被误声明成 shared 时，在这里显式红并点名，不许混进共享批假绿。
  const declMismatch = [];
  for (const f of all) {
    const c = decl.get(f);
    if (c === 'shared' || c === 'self-launch') {
      const s = srcOf(f);
      if (s !== null && !RUNTIME_MARKER.test(s)) declMismatch.push({ name: f, c });
    }
  }
  if (declMismatch.length) {
    console.error(`✗ 声明矛盾（shared/self-launch 的本质=attach/spawn 调试端口实例，源码须含 9229/9333/lib-occupancy/CDP/remote-debugging 特征）：`);
    for (const d of declMismatch) console.error(`   ${d.name} 声明为 ${d.c} 但源码无端口/CDP/占用自检特征——疑似声明错类，先改声明再跑`);
    process.exit(1);
  }

  // ---- ci/none 归类闸门（票 11-Y3 T3-①）----
  // none 必须逐件点名豁免：它是"谁都不属于"的桶，有断言能力的判据件躲进来就等于没人执行（§91 同族）。
  const NONE_ALLOWLIST = new Set([
    'lib-aim.js', 'lib-container.js', 'lib-occupancy.js', 'lib-cursor.js', 'lib-window.js', 'lib-show-pet.js', // 共享库，被 require，不独立执行
    'run-ci.js', 'run-runtime-ci.js', // 两个装置自身
    'gen-emoji-catalog.js', 'mock-preload.js', 'inject-click.js', 'move-cursor.js', 'probe-mouse-event.js',
  ]);
  const ciGate = [];
  for (const f of all) {
    const c = decl.get(f);
    if (c === 'ci' && !forcedSet.has(f)) ciGate.push({ name: f, why: '声明 ci 但不在 ci.yml 的强制清单里（要么加进一步 run:，要么改类）' });
    else if (c === 'none' && forcedSet.has(f)) ciGate.push({ name: f, why: '在 ci.yml 里却声明 none——必须改声明为 ci，否则 none 桶混装有断言的强制层件' });
    else if (c === 'none' && !NONE_ALLOWLIST.has(f)) ciGate.push({ name: f, why: `none 只允许 NONE_ALLOWLIST 逐件点名（当前 ${NONE_ALLOWLIST.size} 件）——有断言的判据件不许躲进无底洞` });
  }
  if (ciGate.length) {
    console.error(`✗ ci/none 归类闸门：${ciGate.length} 件归类不成立：`);
    for (const g of ciGate) console.error(`   ${g.name} — ${g.why}`);
    process.exit(1);
  }

  // ---- 按声明编排 ----
  const runtime = all.filter((f) => decl.get(f) === 'shared' || decl.get(f) === 'self-launch');
  const phase1 = all.filter((f) => decl.get(f) === 'self-launch').sort();
  const phase2raw = all.filter((f) => decl.get(f) === 'shared').sort();
  // verify-quit 会终结共享实例：固定排到最后，减少无谓重启
  const phase2 = [...phase2raw.filter((f) => f !== 'verify-quit.js'), ...phase2raw.filter((f) => f === 'verify-quit.js')];
  const installed = all.filter((f) => decl.get(f) === 'installed').sort();
  // 不进本装置执行面的声明件（逐件理由在 printPlan 打印；CI 强制件/lib/装置自身不在此列——它们有各自的层）
  const restNames = all.filter((f) => !forcedSet.has(f) && !libs.includes(f) && f !== SELF_NAME);
  const outside = {
    'self-host': restNames.filter((f) => decl.get(f) === 'self-host').sort(),
    'log-only': restNames.filter((f) => decl.get(f) === 'log-only').sort(),
    'artifact': restNames.filter((f) => decl.get(f) === 'artifact').sort(),
    'none': restNames.filter((f) => decl.get(f) === 'none').sort(),
  };

  // 件缺失按失败件报告，不许静默跳过（M4）
  const missing = [...new Set([...forced, ...runtime, ...installed])].filter((f) => !fs.existsSync(path.join(toolsDir, f)));
  const unknownFlee = [...FLEE_TRUE].filter((f) => !runtime.includes(f));
  const reasonOf = (name) => declaredReason(srcOf(name));
  return { all, forced, libs, runtime, phase1, phase2, installed, outside, decl, classCounts, classSum, missing, unknownFlee, toolsDir, srcOf, reasonOf };
}

// --plan 可跑性评估（任务 4：plan 不许恒 0 的打印式恒绿）。装机版在场 → 共享批不可跑（exit 3 语义）。
// 返回装机版进程数（-1 = 枚举不可用 → 前置不可证，同样不算可跑）。
function planRunnability() {
  const blockers = findBlockingInstalledInstances();
  const n = blockers === null ? -1 : blockers.length;
  const sharedOk = n === 0;
  const nText = n < 0 ? '枚举不可用' : String(n);
  if (n < 0) console.log(`装机版进程数=${nText} → 共享批（直跑全量）当前可跑=false（exit 3 语义：前置不可证不算通过）`);
  else console.log(`装机版进程数=${n} → 共享批（直跑全量）当前可跑=${sharedOk ? 'true' : 'false（exit 3 语义：先从托盘退出装机版）'}`);
  console.log(`装机轮（--installed）当前可跑=${n > 0 ? 'true（装机版在场）' : `false（装机版需在场${n < 0 ? '，且枚举不可用' : ''}）`}`);
  return n;
}

function printPlan(root, plan) {
  console.log(`仓库根：${root}（入口已 fs.realpathSync.native 规范化——§96：require cache 按路径字符串大小写分副本，CDP 绝对路径 require 全部以它为源）`);
  console.log(`全集 ${plan.all.length} 件 / CI 强制 ${plan.forced.length} 件（动态解析 ci.yml）/ 排除 lib-* ${plan.libs.length} 件 / 装置自身 1 件`);
  const counts = RUNTIME_CLASSES.map((c) => `${c}=${plan.classCounts[c]}`).join(' ');
  console.log(`八类计数（按件头 @runtime 声明）：${counts}；求和 ${plan.classSum} ${plan.classSum === plan.all.length ? `== 全集 ${plan.all.length} ✓` : `≠ 全集 ${plan.all.length} ✗`}`);
  console.log(`运行时执行面 ${plan.runtime.length} 件＝自起实例批（self-launch）${plan.phase1.length} 件 + 共享实例批（shared）${plan.phase2.length} 件；装机轮（installed）${plan.installed.length} 件；不进执行面 ${plan.outside['self-host'].length + plan.outside['log-only'].length + plan.outside['artifact'].length + plan.outside['none'].length} 件`);
  console.log(`强制集：${plan.forced.join('、')}`);
  console.log(`自起实例批：${plan.phase1.join('、') || '（无）'}`);
  console.log(`共享实例批：${plan.phase2.join('、') || '（无）'}`);
  console.log(`装机轮（--installed，对象＝装机产物；读数＝现状快照，不与共享轮混比）：${plan.installed.join('、') || '（无）'}`);
  for (const c of ['self-host', 'log-only', 'artifact', 'none']) {
    if (plan.outside[c].length) {
      console.log(`${c}（不在本装置执行面，逐件理由）：`);
      for (const f of plan.outside[c]) console.log(`  ${f} — ${plan.reasonOf(f) || '（无理由注释）'}`);
    }
  }
  if (plan.unknownFlee.length) console.error(`⚠ FLEE_TRUE 登记了执行面之外的件（登记漂移，请清理）：${plan.unknownFlee.join('、')}`);
}

// ---------- 隔离实例 ----------
function childEnvFor(root, dataDir, userDataDir) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 置空串不算——必须让变量不存在（§64 子坑 1）
  env.SHOWCASE_DATA_DIR = dataDir; // 日志与 config 落点（config.js DATA_DIR 只认这个覆盖）
  env.PET_USER_DATA_DIR = userDataDir; // 单实例锁锚在 userData（§65 子坑 6 / §89 根因 2）
  return env;
}

function electronExeOf(root) {
  // 纯 node 下 require electron 包返回 dist/electron.exe 全路径字符串（verify-petcovered-alpha 同款用法）
  const p = require(path.join(root, 'node_modules', 'electron'));
  if (typeof p !== 'string' || !fs.existsSync(p)) fail(`require('node_modules/electron') 拿不到 electron.exe 全路径：${p}`);
  return p;
}

async function launchInstance(root, env, redirectDir) {
  const exe = electronExeOf(root);
  if (/['"]/.test(exe) || /['"]/.test(root)) fail(`路径含引号，PowerShell 单引号字面量转义不了：${exe}`);
  // Start-Process -PassThru 拿 pid；stdout/stderr 重定向到隔离根（起不来时装置要能说出为什么）；
  // 子环境经 powershell 继承给 electron（契约①②③④）
  const outLog = path.join(redirectDir, 'electron-stdout.log');
  const errLog = path.join(redirectDir, 'electron-stderr.log');
  const script = `$p = Start-Process -FilePath '${exe}' -ArgumentList '--inspect=${PORT_MAIN}','--remote-debugging-port=${PORT_RENDERER}','${root}' -WorkingDirectory '${root}' -PassThru -RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}'; if ($p) { Write-Output ('PID=' + $p.Id) } else { Write-Output 'PID=' }`;
  const r = await psEval(script, 30_000, env); // ← env 必传：删除 ELECTRON_RUN_AS_NODE 的契约在这一跳落地
  const m = r.text.match(/PID=(\d+)/);
  if (!m) throw new Error(`Start-Process 没返回 pid（${firstLine(r.out) || firstLine(r.err) || '零输出'}）`);
  return Number(m[1]);
}

function tailLines(file, n = 8) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n).map((l) => '    ' + l.trim()).join('\n');
  } catch { return '    （无输出）'; }
}

async function portUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

async function waitReady(deadlineMs = READY_TIMEOUT_MS) {
  const t0 = Date.now();
  for (;;) {
    if (await portUp(PORT_MAIN)) {
      if (await portUp(PORT_RENDERER)) return Date.now() - t0;
    }
    if (Date.now() - t0 > deadlineMs) throw new Error(`调试端口 ${PORT_MAIN}/${PORT_RENDERER} 在 ${Math.round(deadlineMs / 1000)}s 内没就绪`);
    await sleep(500);
  }
}

async function waitPortDown(port, deadlineMs = 15_000) {
  const t0 = Date.now();
  while (await portUp(port)) {
    if (Date.now() - t0 > deadlineMs) return false;
    await sleep(300);
  }
  return true;
}

// ---------- CDP（主进程 inspector；config 翻面用，§72 子坑 2：evaluate 里没有裸 require） ----------
async function cdpMainEval(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  const t = targets.find((x) => x.type === 'node') || targets[0];
  if (!t) throw new Error(`端口 ${port} 上没有主进程 inspector 目标`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('WebSocket 连不上'))); });
  try {
    return await new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message));
        else if (msg.result.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluate 失败'));
        else resolve(msg.result.result && msg.result.result.value);
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  } finally { try { ws.close(); } catch {} }
}

async function setFlee(want) {
  // §96：CDP 表达式里 require 配置必须用绝对路径（来自 ROOT），不许 './config'——伪模块按
  // process.cwd() 解析，盘符大小写与产品解析不一致时落第二个副本，装置写的值产品永远看不到。
  const got = await cdpMainEval(PORT_MAIN, `(() => { const c = process.mainModule.require(${JSON.stringify(path.join(ROOT, 'config.js'))}); c.set('cursorFleeEnabled', ${want ? 'true' : 'false'}); return c.get('cursorFleeEnabled'); })()`);
  if (got !== want) throw new Error(`cursorFleeEnabled 翻到 ${want} 失败（读回 ${got}）`);
}

// ---------- 逐件执行 ----------
function runOneTool(scriptAbs, args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [scriptAbs, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: FILE_TIMEOUT_MS, windowsHide: true });
    const out = []; const err = []; const t0 = Date.now();
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => finish(1, `spawn 失败：${e.message}`));
    // 'exit'+宽限兜底与 runCapture 同理：自起实例的件（petcovered-alpha 等）其 electron 子进程
    // 若继承管道句柄，'close' 会迟到甚至不来
    p.on('exit', (code, signal) => setTimeout(() => finish(code === null ? 1 : code, code === null ? `超时(${Math.round(FILE_TIMEOUT_MS / 1000)}s)/被信号终止：${signal}` : ''), 400));
    p.on('close', (code, signal) => finish(code === null ? 1 : code, code === null ? `超时(${Math.round(FILE_TIMEOUT_MS / 1000)}s)/被信号终止：${signal}` : ''));
    let settled = false;
    function finish(code, note) {
      if (settled) return; settled = true;
      resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err), note, ms: Date.now() - t0 });
    }
  });
}

// ---------- 装机轮（installed 类单独成批，2026-10-09 立） ----------
// 对象＝装机产物（真实窗口/装机容器），前置与共享轮互斥：装机版必须在跑（进程内枚举计数 > 0，
// 不用 tasklist //FI——§65 子坑 7 静默空返回）。读数是现状快照不是历史事件（§40 族）：
// 每件输出带取样时刻，不与共享轮（dev 隔离实例）读数混比大小。会注入真实点击/移动真实光标的件
// （REAL_INPUT_TOOLS 名单）沿用 verify-click-passthrough 的真人授权闸门：无 --i-accept-real-input
// 必 skip（rc=3）并点名，不代签。
async function runInstalledRound(root, plan, flags) {
  const blockers = findBlockingInstalledInstances();
  if (blockers === null) {
    console.error('✗ 前置不可证（exit 3）：装机版进程枚举不可用——不许在「查不出」上打绿灯，先人工确认装机版状态再跑');
    process.exitCode = 3;
    return;
  }
  if (!blockers.length) {
    console.error('✗ 前置不满足（exit 3）：装机版未在跑——装机轮对象＝装机产物，请先启动装机版再跑 --installed');
    process.exitCode = 3;
    return;
  }
  console.log(`── 装机轮（本轮对象＝装机产物）${plan.installed.length} 件 ──`);
  console.log(`装机版在场 ${blockers.length} 进程（pid：${blockers.map((b) => b.pid).join('、')}）；读数＝现状快照（§40 族），每件带取样时刻，不与共享轮（dev 隔离实例）读数混比大小`);
  const authorized = flags.has('--i-accept-real-input');
  const results = [];
  // 票 14-M 附注：装机轮也落失败件原文。装机轮不建隔离数据根（对象＝在跑的装机产物），所以根**懒建**——
  // 只有第一条真失败才 mkdtemp，零失败轮连目录都不产生（M2i 反向对照按构造成立，不靠"记得删"）。
  let dumpRoot = null;
  for (const name of plan.installed) {
    const full = path.join(plan.toolsDir, name);
    const sampledAt = new Date().toISOString();
    if (!fs.existsSync(full)) {
      results.push({ name, status: 'fail', rc: null, bytes: 0, reason: '件文件不存在（按失败件报告，不许当跳过）' });
      console.log(`✗ [装机] ${name} — 件文件不存在（按失败件报告，不许当跳过；取样 ${sampledAt}）`);
      continue;
    }
    if (REAL_INPUT_TOOLS.has(name) && !authorized) {
      results.push({ name, status: 'skip', rc: 3, bytes: 0, skipClass: '真人授权闸门（白名单内）', reason: '真人授权闸门：本件会注入真实点击/移动真实光标，无 --i-accept-real-input 一律 skip，不代签（verify-click-passthrough 同口径）' });
      console.log(`⊘ [装机] ${name} — skip（真人授权闸门；取样 ${sampledAt}）`);
      continue;
    }
    if (MANUAL_TOOLS.has(name)) {
      results.push({ name, status: 'skip', rc: 3, bytes: 0, skipClass: '人工参数闸门（白名单内）', reason: '人工参数闸门：本件需命令行传参（如 hwnd）才有意义，无参时它自己 exit 3（前置不满足，票 14-N 收敛口径）拒绝打绿灯——装置自动批跑无从传参，记 skip；取证请手跑 node tools/' + name + ' <hwnd>' });
      console.log(`⊘ [装机] ${name} — skip（人工参数闸门，需带 hwnd 手跑；取样 ${sampledAt}）`);
      continue;
    }
    const r = await runOneTool(full, [], { ...process.env }, root);
    const bytes = Buffer.byteLength(Buffer.concat([r.out, r.err]));
    const why = firstLine(r.err) || firstLine(r.out) || r.note;
    let status;
    if (r.code === 0 && bytes === 0) status = 'fail';
    else if (r.code === 0) status = 'pass';
    else if (r.code === 3) status = 'skip';
    else status = 'fail';
    const reason = status === 'pass' ? '' : (r.code === 0 ? '零字节＝没跑，不算通过' : why || `rc=${r.code}`);
    // 票 14-M 附注：与共享/自起批同格式落盘（:1188 那段），失败件原文不再只剩「首行」——
    // 装机轮的 stderr 首行同样会被 node 的 MODULE_TYPELESS_PACKAGE_JSON 警告顶掉（§108 症状三同族）。
    let dumpPath = null;
    if (status === 'fail') {
      try {
        if (!dumpRoot) dumpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `showcase-rtci-${process.pid}-`));
        const failedDir = path.join(dumpRoot, 'failed');
        fs.mkdirSync(failedDir, { recursive: true });
        dumpPath = path.join(failedDir, `${name}.log`);
        fs.writeFileSync(
          dumpPath,
          `件：${name}（装机轮）\nrc=${r.code} 字节=${bytes} 用时=${(r.ms / 1000).toFixed(1)}s 取样=${sampledAt}${r.note ? `\nnote：${r.note}` : ''}\n` +
            `（票 14-M 附注：装机轮失败件 stdout+stderr 全量原文，本文件随留场根保留）\n\n── stdout ──\n${r.out.toString('utf8')}\n── stderr ──\n${r.err.toString('utf8')}`,
          'utf8'
        );
      } catch (e) {
        dumpPath = null;
        console.log(`    （失败件原文落盘失败：${e.message}——「首行」兜底读数仍在）`);
      }
    }
    results.push({ name, status, rc: r.code, bytes, reason, skipClass: status === 'skip' ? '件自身 exit 3' : null, dumpPath });
    const mark = status === 'pass' ? '✓' : status === 'skip' ? '⊘' : '✗';
    console.log(`${mark} [装机] ${name} — rc=${r.code} 字节=${bytes} ${(r.ms / 1000).toFixed(1)}s 取样=${sampledAt}${r.note ? `（${r.note}）` : ''}`);
    if (status !== 'pass') console.log(`    └ ${status === 'skip' ? 'skip 原因' : '首行'}: ${reason}`);
  }
  const passed = results.filter((x) => x.status === 'pass');
  const failed = results.filter((x) => x.status === 'fail');
  const skipped = results.filter((x) => x.status === 'skip');
  // 票 14-K 任务 2：装机轮同型收口（此前只看 passed.length===0，1 绿＋N skip 照样 rc=0）
  const legitSkips = skipped.filter((x) => LEGIT_SKIP_INSTALLED.has(x.name));
  const illegitSkips = skipped.filter((x) => !LEGIT_SKIP_INSTALLED.has(x.name));
  const unfit = illegitSkips.length ? `本轮不合格：${illegitSkips.length} 件没跑——` : '';
  console.log(`${unfit}装机轮 PASS ${passed.length}/${results.length - skipped.length}（绿 ${passed.length} / 失败 ${failed.length} / skip：白名单内 ${legitSkips.length}／白名单外 ${illegitSkips.length}）——现状快照读数，不与共享轮读数混比大小（§40 族）`);
  if (skipped.length) {
    console.log('装机轮 skip 件（白名单内＝既有闸门设计如此；白名单外＝该件没跑成，整轮不计绿）：');
    for (const x of skipped) {
      console.log(`  ${LEGIT_SKIP_INSTALLED.has(x.name) ? '⊘(白名单内)' : '✗(白名单外)'} ${x.name} — ${x.skipClass || '（未分类）'}：${x.reason || '（无原因记录）'}`);
    }
  }
  if (failed.length) {
    console.log(`装机轮失败件（先修再报绿）：${failed.map((x) => `${x.name}${x.rc === null ? '(缺失)' : `(rc=${x.rc})`}`).join('、')}`);
    for (const x of failed) {
      if (x.dumpPath) console.log(`    → ${x.name} 判据原文（绝对路径）：${x.dumpPath}`);
    }
    process.exitCode = 1;
  } else if (passed.length === 0 && skipped.length > 0) {
    // 整轮级前置（装机版不在场等）仍 exit 3——单件级 skip 才按白名单规则转红（票 14-K 分界）
    console.error('前置不满足，不算通过：装机轮无一实际执行（全 skip）');
    process.exitCode = 3;
  } else if (illegitSkips.length) {
    console.error(`本轮不合格：${illegitSkips.length} 件白名单外 skip（该件没跑成，不许靠分母减掉报绿）——逐件原因见上，先修再报绿`);
    process.exitCode = 1;
  }
}

// ---------- 主流程 ----------
let launchedPids = []; // 只收自己起的 pid；收尾按 pid 杀，禁止按映像名
let onlyMode = false; // --only 归因模式下逐件打全量 stdout/stderr

async function runMode(root, flags, only) {
  const plan = buildPlan(root);
  if (only && only.length) {
    // 归因用子集：复用同一套启动契约逐件重跑，输出不截断地看全量 stdout/stderr。
    // 明打横幅：--only 的结果只用于归因，不作为全绿验收（验收口径是全量直跑）。
    console.log('⚠ --only 部分执行（仅归因用，不作为全绿验收）：' + only.join('、'));
    const pick = new Set(only.map((n) => n.replace(/\.js$/, '') + '.js'));
    const unknown = [...pick].filter((n) => !plan.phase1.includes(n) && !plan.phase2.includes(n));
    if (unknown.length) console.error('⚠ --only 里有不在运行时执行面的件：' + unknown.join('、'));
    plan.phase1 = plan.phase1.filter((n) => pick.has(n));
    plan.phase2 = plan.phase2.filter((n) => pick.has(n));
    plan.missing = plan.missing.filter((n) => pick.has(n));
    onlyMode = true;
  }
  printPlan(root, plan);
  if (flags.has('--plan')) {
    console.log('起手双副本自检（§96）：共享实例就绪后、任何件跑之前断言 config.js require 副本唯一（_cache 键去大小写=1，且 产品侧 === 装置绝对路径 require === cwd 相对解析）——不过整轮 exit 3，本轮读数作废');
    if (plan.missing.length) {
      console.error(`失败件（文件不存在，按失败报告不许当跳过）：${plan.missing.join('、')}`);
      process.exitCode = 1;
    }
    // --plan 可跑性断言（任务 4）：plan 不许恒 0 的打印式恒绿。装机版在场 → 共享批不可跑 → exit 3；
    // 缺失件（exit 1，更坏）在场时优先保留 1。N3 红法口径：断言禁用后 plan 仍 exit 0，
    // 但必须明打「已禁用」——注掉后输出不变即说明断言无牙。
    if (PLAN_RUNNABILITY_ASSERT) {
      const n = planRunnability();
      if (n !== 0 && process.exitCode !== 1) {
        console.error(`plan 前置不满足（exit 3）：${n < 0 ? '装机版进程枚举不可用，前置不可证' : `装机版 ${n} 进程在场，共享批不可跑`}——直跑全量前先从托盘退出装机版（托盘退出是用户的动作，装置绝不代杀）`);
        process.exitCode = 3;
      }
    } else {
      planRunnability();
      console.error('⚠ 可跑性断言已禁用（PLAN_RUNNABILITY_ASSERT=false）——plan 退出码不反映可跑性，读数不可信');
    }
    return;
  }

  // 装机轮：installed 类单独成批，前置与共享轮互斥（装机版需在场；共享轮则要求不在场）。
  if (flags.has('--installed')) {
    await runInstalledRound(root, plan, flags);
    return;
  }

  // 占用闸门只在本轮确要起/连实例时才有意义（纯缺失报告、空执行面的轮次不需要独占场地）；
  // 只拦装机版映像名，dev 隔离实例是被测对象不拦（设计意图，勿改全量语义）
  if (plan.phase1.length + plan.phase2.length > 0) {
    assertNoBlockingInstances(SELF_NAME);
    console.error('（若上一步拦了你：装机版请从托盘退出后重跑——托盘退出是用户的动作，装置绝不代杀）');
  }

  const t0 = Date.now();
  scanLeftoverRoots();
  // 前缀带 pid 唯一化：mkdtemp 随机段之外再加归属层（%TEMP% 同前缀混过人工件，见 scanLeftoverRoots）
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), `showcase-rtci-${process.pid}-`));
  const dataDir = path.join(iso, 'data');
  const userDataDir = path.join(iso, 'userdata');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  // 物理鼠标干扰前置：关让开（现有键；deepMerge 会补齐其余默认项）
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ cursorFleeEnabled: false }, null, 2) + '\n');
  const logPath = path.join(dataDir, identity.LOG_NAME);
  const env = childEnvFor(root, dataDir, userDataDir);
  console.log(`隔离数据根：${iso}（日志 ${identity.LOG_NAME}；查完可整目录删除）`);

  // uncaughtException 字节偏移基线：自起实例批之前取（自起件若沿用本数据根也纳入窗口）
  const baseOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  const results = [];
  let sharedLaunches = 0;
  let lastPid = 0;
  let uncaughtAssertionRan = false;
  let uncaughtDelta = null;

  const ensureInstance = async () => {
    if (lastPid && (await portUp(PORT_MAIN)) && (await psAlive(lastPid))) return;
    if (lastPid && (await psAlive(lastPid))) {
      console.log('  （实例进程在但调试端口不应答——按僵实例收掉重启）');
      await killTree(lastPid);
      await waitPortDown(PORT_MAIN);
    } else if (lastPid) {
      await waitPortDown(PORT_MAIN); // 上一件（如 verify-quit）正常退净后端口可能滞留片刻
    }
    if (sharedLaunches >= MAX_RELAUNCH) throw new Error(`共享实例重启已达 ${MAX_RELAUNCH} 次上限`);
    lastPid = await launchInstance(root, env, iso);
    launchedPids.push(lastPid);
    sharedLaunches += 1;
    try {
      const ms = await waitReady();
      console.log(`共享实例已起 pid=${lastPid}（第 ${sharedLaunches} 次，${(ms / 1000).toFixed(1)}s 就绪）`);
    } catch (e) {
      console.error(`实例起不来（pid=${lastPid}），electron stderr 尾部：\n${tailLines(path.join(iso, 'electron-stderr.log'))}\nelectron stdout 尾部：\n${tailLines(path.join(iso, 'electron-stdout.log'))}`);
      throw e;
    }
    await assertConfigIdentity();
  };

  // ---- 起手「双副本」硬自检（§96 修复的牙；每次实例就绪后、任何件跑之前）----
  // config.js 的 load() 首调读盘后永不再读；require cache 按解析路径字符串大小写分副本时，
  // 「装置写的副本」与「产品自己那份」各自缓存——装置写的开关产品永远看不到，而 setFlee 读回、
  // 判据件前置自查、复位拍四读数全走 inspector 侧 ⇒ 读写同侧自洽假绿。所以起手必须断言同一性：
  //   ① _cache 里 config.js 的键去大小写后恰好 1 个；
  //   ② 产品侧（main.js 模块实例 require('./config')，与产品同一 cache 键）=== 装置绝对路径 require；
  //   ③ cwd 相对解析（伪模块按 process.cwd() 解析相对说明符——原始故障通道）也指向同一对象：
  //      normalizeRoot 失效/被绕过时它最先分裂。
  // 任一不过 ⇒ 整轮 exit 3，原样打出键清单与 cwd——本轮所有读数作废，不许继续跑、不许记绿。
  // _cache 不可用时的兜底（明打）：改用 app.getAppPath() 求产品解析基点做同一性比对（产品侧读回法）。
  const configIdentityEval = () => {
    const abs = JSON.stringify(path.join(root, 'config.js'));
    return `(() => {
      const pathM = process.mainModule.require('path');
      const absCfg = ${abs};
      const out = { cwd: process.cwd(), noCache: false, viaFallback: false };
      let keys = [];
      const ModuleCtor = process.mainModule && process.mainModule.constructor;
      const cache = ModuleCtor && ModuleCtor._cache;
      if (!cache) { out.noCache = true; } else {
        keys = Object.keys(cache).filter((k) => /[\\\\/]config\\.js$/i.test(k));
      }
      let prod = null; let prodHow = null;
      if (cache) {
        const mainKey = Object.keys(cache).find((k) => /[\\\\/]main\\.js$/i.test(k));
        if (mainKey) { try { prod = cache[mainKey].require('./config'); prodHow = 'main.js 模块实例 require("./config")'; } catch (e) {} }
      }
      if (!prod) {
        try {
          const { app } = process.mainModule.require('electron');
          prod = process.mainModule.require(pathM.join(app.getAppPath(), 'config.js'));
          prodHow = 'app.getAppPath() 解析 require（_cache 兜底）';
          out.viaFallback = true;
        } catch (e) {}
      }
      const ins = process.mainModule.require(absCfg);
      // 故意的 cwd 相对解析探针（动态拼接是防 grep 误伤：Z5 判据要求通道字面量归零，此行是闸门自身、非通道）
      let cwdCfg = null; let cwdErr = '';
      try { cwdCfg = process.mainModule.require('.' + '/config'); } catch (e) { cwdErr = String((e && e.message) || e); }
      // 键清单在全部探针 require 之后统计：cwd 相对解析探针自己也可能造出第二个副本——
      // 红法（Z3/Z2 族）要的就是失败输出里原样点名两个键，不许只报通道名。
      if (cache) keys = Object.keys(cache).filter((k) => /[\\\\/]config\\.js$/i.test(k));
      out.keys = keys;
      // 注意：双副本的两个键恰好只差大小写，按小写归一去重恒=1——断言必须用原始键数，
      // 归一计数只作展示（否则同形故障从 ① 溜过去，只剩 ③ 兜着）。
      out.keyCount = keys.length;
      out.dedupCount = new Set(keys.map((k) => k.toLowerCase())).size;
      out.sameProdIns = prod ? (prod === ins) : null;
      out.sameCwdIns = cwdCfg ? (cwdCfg === ins) : null;
      out.cwdErr = cwdErr;
      out.prodHow = prodHow || '（产品侧副本不可达）';
      return JSON.stringify(out);
    })()`;
  };

  const assertConfigIdentity = async () => {
    const v = JSON.parse(await cdpMainEval(PORT_MAIN, configIdentityEval()));
    const problems = [];
    if (v.noCache) {
      if (v.sameProdIns !== true) problems.push(`_cache 不可用且兜底判同一性失败（prodHow=${v.prodHow}）`);
      else console.log('双副本自检：⚠ _cache 不可用，已用「产品侧（app.getAppPath 解析）读回」兜底判同一性 ✓');
    } else {
      if (v.keyCount !== 1) problems.push(`config.js 在 require cache 有 ${v.keyCount} 个键（去大小写归一 ${v.dedupCount} 个——归一恒 1 恰是双副本的形状，判据用原始键数）：${v.keys.join(' | ')}`);
      if (v.sameProdIns !== true) problems.push(`产品侧 config ≠ 装置绝对路径 require（取法：${v.prodHow}）`);
      if (v.sameCwdIns !== true) problems.push(`cwd 相对解析 './config' ≠ 同一对象${v.cwdErr ? `（require 失败：${v.cwdErr}）` : ''}——原始故障通道分裂`);
    }
    if (problems.length) {
      const err = new Error(`起手双副本自检不过（§96）：${problems.join('；')}；产品 cwd=${v.cwd}——本轮所有读数作废`);
      err.identity = true;
      throw err;
    }
    console.log(`双副本自检：config.js require 副本唯一（cache 原始键 ${v.keyCount} 个），产品侧 === 装置侧 === cwd 相对解析 ✓（产品 cwd=${v.cwd}）`);
  };

  // ---- 场地卫生：复位拍 + 净场断言（四读数判据，见文件头「场地卫生」节；只在共享批用） ----
  // 自证跨到产品侧（§96 修复任务 4，(a) 路线）：复位拍此前是「写 inspector 副本 → 读 inspector 副本」，
  // 读写同侧自洽——§94 把它当成自证正是漏掉了「inspector 副本 ≠ 产品副本」这一形态。现在的保证是：
  // ensureInstance 在任何件跑之前已过「双副本自检」（产品侧 === 装置绝对路径 require === cwd 相对解析，
  // 不过整轮 exit 3），所以此处 CDP 写与四读数落在与产品同一个 config 副本上，写后复读即为产品可见。
  // 若日后把双副本自检注掉，这里的「已写回默认」不再等于产品可见——届时对 flee/scale 这类有行为
  // 读数的开关必须改用行为回读终判（让开行/窗口尺寸），不许只信本节读数。
  let fieldBaseline = null; // { pos:{x,y}, physical:{width,height} }——首启实测，不手抄产品常量
  const polluters = []; // 净场断言点名用：{ name, dirt }
  let lastSharedName = null; // 复位拍点名「前一件」用（首个共享件前为 null → 记「（根初值/轮外）」）

  const FIELD_READ_EVAL = `(() => {
    const { BrowserWindow, screen } = process.mainModule.require('electron');
    const c = process.mainModule.require(${JSON.stringify(path.join(root, 'config.js'))});
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    if (!w) return JSON.stringify({ err: 'pet-window-missing' });
    const b = w.getBounds();
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x >= a.x && b.y >= a.y && b.x < a.x + a.width && b.y < a.y + a.height;
    });
    return JSON.stringify({
      pos: c.get('petPosition') || null,
      scale: c.get('petScale'),
      flee: c.get('cursorFleeEnabled'),
      visible: w.isVisible(),
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      onScreen,
      hwnd: w.getNativeWindowHandle().readBigUInt64LE(0).toString(),
    });
  })()`;

  // 物理尺寸由装置侧 GetWindowRect 读（票 14-I）：基线要能「原样写回」，而 DIP 侧读数在
  // 1.13 缩放下是往返取整后的值（首启 600 DIP 名义 → 605 实测），拿它反推物理尺寸会二次取整。
  const fieldRead = async () => {
    const raw = await cdpMainEval(PORT_MAIN, FIELD_READ_EVAL);
    const v = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (!v || v.err) throw new Error(v && v.err ? `读数失败：${v.err}` : '读数返回非 JSON');
    const ph = v.hwnd ? windowSize(v.hwnd) : null;
    v.physical = ph && ph.width > 0 ? ph : null;
    // 第三层读数（票 14-I）：渲染子窗在不在、可见不可见。外壳 visible/EXSTYLE 全绿而子窗被藏
    // ＝点击全丢（§101 的坏态），而「同句柄 hide→showInactive 重显」稳定产出这个形态（§95），
    // 件里还有这种收场方式 ⇒ 场地判据必须能看见它，否则下一件带着失联的输入通道起跑。
    v.child = v.hwnd ? childByClass(v.hwnd, 'Chrome_RenderWidgetHostHWND') : null;
    return v;
  };

  const posNullish = (p) => !p || (p.x == null && p.y == null);
  const posEq = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
  const fmtPos = (p) => (posNullish(p) ? 'null' : `${p.x},${p.y}`);

  // 窗口尺寸容差（物理像素，票 14-I）：尺寸恢复只能走 Electron setBounds，它按 DIP 落定后
  // 回读会差 1 DIP 的取整档（实测基线 683 物理 → setBounds 后 684）。容差 2 覆盖这一档；
  // 真正的漂移是每拍 2~3px 的累积（一件 200+ 拍 → +几百 px），2px 拦得住且不会误报。
  const SIZE_TOL = 2;
  const sizeOff = (ph, base) => !ph || Math.abs(ph.width - base.physical.width) > SIZE_TOL || Math.abs(ph.height - base.physical.height) > SIZE_TOL;

  const fieldDirt = (v, base) => {
    const dirt = [];
    if (!v.onScreen) dirt.push(`窗口原点出屏（${v.bounds.x},${v.bounds.y}）`);
    if (!posEq(v.bounds, base.pos)) dirt.push(`窗口位置 ${v.bounds.x},${v.bounds.y} ≠ 默认 ${base.pos.x},${base.pos.y}`);
    if (!(posNullish(v.pos) || posEq(v.pos, base.pos))) dirt.push(`config petPosition=${fmtPos(v.pos)}`);
    if (Number(v.scale) !== 1) dirt.push(`petScale=${v.scale}`);
    if (v.visible !== true) dirt.push('petWindow 不可见');
    if (v.flee !== false) dirt.push(`cursorFleeEnabled=${v.flee}`);
    // 票 14-I：窗口尺寸是「段位差」而非「状态开关」——setPosition 每拍涨 2~3px，旧复位拍
    // 用它写回，于是脏场越修越大；不把尺寸进判据，这类漂移会一路隐身到某件的几何断言才炸。
    if (!v.physical) dirt.push('窗口物理尺寸读不到（句柄失效）');
    else if (sizeOff(v.physical, base))
      dirt.push(`窗口尺寸 ${v.physical.width}×${v.physical.height} ≠ 基线 ${base.physical.width}×${base.physical.height}（容差 ±${SIZE_TOL}px；DIP 往返取整漂移，票 14-I）`);
    // 输入通道（票 14-I）：外壳健康不等于点得动——子窗被藏就是「看着在、点不动」（§101）。
    if (!v.child || !v.child.exists) dirt.push('渲染子窗不在（输入通道失联：点击全丢，§95/§101 坏态）');
    else if (!v.child.visible) dirt.push('渲染子窗不可见（输入通道失联：点击全丢，§95/§101 坏态）');
    return dirt;
  };

  // 现场写回（票 14-I 改）：位置走原生 SetWindowPos（**位置-only 必须 SWP_NOSIZE**），
  // 尺寸走 Electron setBounds——两条路分工是实测逼出来的，不是偏好：
  //   · setPosition 把整窗 rect 按 DIP→物理→DIP 往返重设，1.13 下每次 +2~3px（§98/§104）；
  //   · SetWindowPos 带 cx/cy 对 `resizable:false` 的桌宠窗**无效**（WM_GETMINMAXINFO 把
  //     min/max track size 钳在现值：实测 ret=true、尺寸纹丝不动）；
  //   · setBounds 能改，但按 DIP 落定后回读差 1 DIP 的取整档（683 → 684 物理），故判据带 ±2 容差。
  // config 与可见性仍走 CDP（产品自己的状态面）。scale 走产品 pet:config 推送通道
  // （渲染端 onConfig 的 petScale 分支幂等应用；部分载荷安全——dblclickStats/isAdmin 分支
  // 各有 typeof 守卫，不会误触）。可见性只恢复 isVisible 位；showPet 的换 HWND 重建是产品语义
  // （隐藏→显示点不动的既定解法），装置不替代——修复后 petHidden 记账漂移会出一条对账日志，
  // 那是产品对账层在如实报告装置的干预，不是缺陷。
  const fieldConfigResetEval = () => `(() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const c = process.mainModule.require(${JSON.stringify(path.join(root, 'config.js'))});
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    if (!w) return JSON.stringify({ err: 'pet-window-missing' });
    c.set('petPosition', null);
    if (Number(c.get('petScale')) !== 1) {
      c.set('petScale', 1);
      w.webContents.send('pet:config', { petScale: 1 });
    }
    c.set('cursorFleeEnabled', false);
    if (!w.isVisible()) w.show();
    return JSON.stringify({ ok: true });
  })()`;

  // 尺寸恢复（DIP 口径，基线即首启实测值）。不用绝对 600：本机 1.13 下 600 DIP 名义建窗
  // 回读是 605（§105），写 600 会把窗口设成另一档，永远「差一点」。
  const fieldSizeResetEval = () => `(() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    if (!w) return JSON.stringify({ err: 'pet-window-missing' });
    w.setBounds({ x: ${fieldBaseline.pos.x}, y: ${fieldBaseline.pos.y}, width: ${fieldBaseline.dip.width}, height: ${fieldBaseline.dip.height} });
    return JSON.stringify({ ok: true });
  })()`;

  // DIP 起点 → 物理坐标：交给产品自己的 screen.dipToScreenPoint（跨屏混合 DPI 下映射非线性，
  // 按点所在屏算才准——与 main.js movePetWindowTo 同款），装置不自己乘 scaleFactor。
  const fieldPlaceEval = () => `(() => {
    const { screen } = process.mainModule.require('electron');
    const p = screen.dipToScreenPoint({ x: ${fieldBaseline.pos.x}, y: ${fieldBaseline.pos.y} });
    return JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) });
  })()`;

  const fieldRepair = async (v) => {
    const phys = JSON.parse(await cdpMainEval(PORT_MAIN, fieldPlaceEval()));
    if (!placeWindow(v.hwnd, phys.x, phys.y)) throw new Error(`SetWindowPos(${phys.x},${phys.y},SWP_NOSIZE) 返回 false`);
    if (sizeOff(v.physical, fieldBaseline)) {
      await cdpMainEval(PORT_MAIN, fieldSizeResetEval());
      await sleep(250); // setBounds 落定（DIP→物理映射要走一遍）
    }
    await cdpMainEval(PORT_MAIN, fieldConfigResetEval());
  };

  // 根初值污染的修复：此刻默认位不可知（首启 bounds 不可信——落位随 petScale 走 petSize()），
  // 只能四读数全部置回票面默认后重启实例，让产品自己的 resolvePetPosition→petDefaultPosition 重新落位。
  const FIELD_BOOT_REPAIR_EVAL = `(() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const c = process.mainModule.require(${JSON.stringify(path.join(root, 'config.js'))});
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
    if (!w) return JSON.stringify({ err: 'pet-window-missing' });
    if (Number(c.get('petScale')) !== 1) {
      c.set('petScale', 1);
      w.webContents.send('pet:config', { petScale: 1 });
    }
    c.set('cursorFleeEnabled', false);
    c.set('petPosition', null);
    if (!w.isVisible()) w.show();
    return JSON.stringify({ ok: true });
  })()`;

  // 重启共享实例（复位拍「先修后复读仍脏」的最后一档）：尺寸脏通常由 setBounds 一次修回（校验轮
  // 实测物理 1198 级仍可，见上面的 needRelaunch 注释），真正非靠重启不可的是被藏的渲染子窗——
  // 外壳 show() 不回来，换一个新窗口让产品按 600 DIP 重建才干净。返回重启后的读数。
  const relaunchForField = async (why) => {
    if (lastPid && (await psAlive(lastPid))) await killTree(lastPid);
    await waitPortDown(PORT_MAIN);
    if (sharedLaunches >= MAX_RELAUNCH) throw new Error(`场地修复需重启实例（${why}），但共享实例重启已达 ${MAX_RELAUNCH} 次上限`);
    lastPid = await launchInstance(root, env, iso);
    launchedPids.push(lastPid);
    sharedLaunches += 1;
    await waitReady();
    console.log(`场地修复：实例已重启（第 ${sharedLaunches} 次）——${why}`);
    // 端口就绪 ≠ 渲染子窗就绪（Chromium 要等页面开始合成才建 Chrome_RenderWidgetHostHWND）。
    // 不等它就会把「刚重启」误判成「子窗不在」→ 连环重启撞上限。
    for (let i = 0; i < 25; i++) {
      const v = await fieldRead();
      if (v.child && v.child.visible) return v;
      await sleep(200);
    }
    return fieldRead();
  };

  // 基线采集（首个共享件的复位拍里走一次）：读数验根 → 可信则 bounds 即默认位。
  // 返回 null=根干净；数组=根被外部改写的读数清单（调用方据此给首件记 exit 3）。
  const establishBaseline = async () => {
    let v = await fieldRead();
    const bootDirt = [];
    if (!posNullish(v.pos)) bootDirt.push(`config petPosition=${fmtPos(v.pos)}（装置写根时恒为 null，非 null＝根被外部改写）`);
    if (Number(v.scale) !== 1) bootDirt.push(`petScale=${v.scale}`);
    if (v.flee !== false) bootDirt.push(`cursorFleeEnabled=${v.flee}`);
    if (v.visible !== true) bootDirt.push('petWindow 启动即不可见');
    if (bootDirt.length) {
      console.error(`✗ 场地基线不可信——根初值被外部改写：${bootDirt.join('；')}`);
      await cdpMainEval(PORT_MAIN, FIELD_BOOT_REPAIR_EVAL);
      v = await relaunchForField('根初值被外部改写，产品需重新落默认位');
      if (!posNullish(v.pos)) throw new Error(`重启后 config petPosition 仍非 null（${fmtPos(v.pos)}）——基线无法建立`);
    }
    if (!v.onScreen) console.error(`⚠ 基线位置本身出屏（${v.bounds.x},${v.bounds.y}；显示器拓扑异常？）——仍按实测值作基线继续`);
    // 尺寸基线取首启实测的 DIP + 物理两份（票 14-I）：DIP 用于 setBounds 恢复，物理用于判脏。
    // 都不许手抄 600 —— 1.13 下 600 DIP 名义建窗回读是 605（§105），写 600 会把窗口设成另一档。
    if (!v.physical) throw new Error('基线采集失败：窗口物理尺寸读不到（句柄失效）');
    fieldBaseline = {
      pos: { x: v.bounds.x, y: v.bounds.y },
      dip: { width: v.bounds.width, height: v.bounds.height },
      physical: v.physical,
    };
    console.log(`场地基线：默认位 ${fieldBaseline.pos.x},${fieldBaseline.pos.y}，窗口 ${fieldBaseline.dip.width}×${fieldBaseline.dip.height} DIP（物理 ${fieldBaseline.physical.width}×${fieldBaseline.physical.height}）（首启实测；产品改落位公式/窗口尺寸装置自动跟随）`);
    return bootDirt.length ? bootDirt : null;
  };

  // 复位拍：共享批每件开始前。返回 null＝场地干净/已修复，可跑；{exit3,…}＝该件不跑。
  const fieldResetSnap = async (name) => {
    if (!fieldBaseline) {
      const tamper = await establishBaseline();
      if (tamper) {
        return {
          exit3: true,
          noRetry: true, // 根改写是确定性状态：修好后重试只会让「前置不可证」的首件混成绿
          kind: '场地污染',
          reason: `场地被前一件 ${lastSharedName || '（根初值/轮外）'} 污染：${tamper.join('；')}——基线已重建，本件不跑（前置不可证）`,
        };
      }
      return null;
    }
    let v;
    try {
      v = await fieldRead();
    } catch (e) {
      return { exit3: true, kind: '读数不可得', reason: `场地读数不可得（${e.message}）——实例状态未知，不许静默继续跑` };
    }
    const dirt = fieldDirt(v, fieldBaseline);
    if (!dirt.length) return null;
    try {
      await fieldRepair(v);
      await sleep(400); // 等 SetWindowPos/setBounds 落稳（verify-scale placeAt 同款 300ms 档）
    } catch (e) {
      console.error(`⚠ 场地写回动作失败（${e.message}），以复读定夺`);
    }
    const who = lastSharedName || '（根初值/轮外）';
    // ---- 复读 + 重建容忍（票 14-K 任务 1）----
    // 产品自愈（checkPetInputRoute）＝「销毁旧窗 → 建新窗」，中间有一瞬
    // getAllWindows().find(url.endsWith('pet.html')) 返回空——fieldRead 会抛
    // 「读数失败：pet-window-missing」（14-J 校验轮实测：自 showInactive 起 +1.1s 子窗仍不可见、
    // +1.2s 读数就抛，正处在重建的瞬间）。旧代码对这种抛直接交上层 catch 记 exit 3＝该件变
    // skip、场地也没修，且轮询把踩雷机会从 1 次放大到 N 次。现在：
    //   · 恢复窗 12×250ms = 3.0s：自愈带宽两方独立实测 0.8s（14-J 执行方细分）~1.2s（14-J 校验轮），
    //     3.0s 覆盖上界并留 ≥1.8s 余量（旧 8×200ms=1.6s 余量只剩 ≤0.5s，一次慢拍就掉出去）；
    //   · 「窗口暂时不存在」（pet-window-missing／主进程 inspector 目标暂时取不到）当**仍在重建**：
    //     捕获、missing 计数 +1、继续下一拍——不抛、不记 skip；
    //   · 3s 用尽仍未回来 ⇒ 保持「该件 exit 3」的既有语义，但点名要量化：
    //     「重建后窗口 3s 未回来，重建等待 X ms（missing 计数 Y）」，不许静默继续跑；
    //   · 其他读数失败（实例真死了等）不属重建，维持「交上层 catch 记 exit 3」的既有语义。
    //   ⚠ 首读（本函数开头的 fieldRead）**不在**容忍范围：它有「场地读数不可得」自己的语义与
    //   一次重试，本票只改 fieldRepair 之后的恢复窗（票面任务 1 的对象就是这一段）。
    const REBUILD_POLL_MS = 250;
    const REBUILD_POLL_TIMES = 12; // 12×250ms = 3.0s 恢复窗（余量理由见上）
    let v2 = null; // 最近一次成功读数
    let missingCount = 0; // 重建窗口期内「窗口暂时不存在」的拍数
    let lastMissing = false; // 最后一拍是否缺失——用尽时区分「窗口没回来」与「子窗仍不可见」
    const rebuildT0 = Date.now();
    for (let i = 0; i <= REBUILD_POLL_TIMES; i++) {
      if (i > 0) await sleep(REBUILD_POLL_MS);
      let v;
      try {
        v = await fieldRead();
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/pet-window-missing|inspector 目标/.test(msg)) throw e; // 非重建类失败：交上层 catch（既有语义）
        missingCount += 1;
        lastMissing = true;
        continue; // 仍在重建：容忍，等下一拍
      }
      lastMissing = false;
      v2 = v;
      if (v.child && v.child.visible) break; // 恢复完成（子窗可见）
    }
    if (!v2 || lastMissing) {
      // 窗口用尽仍未回来：保持 exit 3 语义并量化点名——不许静默继续跑（票 14-K 任务 1.3）
      return {
        exit3: true,
        kind: '读数不可得',
        reason: `场地被前一件 ${who} 污染：${dirt.join('；')}——重建后窗口 ${REBUILD_POLL_TIMES * REBUILD_POLL_MS}ms 未回来，重建等待 ${Date.now() - rebuildT0}ms（missing 计数 ${missingCount}）——不许静默继续跑`,
      };
    }
    if (missingCount > 0) {
      console.log(`    （复位拍：重建等待 ${Date.now() - rebuildT0}ms（missing 计数 ${missingCount}）——产品自愈重建期间的窗口缺失已容忍，票 14-K）`);
    }
    let dirt2 = fieldDirt(v2, fieldBaseline);
    // 两类脏走「先修后复读，仍脏才换实例」：
    //   · 尺寸：setBounds 按 DIP 落定有 ±1 取整档，故判据带 ±2 容差。**校验轮实测**：撑到物理
    //     1198×1130 后 `setBounds(首启锚)` **一次**回 606×606 DIP（物理 684×684，差 1＝容差内）
    //     ⇒ 尺寸脏通常**可修复**、不该走到重启；旧注释写的「撑到 1200 级就再也设不回」是反的。
    //     （改不小才是真的：resizable:false 下 `SetWindowPos` 带 cx/cy 被 WM_GETMINMAXINFO 钳死。）
    //   · 输入通道：同句柄 hide→showInactive 的坏态，外壳 show() 自己不回来（§95：之后点击全丢）。
    //     产品 `checkPetInputRoute`（600ms 节拍、连续两拍判定）会重建救回。**票 14-J 受控实测**：
    //     showInactive 后 +0.1s 子窗 visible=false，**+0.8s 父窗口与渲染子窗句柄已双双更换且子窗可见**
    //     ⇒ 上面这段恢复窗（票 14-K 起为 12×250ms=3.0s 并容忍重建窗口期的读数缺失）**足够等到自愈**
    //     （14-J ×2 次实测均走「已写回默认，本件继续」、重启计数 0）。原先这里写的「子窗脏实际都会
    //     落进重启这档」是**按 3s 上界做的推断，实测偏保守**。
    //     重启仍是兜底：产品自愈有冷却（PET_ROUTE_HEAL_COOLDOWN_MS），冷却期内或自愈没发生时由它接住。
    const needRelaunch = (d) => d.startsWith('窗口尺寸') || d.startsWith('窗口物理尺寸读不到') || d.includes('渲染子窗');
    if (dirt2.length && dirt2.every(needRelaunch)) {
      console.log(`    （复位拍：场地被前一件 ${who} 污染：${dirt.join('；')}——该类不可逆，重启实例重建窗口）`);
      v2 = await relaunchForField(`场地不可逆：${dirt2.join('；')}`);
      dirt2 = fieldDirt(v2, fieldBaseline);
    }
    if (dirt2.length) {
      return { exit3: true, kind: '场地污染', reason: `场地被前一件 ${who} 污染：${dirt.join('；')}——写回后仍脏（${dirt2.join('；')}），不许静默继续跑` };
    }
    console.log(`    （复位拍：场地被前一件 ${who} 污染：${dirt.join('；')}——已写回默认，本件继续）`);
    return null;
  };

  // 净场断言：共享批每件结束后只读不修（写回是下一件复位拍的职责，R3 语义）；自身异常绝不外抛。
  const fieldCheckAfter = async (name) => {
    if (!fieldBaseline) return;
    try {
      if (!(await portUp(PORT_MAIN))) {
        console.log(`    （净场：实例无应答——${name} 疑似终结/拖垮了实例，读数未取得）`);
        return;
      }
      const v = await fieldRead();
      const dirt = fieldDirt(v, fieldBaseline);
      if (dirt.length) polluters.push({ name, dirt: dirt.join('；') });
    } catch (e) {
      console.log(`    （净场读数失败：${e.message}）`);
    }
  };

  const execBatch = async (names, phase) => {
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const idx = `${results.length + 1}/${plan.phase1.length + plan.phase2.length}`;
      const full = path.join(plan.toolsDir, name);
      if (!fs.existsSync(full)) continue; // 缺失件已在入口统一落账（M4），这里不重复记账
      if (phase === '共享' && MANUAL_GATE_SHARED.has(name)) {
        // 票 14-N：共享轮人工参数闸门——**预防性** skip，先于 ensureInstance/复位拍（形状照装机轮
        // 人工参数闸门），批跑不再执行该件（零读数面的 21 字节假绿从执行面消失）；不碰共享实例、
        // 不动 lastSharedName（它没跑，复位拍点名「前一件」时不算它）。名单与 LEGIT_SKIP_SHARED
        // 单一真源；分离（skip 了却不在白名单）时聚合闸必红——红法 G7。
        const reason = '人工参数闸门：本件要人工操作才有读数（install→真实操作→dump），自动批跑默认 dump 且无人装记录器＝恒「未安装记录器」21 字节假绿（票 14-M 待查读数已核）——预防性 skip 不执行；取证请手跑 node tools/' + name;
        results.push({ name, phase, status: 'skip', rc: 3, bytes: 0, reason, skipClass: '人工参数闸门（白名单内）', dumpPath: null });
        console.log(`⊘ ${idx} [${phase}] ${name} — rc=3 字节=0 0.0s（预防性 skip，未执行——票 14-N）`);
        console.log(`    └ skip 原因: ${reason}`);
        continue;
      }
      const flee = FLEE_TRUE.has(name);
      let attempt = { code: 1, out: Buffer.alloc(0), err: Buffer.alloc(0), note: '', ms: 0 };
      let noRetry = false; // 复位拍判「根初值污染」这类确定性前置时置位：不许靠重试混成绿
      let snappedOut = false; // 末轮被复位拍拦下（未起跑）——skip 原因分类用（票 14-K 任务 2）
      let snapKind = null; // 复位拍拦下时的原因分类（snap.kind：场地污染/读数不可得）
      for (let round = 1; round <= 2; round++) {
        snappedOut = false;
        snapKind = null;
        try {
          if (phase === '共享') {
            await ensureInstance();
            const snap = await fieldResetSnap(name); // 复位拍：断言+写回，先于一切件内动作
            if (snap && snap.exit3) {
              attempt = { code: 3, out: Buffer.alloc(0), err: Buffer.from(snap.reason), note: '', ms: 0 };
              if (snap.noRetry) noRetry = true;
              snappedOut = true;
              snapKind = snap.kind || '场地污染';
            }
          }
          if (!snappedOut) {
            if (flee) await setFlee(true);
            attempt = await runOneTool(full, ARGS_TABLE[name] || [], env, root);
          }
        } catch (e) {
          if (e && e.identity) throw e; // 双副本自检不过：整轮 exit 3，不许降级成单件 skip 继续跑
          attempt = { code: 3, out: Buffer.alloc(0), err: Buffer.from(String(e && e.message || e)), note: '', ms: 0 };
        } finally {
          if (flee && !snappedOut) { try { await setFlee(false); } catch {} }
        }
        if (!noRetry && attempt.code === 3 && round === 1) continue; // 前置竞态允许重试 1 次
        break;
      }
      if (phase === '共享') {
        await fieldCheckAfter(name); // 净场断言：只读+点名，写回交给下一件的复位拍
        lastSharedName = name;
      }
      const bytes = Buffer.byteLength(Buffer.concat([attempt.out, attempt.err]));
      const why = firstLine(attempt.err) || firstLine(attempt.out) || attempt.note;
      let status;
      if (attempt.code === 0 && bytes === 0) status = 'fail';
      else if (attempt.code === 0) status = 'pass';
      else if (attempt.code === 3) status = 'skip';
      else status = 'fail';
      const reason = status === 'pass' ? '' : (attempt.code === 0 ? '零字节＝没跑，不算通过' : why || `rc=${attempt.code}`);
      let skipClass = null;
      if (status === 'skip') {
        // 原因分类（票 14-K 任务 2）：复位拍拦下＝snap.kind（场地污染/读数不可得）；件没跑到就被
        // 装置层抛错拦下（重启上限/端口未就绪等，ms=0）＝实例级前置；件自己跑过且自报 3＝件自身 exit 3。
        // （「超时」与「件缺失」按既有语义落 fail 不落 skip：runOneTool 超时 rc=1＝断言面失败、
        // 件缺失按失败件报告（M4）——所以这两个类别不会出现在 skip 名单里。）
        if (snappedOut) skipClass = snapKind;
        else if (attempt.ms === 0) skipClass = '实例级前置（装置层抛错：重启上限/端口未就绪等）';
        else skipClass = '件自身 exit 3';
      }
      // 票 14-M 任务 1：失败件原文落盘。走既有留场根（iso），不新开目录约定；failed/ 只在本件
      // 真失败时创建（M2 反向对照：无失败件的轮次不得凭空生成 failed/，留场根自删语义不变）。
      let dumpPath = null;
      if (status === 'fail') {
        try {
          const failedDir = path.join(iso, 'failed');
          fs.mkdirSync(failedDir, { recursive: true });
          dumpPath = path.join(failedDir, `${name}.log`);
          fs.writeFileSync(
            dumpPath,
            `件：${name}\nrc=${attempt.code} 字节=${bytes} 用时=${(attempt.ms / 1000).toFixed(1)}s${attempt.note ? `\nnote：${attempt.note}` : ''}\n` +
              `（票 14-M 任务 1：失败件 stdout+stderr 全量原文，本文件随留场根保留）\n\n── stdout ──\n${attempt.out.toString('utf8')}\n── stderr ──\n${attempt.err.toString('utf8')}`,
            'utf8'
          );
        } catch (e) {
          dumpPath = null;
          console.log(`    （失败件原文落盘失败：${e.message}——「首行」兜底读数仍在）`);
        }
      }
      results.push({ name, phase, status, rc: attempt.code, bytes, reason, skipClass, dumpPath });
      const mark = status === 'pass' ? '✓' : status === 'skip' ? '⊘' : '✗';
      console.log(`${mark} ${idx} [${phase}] ${name} — rc=${attempt.code} 字节=${bytes} ${(attempt.ms / 1000).toFixed(1)}s${attempt.note ? `（${attempt.note}）` : ''}`);
      if (status !== 'pass') console.log(`    └ ${status === 'skip' ? 'skip 原因' : '首行'}: ${reason}`);
      if (onlyMode) {
        if (attempt.out.length) console.log('    ── stdout ──\n' + attempt.out.toString('utf8').trimEnd().split('\n').map((l) => '    ' + l).join('\n'));
        if (attempt.err.length) console.log('    ── stderr ──\n' + attempt.err.toString('utf8').trimEnd().split('\n').map((l) => '    ' + l).join('\n'));
      }
    }
  };

  try {
    // 件缺失（强制集或运行时集）先落账：按失败件报告，不许当跳过（M4）
    for (const name of plan.missing) {
      results.push({ name, phase: '缺失', status: 'fail', rc: null, bytes: 0, reason: '件文件不存在（按失败件报告，不许当跳过）' });
      console.log(`✗ [缺失] ${name} — 件文件不存在（按失败件报告，不许当跳过）`);
    }
    if (plan.phase1.length) {
      console.log(`\n── 自起实例批（共享实例未起，独占场地）${plan.phase1.length} 件 ──`);
      await execBatch(plan.phase1, '自起');
    }
    if (plan.phase2.length) {
      console.log(`\n── 共享实例批 ${plan.phase2.length} 件 ──`);
      await ensureInstance();
      await execBatch(plan.phase2, '共享');
    }
  } finally {
    for (const pid of launchedPids) {
      if (await psAlive(pid)) await killTree(pid);
    }
    await sleep(800);
    const alive = [];
    for (const pid of launchedPids) if (await psAlive(pid)) alive.push(pid);
    if (alive.length) console.error(`⚠ 收尾后仍有自己起的实例存活（请手工核查，pid）：${alive.join('、')}`);
    else if (launchedPids.length) console.log(`收尾完成：自己起的 ${launchedPids.length} 个实例已按 pid 收干净`);

    // 整轮硬断言：字节基线 → 字节切片 → utf8（§64 子坑 2 口径）
    if (sharedLaunches > 0 || plan.phase1.length > 0) {
      const endSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : baseOffset;
      const deltaText = endSize > baseOffset
        ? fs.readFileSync(logPath).slice(baseOffset, endSize).toString('utf8')
        : '';
      uncaughtDelta = (deltaText.match(/uncaughtException/g) || []).length;
      uncaughtAssertionRan = true;
      if (uncaughtDelta > 0) {
        results.push({ name: '(整轮) uncaughtException 增量==0', phase: '断言', status: 'fail', rc: 1, bytes: 0, reason: `实例日志 uncaughtException 增量 ${uncaughtDelta}（§83：兜底把功能失效藏成一行日志）`, dumpPath: logPath });
        for (const l of deltaText.split('\n').filter((l) => l.includes('uncaughtException')).slice(0, 5)) console.log('  日志 > ' + l.trim().slice(0, 200));
      }
    }
  }

  // ---- 聚合（票 14-K 任务 2 收紧：skip 白名单化，名单外不计绿、整轮转红）----
  const passed = results.filter((r) => r.status === 'pass');
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  const legitSkips = skipped.filter((r) => LEGIT_SKIP_SHARED.has(r.name));
  const illegitSkips = skipped.filter((r) => !LEGIT_SKIP_SHARED.has(r.name));
  const unfit = illegitSkips.length ? `本轮不合格：${illegitSkips.length} 件没跑——` : '';
  console.log(`\n${unfit}PASS ${passed.length}/${results.length - skipped.length}（绿 ${passed.length} / 失败 ${failed.length} / skip：白名单内 ${legitSkips.length}／白名单外 ${illegitSkips.length}）`);
  if (failed.length) {
    console.log(`失败件（先修再报绿）：${failed.map((r) => `${r.name}${r.rc === null ? '(缺失)' : `(rc=${r.rc})`}`).join('、')}`);
    // 票 14-M 任务 1：汇总行必须带原文绝对路径——只给件名＋rc 等于让人再考古一遍
    for (const r of failed) {
      if (r.dumpPath) console.log(`    → ${r.name} 判据原文（绝对路径）：${r.dumpPath}`);
      else console.log(`    → ${r.name} 无件级原文（件缺失或落盘失败——「首行」兜底读数见逐件行）`);
    }
  }
  if (skipped.length) {
    // 逐件打「件名＋原因分类＋原因首行」——分清「闸门设计如此」与「该件没跑成」（票 14-K 任务 2）
    console.log('skip 件（白名单内＝既有闸门设计如此；白名单外＝该件没跑成，整轮不计绿）：');
    for (const r of skipped) {
      console.log(`  ${LEGIT_SKIP_SHARED.has(r.name) ? '⊘(白名单内)' : '✗(白名单外)'} ${r.name} — ${r.skipClass || '（未分类）'}：${r.reason || '（无原因记录）'}`);
    }
  }

  // 场地污染点名（净场断言的汇总面）：谁留下脏场地，读数全打，不许静默
  if (polluters.length) {
    console.log(`场地污染点名（谁留下脏场地——写回默认由下一件的复位拍负责）：`);
    for (const p of polluters) console.log(`  ✗ ${p.name}：${p.dirt}`);
  } else if (fieldBaseline) {
    console.log('净场断言：全部共享件场地干净（无件留下脏场地）');
  }

  // 断言自检（M3 的判别性所在：注掉断言后这行输出必须变）
  if (!uncaughtAssertionRan) {
    if (sharedLaunches > 0) console.error('⚠ 断言自检：uncaughtException 增量断言未生效——该断言已禁用或未执行（本轮共享实例启动 ' + sharedLaunches + ' 次），读数不可信');
    else console.log('断言自检：本轮无共享实例启动，uncaughtException 增量断言不适用（0 实例）');
  } else {
    console.log(`断言自检：uncaughtException 增量断言已执行（自起实例批计入字节窗；共享实例启动 ${sharedLaunches} 次；增量 ${uncaughtDelta}＝${uncaughtDelta === 0 ? '通过' : '失败'}）`);
  }
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  // 保留策略：只保留失败件的隔离根（纯文件、无 junction，可直接删）；自删前 uncaughtException
  // 断言已读完了日志增量（finally 先于此处）。
  if (failed.length === 0) {
    try {
      fs.rmSync(iso, { recursive: true, force: true });
      console.log(`隔离数据根已自删（本轮无失败件）：${iso}`);
    } catch (e) {
      console.log(`隔离数据根自删失败（原样保留）：${e.message}；根在 ${iso}`);
    }
  } else {
    console.log(`隔离数据根保留在 ${iso}（本轮有失败件，留场查证）`);
  }

  const missingFails = failed.filter((r) => r.rc === null);
  const executed = passed.length + failed.length - missingFails.length;
  if (failed.length) process.exitCode = 1;
  else if (executed === 0 && skipped.length > 0) {
    // 整轮级前置（占用闸门拦下、调试端口没起、双副本自检不过、所有件全 skip）仍 exit 3——
    // 本票只把「单件级 skip」计入红，这条分界不许改（票 14-K）
    console.error('前置不满足，不算通过：所有件都 skip、无一实际执行——先清场地（装机版退出/端口释放）再重跑');
    process.exitCode = 3;
  } else if (illegitSkips.length) {
    console.error(`本轮不合格：${illegitSkips.length} 件白名单外 skip（该件没跑成，不许靠分母减掉报绿）——逐件原因与分类见上，先修再报绿`);
    process.exitCode = 1;
  }
}

// ---------- 台账重生（--ledger） ----------
// 语料：仓库根 *.md + docs/**。md，含本台账；扫描口径：
//   - 提及 = 任意行按词边界命中件名（verify-flee 不得被 verify-flee-interaction 顶绿，边界含 -）；
//   - 有读数 = 同一段（空行分隔）内出现件名 且 出现 rc=[0-3] / exit [0-3] / PASS n/m 之一；
//     **表格行（| 开头）不参与读数判定**——诊断件台账/DIAGNOSTICS 的表格是「规格面」（写的是期望
//     退出码），不是实跑读数面，不排除会把「登记过」误判成「跑过」；
//   - 时序 = 根文档与 docs/ 下的参考件在前（历史读数），台账所在的私有记录目录（本机维护，
//     不随公开版发布）按文件名日期升序殿后；
//     取最后一条命中段为「最近」——台账回填节因此总是赢得引用列，不被根文档旧行压过。
// 自证（一条不许省）：正例 verify-flee 必判「有」；反例·匹配器 `verify-flee-interaction` 的读数段
// 不得点亮 verify-flee；零读数集合逐件复核判「无」。
function ledgerMode(root) {
  const ledgerPath = path.join(root, 'docs', 'findings', LEDGER_NAME);
  const toolsDir = path.join(root, 'tools');
  const names = listToolEntries(toolsDir).js; // 枚举单一真源（票 14-R 任务 2a）：台账面与编队面同源，禁第二份谓词

  const corpus = [];
  const push = (p) => corpus.push(p);
  fs.readdirSync(root).filter((f) => f.endsWith('.md')).sort().forEach((f) => push(path.join(root, f)));
  const walkDocs = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (path.resolve(dir, e.name) === path.resolve(root, 'docs', 'findings')) continue; // findings 殿后单列
        walkDocs(path.join(dir, e.name));
      } else if (e.name.endsWith('.md')) push(path.join(dir, e.name));
    }
  };
  walkDocs(path.join(root, 'docs'));
  const findingsDir = path.join(root, 'docs', 'findings');
  if (fs.existsSync(findingsDir)) {
    fs.readdirSync(findingsDir).filter((f) => f.endsWith('.md')).sort().forEach((f) => push(path.join(findingsDir, f)));
  }
  // 语料顺序＝时序（越靠后越新）：根文档与 docs/ 下的参考件在前（其中读数视为历史——行位置不编码时间），
  // 台账所在私有目录的日志件按文件名日期升序殿后（追加式日志，文件越新/行越靠后读数越新）。
  // 读数回填的工作流就是「写进台账最新节」，这样「最近一条有读数」才会指向回填节，而不是被根文档旧行压过。
  const seen = new Set();
  const files = corpus.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = (name) => new RegExp(`(?<![A-Za-z0-9_-])${esc(name)}(?![A-Za-z0-9_-])`);
  const READING = /rc=\s*[0-3]\b|\bexit\s+[0-3]\b|PASS\s+\d+\s*\/\s*\d+/;

  // 预扫描：每文件 → { 行文本, 表格行标记, 段列表[{start,end,lines}] }
  const docs = files.map((p) => {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const paras = [];
    let cur = null;
    lines.forEach((line, i) => {
      const isText = line.trim() && !line.trimStart().startsWith('|');
      if (isText) {
        if (!cur) cur = { start: i + 1, lines: [] };
        cur.lines.push(line);
      } else if (cur) { paras.push(cur); cur = null; }
    });
    if (cur) paras.push(cur);
    return { path: p, rel: path.relative(root, p).split(path.sep).join('/'), lines, paras };
  });

  const mentionCount = new Map();
  const lastMention = new Map();
  const lastReading = new Map();
  for (const name of names) {
    const base = name.replace(/\.js$/, '');
    const re = wordRe(base);
    let count = 0; let lastM = null; let lastR = null;
    for (const d of docs) {
      d.lines.forEach((line, i) => { if (re.test(line)) { count += 1; lastM = { file: d.rel, line: i + 1 }; } });
      for (const para of d.paras) {
        const text = para.lines.join('\n');
        if (re.test(text) && READING.test(text)) lastR = { file: d.rel, line: para.start, text: para.lines[0].trim().slice(0, 120) };
      }
    }
    mentionCount.set(base, count);
    lastMention.set(base, lastM);
    lastReading.set(base, lastR);
  }

  // ---- 自证 ----
  const problems = [];
  if (!lastReading.get('verify-flee')) problems.push('自证·正例失败：verify-flee 在语料里应判「有读数」（台账 11-S/11-U 回填段与首轮全量段都有它的 rc= 读数）');
  // 反例·匹配器：verify-flee-interaction 的读数段不得点亮 verify-flee（词边界含 -）
  {
    const synthetic = '`verify-flee-interaction` rc=0（合成段，只该点亮 interaction）';
    const reFlee = wordRe('verify-flee');
    const lit = reFlee.test(synthetic) && READING.test(synthetic);
    if (lit) problems.push('自证·反例失败：合成段把 verify-flee 顶亮了——边界正则漏了连字符');
  }
  // 零未分类闸门（与 buildPlan 同一解析）：台账「归属类」列必须全覆盖，未分类 > 0 拒绝重写
  const declLedger = new Map();
  const unclassifiedLedger = [];
  for (const f of names) {
    const c = declaredClass(fs.readFileSync(path.join(toolsDir, f), 'utf8'));
    if (c && RUNTIME_CLASSES.includes(c)) declLedger.set(f, c);
    else unclassifiedLedger.push(f);
  }
  if (unclassifiedLedger.length) {
    problems.push(`零未分类闸门：${unclassifiedLedger.length} 件缺有效 @runtime 声明（${unclassifiedLedger.join('、')}）——先补声明再重生台账`);
  }
  const zeroSet = names.map((n) => n.replace(/\.js$/, '')).filter((n) => !lastReading.get(n));
  for (const n of zeroSet) { /* 逐件复核：判无即通过，判有不可能（来源同一条扫描） */ }

  if (problems.length) {
    for (const p of problems) console.error('✗ ' + p);
    fail('台账自证未过，拒绝重写表格');
  }
  console.log(`自证通过：正例 verify-flee 判「有」；反例（interaction 不点亮 flee）通过；零读数 ${zeroSet.length} 件逐件判「无」`);

  // ---- 表格重建 ----
  const oldText = fs.readFileSync(ledgerPath, 'utf8');
  const oldLines = oldText.split(/\r?\n/);
  const tStart = oldLines.findIndex((l) => /^\|\s*件\s*\|/.test(l));
  if (tStart < 0) fail(`台账里找不到表格头（| 件 |…）：${ledgerPath}`);
  let tEnd = tStart;
  while (tEnd + 1 < oldLines.length && oldLines[tEnd + 1].trimStart().startsWith('|')) tEnd += 1;

  // 扫描时已把表格行排除（paras 只收非 | 行），此处拼接新表（含「归属类」列，2026-10-09 起）。
  // fix 参：拼接后台账自身段落行号整体位移（新表行数 - 旧表行数），第二遍用 fixRef 修正引用列。
  const ledgerRow = (f, fix) => {
    const base = f.replace(/\.js$/, '');
    const mr = fix ? fix(lastReading.get(base)) : lastReading.get(base);
    const mm = fix ? fix(lastMention.get(base)) : lastMention.get(base);
    const reading = mr ? `${mr.file}:${mr.line}` : '——（从未）';
    const mention = mm ? `${mm.file}:${mm.line}` : '——';
    return `| \`${base}\` | ${declLedger.get(f) || '未分类'} | ${mentionCount.get(base)} | ${reading} | ${mention} |`;
  };
  const newTable = [
    '| 件 | 归属类 | 文档提及次数 | 最近一条有读数的记录 | 最后提及处 |',
    '|---|---|---|---|---|',
    ...names.map((f) => ledgerRow(f, null)),
  ];

  // 本台账自身段落行号在拼接后整体位移：新表行数 - 旧表行数
  const delta = newTable.length - (tEnd - tStart + 1);
  const fixRef = (ref) => {
    if (!ref) return ref;
    if (ref.file.endsWith(LEDGER_NAME) && ref.line > tEnd + 1) return { ...ref, line: ref.line + delta };
    return ref;
  };
  const newTableFixed = [newTable[0], newTable[1], ...names.map((f) => ledgerRow(f, fixRef))];

  const outLines = [...oldLines.slice(0, tStart), ...newTableFixed, ...oldLines.slice(tEnd + 1)];
  fs.writeFileSync(ledgerPath, outLines.join('\n'), 'utf8');

  const hasX = names.length - zeroSet.length;
  const ledgerCounts = {};
  for (const c of RUNTIME_CLASSES) ledgerCounts[c] = 0;
  for (const c of declLedger.values()) ledgerCounts[c] += 1;
  console.log(`台账已重写：${ledgerPath}`);
  console.log(`覆盖 ${names.length} 件（tools/ 全部 .js，含 lib-* 与装置自身，表内不设例外）；有读数 ${hasX} / 零读数 ${zeroSet.length}，合计 ${names.length}`);
  console.log(`归属类计数：${RUNTIME_CLASSES.map((c) => `${c}=${ledgerCounts[c]}`).join(' ')}；求和 ${RUNTIME_CLASSES.reduce((a, c) => a + ledgerCounts[c], 0)} ${unclassifiedLedger.length === 0 ? '== ' + names.length + '（未分类 0 ✓）' : '≠ ' + names.length + '（未分类 ' + unclassifiedLedger.length + ' ✗）'}`);
  if (zeroSet.length) console.log('零读数集合（下一轮校验优先级清单）：' + zeroSet.join('  '));
  if (problems.length === 0 && zeroSet.length === 0) console.log('（零读数集合为空：所有件都留下过可核对读数）');
}

// ---------- 入口 ----------
(async () => {
  const argv = process.argv.slice(2);
  const flags = new Set();
  const posArgs = [];
  let only = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') { only = (argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean); i += 1; continue; }
    if (a.startsWith('--')) { flags.add(a); continue; }
    posArgs.push(a);
  }
  const ledger = flags.has('--ledger');
  flags.delete('--ledger');
  ROOT = normalizeRoot(posArgs[0]); // 任务 1：仓库根单一真源（后续一切路径/CDP require 从它出）
  if (!fs.existsSync(ROOT)) fail(`仓库根不存在：${ROOT}`);
  if (ledger) ledgerMode(ROOT);
  else await runMode(ROOT, flags, only);
})().catch((e) => {
  if (e && e.identity) {
    console.error(`✗ ${e.message}`);
    console.error('退出码 3：双副本自检不过，本轮不产任何有效读数');
    process.exitCode = 3;
    return;
  }
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
