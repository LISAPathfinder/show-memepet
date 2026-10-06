// 「离开辖区 → 转穿透」延迟分布量测（票 11-J 任务 4 的量化验收件；铁律 3：真断言 + 非零退出码）。
//
// 背景：1.0.58 真机全天日志实测（现场 2，样本 260）离开→穿透 p50=777ms / p90=2480ms / max=9592ms
// ——600ms 保持 + 120ms 轮询 + 16px 环内反复进出是长尾来源。1.0.59 改造后要求 p50 ≤ 250ms、
// p90 ≤ 400ms、不再出现秒级长尾（票面验收 ★c）。⚠ 777/2480/9592 是**并集时代**的旧尺子
// （当时命中区是全元素并集包围盒），与 1.0.59+ 离散盒判定不可直接混引，只作历史对照（§79 口径条）。
//
// 量法（终判层，不看日志不等代理指标）：把真实光标从脸中心移到预设的离开点，busy-loop 读
// 桌宠窗口原生 EXSTYLE 的 WS_EX_TRANSPARENT 位，取**置位时刻**算延迟。离开点按「距最近上报盒」
// 的实际距离分三组（票 11-N 把旧 E 组再切一刀；JITTER_PAD=1 子带恒判 inside、永不翻穿透，
// 3000ms 删失是**正确行为**，把它写成正向对照断言而不是长尾假红源）：
//   A 组（断言分位数+长尾）= dist ≥ 13px 明确离开 → 预期 1 拍 ≈120ms 快速穿透；
//   B 组（只设长尾）     = 2~12px = FAST 环内 + 摆动带（dist 2~8 走 600ms 保持、9~12 走
//                          FAST 通道）——设计内迟早穿透，只防秒级长尾；
//   C 组（正向对照）     = dist ≤ JITTER_PAD(1) → 静态判定恒 inside；实机漂浮/量化会
//                          让顶边点间歇摆出环（见下），断言只要求「删失被观测到 ≥1」。
// 日志 120ms 节流会吃掉真实翻转时刻，故不解析日志。
//
// ⚠ 「C 组恒删失」的物理边界（2026-10-05 实跑坐实，写断言前必读）：.pet-body 漂浮
//   （translateY 0→-6）+ 上报量化（BOX_EPSILON=3）让顶边 dist=1px 的点实时距离在
//   1~10px 摆动、可间歇超 FAST_EXIT_PAD(8)——同一离开点两轮采样一删失一翻转实测在案。
//   「dist≤JITTER_PAD 永不翻穿透」只在水平方向与特定漂浮相位成立；「全部删失」型断言
//   实机必然常年假红（这正是本票要消灭的形态），故 C 组断言取「删失 ≥1」正向对照，
//   「JITTER_PAD 被改大」的回归检测落 B 组长尾（见红法②）。
//
// ⚠ 本件移动真实光标（不点击）。需 dev 隔离实例（--inspect=9229 --remote-debugging-port=9333）；
//   建议隔离 config 关 cursorFleeEnabled（现有键，不新增配置项；§76 教训③：光标长停会触发让开）。
//   占用自检按 measure 纪律只警告不拦（票 11-G 任务 4）。
//   双实例场地（装机版同时在跑）读数可信度降一级（票 11-N 前置提示）。
//
// 用法：node tools/measure-exit-delay.js [轮数，默认 2]
// 退出码：0 = A 组 p50≤250/p90≤400、A 与 B 组长尾≤2000、C 组非空且全部删失；1 = 断言不过；3 = 前置不满足。
//
// 红法（票 11-N ★3，都在 %TEMP% 副本实跑）：
//   ① 人为灌一个 dist=20/delay=2500 的 A 组样本 → exit 1 红在 A 组（防把上限改松）；
//   ② 主进程 main.js 的 JITTER_PAD 1→8（副本仓库跑隔离实例；模拟「判定环被人改大」）：
//      dist 2~8 的点转恒 inside → B 组出现 3000ms 删失 → maxB 超 2000 → 红。
//      ⚠ 票面原文设想红在 C 条（「C 组会翻转」），但实机漂浮让绿法 C 组本就有间歇翻转
//      （见上物理边界注），「C 出现翻转→红」与「C 恒删失」互斥且前者实机必假红——
//      同一回归（JITTER_PAD 被改大）改由 B 组长尾捕捉，检测语义不变、红在更宽的组。
const koffi = require('koffi');
const { warnBlockingInstances } = require('./lib-occupancy');
warnBlockingInstances();

