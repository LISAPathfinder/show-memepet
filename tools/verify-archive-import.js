// 验证压缩包导入（1.0.45 拖 zip/7z 建皮肤；1.0.46 扩到 rar/cbz/cbr/tar 系）。
// 可自动化部分（全部走真模块 skins.importArchive，非镜像）：
//   ① 现场构造真实 zip（adm-zip 建包）：子目录/深层嵌套/GBK 乱码风格文件名/假 jpg+webp
//      （仅魔数正确，导入按魔数识别不解析图像数据）/非图片/__MACOSX 垃圾/路径穿越条目
//   ② 现场构造真实 7z / tar / tar.gz（7z-wasm callMain 'a' 建包）再导入
//   ③ .cbz 分派：zip 内容挂 .cbz 名走 adm-zip 通路
//   ④ `7zz i` 编解码清单断言 Rar/Tar/GZip/XZ 在编译产物内（rar 夹具本机造不出——无 WinRAR 且
//      unRAR 许可禁止创建，rar 的真实解包留实机验收，此断言守住「解码器在」这层前提）
//   ⑤ 文件夹收集 collectImageFiles：目录递归+排序、空目录、混合路径合并、坏路径忽略
//   ⑥ 断言：落盘 sticker_NNN 扩展名与内容魔数逐一对应；非图与垃圾跳过；穿越条目
//      不落皮肤目录之外；重名自动 -2；无图包抛错且不留空目录；非压缩包扩展名拒收；
//      导入后临时目录无 pet-7z-* 残留（finally 清理生效）
// 断言不符 exit 1。全程临时目录，不碰真实皮肤根。
const fs = require('fs');
const os = require('os');
const path = require('path');

const skins = require('../skins');
const AdmZip = require('adm-zip');

