// 皮肤管理（换皮）：扫描 assets/skins/<皮肤名>/，约定文件名或 skin.json 显式映射；
// eif 导入按图片签名 carving（QQ eif 为 OLE2/zip 容器内嵌 GIF/PNG 字节流，签名切分对容器变体免疫）
const fs = require('fs');
const path = require('path');

const SKIN_STATES = ['idle', 'blink', 'happy', 'sleep', 'wow', 'remind', 'drag', 'move'];
// .avif：静图/动图 Chromium 均原生解码（显示零成本）；jxl/heic 内核不支持，刻意不收
const IMAGE_EXTS = ['.gif', '.png', '.jpg', '.jpeg', '.webp', '.avif'];
// emoji 皮肤映射存储：skinRoot/emoji-skin.json（state → emoji 字符）
const EMOJI_MAPPING_FILE = 'emoji-skin.json';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const GIF_SIGS = [Buffer.from('GIF89a'), Buffer.from('GIF87a')];

// 皮肤根目录：与数据目录同策略——挂在用户数据根（config.SKIN_ROOT，打包版 =
// <容器>\skin\ 或旧结构 <程序名>-data\skin\）下，覆盖安装/卸载清空安装目录也不受影响；
// 安装同级不可写时 USER_DATA_ROOT 已是 userData，同样落在这里；开发版保持项目内 assets/skins
const { SKIN_ROOT } = require('./config');
function defaultSkinRoot() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return SKIN_ROOT;
    }
  } catch {
    // 纯 node 环境（测试/脚本）
  }
  return path.join(__dirname, 'assets', 'skins');
}

let skinRoot = defaultSkinRoot();

function getSkinRoot() {
  return skinRoot;
}

function setSkinRoot(dir) {
  skinRoot = dir;
}

function isImageFile(name) {
  return IMAGE_EXTS.includes(path.extname(name).toLowerCase());
}

// 根目录边界校验：返回落在 root 内的绝对路径，越界返回 null
function insideRoot(root, relative) {
  if (typeof relative !== 'string' || !relative) return null;
  const resolved = path.resolve(root, relative);
  if (resolved === path.resolve(root)) return null;
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return null;
  return resolved;
}

// 皮肤名白名单：中文/字母/数字/下划线/连字符，且不带路径分隔符
function isSafeName(name) {
  return typeof name === 'string' && !!name && /^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(name);
}

// 皮肤有效条件：能确定 idle 图（skin.json 映射或约定文件名）
// 名字 'emoji' 是内置 emoji 皮肤：无目录，帧来自 emoji-skin.json 的字符映射
function resolveSkin(name) {
  if (name === 'emoji') {
    return { name, dir: null, type: 'emoji', frames: getEmojiMapping() };
  }
  if (!isSafeName(name)) return { name, dir: null, type: 'invalid', frames: {} };
  const dir = insideRoot(skinRoot, name);
  if (!dir) return { name, dir: null, type: 'invalid', frames: {} };
  let mapping = null;
  try {
    mapping = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8')).frames;
  } catch {
    // 无显式映射：走约定文件名
  }
  const frames = {};
  for (const state of SKIN_STATES) {
    let file = null;
    const mapped = mapping && typeof mapping[state] === 'string' ? mapping[state] : null;
    if (mapped && isImageFile(mapped)) {
      const mappedPath = insideRoot(dir, mapped);
      if (mappedPath && fs.existsSync(mappedPath)) file = mapped;
    }
    if (!file) {
      for (const ext of IMAGE_EXTS) {
        const hit = findCaseInsensitive(dir, state + ext);
        if (hit) {
          file = hit;
          break;
        }
      }
    }
    if (file) frames[state] = file;
  }
  return { name, dir, type: frames.idle ? 'image' : 'invalid', frames };
}

function findCaseInsensitive(dir, lowerName) {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === lowerName.toLowerCase());
    return hit || null;
  } catch {
    return null;
  }
}

// emoji 皮肤映射：state → emoji 字符。字符白名单：Extended_Pictographic + 变体选择符/连接符/肤色符
const EMOJI_CHAR_RE =
  /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200d\uFE0F\u20E3\u{E0020}-\u{E007F}])+$/u;

