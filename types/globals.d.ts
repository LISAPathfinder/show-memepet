// 票 11-Z：让静态层（tsc --noEmit + checkJs）认得 petAPI。
// petAPI?: any 是有意过渡——真实方法表（约 37 个方法）留下一票补，any 不是把接口写对。
interface Window {
  petAPI?: any;
}

// 票 0a-2：渲染端三个「跨经典脚本共享」的纯符号——真源在 core/interactive-box.js 的顶层声明，
// 由 renderer/pet.html 先于 pet.js 以 <script src> 加载（渲染端没有 CommonJS）。TS 看不见这种
// 跨脚本的全局词法绑定，不声明就是 5 条 TS2304（pet.js 的 interactiveBox/reportInteractiveBox 各一处）。
// 这里**只声明类型不写值**：写了值就成了第二份真源，值由 core 与判据件（require）钉。
declare const BOX_PAD: number;
declare const BOX_EPSILON: number;
declare function boxSignature(box: Array<{ x: number; y: number; width: number; height: number }> | null): string;