let passed = 0;
let failed = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)}`);
}

// 标准测试图（内容合法、魔数真实）：1x1 透明 PNG / 1x1 GIF89a（公开的规范字节序列）
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// 假 jpg/webp：仅魔数正确——导入按魔数识别、不解析图像数据，够测识别语义
const FAKE_JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0x11)]);
const FAKE_WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.alloc(4, 0),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(8, 0x22),
]);
const NOT_IMAGE = Buffer.from('这不是图片内容 plain text only', 'utf8');
const MACOSX_JUNK = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x00, 0x02, 0x00]);
// 假 avif/mp4：同为 ISOBMFF 的 ftyp box，差别只在品牌（avif/avis 可收，isom 是 mp4 必须排除）
const FAKE_AVIF = Buffer.concat([
  Buffer.alloc(4, 0),
  Buffer.from('ftyp', 'ascii'),
  Buffer.from('avif', 'ascii'),
  Buffer.alloc(8, 0x33),
]);
const FAKE_MP4 = Buffer.concat([
  Buffer.alloc(4, 0),
  Buffer.from('ftyp', 'ascii'),
  Buffer.from('isom', 'ascii'),
  Buffer.alloc(8, 0x44),
]);

// 各类型魔数在文件内的偏移：webp 的 RIFF/WEBP 头在 0/8 两段，WEBP 标记在偏移 8
const MAGIC = {
  png: { off: 0, bytes: PNG_1PX.subarray(0, 8) },
  gif: { off: 0, bytes: Buffer.from('GIF89a', 'ascii') },
  jpg: { off: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  webp: { off: 8, bytes: Buffer.from('WEBP', 'ascii') },
  avif: { off: 8, bytes: Buffer.from('avif', 'ascii') },
};

// 用 7z-wasm 建真实压缩包（与导入同一条 wasm 链路，不依赖外部 7z.exe）；
// typeFlag 例 '-ttar'（建 tar）；不传则按 archiveName 扩展名自动判型（.tgz → tar+gzip）
async function make7z(workDir, archiveName, typeFlag) {
  const SevenZip = require('7z-wasm');
  const seven = await SevenZip({ print: () => {}, printErr: () => {} });
  seven.FS.mkdir('/work');
  seven.FS.mount(seven.NODEFS, { root: workDir }, '/work');
  seven.FS.chdir('/work');
  seven.callMain(['a', ...(typeFlag ? [typeFlag] : []), archiveName, 'src', '-y']);
  const p = path.join(workDir, archiveName);
  if (!fs.existsSync(p)) throw new Error(`建包失败（无产物）：${archiveName}`);
  return p;
}

// 7zz 支持格式清单（callMain 'i' 的 stdout）：守住「rar/tar 系解码器在编译产物内」这层前提
async function sevenCodecList() {
  const SevenZip = require('7z-wasm');
  const lines = [];
  const seven = await SevenZip({ print: (l) => lines.push(String(l)), printErr: () => {} });
  seven.callMain(['i']);
  return lines.join('\n');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-arch-'));
  const skinRoot = path.join(root, 'skin');
  fs.mkdirSync(skinRoot);
  skins.setSkinRoot(skinRoot);
  const skinDirs = () => fs.readdirSync(skinRoot).sort();

  try {
    // ===== zip：混合内容（4 图 + 3 垃圾 + 1 穿越条目）=====
    const zipPath = path.join(root, 'pack-zip.zip');
    const zip = new AdmZip();
    zip.addFile('sticker-中文目录/图1.png', PNG_1PX);
    zip.addFile('sticker-中文目录/图2.gif', GIF_1PX);
    zip.addFile('深层/嵌套/目录/图3.webp', FAKE_WEBP);
    zip.addFile('动图4.avif', FAKE_AVIF); // avif 品牌识别
    zip.addFile('video.mp4', FAKE_MP4); // mp4 同为 ftyp 容器：品牌 isom，必须排除
    zip.addFile('乱码ÃÂ¸Ã¢Â Â.gif', FAKE_JPG); // GBK 文件名被误读的乱码形态（内容其实是 jpg）
    zip.addFile('zz/../../evil.png', PNG_1PX); // 路径穿越条目：不得逃出皮肤目录
    zip.addFile('说明.txt', NOT_IMAGE);
    zip.addFile('__MACOSX/._图1.png', MACOSX_JUNK);
    zip.writeZip(zipPath);

    console.log('zip 导入（混合内容）');
    const r1 = await skins.importArchive(zipPath);
    check('zip 返回皮肤名', r1.name, 'pack-zip');
    // 编号按包内路径排序（产品侧排序，跨导入稳定）。注意：adm-zip 在 addFile 时就把
    // 'zz/../../evil.png' 规范化为 'evil.png'（所以 png 落在 sticker- 目录之前）；
    // 手工构造的穿越 zip 在导入侧同样安全——写盘只用地生成名 sticker_NNN，不使用包内路径。
    check(
      'zip 图片清单（按内容识别 + 平铺 + 统一命名）',
      r1.files,
      [
        'sticker_001.png',
        'sticker_002.png',
        'sticker_003.gif',
        'sticker_004.jpg',
        'sticker_005.avif',
        'sticker_006.webp',
      ]
    );
    check('mp4（ftyp isom）不入清单', r1.files.some((f) => f.includes('mp4')), false);
    for (const rel of r1.files) {
      const buf = fs.readFileSync(path.join(skinRoot, r1.name, rel));
      const m = MAGIC[path.extname(rel).slice(1)];
      check(
        `落盘魔数 ${rel}`,
        buf.length >= m.off + m.bytes.length && buf.subarray(m.off, m.off + m.bytes.length).equals(m.bytes),
        true
      );
    }
    check('穿越条目未落皮肤目录外', fs.existsSync(path.join(root, 'evil.png')) || fs.existsSync(path.join(root, 'zz')), false);
    check('zip 落盘文件数（垃圾不入目录）', fs.readdirSync(path.join(skinRoot, r1.name)).length, 6);

    // ===== 重名：同包再导一次 → -2 后缀 =====
    console.log('重名递增');
    const r2 = await skins.importArchive(zipPath);
    check('第二次导入皮肤名', r2.name, 'pack-zip-2');

    // ===== zip 无图：抛错且不留目录 =====
    console.log('zip 无图');
    const emptyZip = path.join(root, 'empty-pack.zip');
    const z2 = new AdmZip();
    z2.addFile('a.txt', NOT_IMAGE);
    z2.writeZip(emptyZip);
    let emptyErr = null;
    try {
      await skins.importArchive(emptyZip);
    } catch (e) {
      emptyErr = e.message;
    }
    check('无图包错误信息', emptyErr, '未能从该压缩包中提取到图片（格式不支持，或包里没有 PNG/GIF/JPG/WebP/AVIF）');
    check('无图包不留皮肤目录', skinDirs().includes('empty-pack'), false);

    // ===== 非压缩包扩展名：拒收 =====
    console.log('扩展名拒收');
    const txtPath = path.join(root, 'random.txt');
    fs.writeFileSync(txtPath, NOT_IMAGE);
    let extErr = null;
    try {
      await skins.importArchive(txtPath);
    } catch (e) {
      extErr = e.message;
    }
    check('非压缩包错误信息', extErr, '请选择压缩包文件（zip/7z/rar/tar 系）');

    // ===== 7z：真实建包 → 导入 =====
    console.log('7z 导入（真实 wasm 建包/解包）');
    const work7z = path.join(root, 'work-7z');
    fs.mkdirSync(path.join(work7z, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(work7z, 'src', 'a.png'), PNG_1PX);
    fs.writeFileSync(path.join(work7z, 'src', 'nested', 'b.gif'), GIF_1PX);
    fs.writeFileSync(path.join(work7z, 'src', 'junk.bin'), NOT_IMAGE);
    const p7z = await make7z(work7z, 'pack-7z.7z');
    const r3 = await skins.importArchive(p7z);
    check('7z 返回皮肤名', r3.name, 'pack-7z');
    check('7z 图片清单', r3.files, ['sticker_001.png', 'sticker_002.gif']);
    check(
      '7z 落盘魔数',
      fs.readFileSync(path.join(skinRoot, r3.name, 'sticker_002.gif')).subarray(0, 6).toString('ascii'),
      'GIF89a'
    );

    // ===== .cbz 分派：zip 内容挂 .cbz 名 → 仍走 adm-zip 通路 =====
    console.log('.cbz 分派（zip 内容）');
    const cbzPath = path.join(root, 'pack-cbz.cbz');
    fs.copyFileSync(zipPath, cbzPath);
    const r4 = await skins.importArchive(cbzPath);
    check('.cbz 皮肤名（双扩展名截断正确）', r4.name, 'pack-cbz');
    check('.cbz 图片数', r4.files.length, 6);

    // ===== tar / tar.gz：真实建包 → 导入（7zz 内容判型，与扩展名解耦）=====
    // tar.gz 夹具不能用 7zz 建：wasm 构建创建复合流（a pack.tgz）会抛裸数字异常（C++ 异常
    // 被 emcc 转成 abort，实测 262192）；改用 7zz 建 tar + node zlib.gzipSync 压一层，
    // 恰好也覆盖了「7zz x 对 tar.gz 只剥最外层 → 产品侧二段解包」的语义。
    console.log('tar / tar.gz 导入（真实 wasm 建包/解包）');
    const pTar = await make7z(work7z, 'pack-tar.tar', '-ttar');
    const r5 = await skins.importArchive(pTar);
    check('tar 皮肤名', r5.name, 'pack-tar');
    check('tar 图片清单', r5.files, ['sticker_001.png', 'sticker_002.gif']);
    check(
      'tar 落盘魔数',
      fs.readFileSync(path.join(skinRoot, r5.name, 'sticker_001.png')).subarray(0, 8).equals(PNG_1PX.subarray(0, 8)),
      true
    );

    const zlib = require('zlib');
    const pTgz = path.join(work7z, 'pack-tgz.tgz');
    fs.writeFileSync(pTgz, zlib.gzipSync(fs.readFileSync(pTar)));
    const r6 = await skins.importArchive(pTgz);
    check('tar.gz 皮肤名', r6.name, 'pack-tgz');
    check('tar.gz 图片清单（复合流二段解包）', r6.files, ['sticker_001.png', 'sticker_002.gif']);

    // ===== 文件夹收集（菜单「导入皮肤文件夹」/文件夹拖拽共用 skins.collectImageFiles）=====
    console.log('文件夹收集');
    const fdir = path.join(root, 'folder-src');
    fs.mkdirSync(path.join(fdir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(fdir, 'a.png'), PNG_1PX);
    fs.writeFileSync(path.join(fdir, 'nested', 'b.avif'), FAKE_AVIF);
    fs.writeFileSync(path.join(fdir, 'note.txt'), NOT_IMAGE);
    const col = skins.collectImageFiles([fdir]);
    check('目录递归收集 + 排序（跳过非图，含 avif）', col.map((p) => path.basename(p)), ['a.png', 'b.avif']);
    const emptyDir = path.join(root, 'no-images');
    fs.mkdirSync(emptyDir);
    check('空目录', skins.collectImageFiles([emptyDir]), []);
    const oneFile = path.join(fdir, 'a.png');
    check('混合路径（文件 + 目录）合并收集', skins.collectImageFiles([oneFile, fdir]).length, 3);
    check('不存在的路径忽略', skins.collectImageFiles([path.join(root, 'gone'), null, 42]), []);

    // ===== 7zz 编解码清单：rar/tar 系解码器确实在编译产物内 =====
    console.log('7zz 编解码清单');
    const codecs = await sevenCodecList();
    for (const fmt of ['Rar', 'Tar', 'GZip', 'BZip2', 'XZ']) {
      check(`产物支持解 ${fmt}`, new RegExp(`\\b${fmt}\\b`, 'i').test(codecs), true);
    }

    // ===== 临时目录清理：无 pet-7z-* 残留 =====
    console.log('临时目录清理');
    const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pet-7z-'));
    check('无 7z 临时目录残留', leftovers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n结果: ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('验证件异常:', e);
  process.exit(1);
});
