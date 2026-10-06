# 诊断与排查工具箱（工程面台账）

本文件登记 `tools/` 下每件诊断脚本测什么、判据落在哪一层、期望退出码是什么——写给要改代码或查问题的人。
使用者视角的功能与配置见 [README.md](README.md)，问题成因与解法见 [PITFALLS.md](PITFALLS.md)，版本沿革见 [CHANGELOG.md](CHANGELOG.md)。
新增诊断件请登记进本表（开发协议铁律 5，该协议本机维护、不随公开版发布）。

## 日志与工具箱

出问题时先看 **`<数据根>\showcase.log`**——安装版就是 `<安装目录>\data\showcase.log`（1.0.5 及以前的老结构在安装目录同级的 `<安装目录名>-data\data\`；1.0.48 及以前文件名是 `desktop-pet.log`）：
锁屏/唤醒、穿透状态每次变化、渲染端异常、渲染端无响应、旧数据迁移、退出收尾都会逐条记录。工具箱（纯 node，可直接对安装版运行）：

| 工具 | 用途 |
|---|---|
| `npm run ci`（＝`node tools/run-ci.js [ci.yml路径]`） | **出包闸门装置（票 11-U）**：从 `.github/workflows/ci.yml` **动态解析**全部纯逻辑件逐件跑（清单不手抄，ci.yml 增删件自动跟随），输出逐件 `rc` + 输出字节数（`Buffer.byteLength` 口径，不用会虚低的 `String.length`），末尾 `PASS n/N`，退出码取最坏值（断言失败/件自身崩→1；前置不满足→3 并明说「不算通过」）。**本地闸门：出包/覆盖安装前必跑，全绿是必要不充分条件**；GitHub Actions 那道只在 push 后跑，本仓无 remote 时不构成强制力 |
| `node tools/probe-log-visibility.js [仓库根]` | logLine 落盘可见性分流实验（票 11-T 任务 5，纯 fs 不接实例）：(a) 同进程 appendFileSync 写 200 次哨兵立刻 readFileSync 找回（复刻 logLine 写侧语义，探针写独立文件不污染判据日志，showcase.log 只落一行 [probe] 对照）；(b) 动态解析主进程写侧 DATA_DIR（只认 SHOWCASE_DATA_DIR 覆盖，PET_USER_DATA_DIR 不改日志落点）与工具读侧 LOG_CANDIDATES 是否同目录； (c) 逐件核对日志面判据读法（行切片件必须全量重读+行数切片，禁字节偏移裁剪与跨调用读位置状态）。结论：写盘微秒级可见、读写同文件、无读法缓存 ⇒「判据行晚出现」的延迟在触发链（渲染端 IPC 异步投递 + 主进程忙时排队），不在读写任何一侧 |
| `node tools/probe-window-style.js` | 读桌宠/锚点两个窗口的**真实**扩展样式，判断此刻是否真的点击穿透（外加光标位置与是否在窗内）。自动模式逐条校验日志句柄归属（PID 属于 Showcase.exe / dev electron.exe 且类名 `Chrome_WidgetWin_1`；映像名单走 `identity.EXE_BASENAMES`，迁移期旧名双认已随票 11-Q 撤），不过则报「桌宠进程未运行 / 句柄已被复用，读数无效」并 exit 1、不打表——防进程退出后句柄被系统复用、把别家窗口当桌宠读数 |
| `node tools/probe-window-style.js --watch` | 持续监测，**只在变化时打印**——适合「必须保持鼠标悬停在桌宠上才能复现」的场景 |
| `node tools/verify-taskbar-zorder.js` | 检查桌宠此刻在 z 链上是否压着任务栏（Shell_TrayWnd），打印两窗 TOPMOST 位与矩形重叠——「桌宠被任务栏盖住」的硬证据（PITFALLS §60；退出码 0=上层/不重叠，1=被盖） |
| `node tools/measure-ignore-storm.js` | 量化鼠标移动/拖拽期间的穿透状态翻转：约 20Hz 采样「穿透位(ex&0x20)+命中路由(WindowFromPoint 归属)」组合状态，任一场景翻转 >2 次判失败 exit 1（回归红线：200 次移动翻转应 ≤2；实测采样频率写进输出） |
| `node tools/measure-swallow-clicks.js [日志路径] [起始 ISO] [截止 ISO]` | **只读**分析运行日志，量化"透明区下方文件第一次点不中"（票 11-J）：①「光标离开辖区 → 真转穿透」延迟 p50/p90/p99/max（**日志尺**，与 `measure-exit-delay` 的受控尺不是一回事，别混引）；②被吞点击候选（状态=可交互且指针在所有上报盒外扩 10px 之外、已排除拖拽期整窗）+ **离盒距离分布**（≤8 / 9~16 / 17~40 / >40px）+ **按元素归因**（`pet-root`＝空隙/余量型，具名元素＝盒陈旧型）；③上报盒尺寸分布。**快照年龄闸门**：状态行只在穿透**翻动**那一拍落，所以取到的盒可能是若干秒前的——年龄 >500ms 的候选**只列不判**（PITFALLS §79），否则日志新鲜度会被读成上报新鲜度。后两个参数按**版本段**切（段边界取装机 exe 的 mtime），跨版本全量混算的数字不许当"改善幅度"引用。不带参数读开发态 `data/`，读实机把 `<安装目录>\data\showcase.log` 当参数传。退出码 0 出统计 / **1 状态行或点击行解析为零**（正则与日志格式不匹配时拒绝报"没有吞点击"）/ 3 日志不存在或时间参数无法解析 |
| `node tools/verify-asar.js [asar路径]` | **构建后、安装前必跑**：校验 `app.asar` 的 package.json 可解析、main 入口存在、12 个顶层源文件与项目源比对一致（行尾归一后比对：本机 `core.autocrlf=true` 下只差行尾不算错位，行中字符差仍必红——票 11-C；1.0.12 曾产出「索引正常、内容错位」的坏包，双击静默秒退，见 PITFALLS §4.9） |
| `node tools/verify-identity.js` | 名字一致性守卫：`identity.js`（名字单一真源，main 与 tools 共用）与 package.json 六项（name / build.productName / build.nsis.artifactName / build.directories.output / build.appId / build.nsis.guid）逐项比对，并断言 tools/ 下没有裸日志名字面量（读日志一律走 `identity.LOG_NAME`/`LOG_CANDIDATES`）。任一项不符 exit 1——漏改一处从静默失效变成必红（改名过渡期守卫，票 11-A） |
| `node tools/verify-autostart-migration.js` | 自启注册表读回纯函数回归（票 11-C 立件，票 11-Q 判据换轨）：`findRunEntry`/`isStartupApprovedEnabled` 对实机 `reg query` dump 形态夹具（行首 4 空格）的用例矩阵，含重写版「11-B 回归基线」——旧缺陷正则命中 0（夹具保真守卫）+ 活判据命中 1（行首空白容忍钉在还在跑的读回路径上），防再写出失配正则的红灯；另有 ⑤ 调用点定界（票 11-R）：main.js 不得出现 `pickLegacyRunEntries` 代码行调用（④ 退休的退出码牙齿）+ `ensureAutostartIntent();` 正向对照；真断言非零退出码 |
| `node tools/probe-login-item.js` | 只读三源对照探针（票 11-D）：并排打印裸 `getLoginItemSettings().openAtLogin`、带 `args` 的同名调用、以及 `reg query` 直读本项目 Run 值名的结果，用于判定「自启到底开没开」该信谁。三源一致 exit 0，不一致 exit 1 并指出差在哪一源。**全程只 get**：driver 生成前先自查探针源码里的禁词（`setLoginItemSettings` / `reg delete` / `reg add` / `WriteValue` / `DeleteValue`），命中即拒绝执行；临时 app 目录跑完自删（已在 .gitignore）。 |
| `node tools/verify-quit.js` | 触发 `app.quit()` 并测量进程树退干净所需时间（<1s） |
| `node tools/verify-recovery.js` | 打崩渲染进程/注入假死，确认自动恢复而不是整个程序退出 |
| `node tools/verify-passthrough.js` | 验证「指针不动但命中区变了」时穿透状态能否自愈（真实光标驱动；判据=穿透位+命中路由组合，不符 exit 1） |
| `node tools/verify-rebuild-grace.js [main.js 路径]` | 重建/首屏「命中区宽限期」纯逻辑回归（1.0.58 立件，1.0.59 适配数组）：从 `main.js` 提取 `graceJudgeBoxes` / `graceEndsOnReport` / `petBoxInUse` 等在 vm 求值，用实机日志的真实几何（首报 `389,448 122x152`、稳态 `320,443 260x157`）断言——宽限∪（上报数组 ∪ 兜底）首判时计数区那点算命中、常态判定退回上报数组、窗口左上透明空白仍判穿透、宽限∪只在重建后首次同步生效。**1.0.57 及以前没有这些函数 → 提取失败即 exit 1（自带判别性）**。**1.0.68 增票 11-T 守卫（分支定界 + 行为级）**：resync recreate=false 分支体与 second-instance 回调体内必须含 petHidden 判定、createPetWindow 必须 show: !petHidden、logHiddenMismatch 对账在位——提取/定界失败一律红，且 vm 行为级沙箱验证隐藏态下 showInactive 零次、second-instance 隐藏时改调 showPet（守卫写成永不成立表达式也会被行为级抓红；字面量断言一律剥行注释后匹配，防命中注释假绿）。**1.0.70/1.0.71 增抢锁门槛与提权哨兵守卫**：retry 必须被提权标志门槛化、非提权第二实例立即退出且退出前写显隐请求哨兵、bootApp 的 fs.watch 哨兵处理三重门槛（时效/second-instance 去重/petHidden）齐备——行为级五用例覆盖生效/过期/让路/可见态/读空。改动建窗/上报/命中区/单实例锁链路后跑一遍，已进 CI |
| `node tools/verify-hit-region.js [仓库根]` | 「被吞点击」判据（票 11-J 任务 1）：从 `renderer/pet.js` 提取 `interactiveBox()`、从 `main.js` 提取 `pointInBoxes()` 喂现场 3 真实元素矩形，断言元素本体判区内、**元素间透明空隙判区外**、上报盒外 ≥17px 判区外、脸本体判区内，并实算「吞点击面积 ÷ 元素真实面积」断言 ≤1.2。对 `git show 6df494f:` 改前副本 exit 1（判别性），已进 CI |
| `node tools/verify-click-passthrough.js --i-accept-real-input` | 真机终判（票 11-J 任务 1，**注入真实点击、需用户授权**，无授权 exit 3）：指针停在「改前环内/改后放行」的判别带上注入一次点击，断言 `WindowFromPoint` 的 GA_ROOT 第一次就归属桌面（Progman/WorkerW） |
| `node tools/measure-exit-delay.js [轮数]` | 「离开辖区 → 转穿透」延迟分布（票 11-J 任务 4；票 11-N 分组口径）：真实光标移到分带离开点，busy-loop 读原生穿透位取置位时刻；按实际距离分三组——A（≥13px 明确离开）断言 p50 ≤250ms、p90 ≤400ms、max ≤2000ms；B（2~12px FAST 环内+摆动带）只设 max ≤2000ms 长尾；C（≤JITTER_PAD=1 恒 inside）为正向对照「删失必须被观测到 ≥1」（该子带 3s 删失是正确行为，翻转仅漂浮相位间歇摆出、信息性；旧口径把 C 算进全样本长尾对它物理不可达，整件常年假红——已随 11-N 修正，分位数与阈值未放宽）。「改前 777/2480/9592」是并集时代旧尺子，只作历史对照不与新尺子混引。移动真实光标不点击；measure 级占用自检只警告 |
| `node tools/verify-unlock-position.js [仓库根]` | 解锁/唤醒位置归位判据（票 11-K）：vm 提取 `resolvePetPosition` 与延迟复查函数注入桩显示器，断言 defer 路径出屏不弹回主屏右下角（先按保存位置建窗 + 复查拉回）、真拔屏才归位默认且决策落日志、defer 传递链在位。桩含 `clearTimeout` 撤销语义 + 丢唤醒回归场景 8（票 11-M）+ 贴边容差回挪场景 9/10/11、拖拽屏幕钳制场景 12（11-K 真因修正续）与内容矩形模型场景 13（1.0.64 判据收紧：脸贴上缘、y 半幅 80/x 半幅 150 不变、模型接线断言）。场景 14（票 11-N）：`walkPetTo`/`fleeFromCursor`/`pet:scale-end` 三处摆放路径按**函数体定界**的接线双向断言——体内必须出现内容矩形串、不得出现视觉矩形串（含 `vis.` 悬空引用形态位，票 11-O；全局搜是恒绿守卫，防静默改回视觉矩形且无日志可查）；提取失败 exit 3 前置拦截。场景 15（票 11-O）：vm 沙箱**真调一次** `fleeFromCursor`（walkPetTo 桩成 spy），断言不抛异常 + dip == target + size/2——1.0.64 悬空引用 `vis` 在此必红，源码字符串断言抓不住。已进 CI |
| `node tools/verify-box-cadence.js [仓库根]` | 上报节奏判据（票 11-L / 11-J 任务 2b）：vm 提取 `interactiveBox`/`boxSignature`/`reportInteractiveBox` 注入桩 DOM，断言 rAF 帧驱动 + 3px 量化比对（漂浮缓动不帧级 IPC、显隐/弹跳突变一帧即报）、1s 兜底与主进程点名通道在位。已进 CI |
| `node tools/verify-ctrl-reconcile.js [仓库根]` | Ctrl 显隐状态对账自愈判据（票 11-S 任务 1）：vm 提取 `petCtrlState`/`pushPetCtrlState`/`trackPetCtrl`/`reconcileCtrlState` 注入可编程 `GetAsyncKeyState` 桩，断言两拍门槛（闩住后连两拍松开 ⇒ 恰一次 `down:false` 推送+对账日志、单拍必须零推送、真按住不误纠、丢 keydown 方向补全）与 `bootApp` **函数体定界**的 `setInterval(reconcileCtrlState, ≤2000)` 接线在位（全局 includes 是恒绿守卫）。探针读数计数防「静默 return」假绿。**1.0.68 补三条盲区（票 11-T 任务 4，校验轮⑦ 实测突变全绿的洞）**：桩记录 vk 实参并断言恒 0x11（读错 0x12=VK_MENU 必红）、拍序「不一致→一致→不一致」零纠正（一致拍必须重置 streak）、钩子只见过 CtrlRight 两拍松开后左右双侧清零（只清 left 的回归——右 Ctrl 闩死形态——必红）。21 断言，突变自证 M1-M4+W1/W3/W8。f31b6ba 的自愈路径此前零判据零日志。已进 CI |
| `node tools/verify-fallback-box.js` | 兜底可交互区派生纯逻辑回归（票 11-G 任务 3）：从 `main.js` 源码提取 `petFallbackBox` 切片在 vm 沙箱求值，断言兜底盒右下角贴住 (600,600)、scale=1 中心落在 [300..600]、全档在窗口内——1.0.55 及以前的写死常量 `{40,140,200x155}` 落在固定窗空白左上角。改动 `petFallbackBox` / `petVisualOffset` / `visualSize` 后跑一遍 |
| `node tools/verify-cursor-sync.js --face` | 验证页面重载后穿透状态是否立刻正确（真实光标预置宠物脸上，重载后断言恢复可交互，不符 exit 1） |
| `node tools/verify-main-passthrough.js` | 把页面换成空白页（渲染端彻底失效）后，用真实光标移动确认判定确实在主进程（断言不符 exit 1；跑完自动恢复页面） |
| `node tools/verify-rescue.js` | 救援链路渲染端一半：发 `pet:force-interactive` 后断言菜单窗口弹出且穿透状态保持可交互（不符 exit 1；主进程侧强制下发由真实热键触发，不在覆盖内） |
| `node tools/probe-mouse-event.js [秒]` | 打印全局钩子收到的每次鼠标按下（坐标/按钮/**clicks 连击计数**/ctrl·alt·shift），用来确认 uiohook 事件的哪些字段真的被填充 |
| `node tools/verify-walk.js` | 「走过去」纯逻辑自测（三击判定边界、冷却、路径时长钳制、按进度取点、朝向、落点钳制与副屏），改动 `walk.js` 后跑一遍 |
| `node tools/test-layout-menu.js` | 菜单弹出位置纯几何单测（13 用例：贴桌宠左右翼优先、四边钳制、竖屏、窄屏垂直避让、副屏负坐标），改动 `menu-layout.js` 后跑一遍 |
| `node tools/test-data-root.js` | 数据根定位单测（10 用例：程序在 `bin\` 下→容器根、旧结构→同级 `-data`、容器不可写→回退 userData、dev 项目根、环境变量对拍——旧名 `DESKTOP_PET_DATA_DIR` 必须被忽略、新名 `SHOWCASE_DATA_DIR` 必须生效），改动 `config.js` 的目录定位后跑一遍 |
| `node tools/verify-archive-import.js` | 压缩包导入回归（35 断言，纯 node）：现场构造真实 zip（adm-zip）与真实 7z/tar/tar.gz（7z-wasm 建包）再调真 `skins.importArchive`——断言魔数识别（含 GBK 乱码名/假 jpg+webp+avif、mp4 按品牌排除）、子目录平铺、复合流二段解包、`.cbz` 分派、文件夹收集 `collectImageFiles`（递归/空目录/混合路径/坏路径）、非图与 `__MACOSX` 垃圾跳过、穿越条目不外逃、重名 `-2`、无图抛错不留目录、扩展名拒收、`7zz i` 编解码清单含 Rar/Tar/GZip/BZip2/XZ、临时目录无残留。改动 `skins.js` 导入逻辑后跑一遍 |
| `node tools/probe-click-target.js [--click] [--at x y]` | 「点不动」取证：光标处的点击**会落到哪个窗口**（含上层层级）、可选注入一次真实点击 |
| `node tools/probe-passthrough-inputs.js` | 对账穿透判定的三个输入量（窗口 bounds / 真实光标 / 渲染端上报的 box），一眼看出谁和谁不一致 |
| `node tools/verify-passthrough-desync.js` | 穿透「单写入者」回归（真断言，1.0.57 起随写入口摘除改写；1.0.56 起退出码承载判据）：前置 ①光标压**上报盒中心**翻可交互，不满足 exit 3；断言 **A** 渲染端 `petAPI` 无 `setIgnoreMouseEvents`（接口层）、**B** 光标压在形象上 1.75s 期间 busy-loop 监视原生穿透位**从未**置上且结束时仍可交互（不变量层，抓 §52 的「该可交互却卡穿透」形态）、**C/D** `keepInteractive` 窗外保持与释放，任一不符 exit 1 并逐条打「哪一段、期望、实读」，末尾 `PASS n/N`。瞄准点每步重取（旧版瞄窗口几何中心落在固定窗空白处、测出假「卡死」，PITFALLS §76）。旧版 ②③「渲染端写一次→期望自愈」与 `--repro` 模式已随入口删除作废；「让渲染端穷举试写所有 petAPI」的设计也已废弃——那些 API 有真实副作用，试调用会改 scale/开菜单/结束拖拽，判「渲染端写不动」的终判层在 `verify-single-writer.js` 与 A，不在这里 |
| `node tools/verify-single-writer.js [仓库根]` | 穿透单写入者的**源码级守卫**（纯 node 零依赖，已进 CI）：preload 无暴露 / main.js 无该 ipc 处理器 / renderer 无调用；前两条是**正向对照**（主进程那个唯一写入者必须在位），防"读不到即绿灯"。改动 `preload.js`、`main.js` 的穿透写入路径后跑一遍；对 `git show` 出来的历史副本传根目录可做突变自证 |
| `node tools/probe-compat-layer-state.js` | 迁移期兼容层六件的**只读**状态探针（不写注册表、不删文件；票 11-Q 起逐项先探「接缝还在不在」）：在位项按到期判据给机器读数（旧 exe 名进程与容器 bin 文件、旧日志名 mtime「谁还在被写」、旧 Run 值名、旧 AUMID 键、旧名环境变量），已撤项报「已撤」+ 退休凭据——谁把退休的代码改回来，对应行立刻翻回「在位」。**任一需要的数据源取不到数即 exit 1**（拒绝在"读不到"上打绿灯） |
| `node tools/verify-pass-hold.js` | 穿透判定纯逻辑回归（**10 场景**，1.0.59 起含「FAST 环内静止指针 + 盒漂移」）：交互区边界抖动必须 0 次状态切换、`FAST_EXIT_PAD` 外真离开 1 拍内穿透、环内微移出界仍守 `PASS_HOLD_MS` 保持时间、真实进出与拖拽保持均正常。⚠ 它**手抄**了 `PASS_HOLD_MS`/`JITTER_PAD`/`FAST_EXIT_PAD` 等常数，改 `main.js` 的 `syncPetPassThrough` 那组参数必须同步这里 |
| `node tools/verify-peek.js` | 右键让路穿透（peek）端到端回归（需带 `--inspect=9229 --remote-debugging-port=9333` 的 dev 隔离实例；占用自检不满足 exit 3）：CDP 注入**右键**走真实触发链，断言 ①穿透位（WS_EX_TRANSPARENT）置上、②TOPMOST 位**保持置上**（让路穿透不动 z 序）、③未压底（z 链下一窗非桌面窗）、④渲染端 `body.peek` 变暗变透明类在、⑤peek 中段 1.2~1.85s busy 监视穿透位**从未被常态轮询翻回**（光标正压在桌宠上，抓 peek 守卫与记账脱节的回归）、⑥到点自动复原。6 断言，任一不符 exit 1 |
| `node tools/probe-layered-attr.js <hwnd> [...]` | 读任意窗口的扩展样式与分层属性（`GetLayeredWindowAttributes`：crKey/bAlpha/flags，出参预填哨兵）——「这窗会被 petCovered 排除还是算遮挡」的取证口径，判据见 `layeredVisuallyTransparent` 注释（PITFALLS §61 子坑 4） |
| `node tools/instrument-pet-mouse.js [install\|dump\|clear]` | 在桌宠页面装鼠标事件记录器（经 CDP），判定「页面到底收到了 down/up/click 里的哪些」 |
| `node tools/inject-click.js <x> <y> [按住毫秒]` / `--ctrl-triple <x> <y>` | 用 SendInput 注入真实点击 / 驱动「走过去」，用于没有真手时的自动化验证 |
| `node tools/move-cursor.js <x> <y>` | 把光标移到指定坐标（配合上面几个探针） |
| `node tools/verify-walk-visual.js [截图路径]` | 走过去的**渲染端**验证（需带 `--inspect`/`--remote-debugging-port` 启动）：从主进程发 `pet:walk` 后断言 move 状态、朝向翻转、走路动画，并截图 |
| `node tools/verify-petcovered-alpha.js` | petCovered 按 alpha 判定的三窗回归（自起 dev 实例 + 隔离数据目录与 Chromium userData）：SLWA alpha=255 造窗压住桌宠必须在 1.5s 防抖链路内触发「置顶重申」且归名正确；alpha=128 与 ULW per-pixel 造窗必须零候选零重申（BongoCat 互踩闪烁回归防线，PITFALLS §61 子坑 4）。改动 `petCovered` / `layeredVisuallyTransparent` 后跑一遍。**前置：须无其它桌宠实例在跑**（装机版或 dev）——spawn 前自检进程，占用直接 exit 3 并打印 pid，不等超时（PITFALLS §65 子坑 6：单实例锁活在 Chromium userData 里，双实例还会在 TOPMOST band 顶插队污染 z 序判定）。exit 码：0 全过 / 1 断言不过 / 2 超时或异常 / 3 实例占用。exit 0 时自动删除 `%TEMP%` 的 `petcover-alpha-*` 隔离目录；失败退出保留现场并打印 showcase.log / electron-stdout.log 完整路径便于查因（查因后手动删） |
| `node tools/measure-walk-perf.js [--local]` | 量走路的两个旋钮：`setPosition` 单次开销、主进程定时器实际能到多少 Hz（决定 `WALK.frameMs`）；`--local` 不开 Electron 也能测定时器精度 |
| `node tools/verify-hide.js` | 隐藏/托盘的自动核验：走真实菜单路径隐藏 → 断言窗口只隐藏不销毁、进程没退 → 注入 F24 键确认后台仍在计数 → 恢复显示 |
| `node tools/verify-scale.js` | 缩放链路回归（需带调试端口的隔离实例）：真实合成拖拽全管线（mousedown→mousemove 即时改 transform→mouseup scaleEnd 带值持久化）、拖拽全程窗口纹丝不动（固定 600×600 零原生操作）、容器右下角钉 (600,600)（右下角锚定证明）、transform 即时应用、config 松手才写盘、上下限钳制 + 拖过量程 limit 红显（松手复原）、滚轮路径已删防回归、Ctrl 手柄显隐与拖手柄手势（pet:ctrl 通道注入）、手柄边长=计数栏×0.65、Ctrl+按脸拖动不再缩放（手势已移交）。**位置断言自设起点方向对拍（票 11-N，替换旧的无条件「petPosition 不变」——它缺「起点离左/上缘够远」前提，贴左缘缩放回挪（1.0.64 内容矩形口径）会被误报成回归）**：T1 非贴边 (700,600) 缩放后零位移（锁「回挪不得无条件平移」）；T2 贴左缘 (−200,−200) 必须等于产品同款算法期望（contentX = x + (600 − round(300·s))、dx = max(0, wa.x − contentX)，s 取缩放后新值）且日志出现「缩放后回挪」；红法三突变已验（删回挪→T2 日志红、无条件平移→T1 红、仅 x 轴无条件→T1 红 T2 绿）。37 断言不符 exit 1，跑完自动恢复 petScale=1；双实例场地读数可信度降一级 |
| `node tools/verify-autostart-elevation.js` | 开机自启提权判定链路回归（真函数断言 + 隔离实例，无真 UAC）：`shouldRequestElevationOnBoot` 真值表六象限（开机标记/配置位/提权产物标记/假值边界）、Run 键 args 标记到达主进程 argv、autoStartAdmin=false 时未发起提权、实例存活；10 断言不符 exit 1，9229 被占 exit 3。真 UAC 链路（勾选→重启→弹窗）留实机验收 |
| `node tools/verify-flee.js [等待秒]` | 「鼠标停留 5 秒自动让开」端到端四断言（票 11-O 升级）：真实光标停到命中区中心（渲染端上报盒定位，非窗口几何中心）→ ①日志出现「让开 NNNpx」决策行；②**同一秒**出现「走过去:」行（1.0.64 悬空引用让让开后零执行，决策行与执行行是否成对就是分水岭）；③窗口终位 ≈ 让开目标按内容矩形换算的期望窗口位（±40px）且位移分量符号与方向一致；④期间日志 `uncaughtException` 计数增量为 0——兜底吞异常会把功能失效藏成一行日志。**必须留着 cursorFleeEnabled=true 跑**（false exit 3；这条路径此前不在任何判据的执行路径上）。等走路动画完成再取终位；占用闸门 assertNoBlockingInstances：装机版在跑 exit 3 不许绕 |
| `node tools/verify-flee-interaction.js` | 「点击互动就不让开」的回归：按住左键 8 秒不得让开、松手后重新计时并触发、每 2 秒点一次连点 10 秒不得让开。瞄点走 `tools/lib-aim.js`（票 11-S 任务 2：上报盒脸中心每步重取 + 「落点不在形象上」exit 3 前置） |
| `node tools/probe-alt-tab.js [--pet]` | 枚举 Alt-Tab 候选窗口（可见 && 非 TOOLWINDOW && 未 cloak，z 链遍历）：`--pet` 只显示本应用窗口。§67 Alt-Tab 回归的实测依据（锚点窗摘 TOOLWINDOW 后进候选、桌宠窗不进） |

> 退出码语义（票 11-G 任务 4 起全项目诊断件统一，`tools/lib-occupancy.js` 提供共用占用自检，
> `tools/lib-container.js` 提供共用装机容器定位——从 HKCU 卸载键反推 `<容器>\data`，取不到时调用方必须明打「未取到安装容器」且不得据此打绿灯，
> `tools/lib-aim.js` 提供共用瞄点与「落点必须在形象上」前置（票 11-S 任务 2））：
> `0` = 断言全绿；`1` = 断言失败（脚本自身异常也落 1，stderr 会打「脚本异常：<原因>」行与断言失败区分）；
> `3` = 前置不满足——调试端口连不上、或已有桌宠实例在跑（verify-* 回归件必拦并打印占用 pid/映像名；
> probe/measure 测量件只打「读数可能被污染」警告、不改退出码；**CI 那十三件纯逻辑件不接实例、无此检查**）。
> 把前置失败记成 0、或把断言失败混进 3，都算判据违规。
>
> 调试端口注意：`--inspect=9229` 可能被别的程序或 Windows 保留端口段占用（报 `permission denied`），
> 启动后确认 stdout 里有 `Debugger listening on …` 才算连上；相关工具的端口可在脚本顶部改。

## 开发辅助工具（dev-only，非诊断件）

上表是排查诊断工具箱，按开发协议铁律 5（该协议本机维护、不随公开版发布）保持纯 node、零 Electron 依赖。以下件**不是诊断件**、不进上表，属开发辅助，边界在此登记（2026-10-02 票 9 顺带 f 处置；每条的取舍理由随条目）：

- `electron tools/preview-stats.js <输出.png> [--dark]`（配套 `tools/mock-preload.js`）：统计面板视觉预览——用**真 Electron 渲染管线**加载 stats.html、注入 mock 数据并截图（轻量替代浏览器截图）。必须跑在 Electron 里（contextBridge/preload/capturePage 都是 Electron API），改造成纯 node 会砍掉它唯一的价值，故登记为 dev-only 例外；注意用法是 `electron …` 而非 `node …`。
- `node tools/gen-emoji-catalog.js`：换皮肤的 emoji 目录**生成器**——联网（jsdelivr 的 unicode-emoji-json）重新生成 `renderer/emoji-catalog.js`，仅在目录结构变更时手动跑。运行期红线（零网络请求）约束的是产品运行期，不含本件。
- ~~`tools/fake-main-server.js`~~：已删除——它模拟的 helperServer 属 2026-09-23 整体移除的游戏模式提权 helper（PITFALLS §4.7 注记），再无可连的消费方，死件；当时删配套工具漏掉了它。
