# Showcase 桌宠 🐱

> 曾用名 desktop-pet（2026-10 改名，1.0.49 起；升级链与数据目录不受影响，见 PITFALLS §66 与 CHANGELOG 1.0.49 条目）。

常驻 Windows 桌面的 emoji 桌宠：全局按键/鼠标点击统计（仅本地存储）、摸头拖拽交互、久坐提醒、换皮肤、隐藏到托盘、Ctrl+三击走过去。**不上传任何数据，不记录输入内容与窗口标题。**

> **这个项目是 AI 做的。** 架构、实现、判据脚本、排障与文档都由 AI 会话产出，人负责定产品形态、在真机上验收、以及否决方案。
> 技术栈选 Electron + 纯 JS 是刻意的取舍：为的是"一天能跑起来、每台 Windows 都能复现"，不是性能最优——安装包约 108 MiB，
> 其中绝大部分是 Chromium 本体。**如果你要更轻的实现，这个项目适合用原生框架重写**：真正与平台绑定的只有三类调用——
> 低级键盘/鼠标钩子（计数）、`WS_EX_LAYERED | WS_EX_TRANSPARENT` 的鼠标穿透与置顶带管理、注册表（自启 Run 键、
> `StartupApproved`、AUMID 通知归属）；其余（命中区几何、动画层、皮肤导入、状态记账、托盘与提醒调度）都是纯逻辑，可直接照搬。
> 需要留意的地方都写在 [PITFALLS.md](PITFALLS.md) 里——穿透状态失步、任务栏归组、隐藏后再显示点不动这类问题，
> 换成原生实现多半只会换一种形态重现，动手前值得先读。

- 规划见 [PLAN.md](PLAN.md)
- **踩坑与排查经验见 [PITFALLS.md](PITFALLS.md)**（含各类疑难问题、诊断工具用法，以及一次「同一症状修了 7 轮」的方法复盘）
- 许可：MIT，见 [LICENSE](LICENSE)
- 版本变化见 [CHANGELOG.md](CHANGELOG.md)

## 启动

```bash
npm install
npm start
```

- 要求 Node.js 18+（开发机为 v24）。首次 `npm install` 后若 Electron 二进制缺失，执行 `npx electron --version` 会自动补下（已配置国内镜像 [.npmrc](.npmrc)）。
- `uiohook-napi` 的安装脚本需在 npm 询问时批准（npm 11 的 install-scripts 机制），或手动：
  ```bash
  npm install-scripts approve uiohook-napi && npm rebuild uiohook-napi
  ```

## 功能

