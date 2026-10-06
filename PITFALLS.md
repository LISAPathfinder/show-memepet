# 踩坑与修复记录（PLAN.md 交付后的迭代阶段）

> 记录 M1~M9 里程碑交付后，反馈迭代过程中踩过的坑。每条按「症状 → 根因 → 解法」组织，
> 引入对应提交号。改动前先扫一遍本文档，避免重复踩坑。
> 时间范围：2026-09-13（提交 1a8a180 起）。

## 一、打包与依赖（安装版专属问题，dev 模式发现不了）

### 1. build.files 白名单漏文件 → 安装版启动即崩
- **症状**：安装版双击弹「Uncaught Exception: Cannot find module './gamepad-xinput'」。
- **根因**：新增本地模块时只写了代码，没同步加进 `package.json → build.files`。dev 模式文件都在项目目录下感知不到，打包后 app.asar 里没有该文件。
- **解法**：`gamepad-xinput.js` 加入 files。**新增任何 `require('./xxx')` 本地模块时必须同步更新 build.files**，并打包后用 `npx @electron/asar list` 验证。
- **同类坑（2026-09-23）**：白名单不止漏「被 require 的模块」，**资产目录也漏**——`assets/skins/`（内置皮肤）一直没登记，
  于是安装包里一个皮肤都没有，只有 dev 模式能看到（用户问「能保证每个安装包都有 ac_color 吗」才发现）。
  新增资产目录时要一并登记 `"assets/skins/**"`；且注意**打包版的皮肤扫描只看用户数据目录**（`skins.js` 的
  `defaultSkinRoot()` 对打包版返回 `SKIN_ROOT`），所以光打进包还不够，还要在首次运行时把内置皮肤释放到数据目录
  （见 main.js `installBuiltinSkins()`，用 `builtinSkinsVersion` 记批次，删掉的不复活）。

### 2. 原生模块必须 asarUnpack
- **症状**（预防性修复）：修完 files 后下一个必炸点是原生模块。
- **根因**：`.node` 二进制无法从 asar 内加载；koffi 还带自己的预编译 DLL 目录。
- **解法**：`asarUnpack` 需包含 `node_modules/koffi/**`、`node_modules/uiohook-napi/**`、`node_modules/sherpa-onnx-*/**`。新增原生依赖时同步加。

### 3. Worker 线程脚本不要从 asar 里读
- **症状**（预防）：`new Worker(path)` 对 asar 内路径的兼容性不可靠。
- **解法**：`asr-worker.js` 加入 asarUnpack，加载时用 `__dirname.replace('app.asar', 'app.asar.unpacked')` 取物理路径（打包态），dev 态直接用相对路径。

### 4. npm 安装脚本拦截 / Electron 下载慢
- `npm install-scripts approve <pkg>`（写入 package.json `allowScripts`：uiohook-napi / electron / electron-winstaller）。
- `.npmrc` 写 `electron_mirror=https://npmmirror.com/mirrors/electron/`。

### 4.5 不要装 `node-global-key-listener`：会被 Defender 当键盘记录器隔离
- 症状：Windows Defender 报 **`Trojan:Win32/KeyLogger!AMTB`（严重）**，命中
  `node_modules/node-global-key-listener/bin/WinKeyServer.exe`；npm 缓存里的同一个包还会报
  `HackTool:MacOS/KeyLogger!rfn`（`%LOCALAPPDATA%\npm-cache\_cacache\tmp\...`）。
- 判定：**误报，而且它不属于本项目**。三条依据：
  1. 该包的功能就是安装**全局键盘钩子**，与键盘记录器行为同源 → 撞上 Defender 的行为启发式（微软签名页写着 `Aliases: No associated aliases`，是通用签名特征，不是具体家族）。
  2. 它不是本项目的依赖（依赖只有 `koffi` / `sherpa-onnx-node` / `uiohook-napi`），不在 `package-lock.json`，也没有任何包依赖它；代码里**只有注释**提过它（`keylistener.js`、`PLAN.md` 里那句"降级方案"），所以 `WinKeyServer.exe` 从未被执行过。
  3. 安装包里没有它：`npx asar list ... | grep -i global-key` 为空（包里只有 `uiohook-napi`）→ **发给别人的安装版不会触发这个告警**，只有开发机的 `node_modules` 会残留并告警。
- 处理：别装、别用。真要换钩子实现就换别的 N-API 钩子或签名过的辅助进程（`keylistener.js` 已做接口隔离，换实现不用动 main.js）。
- 顺带：本项目实际使用的 `uiohook-napi` 同样是全局键盘钩子，**也可能被激进杀软盯上**——用户机器上出现过 `pet 渲染进程退出: killed exitCode=1`（外部杀进程，不是程序自身），怀疑与此有关。排查"进程莫名被杀 / 钩子失效"时，先去 Defender 的「保护历史记录」和安全软件日志里搜程序名，再决定是否把安装目录加白名单（属安全取舍）。

### 4.6 宿主 shell 里的 `ELECTRON_RUN_AS_NODE=1` 会让 `npm start` 变成纯 node 运行
- **症状**：`npm start` 秒退，报 `TypeError: Cannot read properties of undefined (reading 'setPath')`（main.js 顶部 `app.setPath(...)` 那行），堆栈里还带 `node:electron/js2c/node_init`，看着像 Electron 内部出错。
- **根因**：当前会话的环境变量里有 `ELECTRON_RUN_AS_NODE=1`（IDE/宿主注入的），Electron 二进制被当成普通 node 跑：此时 `require('electron')` 返回的是**包路径字符串**而不是 Electron API，解构出的 `app` 就是 undefined。
- **解法**：启动时把这个变量**删掉**再跑 —— `env -u ELECTRON_RUN_AS_NODE npm start`。注意 `ELECTRON_RUN_AS_NODE=`（赋空值）**没用**：Electron 只看这个变量**存不存在**，不看值。
- 判据：只看 `app.setPath of undefined` + 堆栈里的 `node:electron/js2c/node_init` 就能认出来，别去查项目代码。
- **第二种形态（2026-09-22 打包时遇到）：打包版 exe 同样中招**。`./win-unpacked/desktop-pet.exe` 会变成一个挂在 node REPL 上的进程：任务管理器里**只有 1 个进程**（没有 GPU/渲染子进程）、**不建数据目录**、不写日志、窗口永不出现 —— 非常容易被误判成「这次打包坏了」。判据就是「只有 1 个进程 + 没有 `<exe 旁>/data` + 没有日志」这三条同时出现。解法同样是 `env -u ELECTRON_RUN_AS_NODE ./desktop-pet.exe`。
- 打包版冒烟定型动作（本轮沉淀）：`env -u ELECTRON_RUN_AS_NODE ./win-unpacked/desktop-pet.exe --inspect=9229` 起进程，然后查三件事：① `<exe 旁>/data/desktop-pet.log` 出现锚点/桌宠 HWND；② 日志里没有「托盘图标创建失败」；③ 经调试端口确认 `nativeImage.createFromPath(process.resourcesPath + '\\app.asar\\resources\\icon.ico')` 非空（本轮实测 256×256）—— 托盘图标是**新增的文件依赖**，专门验它有没有真的进包。

### 4.7 electron-builder 自动解包只挑「含 .node 的包」，其纯 JS 依赖不会跟着出来（helper 1.0.1 计数失效的直接根因）
> **【2026-09-23 注记：「游戏模式」机制已整体移除】** 按用户要求，1.0.5 起删掉「游戏模式」提权辅助进程
> （helper.js、本地回环 socket、菜单开关），管理员权限场景统一走菜单「以管理员身份重启」整体提权；
> 配套工具 repro-packaged-helper.js / verify-unpack-sim.js / verify-game-mode-helper.js 一并删除。
> 本节保留为历史记录——「asar.unpacked 里的脚本被纯 node 执行时依赖树必须人工核对解包」这条教训
> 对任何 asar.unpacked 场景仍然成立（`node_modules/node-gyp-build/**` 的 asarUnpack 登记也因此保留，
> uiohook-napi 仍靠它加载原生模块）。
- **症状**：游戏模式提权辅助进程永远连不上，日志固定停在「已请求提权启动辅助进程…」→ 15 秒后「未连上，回退本地钩子」。UAC 是确认过的，也不是 fuse 问题。
- **复现**（不用提权就能抓）：`cmd /c set "ELECTRON_RUN_AS_NODE=1" && <打包exe> <asar.unpacked>/helper.js --port … --token …`，stderr 立刻给真相：`Error: Cannot find module 'node-gyp-build' ← uiohook-napi/dist/index.js`。
- **根因**：electron-builder 自动把**含 `.node` 原生二进制**的包解包到 `app.asar.unpacked/node_modules/`（uiohook-napi、koffi 因此都在），但被解包包的**纯 JS 依赖不跟随**——`uiohook-napi` 唯一的运行时依赖 `node-gyp-build`（纯 JS，负责从 prebuilds 加载 .node）留在 asar 内。主进程跑没事（Electron 的 require 能读 asar），而 helper 是 `ELECTRON_RUN_AS_NODE=1` 的**纯 node**，没有 asar 支持，require 链在这里断掉，进程 1 秒内退出。主进程侧只看到「没连上」，两边现象对不上，这就是它难查的原因。
- **解法**：package.json `build.asarUnpack` 显式登记：`"node_modules/node-gyp-build/**"`。**判据**：凡是「asar.unpacked 里的脚本要被纯 node 进程执行」的场景，把该脚本的完整 require 依赖树逐一核对解包目录（`ls app.asar.unpacked/node_modules`），不能信自动解包。
- 验证基建：`tools/repro-packaged-helper.js`（起假 server + 打包 exe 以 RUN_AS_NODE 跑 helper，看 hello 是否回传；支持传 exe/helper 路径，可指到 win-unpacked 复测产物）——**已随机制移除**（见本节注记）。

### 4.8 NSIS 自定义脚本（nsis.include）的三个拦路坑：注释续行符 / 未被引用的函数 / 卸载器的函数名规则

electron-builder 支持用 `nsis.include` 注入自定义 NSIS 脚本（本项目 = `resources/installer.nsh`，用来接管安装目录自动化，见 §29.8）。它把 **警告当错误**（`warningsAsErrors` 默认开），下面三条都会直接中断打包，且报错信息不指向真正原因：

1. **注释行以反斜杠结尾** → `warning 6050: comment contains line-continuation character, following line will be ignored`。NSIS 把行尾 `\` 当续行符，`; … data\、skin\` 这类注释会吞掉下一行。**注释别以反斜杠收尾**（写「bin 子目录」而不是「bin\」）。改了第 43 行又会在第 44 行复发——一次用 `grep '\\$'` 全扫。
2. **定义了却不被引用的函数** → `warning 6010: install function "instFilesPre" not referenced - zeroing code`。本脚本用 `!define /redef MUI_PAGE_CUSTOMFUNCTION_PRE <自己的函数>` 覆盖 electron-builder 的页回调后，它自带的 `instFilesPre` 就没人调用了。解法：在自己的回调里 `Call instFilesPre`——既消警告，又复用它「路径不含程序名就补一层」的逻辑（注意它内部会改写 `$0`，要放在 `Push $0` 之前调用）。
3. **自定义脚本会同时进入「安装器」与「卸载器」两遍构建** → `Note: uninstall functions must begin with "un.", and install functions must not` + `Error - aborting creation process`。安装器专属的宏与函数必须包在 `!ifndef BUILD_UNINSTALLER` 里（electron-builder 模板自己也是这么做的）。

- 挂载点备忘（按执行时机）：
  - `customHeader` — 生成脚本最前部，但**晚于** `assistedInstaller.nsh` 的 `!include`，所以改 MUI 页回调（`MUI_PAGE_INSTFILES` 已展开）来不及；
  - `preInit` — `.onInit` 里，**静默安装（/S）也会执行**，适合处理 `/D=` 指定的目录；
  - `customPageAfterChangeDir` — 目录页之后、instfiles 页之前，**正好用来 `!define` MUI 页回调**（`MUI_PAGE_CUSTOMFUNCTION_PRE`）；
  - `customInstall` — **太晚**（在 `installApplicationFiles` 之后，文件已释放），改 `$INSTDIR` 无意义。
- 验证手段：`installer.exe /S`（静默安装不弹界面、退出即完成）可以在临时目录跑真实安装做端到端验证——**务必用改了 appId/productName 的隔离构建**（`--config.appId=… --config.productName=… --config.directories.output=…`），否则会卸载掉本机正在用的正式安装。
- **两个易错点（2026-09-23 踩到）**：
  1. **「目录页显示容器」和「安装目标下沉到 bin」是两件事，必须拆开挂在不同时点**：
     `petNormalizeInstallDir`（`customInit` 里，只做「去掉尾部 bin + 补程序名层」）负责让目录页显示 `<安装目录>`；
     `petResolveInstallDir`（GUI 走 instfiles 页 PRE 回调、静默走 `preInit` 里的 `${If} ${Silent}`）才真正下沉。
     把下沉放进 `preInit` 无条件执行，目录页就会显示 `…\bin`（用户直接反馈「为什么选择目录这里还是会出现 bin」）。
  2. **别把「静默安装慢」当成「卡住」**：本项目 113MB 的包在开着实时防护的机器上要 **1 分 50 秒**才装完。
     验证脚本给 90~240 秒超时会把它杀掉，留下「bin 建了但 data/skin 没有」的**假现场**，极易误判成脚本 bug（为此刻意绕了一大圈，
     最后靠临时 FileWrite 日志才确认逻辑本来就是对的）。**静默安装验证一律给 ≥5 分钟**。
     另外：electron-builder 的静默安装**不采纳 `/D=` 参数**（一律装到默认 `%LOCALAPPDATA%\Programs\<name>`），
     想让它装到指定目录只能靠注册表里已有的旧安装位置。
  3. **想改 `$INSTDIR` 让目录页显示别的路径？先确认它会被谁覆盖**：electron-builder 的 `multiUser.nsh` 里
     `setInstallModePerUser` 会在**安装模式页确认时**用注册表 `InstallLocation`（= 上次安装位置）重设 `$INSTDIR`——
     这个时点**晚于** `customInit`，所以在那里做的「去掉尾部 \bin」会被无声覆盖。
     实测证据（在每个执行点各写一个诊断文件打印 `$INSTDIR`）：`customInit` 出口已是容器目录，
     但目录页仍显示 `…\bin`，且 instfiles 回调里又变回 `…\bin`。
     **结论**：「保留 bin 结构」与「升级时目录页显示容器目录」不可兼得（除非放弃用注册表记录安装位置，而那会连累卸载）。
     全新安装（注册表无记录）时目录页显示的本就是容器目录，只有升级场景会显示上次的 `…\bin`——
     那正是最终安装位置，用户直接下一步即可。

### 4.9 构建产物可能「索引正常、内容错位」——构建后必须校验 asar（1.0.12 实翻车）

- 症状（2026-09-25 00:13 构建的 1.0.12）：**双击安装版毫无反应，桌宠不显示**；日志里连启动第一条
  「锚点窗口 HWND=…」都没有。干净环境命令行启动复现：**0.6 秒静默退出，退出码 0、无 stderr**。
- 根因：那次构建产出的 `app.asar` **头部索引完好、但内容区错位**——`package.json` 的 367 字节内容区
  实际是「package.json 中后段 + preload.js 开头」的拼接（非法 JSON），Electron 读不到 `main` 入口 →
  静默退出。asar 的头部索引完好不代表内容对：**「`npx @electron/asar list` 能列出文件」远远不够**。
- 排查路径（复用价值高）：
  1. 先看安装版日志有没有「锚点窗口 HWND」——没有 = 进程没跑到建窗口，别往穿透/渲染端方向查；
  2. 命令行干净环境启动复现，拿到「秒退 + 退出码 0 + 零输出」三件套（退出码非 0 才像代码崩溃）；
  3. 按 asar 头里的 `offset/size` 直接抠出 `package.json` 原始字节 `JSON.parse`——一步定性。
  注意：本机命令行环境自带 `ELECTRON_RUN_AS_NODE=1`（agent 沙箱），直接跑 electron 系 exe 会变成
  纯 Node 模式的假进程（无窗口、无日志、挂着不退），**必须 `env -u ELECTRON_RUN_AS_NODE`**，否则测量全废。
- 解法：重新构建（走镜像绕过下载超时，见下），**安装前先 `node tools/verify-asar.js`**（2026-09-25 新增，
  校验 package.json 可解析 + main 入口存在 + 9 个顶层源文件与项目源逐字节比对一致）。
  成因未能完全定论（同流程 1.0.10/1.0.11 产物均正常，疑为偶发写入错位）——所以防线只能放在「构建后校验」。
- 附：electron-builder 重新构建时在下载环节卡 10 分钟超时（electron zip 与 winCodeSign 缓存不全 +
  GitHub 不通）。带国内镜像环境变量跑：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
  （32 秒跑完）。另外实测 26.15.3 静默升级 `/S /D=<bin>` 落位正确（注册表旧 InstallLocation 兜底），
  未复现 4.8「不采纳 /D=」的旧行为，但仍以注册表为准。

## 二、Electron API 行为（版本实测为准，文档不可全信）

### 5. setDisplayMediaRequestHandler 签名是两参
- **症状**：点扬声器后永远停在「正在启动」，无错误无超时（加了超时后表现为「音频捕获请求超时」）。
- **根因**：Electron 44 实测签名是 `(request, callback)`，代码按三参 `(request, options, callback)` 解构 → `callback` 拿到 undefined → 授权回调永不提交 → getDisplayMedia 悬挂。日志里出现 `callback is not a function` 才定位到。
- **解法**：`(_request, ...rest) => { const callback = rest.length === 1 ? rest[0] : rest[1]; ... }` 兼容两种签名（33756bf 前身 d1d0bfd）。**教训：涉及回调的 API 必须在 handler 里第一时间调用一次 callback 并打日志验证**。

### 6. getDisplayMedia 必须在用户手势内同步发起
- **症状**：先 `await` 别的异步操作（如等模型加载）再调 getDisplayMedia → 请求永久挂起。
- **根因**：Chromium 要求 transient user activation；await 链超过激活窗口后手势失效。
- **解法**：点击处理器里**第一行**就发起 `getDisplayMedia(...)`（拿 promise），再 await 模型加载，最后 `Promise.race([streamPromise, 10s超时])`。另加音频轨校验（`getAudioTracks().length === 0` 时明确报错，否则 ASR 吃静音永远无字幕）。

### 7. 显示媒体处理器必须保证 callback 恒被调用
- **症状**：getSources 失败时请求无限悬挂。
- **解法**：handler 内 `.catch` 兜底 `callback({ video: null })`（让请求以错误结束而不是挂死），renderer 侧 catch 显示错误。

### 8. 重活必须挪 worker 线程
- **症状**：点击扬声器后整个应用冻结 2~4 秒。
- **根因**：sherpa 模型加载（190MB，1~4s）同步跑在主进程，阻塞所有窗口的 IPC。
- **解法**：`asr-worker.js`（worker_threads）承载模型加载与解码，主进程只做消息转发。**新增任何 CPU 密集步骤（模型推理、大文件解析）先想 worker**。注意：`feedAudio` 从「返回值」变成「onResult 回调」，调用方语义要跟着改。

### 9. BrowserWindow API 细节
- **置顶层级**：`setAlwaysOnTop(true, 'screen-saver')` 才能压过任务栏和其他自置顶窗口（游戏内可见的前提）。
- **不抢焦点**：`focusable: false` 使点击/拖动桌宠不把全屏游戏切后台（鼠标输入不依赖焦点）。
- **frameless 窗口没有原生缩放边框**：`resizable:false` + 透明窗需要自绘边缘把手；把手做在「透明窗缘」用户够不着，必须压在可视框边上。

### 10. moveBy 类 IPC 必须按发送方窗口处理
- **症状**：拖字幕条，移动的是桌宠。
- **根因**：`pet:move-by` 处理器写死 `petWindow.setPosition`，字幕条复用了同一 IPC。
- **解法**：`BrowserWindow.fromWebContents(event.sender)` 按发送方窗口操作；drag-end 位置持久化也要判断 `win === petWindow`。

### 55. Display 对象没有 `width`/`height`：`NaN` 传进 `setBounds` 不报错、静默变 0
- **症状**：菜单弹出后钉在**屏幕最顶端**、只剩一个条目高（竖屏用户截图实锤）。初始 600ms 兜底 show 用的占位布局是对的，坏在渲染端上报内容尺寸后的重排。
- **根因（两层叠加，第一层还掩盖了第二层）**：
  1. `screen.getDisplayNearestPoint()` 返回 **Display 对象**，只有 `workArea`/`bounds`/`size` 字段，**没有顶层 `width`/`height`**。`wa.height` 得 `undefined`，`undefined - 24 = NaN`。
  2. `NaN` 进 `Math.min`/`Math.max` 全程传染不报错，最终 `setBounds({ y: NaN, height: NaN })` —— Electron/Chromium 对 NaN 参数**不抛异常，静默转成 0**。窗口于是被钉到 y=0、高度趋 0。
- **排查教训**：窗口「出现在坐标 0 / 尺寸归零」是数值链路被 NaN 污染的强指纹——先查上游算式里有没有 `undefined` 参与运算，别先怀疑布局算法。同类代码全项目 grep `getDisplayNearestPoint|getPrimaryDisplay`，核对每处是否都取了 `.workArea`。

## 三、Windows 平台机制

### 11. UIPI 完整规则（游戏场景的核心约束）
- 游戏以**管理员运行**时：普通权限进程的键盘/鼠标低级钩子收不到其输入（计数失效）；文件拖放也被拦（拖拽导入失效）。手柄不受影响——XInput 是主动轮询不走钩子。
- **解法**：菜单「以管理员身份重启」提权。代价：提权后收不到资源管理器拖放。README「已知限制」有完整表格。
- **真·独占全屏**：任何覆盖层不可见（BongoCat 同样不行）；FPS 锁鼠标时指针到不了桌宠，任何覆盖层都无法被点击。

### 12. 管理员提权：不要用 PowerShell 子进程
- **症状**：气泡有、UAC 不弹、日志不生成——三个症状并存。
- **根因**：`spawn('powershell.exe', ['-Command', <含双引号路径的脚本>])` 在 Windows 参数转义下命令被搅碎，try/catch 未执行；换成 `-EncodedCommand` 后整个子进程被安全软件静默拦截（编码命令+RunAs 是典型拦截特征）。
- **解法**：koffi 直接调 `ShellExecuteW(0, 'runas', exe, params, null, 1)`（33bdc 系 b932dc6）——与右键「以管理员身份运行」同一系统调用，无子进程可拦。返回码 ≤32 失败（5=用户取消 UAC）。
- **配套**：旧实例等新实例触发 `second-instance` 再退出（`adminRelaunchPending` 标志），新实例 400ms 重试抢锁 20s；提权确认用 `spawnSync('fltmc')` 成功与否判断，启动后气泡「已以管理员权限运行」；全程写 `%TEMP%\desktop-pet-admin.log`（requested/OK/错误信息三态）。

### 13. schtasks / reg 命令在 Git Bash 下被路径转换破坏
- **症状**：`schtasks /Query` 报「无效参数 - 'D:/Environment/Git/Query'」。
- **解法**：`MSYS2_ARG_CONV_EXCL='*'` 前缀，或双斜杠 `//TN`。非提权 shell 删 RunLevel Highest 的任务会「拒绝访问」，需 UAC 提权（PowerShell `Start-Process -Verb RunAs -Wait`）。

### 14. 管理员权限的安装器/应用会「继承提权」
- 安装时若以管理员跑安装包，`runAfterFinish` 启动的应用也带提权。判断当前是否提权：`spawnSync('fltmc', {stdio:'ignore'})` 退出码 0 = 管理员。

### 60. 置顶会「过期」：explorer 把任务栏抬回 TOPMOST band 顶部，桌宠被盖在下面
- **症状**（用户报，2026-10-01）：桌宠创建时明明是 `screen-saver` 级置顶（§9），平时却会被任务栏盖住；把桌宠拖到任务栏区域后点一下任务栏/开始菜单最明显，托盘展开浮层（Win+B）弹出也会盖。
- **根因（机制实验实锤，见下）**：任务栏（Shell_TrayWnd）与桌宠**同在 TOPMOST band**，band 内 z 顺序由「最近一次 SetWindowPos」决定。explorer 在用户点任务栏/开始菜单/通知动作时会把自己重新抬到 band 顶部；桌宠 `focusable: false`（WS_EX_NOACTIVATE）永远不能靠交互把自己抬回来——被压下去就一直被盖，直到下一个锁屏/唤醒事件（那些路径会重申置顶）。**平时没有任何机制对抗这种反扑**，才是缺陷本体。
- **解法（最终版）**：主进程每 **500ms** 重申一次，且重申必须**「先 `setAlwaysOnTop(false)` 再 `(true,'screen-saver')`」**——直接重复同 level 的 setAlwaysOnTop 在高频连续调用下会变空操作（5 轮反扑闭环实测 4 轮无效；单次调用实验曾误判它有效），先出 band 再进 band 才必然重调 SetWindowPos 排回 band 顶部。500ms 使反扑后最坏半秒内恢复，点任务栏的动效期间就压回去，肉眼无感（Bongo Cat 类 overlay 同样靠高频重申对抗，Windows 没有系统级「绝对置顶」）。仅窗口可见时执行；隐藏到托盘不唤醒。
- **机制实验方法**（临时 electron 脚本即可，勿再猜）：koffi `SetWindowPos(taskbar, HWND_TOP, ..., SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` 把任务栏抬到 band 顶部模拟反扑（返回 true）→ 从桌宠 hwnd 沿 `GetWindow(GW_HWNDPREV)` 走 z 链，遇 Shell_TrayWnd 即「被盖」。**闭环验收要连跑多轮（反扑→600ms→查）**，单轮单次会漏掉「重复调用变空操作」的行为。注意：①对**隐藏**窗口设置 screen-saver 级不进 TOPMOST band，实验必须先 show 再 set；②验证脚本抓句柄**只准扫目标实例自己的日志**——安装版日志里的有效句柄排前面会把整个测试带偏（实测 5 轮测的全是旧版 3 秒周期，1/5 通过率恰好等于 600/3000 的踩中概率）。
- **验收**：`node tools/verify-taskbar-zorder.js`（z 链硬证据，退出码 0=上层/不重叠、1=被盖）；实机动作 = 把桌宠拖到任务栏上点一下任务栏/展开托盘，半秒内应压回、肉眼基本无感。

> **闪烁排查全景（1.0.21 → 1.0.25，2026-10-01~02）**——同一种「闪」背后叠加了多个独立闪烁源，五轮逐个实证、逐个消除。每一步都修掉了实测确认的真实问题（没有白做），但直到 1.0.25 才命中用户主诉场景的根因；前四轮的价值在于**逐步把重申链路洗干净**，1.0.24 复测时段的零重申日志才让 §62 的真根因得以暴露：

