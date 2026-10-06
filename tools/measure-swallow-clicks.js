// 被吞点击与穿透延迟的量化工具（票 11-J 的读数源；只读日志，不改任何状态）
//
// 为什么它在仓库里：票 11-J 的三段读数最初是一次性脚本算的，**跑完就删了**——
// 那等于把数字写成不可复现的口述（与"交付物要落盘"同一条纪律，PITFALLS §76/§77）。
// 本件把同一套算法固化下来，改判据前后都用它出数，才允许说"变好了"。
//
// 用法：node tools/measure-swallow-clicks.js [日志路径] [起始时间 ISO] [截止时间 ISO]
//   不带参数 = 按 identity.LOG_CANDIDATES 读开发态 data/ 下的日志
//   读实机装机版：把它的 DATA_DIR 下同名日志路径作为参数传进来（路径里别在本文件内写字面量——
//   `verify-identity` 会扫 tools/ 下的裸日志名，写了必红；本件首跑就被它拦下过一次）
//   第二个参数按版本段切：这本日志跨了 1.0.58→1.0.61 多个版本，全量混算出来的数字不能当"改善幅度"
//   引用（跨口径比大小是本仓库被反复判过的一类错）。装机时刻取装机 exe 的 mtime。
// 退出码：0 = 取到足量事件并给出统计；1 = 解析出的状态行或点击行为零（**正则/日志格式坏了也报绿是最危险的**）；
//         3 = 日志文件不存在（前置不满足，不是"没有吞点击"）。
const fs = require('fs');
const path = require('path');
const { LOG_CANDIDATES } = require('../identity');

const argPath = process.argv[2];
const argSince = process.argv[3];
const argUntil = process.argv[4];
const SINCE = argSince ? Date.parse(argSince) : NaN;
const UNTIL = argUntil ? Date.parse(argUntil) : NaN;
if ((argSince && !Number.isFinite(SINCE)) || (argUntil && !Number.isFinite(UNTIL))) {
  console.error('前置不满足（exit 3）：起始/截止时间无法解析（要 ISO 形态，如 2026-10-05T08:26Z）');
  process.exit(3);
}
let LOG = argPath;
if (!LOG) {
  LOG = null;
  for (const name of LOG_CANDIDATES) {
    const p = path.join(__dirname, '..', 'data', name);
    try { if (fs.statSync(p).isFile()) { LOG = p; break; } } catch {}
  }
  if (!LOG) LOG = path.join(__dirname, '..', 'data', LOG_CANDIDATES[0]);
}
if (!fs.existsSync(LOG)) {
  console.error(`前置不满足（exit 3）：日志文件不存在 ${LOG}\n  开发态跑过桌宠才有这本；读实机请把路径作为参数传进来。`);
  process.exit(3);
}

const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim());
let nSkippedOutside = 0;
if (Number.isFinite(SINCE) || Number.isFinite(UNTIL)) {
  const kept = [];
  for (const l of lines) {
    const m = l.match(/^\[([^\]]+)\]/);
    if (!m) { kept.push(l); continue; } // 无时间戳的行（续行）随上一条走
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) { kept.push(l); continue; }
    if (Number.isFinite(SINCE) && t < SINCE) { nSkippedOutside++; continue; }
    if (Number.isFinite(UNTIL) && t >= UNTIL) { nSkippedOutside++; continue; }
    kept.push(l);
  }
  lines.length = 0;
  lines.push(...kept);
}
// 上报盒解析要跨版本：1.0.58 及以前是**单个包围盒**，1.0.59（票 11-J 任务 2）改成**逐盒 `|` 分隔**。
// 只认第一个盒会让"点在齿轮/计数上"被误判成盒外被吞（本件首版就这么错过一次，校验轮 2026-10-05 修）。
const BOX_RE = /(-?[\d]+),(-?[\d]+)\s+([\d]+)x([\d]+)/g;
const ev = [];
let nMultiBoxLines = 0;
for (const l of lines) {
  const m = l.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!m) continue;
  const t = Date.parse(m[1]);
  if (!Number.isFinite(t)) continue;
  const body = m[2];
  let g;
  if ((g = body.match(/^穿透状态 桌宠: (可交互|穿透)（光标在区域内=(是|否)，区域来源=(\S+?)\s+(.+?)）/))) {
    const boxes = [];
    let b;
    BOX_RE.lastIndex = 0;
    while ((b = BOX_RE.exec(g[4]))) boxes.push({ x: +b[1], y: +b[2], w: +b[3], h: +b[4] });
    if (g[4].includes('|')) nMultiBoxLines++;
    ev.push({ t, kind: 'state', state: g[1] === '可交互' ? 'I' : 'P', inside: g[2] === '是', src: g[3], boxes });
  } else if ((g = body.match(/^桌宠收到点击: (\S+) button=(\d+) @(-?[\d.]+),(-?[\d.]+)/))) {
    ev.push({ t, kind: 'click', el: g[1], x: +g[3], y: +g[4] });
  }
}

