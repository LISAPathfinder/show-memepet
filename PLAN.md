# 桌宠项目计划书（AI Agent 可执行版）

> **项目**：Emoji 桌宠 + 全局按键统计（Windows 10/11）
> **计划版本**：v2（2026-09-13，已获用户批准）—— v2 新增：鼠标点击统计（F8）、素材无关动画层（F2）；F9 视频实时翻译已于 2026-09-22 移除
> **执行进度**：M1-M9 全部完成（2026-09-13，v2 交付）+ 换皮扩展（皮肤目录/eif 导入）+ NSIS 安装版打包（用户批准，（当时含独立 OCR sidecar.exe，已装到 <安装目录> 并实测）。§8 验收状态见 README；余 2 项待日常使用人工确认（键盘实键一致性、真实手速触发）
> **给执行 Agent 的指令**：完整读完本文档后再动手。按 §7 里程碑顺序执行，每个里程碑完成后先自查 §8 中对应验收项，再进入下一个。§3 技术选型为已定项，不得擅自更换；§12 默认决策如与用户后续要求冲突，以用户为准。

> **现状注记（2026-10-06；只加指针，不改写上文）**：本文是 v1/v2 的立项计划，正文按原样保留作对照。与现行实现的已知差异有五条——
> ① **产品名已改为 Showcase**（曾用名 desktop-pet，1.0.49 起；见 CHANGELOG 与 PITFALLS §66/§72），文中旧名与旧路径按历史读；
> ② **F1 的窗口尺寸 260×300 早已作废**：1.0.52 起是**固定 600×600 透明窗 + 300×300 视觉区**，缩放走纯 CSS transform、零窗口操作（PITFALLS §74）；
> ③ **§4 的「`skins/` 预留，v1 为空」**已演化成两套：应用数据侧 `<安装目录>\skin\`（用户导入的皮肤）与仓库侧 `assets/skins/`（**素材不入库、也不进公开发布的安装包**，理由见 README「开源与素材说明」）；
> ④ **M9 的「README 含 llama-server 启动说明」随 F9 一并失效**（视频实时翻译 2026-09-22 整体移除，运行期零网络请求）；
> ⑤ **版本与发布**：当前 **1.1.0**（2026-10-06 首发）；对外发布走 **v1.1.0 首发 + orphan 单提交**（内部工作记录目录不进公开树），
> 安装包 108.3 MiB **超 Gitee 社区版附件 100MB 闸** ⇒ GitHub 放安装包、Gitee 只放源码。

---

## 1. 项目目标

一个常驻 Windows 桌面的 emoji 桌宠：

- 实时统计**全局**键盘每个按键的按下次数，**仅存本地，不上传**
- 简单交互：点击摸头、拖拽移动、闲置打瞌睡、说话气泡、久坐/喝水提醒
- 展示：桌宠脚下悬浮「今日击键数」+ 统计面板（Top10 按键、每日趋势、鼠标点击）
- 附加统计：鼠标左/右/中键点击计数（F8）

## 2. 运行环境与路径

- Windows 10 / 11 x64；本机已装 Node.js v24、npm（Git Bash 环境）
- 项目目录：`<开发机上的项目根>`（文档里不写绝对路径）
- 运行方式：`npm start`（v1 不打包 exe，打包需用户另行确认）

## 3. 技术选型（已定，不得更换）

| 项 | 选择 | 说明 |
|---|---|---|
| 框架 | Electron + 原生 HTML/CSS/JS | 不引入 Vue/React 等前端框架 |
| 全局键盘钩子 | `uiohook-napi` | 主进程 N-API 预编译模块，无需 node-gyp。钩子逻辑隔离在 `keylistener.js` 内，换实现不用动 main.js。**注意：降级方案不要选 `node-global-key-listener`**——它的 `WinKeyServer.exe` 会被 Defender 按键盘记录器隔离（`Trojan:Win32/KeyLogger!AMTB`，行为启发式误报，因该包本身就是装全局键盘钩子的）；换实现请另找 N-API 钩子或签名过的辅助进程 |
| 数据存储 | 本地 JSON（按天一文件） | 不用数据库 |
| 图表 | 纯 CSS 条形图 + 手写 SVG 折线 | 不引图表库 |
| 打包 | v1 不打包 | `npm start` 运行 |
| 鼠标统计 | uiohook-napi 同一实例的 mouse 事件 | 与键盘钩子共用，不额外装库 |
| 动画层 | 帧序列抽象（v1 用 emoji 帧） | 后续换像素素材不改逻辑（F2） |

## 4. 目录结构（目标形态）

```
showcase/
  PLAN.md            # 本文档
  README.md          # 使用说明：启动、功能、常见问题（M6 编写）
  package.json
  main.js            # 主进程：窗口管理、键盘钩子、数据落盘、菜单、提醒定时
  preload.js         # contextBridge 安全暴露 ipc API
  keylistener.js     # 键盘+鼠标钩子封装（含降级方案切换点）
  lines.js           # 桌宠台词库（~30 条中文，用户可自行增删）
  sidecar/
  assets/
    skins/             # 预留：像素形象素材目录（v1 为空）
  renderer/
    pet.html/css/js     # 桌宠本体 + 气泡 + 爱心粒子 + 悬浮计数
    stats.html/css/js   # 统计面板
  data/              # 运行时生成，已 gitignore
    keys-YYYY-MM-DD.json   # 每日按键计数
    config.json            # 用户配置