| 版本 | 改动 | 修掉的真实问题（各有实证） | 与主诉「面板拉宽/拖动、光标扫过就闪」的关系 |
| --- | --- | --- | --- |
| 1.0.22 | 无条件重申 → 按需（`petCovered`） | 无反扑时每 500ms 无谓折腾两次 z 序，与任何矩形相交窗口在 DWM 合成上打架（§61 主坑，dev 实锤） | 是**独立闪烁源之一**；修掉后主诉仍闪 → 主诉另有根因 |
| 1.0.23 | petCovered 排除 `WS_EX_LAYERED` | BongoCat 全屏透明分层窗恒被误判为「压住」桌宠（1.0.22 实机日志实锤：矩形相交≠视觉遮挡） | petCovered 正确性修复；但关掉 BongoCat 仍闪 → 非主诉根因 |
| 1.0.24 | 幻影类排除 + own-PID + 零面积跳过 + 3 拍防抖 + 肇事归名 | IME 幻影窗打字期恒触发重申（16:52 暴风实锤）、本进程透明窗误判、瞬态遮挡逐拍互踩 | 又一组真实独立闪烁源；修掉后用户复测时段**日志零重申** → 重申链路彻底洗清，暴露真根因 |
| 1.0.25 | 穿透翻转不再挂/摘 `WS_EX_LAYERED`（koffi 直写，只翻 TRANSPARENT） | Electron `setIgnoreMouseEvents(true)` 无条件挂 LAYERED，每次「可交互↔穿透」翻转都切换 DWM 合成路径 = 整窗重合成 = 闪 | **主诉根因**：拖动/缩放面板时光标必然扫过桌宠命中区 → 高频翻转 → 稳定闪 |

- **方法论教训**：①同一症状下可能叠加多个独立闪烁源，逐个实证、逐个消除是正确路径，但要每轮自问「这个修复能完整解释用户主诉吗」——前四轮的修复都没解释「光标扫过就稳定触发」，这个未解释的残差就是根因还在的信号；②自动化测不出主诉，是因为从没模拟「光标真实扫过命中区」这个动作——**用户对操作细节的补充（哪只手、扫过哪、怎么拖）比任何仪器都快**。

### 61. §60 的 500ms 重申必须「按需」：无条件重申会跟矩形相交的窗口闪成一片
- **症状**（用户报，2026-10-01，1.0.21）：统计面板拉宽到与桌宠窗矩形相交——哪怕相交处全是桌宠的**透明像素**——面板疯狂闪烁（每秒 2 次的节奏）。
- **根因**：§60 的重申是**无条件**的，无反扑时也每 500ms `false→true` 折腾两次 z 序。平时看不出影响；一旦有普通窗口与桌宠**窗口矩形**相交（注意是矩形，与透明像素无关），DWM 每次都要重新合成相交区域 → 相交区每秒闪 2 次。
- **解法（1.0.22）**：按需重申。`petCovered()`：从桌宠 hwnd 沿 `GetWindow(GW_HWNDPREV)` 扫 TOPMOST band 内的窗口，存在**可见 + 非 cloak + 矩形相交**的窗口才执行 false→true；检测异常时返回 true 退回无条件重申（宁可多动不可失守）。普通窗口永远在 band 之下盖不住桌宠，所以统计面板这类相交**永远不触发重申**，闪烁源消除；反扑/真遮挡仍半秒压回（重申间隔 ≥500ms，不属于 §60「高频连续调用变空操作」的失效场景）。
- **子坑 1：「桌宠是不是最前」不能看 `GW_HWNDPREV == NULL`。** 实测桌面常年有其他 TOPMOST 窗口（另一实例、常驻置顶小工具），桌宠永远不是全局最前 → 守卫恒不成立，退化回无条件重申。判定必须是「有没有**相交**的可见窗口压着」，而不是「是不是第一名」。
- **子坑 2：cloak 窗口——`IsWindowVisible=true` ≠ 肉眼可见。** Windows 系统壳窗（`Windows.UI.Core.CoreWindow`，SearchUI/StartMenuExperienceHost 宿主）平时被 DWM **隐身**挂在整个屏幕（实测 2560×1440 全屏矩形）、TOPMOST band 内且 `IsWindowVisible` 返回 true——按「可见+相交」判定会被它恒触发重申。必须用 `DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED)`（dwmapi.dll，attr=14，非 0 即被隐身）排除。这是 10 秒高频抓现行 + 进程内诊断日志才定位到的：外部枚举走 `IsWindowVisible` 看不见问题，进程内外结论相反。
- **子坑 3（验证环境噪声）**：dev 验证时若安装版旧实例还在跑，它的无条件重申会把 band 顶不断「插队」到 dev 桌宠前面（band 顶插入永远排最前，与矩形无关），两实例互踩让 z 序采样刷屏；桌宠 `walk` 又会自己走动。排障结论只信：**目标实例自己的日志**（数据根仍按 §29.8——`PET_USER_DATA_DIR` 只隔离 Chromium userData，日志/统计仍在项目 `data/`）+ 长窗口统计（前后计数差）而非单点采样。
- **子坑 4（1.0.22 实机回归实锤）：layered 透明窗的矩形相交≠视觉遮挡。** 用户装 1.0.22 后闪烁依旧——安装版日志 500ms 恒刷重申，外部枚举 PREV 链 5 轮稳定命中 `UnityWndClass`「BongoCat」：**全屏 (0,-1)-(2560,1439) 的透明 TOPMOST 分层窗**（`WS_EX_LAYERED|WS_EX_TRANSPARENT`，ex=0x80028），且 BongoCat 自己也高频重申置顶——它每秒多次插队到 band 顶排到桌宠前面，桌宠 petCovered 恒 true 跟着重申，两个透明窗互踩把相交区闪成一片。修法（1.0.23）：petCovered 再排除 `WS_EX_LAYERED`——透明像素的矩形相交没有视觉意义；不透明系统窗（任务栏 ex=0x88）保留判定，反扑压回不受影响。1.0.22 的 dev 验证为什么通过：BongoCat 的 z 序是动态的（它自己也在重申），采样窗口恰好没撞上它在桌宠前面的时刻——**环境类验证必须长窗口统计，且尽量复刻用户真实桌面（同位置 + 同常驻软件）**。
- **子坑 5（1.0.23 实机回归实锤：IME 幻影窗——「关掉 BongoCat 还闪」的真相）。** 用户装 1.0.23 后关掉 BongoCat 仍闪。直读安装版日志：16:52:22-28 连续 13+ 条 @500ms 重申暴风，与用户打字时段吻合。真凶：Windows 输入法伴生窗 `Default IME` / `MSCTFIME UI`——`IsWindowVisible=true`、TOPMOST、**非 layered**、矩形相交，但没有视觉内容（Chromium 自己的遮挡判定同样忽略它们）；**打字期间恒命中** → petCovered 每拍 true → 2Hz 重申暴风。dev 为什么复现不了：CDP 自动化从不打字（dev 侧 BitBlt+GetDIBits 客观测量四场景 A/B 完全一致，零重叠特异性闪烁——先客观排除 dev 环境，再直读实机日志找暴风时段，是这轮的正确定性路径）。修法（1.0.24）四层：
  1. `PHANTOM_CLASSES = {'Default IME','MSCTFIME UI','Ghost'}` 按类名排除。Ghost 是系统给分层/失响窗创建的伴生窗（TOPMOST、可见、非 layered、同矩形），dev 实测真会触发，一并入列；
  2. **own-PID 排除**：Electron 44 的透明窗没有任何样式位可认——`transparent:true` 的 BrowserWindow 实测 `ex=0x8`（无 WS_EX_LAYERED、无 WS_EX_NOREDIRECTIONBITMAP，Chromium 用 DComp 把 alpha 画在普通窗面上），样式上与不透明窗无从区分，只能按进程归属排除本进程窗口；
  3. 零面积窗跳过（无视觉内容，不算遮挡）；
  4. **3 拍（1.5s）防抖 + 肇事归名落盘**：streak==1 记「置顶遮挡候选(1/3)：类名 @矩形」，持续 ≥3 拍才执行重申并记「置顶重申：…压回 band 顶」。就算将来冒出未知元凶，日志直接写出肇事类名，不再靠猜。代价：任务栏反扑压回 0.5s→1.5s（肉眼基本无感）。
  - koffi 排除矩阵（dev 全 PASS）：静置零触发 / 本进程透明窗（CDP 造）零触发 / 外来不透明 Static 触发+归名正确（证明检测链路活着）/ 外来分层窗及其 Ghost 伴生被排除 / **真 Default IME 类窗**（RegisterClassW 注册同名类 + DefWindowProcW 作窗口过程 + TOPMOST 可见压住桌宠）零触发——幻影排除路径拿到真窗实证。
  - koffi 造真 IME 类窗的定型写法（绕开 proto 两个坑）：`WNDCLASSW.lpfnWndProc` 声明为 **`'uintptr'` 字段**，直接赋 `GetProcAddress(user32, 'DefWindowProcW')` 的裸地址——根本不需要 `koffi.register`/proto；`RegisterClassW` 参数声明具体类型 **`'WNDCLASSW *'`** 直接传 struct 对象（声明 `'void *'` 传对象报 `Unexpected Object value`，`koffi.address()` 也只收指针类型不收 struct）。另外 func() 声明必须在 `koffi.struct()` 之后（声明期解析类型名）。
  - 客观闪烁测量的方法学：GetPixel 逐点 ~10ms/点（约 0.6Hz），测不了 60Hz 闪烁；**BitBlt+GetDIBits 整块回读**可达 ~90-114fps，对补丁块做亮度差分 + 闪烁帧占比 + 均值跳变即可量化。注意桌宠 flee/walk 会自己动，实验要逐帧 SetWindowPos 钳位。
- **验收**：①静置（无遮挡）应用日志 10 秒内零「置顶重申」；②把桌宠挪到与任务栏相交 + koffi 模拟反扑（§60 方法），1.5 秒内压回、日志恰好多一条重申记录；③实机 = 统计面板拉宽压到桌宠上方，不再闪烁；④**实机打字场景**：在输入框连续打字（含中文输入法组词），桌宠与面板相交区不再 2Hz 闪；若还闪，看日志「置顶遮挡候选/置顶重申」行的归名类名直接定位下一元凶。

### 62. 穿透翻转的隐形代价：Electron `setIgnoreMouseEvents(true)` 无条件挂 `WS_EX_LAYERED`，每次翻转 = DWM 合成路径切换 = 闪烁（1.0.24 仍闪的真因）
- **症状**（用户报，2026-10-02）：1.0.24 后仍闪。两条决定性线索：①「不仅拉宽拉高，**拖动统计面板移动**也闪」；②「**鼠标光标移到桌宠上方一定区域会稳定触发**——这可能也是之前一直测不出来的原因」。同时 1.0.24 安装版日志（用户复测时段）**零「置顶遮挡候选/重申」** → 重申链路（§61）彻底洗清嫌疑，闪另有根因。
- **根因**：独立 Electron 窗实测（`tools/tmp-ex-probe2.js` 思路，koffi 读 GWL_EXSTYLE）：`setIgnoreMouseEvents(false)` → ex=0x8；`setIgnoreMouseEvents(true)` → ex=0x80028——**带不带 `{forward:true}` 都无条件挂 `WS_EX_LAYERED`**。本窗是 DComp alpha 贴普通窗面的透明窗（§61 子坑 5：ex=0x8 无 LAYERED），于是每次「可交互 ↔ 穿透」翻转都在「DComp 窗面」与「分层重定向位图」两条 DWM 合成路径之间切换 → 整窗重新合成 → 视觉上就是一次闪烁。用户拖动/缩放面板时光标必然扫过桌宠命中区（§46 的命中判定以光标位置为准），状态高频翻转 → 相交区稳定闪。**之前一直测不出来**：自动化从没模拟过「光标真实扫过命中区边界」这个动作。
- **修法（1.0.25）**：主进程 `nativeSetIgnoreMouseEvents(win, ignore)`——koffi 直接 `SetWindowLongPtrW`，**只翻 `WS_EX_TRANSPARENT`（纯鼠标消息路由标志，不涉及 DWM 合成），永不挂/摘 LAYERED**。`forward`（穿透时向页面转发 mousemove）自 §38 改为 250ms 真实光标轮询后已无消费者，LAYERED 的 alpha hit-test 没有别的依赖。TRANSPARENT 位生效无需 FRAMECHANGED，不带它（NCCALCSIZE 重算反而可能引起重绘）。§52 的「主进程唯一写入者 + petIgnoreSent 记账」逻辑原样保留，只换底层下发。字幕条已移除（2026-09-22），桌宠窗口 4 处调用点 + 1 处 IPC 通道全换。
- **子坑 1：目标态必须从「干净基线」重算，不能在 cur 上做增量。** 第一版写 `base = cur & ~LAYERED; next = ignore ? base|TRANSPARENT : base`——LAYERED 本就不在时 false 分支 `next===cur` 提前 return，**TRANSPARENT 永远摘不掉**（实测：日志翻转 7 次而 ex 恒 0x80000a8，①③ 探针读数相同才暴露）。正确写法：`base = cur & ~(LAYERED|TRANSPARENT)`，`next = ignore ? base|TRANSPARENT : base`。
- **子坑 2：CDP `Input.dispatchMouseEvent` 不走 Windows hit-test。** 穿透态（WS_EX_TRANSPARENT 挂着）下合成点击照样到达渲染端——**不能用「点击有反应」验证穿透状态**；穿透验证必须读真实 ex（`probe-window-style.js` 口径）或看消息是否落到下层窗口。
- **子坑 3：验证脚本会被主进程轮询「纠正」。** 渲染端直发穿透状态 150ms 内可能被主进程 250ms 轮询按记账（petIgnoreSent）写回——探针读到「写回后的值」不等于「写位失败」。隔离办法：看写位后**第一拍**的 ex 是否变化，或临时让光标处于会被轮询认同的位置。
- **验证**：①BitBlt 亮度采样（64fps × 12s）+ SetCursorPos 驱动 8 次进出 → 日志 7 次真实翻转（ex 实测 0x8000088 ↔ 0x80000a8）、**亮度跳变帧 0 个**、LAYERED 出现 0 次、翻转时刻 ±250ms 零对齐跳变 → 翻转零视觉副作用；②功能回归：可交互态 TRANSPARENT 摘除 ✓、穿透态挂上 ✓、CDP 点击到达渲染端 ✓、§52 记账纠正机制正常 ✓。
  - **⚠ 本条验证 ② 已被 §63 改判**：「CDP 点击到达渲染端」不能当穿透证据（本条子坑 2 自己就这么写的），实测 1.0.25 的穿透是假的；「穿透态挂上 ✓」只证明了样式位写对，没证明鼠标路由生效。另：①里「翻转零视觉副作用」成立，但根因段那句「LAYERED 挂/摘 = 合成路径切换 = 闪烁」在 GDI 代理窗上复现不出来（见 §63 与本节末那条 GDI 代理窗实测），因果表述要限定为「Electron/DComp 窗上翻 LAYERED 实测会闪」。
- **教训**：把「状态翻转」当成无视觉副作用的操作之前，先确认底层 API 是否在翻转窗口的**合成属性**（样式位、层、重定向）；日志里状态机正确 ≠ 视觉无扰动——用户看到的「闪」永远要以像素测量收尾。
- **实机确认（2026-10-02 02:03）**：用户覆盖安装 1.0.25 后确认修复（「终于修好了」）。闪烁排查五轮闭环收官：1.0.21 无条件重申 → 1.0.22 按需 → 1.0.23 排 layered → 1.0.24 排幻影+own+防抖 → 1.0.25 穿透翻转不切 LAYERED。前四轮都在「重申」这条因果链上找补，真根因在另一条链路（穿透翻转）——用户的行为细节（光标扫过哪、怎么拖面板）是最终定位的决定性输入。

### 63. §62 的穿透是假的：`WS_EX_TRANSPARENT` 单挂（无 `WS_EX_LAYERED`）不产生鼠标路由（2026-10-02 独立校验轮实测）
- **症状**（用户实测，2026-10-02）：1.0.25 装好后不闪了，但把光标停在桌宠**透明区**点下去——**点中桌宠**，下层桌面图标点不到。
- **根因**：`WS_EX_TRANSPARENT` 对**非分层窗**只是 GDI 绘制顺序标志，不参与鼠标路由；Windows 的整窗点击穿透要 `WS_EX_LAYERED` 一起才生效（Electron 挂 LAYERED 不是多余动作）。§62 修法把「翻转 LAYERED」当闪烁源整条摘掉，顺带把穿透语义也摘了：可交互态与穿透态在命中路由上变成同一件事。**「不闪」与「穿透失效」是同一个改动的一体两面**——§62 那句「`WS_EX_TRANSPARENT` 只是鼠标消息路由标志，翻转不改变合成路径，零视觉副作用」（main.js:1193）前半句是错的。
- **三条一手读数**（互不依赖）：① 用户真实点击落在桌宠；② 桌宠顶层窗 `ex=0x080000a8`（`TRANSPARENT` 有、`LAYERED` 无），koffi `WindowFromPoint` 在 300×300 三个取样点全部返回渲染子窗 `Chrome_RenderWidgetHostHWND`；③ 样式矩阵探针的 B 格（仅 `TRANSPARENT`）双证人 `WindowFromPoint` 命中自身 + `WM_NCHITTEST=HTCLIENT`。对照组：锚点窗 `ex=0x000800a0` 走旧 Electron API，LAYERED 在位。
- **为什么五轮都没测出来**：① §62 验证 ② 的穿透侧证据是 CDP 合成点击，而同一节子坑 2 明令「CDP 点击不走 Windows hit-test，不能用『点击有反应』验证穿透」——自己违反了自己的纪律；② 当时那 5 件穿透类诊断脚本全是打印式、`process.exit(0)` 收尾、判据文案静态不参与判定，结构上不可能变红（已由 `b005465` 补断言 + 退出码 + 命中路由层判据修掉）。**用户「终于修好了」确认的是不闪，穿透没有对应验收动作**——修复轮的验收清单必须包含「这条改动让哪个功能消失」的反向问题。
- **状态**：已修（方案 1 落地，1.0.26 / 提交 804563d，见 §65）。票 3' 的真 Electron 窗三态实测结论（三条读数都抄在本条里）：**方案 1（开窗即挂 `WS_EX_LAYERED`、之后只翻 `TRANSPARENT`）拿到真窗正例**（α2 态 `WindowFromPoint` 归下层窗 + 注入点击 Δ=0，且双抓亮度差 ≤0.01 说明裸挂 LAYERED 不杀渲染内容）；方案 4（per-pixel ULW）就地降级——桌宠要的是**整窗**不接鼠标，per-pixel 只让透明像素穿透、emoji 本体照样挡点击，与 §63 想解决的问题同源。原文「剩最后一件待验：挂 LAYERED 的时机必须在开窗时（γ1 渐变仅 1 轮样本）」已由 §65 验收 e 定案：α/γ 各 5 轮，γ（运行时补挂）4/5 轮出现 20~31 帧跳变簇、MAD 差 5 倍，**必须在开窗时挂**。
- **顺带拿到的两条分层事实**（原票报的「本机 `SetLayeredWindowAttributes` 参数被系统性清零」是调用侧声明问题，不是平台异常，已用同机 koffi 3.2.1 复跑推翻）：① SLWA 的 `crKey`/`bAlpha` 写入后 `GetLayeredWindowAttributes` 精确读回（255/128/1 三档 + colorkey 全对）；② **真 Electron 窗的 LAYERED 不带任何 SLWA 属性**——锚点窗 `GLWA ret=false` 且三个出参零写入（哨兵值原样）。这条是 `petCovered` 能不能按 alpha 收紧的关键：`ret=0 → 当透明排除`（保住 §61 子坑 4 的 BongoCat 与 Electron 自家透明窗），`ret=1 且 flags&LWA_ALPHA 且 alpha==255 → 判不透明遮挡`。
  - **⚠ 本条的「用 ret 分类」已被票 3' 与校验轮共同推翻，改用 flags 兜**：同为 LAYERED 窗，自造「`CreateWindowExW` 即带 LAYERED、从不调 SLWA/ULW」的隐藏窗读 `ret=false`（哨兵原样），而真 Electron 窗被外部补挂 LAYERED 后读 `ret=1` 且 key/alpha/flags 全零——**`ret` 在同类窗之间不稳定，不能当分层实现方式的判别位**。判别的不变量只有一条：只有显式 `SLWA(LWA_ALPHA, 255)` 才判不透明遮挡，其余（`ret=0` 或 `flags` 不含 `LWA_ALPHA`）一律按透明排除。票 5 的 `layeredVisuallyTransparent` 两支都通向排除，所以 §61 防线不依赖 `ret`；但注释里把 Electron 窗归到 `ret=0` 那一支的写法要改（findings 第八节改判 1/2）。
- **教训**：把某个样式位当作「只是路由标志、无副作用」之前，先确认操作系统有没有把这个语义绑定在别的位上；「翻转不再有视觉副作用」≠「翻转还在改变行为」——行为侧必须有一条**不经过被改 API 自身**的证据（本轮的正确答案是 `WindowFromPoint` 归属或真实注入点击）。

### 64. 工具脚本两个新坑（票 5 实测轮，2026-10-02）
- **子坑 1：宿主环境继承的 `ELECTRON_RUN_AS_NODE` 让 electron.exe 以纯 node 模式启动。** 症状：`tools/verify-petcovered-alpha.js` 自起的 dev 实例秒炸 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`（main.js 里 `app` 是 undefined）。根因：WorkBuddy 等 Electron 宿主自身的子进程（shell/脚本）环境里带着 `ELECTRON_RUN_AS_NODE=1`，spawn electron 时被继承。解法：spawn 前从 env 里 `delete childEnv.ELECTRON_RUN_AS_NODE`——**置空串不够**（Electron 的 HasVar 只查存在性，空串仍算已设）。适用面：一切「工具脚本里 spawn electron」的场景。
- **子坑 2：日志增量断言的字节/字符口径错位。** 症状：回归件轮询日志增量时，已落盘的「置顶重申」行读不到（差点把绿判据误报成红）。根因：基线取 `statSync().size`（**字节**），增量读 `readFileSync(path, 'utf8')` 之后 `slice(base)` 按**字符**（UTF-16 code unit）切——日志含中文时同一行的字节数远大于字符数，字节基线在字符坐标里直接越过目标行。解法：读原始 Buffer、`Buffer.slice(from)` 之后再 `toString('utf8')`，基线与读取必须同口径。

### 65. 方案 1 落地：LAYERED 开窗即挂永不摘、之后只翻 TRANSPARENT——穿透与零闪烁同时成立（1.0.26，票 6）
- **症状**：1.0.25 起穿透是假的（§63：光标停桌宠透明区点下去点中桌宠，下层桌面图标点不到）。
- **根因**：§62 的修法把 LAYERED 当闪烁源整条摘掉。整窗点击穿透 = `WS_EX_LAYERED` + `WS_EX_TRANSPARENT` 缺一不可（TRANSPARENT 对非分层窗只是 GDI 绘制顺序标志，不参与鼠标路由）；而 Electron/DComp 窗上翻转 LAYERED 实测会闪（§62）。两个约束合起来唯一解：**让 LAYERED 成为常量**（开窗即挂、永不摘），高频翻转只发生在无视觉副作用的 TRANSPARENT 位上。
- **解法（1.0.26，提交 804563d）**：`nativeSetIgnoreMouseEvents` 基线永含 LAYERED——`base = (cur | WS_EX_LAYERED) & ~WS_EX_TRANSPARENT`，false 分支只摘 TRANSPARENT、true 分支只加 TRANSPARENT，两个分支都保 LAYERED。`next === cur` 提前返回必须保留（§62 子坑 1 的防护方向反转后仍要：可交互态再调 false 才是真空转，防止每拍重写；反过来 LAYERED 被外部清掉时 next 必然 ≠ cur，写位自动补挂——本函数因此兼任兜底重挂点）。挂位时机 = `createPetWindow` 建窗后、`loadFile` 前的第一次写位（首帧合成前，票 3' α 形态）。所有窗口重建路径（recreatePetWindow / 托盘显示 / 锁屏解锁 / 唤醒）都走 createPetWindow → 新 HWND 开窗即挂，**不需要**额外的重挂代码。
- **子坑 1（读数别名，判绿判红看位不看整值）**：真窗实测可交互态 `ex=0x08080088`、穿透态 `0x080800a8`——比 1.0.25 读数（0x080000a8）多 `0x800 = WS_EX_NOACTIVATE`（focusable:false 的建窗参数），与写路径无关；历史探针读数缺它是因为 patch 实例建窗参数不同，不要拿整值相等做断言。
- **子坑 2（γ 形态的代价不止「一次渐变」）**：外部摘 LAYERED → 2s 后补挂（=γ1 运行时补挂形态），5 轮里 4 轮出现 **20~31 帧跳变簇**（集中在补挂后 1~3.4s，Δ±20 灰度），另 1 轮亮度稳态永久下移 -13.8（有动画状态混淆，不定案但方向一致）。α/γ 的 MAD 均值差 5 倍（0.26 vs 1.38）。「挂位必须开窗时」由 γ1 的 1 轮样本定案为 5+5 轮（findings 第八节）。
- **验收（全部一手实测，dev 实例 + 安装包）**：①机器侧命中判据 2/2——透明点 `WindowFromPoint` 的 `GA_ROOT` 归下层窗（点得穿），脸中心归桌宠窗（点得中），穿透/可交互两态 LAYERED 都在位；真人终判（透明区点击必中下层桌面图标、emoji 点击必中桌宠）**已由用户执行并确认**（2026-10-02，1.0.27 实机；用户对校验轮摊出的 A 判据回话确认，原话「这轮结论我已经做过了」→ 追摊 A/B 后选 A；校验轮未代做该动作，故此处记的是用户确认而非机器读数）；②5 件套 5/5 EXIT=0（verify-passthrough / verify-main-passthrough / verify-cursor-sync --face / verify-rescue / measure-ignore-storm）；③**12 分钟**外部 koffi watch（2781 采样 @250ms）覆盖静置/页面重载/拖动/隐藏→托盘显示/真实锁屏→解锁，**LAYERED 被外部清掉 0 次**，两条重建路径的新 HWND（0x4402de / 0x4502de）开窗即挂都在位；④闪烁复验 5 轮 × 320 帧（40fps BitBlt+GetDIBits）+ 每轮光标 8 次进出，**跳变帧 5×0**（MAD 0.26~0.74，动画噪声档）——§62 换来的零闪烁没丢。
- **子坑 3（1.0.26 用户回归实测：600ms 离开保持把拖放后的第一次点击静默吃掉）**：用户装 1.0.26 后报「点桌面文件要等 1 秒左右才能点中」。链路实测（SendInput 注入 + 日志判据）排除了翻转与 hit-test 延迟（进向 p50=94ms、WFP 与样式同步、D=0ms 点击 4/4 有效）；真因是 §52 的 PASS_HOLD_MS=600ms 对**所有离开**一视同仁——拖桌宠盖住文件后光标大幅移向文件，状态仍维持可交互 600ms，期间点击被桌宠矩形吃掉且零反馈，叠加人手重试间隔体感 ≈1s。修法（1.0.27）：`DISTANT_MOVE_PX=40` 快速通道——inside=false 且光标相对「最后一次 inside 的窗口内坐标」位移 >40px 必然是真实离开（§52 防的抖动形态是「光标不动、box 边界 ±6px 动」，那种场景位移≈0），立即穿透不吃保持；抖动防线不动（verify-pass-hold 场景 1/2 原样绿）。出向延迟实测 600~720ms → p50=78ms（8/8）。注意 x/y 是窗口内坐标，flee/walk 移走窗口时相对坐标同样大变，此时立即穿透语义也成立。**verify-pass-hold.js 判定内核已同步**（场景 3/4 按新契约重写为「大位移 1 拍穿透 / 微移出界仍守 600ms」，新增场景 10 拖放后点击）。
- **子坑 4（工具侧，两轮测量白做的教训）：x64 `SendInput` 的 `dwFlags` 在 INPUT 偏移 20 而非 8**——INPUT 结构 type(0..3)+pad(4..7)，MOUSEINPUT union 从 8 起（dx 8 / dy 12 / mouseData 16 / **dwFlags 20**）。把 LEFTDOWN 写到偏移 8 实际发的是零标志空事件，SendInput 返回值还正常——0/32「点击无效」假读数浪费两轮测量。判据侧也要防假绿：注入类测量的「点击有效」判据必须独立验证注入真的进了系统（如读全局钩子计数），否则测量 bug 会伪装成被测对象的 bug。
- **子坑 5（verify-cursor-sync 的偶发红）**：脚本把光标停在脸上跨过 5 秒时，「鼠标停留 5s 让开」会把窗口挪走，重载后读数光标下已无桌宠 → 判「该可交互时穿透」假红。单独重跑即 PASS。排查此类脚本红先查日志有没有同时段「停留超过 5s → 让开」，别急着怀疑写路径。
- **子坑 6（校验轮发现，日常状态必踩）：自起实例的回归件必须隔离 Chromium `userData`，只隔数据根不够。** 症状：装机版在跑时 `node tools/verify-petcovered-alpha.js` 必报 `✗ 30s 内渲染端 pet.html 未就绪`（exit 1），文案指向「渲染端起不来」。真因：spawn 只传了 `DESKTOP_PET_DATA_DIR`（搬应用数据根），没传 `PET_USER_DATA_DIR`（搬 Chromium `userData`，main.js:35-36）——**单实例锁活在 userData 里**，dev 实例抢不到锁，走 main.js:1663 的重试循环，20s 后 `app.quit()`。判据：子进程 stdout 出现 `before-quit: 开始收尾` 而没有任何窗口日志。解法：`childEnv` 加 `PET_USER_DATA_DIR: tmpData`；并在 spawn 前检测已有实例、直接把原因打出来，别让人等 30s 超时。**凡是「自己起一个实例再连 CDP 测」的工具件，都要过这一关**（§64 子坑 1 的 `ELECTRON_RUN_AS_NODE` 是同一族的第二类启动期假失败）。
- **子坑 7（测量法本身要证据，校验轮自打一轮）：Git Bash 里 `tasklist //FI "IMAGENAME eq desktop-pet.exe"` 会静默返回空，害我把「桌宠在跑」判成「零进程」。** 症状：同一句命令报 0 个进程，而 `verify-petcovered-alpha.js` 的占用自检当场列出 5 个 `desktop-pet.exe` 的 pid；`powershell Get-Process desktop-pet` 也列出 5 个。根因：Git Bash 的路径转换把 `/FI` 变成 `D:/Environment/Git/FI`（报「无效参数/选项」），而带 `//` 转义的写法虽能执行，过滤器却匹配不到任何东西、只输出「没有运行的任务」——**错误与「真的没有进程」两种情况在 stdout 上长得一模一样**。解法与判据：① 计数类命令必须先用**正例**自证（明知进程在跑时跑一次，看它是否真数出来），拿不到正例就判该测量无效；② 进程枚举改用进程内 API（`K32EnumProcesses` + `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW`，本件已这么写），它不吃 shell 引号、不吃 PATH，且能读到提权进程 PowerShell 读不到的映像路径（实测 5 个里 PowerShell 有 2 个 Path 为空，脚本 5 个全认得出）。适用面：一切「用 shell 命令做存在性否定」的判断——包括本仓库里所有「先确认没有别的实例在跑」的前置检查。
- **教训**：修 A 丢 B 的结构性风险第二次出现（§62 修闪烁丢穿透）——修复轮的验收清单必须把上一轮牺牲掉的行为列为必测项，且判据要落在不经过被改 API 自身的语义层（`WindowFromPoint` 归属 / 真实注入点击）。样式位的「常量化」（挂一次不再动）是把「翻转有代价」类问题变成非问题的通用解法：把会闪的动作压到只发生一次，把高频动作留给实测无副作用的位。保持时间这类「防抖代价」也要定期重审：它防的场景（光标不动 box 抖）和它误伤的场景（光标真走了）可以用位移判据分开，不必一刀切。——修复轮的验收清单必须把上一轮牺牲掉的行为列为必测项，且判据要落在不经过被改 API 自身的语义层（`WindowFromPoint` 归属 / 真实注入点击）。样式位的「常量化」（挂一次不再动）是把「翻转有代价」类问题变成非问题的通用解法：把会闪的动作压到只发生一次，把高频动作留给实测无副作用的位。保持时间这类「防抖代价」也要定期重审：它防的场景（光标不动 box 抖）和它误伤的场景（光标真走了）可以用位移判据分开，不必一刀切。



