// 开机自启提权判定（1.0.32：管理员自启用 Run 键 + 启动时请求提权，替代任务计划方案）。
// 纯逻辑、零依赖：main.js 引用，tools/verify-autostart-elevation.js 直接 require 测真函数，
// 不做镜像断言（镜像测的不是被运行的代码）。
const AUTOSTART_ARG = '--autostart';
const ELEVATED_AUTOSTART_ARG = '--elevated-autostart';

// 开机自启是否应请求提权：
// - argv 带 --autostart：这次是 Run 键开机拉起（手动启动永不触发，用户想提权走「以管理员身份重启」）
// - argv 带 --elevated-autostart：自身已是提权产物，必须跳过，否则 UAC 确认后又弹一次（循环）
// - adminFlag：config.autoStartAdmin（开机自启时以管理员身份运行）
// 注意不能用 isAdmin 挡循环：管理员探测（fltmc）是异步的，提权实例刚起时 isAdmin 还没回来
function shouldRequestElevationOnBoot(argv, adminFlag) {
  const has = (m) => argv.includes(m);
  return has(AUTOSTART_ARG) && !has(ELEVATED_AUTOSTART_ARG) && !!adminFlag;
}

module.exports = { AUTOSTART_ARG, ELEVATED_AUTOSTART_ARG, shouldRequestElevationOnBoot };
