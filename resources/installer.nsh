; 安装目录结构自动化：安装目标自动下沉到 bin 子目录，自动形成
;   <容器>\bin\    程序本体（= $INSTDIR，覆盖安装只清这里）
;   <容器>\data\   计数记录 + config.json + 日志
;   <容器>\skin\   皮肤
; 这样用户只需选一个「容器」目录，数据就永远落在 $INSTDIR 之外——NSIS 覆盖安装
; 清空的是 $INSTDIR（un.atomicRMDir 只遍历其内部 + RMDir /r $INSTDIR），碰不到父目录。
;
; 下沉规则：
;   1) 末段已是 bin → 保持不动（用户自己就选了 …\bin）
;   2) 容器根已有 bin\ → 下沉（旧安装位置就是 bin，清它不影响数据）
;   3) 容器根已有 data\ / skin\ 却没有 bin\ → 保守不动，避免旧卸载程序连带删掉数据
;   4) 其余（全新安装的空目录、只有旧程序文件的 1.0.6 以前结构）→ 下沉，并建好 data 与 skin
;
; 下沉分两条路挂载：
;   · GUI 安装 —— 用户选完目录之后（instfiles 页的 PRE 回调）；
;   · 静默安装 —— customInit 里（/S 不走页面回调，此时 $INSTDIR 已由 /D 或注册表定好）。
;
; 已知限制（实测）：想让**目录页**显示容器目录（而不是 …\bin）在升级场景做不到——
; electron-builder 的 multiUser.nsh 会在安装模式页确认时用注册表里上次的 InstallLocation
; 重设 $INSTDIR（晚于本脚本的 customInit），把这里的规范化覆盖回去。
; 全新安装（注册表无记录）时目录页显示的本就是容器目录；升级时显示上次的 …\bin，也就是最终安装位置，
; 用户直接下一步即可，功能不受影响。详见 PITFALLS §4.8。

; 本自定义脚本会同时进入「安装器」与「卸载器」两遍构建；
; 卸载器要求所有函数以 un. 开头，因此安装器专属的宏与函数必须包在 BUILD_UNINSTALLER 之外。
!ifndef BUILD_UNINSTALLER

; 杀一个映像名的全部实例：普通权限先杀两轮，杀不干净（典型：以管理员运行的实例）再
; runas 提权杀一次（弹一次 UAC，用户拒绝不阻塞，后续 CHECK_APP_RUNNING 兜底）。
; taskkill 退出码：0=杀到进程、128=无此进程、其他=异常（拒绝访问等）。
; 抽成宏是为了普通/提权两轮逻辑复用（票 11-B 第 3 条引入时曾对迁移期新旧两个映像名各跑一遍；
; 旧映像名的第二杀已随票 11-Q 退休，2026-10-06——读数：旧名进程 0 个、容器 bin 内无旧 exe）。
!macro petKillImage IMAGE_NAME
  Push $0
  Push $1
  nsExec::Exec `taskkill /im ${IMAGE_NAME} /f`
  Pop $0
  ${if} $0 != 128
    Sleep 500 ; 给已杀到的实例留退出时间，避免下一轮误判「仍有进程」
    nsExec::Exec `taskkill /im ${IMAGE_NAME} /f`
    Pop $1
    Sleep 400
    ${if} $1 != 128 ; 仍有存活进程（典型：以管理员运行的实例）
      ExecShell runas "taskkill.exe" `/im ${IMAGE_NAME} /f` SW_HIDE
      Sleep 800 ; UAC 同意后给提权 taskkill 留完成时间
    ${endIf}
  ${endIf}
  Pop $1
  Pop $0
!macroend

!macro customInit
  ; ---- 覆盖安装前置：先关掉运行中的桌宠（含管理员权限实例，1.0.42）----
  ; 新名宏由 productName 派生（Showcase.exe）。迁移期曾对旧映像名 desktop-pet.exe 再杀一遍
  ; （票 11-B 第 3 条，兼容层清单 ③）——已随票 11-Q 退休（2026-10-06）：公开面 orphan 首发、
  ; 外部无 1.0.x 用户，本机亦无旧名进程/旧 exe。反向验收：升级时若仍有旧名进程在跑，
  ; 安装器不再杀它，$INSTDIR 清空可能因文件占用失败——只能手工结束进程后重装。
  !insertmacro petKillImage `${APP_EXECUTABLE_FILENAME}`

  ; 此时 initMultiUser 已把注册表里的旧安装位置写进 $INSTDIR（升级场景通常是 …\bin）。
  ; 静默安装没有目录页、也不走页面回调，这里直接下沉；
  ; GUI 安装做个规范化（尽力让目录页显示容器目录，升级场景会被安装模式页覆盖，见顶部已知限制）。
  IfSilent petCustomInitSink
    Call petNormalizeInstallDir
    Goto petCustomInitDone
  petCustomInitSink:
    Call petResolveInstallDir
  petCustomInitDone:
!macroend

!macro customPageAfterChangeDir
  ; 用户选完目录之后、开始释放文件之前执行。
  ; /redef：覆盖 electron-builder 在 assistedInstaller.nsh 里已经定义过的同名常量
  !define /redef MUI_PAGE_CUSTOMFUNCTION_PRE petResolveInstallDir
!macroend

; 规范化：把 $INSTDIR 调成「容器」形态，供目录页展示（全新安装时本来就正确，这里是兜底）
Function petNormalizeInstallDir
  ; 复用 electron-builder 的 instFilesPre（路径不含程序名就先补一层）。
  ; 注意两点：① 它内部会改写 $0，所以必须在 Push $0 之前调用；
  ;          ② 这同时让 instFilesPre 保持「被引用」，否则 NSIS 6010 未引用警告会被 electron-builder 当作错误。
  ; 依赖：allowToChangeInstallationDirectory 必须为 true（package.json 的 nsis 段），否则该函数不存在。
  Call instFilesPre

  Push $0
  StrCpy $0 $INSTDIR "" -4
  StrCmp $0 "\bin" 0 petNormDone
    StrCpy $INSTDIR $INSTDIR -4 ; 去掉尾部 \bin → 还原成容器目录
  petNormDone:
  Pop $0
FunctionEnd

; 下沉：把安装目标改成 <容器>\bin，必要时补建 data 与 skin
Function petResolveInstallDir
  Push $0

  ; ① 末段已是 bin → 不动
  StrCpy $0 $INSTDIR "" -4
  StrCmp $0 "\bin" petDirDone

  ; ② 容器根已有 bin\ → 下沉
  IfFileExists "$INSTDIR\bin" petDirSink

  ; ③ 容器根已有 data\ / skin\ 但没有 bin\ → 保守不动（保护可能已存在的用户数据）
  IfFileExists "$INSTDIR\data" petDirDone
  IfFileExists "$INSTDIR\skin" petDirDone

  petDirSink:
    ; 空目录与旧结构都走这里：建好数据/皮肤目录，再把程序装进 bin 子目录
    CreateDirectory "$INSTDIR\data"
    CreateDirectory "$INSTDIR\skin"
    StrCpy $INSTDIR "$INSTDIR\bin"

  petDirDone:
  Pop $0
FunctionEnd

!endif ; !ifndef BUILD_UNINSTALLER