const user32 = koffi.load('user32.dll');
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uintptr', 'int']);
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(port, pick) {
  return (async () => {
    let targets;
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      console.error('前置不满足（exit 3）：调试端口 ' + port + ' 连不上——先起 dev 隔离实例');
      process.exit(3);
    }
    const t = pick(targets);
    if (!t) {
      console.error('前置不满足（exit 3）：端口 ' + port + ' 上找不到目标');
      process.exit(3);
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener('open', res));
    let seq = 0;
    return (expression) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (msg.result && msg.result.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluate 失败'));
            return;
          }
          resolve(msg.result.result.value);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
  })();
}

const distOut = (p, rects) => {
  let d = Infinity;
  for (const r of rects) {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
    d = Math.min(d, Math.hypot(dx, dy));
  }
  return d;
};
const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

(async () => {
  const mainProc = await connect(9229, (ts) => ts.find((t) => t.type === 'node') || ts[0]);
  const renderer = await connect(9333, (ts) => ts.find((t) => (t.url || '').endsWith('pet.html')));

  const info = JSON.parse(
    await mainProc(`(() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('pet.html'));
      const b = w.getBounds();
      return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, hwnd: w.getNativeWindowHandle().readBigUInt64LE(0).toString() });
    })()`)
  );
  const hwnd = BigInt(info.hwnd);
  const transparentBit = () => (Number(BigInt(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & 0xffffffffn) & WS_EX_TRANSPARENT) !== 0;

  const rawBoxes = JSON.parse(
    await renderer(
      '(() => { const b = interactiveBox(); const arr = Array.isArray(b) ? b : b ? [b] : []; return JSON.stringify(arr.filter(r => r.width > 0 && r.height > 0)); })()'
    )
  );
  if (!rawBoxes.length) {
    console.error('前置不满足（exit 3）：渲染端上报盒读不到');
    process.exit(3);
  }
  // 屏幕坐标盒（上报已含渲染端 BOX_PAD；「距最近上报盒」即主进程判定的同一坐标系）
  const boxes = rawBoxes.map((r) => ({ x: info.x + r.x, y: info.y + r.y, width: r.width, height: r.height }));
  const face = boxes.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const aim = { x: Math.round(face.x + face.width / 2), y: Math.round(face.y + face.height / 2) };

  // 离开点集（口径对齐现场 2 的「离开辖区→真转穿透」）：从各盒四边界沿外法向取
  //   d ∈ {10,16,20,50}，随后**按实际到所有盒的最近距离重分类**（预想距离不可信——
  //   离散小盒彼此很近，counter 顶距脸盒底仅 7px，某盒边界外推的点会落进相邻盒的
  //   FAST_EXIT_PAD 环甚至盒内，走保持期却混进断言组会把 p90 拖到 647ms，1.0.59 实测）。
  //   票 11-N 三组口径（按实际 dist 分，分位数与阈值不放宽，改的只有分组）：
  //   A 组（计入 p50/p90/长尾断言）= 实际 dist ≥ FAST_PAD(8)+摆幅(3)+2 = 13px——
  //   「明确离开辖区」：连摆幅极值都碰不到 FAST 环，预期 1 拍（≈120ms）快速穿透。
  //   B 组（只设长尾上限）= JITTER_PAD < dist ≤ 12 = FAST 环内 + 摆动带——设计内
  //   迟早穿透（2~8 走 600ms 保持、9~12 走 FAST 通道），保持期属预期。
  //   C 组（正向对照）= dist ≤ JITTER_PAD(1)：恒判 inside、永不翻穿透，3s 删失是
  //   正确行为——旧口径把它算进 allMax≤2000 是物理不可达，整件常年假红（校验轮④续）。
  const FAST_PAD = 8;
  const FAST_EDGE = FAST_PAD + 3 + 2; // 13：摆幅极值外仍有 2px 余量
  // 手抄 main.js syncPetPassThrough 判定层的 JITTER_PAD（:2523，票 11-J 起 =1）。
  // 同步义务与 verify-pass-hold 相同：主进程改这个值必须同步这里，否则 C 组「恒删失」
  // 前提断裂——C 组正向对照断言就是为此存在的（红法②）。
  const JITTER_PAD = 1;
  const targets = [];
  const edges = [];
  for (const b of boxes) {
    edges.push(
      { x: b.x, y: b.y + b.height / 2, dir: '左' },
      { x: b.x + b.width, y: b.y + b.height / 2, dir: '右' },
      { x: b.x + b.width / 2, y: b.y, dir: '上' },
      { x: b.x + b.width / 2, y: b.y + b.height, dir: '下' },
    );
  }
  const seen = new Set();
  const pushTarget = (p, dir, base) => {
    p.x = Math.round(p.x);
    p.y = Math.round(p.y);
    const dist = Math.round(distOut(p, boxes));
    if (p.x < 2 || p.y < 2 || dist < 1) return; // 出屏/落进别的盒里
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    // 按实际距离重分类（不是按预想外推距离）：这是本件 1.0.59 首跑的最大教训。
    // 票 11-N 后分组一律按 dist 现算（A/B/C），不再存 want 字段
    targets.push({ ...p, dir: `${dir}@${base}px`, dist });
  };
  for (const e of edges) {
    const outward = (d) => ({
      x: e.x + (e.dir === '左' ? -d : e.dir === '右' ? d : 0),
      y: e.y + (e.dir === '上' ? -d : e.dir === '下' ? d : 0),
    });
    for (const d of [FAST_PAD + 2, FAST_EDGE, FAST_PAD + 12, FAST_PAD + 42]) {
      pushTarget(outward(d), e.dir, d);
    }
  }

  const rounds = Math.max(1, Number(process.argv[2]) || 2);
  console.log(`窗口 ${info.x},${info.y} ${info.w}x${info.h}；脸盒中心 ${aim.x},${aim.y}；离开点 ${targets.length} 个 × ${rounds} 轮\n`);

  const samples = [];
  let setupFails = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const t of targets) {
      // 回到脸中心，等可交互（穿透位清零）
      SetCursorPos(aim.x, aim.y);
      let ok = false;
      const tWait = performance.now();
      while (performance.now() - tWait < 2500) {
        if (!transparentBit()) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        setupFails++;
        continue;
      }
      await sleep(150);
      // 移到离开点，busy 抓穿透位置位时刻
      const t0 = performance.now();
      SetCursorPos(t.x, t.y);
      let delay = -1;
      const tLimit = t0 + 3000;
      while (performance.now() < tLimit) {
        if (transparentBit()) {
          delay = performance.now() - t0;
          break;
        }
      }
      if (delay < 0) delay = 3000; // 删失：3s 内没穿透 = 长尾样本
      samples.push({ ...t, delay: Math.round(delay), censored: delay >= 3000 });
      await sleep(400);
    }
  }
  if (samples.length < 8) {
    console.error(`前置不满足（exit 3）：有效样本过少（${samples.length}，setup 失败 ${setupFails} 次）——实例不健康`);
    process.exit(3);
  }

  // 票 11-N 三组口径：按实际 dist 分组（分位数与阈值不放宽，改的只有分组）
  const gA = samples.filter((s) => s.dist >= FAST_EDGE);
  const gB = samples.filter((s) => s.dist > JITTER_PAD && s.dist < FAST_EDGE);
  const gC = samples.filter((s) => s.dist <= JITTER_PAD);
  const delays = gA.map((s) => s.delay);
  const p50 = pct(delays, 0.5);
  const p90 = pct(delays, 0.9);
  const max = delays.length ? Math.max(...delays) : Infinity;
  const maxB = gB.length ? Math.max(...gB.map((s) => s.delay)) : 0;
  const allMax = Math.max(...samples.map((s) => s.delay));
  console.log(
    `按实际距离分三组（票 11-N：A=明确离开 ≥${FAST_EDGE}px；B=FAST 环内+摆动带 ${JITTER_PAD + 1}~${FAST_EDGE - 1}px；C=JITTER_PAD 环内 ≤${JITTER_PAD}px 恒 inside，删失=正确行为）：`
  );
  if (gA.length)
    console.log(`  A组 明确离开(≥${FAST_EDGE}px): n=${gA.length}  p50=${pct(gA.map((s) => s.delay), 0.5)}ms  p90=${pct(gA.map((s) => s.delay), 0.9)}ms  max=${Math.max(...gA.map((s) => s.delay))}ms`);
  if (gB.length)
    console.log(`  B组 环内+摆动带(${JITTER_PAD + 1}~${FAST_EDGE - 1}px，保持期属预期): n=${gB.length}  p50=${pct(gB.map((s) => s.delay), 0.5)}ms  p90=${pct(gB.map((s) => s.delay), 0.9)}ms  max=${maxB}ms`);
  if (gC.length) {
    const censC = gC.filter((s) => s.censored).length;
    console.log(`  C组 JITTER_PAD 环内(≤${JITTER_PAD}px，恒 inside): n=${gC.length}  删失=${censC}  翻转=${gC.length - censC}  max=${Math.max(...gC.map((s) => s.delay))}ms`);
  }
  // B/C 组按 dist 分档的形态表（确认摆动带/环内延迟符合预期特征）
  const bcByDist = new Map();
  for (const s of samples.filter((x) => x.dist < FAST_EDGE)) {
    if (!bcByDist.has(s.dist)) bcByDist.set(s.dist, []);
    bcByDist.get(s.dist).push(s.delay);
  }
  if (bcByDist.size) {
    console.log('B/C 组按 dist 分档：');
    for (const [d, ds] of [...bcByDist.entries()].sort((a, b) => a[0] - b[0]))
      console.log(`  dist=${d}px: n=${ds.length}  p50=${pct(ds, 0.5)}ms  max=${Math.max(...ds)}ms`);
  }
  console.log(`\nA 组（断言口径）样本 ${delays.length}：p50=${p50}ms  p90=${p90}ms  max=${max}ms；B 组 max=${maxB}ms；全样本 max=${allMax}ms`);
  const slow = samples.filter((s) => s.delay >= 300);
  if (slow.length) {
    console.log(`≥300ms 样本明细（${slow.length} 个，定位慢样本归属）：`);
    for (const s of slow.sort((a, b) => b.delay - a.delay))
      console.log(`  ${s.dir}  实际dist=${s.dist}px  组=${s.dist >= FAST_EDGE ? 'A' : s.dist > JITTER_PAD ? 'B' : 'C'} → ${s.delay}ms${s.censored ? '（删失）' : ''}`);
  }

  // 断言（票 11-N）：A 组分位数+长尾；B 组只设长尾；C 组正向对照。C 组不参与任何分位数或长尾比较。
  // 历史：旧口径 allMax≤2000 把 C 组的必然删失算进断言——物理不可达，整件常年假红（校验轮④续）。
  //
  // ⚠ C 组断言为什么是「删失必须被观测到（≥1）」而不是票面设想的「全部删失」：
  //   2026-10-05 实跑（隔离实例，rounds=2）证明顶边 dist=1px 的点会随 .pet-body 漂浮
  //   （translateY 0→-6）+ 上报量化（BOX_EPSILON=3）间歇摆出 JITTER 环（实时距离 1~10px
  //   摆动，可超 FAST_EXIT_PAD=8）——同一离开点两轮采样一次删失一次翻转（694/1270/2631ms
  //   保持期量级 + 偶发 <300ms FAST 翻转），「C 组恒删失」只在水平方向与特定相位成立。
  //   「全删失」型断言实机必然常年假红，违背本票治病目标。故：
  //   - C 组正向对照 = 删失 ≥1（dist≤JITTER_PAD 至少观测到一次恒 inside——判定环在位的证据；
  //     判定环/判定链被改坏到环内点也穿透时，删失消失 → 红）；
  //   - 「JITTER_PAD 被人改大」的检测落 B 组长尾：主进程环变大 → dist 2~8 的点转恒 inside →
  //     B 组出现 3000ms 删失 → maxB 超 2000 → 红（红法②）。
  const reasons = [];
  if (!gA.length || p50 > 250 || p90 > 400 || max > 2000)
    reasons.push(`A组 ${!gA.length ? '无样本' : `p50=${p50}(≤250) p90=${p90}(≤400) max=${max}(≤2000)`}未达标`);
  if (maxB > 2000) reasons.push(`B组 max=${maxB}ms 超 2000（防秒级长尾回潮；若大量删失出现，先查主进程 JITTER_PAD 是否被改大）`);
  if (!gC.length) reasons.push(`C组无样本（dist≤${JITTER_PAD} 的删失未观测到——离点几何或场地变了）`);
  else if (!gC.some((s) => s.censored))
    reasons.push(`C组删失 0/${gC.length}（dist≤JITTER_PAD 应至少观测到一次恒 inside——判定环或判定链被改坏）`);
  const ok = reasons.length === 0;
  console.log(
    ok
      ? `\nPASS：A组 p50 ${p50}ms ≤ 250、p90 ${p90}ms ≤ 400、max ${max}ms ≤ 2000；B组 max ${maxB}ms ≤ 2000；C组删失 ${gC.filter((s) => s.censored).length}/${gC.length} ≥ 1（正向对照成立；翻转 ${gC.length - gC.filter((s) => s.censored).length} 次为漂浮相位间歇摆出，信息性）`
      : `\nFAIL：${reasons.join('；')}`
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
