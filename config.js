// data/config.json 读写：缺省项自动补全，未知键忽略
const fs = require('fs');
const path = require('path');

// 数据目录：数据与程序分离——NSIS 覆盖安装/卸载会清空安装目录（$INSTDIR），用户数据必须落在
// 它之外。1.0.6 起支持两种落地方式，优先新结构：
//   ① 程序装在 <容器>\bin\ 下（新结构）：根 = 容器本身，数据落 <容器>\data\、皮肤落 <容器>\skin\。
//      此时 NSIS 的 $INSTDIR 只到 bin，覆盖安装清空 bin 时父目录里的数据/皮肤在删除范围之外。
//   ② 程序直接装在安装目录下（1.0.5 及以前）：根 = 安装目录同级的 <安装目录名>-data\。
// 同级不可写（如装进盘根）才回退 userData（C 盘）保命；仍可用
// SHOWCASE_DATA_DIR 环境变量覆盖（测试接缝。旧名 DESKTOP_PET_DATA_DIR 的回落已随票 11-Q
// 退休，2026-10-06：公开面无 1.0.x 用户，仓内 spawn 件已换新名）。开发版保持项目内 data/
function writableDir(base, sub) {
  try {
    const target = path.join(base, sub);
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch {
    return null;
  }
}

const SKIN_DIR = 'skin'; // 皮肤子目录名（1.0.6 起统一为 skin；更早版本叫 skins，迁移时并入）

function resolveUserRoot() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      const exeDir = path.dirname(app.getPath('exe'));
      // ① 程序在名为 bin 的子目录里 → 根取它的父目录（容器）。
      // 探测顺手建好 data\（幂等）：建不出来说明容器不可写，退回旧逻辑。
      if (path.basename(exeDir).toLowerCase() === 'bin' && writableDir(path.dirname(exeDir), 'data')) {
        return path.dirname(exeDir);
      }
      // ② 旧结构：安装目录同级的 <安装目录名>-data\
      const sibling = writableDir(path.dirname(exeDir), `${path.basename(exeDir)}-data`);
      if (sibling) return sibling;
      // 安装目录同级不可写：回退 AppData（老兜底位置）
      return app.getPath('userData');
    }
  } catch {
    // 纯 node 环境（测试/脚本）
  }
  return __dirname;
}

// 用户数据根：新结构 = <容器>（程序在 <容器>\bin\ 时）；旧结构 = 安装目录同级 <程序名>-data\；dev = 项目根。
// skins.js 的皮肤根也挂在这下面（skins.js require 本文件的 SKIN_ROOT，无循环依赖）
const USER_DATA_ROOT = resolveUserRoot();
// 数据根覆盖接缝：SHOWCASE_DATA_DIR（票 11-B 第 5c 条，用户 2026-10-04 勾选 A）。
// 旧名 DESKTOP_PET_DATA_DIR 的回落已随票 11-Q 退休（⑥，2026-10-06）——反向验收：仍按旧名
// 传参的外部命令会被静默忽略、数据落回默认根；仓内两个 spawn 件已同步换新名。
const DATA_DIR = process.env.SHOWCASE_DATA_DIR || path.join(USER_DATA_ROOT, 'data');
const SKIN_ROOT = path.join(USER_DATA_ROOT, SKIN_DIR);
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  skinName: 'emoji',
  menuFontSize: 14,
  reminderEnabled: true,
  reminderNotifyWindows: true, // 久坐提醒同时弹 Windows 系统通知（隐藏桌宠时唯一可见的提醒途径）
  reminderIntervalMin: 45,
  sleepAfterMin: 10,
  petPosition: { x: null, y: null },
  autoStart: false,
  autoStartAdmin: false, // 开机自启模式偏好：false=普通（默认）、true=管理员（开机弹一次 UAC，机制见 main.js setAutoStartMode / autostart-elevation.js）
  petScale: 1, // 桌宠整体缩放（Ctrl 手柄拖动调节，0.5~2；1.0.52 起只驱动渲染端 transform，窗口固定 600×600）
  petWindowFixed: false, // 固定窗迁移标记：1.0.52 首启把 petPosition 按「视觉右下角不动」换算一次（见 main.js migratePetWindowFixed）
  dblclickStats: false, // 双击桌宠打开统计面板（默认关）
  walkByTripleClick: true, // Ctrl+连续三击任意位置 → 桌宠走过去（带修饰键，避免与系统三击选段冲突）
  cursorFleeEnabled: true, // 鼠标在桌宠身上停留超过 5 秒 → 自动让开（优先向下，其次左右）
  builtinSkinsVersion: 0, // 随包内置的皮肤已释放到用户皮肤目录的批次号（见 main.js installBuiltinSkins）
  theme: 'system', // 主题：system/light/dark（菜单「主题」写入；必须在 DEFAULTS 里登记，否则被白名单丢弃）
};

let cache = null;

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    const isObj = v && typeof v === 'object' && !Array.isArray(v);
    if (isObj && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (k in base) {
      base[k] = v;
    }
  }
  return base;
}

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // 首次运行或文件损坏：全用默认值
  }
  cache = deepMerge(structuredClone(DEFAULTS), saved);
  return cache;
}

function save() {
  if (!cache) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[config] 写入失败:', err.message);
  }
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  save();
}

module.exports = { load, save, get, set, DATA_DIR, USER_DATA_ROOT, SKIN_DIR, SKIN_ROOT };