| 功能 | 说明 |
|---|---|
| 桌宠窗口 | **固定 600×600 透明无边框窗**（1.0.52 起；桌宠视觉区 300×300 ×缩放，钉在窗口右下角），`screen-saver` 级置顶（压过任务栏与其他置顶窗口），且**不抢焦点**——全屏游戏/视频里照常可见、可点击拖动，不会把游戏切到后台；透明区域鼠标穿透不挡操作。**可见内容**（脸 + 底部计数栏，约 300×160）才参与贴边与出屏判定，头顶 ~154px 是气泡/💤 的渲染预留，1.0.64 起不算桌宠本体 ⇒ **脸能贴到屏幕上缘**（旧口径隔着一截空白） |
| 进程分组 | 任务管理器里 4 个进程（主/GPU/网络/渲染）+ 1 个不可见锚点窗口收成**一条可展开条目** `Showcase (5)`，一次「结束任务」即可整只关掉 |
| 稳定性 | 穿透状态由主进程按真实光标判定（页面被系统节流也不会卡住）；渲染进程崩溃/僵住自动重载；**锁屏解锁后自动重建窗口**，避免「回来点不动」；退出前全量收尾并有 3 秒兜底强杀 |
| 动画 | 帧序列抽象（v1 emoji 帧），状态机：idle / blink / happy / sleep / wow / remind / drag（拖动桌宠时展示）/ move（走过去时展示） |
| 交互 | 点击摸头（爱心粒子）、10 秒内连点 5 次「别戳啦！」、按住拖动（≥5px 判拖拽）、双击打开统计面板（**默认关**，菜单「双击桌宠打开统计面板」勾选开启） |
| 缩放 | **按住 Ctrl** → 桌宠左上方出现**发光三角手柄**（正方形对角线斜切上半，统计面板蓝色系，大小为底部计数栏高度的 0.65 倍）→ **拖手柄缩放**（向下拖缩小、向上拖放大）等比缩放，0.5x~2.0x；**右下角锚定原地伸缩**——桌宠朝手柄方向生长/收缩、右下角不动，手柄拖动全程贴着桌宠不脱离；缩放全程**零窗口操作**（固定 600×600 透明窗 + 纯 CSS transform），无闪烁抽搐；拖到 0.5x/2.0x 顶格再继续拖，手柄**变红保持发光**提示到限；松手持久化，比例保持、重启保持（1.0.39 起手势从「Ctrl+按脸拖动」移交手柄，Ctrl+拖脸现在就是普通移动） |
| 紧急恢复 | 连续按 **Ctrl → Alt → P**（顺序不限、中间不插别的键）：强制恢复可交互并弹出菜单（万一出现点不动时不用去任务管理器） |
| 让路穿透 | **右键桌宠** → 2 秒「让一让」：桌宠**保持置顶不动**，整体**变暗并变透明**（brightness 0.35 + opacity 0.4），同时整窗点击穿透——点在它身上就是点在下层的文件/按钮，到点自动复原（亮度、透明度、常态穿透判定）。参考 Bongo Cat 的同名交互（1.0.72 内曾按「压到桌面层」实现，按用户实测裁决改为视觉让路、不动 z 序）；拖拽/缩放/拖文件悬停期间右键不触发；期间 Ctrl+Alt+P 救援照常可用（会提前收场） |
| 走过去 | **按住 Ctrl + 在任意位置快速连点左键三下** → 桌宠**走过去**（约 230px/秒，逐帧推进窗口位置、帧间隔 8ms≈60Hz，近距离最短 0.5 秒、最远 6 秒），途中显示 `move` 状态、向左走时朝向翻转，到达后回 idle 并记住位置。带修饰键是为了和系统「三击选段」区分开；菜单里可关 |
| 移动状态 | 状态机新增 `move`（走路），与拖拽一样可被图片皮肤覆盖：`assets/skins/<皮肤名>/move.gif` 或「挑选表情映射…」里给「移动」挑图；emoji 皮肤默认 🐈 + 走路颠簸动画 |
| 移动与位置 | 拖动全程被**钳进显示器工作区**（1.0.63 起，桌宠拖不出屏幕）；解锁/唤醒后位置**不弹回主屏右下角**（1.0.60 起：先按原位建窗再延迟复查，贴边悬出走最小位移回挪，只有真出屏——拔屏、分辨率收缩——才归位默认角，且每次决策都落日志）；锁屏/唤醒会重建窗口，表现为**闪一下**（正常） |
| 自动让开 | 鼠标**停在桌宠身上超过 5 秒**不动 → 它自己走开：**向下与左右同时生效**（向下优先、能往下就挪到工作区极限，还离不开光标的部分由左右补上 —— 常见形态是「斜着往下-侧挪」，左右取挪得少的一侧）；左右都放不下且向下也补不齐就原地不动。**点它/按住它/拖它都算互动：点击会把 5 秒计时清零，按住期间根本不触发**（松开后重新计时）。正在走路或睡觉时不触发；菜单可关 |
| 隐藏与托盘 | ⚙ 菜单 →「隐藏桌宠」：桌宠、计数、齿轮一起消失，**计数照常后台运行**；托盘图标（左键切换显隐／右键菜单：显示桌宠、打开统计面板、退出）是唯一入口。Windows 11 默认把新图标收进 `^` 折叠区，需要时把它拖到任务栏上固定 |
| 打瞌睡 | 10 分钟无键鼠/手柄活动打瞌睡（😴💤），**键鼠或手柄**任意活动立刻唤醒 |
| 说话气泡 | 每 5~15 分钟随机台词，显示 4.5 秒 |
| 手速检测 | 3 秒内 ≥24 键 → 😮「手速好快！」 |
| 久坐提醒 | 默认每 45 分钟 💧 提醒（可关、可调 30/45/60/90 分钟），键鼠活动不重置；**同时弹 Windows 系统通知**（桌宠隐藏/被遮挡时也触达，点通知显示桌宠；菜单「提醒同时发 Windows 通知」可关，默认开） |
| 按键统计 | 全局键盘每键计数 + 鼠标左/右/中键计数 + **手柄按键计数**（XInput 轮询，无需窗口焦点），悬浮计数「⌨ N · 🖱 M · 🎮 G」，按天写入 `data/keys-*.json`；计数栏最左侧有**管理员指示灯**（普通权限熄灭、管理员运行亮绿灯，当前能否在提权游戏里计数一眼可辨） |
| 统计面板 | 今日 / 最近 7 天 / 累计、鼠标点击、手柄按键（空态区分未连接/已连接/组件失败）、今日 Top10 按键条形图（三源混合）、最近 14 天平滑趋势曲线（**逐日刻度** + 错排日期标签，**悬浮预览**：定位虚线 + 高亮点 + 当日总数）；全页统一蓝色系 |
| 换皮肤 | ⚙ 菜单 →「皮肤」：内置 emoji 皮肤（随包，纯字符渲染）+ **贴纸皮肤靠导入**（素材不入公开仓、不进公开安装包，见「开源与素材说明」）；皮肤目录放约定命名图片（png/jpg/gif/webp，idle 必选）；**导入 .eif 表情包**、**拖压缩包**（zip/7z/rar/tar 系）或**直接把图片拖到桌宠身上**（单图即生效，其余开挑选窗）；菜单也可导入（eif/图片/压缩包多选 + 皮肤文件夹）；「挑选表情映射…」给状态分配图片；「打开皮肤目录」直达皮肤根目录 |
| 菜单 | 桌宠下方 ⚙ 齿轮按钮打开（自绘 HTML 菜单），**再点齿轮即关闭**；弹出位置**优先贴桌宠左右侧翼**展开、不遮挡桌宠、始终完整落在屏幕工作区内（窄屏降级：锚点侧展开 → 上/下避让）；**字号 12~20px 可调**（菜单底部 A−/A＋，窗口宽高都随内容自适应、大字号不裁字），勾选/单选/子菜单两级导航；含「开机自启」（**点它只展开子菜单，父项不再是开关**：子菜单 **关闭 / 普通模式 / 管理员模式** ✓ 三项互斥；**勾选态以配置为准——覆盖安装保持不变、全新安装默认「关闭」**；管理员模式=开机弹一次 UAC 请求提权，取消则降级普通权限继续跑；点某个模式即以该模式开启自启，点「关闭」关 Run 键）、「恢复默认大小」（Ctrl 手柄缩放后一键原地回 1.0，右下角不动）与「以管理员身份重启」 |