// 映射文件固定在 skinRoot 直下（常量文件名 + 显式包含性校验，杜绝路径穿越）
function emojiMappingPath() {
  const target = path.resolve(skinRoot, EMOJI_MAPPING_FILE);
  if (path.dirname(target) !== path.resolve(skinRoot)) return null;
  return target;
}

function getEmojiMapping() {
  const file = emojiMappingPath();
  if (!file) return {};
  try {
    const frames = JSON.parse(fs.readFileSync(file, 'utf8')).frames;
    const clean = {};
    for (const state of SKIN_STATES) {
      const v = frames && frames[state];
      if (typeof v === 'string' && v.length <= 12 && EMOJI_CHAR_RE.test(v)) clean[state] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

function setEmojiMapping(frames) {
  const clean = {};
  for (const state of SKIN_STATES) {
    const v = frames && frames[state];
    if (typeof v === 'string' && v.length <= 12 && EMOJI_CHAR_RE.test(v)) clean[state] = v;
  }
  if (!clean.idle) throw new Error('emoji 皮肤必须分配默认表情');
  const file = emojiMappingPath();
  if (!file) throw new Error('emoji 映射文件路径非法');
  fs.mkdirSync(skinRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ frames: clean }, null, 2));
  return clean;
}

// 列出可选皮肤：有图片的皮肤目录都算（未完成分配的也列出，便于切回去挑选）
function listSkins() {
  try {
    return fs
      .readdirSync(skinRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => resolveSkin(name).type === 'image' || listSkinImages(name).length > 0);
  } catch {
    return [];
  }
}

// 列出皮肤目录里的全部图片（picker 用），相对路径
function listSkinImages(name) {
  if (!isSafeName(name)) return [];
  const dir = insideRoot(skinRoot, name);
  if (!dir) return [];
  const out = [];
  const walk = (sub) => {
    let entries = [];
    try {
      entries = fs.readdirSync(sub, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(sub, e.name);
      if (!insideRoot(dir, full)) continue;
      if (e.isDirectory()) {
        walk(full);
      } else if (isImageFile(e.name)) {
        out.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return out.sort();
}

// 从拖入/菜单选择的路径收集图片文件：目录递归（排序保编号稳定），文件按扩展名判断。
// 菜单「导入」与拖拽导入共用；返回绝对路径列表
function collectImageFiles(paths) {
  const out = [];
  const walkDir = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkDir(full);
      else if (isImageFile(e.name)) out.push(full);
    }
  };
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string') continue;
    let st = null;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkDir(p);
    else if (st.isFile() && isImageFile(p)) out.push(p);
  }
  return out;
}

// 生成唯一皮肤目录（按白名单清理名称，重名自动加后缀），返回绝对路径
function uniqueSkinDir(baseRaw) {
  const base = String(baseRaw || 'skin')
    .replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'skin';
  let candidate = insideRoot(skinRoot, base);
  if (!candidate) throw new Error('皮肤目录名非法');
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = insideRoot(skinRoot, `${base}-${n++}`);
    if (!candidate) throw new Error('皮肤目录名非法');
  }
  return candidate;
}

// 导入 .eif：签名 carving 抽取全部内嵌图片到 assets/skins/<名称>/
function importEif(eifPath) {
  if (typeof eifPath !== 'string' || path.extname(eifPath).toLowerCase() !== '.eif') {
    throw new Error('请选择 .eif 表情包文件');
  }
  const buf = fs.readFileSync(eifPath);
  const candidate = uniqueSkinDir(path.basename(eifPath, path.extname(eifPath)));
  fs.mkdirSync(candidate, { recursive: true });

  const starts = [];
  for (const sig of [PNG_SIG, ...GIF_SIGS]) {
    let pos = 0;
    while ((pos = buf.indexOf(sig, pos)) !== -1) {
      starts.push({ isPng: sig === PNG_SIG, pos });
      pos += sig.length;
    }
  }
  starts.sort((a, b) => a.pos - b.pos);

  const images = [];
  for (let i = 0; i < starts.length; i++) {
    const { isPng, pos } = starts[i];
    const nextPos = i + 1 < starts.length ? starts[i + 1].pos : buf.length;
    if (isPng) {
      const end = buf.indexOf(PNG_END, pos);
      if (end !== -1 && end < nextPos + 64) {
        images.push({ type: 'png', buf: buf.slice(pos, end + 8) });
      }
    } else {
      // GIF：trailer 为 00 3B，取下一张图起点之前最后一个（内部数据可能含 00 3B）
      const seg = buf.slice(pos, nextPos);
      for (let j = seg.length - 2; j >= 100; j--) {
        if (seg[j] === 0x00 && seg[j + 1] === 0x3b) {
          images.push({ type: 'gif', buf: seg.slice(0, j + 2) });
          break;
        }
      }
    }
  }

  if (!images.length) {
    fs.rmdirSync(candidate);
    throw new Error('未能从该文件中提取到图片（不支持的格式）');
  }
  const files = [];
  for (let i = 0; i < images.length; i++) {
    const fileRel = `sticker_${String(i + 1).padStart(3, '0')}.${images[i].type}`;
    const fileAbs = insideRoot(candidate, fileRel);
    if (!fileAbs) throw new Error('写入路径非法');
    fs.writeFileSync(fileAbs, images[i].buf);
    files.push(fileRel);
  }
  return { name: path.basename(candidate), files };
}

// ===== 压缩包导入：拖拽导入用；解出全部内嵌图片建皮肤 =====
// 格式门槛按扩展名（防止把任意 exe/msi 都拿来试解），但识别交给解压器按内容自动判型：
// zip/cbz 走 adm-zip，其余（7z/rar/tar 系）走 7z-wasm——其 7zz 解码表含 Rar/Tar/GZip/XZ/BZip2 等，
// 无需外部程序（rar 仅解压，unRAR 许可本就只允许免费解包）

const ARCHIVE_EXTS = ['.zip', '.7z', '.rar', '.cbz', '.cbr', '.tar', '.tgz', '.tar.gz', '.tar.bz2', '.tar.xz'];
// 单条目解压上限：表情图不可能这么大，异常大文件（误拖的安装包等）直接跳过，兼防 zip 炸弹
const ARCHIVE_MAX_ENTRY = 64 * 1024 * 1024;

// 匹配压缩包扩展名：支持 .tar.gz 这类双扩展名（extname 只给 .gz，不能直接用）；命中返回该扩展名
function matchArchive(name) {
  if (typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  return ARCHIVE_EXTS.find((ext) => lower.endsWith(ext)) || null;
}

// 按魔数识别图片类型：压缩包内文件名常是 GBK/任意编码（乱码），扩展名不可信，
// 一律以内容为准识别并统一重命名 sticker_NNN.ext
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (GIF_SIGS.some((sig) => buf.subarray(0, 6).equals(sig))) return 'gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  // AVIF：ISOBMFF 容器，偏移 4 起 'ftyp'、偏移 8 起主要品牌（avif=静图 / avis=动图）。
  // mp4 同为 ftyp（品牌 isom 等）、HEIF 相机图是 heic/heix/mif1——Chromium 解不了后者，
  // 只认 avif/avis 两个品牌，避免收进解码不了的文件建成满屏破图的皮肤
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

function writeStickers(dir, images) {
  const files = [];
  images.forEach((img, i) => {
    const fileRel = `sticker_${String(i + 1).padStart(3, '0')}.${img.type}`;
    const fileAbs = insideRoot(dir, fileRel);
    if (!fileAbs) throw new Error('写入路径非法');
    fs.writeFileSync(fileAbs, img.buf);
    files.push(fileRel);
  });
  return files;
}

// zip：adm-zip 纯 JS 内存解包（表情包体量小，无需落盘中转）。
// 条目按包内路径排序后编号——getEntries 不保证顺序，排序让 sticker_NNN 跨导入稳定
function importZip(zipPath) {
  const AdmZip = require('adm-zip'); // 惰性加载：不导入压缩包就不付出模块加载成本
  const entries = new AdmZip(zipPath)
    .getEntries()
    .slice()
    .sort((a, b) => (a.entryName < b.entryName ? -1 : a.entryName > b.entryName ? 1 : 0));
  const images = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.header && entry.header.size > ARCHIVE_MAX_ENTRY) continue;
    let buf;
    try {
      buf = entry.getData(); // 加密/损坏条目跳过，不毁掉整个包
    } catch {
      continue;
    }
    const type = sniffImage(buf);
    if (type) images.push({ type, buf });
  }
  return images;
}