### 66. 改 `appId` 会换掉 NSIS 的安装身份：装出并存实例、数据「看着归零」（1.0.29 用 `nsis.guid` 钉回）
- **症状**（用户实测，2026-10-02，装 1.0.28 后）：统计面板数字全空，像「数据丢了」；而桌面上实际多出一份新的空桌宠。
- **根因**：electron-builder 的 NSIS 安装包，其卸载注册键 / 安装身份是 **由 `appId` 生成的 name-based UUID v5**。官方文档两句原话：`name-based UUID v5 will be generated from your appId or name if appId was not set`、`changing your appId will break silent upgrades of existing installs`。1.0.28 为脱敏把 `appId` 从旧值换成 `com.desktoppet.app` → 新包不再认识已装的 1.0.27：**不覆盖旧装、另起一条卸载项、默认目录落到 `%LOCALAPPDATA%\Programs\desktop-pet`**。而数据根按铁律 4 走「容器根」策略，跟着安装目录走 → 新容器根 `data\` 是空的，老数据完整留在 `<安装目录>\data\`。**数据没丢，是被两个容器根劈开了。**
- **注册表实证**：`HKCU\...\Uninstall` 下同时存在 `fc5d11e1-8dec-51f5-b3eb-7f4d1eb01281`（1.0.27，D 盘）与 `04fb20b2-9d2e-51c0-97a3-9fd32253a8ba`（1.0.28，C 盘）；两把键第三段都以 `5` 开头 = UUID v5，与文档口径一致。
- **解法（1.0.29）**：`build.nsis.guid` 显式钉成旧装一直在用的 `fc5d11e1-8dec-51f5-b3eb-7f4d1eb01281` → `appId` 只管 AUMID/任务栏归组，卸载身份不变，后续版本重新变成覆盖升级。要在改 `appId` **同一版**就钉，拖得越久并存实例越多。
- **已装错实例的处置**：静默卸载 C 盘那份（`"<容器>\bin\Uninstall desktop-pet.exe" /S`；`deleteAppDataOnUninstall: false`，它不动数据），再装带旧 guid 的新包，安装目录填回 `<安装目录>`，数据原地复用。动手前先把两边 `data\`/`skin\` 各拷一份。
- **验收（1.0.29 实装，2026-10-02 22:10）**：静默卸载 C 盘那份后，注册表里 `04fb20b2-9d2e-…`（1.0.28）消失；把 `guid` 钉住再静默装 1.0.29 回 `<安装目录>`，结果**复用的正是旧那把键** `fc5d11e1-8dec-51f5-b3eb-7f4d1eb01281`，`DisplayName=desktop-pet 1.0.29`、卸载串指向 D 盘，且此刻 `HKCU\...\Uninstall` 下再无第二条 desktop-pet —— 证明「`appId` 换新值 + `guid` 钉旧值」确实把 AUMID 变更与升级链解耦。同时：`desktop-pet.lnk` 由安装器改指 D 盘、`data\` 仍是 38 个文件、`skin\` 6 套齐全、`FileVersion=1.0.29`、启动后 5 个进程全部来自 D 盘。
- **两条实操坑（本轮各踩一次）**：① NSIS 静默安装指定目录时 `/D=<路径>` **必须是最后一个参数且不能加引号**，带空格路径也不能引（否则被解析成程序参数）；② 用脚本驱动卸载/安装时，`.ps1` 里**不要写中文**——PowerShell 5.1 按 GBK 读无 BOM 的 UTF-8，中文双字节会吞掉紧随的 ASCII 引号，报「表达式中缺少右括号」这类看不懂的解析错（本项目 hub 约定 `.ps1/.cmd` 只用 ASCII 就是这个原因）。
- **补：`appId` 的确切落点与一处残留（2026-10-03 读 `node_modules/app-builder-lib` 模板取证，用于票 11-B）**。上文「`appId` 只管 AUMID/任务栏归组」这句写过头了，按模板更正为三条：
  - `appId` 在 NSIS 里**只写进快捷方式的 AUMID**：`templates/nsis/include/installer.nsh:200,209,225,232,240` 全是 `WinShell::SetLnkAUMI "$newStartMenuLink"/"$newDesktopLink" "${APP_ID}"`，别处不再引用它（卸载身份已被 `guid` 接管）。
  - **任务管理器归组与它无关**：§67 已实测 `app.setAppUserModelId()` 对归组无效，归组靠 1×1 隐形锚点窗；`main.js` 里没有任何 AUMID 代码。归组显示名会从 `desktop-pet (5)` 变 `Showcase (5)`，那是 `productName`/exe 名驱动的，别去动 AUMID「修归组」。（**更正**：「没有任何 AUMID 代码」已随 1.0.53 失效——bootApp 内现有 `app.setAppUserModelId(identity.APP_ID)`，服务 toast 归属而非归组，限定见 §29.5；本句按历史保留。）
  - **残留**：`templates/nsis/uninstaller.nsh:191` 是 `WinShell::UninstAppUserModelId "${APP_ID}"` —— 卸载器只清**它自己那一版** appId。所以每次换 appId 都会在 `HKCU\Software\Classes\AppUserModelId\<旧值>` 留一条旧键，需要单独清理（与「自启 Run 旧键不会自动删」是同一类「旧身份残留」）。
- **教训**：① 改任何可能参与「安装身份派生」的字段前，先查官方文档它是否被用来生成 GUID / 决定升级链——`appId` 看着只是个反向域名，实际同时决定 AUMID 与卸载注册键，一个纯脱敏诉求就能把用户数据目录劈成两半。② 凡是改了这类字段，**必须配一次版本递增 + 固定 guid**，否则同版本号还会再叠一层「两个内容不同但版本号相同的包」（1.0.28 已经踩过：21:25 的包和 18:56 的包 appId 不同、版本号相同）。③ 别把「卸载后目录还在」当成卸载失败：`deleteAppDataOnUninstall: false` 就是故意留 `data\`/`skin\`，判成败要看注册项与 `bin\`。

### 67. 给锚点窗补 `WS_EX_TOOLWINDOW` 会顺手打掉任务管理器分组身份（1.0.27 埋、1.0.30 炸）
- **症状**（用户报，2026-10-03，附任务管理器截图）：安装版 5 个 desktop-pet 进程从一条可展开的 `desktop-pet (5)` 散成 **5 条独立条目**，只能逐条结束任务。装 1.0.27 之前的版本没有这个现象（§29.5 验收时归组正常）。
- **根因**：§57 为修「explorer 重建后任务栏低频回流」给桌宠窗与锚点窗都补挂了 `WS_EX_TOOLWINDOW`。但 §29.5 的分组机制原文是「系统认不认这个窗口当『应用窗口』」——**shell 的应用窗口判定同时排除两类：不可聚焦（`WS_EX_NOACTIVATE`）与工具窗（`WS_EX_TOOLWINDOW`）**。锚点窗挂上 TOOLWINDOW 后被 shell 排除出应用窗口名单，整棵进程树失去聚合锚点 → 全部散开。§57 当时写了「分组看的是可聚焦性，不看工具窗位」，这个断言是从 §29.5 的对照实验（该实验里锚点窗恰好没有 TOOLWINDOW 位）外推的，**没做过「加 TOOLWINDOW 后分组是否还在」的对照**——同症状不同根因的又一例：两次「进程散开」（§38 散两个、这次散五个）机制完全不同。
- **实测对照（2026-10-03）**：修复前安装版锚点窗 `EXSTYLE=0x000800a0`（LAYERED+TOOLWINDOW+TRANSPARENT，5 条散开）；修复后 dev 实例锚点窗 `EXSTYLE=0x00080020`（LAYERED+TRANSPARENT，无 TOOLWINDOW）。分组恢复与否的终判由用户看任务管理器（不经任何 API 的证据）。
- **解法（1.0.30）**：`createAnchorWindow` 不再调 `forceNoTaskbar`，只靠 `skipTaskbar`（ITaskbarList::DeleteTab 登记）不进任务栏；桌宠窗保留 TOOLWINDOW（它 `focusable:false` 本来就不参与分组，而它有可见内容、回流显眼，防回流的价值大于分组代价）。
- **接受的回归**：explorer 重启 / shell 崩溃自动重启后，任务栏可能低频回流**一条纯透明的锚点条目**（§57 的老问题回来了，但只有锚点会回流、桌宠窗仍被 TOOLWINDOW 压住）。取舍：回流是低频 + 无功能损害（一条不可见条目），分组散开是常态 + 每次都碍事。
- **接受的回归（Alt-Tab，1.0.30 实测）**：锚点窗摘掉 TOOLWINDOW 后重新出现在 **Alt-Tab 候选列表**（tools/probe-alt-tab.js 实测：dev 实例锚点 32×39@0,0 进候选，桌宠窗仍被 TOOLWINDOW 压住不进）。这正是 1.0.27 之前半个月的常态（§57 注释「两窗也从 Alt-Tab 列表消失」自证当时锚点就在列表中），当时无人投诉，故本轮接受。**未做的选项**：DWM cloak（`DwmSetWindowAttribute` Cloak）理论上能让锚点不进 Alt-Tab，但盲改有再次破坏分组身份的风险（shell 对 cloak 窗口的分组判定无实测依据）且分组无法在本机自动验证——记录为后续选项，等有分组回归手段再动。
- **教训**：① 两个需求同时压在同一个样式位上时（TOOLWINDOW：防任务栏回流 vs 保分组身份），**先列出每个位的全部消费方再动手**——§57 修的是一个「低频难复现」的问题，用的手段却砸了「每次打开任务管理器都依赖」的功能，且当时没有任何回归项覆盖分组。② 「A 位决定 X」的结论（§29.5）只在当时的样式组合下成立，换个组合引用前要先重验：§57 引用「分组看可聚焦性不看工具窗位」时，实验条件已经变了。

### 68. 改造同一功能时凭记忆重写，把已修的 bug 又写回来（1.0.30 修、1.0.31 重构又丢）
- **症状**：1.0.31 把缩放手势从 Ctrl+滚轮改成 Ctrl+拖拽后，`verify-scale.js` 6 项 FAIL：拖拽中窗口恒 300×300、config 不持久化、下限钳制无效——而渲染端 transform 正常、IPC 通路正常（scaleEnd 的 petPosition 写盘成功）。
- **根因**：`applyPetScale` 里 `setBounds` 的尺寸用了 `petSize()`——它内部读 `config.petScale`（持久化前的旧值）。拖拽中 `persist=false` **不写盘**，config 恒为 1，于是窗口永远被设成 300×300。这正是 1.0.30 首轮 verify 抓出并修过的「窗口落后一档」，改成拖拽版重写这个函数时又按旧模式写了一遍，修复丢失。
- **为什么 1.0.30 首轮能抓出、这轮差点漏掉**：首轮失败后改动同一段代码时**没有先重跑回归件**，而是凭「记得修过」的印象继续写。修复不是状态，是代码——代码被覆盖，修复就没了。
- **解法**：尺寸按目标 s 现算：`{ width: Math.round(PET_SIZE.width * s), height: Math.round(PET_SIZE.height * s) }`；通用原则——**持久化前的中间态（拖拽中/未松手），任何从 config 读派生值的路径都失效**，函数参数里已有目标值就不要绕道配置源。
- **教训**：① 动「曾经修过 bug」的函数，第一件事是重跑对应回归件确认现状是绿的，再动手；改完立即再跑。② 回归件的价值不在抓新 bug，而在守住旧修复——「修过」不等于「还在」。③ 症状排查时先做最有分辨力的实验（本例：scaleEnd 的 petPosition 写盘成功 = IPC 通路正常 = 问题收窄到 applyPetScale 内部），比从头顺着链路读代码快得多。

### 69. 「无人值守提权自启」只有任务计划一条正路；用户不接受时改 Run 键 + 启动时弹 UAC（1.0.30 → 1.0.32）
- **背景**：1.0.30 用任务计划程序（`/sc onlogon /rl highest`）实现管理员自启——技术上它是「开机自启 + 提权 + 不弹框」的唯一官方正路（Run 键对 requireAdministrator 程序静默跳过；启动器 runas 每次开机弹 UAC；服务受 Session 0 隔离没有桌面）。但用户明确**不想在系统里留计划任务**，选择接受「每次开机弹一次 UAC」的折衷。
- **1.0.32 方案**：普通自启（Run 键，`setLoginItemSettings` 带 `--autostart` 标记）+ 开机拉起的普通实例判定「标记 + config.autoStartAdmin」后经 `ShellExecuteW('runas')` 拉起提权自身（复用「以管理员身份重启」relaunchAsAdmin 的单实例锁交接与 UAC 取消回退）。UAC 取消 → 提权失败 → 普通实例不退出，桌宠降级普通权限继续跑。
- **防 UAC 循环的关键**：提权产物实例的 argv 带 `--elevated-autostart` 标记，判定函数见之必跳过。**不能靠 isAdmin 挡循环**——管理员探测（fltmc）是异步的，提权实例刚起时探测还没回来，用它会二次弹 UAC。判定抽成纯函数模块 autostart-elevation.js（verify 直接 require 真函数，不做镜像断言）。
- **语义迁移坑**：config.autoStartAdmin 从「存在计划任务」变为「开机自启时请求提权」（普通自启的修饰位，依赖 Run 键载体）。1.0.31 及以前写的 Run 键值不带 `--autostart` 标记 → 启动时幂等重写一次完成迁移（同值覆写，不影响任务管理器的「启动项禁用」状态）。1.0.30/1.0.31 的计划任务残留由管理员实例启动时静默清理（`schtasks /delete`，非管理员实例跳过——删任务本身就要管理员，不能让开机再为清理弹 UAC）。
- **行为差异表**：任务计划方案勾选时弹一次 UAC、开机不弹、系统里留任务；Run 键方案勾选不弹、每次开机弹一次、系统里零残留。管理员自启与普通自启从「互斥」变「修饰」——Run 键是唯一载体，关自启连带关提权位。
- **教训**：① 「技术上唯一正路」不等于用户要的方案——系统里留一个可见的计划任务对用户是心理负担，宁可每开机点一次 UAC。② 方案替换时旧方案的系统级残留（计划任务）必须清理路径，否则旧用户开机多拉一份提权实例（锁挡得住进程，挡不住多余的 UAC）。
### 15. CSP `style-src 'self'` 拦内联 style 属性
- **症状**：条形图宽度不生效；趋势曲线隐形、圆点变默认黑色。
- **根因**：CSP 禁止 `style="..."` 属性（连 SVG 的都拦），但**不拦 CSSOM 赋值**（`el.style.width = ...`）和**样式表里的类**。
- **解法**：动态尺寸用 CSSOM；主题色/图形颜色放样式表类（如 `.trend-line { stroke: var(--accent-deep) }`），SVG 用 `class` 不用 `style` 属性。**SVG presentation attribute（fill/stroke 属性）可以用，内联 style 不行**。

### 16. 渲染端数据形状契约
- **症状**：手柄面板恒显「还没按过键」，其他数字都在刷新。
- **根因**：`renderBars` 只吃 `{key,count}` 数组（用 `entries.length` 判空），手柄传的是对象 → `.length` undefined → 永远空态。主进程计数、落盘全正常，纯渲染端 bug 被「手柄连不上」的表象掩盖了很久。
- **解法**：主进程传出前 `Object.entries().map()` 成数组；**面板打开期间每 5 秒自动刷新**（与落盘周期一致），避免「看了旧数据」的错觉。

### 17. 字幕条自适应窗口的测量陷阱
- **症状**：开设置面板后窗口不长高、内容裁切。
- **根因**：`#bar` 被 CSS 拉伸填满窗口后，`getBoundingClientRect` 量到的是窗口尺寸（循环自量）；flex 压缩后子元素溢出也不进父级 scrollHeight。
- **解法**：量**实际内容**——`barMain.scrollHeight + settings.offsetHeight + 各层 padding`；主进程「只增不减」；设置面板固定贴底高度恒定（`flex:none`），文本区 `flex:1` + `align-items:center`；面板打开时边缘拖拽同步 fitHeight 钳制最小高度。

### 18. 合成鼠标事件（CDP）有坐标反馈伪影
- CDP `Input.dispatchMouseEvent` 的 movementX/Y 按屏幕坐标差计算，**拖拽中窗口自身移动会让 movement 被放大/缩小**（北/西缩放测试出现过过冲）。真实鼠标无此问题。E2E 验证缩放时只信「东/南方向」和最终钳制状态，别拿合成 movement 的数值当真。

## 五、语音链路（sherpa-onnx + llama）

> **该功能已于 2026-09-22 按用户要求整体移除**（连同画面字幕 OCR 链路：`asr.js`/`asr-worker.js`/`renderer/subtitle.*`/`sidecar/ocr_server.py` 与打包用的 ASR 模型、OCR sidecar 均已删除）。
> 本节与散落在其它章节的 OCR/字幕条目**保留作为历史与通法参考**（原生模块打包、ASR 端点切句、CPU 占用口径等经验对以后可能的功能仍然适用）。

### 19. sherpa-onnx-node 配置字段是 camelCase
- **症状**：`Please provide a model`。
- **根因**：SenseVoice 配置键是 `senseVoice`（不是 `sense_voice`）。
- **解法**：以 `node_modules/sherpa-onnx-node/types.js` 的 typedef 为准（schema 全在里面）。查询命令：`grep -n "SenseVoice" node_modules/sherpa-onnx-node/types.js`。

### 20. SenseVoice 是非流式模型
- 流式 zipformer 有端点检测和逐字结果；SenseVoice 只能整段解码。**解法**：worker 里做音频缓冲——每积累 1.2s 解码一次出「半句」，静音 1.0s 或缓冲满 15s 强制切句，模拟流式体验（原文半句滚动 + 同传译文都靠它）。
- 静音判定用 RMS 阈值（0.01），环回采集的数字静音接近 0，可靠。

### 20.5 流式英文模型的原文没有标点，切段不能只认句号
- 实测（用户截图里那段真实识别结果）：流式 zipformer 的中英模型输出**全大写、完全没有标点**——`WHICH IS THAT YOU MIGHT BE WONDERING WHY A MATHEMATICIAN…` 一路到底。所以任何「在句末标点处切段」的逻辑在这条链路上**永远不触发**（我第一版就是这么写的，等于没生效，靠拿真实文本跑一遍才发现）。
- 端点规则的边界：sherpa 只在「静音够久」或「超出 `rule3MinUtteranceLength`」时切句。连续讲话（视频/播客）没有长停顿，于是攒成一大段：字幕条被原文铺满、整句翻译一直等到最后、超长时一刀切在句子中间。
- 解法（main.js 的 `cutSegment`）：三级退让——有句末标点就切在标点；没标点就按目标长度（100 字）**退到空格即词边界**切，绝不切在词中间；连空格都没有（中文长句）才按字数切。切出去的部分立刻走一遍翻译（句序 +1，旧段迟到结果自动作废），字幕条上只留还没说完的那段（实测 372 字 → 83 字）。
- 配套：`rule1` 2.0→1.6、`rule2` 1.0→0.9（静音切句更快）、`rule3` 20→30（少一些强制切在句子中间）。
- **教训**：改这类文本逻辑前，先拿真实识别结果跑一遍（`node -e` 里复制函数即可），别拿「带标点的漂亮样例」自测。

### 21. llama 流式翻译的三个坑
- SSE 解析：`data: {...}` 行 + `[DONE]` 结尾；半行 JSON 要留在 buffer 里拼下一块。
- 思考型模型：`chat_template_kwargs: { enable_thinking: false }` 失败要去掉重试一次；流式下 `<think>` 未闭合前不上屏（增量显示需要单独的抑制逻辑）。
- **句序守卫**：连续切句时新旧句子的翻译回调会交错，每句发号 `seq`，回调时 `my !== seq` 一律丢弃。

### 22. 同传（半句翻译）节流
- ASR 中间结果持续增长，逐条翻译会打爆 llama。节流：≥1.5s 且新增 ≥4 字符、无进行中请求（`partialBusy` 标志），半句翻译不入译文缓存（前缀每次都不同，会撑爆 Map）。

## 六、交互与状态机

### 23. GIF/图片皮肤的三个状态切换坑
- 眨眼定时器每 3~6s 切走一次，GIF 播不完就被打断 → 早期做法是 **image 皮肤完全禁用 blink**。**但导入皮肤通常自带 blink 帧，一律禁用等于那套图白导入**（用户明确反馈「导入皮肤的眨眼没显示」）。现在改成：只要皮肤提供了 `blink` 帧就参与眨眼，图片皮肤间隔放宽到 4~9s（GIF 自带动作，眨眼只是偶尔插一下）。实测导入皮肤 22 秒内出现约 4 次眨眼（改之前是 0）。
- 重设同一张背景图会让 GIF 从第 0 帧重播 → `advance()` 里同 URL 不重设。
- 临时状态（happy/wow）停留时长 image 皮肤加倍，让动图先播完。

### 24. 穿透窗口的交互锁
- `setIgnoreMouseEvents(true, {forward:true})` 下，指针滑出可交互元素后 mousemove 断流。拖拽/缩放/玻璃特效期间必须 `setIgnoreMouseEvents(false)` 锁住整窗，结束再恢复；期间抑制 `updateMousePassThrough` 的正常判定（加 `glass.on`/`dragging` 条件）。
- 穿透判定用 `closest(INTERACTIVE_SELECTOR)`——把手、按钮都是字幕框子元素时，一个 `#bar` 选择器全覆盖。

### 25. 启动推送竞态
- renderer 监听器没注册完时主进程 send 会丢消息。所有主动推送（气泡/皮肤/计数/行为开关）走 `sendToPet` 队列，`pet:ready` 后重放。**新增推送通道时必须走队列**。

### 26. config.js 的 DEFAULTS 是白名单
- `deepMerge` 只接受 DEFAULTS 里已有的键，新配置项（skinName/asrModel/dblclickStats/subtitleFont…）**必须先在 DEFAULTS 登记**，否则被静默丢弃。历史已踩：skinName、asrModel。

