// native 能力契约·uiohook 面（票 14-L 任务 2）——换壳验收清单的输入事件部分。
// 真源＝keylistener.js 装配（uIOhook.on 四路 + UiohookKey 枚举反查）、main.js 消费点
// （bumpKey/Key_0x0 丢弃/tripleClick 详情）、tools/probe-mouse-event.js 的字段实证。
// 机器可判（红法 L8 靶）与「不进 build.files」口径同 types/native-koffi.d.ts。

declare namespace UiohookContract {
  /** 修饰键字段在部分平台上不总填充——OS 侧拿不到时产品用自维护 modDown 补（keylistener.js:52） */
  interface BaseEvent { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; }
  interface KeyEvent extends BaseEvent { keycode: number; }
  /** 按下事件：x/y 为 uiohook 上报的原始坐标，clicks 为 **OS 连击计数**（「Ctrl+三击走过去」的判定源，
   *  walk.js:40 实测 Windows 上有填充且 ≥1；缺数时产品退回自攒计数） */
  interface MouseButtonEvent extends BaseEvent { x: number; y: number; button: number; clicks: number; }
  interface MouseMoveEvent extends BaseEvent { x: number; y: number; }

  /** ⚠ Windows 运行时 **不派发 mouseup**——类型声明里有、2026-09-22 实测不发（main.js:1314）。
   *  需要 mouseup 的功能一律走渲染端 DOM 事件（renderer/pet.js）；on('mouseup') 绑定保留只为
   *  让换实现的人一眼看到这个坑。换壳验收＝新事件源必须同时提供 keydown/keyup/mousedown/mousemove
   *  与 OS 连击计数；mouseup 可缺（与现状等价）。 */
  interface Hook {
    on(evt: 'keydown', h: (e: KeyEvent) => void): void;
    on(evt: 'keyup', h: (e: KeyEvent) => void): void;
    on(evt: 'mousedown', h: (e: MouseButtonEvent) => void): void;
    on(evt: 'mouseup', h: (e: MouseButtonEvent) => void): void;
    on(evt: 'mousemove', h: (e: MouseMoveEvent) => void): void;
    start(): void;
    stop(): void;
  }
  /** UiohookKey 枚举：键名 → 扫描码（'A'→…）。反向查表叫不出名字的扫描码落 `Key_0xNN` 字符串 */
  type UiohookKeyMap = Record<string, number>;
  /** 可读键名：枚举名（A/Space/Ctrl…）或 `Key_0x${string}`（未知扫描码） */
  type KeyName = string;
  /** **Key_0x0 ＝ VC_UNDEFINED**：不是任何真实按键——票 14-H 实测 47/47 紧跟手柄按键 4~660ms，
   *  当击键记就会「按手柄时键盘计数也涨」；消费侧（main.js bumpKey）直接丢弃、只留一行诊断日志。
   *  换壳验收：新事件源若也会报「认不出的输入」，必须有等价的可识别形态与丢弃通道 */
  const VC_UNDEFINED_KEY_NAME: 'Key_0x0';

  // ── 类型级用例（红法 L8 靶） ──
  type _Eq<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
  type _IsTrue<T extends true> = T;
  type _u1 = _IsTrue<_Eq<typeof VC_UNDEFINED_KEY_NAME, 'Key_0x0'>>;
  type _u2 = _IsTrue<_Eq<UiohookKeyMap['A'], number>>;
  type _u3 = _IsTrue<KeyEvent extends BaseEvent ? true : false>;
  type _u3b = _IsTrue<'keycode' extends keyof KeyEvent ? true : false>;
  type _u4 = _IsTrue<'clicks' extends keyof MouseButtonEvent ? true : false>;
  type _u5 = _IsTrue<Hook extends { on(evt: 'mousedown', h: (e: MouseButtonEvent) => void): void } ? true : false>;
}
