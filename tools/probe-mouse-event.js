// 探针：打印全局钩子收到的每次鼠标按下，回答两个必须实测的问题
//   ① e.clicks（OS 连击计数）在 Windows 上到底有没有被填充 —— 决定「Ctrl+三击」用 OS 计数还是自攒
//   ② e.ctrlKey / e.altKey 这些修饰键标志有没有被填充
// 坐标 e.x/e.y 按 uiohook 的契约是物理像素（与 Electron 的 DIP 换算见 walk.js 相关代码）；
// 本机缩放 100% 时两者相同，换到缩放≠100% 的机器需要复核，这里不做自动判定。
// 纯 node（不依赖 electron），用法：
//   node tools/probe-mouse-event.js [秒数]
// 运行期间请按住 Ctrl 在任意位置连点三下，再空手连点三下做对照。每行一条，Ctrl+C 退出。
const { uIOhook } = require('uiohook-napi');

const seconds = Number(process.argv[2]) || 30;

const BUTTON = { 1: '左', 2: '右', 3: '中' };

console.log(`探针启动：监听 ${seconds} 秒。请【按住 Ctrl + 连点左键三下】，再【空手连点左键三下】做对照。`);
console.log('字段：时间 | 事件x,y | 按钮 | clicks | ctrl | alt | shift');

uIOhook.on('mousedown', (e) => {
  const t = new Date().toISOString().slice(11, 23);
  console.log(
    `↓按下 ${t} | ${e.x},${e.y} | ${BUTTON[e.button] || e.button} | clicks=${e.clicks} | ctrl=${e.ctrlKey} alt=${e.altKey} shift=${e.shiftKey}`
  );
});

// 松开事件：确认 uiohook 是否真的会派发 mouseup（类型声明里有 ≠ 运行时会有）
uIOhook.on('mouseup', (e) => {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`↑松开 ${t} | ${e.x},${e.y} | ${BUTTON[e.button] || e.button}`);
});

uIOhook.start();

setTimeout(() => {
  console.log(`\n${seconds} 秒到，探针结束。`);
  try {
    uIOhook.stop();
  } catch {
    // 已停止
  }
  process.exit(0);
}, seconds * 1000);