### 56. 齿轮「再点一下关菜单」：blur 自毁先于 click IPC 到达，只判 `menuWindow` 会漏
- 背景：菜单开关要做 toggle，但「点齿轮」时桌宠窗口若抢焦点，事件顺序是 **菜单 blur（自毁）→ 渲染端 click → `menu:open-at` IPC**；IPC 到达时 `menuWindow` 已是 null，简单判「存在则关闭」永远走不到关闭分支，反而重开一个。
- 解法（两条时序都覆盖，缺一不可）：
  1. 桌宠窗口不抢焦点（`focusable: false`）→ IPC 到达时菜单还活着，`isVisible()` 成立 → 直接关；
  2. 抢焦点 → blur 已自毁 → 用 `lastMenuCloseAt` 时间戳：**300ms 内**到达的 `open-at` 视为「这次点击就是刚才那次」，忽略。窗口值权衡：blur→click 的 IPC 延迟毫秒级，300ms 足够宽；人工「关了再想开」是两次独立点击（间隔 >1s），不会误伤。
- 通用原则：依赖「点击 → IPC」做状态切换时，先画事件时序图——Electron 里窗口焦点转移、blur、渲染端事件、IPC 到达的先后不直观，实测为准。

### 46. uiohook 鼠标事件的 clicks / ctrlKey —— 实测都被填充了，可以直接用
- 疑问来源：`node_modules/uiohook-napi/dist/index.d.ts` 里 `UiohookMouseEvent` 声明了 `x/y/button/clicks` 和 `ctrlKey/altKey/shiftKey/metaKey`，但**类型声明有 ≠ 运行时被填充**（libuiohook 的 mask 有没有传过来、clicks 有没有算，都没保证）。
- 实测（`tools/probe-mouse-event.js`，2026-09-22，用户真实点击）：
  - `clicks` **真的在数**：一次连点三下依次输出 `clicks=1 / 2 / 3`；
  - 修饰键标志**真的在**：按住 Ctrl 时 `ctrl=true`，不按为 `false`；
  - 坐标：本机 2560×1400 工作区下，点击落点与事件 `x,y` 一致（缩放 100% 时物理像素与 DIP 相同，**缩放≠100% 的机器未复核**）。
- 用法结论：「Ctrl+三击让桌宠走过去」用 **`clicks === 3`（恰好等于，不是 >=）**：OS 的连击计数是**累加**的，连点六下会依次报 1…6，用 `>=3` 会把第 4~6 下当成新的三击 —— 真机日志里因此刷了一片「移动跳过」，还在走路中途反复改目标。等于 3 时一次连击只触发一次，想再走要停一下让计数归零（约 500ms）。
- 配套：**OS 计数可用时（`clicks >= 1`）自攒路径整条停用**，只作为「实现不填 clicks」时的兜底 —— 两条路并行跑会把同一次六连点算成两次三击（自攒那条在第 6 下凑满三次，正好越过冷却）。
- 探针工具留在仓库里，将来换钩子实现或换机器时先跑一遍再动手。

### 47. 冷却（cooldown）会吃掉用户的下一次操作，别凭感觉定值
- 症状（真机日志）：用户连试三次 Ctrl+三击（间隔约 1.3s），日志里只有两次移动记录，中间那次没有任何记录 —— 看着像「有时候没反应」。
- 根因：触发冷却初值定 1500ms，用户第二次手势的第三下距上次触发只有 1290ms，整串被丢弃；而且**丢弃时不留任何日志**，事后无法区分「没识别到手势」和「被冷却吃了」。
- 解法：① 冷却收到 400ms（`clicks===3` 之后，冷却只用来挡「同一手势重复触发」；OS 计数归零本身要停约 500ms，冷却再大就会连用户正常节奏的下一次三击一起挡掉）；② 丢弃时补一行日志 `移动跳过: 距上次触发仅 N ms，仍在冷却内`。
- 教训：**凡是"用户操作被静默忽略"的分支，都必须留一条日志**；冷却这类阈值要用真机节奏校准，不能只按"理论上够用"拍。

## 六点五、卡死与进程残留（「有时卡住、任务管理器要全杀」）

### 30. mousemove 逐事件改窗口样式 → 窗口卡死（本轮根因）
- `updateMousePassThrough` 原来在**每个 mousemove** 上无条件调 `setIgnoreMouseEvents`，拖拽期间更是每移动一点调一次。而该 API 每次都要改一次原生窗口样式；`forward:true` 还会把移动消息转发给下层窗口，形成再入消息流。
- 实测（tools/measure-ignore-storm.js，计数器挂在主进程 IPC 上）：**旧代码 200 次 mousemove = 200 次原生样式切换**（脸上移动/拖拽/透明区三个场景都是 1:1）；指针停在桌宠上时相当于每秒 60~125 次窗口样式变更 → 桌宠僵住、点不动、菜单也点不出来，只能去任务管理器。
- 修法：`setIgnore()` 缓存 `lastIgnore`，**只在状态翻转时下发**（同场景实测降到 0~1 次）。**字幕条 renderer/subtitle.js 是同一个写法，一起改了**（它贴在屏幕底部中央，指针扫过那片区域就持续触发；实测 200 次移动从 1:1 降到 1~2 次，见 tools/measure-subtitle-storm.js）。
- 边沿触发的代价：拖拽/玻璃结束时指针可能已不在形象上，而之后没有新的 mousemove 来纠正 → 会漏掉中间那次点击。所以 `endDrag`/`glassEnd` 里补一次 `syncIgnore()`，用 `document.elementFromPoint(lastPtr)` 重算。**改这里时三个入口要一起看。**
- 顺带把「拖拽/缩放期间锁整窗」从隐含约定变成显式状态位（`interactiveLocked`）：原来靠 `e.target` 恰好还是 `#bar`，指针滑出把手就会把窗口设回穿透。

### 31. 自恢复不要 destroy 唯一窗口
- 渲染进程崩溃时若 `petWindow.destroy()` 再 `createPetWindow()`：桌宠是**唯一**窗口，销毁瞬间触发 `window-all-closed → app.quit()`，结果是「渲染进程崩一下，整个程序静默退出」。实测踩到（forcefullyCrashRenderer 后四个 electron 进程全没了）。
- 修法：原地 `webContents.reload()`（会拿到新渲染进程，`did-finish-load` 里的 pushCounter/pushSkin/pushPetConfig 自动补回状态）；另加 `recovering` 标志让 `window-all-closed` 在重载空档不退出。

### 32. 退出收尾与兜底强杀
- `before-quit` 只做存档 + 关 OCR 时，语音 worker（内载 sherpa-onnx 原生库）、uIOhook 原生钩子线程、OCR sidecar 都没人收。**A/B 实测：这些不阻塞 app.quit()（带 live worker 也是 257ms 退出）**，所以它们是「进程残留」的放大器而不是主因——但一旦退出流程被别的原因卡住，残留的就是这一堆。
- 现在：`before-quit` 收 worker/hook/timers/sidecar + `setTimeout(…, 3000).unref()` 兜底 `app.exit(0)`。
- 时序坑：`app.quit()` 时 `window-all-closed` 也会走一遍，用 `quitting` 标志防重入。

### 33. spawnSync 判权限不抛异常
- `try { spawnSync('fltmc'); 提示已提权 } catch {}` 恒成立：**spawnSync 对非零退出码不抛异常**（只设 `status`/`error`），非管理员下也会弹「已以管理员权限运行」。而且它是同步调用，卡在主进程事件循环上。
- 修法：`execFile('fltmc', [], cb)`，按回调的 `err` 判断。

### 34. OCR sidecar 是两层进程
- PyInstaller 打包的 exe 是「引导进程 + 真身」两层，`ocrProcess.kill()` 只杀父进程，子进程变孤儿留在任务管理器（还占着 8765 端口）。
- 修法：`execFile('taskkill', ['/pid', pid, '/T', '/F'])` 整棵树杀。

### 35. 打包版没有控制台 → 必须落盘日志
- 卡死/崩溃现场全在 stdout 里丢掉了，事后无从查。现在 `logLine()` 写数据目录里的 `showcase.log`（1.0.48 及以前为 desktop-pet.log；before-quit、renderer 无响应、渲染进程退出、镜像恢复、uncaughtException/unhandledRejection）。**下次再卡，先看这个文件。**

### 36. 「穿透状态卡死」是边沿触发改法的必备配套（#30 的连带坑）
- 症状（用户报告）：**GIF 动画正常、计数正常，但点击没反应、齿轮点不开**。动画在动说明渲染进程活着，计数在涨说明主进程活着——不是卡死，是窗口卡在「鼠标穿透」上，点击全落到桌面去了。
- 根因：把穿透改成「只在状态翻转时下发」（#30 治卡死）之后，状态更新只由 mousemove 驱动。可是**指针不动、命中区自己变**的情况同样存在：形象有漂浮动画（脸在指针下方飘进飘出）、窗口被拖走（窗口内坐标整体偏移）。此时没有任何 mousemove 来纠正，窗口就永久停在旧状态；用户点击时若指针早已停在形象上，连点击都不会产生 mousemove，于是「怎么点都没反应」。
- 修法两条：
  1. 指针位置改记**屏幕坐标**（`e.screenX/screenY` → `elementFromPoint(screenX - window.screenX, …)`），窗口移动过也算得对；再用 `setInterval(syncIgnore, 250)` 定期重算命中（IPC 仍是「变了才发」，所以不会回到每秒上百次的老问题）。pet.js 与 subtitle.js 都要加。
  2. 救援热键：全局钩子里「连续按 Ctrl、Alt、P」（用最近三次按键的序列判定，不需要 keyup 事件）→ 主进程强制 `setIgnoreMouseEvents(false)` 并让 renderer 同步缓存、弹出菜单。穿透卡住时不必去任务管理器。
- 验证（`tools/verify-passthrough.js`，钩住主进程的 `setIgnoreMouseEvents` 读真实状态）：指针移到透明区 → 状态 `true`；**不发 mousemove** 而让可交互元素出现在指针下 → 旧代码 600ms 后仍是 `true`（永久卡住），修复版 600ms 后变 `false`（自愈，打包版连跑 3 次均通过）。
- 测试脚本自身的坑：别用改 `transform` 的办法把宠物脸移到指针下——脸的漂浮动画也走 `transform`，两者打架会导致「有时移到位、有时没移」，测出时好时坏的假结果（我因此误判过一次「打包版没修好」）。改用气泡元素临时铺到指针处，命中判定确定。
- 临时自救（旧版本里中招时）：把鼠标**移开再移回**宠物身上即可（mousemove 会纠正状态）；实在不行在任务管理器结束 `desktop-pet (N)` 那一条（现在是一个分组条目，一次结束整棵进程树）。

## 七、测试方法（本次迭代沉淀的基建）

### 27. 多实例测试接缝
- dev 与安装版共用 `%APPDATA%\<app 名>` userData（改名前 desktop-pet、1.0.49 起 showcase）→ 单实例锁互斥、缓存打架。`PET_USER_DATA_DIR` 环境变量在 main.js 早期 `app.setPath('userData', ...)`，实现与正式实例并行跑 dev。

### 28. CDP 自动化验证 UI
- `--remote-debugging-port=9222` + Node 内置 WebSocket 驱动：`Input.dispatchMouseEvent` 走真实输入路径（**带 user activation**，getDispleyMedia 类手势测试必须用它而不是 `el.click()`）。
- 流程：写 config 预置状态（或直接 `window.petAPI.menuAction('tr-voice')`）→ CDP 连 subtitle target → 真实点击 → 轮询 DOM 状态。
- 坑：隐藏元素 rect 是 (0,0)（先展开面板再取坐标）；合成事件会粘 Zombie 实例（先 `taskkill //IM electron.exe //T //F` 并确认 tasklist 清零）；窗口自身移动会污染 movement 值（见 #18）。
- 纯 node 测 worker：asr-worker.js 故意不依赖 electron，`new Worker(...)` 直接喂 PCM 验证。

### 29. 后台任务与输出
- 长命令（打包/下载）用 run_in_background + 轮询输出文件；**Bash 写源码文件会被 Mimosa hook 拦截**，生成物一律走「Write 一个可审查的工具脚本 → node 执行」的路径（如 tools/gen-emoji-catalog.js）。
- spawn 的首个参数必须是字面量（变量首参按命令注入拦截）；动态路径拼接读写必须有根目录包含性校验（emojiMappingPath 的 `path.dirname(target) === root` 模式）。
- Git Bash 下 PowerShell 的 `@'...'@` here-string 会在解析期就报错（`Add-Type -MemberDefinition @'` 直接崩），要 P/Invoke 就别走 PowerShell，用项目里已有的 koffi。

### 29.5 任务管理器里的进程分组：真凶是 `focusable: false`
- 症状：任务管理器里桌宠的 4 个进程（主进程/GPU/网络/渲染）被列成 4 条同级独立条目，只能一条条「结束任务」；而 ZCode（同样是 Electron）是一条可展开的 `ZCode (20)`。
- 实测过程（三次对照，靠任务管理器截屏读结果）：
  - 给主进程设 `app.setAppUserModelId(appId)` → **无效**，照样散开。（AUMID 不是这里的机制，别在这上面花时间。）
    **限定（2026-10-04 补，票 11-E 任务 3）**：「无效」只对**任务管理器归组**这一个语义成立，≠ 对**通知归属**无效——
    1.0.53 起 `main.js` bootApp 内的 `app.setAppUserModelId(identity.APP_ID)` 是 Windows toast 挂到 Showcase
    名下的必需项（与 NSIS 快捷方式的 AUMID 一致才归对名），别据本条把这行删掉。
  - 把桌宠窗改成完全普通的窗口（不透明/有边框/可聚焦/进任务栏）→ **立刻变成 `Electron (4)` 一条分组条目**。
  - 逐项收敛 → 只要 `focusable: true`，其它保持透明/无边框/不进任务栏，就已经能分组。**`focusable: false`（Windows 侧 WS_EX_NOACTIVATE）才是拦路的**：系统不把一个无法激活的窗口当成「应用窗口」，于是整棵进程树都不被认作一个应用。
- 解法：保留桌宠窗的 `focusable: false`（这是「游戏里点击不抢焦点」的基础，不能动），另建一个 **1×1、透明、不进任务栏、点击穿透、`showInactive()` 显示的锚点窗口**，专门让系统认出「应用」。实测任务管理器显示 `desktop-pet (5)`（4 + 锚点的渲染进程），桌宠外观与不抢焦点行为完全不变。
- 两个必须注意的细节：锚点必须 `setIgnoreMouseEvents(true)`（否则那 1 像素会吃掉点击）；必须 `showInactive()` 而不是 `show()`（后者会在开机那一下抢走前台窗口焦点）。另外锚点常驻后，桌宠窗被关掉时要顺手把它也收掉，否则 `window-all-closed` 永远不触发、进程留在后台。
- **锚点必须真的看不见**：`about:blank` 是白底，透明窗口会把它当不透明内容画出来 —— 用户看到「桌面左上角多了个白方块」就是这个。改成 `setBackgroundColor('#00000000')` + 载入背景透明的 data URL + `setOpacity(0)` 三层保证；实测不透明度 0 之后任务管理器照样把它算作应用（分组仍是 `Electron (5)`）。
- 锚点必须在桌宠窗**之前**创建：任务管理器是在子进程创建那一刻归属「应用」的，而 GPU/网络进程在第一个窗口 load 时就起来了。先建锚点才 5/5 全归入 `desktop-pet (5)`；后建时实测只归进 3 个、另 2 个游离。
- 代价：多一个渲染进程（约 10~30MB）。