const nState = ev.filter((e) => e.kind === 'state').length;
const nClick = ev.filter((e) => e.kind === 'click').length;
console.log(`日志 ${LOG}`);
console.log(`解析：状态行 ${nState}（可交互 ${ev.filter((e) => e.kind === 'state' && e.state === 'I').length} / 穿透 ${ev.filter((e) => e.kind === 'state' && e.state === 'P').length}），点击行 ${nClick}`);
if (nState === 0 || nClick === 0) {
  console.error('✗ 正例计数为零：要么日志里没有这类行，要么我的正则与日志格式不匹配——拒绝在这种情况下报"没有吞点击"（§77）。');
  console.error('  自查：' + JSON.stringify(lines.filter((l) => /穿透状态/.test(l)).slice(-2)));
  process.exit(1);
}

// 正例对照（跨版本）：日志里出现过逐盒格式，但解析出的 boxes 全只有一个 → 我的正则又落后一个版本了
const nBoxTotal = ev.reduce((s, e) => s + (e.kind === 'state' ? e.boxes.length : 0), 0);
if (nMultiBoxLines > 0 && nBoxTotal === nState) {
  console.error(`✗ 日志里有 ${nMultiBoxLines} 行逐盒格式，但每行只解析出 1 个盒 = 解析没跟上格式，拒绝在此之上出统计`);
  process.exit(1);
}
console.log(`  正例：逐盒格式行 ${nMultiBoxLines}，解析出盒子共 ${nBoxTotal} 个`);

// 「被吞」的口径要跨版本可比：主进程的命中判定是「任一小盒外扩 JITTER_PAD」。
// 旧版 10px、1.0.59 起 1px——这里统一按**外扩 10px**（对新版更宽松）算"真的在盒外"，
// 宁可少报不误报：报出来的每一条都是任何版本实现下都该落到下层的点击。
const RING = 10;
const distToBoxes = (boxes, x, y) => {
  let best = Infinity;
  for (const b of boxes) {
    const dx = Math.max(b.x - RING - x, x - (b.x + b.w + RING), 0);
    const dy = Math.max(b.y - RING - y, y - (b.y + b.h + RING), 0);
    best = Math.min(best, Math.max(dx, dy));
  }
  return best;
};

let cur = null;
let lastInsideYesAt = null;
const hold = [];
const swallowed = [];
for (const e of ev) {
  if (e.kind === 'state') {
    if (e.inside) lastInsideYesAt = e.t;
    if (e.state === 'P' && lastInsideYesAt !== null) { hold.push(e.t - lastInsideYesAt); lastInsideYesAt = null; }
    if (e.state === 'I' && e.src.indexOf('渲染端上报') === 0 && e.boxes.length) cur = e;
    continue;
  }
  if (e.kind !== 'click' || !cur || cur.state !== 'I') continue;
  const dragBox = cur.boxes.some((b) => b.w >= 600); // 拖拽/玻璃期上报整窗，属设计内
  const out = distToBoxes(cur.boxes, e.x, e.y);
  if (out > 0 && !dragBox) {
    swallowed.push({
      t: e.t, el: e.el, x: e.x, y: e.y, boxes: cur.boxes.map((b) => `${b.x},${b.y} ${b.w}x${b.h}`).join('|'),
      out, snapAge: e.t - cur.t, sinceInsideYes: lastInsideYesAt === null ? null : e.t - lastInsideYesAt,
    });
  }
}

