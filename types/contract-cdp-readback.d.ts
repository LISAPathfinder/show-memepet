// native 能力契约·CDP 读回面（票 14-L 任务 2）——换壳验收清单的「判据装置 ↔ 被测实例」通道部分。
// 真源＝tools/run-runtime-ci.js 的注入串（pet-window-missing 各读数口、§96 双副本自检 configIdentityEval）。
// 本仓约定：CDP Runtime.evaluate 的注入表达式一律 `return JSON.stringify(out)`，装置侧再 parse——
// 契约只钉「串里那个对象的形状」；换壳若没有等价的进程内求值通道，运行时判据层要整体重设计（票 14-L 缘起第 2 条）。
// 机器可判（红法 L8 靶）与「不进 build.files」口径同 types/native-koffi.d.ts。

declare namespace CdpContract {
  /** 注入串读回的失败形态：桌宠窗口不在（未建/已关）。装置侧见到它必须把该读数作废，
   *  不许当绿（tools/run-runtime-ci.js:824 等 4 处） */
  interface ErrPetWindowMissing { err: 'pet-window-missing'; }

  /** §96 双副本自检读回（run-runtime-ci.js configIdentityEval，字段照真源逐个抄）：
   *  config.js 的 require cache 按解析路径字符串大小写分副本时，「装置写的」与「产品自己的」
   *  各自缓存——装置写开关产品永远看不到。三项判据（任一不过整轮 exit 3）：
   *  ① keyCount===1（**原始键数**——双副本的两键恰只差大小写，去大小写归一恒 1，归一计数只能作展示）；
   *  ② sameProdIns===true（产品侧 main.js 模块实例 require === 装置绝对路径 require）；
   *  ③ sameCwdIns===true（cwd 相对解析 './config' 也指同一对象——原始故障通道最先分裂） */
  interface DupSelfCheck {
    cwd: string;
    noCache: boolean;        // _cache 不可用：① 弃用，走 app.getAppPath() 兜底判 ②
    viaFallback: boolean;    // 产品侧用了兜底取法
    keys: string[];          // _cache 里解析到 config.js 的全部键（失败输出要原样点名两个键）
    keyCount: number;        // 判据用原始键数，必 1
    dedupCount: number;      // 去大小写归一计数（仅展示，恒 1 不作判据）
    sameProdIns: boolean | null;
    sameCwdIns: boolean | null;
    cwdErr: string;          // cwd 相对解析失败时的错误文本（成功为空串）
    prodHow: string;         // 产品侧副本取法描述
  }

  // ── 类型级用例（红法 L8 靶） ──
  type _Eq<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
  type _IsTrue<T extends true> = T;
  type _u1 = _IsTrue<_Eq<ErrPetWindowMissing['err'], 'pet-window-missing'>>;
  type _u2 = _IsTrue<_Eq<keyof ErrPetWindowMissing, 'err'>>;
  type _u3 = _IsTrue<_Eq<DupSelfCheck['keyCount'], number>>;
  type _u4 = _IsTrue<'sameCwdIns' extends keyof DupSelfCheck ? true : false>;
  type _u5 = _IsTrue<_Eq<DupSelfCheck['sameProdIns'], boolean | null>>;
}