### 29.6 覆盖安装会清空安装目录 —— 用户数据必须另存一份镜像
> **【2026-09-22 更新：镜像机制已删除，改用「数据与程序分离」】** 1.0.4 起数据主位置直接放在
> **安装目录同级的 `<安装目录名>-data\`**（data\ 与 skins\ 都在里面），安装目录内不再存用户数据——
> NSIS 只清安装目录，数据在兄弟目录**结构上就不可能被碰**，不再需要镜像与双向同步（本节其余内容
> 是镜像方案的历史记录，「NSIS 为什么只清安装目录」的源码取证仍然成立）。单份数据无冗余：手动删
> `-data` 目录即彻底重置。老用户升级由 `migrateLegacyData()` 一次性 missing-only 搬迁（userData 旧
> 快照、安装目录内旧 data/skins → 新家；镜像目录就地转正为主数据目录）。
- 症状（真实用户报告，连续中招两次）：「覆盖安装会覆盖掉当天的数据，不覆盖历史记录」。
- **真因**：electron-builder 的 NSIS 覆盖安装会把安装目录整个清掉，而便携化后的 `data\` 与 `skins\` 就在里面。启动时那段「旧数据迁移」只认得 `userData` 里那份**冻结的旧快照**（便携化改造前留下的 config.json + 某一天的历史），于是：历史天数被拷回来、皮肤被拷回来，**只存在于安装目录的「当天」文件永久消失**。
- 三条证据（其中两条是这轮才用上的取证手法）：
  1. 覆盖后 `keys-<前一天>.json` 的 mtime 竟然还是覆盖前的旧时间戳 —— 因为 **Windows 上 `fs.copyFileSync` 保留源文件 mtime**（CopyFile 的行为，Linux 上不是这样），所以「mtime 没变」恰恰是「这文件是被拷回来的」的指纹。当时若按 Linux 的直觉理解，就会得出「安装程序没动数据」的反向结论（我第一轮就是这么错的）。
  2. `skins\` 下各皮肤目录的 mtime = 覆盖安装那一刻（目录 mtime 只在增删条目时变），说明它们是被重新建出来的。
  3. 覆盖后首次启动时当天的文件是**缺失**的：既没有 `.bad`、日志里也没有「文件损坏」记录 —— 走的是「文件不存在 → 从零开始」那条路，而不是解析失败。
- 修法：在**安装目录的同级目录**（同一个盘，如 `<安装目录>-data`）常驻一份镜像：
  - 为什么不是 userData：安装程序确实不碰 userData，但那会把备份写到 C 盘；同级目录同样不被安装程序碰，且不占 C 盘。父目录不可写（例如装在盘根）时才退回安装目录内并记日志。
  - 安装程序为什么只清安装目录：读 `node_modules/app-builder-lib/templates/nsis/uninstaller.nsh` 可见默认逻辑——`${isUpdated}` 时先 `un.atomicRMDir` 把**整个 `$INSTDIR` 改名搬走**，随后 `RMDir /r $INSTDIR` 删掉。所以「安装目录内的任何东西都会没」，兄弟目录不会。
  - 启动时 `syncMirror()` 跑在 `rollDateIfNeeded()` **之前**，先把被清掉的补回来，再加载当天记录（顺序错了就白恢复）。
  - 统计文件按「**total 大的一方为准**」判定，不能用 mtime：覆盖安装后应用会先写出一份只有几条计数的当天文件，mtime 比镜像新，按 mtime 判会把镜像里完整的 327 条顶掉。
  - 其它文件（config、皮肤）按 mtime 新的一方为准；时间戳相当就跳过，避免每分钟整目录重写。
  - 高频路径只镜像当天文件 + config（每次落盘 / 每 5 秒），皮肤目录每分钟整目录补齐一次，退出前再刷一遍。
- 已验证（dev + 独立的 `PET_USER_DATA_DIR`/`DESKTOP_PET_DATA_DIR`）：清空数据目录模拟覆盖安装 → 重启后当天 327 条、config、皮肤全部恢复，日志逐条记录；再把主文件改成 61 条而镜像保留 327 条 → 启动后以 327 条为准。
- 遗留：卸载（而非覆盖安装）时数据目录仍会被删；`<安装目录>-data` 镜像会在卸载后留下（数据还在里面，属预期）。

#### 覆盖安装到底会不会丢数据：分情况判断
用户问「其他电脑的普通用户会不会也丢」，判断依据是安装器模板里的这一段（`include/installUtil.nsh` 的 `uninstallOldVersion`）：注册表里读不到上一版的 `UninstallString` 时**直接 Return**，也就是全新安装根本不走「删目录」那条路；模板注释也写着 `uninstaller should be copied out of app installation dir (because this dir will be deleted)`。

| 情况 | 结果 |
| --- | --- |
| 新电脑 / 全新安装修复版 | 不丢。没有旧版本可卸载，安装器只写文件 |
| 已跑过修复版的机器，之后覆盖安装 | 不丢。镜像首次启动就建好，被清掉的内容下次启动自动补回（已用清空目录模拟验证） |
| **从旧版（镜像存在之前）第一次升级到修复版** | **丢当天数据，且只有这一次**。旧版从没建过镜像，清空后无可恢复——用户这次中招的就是这一种 |

- 前提：镜像要在覆盖安装**之前**就存在，所以装完修复版必须**至少启动过一次**；装完不启动就立刻再覆盖安装，那次仍然没有镜像可用。
- 防护不到的边界：安装目录的**父目录不可写**（例如装在盘根）→ 镜像退回安装目录内，防不住覆盖安装（日志记一行）；覆盖安装时**改了安装目录** → 新目录旁边是新镜像，旧目录旁那份读不到，那一次仍会丢（升级建议保持同一路径）；真正**卸载**时数据仍被删（镜像保留在旁边）。
- 普通用户（非管理员）是 per-user 安装，默认落在 `%LOCALAPPDATA%\Programs\<productName>`（随 productName：改名前 desktop-pet、1.0.49 起 Showcase），数据与镜像同样写在它旁边、同样受保护——只是这种情况下程序、数据、镜像都在 C 盘（因为程序本身就在 C 盘）。
- 仍未堵住的一处：上面第三种。要堵需要在安装器侧加一层（`customInit` 里先把 `$INSTDIR\data`、`$INSTDIR\skins` 备份到临时位置，`customInstall` 再放回；`uninstallOldVersion` 在 installSection 里、`customInstall` 在其后，顺序可行）。验证方式：用一份改了 appId 的测试构建在临时目录跑一次真实升级流程，避免碰到正式安装。**截至本次提交尚未实施。**


### 29.7 取证用的零碎坑
- Windows PowerShell 5.1 按 ANSI/GBK 读 `.ps1`，**文件里有 UTF-8 中文就会解析崩**（`Add-Type` 的 here-string 首行带中文即报错）。给 PowerShell 的脚本一律写纯 ASCII。
- 反过来：`reg query` 的输出是 GBK，用 UTF-8 的中文 pattern 去 grep 等于没查，要先 `iconv -f GBK -t UTF-8` 再 grep。
- 任务管理器自身是提权进程 → UIPI 挡住 UI 自动化（同 #11），但**整屏截图不受影响**：`start taskmgr` 把窗口唤到前台，截图后放大就能读分组结果——本轮所有分组结论都来自这条路。
- 查进程 AUMID 的 API（kernel32 `GetApplicationUserModelId`）用 PowerShell P/Invoke 与 koffi 都读不出（连自己刚 `SetCurrentProcessExplicitAppUserModelID` 设过的进程也回 `0x3D57`），**别把这当成「该进程没有 AUMID」的证据**——本轮据此得出过完全相反的结论。
- 判断「某进程是不是我们的」最省事的办法：拿 UTF-16LE 的中文串去 `Buffer.indexOf` 扫 exe。当时任务管理器里那三条 `桌宠` 就是这么排除掉的（我们的 exe 里根本没有这三个字，是机器上另一个应用）。
- koffi 读 C 输出参数（`GetCursorPos`/`GetWindowRect` 这类）**必须声明成 `void *` 并传 `Buffer`**，然后自己 `readInt32LE`：`user32.func('GetCursorPos','bool',['void *'])` + `Buffer.alloc(8)`。写成 `bool __stdcall GetCursorPos(_Out_ POINT *pt)` 再传 `{x:0,y:0}` 会**不报错但字段恒 undefined**（`koffi.out(koffi.pointer(POINT))` 直接报 `Expected 1 arguments`）——本轮在探针和让开验证里各栽了一次，最终以 `probe-window-style.js` 的写法为准。

### 29.8 让覆盖安装碰不到数据的第二种姿势：程序塞进 `<容器>\bin\`，`$INSTDIR` 就只剩子目录

- 背景：29.6 的结论是「数据不能放安装目录内」。但用户想要「一个 `desktop-pet` 目录装下程序 + 数据」——
  把程序放进子目录即可两全：安装时把路径选到 `<容器>\bin`，`$INSTDIR` 就只有 bin，数据落在父目录即可。
- 源码依据（两处，缺一不可）：
  1. `uninstaller.nsh` 的 `un.atomicRMDir` 只遍历 **`$INSTDIR` 内部**的条目（`StrCpy $R3 "$INSTDIR$R0\*.*"`），
     最后 `RMDir /r $INSTDIR` ——删除范围严格限于 `$INSTDIR`，**父目录不会被上升清理**。
  2. `installUtil.nsh` 的 `uninstallOldVersion` 清旧版本的方式是 `ExecWait '"…uninstaller…" /S … _?=$installationDir'`，
     `$installationDir` 来自注册表 `InstallLocation`（**上一次的安装位置**），不是用户本次新选的路径——
     所以「把安装路径改到 bin」这个动作不会被「按新路径清空」误伤。
- 结构：`<容器>\{bin, data, skin}`。程序侧 `config.js:resolveUserRoot()` 识别「exe 在名为 `bin` 的子目录里」→
  数据根取父目录（数据 `<容器>\data`、皮肤 `<容器>\skin`）；不是 bin 结构时保持 29.6 的同级 `-data\` 约定（向后兼容）。
- 皮肤子目录 1.0.6 起由 `skins\` 更名为 `skin\`；迁移时把旧名目录并入新名（missing-only），旧结构用户不受影响。
- 首次安装**不用手选路径**：1.0.7 起安装器（`resources/installer.nsh`）自动把程序下沉到 `<容器>\bin\` 并建好 `data\`、`skin\`——
  规则是「末段已是 bin 就不动；容器根已有 bin（或为空、或只有旧程序文件）就下沉；容器根有 data/skin 却没有 bin 时保守不动（避免旧卸载程序连带删掉数据）」。
  之后的升级会读注册表旧位置自动预填，保持 `…\bin`。
- 单测：`tools/test-data-root.js`（7 用例，含「容器不可写 → 回退 userData」这一分支）。

### 48. 把判定逻辑抽成不依赖 electron 的模块 + 纯 node 单测，首跑就抓到真 bug
- 背景：「Ctrl+三击走过去」的判定（三击识别、冷却、落点钳制）如果直接写在 main.js 里，就只能靠真机点击验，边界用例（慢三击、三次分散、冷却边界、贴边钳制）几乎无法稳定复现。
- 做法：抽成 `walk.js`（只依赖传入的时间戳与坐标，不 require electron），`tools/verify-walk.js` 用纯 node 跑 30 条用例。
- **收益立竿见影**：首跑抓到 `firedAt` 初值写成 `0`，导致「第一次三击被冷却判断误挡」（`now - 0 < cooldownMs` 对早期时间戳恒成立）——这个 bug 在真机上因为 `Date.now()` 很大而永远不出现，只有能注入时间戳的单测才抓得到。另有一条失败是我自己用例写错（把冷却边界当成必挡），单测把「我以为的行为」和「实现的行为」摆在一起对账。
- 用法约定：新增这类纯判定/几何计算优先放 `walk.js` 这种不依赖 electron 的模块，并在 `tools/` 配纯 node 自测；`package.json` 的 `build.files` 记得同步（架构铁律 1）。

### 49. 新增一个动画状态要同时改三处；翻转姿态别用 transform
- 背景：给桌宠加「走过去」的 `move` 状态（主进程按帧推进窗口位置，渲染端播走路帧）。只改帧表会半通不通。
- 完整链路（缺一处就少一点能力）：
  1. `renderer/pet.js` 的 `SKIN.frames` 加 key（emoji 默认帧）；
  2. `skins.js` 的 `SKIN_STATES` —— 它决定图片皮肤的约定文件名（`move.gif/png/jpg/webp`）与挑选窗的状态列表；
  3. `renderer/skin-picker.js` 的 `STATE_LABEL`（中文标签，如「移动」）。
  `applySkin()` 是遍历 `Object.keys(SKIN.frames)` 重建帧源的，所以第 1 步做完，图片皮肤的缺失回退（没给 move 图就回退 idle）和 emoji 映射会自动跟着走。
- 翻转姿态的坑：`.pet-body` 挂着 `float`、`.pet-face` 挂着 `pop`，**两者都占用 `transform`**；向左走想翻转写 `transform: scaleX(-1)` 会和这两个动画互相覆盖（本项目已有「用 transform 移脸测穿透、结果时好时坏」的同源教训）。改用 CSS 独立变换属性 **`scale: -1 1`**，与 transform 互不干扰，`.pet-face.flip` 一行搞定。
- 验证方式（可复用）：状态机 + CSS 这种改动别只看代码或只靠肉眼——`tools/verify-walk-visual.js` 用 CDP 从主进程发 `pet:walk`，再读 `dataset.state` / `classList.contains('flip')` / `getComputedStyle(face).scale` / `getComputedStyle(body).animationName` 四项并截图，一次把「状态切了、翻转生效、动画换了、结束了能回 idle」全验掉。
- 主进程侧的配套：移动用 `setInterval(约 30fps) + setPosition` 逐帧推进，期间每帧 `syncPetPassThrough`（只在状态真翻转时才下发原生调用，避免回到 #30 那种风暴）；打断点有四条——新的一次触发（按当前位置重规划）、拖动（`pet:move-by`）、锁屏重建窗口、退出；位置只在「走完」或「拖动结束」时落盘，避免半路被打断时把中途位置当成家。

### 50. Windows 上主进程的 setInterval 被量化在约 15.6ms：按「请求值」推算帧率会算错
- 症状：桌宠「走过去」用 `setInterval(33ms)` 推进窗口位置，用户第一句反馈就是「走得有点快，而且**帧率太低**」——肉眼看是一顿一顿的阶梯。
- 实测（`tools/measure-walk-perf.js`）：
  - 单次 `win.setPosition` 只要 **0.16~0.22ms** —— 不是瓶颈，别在这上面优化；
  - 请求 33 / 16 / 8 ms 实际只跑到 **24 / 43~48 / 63 Hz**：明显是 ~15.6ms 的量化台阶（Windows 默认定时器分辨率），**按请求值算「33ms = 30fps」直接错了两成**。
- 解法：帧间隔改 8ms（实测约 63Hz，230px/秒下每步 3.5px，看不出台阶）；位置一律用**墙钟时间算进度**（`t = (Date.now() - startedAt) / durationMs`），于是定时器抖动只影响步长均匀度、不会让速度跑偏。
- 备选（实测过但未采用）：`winmm.timeBeginPeriod(1)` 能把同样的 8ms 请求拉到 **116Hz**（每步 1.9px）。代价是走路期间抬高整机定时器精度（功耗），且必须保证 `timeEndPeriod` 在所有退出路径成对调用、否则精度一直悬着。63→116Hz 的边际收益不值这个代价，暂不做。
- 教训：**帧率类问题先量「实际投递率」再调参数**，别拿请求值当事实（同 §10.5「先测量，后假设」）。

### 51. 托盘图标的两个必备动作 + 「隐藏后统计还在不在」怎么测
- 托盘（Tray）必须在**模块级变量**里留着引用：Electron 的 Tray 一旦被 GC 回收，图标会从通知区域突然消失，而代码上看不出任何错误。
- 退出时 `tray.destroy()`：不销毁又遇到退出流程被卡住时，托盘里会留下一个「幽灵图标」（挪上去才消失）。
- 桌宠窗口「隐藏」用 `hide()` 而不是 `close()`：窗口仍然存在，`window-all-closed` 不会触发、进程与钩子/翻译都照常跑；恢复用 `showInactive()`（不能用 `show()`，那一下会把前台窗口的焦点抢走，和 anchor 窗口同理）。
- **测「隐藏后计数还在涨」有个坑**：`stats:get`（面板口径）是从 `data/keys-*.json` **文件**汇总的，而计数是「内存累计 + 每 5 秒落盘」→ 隐藏后立刻读会得到和隐藏前一样的数字，看着像「统计停了」。正确做法是**等过落盘周期（或轮询到数字变化）再判定**（`tools/verify-hide.js` 就是这么做的：轮询最多 12 秒）。验证手段用的是系统级 `keybd_event` 注入 F24（没有应用绑这个键，副作用最小），而不是 Electron 内部 API —— 这样测到的是「系统钩子确实还在收键」。
- 让开逻辑的实测口径：`tools/verify-flee.js` 用 koffi `SetCursorPos` 把真实光标放到宠物形象上、等 5 秒以上，再看窗口位移与日志里的方向。
  - **用户真实鼠标会覆盖注入的位置**（§10.3 的老问题）：第一轮只设一次光标，结果「停留」计时被真实鼠标打断，触发漂到 7.7 秒，我读到的窗口位置还停在走路途中（看着像功能没生效）。修法是在等待期间**每 500ms 把光标按回原位**，这样整轮测量（8 秒）稳定，实测 5 秒准点触发。
  - `--center`（下方有余量 → 纯向下）与 `--low`（底边上方 60px → 向下不够）两个姿势各测一次，才能覆盖「向下优先」和「下+左右叠加」两种形态。

### 52. 「点不动」的新根因：穿透状态有两个写入者，主进程记账被写乱后永久卡死
- 症状（用户报「用移动功能后点不动」）：点击全被转发到下层窗口，**但计数正常、悬停也有反应、应用日志还显示「可交互」** —— 而 `probe-window-style` 读原生样式却是 `WS_EX_TRANSPARENT` 仍在。**日志与真实原生状态不一致**是这次最迷惑人的地方（前几轮取证都被日志带偏过）。
- 根因：穿透状态由主进程轮询下发，并做了「值没变就不下发」的优化（`petIgnoreSent` 记账）；但 `renderer/pet.js` **也在 mousemove 时直接调 `setIgnoreMouseEvents`**（当年为了把切换延迟降到 0）。渲染端写的那次不更新主进程记账 → 主进程算出「应该是可交互」时发现记账里已经是 `false`（它以为早就是可交互）→ **直接 return 不再下发** → 窗口永久卡在穿透。落点压在形象边界（还有 ±6px 漂浮动画）时，两边反复翻转，更容易进入这个状态。
- 实测复现与回归（`tools/verify-passthrough-desync.js`）：光标压在桌宠上（原生样式确认可点）→ 从渲染端写一次 `ignore=true` → 等 1.5 秒（6 次轮询）**仍是穿透 = 卡死复现**；修复后同样操作 **120ms 内自愈**。
- 修复（三条一起，缺一条都可能再卡）：
  1. **主进程是穿透状态的唯一写入者**：渲染端不再调 `setIgnoreMouseEvents`（拖拽/玻璃期间改成发「保持可交互」意图 `pet:keep-interactive`，仍由主进程下发）；
  2. `pet:set-ignore-mouse-events` 通道保留但**同步记账**（`petIgnoreSent = ignore`）—— 将来任何写入方都不会再让记账失真；
  3. 光标**刚进入**交互区时无条件重新下发一次「可交互」（自愈历史遗留的不一致）。
- 附带：轮询间隔 250ms → 120ms（入场翻转延迟减半，也顺带缩小「移过去马上点」丢点击的窗口）。
- 教训：**同一个原生状态存在多个写入者时，任何「值没变就跳过」的优化都会退化成永久卡死**；要么保证单一写入者，要么记账必须由写入方同步更新。另外——日志只证明代码想干什么，**验证真实窗口状态必须用原生探针**（§29 的 `probe-window-style.js` 这次是决定性证据）。

### 53. uiohook **不派发 mouseup**：任何「是否正按着」的状态都别指望系统钩子
- 实测（`tools/probe-mouse-event.js` 现已同时打印按下/松开）：注入一次标准点击，探针稳定收到 `↓按下`，**永远收不到 `↑松开`** —— 而 `uiohook-napi` 的类型声明里明确写着 `on('mouseup', ...)`。**类型声明有 ≠ 运行时会派发**（与 §46 的 clicks 是同一类坑，但结论相反）。
- 踩法：给「鼠标停留 5 秒自动让开」加「按住时不触发」时，我用钩子的 mousedown 做按下计数、mouseup 做解除 → 计数永远停在 1 → **让开被永久禁用**（表现是「松手后怎么都不走开」）。是验证脚本 `tools/verify-flee-interaction.js` 的「松手后应触发」用例抓出来的。
- 正确做法：用**渲染端的 DOM `mousedown`/`mouseup`**（在自家窗口里可靠）上报「正按着」状态给主进程；钩子只负责「点在哪、点了没」。
- 补充兜底：系统钩子因为拿不到 mouseup，「按着」状态可能因为「在宠物窗口按下、在窗口外松开」而残留 —— 用「钩子看到**互动范围之外**的 mousedown」来清掉这个状态（那次按下说明上一次互动已经结束）。
- 教训：**平台事件的「有没有」必须用探针实测**，别拿类型声明或文档当依据（本项目已两次栽在 uiohook 的字段/事件上）。

### 54. 隐藏→显示 也要重建窗口句柄（与锁屏解锁同类）
- 现象（用户实测）：托盘「隐藏桌宠」再「显示桌宠」后，桌宠看着可点、点击却进不来（全局计数正常）。
- 定性：与「锁屏解锁后点不动」同一类 —— 旧 HWND 与会话/输入系统失联，样式看着可点但收不到鼠标消息。
- 解法：`showPet()` 不要对旧窗口 `showInactive()`，改为复用解锁那条 `recreatePetWindow()`（位置/皮肤/计数按配置恢复，`petIgnoreSent` 置空后穿透状态重新下发）。用户复验：恢复正常。
- 注意：这**不是**穿透状态双写入者那条 bug（§52）—— 两条独立存在，2026-09-22 先修了 §52，用户复测发现隐藏显示仍会坏，才有了这一条。
- 测量教训：本机**注入点击不可靠**（同一段代码时通时不通，连「隐藏前」都会测成不通），这类「点击进不来」的问题最终必须由用户在真机上用真手确认，注入只能当辅助线索。

### 57. 任务栏偶尔冒出两个 desktop-pet 窗口（一透明一带宠）：skipTaskbar 是 shell 侧登记，任务栏重建后会回流
- 现象（用户报，低频复现）：Windows 任务栏有时出现两个 desktop-pet 条目，一条**纯透明**、一条**显示桌宠**；平时没有。
- 定性：常驻可见的顶层窗口只有桌宠窗和锚点窗各一，「一透明一带宠」正是它们。Electron 在 Windows 上的 `skipTaskbar` **不是**窗口样式位，而是 `ITaskbarList::DeleteTab` 向 explorer（shell）做的**登记**；登记存在 shell 侧。任务栏一旦重建（explorer 重启、shell 崩溃自动重启、部分显示拓扑变化），shell 会重新枚举所有可见顶层窗口并把 tab 加回来，而 Electron 不会补删 → 两个窗口一起在任务栏冒出来。低频正对应「任务栏重建」的低频，属平台行为，非应用逻辑 bug。
- 解法：建窗后用 koffi 补 `WS_EX_TOOLWINDOW`（`main.js forceNoTaskbar()`，桌宠窗与锚点窗都补）。工具窗在 shell 枚举时就被排除，**没有可丢失的登记**，对 explorer 重启/显隐循环/显示拓扑变化全部免疫；`skipTaskbar: true` 保留作兜底。代价：两窗也从 Alt-Tab 消失（桌宠本就 `focusable:false` 不可激活，无实际影响）。注意 `SetWindowLongPtrW` 后必须 `SetWindowPos` 带 `SWP_FRAMECHANGED` 样式位才生效；已带该位时直接 return，避免反复 FRAMECHANGED。
- 验证（dev，2026-10-01）：`tools/probe-window-style.js` 显示两窗均 ✓ WS_EX_TOOLWINDOW，其余样式（穿透/分层/NOACTIVATE/260×300）不变；同法对照升级前的安装版进程，桌宠窗确实没有该位。任务栏重建本身的复现归用户实机（重启 explorer 或等自然复现），无法安全模拟。
- 关联：§29.5（锚点窗与任务管理器分组）、§54（隐藏→显示重建句柄）。锚点窗补 TOOLWINDOW 不影响其「focusable 可见窗口」的分组身份（分组看的是可聚焦性，不看工具窗位）。

### 58. 菜单 20px 字号长标签被裁：面板是块级元素，宽度从不随内容走
- **症状**（用户报，附截图）：菜单字号调到 20px 后，长菜单项（「鼠标停留 5 秒自动让开」「隐藏桌宠（只留托盘图标）」）右侧文字被裁掉一半。
- **根因**：`.panel` 是普通块级元素，宽度恒等于窗口宽（初始 250px），高度才随内容长；渲染端 `menu:resize` 上报的 `panel.offsetWidth` 因此是「窗口宽 - 12」而不是内容宽——窗口宽度的自适应**从来没生效过**，14px 及以下只是碰巧装得下。溢出被 `body` 的 `overflow:hidden` 吃掉，表现就是右侧裁字。
- **解法**（0622cd0）：`.panel { width: max-content }`，`offsetWidth` 变成真实内容宽，宽度自适应立即生效。**不要**顺手加 `max-width: calc(100vw - 12px)`：它以当前窗口宽为基准，内容变宽时窗口不变、上限也不变，形成「量不出更宽就不长」的死循环；超宽防护由主进程 `menu:resize` 的 440px 钳制负责。顺带把 `.item .mark` 的固定 `16px` 改成 `1em`（20px 字号下 ✓ 字形装不进 16px 盒子）。
- **教训**：「按内容自适应窗口尺寸」这类说法要分别验证两个方向——高度自适应生效不代表宽度也生效。

### 59. dev 冒烟「像灵异崩溃」的两种形态与进程核实工具的坑（agent 会话实录，2026-10-01）
- **形态一（§4.6 的坑再确认）**：宿主 shell 继承 `ELECTRON_RUN_AS_NODE=1`，`npm start` 第一行就炸 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`——先 `env -u ELECTRON_RUN_AS_NODE`（详见 §4.6，勿赋空值）。
- **形态二（易误判成「代码改坏了」）**：`env -u` 之后不炸了，但进程静默退出、日志只有一行 `before-quit: 开始收尾`、没有任何启动痕迹。根因：**安装版常驻进程占着默认 userData 的单实例锁**，dev 重试 20 秒后自动让位退出（§27 的接缝在起作用，不是 bug）。排查定型动作：`PET_USER_DATA_DIR=<临时目录> npx electron .` 隔离 userData 冒烟——能完整启动（日志出现锚点/桌宠 HWND）就证明代码没问题、锁在别人手里。
- **进程核实的坑**：会话内内置 PS 查询工具两次**静默返回空输出**（exit 0），差点把「没有实例在跑」的误判当真相；`wmic` 被安全策略黑名单拦、bash 转调 PS 也被拦。**能用的定型动作：bash 跑 `tasklist | grep -iE "desktop-pet|showcase"`**（改名过渡期两代映像名并存：1.0.48 及以前 desktop-pet.exe、1.0.49 起 Showcase.exe，五进程一组——只 grep 旧名会在新包上静默空输出，恰好复现这条要防的假象）。

## 八、遗留问题与已知边界（截至 695d0ac）

- 游戏内体验取决于游戏类型：不锁鼠标可拖可计数（需提权）；锁鼠标只能看不能点；真独占全屏不可见。
- 管理员模式下资源管理器拖放导入不可用（UIPI），普通模式恢复。
- DRM 视频截不到画面；花体字幕 OCR 率低。
- 多语种（SenseVoice）无逐字原文，粒度为 1.2s 半句；日韩粤已实测可用。
- llama 未启动时同传/整句翻译静默跳过（30s 退避气泡提示）。
- 安装包 ~512MB（双 ASR 模型 + OCR sidecar）。
- 卡死自恢复只覆盖「渲染进程崩溃 / 无响应」两条；实测 12 秒 JS 死循环没能触发 Chromium 的无响应判定（`unresponsive` 分支未跑到过，走的是同一条 reload 路径）。主进程自身若被原生调用阻塞，仍只能等 3 秒兜底 `app.exit(0)`（仅在退出时生效）。

## 九、诊断工具箱（tools/，都是纯 node，可直接跑）

统一前置：`PET_USER_DATA_DIR=<临时目录> npx electron --inspect=9229 --remote-debugging-port=9333 .`
（`--inspect` 是主进程，`--remote-debugging-port` 是渲染端；主进程里 `require` 取不到，要用 `process.mainModule.require(...)`。）

- `verify-quit.js ["预置表达式"]` — 调 `app.quit()` 测退出耗时，另接 15s 轮询确认调试端口消失（= 进程真的退了）。例：传 `process.mainModule.require('./asr').startAsr('streaming')` 验证「worker 存活时退出」。
- `measure-ignore-storm.js` — 统计主进程收到多少次 `pet:set-ignore-mouse-events`（脸上移动/拖拽/透明区三场景）。回归红线：**200 次移动应只产生 0~2 次样式切换**。
- `measure-subtitle-storm.js` — 同上，针对字幕条（先经 `window.petAPI.menuAction('tr-voice')` 打开条）。
- `verify-recovery.js` — `forcefullyCrashRenderer()` 打崩渲染进程 + 注入 12 秒假死，确认窗口自我恢复而不是整个程序退出。
- `verify-passthrough.js` — 验证穿透状态会不会卡住：主进程钩住 `setIgnoreMouseEvents` 读真实状态，再把宠物脸移到静止的指针下方，看是否自愈（红线：600ms 内必须变回可交互）。
- `verify-rescue.js` — 验证救援动作的渲染端一半：发 `pet:force-interactive` 后应强制 `setIgnoreMouseEvents(false)` 并弹出菜单窗口。（真实按键 Ctrl→Alt→P 走系统钩子，注入不了合成按键，那一段只能人工确认。）
- `probe-windows.js` — 只读探针：窗口存活/崩溃状态、可见性、bounds，以及渲染端 `#pet-face`/计数文本是否还在。
- 计数类埋点别放渲染端：`contextBridge` 暴露的 API 属性只读，`window.petAPI.xxx = ...` 静默失败（本轮踩过，导致新旧代码都测出 0）。挂主进程 `ipcMain.on` 才准。

### 37. 视频翻译卡顿：desktopCapturer 每次调用约 450ms 固定开销
- 症状：视频翻译一开，任务管理器里 `desktop-pet (N)` 整组 CPU 高企（实测 ocr_server 37.8%/581MB、主进程 41.1%/1077MB），电脑明显卡顿。
- 实测（同一进程里连续调 `desktopCapturer.getSources`）：整屏 2560×1440 与缩到 1600×900 **耗时一样**（520/422/413/488/516ms vs 437/524/596ms），只有一次 40ms 是异常值。**结论：这个接口的开销是「每次调用重建采集管线」的固定成本，与缩略图像素数无关**，所以降采样救不了它——间隔才是这块的旋钮。
- 已做：`ocrIntervalMs` 默认 1s→2s（直接减半）；仍然把整屏缩到 ≤1600 宽再裁区域 —— 这不减采集成本，但**送 OCR 的像素少了一半以上**，直接压低 ocr_server 的 CPU 与内存（那 581MB 就是喂进去的图撑起来的）；同帧跳过与 busy 守卫保留。
- **真正的解法是别再重复调用它**：用 `getDisplayMedia`（框选那一下就是用户手势）在渲染端持一条常驻画面流，每拍只把区域 `drawImage` 到 canvas + `toBlob('image/jpeg')` 经 IPC 交给主进程转 POST——每拍从 ~450ms 降到几毫秒。代价是要把采集从主进程搬到渲染端，并处理流生命周期与区域变更同步；**尚未实施**。
- 排查这类问题别只看任务管理器总量，要单独量可疑 API 的单次耗时（本例一次 `node -e` 连调 3 次就定位了）。

### 38. 渲染进程被外部杀掉 → 重载后卡在穿透（穿透判定的最后一环）
- 症状：桌宠动画正常、计数正常，但点击无反应、齿轮点不开；**管理员启动和普通启动都一样，重启也不恢复**。
- 真因在用户机器日志里抓到了：`pet 渲染进程退出: killed exitCode=1`（出现两次）——渲染进程被**外部**（系统/安全软件）杀掉，不是程序自身。我的自恢复会静默重载它，而重载后的新页面：
  1. 没有任何 mousemove，`lastScreen` 为空 → 穿透判定只能保守地设成「穿透」；
  2. 若此时鼠标恰好停在桌宠上又是静止的（点击不产生 mousemove），就**永久**点不动——正好对上「重启也不恢复」（重启后同样是这个状态）。
- 修法：穿透判定不再依赖 mousemove 推位置，改为每 250ms 向主进程要**真实光标位置**（`screen.getCursorScreenPoint()`，新 IPC `pet:cursor`），页面刚重载也能立刻算对。附带好处：形象漂浮/窗口被拖走导致命中区变化时，也不再需要等一次鼠标移动。
- 验证（打包版，`tools/verify-cursor-sync.js --face`）：把真实光标移到宠物脸中心后重载页面 → 记录到 `[true,false]`（重载后立刻恢复可交互）；光标在别处重载 → `[true,true]`（保持穿透，正确）。
- 另一条线索：用户观察到任务管理器里桌宠进程「散出去两个」，与重载后新渲染进程丢了分组身份是同一事件的两面（分组是外观问题，功能问题已修）。
- 教训：任何「只在事件驱动下更新的状态」，都要想清楚**页面刚加载/刚重载、还没有任何事件**时它取什么值；能直接问系统要事实（光标位置）就别用推断。

### 42. 「点不动」的两条路：先量原生窗口样式，别再猜
- 用户反馈锁屏解锁后稳定复现，且上一轮"渲染端定时器被节流"的修法没能解决 → 说明还有第二类原因。
- 新增硬测量手段（不依赖调试端口，能直接对**安装版**用）：
  - `<数据目录>\showcase.log` 现在会记录 `桌宠窗口 HWND=0x...`；
  - `node tools/probe-window-style.js` 用 koffi 读该 HWND 的 `GWL_EXSTYLE`，直接告诉你窗口此刻**是不是真的挂着 `WS_EX_TRANSPARENT`**（点击穿透），并带上光标位置与是否在窗口内。
  - 实测对照：光标在窗口外 → `EXSTYLE=0x08080028`（含 `WS_EX_TRANSPARENT`）；光标移到脸上 → `EXSTYLE=0x08000008`（该位消失）。**这条判据可以把两类原因分开：**
    - 点在桌宠上却仍带 `WS_EX_TRANSPARENT` → 穿透状态确实是错的（看日志里"穿透状态 桌宠: ..."那几行，能看出主进程当时判成了什么、区域来源是上报还是兜底）；
    - 点在桌宠上且**没有**该位 → 问题不在穿透，而是点击没被渲染端处理（渲染端僵住/被别的窗口截走）。
- 本轮对应的两道保险：
  1. **兜底可交互区**：渲染端还没上报（页面刚加载、解锁后一时不响应）时，不再默认"整窗穿透"，而是用覆盖形象/计数/齿轮的固定区域判定——可见的桌宠不会再完全点不动。
  2. **渲染端存活探测**：主进程定期（解锁/唤醒时立即 + 每 30 秒）`pet:ping`，2.5 秒没回 `pet:pong` 就判定为"没崩溃但已僵住"，直接重载页面并记日志。这类"僵住"正是"动画在动（合成器）但事件不再处理"的形态。
  3. 穿透状态每次变化都写日志（含光标是否在区域内、区域来自上报还是兜底），变化本身很稀少，不会刷屏。

### 43. 「点不动」的真凶：状态高频翻转把 click 劈成两半
- 现场（用户日志实测，锁屏解锁后稳定复现）：
  - 解锁**前**点击正常，日志有 `桌宠收到点击: pet-face button=0 @120,196`；解锁**后**一次点击都没到达渲染端。
  - 同时日志里状态以约 **2Hz 来回切**：`可交互(是)` → `穿透(否)` → `可交互(是)` …，而交互区域尺寸在微动（`6,145 248x155` ↔ `6,148 248x152`，±3px）。
- 机理：`click` 事件要求 **mousedown 与 mouseup 落在同一个窗口**上。状态在 2Hz 翻转时，"按下那一刻可交互、松开那一刻已变成穿透"，于是**根本不产生 click**，表现就是怎么点都没反应。区域微动的来源是漂浮动画与元素（计数/zzz 等）显隐导致并集边界移动；指针恰好停在边界上时就会来回翻。
- 修法（主进程判定处加保持）：**变「可交互」立即生效；变回「穿透」要等光标持续离开 600ms**。这样一次点击的按下与松开必然都在可交互窗口内。
  - 代价：离开桌宠后约 0.6 秒内，它周围那块区域仍算可交互，此时点在那里不会穿透到桌面（点不到东西），属可接受的取舍。
  - 桌宠与字幕条都加（字幕条窗口高度随文本变化，边界同样会抖）。
  - 锁屏/唤醒的强制重同步用 `force` 直接按当前值应用，不受保持影响。
- 验证（dev 实测）：光标移出 → `可交互(光标在区域内=否)` 保持约 681ms 后才切 `穿透`；光标移入 → 立即 `可交互`。
- 教训：这类「原生窗口状态 + 边沿触发」的组合，必须考虑**状态抖动与用户操作的时间重叠**；只要操作本身跨两个状态周期（这里是 mousedown/mouseup），就会静默丢事件。
- ⚠️ **本条最初只修了一半**（2026-09-25 复发，见 #46）：当时只延迟了「离开」这一侧，且把 `justEntered` 直接翻成 `force`，等于给「进入」开了一条绕过保持的即时通道 → 抖动照样 2Hz 翻。

