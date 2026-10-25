// native 能力契约·koffi 面（票 14-L 任务 2）——换壳（WebView2／原生壳）时的 **Win32 能力验收清单**。
// 真源＝产品码与 tools 现行 koffi 绑定（main.js styleFns()／提权 ShellExecuteW／任务栏 COM 链、
// tools/inject-click.js 的 SendInput 组），签名逐条照抄现行声明；新壳必须逐条提供等价能力或明示取舍。
// ⚠ 票面曾列 OpenProcessToken：现仓 grep 0 命中（没有任何件绑定它），不进契约——契约只收真实在用的绑定。
// 机器可判（红法 L8 靶）：文末「类型级用例」把关键签名钉进类型系统——契约里写错签名 ⇒ 用例断言翻红 ⇒
//   verify-checkjs（基线无键 types/*.d.ts 必红）与 verify-checkjs-tiers 双双红，「写了没人用」不可能。
// 本文件不进 build.files（编译期资产不发货），由两份 tsconfig 的 types/**/*.d.ts include 吃进、
//   不进 e/B 面读数（verify-checkjs 对 .d.ts 显式剔除）——「零发货改动」是件里现成的设计，不是推测。

declare namespace Win32 {
  /** 句柄：产品侧 koffi 'uintptr' 落 JS 为 number */
  type Hwnd = number;
  /** HRESULT / BOOL 等整型返回照 koffi 声明落 number */
  interface Rect { left: number; top: number; right: number; bottom: number; }
  interface Point { x: number; y: number; }

  /** main.js styleFns()（样式与几何组）——出参一律预填缓冲（Uint8Array/Buffer），读数靠 readUInt32LE 等 */
  interface StyleFns {
    /** GetWindowLongPtrW int64(uintptr,int)——读扩展样式（GWL_EXSTYLE=-20） */
    getEx(hwnd: Hwnd, nIndex: number): number;
    /** SetWindowLongPtrW int64(uintptr,int,int64)——写扩展样式（穿透/TOOLWINDOW 位的唯一通道） */
    setEx(hwnd: Hwnd, nIndex: number, dwNewLong: number): number;
    /** SetWindowPos bool(uintptr,uintptr,int,int,int,int,uint32)——位置-only 移动必须带 SWP_NOSIZE（§98：
     *  Electron setPosition 在非整数 DPI 下每步把尺寸 +1~2px，koffi 这条是尺寸恒定的那条路） */
    setPos(hwnd: Hwnd, hWndInsertAfter: Hwnd, x: number, y: number, cx: number, cy: number, uFlags: number): boolean;
    /** GetWindow uintptr(uintptr,uint)——z 链遍历（任务栏压顶判定） */
    getWindow(hwnd: Hwnd, uCmd: number): Hwnd;
    /** GetWindowRect bool(uintptr,void*)——lpRect 为 16 字节出参缓冲 */
    getRect(hwnd: Hwnd, lpRect: Uint8Array): boolean;
    /** IsWindowVisible bool(uintptr)——注意 DWM cloak 的窗仍返回 true，配 dwmCloaked 判 */
    isVisible(hwnd: Hwnd): boolean;
    /** GetClassNameW int(uintptr,void*,int)——认窗（Chrome_WidgetWin_1 等） */
    getClassName(hwnd: Hwnd, lpClassName: Uint8Array, nMaxCount: number): number;
    /** GetWindowThreadProcessId uint32(uintptr,void*)——lpdwProcessId 为 4 字节出参 */
    getPid(hwnd: Hwnd, lpdwProcessId: Uint8Array): number;
    /** FindWindowExW uintptr(uintptr,uintptr,void*,void*)——取 Chromium 渲染子窗
     *  （Chrome_RenderWidgetHostHWND，真正接鼠标的那个；外壳在而子窗失联＝点击全丢，§101） */
    findChild(hwndParent: Hwnd, hwndChildAfter: Hwnd, lpszClass: Uint8Array | null, lpszWindow: Uint8Array | null): Hwnd;
    /** DwmGetWindowAttribute int32(uintptr,uint32,void*,uint32)——DWMWA_CLOAKED(14) 出参 4 字节，
     *  返回 0 且值非 0 ＝ DWM 隐身（开始菜单等全屏壳窗，IsWindowVisible 看不见这层） */
    dwmCloaked(hwnd: Hwnd, dwAttribute: number, pvAttribute: Uint8Array, cbAttribute: number): number;
    /** GetLayeredWindowAttributes（整串式声明照抄：pKey uint32*／pAlpha uint8*／pFlags uint32*）——
     *  petCovered 按 alpha 判遮挡的读数口；整串形式是实测件验证过的写法，勿改成拆参形式 */
    getLayeredAttr(hwnd: Hwnd, pKey: Uint8Array, pAlpha: Uint8Array, pFlags: Uint8Array): boolean;
  }