// 快照年龄闸门（校验轮 2026-10-05 加）：主进程只在**穿透状态翻动**那一拍落状态行，
// 行尾那串盒是"上一次翻动时主进程手里的盒"。指针一直在同一侧、盒却在中间变过（元素显隐、
// 表情切换改尺寸）→ 不会有新行 → 拿这串旧盒去比这次点击，就会把**日志新鲜度**读成**上报陈旧**。
// 本件前两轮各被这类假阳性骗过一次（4 次 / 6 次"盒陈旧型"）。只有快照足够新（≤SNAPSHOT_MAX_MS，
// 覆盖 120ms 轮询 + 一帧上报）的样本才允许进归因统计，其余单列、不计入"被吞"。
const SNAPSHOT_MAX_MS = 500;
const cls = swallowed.filter((s) => s.snapAge <= SNAPSHOT_MAX_MS);
const staleSnap = swallowed.filter((s) => s.snapAge > SNAPSHOT_MAX_MS);

const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] : 0; };
console.log(`\n「离开辖区 → 真转穿透」延迟(ms)：样本 ${hold.length}  p50=${pct(hold, 0.5)} p90=${pct(hold, 0.9)} p99=${pct(hold, 0.99)} max=${hold.length ? Math.max(...hold) : 0}`);
console.log(`\n被吞点击候选（状态=可交互、指针在所有上报盒外扩 ${RING}px 之外、非拖拽期）：${swallowed.length} 次`);
console.log(`  其中快照年龄 ≤${SNAPSHOT_MAX_MS}ms 的可判定样本：${cls.length} 次；快照过旧（>${SNAPSHOT_MAX_MS}ms，不能归因）：${staleSnap.length} 次`);
const outDist = {};
const byKind = { 空隙或余量型: 0, 盒陈旧型: 0 };
for (const s of cls) {
  const k = s.out <= 8 ? '≤8px' : s.out <= 16 ? '9~16px' : s.out <= 40 ? '17~40px' : '>40px';
  outDist[k] = (outDist[k] || 0) + 1;
  // 归因（票 11-J 验收 1b）：点在**具名交互元素**上却仍在所有盒外 = 盒是旧的；
  // 点在 pet-root（容器空白）= 空隙/余量把该区划成了可交互
  if (s.el === 'pet-root') byKind.空隙或余量型++; else byKind.盒陈旧型++;
}
console.log('  可判定样本的离盒距离分布：' + (Object.keys(outDist).length ? Object.entries(outDist).map(([k, v]) => `${k}×${v}`).join('  ') : '（无）'));
console.log('  可判定样本按元素归因：' + JSON.stringify(byKind));
for (const s of cls.slice(-10)) {
  console.log(`  ${new Date(s.t).toISOString().slice(11, 23)}Z → ${s.el} @${s.x},${s.y} 出界=${s.out.toFixed(0)}px 快照年龄=${s.snapAge}ms 盒=${s.boxes}`);
}
if (staleSnap.length) {
  console.log('  快照过旧的候选（只列不判）：' + staleSnap.slice(-6).map((s) => `${new Date(s.t).toISOString().slice(11, 19)}Z ${s.el} 出界${s.out.toFixed(0)}px/年龄${s.snapAge}ms`).join('  '));
}
const heights = {};
for (const e of ev) if (e.kind === 'state' && e.src.indexOf('渲染端上报') === 0) {
  for (const b of e.boxes) if (b.w < 600) {
    const k = `${b.w}x${b.h}`;
    heights[k] = (heights[k] || 0) + 1;
  }
}
console.log('\n上报盒尺寸分布（前 8，逐盒计）：' + Object.entries(heights).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join('  '));
console.log('\n注：1.0.61（票 11-L）起上报节奏 = rAF 每帧驱动 + 3px 量化比对，1s 定时器降为兜底；');
console.log('    1.0.59 起上报是逐盒数组，陈旧盒只影响它自己那个小盒。"点在具名元素上却盒外"仍会出现——');
console.log('    但**必须先过上面的快照年龄闸门**才允许归因到"盒陈旧"，否则那是日志新鲜度（只在翻动时落行）而非上报新鲜度。');
if (Number.isFinite(SINCE) || Number.isFinite(UNTIL)) console.log(`    本次统计窗口 ${(argSince || '日志起点')} → ${(argUntil || '日志末尾')}，窗外跳过 ${nSkippedOutside} 行（版本段切分，别和全量混着比大小）。`);