### 46. 「点不动」复发（第八轮）：进入通道绕过保持 + 命中判定没吸收抖动
- 症状（用户报告「怎么最新版桌宠现在又不能点击互动了」）：**锁屏解锁后**稳定复现；悬停有反应（说明窗口收得到鼠标消息）但点击没反应；救援热键 Ctrl+Alt+P 能救回来。
- 现场（安装版日志实测）：
  - 穿透状态在 **2Hz 来回翻**：`可交互` → `穿透` → `可交互`，间隔 **247ms / 740ms / 993ms**，其中 247ms 的「穿透→可交互」反转**比 600ms 保持时间还短**。
  - 全天日志里 `桌宠收到点击` **一条都没有** —— 但这条探针当时是**哑的**（见下面第 3 点），不能据此判断「点击没到窗口」。
- 两个独立根因（都在同一处逻辑里，必须一起修）：
  1. **进入通道绕过保持**：`justEntered` 时把 `force = true`，而 `force` 分支是 `!inside` 直接下发、不受 `PASS_HOLD_MS` 约束。指针停在抖动边界上时，每次 box 变化都会制造一次「刚进入」→ 立刻翻回可交互，把保持时间整个抹掉。**「变可交互立即生效」只有在命中判定本身稳定时才安全。**
  2. **命中判定没吸收抖动**：`inside` 直接拿上报 box 做边界比较，而 box 的并集边界随漂浮动画与计数/zzz 显隐以 1~2Hz 微动 **±6px**（实测 `2,142 256x158` ↔ `2,148 256x152`，下沿恒为 300）。指针停在边界附近时，一次 box 变化就把 `inside` 从真翻成假 —— 状态机被喂进真假交替的输入，加多少迟滞都在跟噪声搏斗。
- 修法：
  1. **命中判定加余量**：`JITTER_PAD = 10`（比实测抖动 ±6px 大一档，远小于形象尺寸）。指针在「区域 + 余量」内即算可交互，抖动被整个吸收，`inside` 保持恒定 —— 这才是根治，迟滞只是补救。
  2. **唯一的即时通道只留 `petKeepInteractive`**（拖拽/玻璃，由真实事件驱动，不是抖动）；进入也走余量判定，不再有绕过保持的 `force`。
  3. `petIgnoreSent === null`（窗口刚建/刚重建）时按实时结果直接下发，避免首轮被 `null` 兜成错误的可交互/穿透。
- **顺带修掉两个「哑探针」**（这次排查被它们误导过）：`preload.js` 与 `renderer/pet.js` 早就接好了 `pet:click-probe` 与 `pet:client-error` 两条通道，**`main.js` 里却没有对应的 `ipcMain.on` 处理器** → 日志里永远一条都没有，无法区分「点击没到窗口」与「到了没记录」，也无法看见渲染端顶层抛错（打包版没有控制台）。现已补齐：点击探针带 60ms 去抖落 `桌宠收到点击: …`，渲染端异常落 `渲染端异常: …`。
- 验证：
  - 纯逻辑回归 `tools/verify-pass-hold.js`（9 场景 / 13 断言）：边界 ±6px 抖动 10 秒 **0 次切换**、真实离开仍守满 600ms、真实进出与 `keepInteractive` 均正常。
  - 实测（dev）：光标压上形象 → 日志仅 `可交互` 一次；移开 → 仅 `穿透` 一次，**无任何短于 600ms 的反转**；注入真实点击后日志出现 `桌宠收到点击: unknown button=0 @248,150`（此前完全静默）。
- 教训：①**「同一处逻辑反复动」的账要算清** —— 保持时间只治症状的一半，输入侧不稳时它只是把噪声周期拉长；先让输入干净，再谈状态机。②**探针必须先验证它真的在写日志**：没有落地处理器的 IPC 通道是「假探针」，比没有探针更危险 —— 它会让你把「没记录」误读成「没发生」。

### 44. 解锁后「日志说可交互、点击却进不来」
- 现场（用户日志，锁屏解锁后）：**解锁前**点击全部到达（`桌宠收到点击: pet-face …` 连续多条），**解锁后**一条都没有；而穿透状态日志显示光标在区域内时主进程判成了「可交互」。也就是：应用层以为窗口可交互，系统层面点击却进不来。
- 推断：解锁/唤醒时 Chromium 内部「是否忽略鼠标事件」的标记可能与真实窗口样式失步——它以为已经是「不忽略」，于是再调 `setIgnoreMouseEvents(false)` 变成空操作，窗口样式仍停在穿透上。
- 处理：锁屏/唤醒的强制重同步里**先反向设一次把标记踢开**（`setIgnoreMouseEvents(true)`），再按判定结果重设；顺带 `showInactive()` + 重申 `setAlwaysOnTop('screen-saver')`，把会话切换后可能失序的窗口状态一并找回。
- 若这一脚还踢不动，下一步是**解锁后重建桌宠窗口**（重新向系统注册窗口与输入）；判断依据用 `tools/probe-window-style.js --watch`：先起监测、再保持鼠标悬停在桌宠上点击，看是否打印
  `★ 异常：光标就在它身上却仍是穿透状态`。
  - 打印了 → 样式确实卡住（重建窗口几乎必然能修）；
  - 没打印（窗口不是穿透，可点击却仍无反应）→ 问题在 Chromium 输入路径，同样指向重建窗口。
- 工具用法补充：`--watch` 模式正是为这种「必须一直把鼠标停在桌宠上才能复现」的场景准备的——否则你一跑命令，鼠标就移开了，测的就不是故障状态了。

### 45. 解锁后点击进不来（最终修法：重建窗口）
- 决定性证据（`tools/probe-window-style.js --watch`，用户实测）：解锁后把光标停在桌宠上，窗口真实样式是**「可接收点击」**（没有 `WS_EX_TRANSPARENT`），渲染端也活着（能回 pong），**但点击就是不进来**（日志里没有任何 `桌宠收到点击`）。
- 结论：不是穿透状态、不是判定逻辑、不是渲染端僵住，而是**这个窗口在会话切换后与系统输入失联**。这类状态没法靠"再设一次 setIgnoreMouseEvents / 反向踢一脚"可靠救回——试过，无效。
- 修法：`unlock-screen` / `resume` 时**重建桌宠窗口**（destroy + createPetWindow，拿到全新 HWND）。位置取当前 bounds 存回 config，皮肤/计数/可交互区域都会照常恢复；代价是解锁瞬间桌宠闪一下（约 0.2 秒）。
  - 细节：重建期间置 `recreatingPet`，让 `closed` 处理器**不要连锚点窗口一起收掉**（否则任务管理器分组身份丢了）；同时置 `recovering` 避免 `window-all-closed` 退出。
  - `lock-screen` / `suspend` 只做轻量重同步（反向踢一脚 + 重申可见性/置顶），不重建。
- 验证（dev）：`powerMonitor.emit('unlock-screen')` → 日志出现「重建桌宠窗口以确保输入恢复」+ 新 HWND；窗口数仍为 2（桌宠 + 锚点）；渲染端 0.7s 内重新上报区域；进程健康。
- 教训：遇到「应用层一切正常但系统不给输入」，别再在应用层找补——**重建窗口句柄**是最省事的终极手段；调试这类问题要把「光标必须停在故障区域」这件事考虑进去（`--watch` 模式）。

### 70. 删大功能时把相邻的 IPC 接收端连带删掉 → 「有发送、无接收」静默失效（拖拽导入消失两周无人发现）
- 症状：把图片/.eif 拖到桌宠身上毫无反应（无气泡、无日志、无报错）；菜单「导入表情包（eif）…」却一直正常。71c873f（按用户要求整体删除视频翻译）起就失效，直到用户问「导入支不支持 zip」顺带排查才发现。
- 根因：主进程里 `ipcMain.on('skins:drop-import', …)`（866ddb4 引入）与被删的翻译代码相邻，整段被连带删掉；而 preload 的 `dropImport` 与 renderer 的 drop 监听都还在。Electron 对**无人监听的 `ipcRenderer.send` 不报任何错**，于是静默失效。README 里该功能条目仍在——与 §63「修好一半、废掉另一半无人发现」同型：删功能的验收清单只覆盖了「删的东西真没了」，没覆盖「相邻的东西还活着」。
- 解法：从 git 历史原样恢复处理器（fd679b3）；并全量核对 preload 每条 `ipcRenderer.send/invoke` 通道在 main.js 里都有 `ipcMain.on/handle` 接收端（本轮核对结果：恢复后一一配对）。
- 教训：删功能的 diff 要按**通道名**过一遍发送端清单（grep `ipcRenderer.send` / `invoke`），确认每条通道的接收端要么保留、要么连同暴露面（preload API + renderer 调用点）一起删；「有发送无接收」是 Electron 的静默黑洞，运行期永远不会报错，只能靠对账发现。

### 71. 压缩包解库的平台行为坑（adm-zip / 7z-wasm，1.0.45 拖压缩包建皮肤、1.0.46 扩 rar/tar 系）
- **① adm-zip 的 `getEntries()` 不保插入序**：`addFile` 按什么顺序加、`getEntries()` 就按什么顺序拿——不成立（实测近乎乱序）。后果：按遍历序给 `sticker_NNN` 编号会漂移。解法：按包内路径字符串排序后再编号（编号跨导入稳定）。另：**`addFile` 会把 `zz/../../evil.png` 规范化成 `evil.png`**——想用 adm-zip 构造路径穿越夹具是造不出来的；但导入器仍必须不信任包内路径（手造的恶意 zip 没经过这层规范化），本项目写盘只用地生成的 `sticker_NNN` 名，穿越天然不可达。
- **② 7z-wasm 的正确打开方式（Electron/Node 主进程）**：`SevenZip({print, printErr})` 工厂 → `FS.mkdir` + `FS.mount(NODEFS, {root: 真实目录}, '/work')` + `FS.chdir('/work')` → `callMain(['x', 'pack.7z', '-oout', '-y'])`，产物用**真实 fs** 从真实目录读（别走 emscripten FS 读结果）。构建是 EXIT_RUNTIME=0：callMain 后运行时存活、**不会 `process.exit` 吞掉进程**（实测同实例连发两次 callMain 也行——生产代码仍按每次导入新实例写，运行时状态复入无保证）。基于 7-Zip 24.09，zip/7z 全格式，无外部二进制。
- **③ asar 与 wasm**：emscripten 经 `readFileSync` 找 `.wasm`，Electron 的 asar 补丁理论上能让它在 asar 内读到——本项目仍把 `node_modules/7z-wasm/**` 加进 `asarUnpack`（`app.asar.unpacked/node_modules/7z-wasm/7zz.wasm`），不给「emscripten 用了别的路径策略」留发挥空间；require 解析到 unpacked 由 Electron 模块加载器自动处理（与 koffi/uiohook 同机制，已被长期验证）。
- **验证件两轮红全是夹具 bug**（产品语义一直正确）：期望顺序想当然 + webp 魔数在偏移 8 而检查从 0 比对。§10「先测量后假设」对自测件自身同样适用——FAIL 先怀疑夹具再怀疑产品，两边都要拿证据。
- **④ 7zz 的 `x` 对复合流（tar.gz 等）只剥最外层**：`x p.tgz` 输出 `Type = gzip`，产物是**内层 tar 文件**而非包内文件——这不是 wasm 特有，桌面版 7z CLI 同样不解到底（WinRAR 才自动链式）。修法：产品侧二段解包——第一层解出「恰好一个 tar」（偏移 257 的 ustar 魔数）时再 `x` 一层，封顶两层（skins.js `import7z`）。
- **⑤ wasm 构建创建复合流会抛裸数字异常**：`7zz a pack.tgz src` 走到压缩阶段抛 `262192`（C++ 异常被 emcc 转成数字 abort，无消息无栈）。教训有二：验证件里 `callMain` 必须 try/catch，否则异常穿透到顶层只剩一个数字、无从定位（本轮就这样卡过一次）；**tar.gz 夹具改用 7zz 建 tar + node `zlib.gzipSync` 压一层**，反而顺带覆盖了 ④ 的二段解包语义。产品代码只解不建（rar 本也只能解——unRAR 许可），不受影响。

### 72. 改名执行轮的三个新坑：Git Bash 吞 reg 开关、inspector 无裸 require、asar extract-file 覆盖 CWD（1.0.49，票 11-B；票 11-C 改号移位——原与 :692 的 §70 撞号且错位在「十、复盘」章内）
- **① Git Bash 直跑 `reg export <键> <文件> /y` 报「无效语法」**：Git Bash 的路径转换把 `/y` 当 POSIX 路径吞成 `Y:\`，与 §66 实操坑 ①（`/D=` 被剥反斜杠）同族——凡是「/开关」形式的 Windows 命令行参数在 Git Bash 里都可能被转换。解法：`reg` 系列一律经 `cmd //c`（双斜杠绕转）或 PowerShell 跑；registry 读写进代码时用 `execFile('reg', [...])`（不经 shell，无此问题）。
- **② inspector `Runtime.evaluate` 上下文里裸 `require` 是 ReferenceError**：Electron 主进程的 evaluate 全局没有 `require`，要用 `process.mainModule.require('electron')` 间接拿（verify-autostart-elevation.js:77 早已是这个写法，凭「node 里 require 都在」的直觉写探针会白跑一轮）。
- **③ `npx @electron/asar extract-file <asar> package.json` 把文件写到当前工作目录**：在仓库根跑会**先覆盖仓库的 package.json、再被清理命令删掉**——本轮实踩，靠 git checkout + 重放改动恢复（新值可精确重建才没酿成事故）。解法：extract-file 一律先 `cd` 到 `%TEMP%` 的临时目录再跑；「提取到临时目录」与「测完删除」是同一条纪律的两半。
- **教训**：③ 的覆盖链是「工具副作用写 CWD」+「清理命令不带路径守卫」两步合谋——写文件的命令要先问「它写在哪」，清理命令要点名精确路径而不是顺手 `rm` 上一个命令的产物（同一轮还顺手 `rm` 了未验证存在性的 `%LOCALAPPDATA%\Programs\desktop-pet`，损失面为零纯靠运气，已在 findings 读数写回 2 段披露）。
- **③ 于 1.0.57 加固轮复发一次（记这里是因为"读了坑仍然会犯"）**：为了看包内 `preload.js` 还有没有穿透写入口，我在**仓库根**跑了 `npx @electron/asar extract-file … preload.js` → 跟踪文件被产物覆盖、`git status` 立刻显示 `D preload.js`。当场 `git checkout -- preload.js` 恢复（5189 B，与工作树一致），改在 `%TEMP%` 子目录里解包再比对才拿到读数。**结论：这条坑的防护不能只写在文档里——取包内文件的动作要固定成「先 cd 临时目录」的一次性脚本**，人（和 agent）在"就看一下"的心态下会重新踩。

### 73. 拖拽缩放的两路驱动错帧：transform 本地预放 + 窗口异步跟上 = 抽搐；锚定角选错 = 手柄脱离（1.0.41，用户四连反馈）
- **症状**：①贴屏幕角落拖动放大时桌宠抽搐、动画不连贯；②往下拖手柄缩小，桌宠反而朝左上跑，三角手柄被甩在原地甚至随窗口缩小裁出视口「消失」。
- **根因一（抽搐）**：渲染端在 mousemove 里本地预放 `#pet-root` transform（指针先行、全帧率），窗口尺寸经 IPC 30ms 节流后才由主进程 `setBounds` 跟上（窗口后到）；贴边时主进程钳制还要挪窗口原点。同一视觉量被两路以不同节奏驱动，错帧叠加就是抖动。**解法**：单一事实源——渲染端拖拽中只发 scaleTo，`scaleDragFrame` 用 rAF 每帧把 transform 对齐到 `innerWidth/基准`，视觉永远等于窗口，错帧在结构上不可能再发生。
- **根因二（脱离）**：`applyPetScale` 以窗口**左上角锚定**，而手柄钉在桌宠视觉区左上角——缩小时桌宠朝左上收缩、锚定侧反而跑掉，手柄（固定在窗口坐标）与桌宠分离。锚定角必须选**手柄的对角**（右下角）：拖角手柄 = 对角钉死、朝手柄方向伸缩，与窗口/资源管理器拖角 resize 同一心智模型。
- **隐性错（顺带修）**：主进程 `applyPetScale` 判重读 config 的 petScale，但拖拽中不写盘——拖出去又拖回起点值时 `s === petScale()` 误 early-return，窗口卡在半路尺寸；旧管线渲染端本地预放 transform 把它掩盖了，改 rAF 对齐后视觉会跟着卡。**解法**：判重一律按窗口实宽反推（`b.width / 基准`），config 只是持久化落点不是运行时事实。
- **验证件随语义走**：verify-scale 原来用「直调渲染端 applyPetScale + scaleTo」模拟拖拽——改管线后它模拟的是已废弃的路径，断言恒绿但测不到真管线。模拟手势要打在**真实入口**（handle 的 mousedown + document 的 mousemove/up 合成事件序列）上，多拍 move 之间 sleep 留出 IPC + resize + 帧的时间；断言读「窗口实宽反推的 scale」而不是字符串比对 transform（浮点缩放值带尾差）。

### 74. 透明窗缩放抽搐的根治是「零窗口操作」：rAF 对齐窗口实宽反而让错位帧每步必现（1.0.52，§73 的修复被实机打回）
- **症状**：1.0.51 上线后用户实测——放大缩小**全程**画面抽搐闪烁（比 1.0.50 只在贴角放大时更糟）。
- **机制**：Windows 透明（layered）窗每次 `setBounds`——不管改尺寸还是挪原点——OS 都会把上一帧表面**拉伸/错位**显示 1~2 帧再等渲染端跟上。§73 的「rAF 把 transform 对齐到窗口实宽」让 transform 永远**滞后**窗口一步：窗口先变、内容后到，每步缩放都必现错位帧；右下角锚定又使每步都挪原点 → 两路叠加，双向全程抽搐。教训：**「单一事实源」不是万能的——当事实源本身是高噪声异步操作（原生窗口 resize）时，让视觉跟着它走等于让视觉跟着噪声走**。
- **根治（固定窗）**：窗口恒 600×600（= 基准 300 × 缩放上限 2），`#pet-root` 绝对定位钉窗口右下角 + `transform-origin: 100% 100%`——任何 scale 下渲染与「窗口 300s + 右下角锚定 setBounds」**逐像素等价**（数学：视觉(p) = 原点 + 300s + s·(p−300) = 原点 + s·p）。缩放变成纯 CSS transform，拖拽全程零原生窗口操作，错位帧在结构上不可能发生。凡「平滑缩放/平滑移动」需求，先问能不能**不碰原生窗口几何**；要碰，就必须接受陈旧帧，把变化频率降到人眼阈值以下。
- **连带语义坑（判据从整窗改视觉矩形）**：固定窗比视觉大 `600−300s`，「桌宠看得见/避让」若继续按整窗判据，scale<2 时桌宠永远走不近屏幕左/上边缘（开机自愈误判出屏弹回、走过去/让开够不到边）。修法：`petVisualRect`（视觉矩形 = 窗口矩形左/上内收 offset）作为开机自愈/走过去/让开/菜单避让的统一判据；scale-end 时视觉矩形出屏才做**一次刚性回挪**（整体平移无陈旧帧问题）。
- **升级迁移**：petPosition（窗口原点）语义不变但窗口变大，须按「视觉右下角不动」一次性换算（`petWindowFixed` 标记，登记 DEFAULTS），否则升级后桌宠视觉外扩 300s、贴角用户的位置直接坏掉。
- **验证件教训**：rect 断言别测带自身动画的元素——脸有 blink pop 弹跳（±12%），rect 会撞上动画中帧造成假 FAIL；测无动画的 `#pet-root` 容器（顺带直接证明锚定：容器右下角恒 (600,600)）。

### 75. `setLoginItemSettings` 的 Run 值名 = 当前 AUMID，`enabled` 默认会清 StartupApproved 禁用标志——1.0.53 加 `setAppUserModelId` 后，1.0.54 首启写出了第二条 Run 键并把用户的手工禁用静默复原（1.0.54 实机，票 11-E）
- **症状**（用户实机，2026-10-04 17:40 装 1.0.54 后）：①任务管理器「启动应用」出现**两条 Showcase**；②用户在任务管理器禁用 Showcase 后，下次启动又被静默恢复「已启用」（禁用意图失效）；③久坐提醒 toast 归属显示 **Electron** 而非 Showcase。
- **根因（Electron 官方文档实锤，非猜测）**：`app.setLoginItemSettings` 的 Windows 选项里 `name` 的默认值 = **"value name to write into registry. Defaults to the app's AppUserModelId()"**——Run 值名跟着**当前 AUMID** 走。因果链：1.0.50 及以前没有 `setAppUserModelId` → 进程用 Electron 默认 AUMID（`electron.app.<name>`）→ 写出 `electron.app.Showcase`；1.0.53 在 bootApp 加了 `setAppUserModelId(identity.APP_ID)`（为 toast 归属）→ 1.0.54 首启的「① Run 键格式幂等重写」（判定已改 `config.autoStart=true`，不再被 11-D 假阴性挡住）→ `setLoginItemSettings` 按**新 AUMID** 写出 `com.showcase.app`，旧值名 `electron.app.Showcase` 无人清理 → 两条并存。1.0.53 自己没在实机装过，所以这颗雷隔了一版才炸。第二条的 `enabled` 选项默认 `true` = 文档原文 "will change the startup approved registry key and enable / disable the App in Task Manager"——**每次启动的幂等重写都会把 StartupApproved 里的禁用标志清掉**，用户的手工禁用被静默撤销。1.0.50 时代同样语义存在，但幂等重写被假阴性恒跳过、只有用户点模式项才写键，所以从未观测到。
- **实机读数链（2026-10-04，票 11-E 任务 1c 取数）**：`electron.app.Showcase` 的 StartupApproved 值 `03000000EA833D4DE253DD01`（03=启用）在基线（禁用前）与终态（装 1.0.54 + 重启后）**逐字节相同** = 该值名全程无人动过；用户禁用的是 `com.showcase.app`（任务管理器两条同名，值名字母序排前），重启后其 StartupApproved 条目**消失**（禁用标志被清 → 未计量/启用）；Run 键两条 command 完全相同（`…\bin\Showcase.exe" --autostart`）。菜单勾选态（config 驱动）显示「管理员模式」（`autoStartAdmin=true`，用户当日 12:43/14:24/15:11 三次点模式项写入），与「开机是否真启动」背离——**旧口径的盲区不仅存在，且禁用状态会被 1.0.54 每次启动撤销**。
- **toast 归属 Electron 的实测**：`HKCU\Software\Classes\AppUserModelId\` 下无本项目任何键（electron-builder 只把 AUMID 写进快捷方式属性、不注册显示名），`com.showcase.app` 无 DisplayName 可查 → 通知中心回退显示框架名。1.0.53 CHANGELOG「toast 挂在 Showcase 名下」的目标**未达成**（1.0.53 只在 dev 隔离实例验证过 `shown=true`，归属名从未验证过）。
- **修复方向（留票 11-F 裁决，本票只取数未动）**：a) 显式传 `name` 钉死值名 + 迁移期清理 `electron.app.<getName()>` 残留 + 把 `findRunEntry` 判据/`describeOwnRunState` 的值名口径从 `electron.app.<getName()>` 换成钉死的值名（否则意图补齐分支每次启动误判「键不在位」）；b) `enabled` 传 false 的语义需查源码实测（「不碰 StartupApproved」还是「写禁用」不能凭文档猜）；c) toast 归属需注册 `HKCU\Software\Classes\AppUserModelId\<AUMID>\DisplayName`（写实机注册表，需用户裁决）或接受现状改文档。**修复前先解决一个设计问题：用户「在任务管理器禁用启动项」这个动作，本应用该把它当「用户意图：不自启」（则 config.autoStart 该被读回 false），还是当作要与 config 对齐清理的干扰**——这是 1c 的裁决点，归用户。
- **教训**：①「同一 API、同一 Electron 版本」写出不同注册表形态，变量可以是**进程内另一处无关 API 的副作用**（setAppUserModelId 改变了 setLoginItemSettings 的默认值名）——排查「注册表为什么多了条目」时先问「进程 AUMID 此刻是什么」；②官方文档一句默认值（`name`/`enabled`）就是机制，先查文档再猜代码；③写键类 API 在实机上「从未真正执行过」的路径（假阴性挡住的幂等重写），一旦判定源修好就会**首次执行**——修判定前先想清楚这条路径第一次跑会写出什么。
- **解法（1.0.55，票 11-F，用户三裁决落地）**：①「任务管理器禁用 = 用户意图不自启」→ 勾选态合并 StartupApproved 系统事实（首字节 01=禁用/02、03=启用/无条目=未计量启用，`isStartupApprovedEnabled` 纯函数解析，复用 Run 键同一套行解析；bootApp 异步预取缓存），被禁用时菜单视同「关闭」；②Run 键全部改 **reg 直写**（方案 B）：`setLoginItemSettings` 的 `enabled` 没有「别碰 StartupApproved」选项（true=清标志、false=写标志，文档字面），要写路径不碰它只能绕开该 API——启用/关闭/意图补齐/残留清理一律 `execFile('reg', [...])`，值名钉死 `identity.RUN_VALUE_NAME = APP_ID`（写路径与 `findRunEntry` 判据同源），1.0.54 的幂等重写段删除（职责被残留清理+意图补齐覆盖）；迁移段清理 `electron.app.<productName>` 残留值及其 StartupApproved 条目（指向当前 exe 才删）；菜单点模式项 = 本应用内显式启用，此时清系统层旧禁用是语义正确的，与自动路径「不碰禁用」相区分；③toast 归属注册 `HKCU\Software\Classes\AppUserModelId\<APP_ID>\DisplayName = PRODUCT_NAME`（键在则不写；卸载自动清——electron-builder 卸载器 `UninstAppUserModelId` 清的就是本键）。dev 读写注册表全部 isPackaged 守卫（顺带消掉 dev 菜单写真实 Run 键的旧污染面）。
- **实机终判（2026-10-04 18:1x，用户确认）**：装 1.0.55 覆盖安装后 Run 键并回一条（`com.showcase.app`，残留被迁移清理）、任务管理器禁用后重启**禁用保持**且菜单视同「关闭」、菜单点模式恢复启用、**通知中心归属显示 Showcase**（不再是 Electron）——§75 三症状（两条键/禁用被复活/归属 Electron）全部消除。

### 76. 诊断件自己的几何假设能把正确行为读成 bug：固定窗下「窗口几何中心」不等于桌宠所在，长按光标还会触发让开（1.0.55 假「卡死」，票 11-G）
- **症状**（2026-10-04 隔离实例跑穿透五件套）：`tools/verify-passthrough-desync.js` 打印「③ 卡死 ✗（有 bug）」「④ 移开再移回也救不回来」，而**同批 `verify-passthrough.js` 判据全绿**。据这个矛盾读数写过一条结论：「渲染端走 IPC 写一次 `ignore=true` 就能永久毒化穿透状态」，并进了跨会话技能卡。
- **根因两条，都在诊断件里，被测物没病**：
  1. 件的瞄准点是 `x + w/2, y + h/2 + 20`＝**窗口**几何中心。1.0.52 起窗口恒 600×600、`#pet-root` 钉右下角，视觉矩形＝窗口左/上各内收 `600-300s`（`petVisualRect`）→ scale=1 时窗口中心恰是视觉矩形的**左上角**；而命中判据用渲染端上报盒（实机日志 `373,443 155x157`，外扩 `JITTER_PAD=10` 也够不到窗口内坐标 300,320）。**光标从头到尾不在桌宠身上**，判「穿透」是正确行为，「移回原坐标」当然救不回来。对照件 `verify-passthrough.js` 瞄的是脸中心 → 全绿。**同批一绿一红＝矛盾信号，当时没解释就写了结论。**
  2. 件把光标**长按在同一处**数秒 → 触发 `checkCursorRest` 的「鼠标久留自动让开」（阈值 5s），窗口被挪走（隔离日志 `鼠标停留超过 5s → 向下+左让开 163px（1940,780 → 1778,800）`），此后任何「回到原坐标」的断言必然落空。