```

## 5. 数据格式

**每日计数** `data/keys-2026-09-13.json`：

```json
{ "v": 1, "date": "2026-09-13", "total": 1234, "keys": { "Space": 200, "KeyA": 87 }, "mouse": { "left": 56, "right": 12, "middle": 0 } }
```

**配置** `data/config.json`（缺省项自动补全）：

```json
{
  "reminderEnabled": true,
  "reminderIntervalMin": 45,
  "sleepAfterMin": 10,
  "petPosition": { "x": null, "y": null },
  "autoStart": false,
  "translate": {
    "llamaBaseUrl": "http://127.0.0.1:8081/v1",
    "llamaModel": "",
    "ocrIntervalMs": 1000,
    "targetLang": "中文"
  }
}
```

## 6. 功能规格

### F1 桌宠窗口
- 尺寸 260×300；透明背景、无边框、置顶（`alwaysOnTop`）、不进任务栏（`skipTaskbar`）
- 默认出现在主屏右下角（距边 20px）；`petPosition` 有值则恢复上次位置；位置超出当前屏幕时自动归位右下角
- **鼠标穿透**：renderer 监听 `mousemove`，指针位于形象/气泡/计数元素上才 `setIgnoreMouseEvents(false)`，否则 `(true, { forward: true })`，保证透明区域不挡其他窗口操作
  > **现行实现（非改写上文，只加指针）**：渲染端定时器会被 Chromium 节流，判定自 1.0.x 起迁到主进程——
  > 渲染端只**上报**可交互区域，穿透位由 `syncPetPassThrough → nativeSetIgnoreMouseEvents` 写；
  > **1.0.57 起渲染端连写入口都已删除**（`petAPI.setIgnoreMouseEvents` 与该 ipc 通道一并摘掉，
  > §52 的单写入者由约定变成结构事实）。判据：`tools/verify-single-writer.js` + `tools/verify-passthrough-desync.js`。

### F2 形象与状态机（动画层素材无关，CSS keyframes 实现）

| 状态 | emoji | 进入条件 | 退出条件 |
|---|---|---|---|
| idle | 🐱 | 默认 | 任意事件 |
| blink | 😸 | idle 时每 3~6 秒随机 | 300ms 后回 idle |
| happy | 🤩 | 被点击 | 1.5s 后回 idle |
| sleep | 😴（脚下 💤） | 连续 `sleepAfterMin` 分钟无键鼠活动 | 任意键鼠活动立刻醒 |
| wow | 😮 | 打字提速触发（见 F3） | 2s 后回 idle |
| remind | 🥺 | 久坐提醒 | 气泡消失后回 idle |

> 动画播放器只消费「帧序列数组」：v1 各状态的帧是 emoji 字符串；后续换像素素材时，把帧换成图片路径（`assets/skins/<name>/idle_0.png…`）即可换皮，状态机与播放逻辑零改动。

### F3 交互
- **点击摸头**：进入 happy + 从脚下飘出 3~5 个 💕 粒子（CSS 动画，飘起并淡出）；10 秒内连续点击 ≥5 次冒台词「别戳啦！」
- **拖拽**：在形象上按住即拖（自实现：mousedown → ipc 通知主进程 `win.setPosition`；位移阈值 5px 区分点击与拖拽），松手后位置写入 config
- **打瞌睡**：键盘 keydown 与鼠标 mousemove（节流 ≥1s）都刷新 `lastActivity`；超时进入 sleep，任何活动唤醒
- **说话气泡**：随机间隔 5~15 分钟从 `lines.js` 抽一条显示 4.5s；气泡出现在形象上方，带出入场动画
- **手速触发**：3 秒滚动窗口击键 ≥24 次且距上次触发 >60s → wow 状态 + 气泡「手速好快！」

### F4 久坐/喝水提醒
- 默认每 45 分钟弹气泡（🥺 +「起来动一动，喝口水💧」），显示 6s
- 触发后重置计时器；键鼠活动**不**重置（久坐本来就指持续工作）
- 开关与间隔经 F6 菜单配置

### F5 按键统计
- 主进程 `keylistener.js` 挂 uiohook `keydown`；keycode 经 `UiohookKey` 枚举映射为可读键名（A、Space、Enter、Shift、Ctrl…），未知键记作 `Key_0xNN`
- 内存累计当日 `{key: count}`；有变更时每 5 秒写当日 JSON；退出前（`before-quit`）强制落盘
- **悬浮计数**：形象脚下常驻「⌨ N · 🖱 M」（键盘+鼠标两段式），由主进程 ipc 推送（节流 200ms），数字带轻微弹跳动画
- **隐私红线**：不记录按键序列/输入内容、不记录窗口标题、不发起任何网络请求

### F6 桌宠右键菜单（`Menu.buildFromTemplate` + `popup`）
1. 打开统计面板
3. 久坐提醒：开/关（checkbox）
4. 提醒间隔：30 / 45 / 60 / 90 分钟（radio）
5. 开机自启：开/关（`app.setLoginItemSettings`）
6. 退出

菜单变更即时持久化到 `data/config.json`。

### F7 统计面板
- 双击桌宠或菜单打开；420×560 普通窗口；单实例（已开则聚焦）；深色简洁风
- 指标卡：**今日 / 最近 7 天 / 累计** 击键总数
- Top10 按键横向条形图（今日数据，CSS 宽度按占比）
- 最近 14 天每日总击键 SVG 折线（手写 polyline + 数值点）
- 数据源：汇总读取 `data/keys-*.json`；打开时计算即可，不需后台常驻

### F8 鼠标点击统计
- 与键盘共用同一个 uiohook 实例，监听 `mousedown`：left / right / middle 分别计数（移动、滚轮不计）
- 写入当日 JSON 的 `mouse` 字段；统计面板新增「鼠标点击」区（左/右/中键次数 + 今日合计）
- 悬浮计数升级为「⌨ N · 🖱 M」两段式（见 F5）

### F9 视频实时翻译（**已于 2026-09-22 按用户要求整体移除**）

> 原设计（框选 → 本地 OCR → llama.cpp 翻译 → 双语字幕条；以及 sherpa-onnx 语音识别链路）
> 连同 `asr.js`、`asr-worker.js`、`renderer/subtitle.*`、`sidecar/ocr_server.py` 一并删除，安装包不再携带 OCR sidecar 与 ASR 模型（体积从 512MB 降到约 150MB）。
> 历史实现见 git 历史与 PITFALLS 第五章（该章条目保留作通法参考）。

## 7. 里程碑执行顺序

| # | 内容 | 产出 |
|---|---|---|
| M1 | 脚手架：`npm init`、安装 `electron` + `uiohook-napi`（下载慢则设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 npmmirror registry）、`git init` + `.gitignore`（node_modules/、data/）、空窗口 `npm start` 跑通 | 可启动的空应用 |
| M2 | 桌宠窗与动画：F1、F2（动画层做帧序列抽象） | 桌宠可见可动画，帧源可替换 |
| M3 | 键盘+鼠标钩子与数据：F5、F8（钩子、落盘、悬浮计数） | 打字/点击计数生效 |
| M4 | 交互：F3、F4 | 全部交互生效 |
| M5 | 统计面板：F7 | 面板可用 |
| M6 | 菜单：F6 | 菜单全项生效 |
| M9 | 收尾：README.md（含 llama-server 启动说明）、PLAN 同步、§8 全量验收 | v2 完成 |
| M10 | v2.1 扩展（用户追加）：换皮（皮肤目录/eif 导入/拖拽导入）、手柄 XInput 统计、主题三模式、自绘菜单（字号可调）、语音翻译（sherpa-onnx 流式 + llama）、NSIS 打包（内置 OCR sidecar.exe 与语音模型） | 安装版 desktop-pet-setup-1.0.0.exe |

每个里程碑完成后：自查 → `git commit`（信息格式 `M2: 桌宠窗口与动画`）。

## 8. 验收清单（M6 逐条验证并输出验收报告）

- [ ] `npm start` 后桌宠出现在右下角，透明无白底/边框，置顶且透明区域不挡其他窗口
- [ ] 记事本连续打字，脚下「今日 N 键」实时增加，与 JSON 中 total 一致
- [ ] `data/keys-当日.json` 抽查 Space/Enter/字母计数正确
- [ ] 点击有 happy 动画 + 爱心；连点 5 次出现「别戳啦！」
- [ ] 按住可拖动；重启应用位置保留
- [ ] 临时把 `sleepAfterMin` 改 1 分钟能看到打瞌睡，敲键盘立刻醒（验完改回 10）
- [ ] 临时把提醒间隔改 1 分钟能收到 💧 提醒（验完改回 45）
- [ ] 打字飞快时出现「手速好快！」
- [ ] 双击/菜单打开统计面板，三项指标、Top10、14 天折线渲染正确
- [ ] 右键菜单各项生效；开机自启开关在任务管理器→「启动应用」中可见变化
- [ ] 退出重开后历史数据完整
- [ ] 资源占用：空闲内存 < 250MB，空闲 CPU ≈ 0%
- [ ] 桌面任意处左/右键点击，悬浮数与面板的鼠标计数一致
- [ ] 悬浮计数为「⌨ N · 🖱 M」两段式
- [ ] llama-server 未启动时桌宠气泡友好提示，应用不崩溃；服务恢复后即用

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 杀软对全局钩子误报 | README 说明放行；数据仅本地可自查 |
| `uiohook-napi` 安装失败 | §3 降级方案，接口隔离在 `keylistener.js` |
| Electron 下载慢 | npmmirror 镜像（见 M1） |
| 管理员权限程序中的按键捕获不到 | 已知系统限制，写入 README |
| 桌宠被拖到屏幕外 | 启动时与配置读取时自动归位（F1） |
| DRM 版权视频（Netflix 等）截不到画面 | 已知系统限制，README 说明 |
| llama-server 未启动或端口不同 | 开启前健康检查 + 气泡提示；地址/模型在 config 可改 |
| RapidOCR 与 Python 3.13 不兼容 | 降级 Tesseract.js（纯 JS）方案，接口不变 |

## 10. 明确不做（v1 范围外）

托盘图标（可作 v1.1）、云端同步、自动更新、输入内容/窗口标题记录、多显示器智能摆放、字幕文件批量翻译（本次未选）、语音听译、llama.cpp 的安装与模型调优（用户已就绪）、字幕区域自动追踪。（原「exe 打包」经用户 2026-09-13 批准已实施为 NSIS 安装版，见 README「打包」节）

## 11. 默认决策（用户可否决）

| 决策 | 默认值 |
|---|---|
| 形象动物 | 猫 🐱（`pet.js` 顶部常量，一行可换） |
| 界面与台词语言 | 中文 |
| 台词库 | 内置约 30 条吐槽/励志语 |
| 提醒间隔 / 打瞌睡阈值 | 45 分钟 / 10 分钟 |
| 数据保留 | 永久（单文件极小） |
| 版本管理 | `git init`，仅本地不推远端 |