  /** main.js:890——GetAsyncKeyState int16(int32)，Ctrl 对账自愈用（VK_CONTROL=0x11） */
  type GetAsyncKeyStateFn = (vKey: number) => number;

  /** main.js:702——ShellExecuteW int(hwnd,lpOperation,lpFile,lpParams,lpDir,nShowCmd)；'runas'＝UAC 提权重启 */
  type ShellExecuteWFn = (hwnd: Hwnd, lpOperation: string, lpFile: string, lpParameters: string | null, lpDirectory: string | null, nShowCmd: number) => number;

  /** 任务栏 COM 链（main.js:1755-1840，票 14-D）：skipTaskbar 不是窗口属性而是 shell 侧登记，
   *  explorer 重建后登记作废——看门狗须能重链并重发 DeleteTab */
  interface TaskbarLink {
    /** CoCreateInstance(CLSID_TaskbarList) 出来的对象（vtable slot 2 = Release） */
    release(): void;
    /** vtable slot 3 = HrInit——非 0 失败须重链 */
    hrInit(): number;
    /** vtable slot ≥5 的 DeleteTab(obj, hwnd)——HRESULT，0=S_OK；对桌宠两个 HWND 各发一次 */
    deleteTab(hwnd: Hwnd): number;
  }
  /** GetShellWindow uintptr()——z 链锚（Shell_TrayWnd 侧另有常量，此处不重复） */
  type GetShellWindowFn = () => Hwnd;

  /** tools/inject-click.js 的注入组（产品码内不绑定，判据工具面） */
  interface MouseInput { dx: number; dy: number; mouseData: number; dwFlags: number; time: number; dwExtraInfo: number; }
  interface Input { type: number; mi: MouseInput; }
  /** SendInput uint32(uint32, INPUT*, int)——返回成功注入的事件数（< 请求数＝注入被吞，判据工具要查）。
   *  ⚠ x64 的 INPUT 共 40 字节：type(4)+对齐 pad(4) 之后才是 MOUSEINITIAL——**mi.dwFlags 在偏移 20 不是 8**；
   *  结构排错/cbSize 传错时注入会变成别的手势（如移动到 (0,0)），不是报错 */
  type SendInputFn = (cInputs: number, pInputs: Input[], cbSize: number) => number;
  /** SetCursorPos bool(int,int)——吃**物理像素**，DIP 几何必须先换算（§102：非 100% 缩放整体错位的根因） */
  type SetCursorPosFn = (x: number, y: number) => boolean;

  // ── 样式位与旗标（语义面，字面量类型钉死数值——改常量必须连用例一起改） ──
  const GWL_EXSTYLE: -20;
  const WS_EX_TRANSPARENT: 0x00000020; // 与 LAYERED 同挂才产生鼠标路由（§63）
  const WS_EX_TOOLWINDOW: 0x00000080;  // 免疫层：shell 枚举直接排除
  const WS_EX_LAYERED: 0x00080000;     // 分层窗：矩形相交≠视觉遮挡（§63）
  const SWP_MOVE_ONLY: 0x0015;         // NOSIZE(0x1)|NOZORDER(0x4)|NOACTIVATE(0x10)——位置-only 摆位（§104）
  const DWMWA_CLOAKED: 14;

  // ── 类型级用例（红法 L8 靶：契约改坏任一被钉签名 ⇒ 这些断言翻红 ⇒ 两件 checkJs 判据件红） ──
  type _Eq<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
  type _IsTrue<T extends true> = T;
  type _u1 = _IsTrue<_Eq<Parameters<StyleFns['setPos']>[6], number>>;        // setPos 第 7 参＝uFlags
  type _u2 = _IsTrue<_Eq<ReturnType<StyleFns['getLayeredAttr']>, boolean>>;
  type _u3 = _IsTrue<_Eq<Parameters<GetAsyncKeyStateFn>[0], number>>;
  type _u4 = _IsTrue<_Eq<ReturnType<ShellExecuteWFn>, number>>;
  type _u5 = _IsTrue<_Eq<TaskbarLink['deleteTab'], (hwnd: Hwnd) => number>>;
  type _u6 = _IsTrue<_Eq<keyof Input, 'type' | 'mi'>>;
  type _u7 = _IsTrue<_Eq<ReturnType<SendInputFn>, number>>;
  type _u8 = _IsTrue<_Eq<typeof SWP_MOVE_ONLY, 0x0015>>;
  type _u9 = _IsTrue<_Eq<typeof WS_EX_LAYERED, 0x00080000>>;
  type _u10 = _IsTrue<_Eq<typeof GWL_EXSTYLE, -20>>;
}