- **反证读码**：IPC 处理器 `main.js:2243` 早就写了 `if (win === petWindow) petIgnoreSent = !!ignore;`，注释本身即「否则轮询会因值没变不再下发 → 卡死」；120ms 兜底轮询（`:2031`）判到 `inside` 就下发 `false` 自愈 → **「永久毒化」机制上不成立**。1.0.56 修好瞄准点与让开干扰后独占复跑：② 用 busy-loop 抓到穿透位**真的置上过**（排掉「其实从未穿透」的假绿）、③ **已自愈 ✓**、`PASS 3/3`、exit 0，突变判定式则 exit 1 → 该结论正式关单为**未复现**。
- **解法与防护（1.0.56，票 11-G）**：瞄准点改**渲染端实时上报盒中心且每步重取**；复跑规程另在隔离 `config.json` 关 `cursorFleeEnabled`（现有键，不新增配置项）；该件从「打印式复现器」改成真回归件（③⑤⑥ 计入退出码、前置不满足 exit 3，`--repro` 才保留恒 0 并在首行声明不作判据）；占用自检抽 `tools/lib-occupancy.js` 统一 exit 3（只拦**装机版**映像名——dev 隔离实例是被测对象，不拦）。顺带把 `PET_FALLBACK_BOX` 从 1.0.51 前的旧坐标系改为按 scale 从视觉矩形偏移派生（判据件 `tools/verify-fallback-box.js`，支持 `argv[2]` 传 main.js 路径做突变）。
- **教训**：① **「读数报了个 bug」先怀疑读数装置**——同批另一件全绿就是矛盾，矛盾未解释前不许写成结论，更不许写进跨会话技能卡（这次下一轮才推翻）。② 诊断件的**几何假设必须跟着被测物的几何真源走**：改窗口模型（1.0.52 固定窗）那轮只验了生产链，没验诊断件的瞄准点，于是旧几何在件里潜伏了两版。③ 让开／打瞌睡／缩放这类**由真实光标时长与位置驱动的生产特性**，会被任何「光标长按不动」的测试触发 → 测前要么关特性要么每步重定位，别把它的正常反应读成故障。④ 恒 `exit 0` 的件被计入「五件套全绿」是 §63 同型复发：**退出码语义要长在脚本里**（写死成断言与前置分支），文档只能约束人、约束不了脚本。⑤ 兜底路径的现场证据要从日志取：改前实机有 `区域来源=兜底 40,140 200x155` 两次命中，那个矩形在固定窗里就是空白左上角——「兜底期间判的是空气」是被日志坐实过的真事，不是推演。

### 77. 守卫与打包链的四个"看着对"的陷阱：恒绿的否定式断言、identity 兜底字面量、reg 的编码与字段、`exit 0` 但零产物（1.0.57 加固轮）
- **只写「搜不到 X」的守卫会永远绿**。1.0.57 摘掉渲染端穿透写入口时新增 `tools/verify-single-writer.js`，三条否定式断言（preload 无暴露 / main 无处理器 / renderer 无调用）在**文件被改名、路径写错、编码读坏**的情况下全部"通过"——这正是 §63（5 件套恒绿掩盖穿透退化）与 §72（`^(\S*…)` 正则整条空转）的同型形状。做法：**每条否定式前面加正向对照**（本件第 1、2 条断言 `nativeSetIgnoreMouseEvents` 定义在位、`syncPetPassThrough` 的 petWindow 下发点在位），并且**读不到源码就 exit 1**，不在"读不到"上打绿灯。判别性自证：对 `git show dfe5e7e:` 抽出的改前源码树 → exit 1（两条 ✗ 正好点名被摘的两处）；对当前源码 → exit 0。
- **自证要用显式提交号，不要用 `HEAD`**。同一条突变在 `7905507` 之后 `HEAD` 已指向改后版，写 `git show HEAD:main.js` 的自证会从"能变红"悄悄变成"永远绿"。账里所有突变判据一律钉死提交号。
- **新诊断件里不要抄名字字面量**。第一版探针写了 `LOG_CANDIDATES.find(...) || 'desktop-pet.log'` 兜底，被 `verify-identity` 第③组（扫 tools/ 裸日志名，**注释里的字面量也算**）当场拦下 exit 1。改成"identity 取不到旧名真源就直接 exit 1"——守卫对我自己也生效，才是它值钱的地方。
- **`reg.exe` 三个本机口径**（探针首跑被它们打了回枪，两次都是把"明确不存在"读成"取不到数"）：① 中文 Windows 上它按 **OEM/GBK 码页**输出，`encoding:'utf8'` 读回来是乱码，任何靠错误文案做的分类都会失效 → 用 `TextDecoder('gbk')`；② **「键不存在」也是 exit 1**，与命令真失败在退出码上不分 → 分类不靠文案，靠输出里有没有 ASCII 的 `REG_SZ`/`REG_BINARY` 标记（有=有值），异常分支再兼容 stdout/stderr 两路；③ 别假设卸载键里有 `InstallLocation`——**这台机器就没有**，容器路径要从 `UninstallString`/`DisplayIcon` 反推（`…\<容器>\bin\Uninstall Showcase.exe`）。顺带：行首空白（`^\s*`）那条 §72 老坑在这里仍然成立。
- **`npm run dist` 可以「秒退 exit 0」却什么都没产出**。本轮两次都是：返回码 0、日志 0 字节、`release/` 里没有 1.0.57、`win-unpacked` 的 FileVersion 还是 1.0.56。直到改用 spawnSync 驱动把 stdout/stderr 落到文件才看到真实终态（第三次是**真失败**：`got` 600s 请求超时）。→ 判"构建跑过"永远看**产物 + 版本号**（`Get-Item …\Showcase.exe).VersionInfo.FileVersion`），不看退出码，也不相信"日志没报错就是成功"（§76 同源：脚本没打完日志 ≠ 失败，也不等于成功）。
- **`.npmrc` 的 `electron_mirror` 只管 npm 侧 electron 的 postinstall，不管 electron-builder**（后者走 `@electron/get`，认环境变量 `ELECTRON_MIRROR`）。所以"配了镜像为什么还卡网络"不是矛盾：缓存里 `electron-v44.3.0-win32-x64.zip` 在 `~\AppData\Local\electron\Cache` 里存在，但 builder 仍可能去取别的资源。要绕开就把 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 显式传给构建进程。

- **教训追加（1.0.57 加固轮我又犯了一次同型错，这次是"主动制造副作用"**：给 desync 写新断言 B 时，我的第一版是
  「让渲染端把 `petAPI` 上 36 个函数逐个用 `(true,{forward:true})` 试一遍，断言怎么试都写不动」——听起来覆盖面比单点强，
  实际**这些 API 全都有真实副作用**：`scaleEnd` 改缩放、`dragEnd` 结束拖拽、`openMenuAt` 弹菜单、`pressing`/`clickProbe`/
  `reportClientError` 往日志里写假点击假异常。首跑 exit 1，现场就是桌宠被判穿透（**正确行为**）。
  → **判"某条路径不可达"不能靠"从那条路径发起调用看有没有效"**，因为被调方可能压根不是那条路径；
  终判层要落在结构上（源码守卫 `verify-single-writer.js` + 运行时接口层 A），行为侧只保留**非破坏性不变量**（B）。
- **同轮另一处：脏场地会跨件污染读数**。那次盲调把**菜单窗口开着**留在了同一个隔离实例里，紧接着批跑的
  `verify-passthrough` / `verify-rescue` 就被它压着判定报红（`verify-cursor-sync` 的红则单纯是我少带了 `--face`）。
  杀实例 + 清临时数据目录重起后全部转绿。**批量跑判据前先确认场地干净**，别拿脏场地的红去立新的票。

### 78. 重建后「首报盒」是残缺的：计数 chip 还没渲染 → 命中区少一截 → 解锁后第一次点击丢（1.0.57 实机，用户 ○g 改判 B）
- **症状**（用户实机，装 1.0.57 后复测锁屏解锁）：**「有时第一次有反应，大多数时候第一次没反应、第二次才有」**。
  这条推翻了 11-G 关单时他按 A 判据给的一次性确认——同一条真人判据，样本一多就露相（见末条教训）。
- **根因（日志坐实，不是推演）**：解锁 → `recreatePetWindow` 换新 HWND → 新页面渲染 → 首次 `pet:interactive-box` 上报。
  问题出在最后一步：**首报那一刻计数 chip 还不在 DOM 里**（它的文本要等主进程下一次 `pet:counter` 推送才从占位变成实体），
  于是可交互盒并集只有脸那么大。实机一天 7 次解锁重建，**7 次首报盒全是 `389,448 122x152`**，稳态却是 `320,44x 260x15x`
  ——差的正是左边那截计数。光标停在那截上 → `inside=false` → 穿透 → 那一次点击交给桌面；等元素渲染齐（实测 0.42s~1.32s 后）
  第二次点击才中。**122×152 与 260×157 的 7/7 一一对应**是把"我觉得是渲染时序"变成"证据"的关键。
- **为什么 11-G 的兜底盒改造没覆盖它**：1.0.56 把兜底盒从旧坐标系救回来（`petFallbackBox(s)` 按视觉矩形派生），
  但兜底盒**只在"一次上报都没到"时使用**；真实失效形态是"**上报到了、但报的是残缺盒**"——这条路径当时不在判据面上。
  教训：**改判据链路时，"上游数据已经可信"这个隐含假设要显式列出来**，残缺上报比没有上报更阴险。
- **解法（1.0.58）**：建窗后开「命中区宽限期」，期间命中区 = 上报盒 ∪ 兜底视觉矩形；
  起点放在唯一建窗点 `createPetWindow()`（开机首建 / 解锁唤醒重建 / 托盘隐藏→显示三条路一次覆盖），
  出口是**收到一次面积变大的上报**就立刻收回，`REBUILD_GRACE_MS=2500` 只当冷启动余量上限。
  日志「区域来源」加第三态 `上报∪兜底(重建宽限)`——将来同类问题看一行就能分辨。判据件 `tools/verify-rebuild-grace.js`。
- **三条教训**：① **宽限期不能做成"整窗可点"**——同一条判据里必须同时考"该变宽"和"该退出/该放行"，
  否则修好了第一次点击、把 §52 的穿透语义整体废掉（反向验收那条就是为这个存在的）。
  ② 兜底/宽限这类"时间窗口"机制要留可观测标记（本次是日志第三态），否则线上永远说不清"那次点击当时用的哪套区域"。
  ③ **人工验收的 A 判据需要样本量**：一句"按 A 记录"如果只对应一次操作，等于没验。以后真人层判据要写清
  「重复 N 次（建议 ≥5）仍成立才算 A」，并把 N 次里的实际现象记下来——本轮就是靠用户自己多试了几次才发现。

### 79. 读数装置的两条静默假绿 + 一条"读数只写在提交信息里"（1.0.61 校验轮，2026-10-05）
- **`env -u ELECTRON_RUN_AS_NODE node tools/xxx.js` 在该变量本为空值的 shell 里，会把 node 的 stdout/stderr 全吞掉并恒返回 0**
  （Git Bash 的 coreutils `env.exe` 派生 Windows 侧 node 时不继承标准句柄）。实测：同一件 `verify-box-cadence.js`
  加 `env -u` → 0 字节 + `exit 0`；去掉 `env` → 1061 字节 + `exit 0`；把断言改坏（`BOX_EPSILON` 改 0.0001）后
  去掉 `env` → 2 条 ✗ + `exit 1`，**加 `env` 仍然 0 字节 `exit 0`**。
  这条的危险性在于它伪造的是**退出码**：一轮"CI 十二件全绿"实际是一件都没跑完就返回。
  → 固定动作：**`env -u` 只在起 Electron 时用**（PITFALLS §64 的宿主继承坑，宿主带 `=1` 才需要）；
  纯 node 判定件直接 `node` 跑，并且**批次里每条都要看到字节数**（`wc -c`），零字节 = 没跑，不是通过。
- **同一条坑的第二个症状（校验轮④续补，起隔离实例时撞的）**：在**该变量本为空**的 shell 里，
  `env -u ELECTRON_RUN_AS_NODE …\dist\electron.exe …` 不止吞输出——**Electron 根本没起来**：命令返回 `exit 0`、
  stdout 0 字节、`tasklist` 里零个 `electron.exe`、隔离数据根里**连日志都不生成**。
  我据此差点又写出"本机不能从 %TEMP% 起 Electron"这种二次误判（这句卡里 1.0.5x 已被更正过一次，别再写回去）。
  判据只有一条：**起完立刻数进程**（`tasklist //FI "IMAGENAME eq electron.exe"`）**加**探 CDP 端口（`curl 127.0.0.1:9333/json/list`），
  两样都空就是"没起来"，与它返回 0 无关。本机会真起的写法＝直调 `dist\electron.exe` 全路径 + Bash `run_in_background`（**不加 `env`**）。
- **状态行只在穿透「翻动」那一拍落日志**，于是"上一次翻动时的盒"会被当成"点击那一刻的盒"用**。
  `measure-swallow-clicks.js` 前两轮报的「4 次 / 6 次 盒陈旧型」全属这一类假阳性：气泡出现后主进程盒早更新了，
  但没有翻动就没有新行，指针点在新元素上就被判成"点在盒外"。实机 1.0.61 段 6 条候选里 4 条快照年龄 942~2480ms
  （其中 3 条 target 就是 `bubble`），只有 2 条 ≤500ms 可归因、且都出界 2~3px（设计内的 8px 快速通道余量）。
  → 固定动作：**用日志推"判定当时用的哪套区域"时，必须把快照年龄打出来并设闸门**（本件取 500ms：120ms 轮询 + 一帧上报）；
  过旧的只列不判。跨版本日志还要按装机时刻切段（装机 exe 的 mtime 就是段边界）。
- **★e 的终判读数只写在 `330164d` 的提交信息里，事实册 §十三 仍写着「未执行」**——同一件事在仓库里有两个相反的记录。
  提交信息会随 squash/rebase 消失，数字要复现必须落在**随仓库版本管理的文档**里。→ **落一手读数到事实册，再在票面标状态**；
  校验轮发现"提交说做了、事实册说没做"时，先按 §76/§77 的办法找独立证据（本机是：装机日志里 `区域来源=渲染端上报`
  的逐盒格式 + 86x40 那类气泡盒确实出现在上报集里）。

### 80. 提前触发通道反过来制造「无声丢复查」：11-K 修法自带的残留竞态（票 11-M，1.0.62，2026-10-05）

- **症状**：`display-metrics-changed` 提前跑掉一次延迟复查后，若 1.5s 内又发生第二次重建（解锁与唤醒各来一次、
  或连续两次解锁），第二次重建排下的复查会**既不拉回也不归位、且一行日志都不落**——11-K 任务 C 消掉的「无声」
  形态在另一条路径上复活。位置数据本身不丢（`recreatePetWindow` 开头已写回 config），下一次重建自愈；影响是
  桌宠停在被 Windows 钳过的位置 + 那次决策完全静默。触发窗口只有 1.5s，实机未复现（校验轮读码发现）。
- **根因（三件套凑齐）**：`runDeferredPositionCheck` 第一行只写 `deferredPositionCheckTimer = null` 却漏了
  `clearTimeout`——① 有一条**提前触发**通道（事件入口见 `timer` 非空就调它）；② 句柄是**模块级状态**；
  ③ 句柄是**裸 `setTimeout` 返回值**。于是：提前触发消费掉 saved、把句柄置 null，但原 1.5s 定时器**没被撤销、
  仍会到期**；这 1.5s 内若 `schedule` 见句柄为 null 又排了新复查，旧定时器到期回调会把新句柄置 null（丢句柄）、
  把新 saved 清空（抹状态）→ 新复查空转，全程零日志。**这正是 §10.4 的现行实例：11-K 为消「无声归位」加的
  提前触发通道，反过来制造了一条新的静默路径。**
- **解法**：`runDeferredPositionCheck` 开头补 `if (deferredPositionCheckTimer) clearTimeout(deferredPositionCheckTimer);`
  （风格照 menuWindow closed 处的写法）。超时回调自己走进来时，`clearTimeout` 打在已到期句柄上是 Node 语义的
  无害 no-op，**不要为它加分支或判 `why`**。**严禁把 `clearTimeout` 写进 `scheduleDeferredPositionCheck`**——
  那会把「唯一还没跑的复查」撤销掉，「同一次重建只排一个」变成「只留最后一次排程」，是另一种语义不是修 bug。
- **固定动作（同构场景的自查题）**：**「提前触发 + 模块级状态 + 裸 `setTimeout` 句柄」三件套凑齐时，必须显式
  回答「旧句柄谁来撤销」**——答案是"提前触发的那次执行自己撤"（进处理函数先撤句柄再消费状态），不是"等它自然到期"。
- **判据**：`tools/verify-unlock-position.js` 场景 8（1.0.62）：三处 vm 沙箱补**真语义** `clearTimeout`
  （置 `cancelled` 标记；**空函数会让场景 8 假绿**）+ `fireTimer(id)` 手动到期 helper（已撤销跳过并打
  「已撤销，不执行」；`setTimeout` 桩**恒真值 id** 的契约保留——schedule 的「只排一个」判据靠它）。断言 A＝
  新排的 T2 到期真执行复查，**归因窗口取在 `fire(T1)` 之后**（改前 T1 自己会产生 setPosition/日志，快照取早了
  假绿）；断言 B＝`fire(T1)` 被跳过。判别性：对改前（6bb5361）副本 exit 1（红在 A：T2 执行窗口 setPosition=0、
  日志=0），改后 exit 0、PASS 23。

### 81. 「根因假说获用户确认」≠ 证实；判据件夹具别写「与实机同构」除非实测过（11-K 真因修正，2026-10-05）

- 11-K 的「副屏枚举竞态」假说在问因时被用户确认，机制自洽、修法方向也对症——但**本机根本没有副屏**
  （用户在真人层回话时才说明）。真因是「桌宠拖到贴右屏边停 → 600 宽窗口右缘悬出 8~13px + 零容差判出屏」，
  装机日志四条决策行的就近工作区读数全部完整正确（`0,0 2560x1400`），枚举从未参与；53 次解锁只有 4 条
  决策行，其余 49 次停在屏内全静默——「有时候才发生」其实是「取决于停在哪儿」。假说被确认的那一轮，
  谁都没去数显示器。
- **固定动作两条**：① 交互症状的根因假说，落地前把**每条前提**（几块屏、什么系统、哪个版本）对着实机核一遍；
  「用户确认机制解释」只代表解释听起来合理，不构成证据。② 判据件的夹具注释别写「与装机实况同构」——
  `verify-unlock-position` 曾这么写而实机是单屏 2560×1440，下一轮差点按错误模型继续建模；夹具要么标注
  「合成场景」，要么附实测命令。
- 反向的正面教训：11-K 任务 C（归位/拉回决策强制落日志）是本轮五分钟定案的唯一依据——「无声变有声」的
  投入在下一轮才收回成本，这类日志位值得优先建。

### 82. 阈值常量不能拍脑袋：贴边停靠的真实悬出量由抓握点几何决定（11-K 真因修正续，1.0.63，2026-10-05）

- **症状**：1.0.62 装机后贴右缘停靠仍次次弹回默认角。复查决策行：saved=2094/2085/2059/2062 → 悬出
  **100~134px**，全部 1.5s 超时复查判 out——固定容差 24px 完全罩不住（装机层核实过：sha 与构建产物同值、
  1.0.62、两笔修复都在位，不是没装上）。
- **根因**：拖拽是「光标顶到屏幕边缘就停」，窗口悬出量 = 抓握点到窗口右缘的距离；第一轮日志样本的 8~13px
  只是桌宠恰好停在那，不代表「贴边」手势的量级。容差常量按第一轮样本拍成 24px，被装机实测打回。
- **解法**：阈值改「视觉矩形半幅」（悬出超过可见区一半才算拖出屏自愈，随 scale 自适应）；已装机的 1.0.62
  按同号不叠包纪律递增 1.0.63 重出。
- **固定动作**：凡是「人手动作 × 几何阈值」的参数，第一轮只当占位值，装机实测一轮（取日志里 saved 实数
  的分布）再定稿；装机后第一次真人测试就先把阈值和实测分布对一遍。

### 83. 兜底处理器把功能失效藏成一行日志：运行时件跑完必须 grep `uncaughtException`（票 11-O，1.0.64→1.0.65，2026-10-05）

**症状**：装机 1.0.64 上「鼠标久留自动让开」完全失效——1.0.64（`b3c1489`）把 `fleeFromCursor`
定义端从 `const vis = visualSize(s)` 改成 `const size = contentSize(s)`，末行使用端 `vis.width/vis.height`
漏改 → 每次触发抛 `ReferenceError: vis is not defined`，被 `main.js` 的 `uncaughtException`
兜底吞成一行日志。潜伏期装机日志累计 **13 条异常**、6 条「让开」行后全无「走过去」行；
同期 CI 十二件全绿、verify-unlock-position 45 条断言全绿——**没有任何一件的执行路径经过让开**。

**根因三层**：
1. 改名/换模型时「定义端改了、使用端漏改」——源码字符串断言（场景 14 的接线双向断言）只查
   串在不在，**查不出体内引用了不存在的变量**；vm 里真调一次函数才能抓住（场景 15 的由来）。
2. 兜底 `uncaughtException` 是双刃剑：进程活着 = 表面健康，功能死了只有一行日志。
   「让开」决策行（logLine 在抛点之前）照落——**只断言「决策日志出现」的判据会假绿**，
   决策行与执行行（「走过去:」）必须成对断言。
3. 判据件的执行路径覆盖盲区：让开此前只在 `verify-flee`（真人层手工件）里走，长期不在
   自动判据里 → 坏了没红。

**解法**（1.0.65）：
- 产品码一行：`vis.width/vis.height` → `size.width/size.height`（:1270）。
- `verify-unlock-position` 场景 15：vm 沙箱真调 `fleeFromCursor`（`walkPetTo` 桩成 spy），
  断言不抛 + dip == target + size/2；场景 14 禁串补 `vis.` 形态位（`pet:scale-end` 体内
  合法的 `const vis` 用独立禁串，别误伤）。PASS 45→47。
- `verify-flee` 升级四断言（让开行 / 同秒走过去行 / 终位 ≈ 目标换算 ±40px 且方向分量一致 /
  **期间 `uncaughtException` 增量为 0**），强制 `cursorFleeEnabled=true` 跑。判别双证：
  未修 HEAD 副本 exit 1（异常增量 1、终位偏差 75px、Δ=(0,0)）；修后 exit 0（终位偏差 0px）。

**通则（写进开发协议标准会话流程第 3 步；该协议本机维护、不随公开版发布）**：**跑完任何运行时件（起过实例的
verify/measure/probe）必须 grep 一遍日志 `uncaughtException`，非 0 就是发现**——
不要因为「件 exit 0」就当链路健康，兜底日志是功能失效的唯一痕迹。


### 84. 「改注释也算改打包输入」与「包 sha 不是内容指纹」——发布准备轮两条（2026-10-06）

- **改打包输入文件的注释＝改了包内容，`verify-asar` 必红**。本轮做仓库文本脱敏时，把 `autostart-migration.js` 注释里的本机路径换成
  `<安装目录>`，而这文件**在 `build.files` 的 14 项里**；已装机/已出包的 1.0.65 没有这处改动 ⇒ 仓库 ≠ 包，`verify-asar` exit 1。
  对比：改 `tools/`、`docs/`、README 的文本不会触发它——**只有打包输入会**。
  → 固定动作：**批量替换前先查目标文件是否进包**（看 `package.json` 的 `build.files`）；别以为"只是注释"就没副作用。
  处置纪律：**不许为了消这条红去重出同号包**（同号叠包是本仓禁令，1.0.65 已装机）。它记为"已知有意分歧"，
  下一次合法升版（发布那一次升 `1.1.0`）重出包时自然转绿。
- **安装包 SHA256 不是内容指纹，别拿它自证"装的是哪一次构建"**。票 11-O 记的 1.0.65 包是 `113,577,963 B / A15731E0…`，
  磁盘现物是 `113,578,041 B / 5AF5A37A…`（23:40 又出过一次）——看着像"内容变了"，实际**两侧 `app.asar` 的 sha256 前缀同为
  `31821C7C3C21EEE7`**：NSIS 容器含时间戳等因素，同内容两次构建体积差 78 B、包 sha 全变。
  → 判层次：**内容层用 `app.asar` sha 自证，分发层用包 sha 做"这一个文件没被换过"的校验**；两者混用会得出相反结论。
  而且**记录里的读数一旦重出就必须回填**，否则下一个人拿旧数去核会误判成构建造假。
- **任务管理器「启动应用」页的"发布者"列是进程内缓存，覆盖安装后不自己刷新**（1.1.0 装机当天实测）：exe 元数据换掉之后，
  开着的那个任务管理器窗口仍显示旧厂商名，看着就像"改了没生效"。当场读数：装机 exe 的 `CompanyName` 已是新值、`FileVersion` 已是新版本、
  asar 与构建同指纹、注册表 `DisplayVersion` 也已更新，进程也确实起在新文件上——四项全对，只有那一列是旧的；**关掉任务管理器重开即正常**（用户实测确认）。
  → 判别顺序固定：**先读文件侧、再看列表**——`VersionInfo`／右键属性"公司"不受这个缓存影响；启动项列表只是显示层。
  别拿它当"元数据没生效"的证据，更别为此去重装一遍（重装会改时间戳，反而把 §84 上面那条"包 sha 不是内容指纹"的账搞乱）。
- **公开文档不得引用内部工作记录目录的路径**（该目录与开发协议文件本身都不随公开版发布，见开发协议第 4 步——该文件本机维护、不入库发布）。引用内部记录一律写「票 11-x」或指到
  PITFALLS 锚点。本轮清了 9 个文件的 11 处（含 `main.js`/`identity.js`/`autostart-migration.js` 的注释），改完复扫为 0。