// 7z-wasm（7-Zip 24.09 编译成 WASM，无外部二进制）解到临时目录再按魔数收集。
// 7zz 按内容自动判型，不依赖扩展名——rar/tar 系同一条通路。
// 每次导入建独立实例——callMain 的运行时状态不保证可复入，进程级偶发导入不差这点加载时间
async function import7z(archivePath) {
  const os = require('os');
  const SevenZip = require('7z-wasm');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-7z-'));
  try {
    const packName = path.basename(archivePath); // 保留原名：内容判型与名字无关，但同名少一层意外
    fs.copyFileSync(archivePath, path.join(tmp, packName));
    const seven = await SevenZip({ print: () => {}, printErr: () => {} });
    seven.FS.mkdir('/work');
    seven.FS.mount(seven.NODEFS, { root: tmp }, '/work');
    seven.FS.chdir('/work');
    seven.callMain(['x', packName, '-oout', '-y']); // -oout 写 /work/out = tmp/out（真实 fs 可读）
    // 复合流二段解包：7zz 的 x 只剥最外层（tar.gz → 得到内层 tar 文件，不解到底）。
    // 第一层解出「恰好一个 tar 文件」（偏移 257 的 ustar 魔数）时再解一层；封顶两层
    let outDir = path.join(tmp, 'out');
    const innerFiles = fs
      .readdirSync(outDir)
      .map((f) => path.join(outDir, f))
      .filter((f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      });
    if (innerFiles.length === 1) {
      try {
        const only = fs.readFileSync(innerFiles[0]);
        if (only.length > 262 && only.subarray(257, 262).toString('ascii') === 'ustar') {
          fs.copyFileSync(innerFiles[0], path.join(tmp, 'inner.tar'));
          seven.callMain(['x', 'inner.tar', '-oout2', '-y']);
          outDir = path.join(tmp, 'out2');
        }
      } catch {
        // 内层再解失败就按第一层结果走（收集不到图会统一报错）
      }
    }
    const images = [];
    const walk = (sub) => {
      let entries = [];
      try {
        entries = fs.readdirSync(sub, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // 编号确定
      for (const e of entries) {
        const full = path.join(sub, e.name);
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        try {
          if (fs.statSync(full).size > ARCHIVE_MAX_ENTRY) continue;
          const buf = fs.readFileSync(full);
          const type = sniffImage(buf);
          if (type) images.push({ type, buf });
        } catch {
          continue;
        }
      }
    };
    walk(outDir);
    return images;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 导入压缩包：无图则抛错且不留空目录（目录在确认有图后才创建）
async function importArchive(archivePath) {
  const ext = matchArchive(archivePath);
  if (!ext) throw new Error('请选择压缩包文件（zip/7z/rar/tar 系）');
  const base = path.basename(archivePath).slice(0, -ext.length) || 'archive';
  const candidate = uniqueSkinDir(base);
  const images = ext === '.zip' || ext === '.cbz' ? importZip(archivePath) : await import7z(archivePath);
  if (!images.length) {
    throw new Error('未能从该压缩包中提取到图片（格式不支持，或包里没有 PNG/GIF/JPG/WebP/AVIF）');
  }
  fs.mkdirSync(candidate, { recursive: true });
  const files = writeStickers(candidate, images);
  return { name: path.basename(candidate), files };
}

module.exports = {
  getSkinRoot,
  setSkinRoot,
  SKIN_STATES,
  IMAGE_EXTS,
  ARCHIVE_EXTS,
  matchArchive,
  collectImageFiles,
  resolveSkin,
  listSkins,
  listSkinImages,
  getEmojiMapping,
  setEmojiMapping,
  importEif,
  importArchive,
  uniqueSkinDir,
};