## 换皮肤（表情包替换 emoji）

⚙ 菜单 →「皮肤」：

- **Emoji 默认**：内置猫 emoji；「挑选表情映射…」可从**完整 Windows emoji 目录（1500+）**里给
  八个状态（含拖拽、移动）挑选任意 emoji，映射持久化。
- **贴纸皮肤（素材不随公开发布分发）**：开发机上现有 6 套（`ac_color`、`ac_dog`、`acmusume`、`acmusume_new`、
  `ac_anonym`、`ac_ow`）**是网络素材、授权未确认**，所以不上传仓库、不作为 Release 附件、也不打进公开发布的安装包
  （理由与做法见「开源与素材说明」）。本机与自建版照旧可用：素材留在 `assets/skins/` 就行。
  - **皮肤放在哪里**：安装版在 **NSIS 装出来的那个目录**（下文统一记作 `<安装目录>`）的 `<安装目录>\skin\<皮肤名>\`；
    开发版是项目内 `assets/skins/<皮肤名>\`。目录里放帧图，可用 `skin.json` 显式映射八态，也可用文件名约定
    （如 `move.gif`）；还能**直接把 `.eif` 或压缩包（zip/7z/rar/tar 系）拖到桌宠身上**导入。
  - **没有贴纸皮肤也不影响功能**：内置 `emoji` 皮肤不需要任何素材文件（从完整 Windows emoji 目录 1500+ 里给
    八个状态各挑一个字符即可）。要贴纸皮肤，请自行准备**你有权再分发**的素材放进上面的皮肤目录。
  - **素材契约**：八态 `idle / blink / happy / sleep / wow / remind / drag / move`；格式 `.gif .png .jpg .jpeg .webp .avif`
    （avif 静图/动图均可，Chromium 原生解码；**jxl/heic 内核不支持，放进来只会显示破图，别用**）；
    只要能确定 `idle` 就是有效皮肤，缺某状态的图回落到 `idle` 不会空白；皮肤名可含中文，但不能带路径分隔符。
    **每个素材目录请附 `SOURCE.txt`（来源 URL + 抓取日期 + 授权条款名）与 `LICENSE.md`**——别把授权线索留给记忆。
  - **要新增一批内置皮肤**：除了把目录放进 `assets/skins/`，还要把 `main.js` 的 `BUILTIN_SKINS_VERSION` 递增（当前 `1`）。
    否则已装过老批次的机器拿不到新增的——释放逻辑先比 `config.builtinSkinsVersion`，同批次直接跳过（`main.js:1446` 起）。
- **自定义皮肤**：在皮肤目录下建 `<皮肤名>/` 放图片——开发版是项目内 `assets/skins/`，
  安装版是数据目录的 `skin/`（`<安装目录>\skin\`，或旧结构的 `<安装目录名>-data\skin\`）。
  菜单「**打开皮肤目录**」一键直达该目录（目录不存在会先建）；新建子目录放图即成新皮肤。
  按状态约定文件名（任选格式）：
  `idle`（必须，默认形象）、`blink`、`happy`、`sleep`、`wow`、`remind`、`drag`（拖动桌宠时展示）、
  `move`（走过去时展示），支持 `.gif / .png / .jpg / .webp / .avif`。
  GIF 直接作为该状态的动画播放；未提供的状态自动回退 idle 图。建议透明背景、200~400px。
- **菜单导入**（⚙ 皮肤 → 两个入口，与拖拽共用同一条导入管线）：
  - **「导入表情包（eif/图片/压缩包）…」**：文件选择器，**可多选**。eif 自动解包内嵌图片（签名提取，
    对 OLE2/zip 容器变体有效）；压缩包同拖拽语义（见下）；单张图片直接建皮肤生效，多张建皮肤开挑选窗。
  - **「导入皮肤文件夹…」**：选一个目录，**递归收集**里面的全部图片建皮肤（Windows 的对话框
    不能同时选文件和文件夹，所以拆成两项）。
  - 导入后弹出「挑选表情」窗口：先点状态标签再点图片完成分配（idle 必选，其余可留空）→「保存并使用」即时生效。
- **导入压缩包（zip/7z/rar/tar 系）**：把压缩包**拖到桌宠身上**（或从上面菜单入口选）——自动解出包里全部图片
  （png/gif/jpg/webp/avif，**按内容魔数识别**，包内文件名是 GBK 乱码也不影响；子目录会平铺、非图片自动跳过；
  mp4/heic 等同为容器类文件按品牌排除，不会收进解码不了的文件）
  建成一个新皮肤并弹出「挑选表情」窗口分配状态。支持 `.zip .7z .rar .cbz .cbr .tar .tgz .tar.gz .tar.bz2 .tar.xz`
  （tar.gz 这类复合流自动二段解包；rar 仅解包）。纯本地解压，不依赖本机是否装了压缩软件：
  zip 走 adm-zip，其余走 7z-wasm（7-Zip 编译成 WASM）；单条目超过 64MB 跳过（防误拖大文件/zip 炸弹）。
- **眨眼**：emoji 皮肤 3~6 秒一次；**导入的图片皮肤只要提供了 `blink` 帧也会眨眼**（间隔 4~9 秒，
  且停留约 1.6 秒让 GIF 播完，不会播一半被切走）。
- **GIF 播放完整性**：临时状态（happy/wow）停留时长加倍、同一张图不重复重设背景
  （重设会让 GIF 从头播），动图可以完整播完再切换。
- **拖文件悬停玻璃特效**：拖着图片/表情包悬停在桌宠上方时，脸部附近一小圈出现毛玻璃高亮
  （只罩住形象，不糊整个窗口），指针离脸心越近越明显；松手即按普通拖拽导入处理。

## 配置 `data/config.json`

首次运行自动生成，菜单改动即时写回；可手动编辑（缺省项自动补全）。**新增配置项必须先在
`config.js` 的 `DEFAULTS` 里登记**，否则会被静默丢弃（见 PITFALLS #26）。

```json
{
  "skinName": "emoji",           // 当前皮肤（emoji 或 skins 下的目录名）
  "menuFontSize": 14,            // 菜单字号 12~20
  "theme": "system",             // 主题：system / light / dark
  "reminderEnabled": true,       // 久坐提醒开关
  "reminderNotifyWindows": true, // 久坐提醒同时弹 Windows 系统通知
  "reminderIntervalMin": 45,     // 提醒间隔（分钟）
  "sleepAfterMin": 10,           // 打瞌睡阈值（分钟）
  "petPosition": { "x": null, "y": null },  // 桌宠位置（拖动自动保存；1.0.63 起拖拽被钳进显示器工作区，出屏只剩拓扑变化，重建时按内容矩形判据回挪或归位）
  "autoStart": false,            // 开机自启（Run 键镜像，与任务管理器「启动应用」同源）
  "autoStartAdmin": false,       // 开机自启模式：false=普通模式（默认）、true=管理员模式（Run 键 + 开机请求提权，每次开机弹一次 UAC；自启关着时仅作模式偏好保留）
  "petScale": 1,                 // 桌宠缩放 0.5~2（拖 Ctrl 手柄调节，松手持久化）
  "dblclickStats": false,        // 双击桌宠打开统计面板
  "walkByTripleClick": true,     // Ctrl+连点三下任意位置 → 桌宠走过去（菜单可关）
  "cursorFleeEnabled": true,     // 鼠标在桌宠身上停留超 5 秒 → 自动让开（菜单可关）
}
```

## 打包（NSIS 安装版）

```bash
npm run dist        # 产物 ../showcase-build/release/showcase-setup-<版本>.exe
```

- **首次构建要从国内镜像拉 Electron**：`.npmrc` 里的 `electron_mirror` **对 electron-builder 无效**（它走 `@electron/get`），
  要显式传环境变量，否则常见症状是卡 600 秒网络超时后失败：
  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
  ```
