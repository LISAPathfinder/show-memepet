// 出包闸门装置（票 11-U）：一条命令跑完 CI 强制层的全部纯逻辑件。
// 为什么要有它：ci.yml 那批件的「强制」靠 GitHub Actions、只在 push 后跑，本仓无 remote ⇒
// 那层从未被机器执行过一次（1.0.72 带着一条 CI 红出包并装机，见票 11-U / PITFALLS §91）。
// 本装置把「没跑」变成「跑不动才会漏」。
//
// 行为契约：
// - 件清单从 .github/workflows/ci.yml 动态解析（正则抓 `run: node tools/xxx.js`），一件都不手抄——
//   手抄清单会在件数变化时漂移，那正是本轮要防的那类错；解析不到任何件 = 脚本异常，闸门不许放行。
// - 逐件顺序跑（一件跑完收集齐 rc/stdout/stderr 再跑下一件，等价于逐件 spawnSync 的语义），
//   纯 node、零依赖、不起实例。**实现用异步 spawn 而非 spawnSync**：2026-10-06 实测 WorkBuddy
//   会话环境拦「node 为父的同步进程创建」（spawnSync/execSync 对任何 exe 一律 EBUSY，
//   异步 spawn 正常，python subprocess 也正常）——异步逐件 await 保住同一契约，在 GitHub Actions
//   与用户本机终端上两种写法行为一致。字节计数用 Buffer.byteLength（缓冲区实长），
//   **不许用 String.length**——中文输出会虚低近 2 倍。
// - 末尾一行 `PASS n/N`；退出码取最坏值：任一件非 0/3（断言失败、件自身崩、spawn 失败）→ 1；
//   否则任一件 3 → 3 并在 stderr 说明「前置不满足，不算通过」；全 0 → 0。
//   （1 比 3 更坏：断言失败说明代码错了要先修；3 只是环境没备好。两类都存在时报 1 并点名全部。）
// - 本件自身出错 → stderr「脚本异常：<原因>」+ 退出 1（与断言失败区分，见退出码语义统一约定）。
//   非 0 件的 stderr 首行必须带出来——不许「跳过＝通过」式的静默。
//
// 红法（改装置或 ci.yml 后应重验，读数见票 11-U）：
//   ① 临时翻一条断言 → 装置报非 0 并点名该件；
//   ② 临时从 ci.yml 删一行 run → 件数必须跟着变（证明动态读、不是手抄）；
//   ③ 临时让某件抛异常 → 该件 rc=1 且 stderr 首行被带出。
//
// 用法：node tools/run-ci.js [ci.yml 路径，默认仓库根 .github/workflows/ci.yml]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ciPath = path.resolve(process.argv[2] || path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'));

// 跑一件到自然结束：收集 rc 与 stdout/stderr 原始字节。120s 兜底超时（纯逻辑件毫秒级，卡死=异常）。
function runOne(full) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [full], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => resolve({ code: 1, out, err, note: `spawn 失败：${e.message}` }));
    p.on('close', (code, signal) => resolve({
      code: code === null ? 1 : code,
      out,
      err,
      note: code === null ? `超时(120s)/被信号终止：${signal}` : '',
    }));
  });
}

(async () => {
  const yml = fs.readFileSync(ciPath, 'utf8');
  // 只认步骤行 `run: node tools/xxx.js`（行首空白容忍）；文件顶部注释里的文件名清单不带 run: 前缀，不会误抓
  const items = [...yml.matchAll(/run:\s*node\s+(tools\/[A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]);
  if (!items.length) {
    console.error('脚本异常：ci.yml 里解析不到任何 `run: node tools/xxx.js` 步骤——清单解析失效，闸门不许放行');
    process.exit(1);
  }

  console.log(`从 ${path.relative(path.join(__dirname, '..'), ciPath)} 动态解析到 ${items.length} 件`);
  const firstLine = (buf) => {
    if (!buf || !buf.length) return '';
    const line = Buffer.concat(buf).toString('utf8').split(/\r?\n/).find((l) => l.trim());
    return line ? line.trim() : '';
  };
  // 崩件（未捕获异常）的 stderr 首行是「文件:行号」，错误消息在后面几行——消息行一并带出，省一次翻找
  const errMessage = (buf) => {
    if (!buf || !buf.length) return '';
    const lines = Buffer.concat(buf).toString('utf8').split(/\r?\n/);
    const m = lines.find((l) => /^\s*[\w$]*Error:/.test(l));
    return m ? m.trim() : '';
  };

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const full = path.resolve(__dirname, '..', item);
    let r;
    if (!fs.existsSync(full)) {
      r = { code: 1, out: [], err: [Buffer.from(`件文件不存在: ${full}`)], note: '' };
    } else {
      r = await runOne(full);
    }
    const bytes = Buffer.byteLength(Buffer.concat([...r.out, ...r.err]));
    results.push({ item, rc: r.code, bytes });
    console.log(`${r.code === 0 ? '✓' : '✗'} ${i + 1}/${items.length} ${item} — rc=${r.code} 字节=${bytes}${r.note ? `（${r.note}）` : ''}`);
    if (r.code !== 0) {
      const fl = firstLine(r.err) || firstLine(r.out);
      if (fl) console.log(`    └ 首行: ${fl}`);
      const em = errMessage(r.err);
      if (em && em !== fl) console.log(`    └ 消息: ${em}`);
    }
  }

  const failed = results.filter((x) => x.rc !== 0 && x.rc !== 3);
  const blocked = results.filter((x) => x.rc === 3);
  const pass = results.length - failed.length - blocked.length;
  console.log(`PASS ${pass}/${results.length}`);
  if (failed.length) {
    console.log(`断言失败/件自身崩（先修再出包）：${failed.map((x) => `${x.item}(rc=${x.rc})`).join('、')}`);
  }
  if (blocked.length) {
    console.error(`前置不满足，不算通过：${blocked.map((x) => `${x.item}(rc=3)`).join('、')}——先清占用/补前置，重跑到全绿`);
  }
  process.exit(failed.length ? 1 : blocked.length ? 3 : 0);
})().catch((e) => {
  console.error(`脚本异常：${e && e.message ? e.message : e}`);
  process.exit(1);
});