- **「排除私有面」只写在文档里不算落地，要落到能跑的差集判据**。本轮核对 `publish` 树才发现：老的同步口径
  「清空索引 → `git checkout main -- .` → 两侧 `comm` 双向比对为空」**两处失效**——① 一旦有意排除那个私有记录目录，"为空"就不再是期望，
  按旧口径核对会把"漏排除"读成正常；② 那个写法要在同一个目录切分支铺文件，会动到 main 的工作树（私有记录误删风险是真实的）。
  **实况证据**：现存 publish 树（`3b69df4`，81 文件）里就带着一个私有记录文件（私有记录目录下的穿透事实本）——旧口径抓不到，
  新口径（差集必须**恰好等于排除清单**）一条就抓出来了。
  → 改成临时索引 plumbing 生成公开树（命令在开发协议第 4 步），三条判据干跑验过。
  ⚠ **但当时记的判据②是错的，两件事叠在一起**：① 命令写作 `comm -13 公开树 main` 而读数记成「= 0」——**命令与读数不匹配**：
  `-13` 输出的是"第二份文件独有"，即 main 独有＝排除清单本身（实测 3～4 行），永远不可能是 0；能得 0 的只有
  `comm -13 main 公开树`（公开树独有）。也就是说**"公开树混进了 main 里没有的文件"这一整类，按写反的方向从来没被测过**。
  ② 2026-10-06 补排除 `AGENTS.md` 时重跑干验，顺带把它改对并加了**反向自证**：往公开树清单里塞一个 main 不存在的假文件，
  修正版报 1、写反版读数纹丝不动（仍是排除项数 4）。
  修正后的现势读数（1.1.0 发布时复算：公开树 **101** 文件 / main 跟踪 **105**；下列 95/99 是当时那次干跑的数）：公开树 **95** 文件 / main 跟踪 99 / 判据① `grep -cE '^(docs/|AGENTS\.md$)'` = 0 /
  ② `comm -13 main 公开树` = 0 / ③ `comm -23 main 公开树` 恰为 4 项（`AGENTS.md` + findings 3 个）。两份清单都要 `LC_ALL=C sort`。
  **干跑全程未碰工作树**（收尾 `git status` 与开工前一致）。
  通则：**"以后那一步再做排除"的约定，必须在写下的当场就把生成命令和判据跑一遍**，否则到发布当天只会照抄文档里的旧口径；
  而且**判据要连同"它该红的场景"跑一次**——只跑绿法，方向写反也看不出来（与 §77①、本轮 11-N/11-O 那条同源）。
- **同一个工作树可能有并行会话正在写，红可能是"改到一半"的快照**。本轮跑 CI 十二件时两条同时崩在
  `identity.js:30 ReferenceError: path is not defined`，而 `git status` 显示 `identity.js`/`main.js` 未提交且 mtime 就在十几秒前——
  那是另一会话正在执行票 11-Q，它刚落笔时 `require('node:path')` 还没补上；隔十几秒复跑，崩溃消失，只剩一条
  `LEGACY_APP_ID 值=undefined` 的断言不过（该常量正被那一票撤掉，守卫夹具还没同步）。
  → **校验轮出红先查"是不是别人的在制品"**：`git status --short` + 涉事文件 mtime + `git log -1 --format=%h` 对一眼，
  再决定是缺陷还是 mid-edit；报告时把复跑读数一并给出（同一件跑两样，红了/绿了就是不同结论）。
  本仓的并行纪律：主会话只提交自己的文件路径（**绝不 `git add -A`**），别替并行会话回滚或"顺手修好"它在制品。
- 本节自身也是一条纪律的现行案例：**章节归位要检查**——§83 当时被追加到了「十、复盘」之后（脱离"九、诊断工具箱"），
  本轮一并搬回。改文档结构的固定动作：改完 `grep -n '^## \|^### '` 看顺序，别只看内容对不对。

### 85. 参数守卫抢在分支解析之前：文档写的 `--ctrl-triple` 用法永远走不到（票 11-R 任务 4 实测踩出，2026-10-06）

- **症状**：`node tools/inject-click.js --ctrl-triple <x> <y>` 按 README 原文传参，打出来的却是普通点击的用法提示
  （`用法: node tools/inject-click.js <x> <y> [按住毫秒]`）并退出——文档用法自上线起就是**死代码**，没人真跑过这个开关。
- **根因**：普通分支的参数解析与 NaN 守卫（`Number(argv[2])` → `!Number.isFinite(x)` → usage → exit 2）写在 `--ctrl-triple`
  分支判断**之前**：`Number('--ctrl-triple')` = NaN，守卫先行退出，后面的分支永远到不了。「分支存在」≠「分支可达」，
  加第二分支时没人拿文档形态真跑过一遍。
- **解法**：先判 `isCtrlTriple` 再做守卫（普通分支的守卫行为不变）；修后实测 `--ctrl-triple` 可达（打出「已注入 Ctrl+三击」）、
  无参仍 usage 退出。提交 `3a3e4ad`。
- **通则**（与 §77①「判据要连它该红的场景跑一次」同源）：**工具的每个文档化调用形态，写下的当场就要按原文真跑一次**——
  「写了」和「测过」之间隔着一条只有实跑才能暴露的可达性鸿沟。

### 86. 守卫正则命中了实现注释里的字面量——「删掉属性行」的突变实测全绿（票 11-T 任务 3，2026-10-06）

- **症状**：`verify-rebuild-grace` 新加的 show 位守卫（断言 `createPetWindow` 体内含 `show: !petHidden`）在红法 R3
  （把属性行 `show: !petHidden,` 突变成 `show: true,`）下**仍然 rc=0 全绿**——守卫没牙。
- **根因**：我在 main.js 的实现注释里写了「show:!petHidden 从建窗点就保持隐藏…」，守卫正则 `/show:/s*!petHidden/`
  对源码全文扫描时**注释与代码无区别**——属性行被删后，注释里的同形字面量把断言顶绿了。这是 §77①
  「全局 includes 是恒绿守卫」的近亲变体：那次是**别处本来就有**同串，这次是**注释里自己写的**同串，
  共同点是字面量匹配不区分语义层。
- **解法**：字面量断言统一先剥行注释再匹配（`stripLineComments`：按行切掉 `//` 之后的部分）；剥完 R3 立即红。
  附带教训（写 `probe-log-visibility` (c) 段时同轮踩的）：「疑似缓存」启发式把「选 LOG 文件的 statSync」、
  mtime 排序、`koffi.offsetof` 全误报——**先 grep 实况再写启发式**，判据要对准真实形态（size 进 slice 起点 /
  跨调用读位置状态），而不是对准宽泛关键词。
- **通则**（与 verify-identity 抓「注释里的裸日志名」同向）：**断言与守卫只认代码层；注释要么剥掉，要么
  注释里也不写会顶绿断言的字面量**。守卫写完必须跑「它该红的场景」的突变——这次 R3 不跑，假绿就上线了。

### 87. second-instance 会跟着第二实例的锁重试循环反复 emit——「隐藏被顶回来」的真源（票 11-T 回归，2026-10-06）

- **症状**：1.0.68 回归实测：隐藏态双击 exe 后桌宠正常显示（预期），但随后 20 秒里「点托盘隐藏 →
  立刻又被弹出来」反复 8+ 轮，直到「过一会又好了」。装机日志「隐藏桌宠→托盘显示：重建」交替
  17/16 次，间隔 0.3~0.4s。
- **根因**：Electron 的 `requestSingleInstanceLock()` **每调用一次**、只要锁被占，首实例就 emit 一次
  second-instance。而 main.js 的抢锁失败分支有 400ms×50 拍、最长 20s 的 retry 循环——第二实例的
  每一拍重试都是首实例上的一次 second-instance。1.0.67 的无条件 `show()` 同样会把隐藏窗顶出来，
  只是没人双击 exe 后立刻去点隐藏，坑一直没露头；1.0.68 把「隐藏态双击 → 显示」变成预期行为，
  这条语义坑才显性化。
- **解法**：second-instance 处理器加 2500ms **活动窗 debounce**——忽略拍也刷新时间基准，事件间隔
  只要 <2500ms 就持续忽略；安静满 2500ms 的下一拍才当真。**不能用 throttle**（固定 2.5s 窗）：
  400ms 一拍的风暴会每 2.5s 漏过一拍，20s 里照样弹 7 次——红法 D2 实测 showPet=9（正确值 2），
  删去抖 D1 实测 showPet=51。守卫进 `verify-rebuild-grace`（可控时钟沙箱重放风暴）。
- **通则**：给「外部事件触发的行为」加语义时，先问**这个事件会不会被系统批量重复派发**——
  单实例锁重试、通知点击、广播唤醒都可能以机械频率重复到达，真人频率假设全部失效。

### 88. 提权首实例收不到普通第二实例的 second-instance——完整性策略 no-write-up（票 11-T 收尾二，2026-10-06）

- **症状**：1.0.70 复测「以管理员身份重启后双击 exe 不显示」。装机日志实锤：4 次双击
  （07:41:51/53/54/58Z）日志里只有第二实例的「立即退出」行，首实例零 second-instance /
  零去抖 / 零 showPet 行；同期托盘显隐正常（排除首实例卡死）。
- **根因**：Windows 完整性级别（Integrity Level）的 **no-write-up** 策略。提权首实例（High IL）
  持有的单实例锁（Chromium ProcessSingleton 的命名内核对象：互斥体/事件）默认 DACL 带
  Mandatory Label——同用户的 Medium IL 第二实例发通知需要**写**（`SetEvent` 要
  EVENT_MODIFY_STATE）→ 被策略拒绝 → `second-instance` 永不到达。**反向不受限**（High 写
  Medium 的对象是 write-up，允许）——所以「以管理员重启」的交接（提权新实例 retry 抢锁触发
  旧实例让位）一直正常，此缺口从未显性化；它在 1.0.70 前就存在，只是提权态下双击从未被测过。
- **解法（1.0.71）**：文件哨兵兜底——普通第二实例立即退出前在数据目录写带时间戳的显隐请求
  （Medium 写**自己的数据目录**不受 Mandatory Label 限制，跨 IL 必可达）；首实例 `fs.watch`
  到后按三重门槛补走 showPet：①请求 10s 内有效 ②2500ms 内来过 second-instance 让路
  ③仅 petHidden 当真；处理完删文件。写端只挂在「立即退出」分支内，风暴根修不受影响。
- **通则**：跨完整性级别的进程间通知，**不能假设默认 DACL 的内核对象双向可达**——事件、
  互斥体、共享内存、命名管道都有 Mandatory Label 拦截面；用户态文件是少数保证可达的通道。
  涉及提权（runas / ShellExecuteW）的功能，回归必须覆盖「提权实例持锁后，普通实例再来」
  这个方向的每条消息通路。

### 89. agent 会话里跑运行时件的三个环境坑：宿主 ELECTRON_RUN_AS_NODE、数据目录变量只传一半、起实例与跑件不同环境（1.0.72 verify-peek 立件日实测，2026-10-06）

- **症状 1**：`node_modules/electron/dist/electron.exe --remote-debugging-port=9333 .` 报
  `bad option: --remote-debugging-port=9333`，且 `electron.exe --version` 打出的是 **Node 版本号**（v24.20.0）不是 Electron 版本号。
- **根因 1**：部分 agent 宿主（WorkBuddy 会话实测）的 shell 预置 **`ELECTRON_RUN_AS_NODE=1`**，
  electron.exe 被降格成纯 node——所有 Chromium 参数都成了「bad option」。`tools/verify-petcovered-alpha.js`
  早就为此在 spawn 时 `delete childEnv.ELECTRON_RUN_AS_NODE`，但人在 shell 里手起命令时必须
  `env -u ELECTRON_RUN_AS_NODE` 前缀。装机版 exe 同理：从这个 shell 里 `start` 拉起装机版会静默秒退。
- **症状 2**：dev 实例秒退，日志一行「second-instance 抢锁失败且非提权产物实例：立即退出」。
- **根因 2**：**数据目录变量只传了一半**。`SHOWCASE_DATA_DIR` 只重定向 config/数据文件落点；
  单实例锁锚在 **userData**，userData 隔离靠 `PET_USER_DATA_DIR`（main.js 建窗前 `app.setPath`）。
  只传 SHOWCASE_DATA_DIR 时 userData 仍是默认根 → 与在跑的实例抢锁 → 1.0.70 起普通第二实例
  设计为立即退出（表现就是「闪退」）。两个变量必须**同时传**（verify-petcovered-alpha 的 childEnv 双传是标准姿势）。
- **症状 3（连带）**：`verify-flee.js` 报「增量日志无让开行」，实例自己的日志里让开链路却完整
  （让开 → 走过去 → 移动完成）。差一点误判成「checkCursorRest 改坏了」。
- **根因 3**：**起实例与跑判据件用了不同环境**。verify-flee 按**工具进程自己**的
  `process.env.SHOWCASE_DATA_DIR` 解析日志路径，只在起实例的命令上加前缀、跑工具时没带，
  工具就去读仓库 `data/` 的旧日志，增量判定自然落空。起实例与跑 verify 要用**同一个环境前缀**。
- **解法**：一条龙模板——
  `env -u ELECTRON_RUN_AS_NODE SHOWCASE_DATA_DIR=<临时目录> PET_USER_DATA_DIR=<同目录> electron.exe --inspect=9229 --remote-debugging-port=9333 .`
  ；跑 verify-* 时带上同一个 `SHOWCASE_DATA_DIR` 前缀。恢复装机版时同样要剥掉
  `ELECTRON_RUN_AS_NODE`（否则它的启动器也会静默失败）。本次按此跑通 verify-peek（6/6×2 轮）、
  verify-passthrough-desync（4/4）、verify-flee（全过），uncaughtException 计数 0。

### 90. petCovered/置顶重申隐含前提：桌宠必须始终在 TOPMOST band——「临时出 band」类功能都会被 1.5s 拽回（1.0.72 置底方案轮实测后废弃，前提知识保留，2026-10-06）

- **症状**：右键置底穿透首版（SetWindowPos(HWND_BOTTOM) 出 band 压底）的验收设想里，
  peek 的 2 秒窗口会被置顶重申循环吃掉一半：重申 500ms 一拍、连续 3 拍「被盖」就
  `setAlwaysOnTop(false)+(true,'screen-saver')` 拽回 band 顶——置底后 1.5s 必然触发。
- **根因**：`petCovered` 从桌宠 HWND 沿 `GW_HWNDPREV` 往上数「压住它的可见不透明窗」，
  **隐含前提是桌宠自己还在 TOPMOST band**（PREV 链从 band 内向上扫、到 band 顶为止）。
  桌宠一出 band，PREV 链会扫过上方全部普通窗，任何一个与视觉矩形相交的窗都算「遮挡」，
  3 拍凑满 → 重申。
- **处置**：用户实测后裁决取消置底（另一理由：置底把桌宠藏进窗体后面完全看不见），
  改为变暗 + 变透明的视觉让路（桌宠保持置顶，只翻穿透位 + 推视觉类）——冲突从根上消解。
- **通则**：将来任何「临时出 band / 临时降 z 序」的功能（贴底小部件、桌面化动画等），
  都必须同时挂起置顶重申循环，否则 1.5s 内必然被拽回；「没被拽回」本身可以作为该类功能
  的验收断言（busy 监视 TOPMOST 位）。

### 91. 强制层的「强制」是假的：Actions 只在 push 后跑、本仓无 remote ⇒ 全靠会话自觉——而自觉最容易漏的正是改动没碰的那条链（1.0.72 带着一条 CI 红出包并装机，票 11-U，2026-10-06）

- **症状（怎么暴露的）**：校验轮⑨ 抽查发现现行 HEAD `verify-rebuild-grace` rc=1——不是断言不过，
  是**件自己跑不动**（`脚本异常：petPeekActive is not defined`）；而 1.0.71 时代它 rc=0／字节 2483。
  1.0.72 已在当天出包并装机在跑：**一条 CI 红就这样进了用户机器**。
- **根因**：1.0.72 给 main.js 加了顶层 `let petPeekActive`（:2698），resync 体首行（:2219）引用它——
  运行时模块求值先于任何调用所以不炸、`node --check` 只查语法所以不报，**两类廉价检查都抓不到
  「抽函数体进 vm 沙箱」这类判据的 ReferenceError，只有真跑全量强制层才会炸**。而流程侧
  ci.yml 那道的「强制」靠 GitHub Actions、只在 push 后跑，本仓无任何 remote ⇒ **那层从未被机器
  执行过一次**；出包前跑不跑、跑多少，全凭会话自觉。
- **三行证据（为什么自觉必漏）**：①崩的是 `verify-rebuild-grace`（老件），不是 1.0.72 的新件——
  正是改动没碰的那条链；②那两笔功能提交**有**读数记录（verify-peek 6/6、desync 4/4、flee 全过、
  uncaughtException 0），但跑的全是本功能的运行时件、没碰回归网——**覆盖面选错，不是假绿**；
  ③`node --check` 与运行时都不报 ⇒ 没有廉价替身能顶替「真跑全量」。
- **处置（把纪律变成闸门与装置）**：立 `npm run ci`（`tools/run-ci.js`：件清单从 ci.yml **动态解析**
  不手抄、逐件 rc+字节（Buffer.byteLength 口径）、退出码取最坏值）；出包闸门成文进开发协议第 3 步——
  **任何 `npm run dist` 或覆盖安装之前必须先跑且全绿，逐件 rc+字节数写进当次提交信息**；
  同步把 peek×resync 耦合升成行为级断言（删 main.js:2219 必红，此前删了它没有任何件会红）。
- **通则**：审计「强制层」先问一句——**这道闸门最后一次被机器执行是什么时候**。「CI 里有」和
  「CI 跑过」是两回事；无 remote 的仓，push 触发的那道永远不存在，本地装置是唯一会被真实执行的层。
  新功能提交的读数只证明新功能活着，**全量绿才证明回归网活着**；「我测过了」回答不了「别的链还好吗」。

### 92. 发布后新增的两道「显示层与归属层」坑：CI 触发面写错分支＝第二个假闸门；Gitee 不认 GitHub 的 noreply 署名（2026-10-06）

- **坑 A：`ci.yml` 的 `on.push.branches` 写死 `[main]`，而公开仓只有 `publish`。** §91 说"无 remote ⇒ Actions 那道从未被机器执行"，发布之后 remote 有了，但**触发条件仍然不匹配**，所以那道闸门**依旧一次都没跑过**——`gh run list` 回读是**空的**。
  教训形态：修好"没有 CI"之后，要验的是**它到底会不会被触发**，不是"文件在不在"。判据固定成一条：推完立刻 `gh run list -R <owner>/<repo>`，**看不到 run ＝ 那道不存在**，与"CI 红"是两种病（红至少说明它在跑）。
  修法是一行（`branches: [main, publish]`），但它动的是**公开树里的文件** ⇒ 代价要摊清：要么在 `publish` 上补一笔后继提交（release tag 仍钉在发布那一笔，分支往前开），要么重生成快照并 force push（不可逆）。首发当天选前者。
- **坑 B：同一笔提交在 GitHub 关联到账号、在 Gitee 变成一个字母头像。** 一手读数：GitHub `GET /repos/…/contributors` 回 `login=LISAPathfinder`、`commits/<sha>` 的 `author.login` 也在；Gitee 仓库页「贡献者」却是首字母 `A` 的占位头像（作者名是 `APR`）。
  两侧规则不同：GitHub 会把 `用户名@users.noreply.github.com` **反解**成账号；Gitee 的官方口径是**提交邮箱必须出现在「设置 → 多邮箱管理」里**，没有 noreply 反解这回事。
  而这条路走不通：`users.noreply.github.com` **既无 MX 也无 A 记录**（`dns.resolveMx`/`resolve4` 双双 `ENOTFOUND`，对照 `gitee.com`/`qq.com` 都有 MX）⇒ Gitee 的验证邮件根本投不到，绑不上。GitHub 官方邮箱文档也没承诺该地址转发收信，**别按"应该能收到"下结论**。
  **结论（这是取舍不是 bug）**：双平台镜像用 noreply 署名＝只有 GitHub 侧有归属。要 Gitee 也关联只有两条路，都不划算——换成真实邮箱＝那串地址永久进公开提交元数据（**脱敏闸门不扫 commit 元数据，不会拦你**，等于自己拆掉刚做的脱敏）；换成 Gitee 的不公开邮箱＝反过来让 GitHub 脱钩，还要 force push 重建 tag/release。`.mailmap` 顶不了：那是命令行显示层的别名，两家网页的统计都不吃。
- **通则**：**"署名/元数据/触发条件"这类东西，落地后要拿对方系统的读接口回读一次**（`gh api …/contributors`、`gh run list`、注册表 `DisplayVersion`、任务管理器列表），不能只信"我这边写进去了"。同轮还抓到一条同型假象：任务管理器「启动应用」的发布者列是进程内缓存，覆盖安装后不自己刷新（见 §84）——**先读文件/注册表侧，再看列表**。

## 十、复盘：一个「点不动」修了 7 轮 —— 方法上的教训

这是本项目目前代价最大的一次排查（用户第 7 次反馈才彻底解决）。技术坑分别记在 #30/#36/#39/#40/#43/#44/#45，这里只记**为什么会拖这么久**，以及下次怎么避开。

### 10.1 七轮流水（同一句「点不动、动画和计数正常」）

| 轮 | 我认定的原因 | 改了什么 | 结果 |
| --- | --- | --- | --- |
| 1 | mousemove 逐事件改窗口样式把窗口卡死 | 穿透改边沿触发 | 真 bug 真修复，**但引入新失败模式**：状态不再自纠正 |
| 2 | 边沿触发后状态陈旧（指针不动、命中区自己动） | 渲染端 250ms 重算 | 代理指标通过，用户实测仍点不动 |
| 3 | 渲染进程被外部杀掉 → 重载后「指针位置未知」 | 改成向主进程要真实光标；**同轮我自己引入 TDZ 崩页**（被验证抓住） | 仍没解决 |
| 4 | 渲染端定时器被页面节流（锁屏/长时间无操作） | 判定搬进主进程 + 兜底区域 + ping 存活探测 | 仍没解决 |
| 5 | 状态以 2Hz 翻转，把 click 劈成两半（mousedown 可交互 / mouseup 已穿透） | 变回穿透前加 600ms 保持 | 仍没解决 |
| 6 | 解锁后 Chromium 内部「忽略鼠标」标记与窗口样式失步 | 反向设一次「踢开」 | **无效** |
| 7 | 解锁后窗口与会话/输入系统失联 | **重建窗口（全新 HWND）** | 解决 |

### 10.2 根因是四个不同的东西，用户看到的现象一模一样

| 根因 | 现象 | 一条能立刻区分的证据 |
| --- | --- | --- |
| 样式风暴（改样式太频繁） | 窗口僵住，连菜单都点不出 | 计数 IPC 频率（#30 的 measure-ignore-storm） |
| 穿透状态陈旧/翻转 | 点击被转发到桌面 | 日志「穿透状态」+ `probe-window-style` |
| 渲染端僵住（被杀/节流） | 点击到了窗口但无反应 | `pet:ping` 无 pong / 无「桌宠收到点击」 |
| 会话切换后输入失联 | 样式显示可点击，点击仍不进来 | 解锁前后对比「桌宠收到点击」有无 |

**教训一：「同一个症状」绝不等于「同一个 bug 没修好」。** 第 2～7 轮里我一直在"同一条因果链"上找补，正确做法是把上面这张表先做出来——**第一件事是建一个能区分原因的测量，而不是改代码**。

### 10.3 我在方法上犯的四个错

1. **用自己造的代理指标验收，而不是用户的验收标准。** 前几轮我都有"验证通过"（钩住 `setIgnoreMouseEvents` 看状态、模拟点击派发 DOM 事件），但用户的标准是"锁屏解锁后能点能拖"——**代理指标全绿，真实动作全废**。凡是"用户能看见的行为"，验收动作必须就是用户那个动作。
2. **先给解释、再去找证据（假设驱动地连补）。** 每轮我都先构造一个合理解释、改一处、跑一个自测就交付。正确的顺序是：**先测量现场 → 让数据指出原因 → 只改那一处**。日志和探针本该是第一动作：用户第一次说"锁屏解锁也会触发"时，就足以让我把"会话切换"这条线独立出来查。
3. **测量工具没考虑"用户还在用这台电脑"。** 我用 `SetCursorPos` 放光标再读状态，结果每次都被用户的真实鼠标立刻覆盖，测出来的结果时好时坏，我却当成偶发而反复重跑。**应该尽早做 `--watch` 这种"让用户保持故障状态、工具只在变化时打印"的观测方式**——它一跑就出结论，却是第 7 轮才做出来。
4. **用模拟代替机制本身。** 我一直用 `powerMonitor.emit('lock-screen')` 来测锁屏解锁——**这恰好绕过了真正出问题的环节（真实会话切换）**。模拟只能验证"我写的处理器会不会被调用"，永远验证不了"系统行为本身"。凡是怀疑平台/系统行为，必须让用户做真实动作。

### 10.4 还有一层：修复本身在制造新 bug

这块逻辑（穿透状态）几乎每轮都动，于是不断产生"同一处的新失败模式"：边沿触发 → 状态陈旧；加定时器 → 节流；加动态上报 → TDZ 崩页（顶层调用读了后面声明的 `glass`，整页处理器全没注册，打包版还完全静默）。
**教训二：同一处逻辑反复改动，就是高风险区。** 每次改完要专门问一遍"这次改动会引入什么新的失败模式"，并且**新增的顶层调用/定时器/事件顺序都要按"最坏情况（页面刚加载、刚解锁、刚重载）"过一遍**。

### 10.5 下次的固定动作（顺序不要调）

1. **先定义验收动作**（一句话、用户能自己做），写在回复里；后续每轮都以它收尾。
2. **先建判别性测量**：读系统事实（这里是窗口真实 `WS_EX_*`）、读应用现场（日志）、读"事件是否到达"（点击探针）。三者齐全再谈原因。
3. **要现场数据要趁早**：日志与探针是资产，第一次复现就该请用户回传，而不是先改三轮再说。
4. **怀疑平台行为时，让用户做真实动作**；`emit` 之类的模拟只用于验证接线。
5. **同症状复发时，先问"这次和上次有什么不同"**（触发条件、时间点、是否有系统事件），不要默认沿用上次的结论。
6. **改完同一处逻辑，专门列一遍"可能引入的新失败模式"**，并针对它们各留一个可观测点（日志/探针）。
7. **当轮写下的纪律，当轮的验收就要回头套一遍自己。** §62 的「子坑 2」明明写着「CDP 点击不走 Windows hit-test，不能用『点击有反应』验证穿透」，同一节的「验证」段还是拿 CDP 点击到达渲染端当穿透证据——纪律是给别人下一轮用的，不是给自己本轮免检用的。收尾时把本轮新写的每一条否定式约束，拿去对照本轮的验收清单逐条打勾。

### 10.6 这轮沉淀下来、可以立刻复用的工具

- `tools/probe-window-style.js`（静态 / `--watch`）：用系统 API 读窗口真实扩展样式，判断是否真的点击穿透；`--watch` 用于"必须保持鼠标悬停"的场景。
- 应用日志里的**穿透状态逐条记录**（含光标是否在区域内、区域来源是上报还是兜底）：状态机的完整过程可回放。
- **点击到达探针**（`桌宠收到点击: …`）：一次性区分"点击没到窗口"与"到了没处理"。
- **渲染端存活探测**（`pet:ping`/`pet:pong`）：区分"渲染端僵住"与"输入没到"。
- `powerMonitor` 事件写日志：把"锁屏/解锁/唤醒"与后续现象在时间轴上对齐。