- **构建后、安装前必跑 `node tools/verify-asar.js`**（校验包内容与源码一致；见「排查与诊断」表）。

- 安装版数据目录：程序装在 `<安装目录>\bin\` 下时，数据就在**容器根**（`<安装目录>\data\` 与 `<安装目录>\skin\`）；程序直接装在安装目录下时退回同级的 `<安装目录名>-data\`（见「数据与隐私」）。
- **改 `appId` 必须同时钉住 `build.nsis.guid`**：NSIS 的卸载注册键是由 `appId` 生成的 UUID v5，只改 `appId` 会让新版本
  认不出旧安装 → 装成并存的两份、默认目录另起、而数据根按容器根策略跟着走，用户侧表现为「升级后统计清零」
  （数据其实在旧目录里，没丢）。本项目的 `guid` 已固定，勿随意改动（PITFALLS §66）。
- 打包后冒烟（先跑一次再用）：`./win-unpacked/Showcase.exe`。**先测 `ELECTRON_RUN_AS_NODE` 到底有没有值再决定要不要剥**：
  它在位（宿主注入 `=1`）时不清掉，Electron 二进制会变成纯 node REPL（只有 1 个进程、没有窗口和数据目录，很像"打包坏了"，见 PITFALLS 4.6）；
  但**剥它要用 shell 内建 `unset`，别用 `env -u` 当默认前缀**——该变量为空时 `env.exe` 会让进程**根本没起来**却返回 `exit 0`、零输出（PITFALLS §79）。
- 开发模式（`npm start`）使用项目内 `data/` 与 `assets/skins/`；可用 `SHOWCASE_DATA_DIR`/
  `PET_USER_DATA_DIR` 环境变量指向别处做并行测试。
- 安装包未签名：首次运行会有 SmartScreen 提示（「更多信息 → 仍要运行」）。
- 安装包体积约 **108.3 MiB（113,578,041 B，1.0.65 实测）**，**不含任何贴纸皮肤素材**（Electron 运行时 + asar + NSIS 是大头；
  原视频翻译功能已移除，不再携带 OCR sidecar 与双 ASR 模型）。**这个体积超过 Gitee 社区版 Release 单附件 100MB 上限**，
  所以发布形态是 GitHub 放安装包、Gitee 只放源码。

## 数据与隐私

- **数据与程序分离**：用户数据永远不放在安装目录（NSIS 的 `$INSTDIR`）里——覆盖安装会把 `$INSTDIR` 整个清空重建。
  1.0.6 起推荐的安装结构是**程序装进 `<安装目录>\bin\` 子目录**，数据与皮肤放容器根：

  ```
  <安装目录>\              ← NSIS 装出来的容器根
  ├── bin\                 ← 程序本体（= $INSTDIR，覆盖安装只清这里）
  ├── data\                ← 计数记录 + config.json + showcase.log
  └── skin\                ← 皮肤
  ```

  1.0.10 起**安装器会自动处理**：安装界面里选**容器目录**（例如 `<安装目录>`）即可——
  目录页显示的就是容器目录本身（不会出现 `…\bin`）；程序会被放进它的 `bin\` 子目录，并自动建好 `data\`、`skin\`。
  （1.0.7~1.0.9 的目录页会显示带 `bin` 的完整安装路径，装出来的结构一样，只是显示不直观。）
  程序直接装在安装目录下时（1.0.5 及以前的结构），数据仍在同级的 `<安装目录名>-data\`（`data\` 与 `skin\`）。
  数据根同级不可写（如装进盘根）时回退 `%APPDATA%\showcase`（1.0.48 及以前为 `%APPDATA%\desktop-pet`，改名后旧目录里的数据由启动迁移 missing-only 补回）。
- **覆盖安装 / 卸载重装都不丢数据**：数据在 `$INSTDIR` 之外（父目录或兄弟目录），NSIS 只清安装目录本身，结构上就不会被碰
  （1.0.3 及以前靠「安装目录内主数据 + 同级镜像」双份互保，1.0.4 起简化为单份外置，镜像机制已删除）。
- **覆盖安装自动关闭运行中的桌宠**（1.0.42）：安装器启动时先 taskkill 结束普通权限实例；探测到杀不掉的**管理员权限实例**时，
  通过 runas 请求提权再杀（弹一次 UAC，同意即清场继续安装）；拒绝 UAC 则回落到安装器自带的「应用无法关闭」重试提示。
  卸载器尚未接入此逻辑——卸载前请先手动退出管理员运行的桌宠。
- **旧版升级自动迁移**（一次性，missing-only 不覆盖已有）：1.0.3 及以前的数据在安装目录内 `data\`/`skins\` 与同级镜像里，
  1.0.4~1.0.5 在同级 `<安装目录名>-data\`——新版启动时把上述旧位置补进当前新结构（旧子目录名 `skins\` 并入新的 `skin\`）；
  源目录保留不删（可手动清理，装在同一路径时下次覆盖安装会自然清掉旧的安装目录内副本）。
- **内置皮肤的释放机制**（公开发布版**没有**内置贴纸素材，本节只对你自建版有意义）：若 `assets/skins/` 里有素材，
  首次运行会把缺的批次释放到 `<数据根>\skin\`（缺什么补什么、不覆盖同名目录），用 `config.json` 的 `builtinSkinsVersion`
  记录已释放批次——**你删掉的皮肤不会复活**，只有递增 `main.js` 的 `BUILTIN_SKINS_VERSION` 才会再补一轮。
  公开版开箱可用的是内置 `emoji` 皮肤（纯字符渲染，不需要任何素材文件）+ 自行导入。
- 计数按天存 `data/keys-YYYY-MM-DD.json`：`{"v":1,"date":"…","total":N,"keys":{…},"mouse":{…},"gamepad":{…}}`；
  同目录还有 `config.json`、当天文件的 `.bak`（会话启动快照）与 `showcase.log`（诊断日志）。
- **注意**：数据只有这一份（无镜像冗余），手动删除数据目录（`<安装目录>\data\`+`<安装目录>\skin\`，或 `<安装目录名>-data\`）即彻底重置；
  换盘/换目录重装时想保留数据，请先备份该目录。

## 已知限制

- **真·独占全屏**模式下任何窗口都无法覆盖游戏画面（Windows DWM 机制），桌宠也压不上去；
  请在游戏显示设置里选「无边框窗口/窗口化全屏」（现代游戏默认的「全屏优化」也属于可覆盖类）。
- **管理员权限运行的程序**中按键/点击捕获不到（Windows UIPI 机制，系统限制）。
  管理员权限的游戏里计数会失效——用菜单「**以管理员身份重启**」让整个桌宠以管理员运行即可恢复（见下条）。
- FPS 等锁定鼠标的游戏里指针到不了桌宠，无法拖动（真·独占全屏下任何覆盖层都不可见，包括 BongoCat 类工具）。
- 安装版默认**以普通权限运行**（资源管理器拖放等集成正常）。要在**以管理员运行的游戏**里计数，就用菜单「**以管理员身份重启**」整体提权运行（ShellExecute('runas')）；**代价是提权后收不到资源管理器拖放**（UIPI 限制），按需开关即可。（1.0.4 及以前的「游戏模式」提权辅助进程方案已于 1.0.5 移除，统一走整体提权，少一个后台进程。）当前权限看**计数栏最左侧的指示灯**：亮绿灯 = 管理员运行中。
- 部分杀软可能对全局键盘钩子误报，请放行本应用；**不要**安装 `node-global-key-listener` 做备选方案
  （它的 `WinKeyServer.exe` 会被 Defender 按键盘记录器隔离，见 PITFALLS #4.5）。
- 解锁后桌宠会**闪一下**：这是自动重建窗口（修复「解锁后点不动」）的正常现象。
- **explorer 重启（或 shell 崩溃自动重启）后，任务栏可能低频回流一条纯透明的条目**：那是不可见的锚点窗口——1.0.30 起锚点不再挂 `WS_EX_TOOLWINDOW`（该位会打掉任务管理器的进程分组，见 PITFALLS §67），不进任务栏改靠 shell 登记而登记会被 shell 重建冲掉。右键那条透明条目关闭即可（或无视它）；显示桌宠的那条仍被 TOOLWINDOW 压住不会回流。
- **走过去（Ctrl+三击）的两个边界**：① 在编辑器里 **Ctrl+三击选段**同样会触发走过去 —— 系统层和应用层是同一个动作，无法区分（不想用就在菜单里关掉）；② 提权窗口里的点击受 UIPI 限制收不到，那些位置不会触发。
- 空闲资源占用：任务管理器里 `Showcase (5)` 一组约 100MB 工作集（含锚点窗口的渲染进程），CPU ≈0%。
- **不内置可分发的贴纸皮肤**：`assets/skins/*/` 不入库（`.gitignore` 排除，仓库内只留 `.gitkeep`），公开发布的
  安装包也不带皮肤；开箱可用的是内置 `emoji` 皮肤与「自行导入」两条路。原因见「开源与素材说明」。
- **贴到屏幕上缘说话时，气泡会被屏幕边缘裁掉一块**：1.0.64 起摆放判据按「可见内容矩形」算（脸能贴上缘），
  头顶 ~154px 的气泡/💤 预留位不再算作本体 ⇒ 换来的是贴顶时气泡显示不全；💤 贴顶也会溢出约 14px。默认摆位不受影响。

## 排查与诊断

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

### 开发辅助工具（dev-only，非诊断件）

上表是排查诊断工具箱，按开发协议铁律 5（该协议本机维护、不随公开版发布）保持纯 node、零 Electron 依赖。以下件**不是诊断件**、不进上表，属开发辅助，边界在此登记（2026-10-02 票 9 顺带 f 处置；每条的取舍理由随条目）：

- `electron tools/preview-stats.js <输出.png> [--dark]`（配套 `tools/mock-preload.js`）：统计面板视觉预览——用**真 Electron 渲染管线**加载 stats.html、注入 mock 数据并截图（轻量替代浏览器截图）。必须跑在 Electron 里（contextBridge/preload/capturePage 都是 Electron API），改造成纯 node 会砍掉它唯一的价值，故登记为 dev-only 例外；注意用法是 `electron …` 而非 `node …`。
- `node tools/gen-emoji-catalog.js`：换皮肤的 emoji 目录**生成器**——联网（jsdelivr 的 unicode-emoji-json）重新生成 `renderer/emoji-catalog.js`，仅在目录结构变更时手动跑。运行期红线（零网络请求）约束的是产品运行期，不含本件。
- ~~`tools/fake-main-server.js`~~：已删除——它模拟的 helperServer 属 2026-09-23 整体移除的游戏模式提权 helper（PITFALLS §4.7 注记），再无可连的消费方，死件；当时删配套工具漏掉了它。

## 开源与素材说明

- 本项目**源码**采用 MIT（见 [LICENSE](LICENSE)）。
- **注意：源码许可证不代表仓库或安装包里的所有素材都可以自由使用。** 皮肤图片、角色形象等资源可能归原作者或
  权利方所有。请在上传、分发或商用前确认对应素材的授权。
- **本仓库默认不上传 `assets/skins/` 下的皮肤素材内容**，只保留空目录占位（`.gitkeep`），避免把未确认授权的素材
  一起发布。当前开发机上那 6 套贴纸的来历与判定如下（记在这里，免得下次靠记忆）：
  - 来源：AcFun 表情页 `https://www.acfun.cn/emot/`（本机于 2026-10-02 核对），内容为 **「Ac 娘」——AcFun 官方
    吉祥物形象**，属站方 IP，非免费可商用素材库。
  - 站方对用途的唯一说明原文：**「供腾讯 QQ 使用的 eif 格式 Ac 娘表情包，下载后双击即可使用。」** 页面未提供
    任何版权归属、商用或嵌入第三方应用再分发的授权条款。也就是说：站方给的是「个人下载使用」，不含「打包给别人」。
  - 判定：**本机自用没问题**（这正是站方描述的用法）；**打进公开发布的安装包、或作为附件供公众下载，属于对
    第三方 IP 形象的再分发，未获授权，因此本项目的公开发布版不含这些素材。** 网上存在他人托管的同类 AC 娘表情
    仓库，但别人的做法不构成对你的授权。
  - 想要「开箱即有贴纸皮肤」的公开版本：只能用**自产**或**明确允许嵌入分发并按规定署名**的素材，或走 AcFun 的
    IP 授权渠道。
- **本项目特有的一条坑：`.gitignore` 只挡 git，不挡打包。** electron-builder 按 `build.files` 从**磁盘**收集文件，
  只要打包机的 `assets/skins/` 里还留着素材，打出来的 `app.asar` 就会带上它们。所以要出「公开发布版」安装包，
  必须在没有素材的工作树里打（新 clone 的仓库天然满足；自己的开发机要发版，先把 `assets/skins/` 临时移走再
  `npm run dist`）。
- 发布前自查（一条命令，看包里有没有漏带素材）：

  ```bash
  npx @electron/asar list release/win-unpacked/resources/app.asar | grep -cE 'assets.(skins)'
  # 期望 0。非 0 说明素材进了包，不要上传到任何公开位置。
  ```

- 想要「开箱即有皮肤」的版本：换成**你有权再分发**的素材（自己生成，或明确允许嵌入分发的开源集并按其条款署名），
  放进 `assets/skins/`，同时把 `main.js` 的 `BUILTIN_SKINS_VERSION` 递增（否则老安装不会补发新批次）。

## 许可

MIT（见 [LICENSE](LICENSE)）。可以自由使用、复制、修改、合并、出版、分发、再授权及销售副本，**含商用**；唯一条件是保留版权声明与许可声明。软件按「现状」提供，不含任何担保。

版权声明写 **`APR`**（与 `package.json` 的 `author`、安装包 exe 的 `LegalCopyright` 三处一致；此前是 `showcase contributors`／更早的 `desktop-pet contributors`，1.1.0 首发时统一成署名个人）。提交身份用 GitHub 的 noreply 地址 `用户名@users.noreply.github.com`，**不含真实邮箱**——代价是这笔提交在 Gitee 侧关联不到账号（Gitee 只认账号里已验证的邮箱，而该 noreply 域名无 MX，验证邮件投不到），GitHub 侧正常关联。
