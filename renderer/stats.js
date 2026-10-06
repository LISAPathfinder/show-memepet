// F7 统计面板渲染：打开时向主进程拉一次汇总数据，之后每 5 秒自动刷新（与落盘周期一致）
// 口径：指标卡与趋势 = 键盘 + 鼠标 + 手柄 总数据；Top10 混合所有输入排名
function render(data) {
  document.getElementById('stat-today').textContent = data.today.toLocaleString();
  document.getElementById('stat-last7').textContent = data.last7.toLocaleString();
  document.getElementById('stat-all').textContent = data.all.toLocaleString();

  const m = data.mouseToday;
  const mouseTotal = m.left + m.right + m.middle;
  document.getElementById('mouse-summary').innerHTML = `
    <div class="mseg">左键<span class="mnum">${m.left}</span></div>
    <div class="mseg">右键<span class="mnum">${m.right}</span></div>
    <div class="mseg">中键<span class="mnum">${m.middle}</span></div>
    <div class="mseg">今日合计<span class="mnum">${mouseTotal}</span></div>`;

  // 手柄区空态文案区分四种状态：界面没数据时用户能看出卡在哪一环
  const GP_STATUS_TEXT = {
    unavailable: '手柄组件加载失败（XInput 不可用）',
    connected: '手柄已连接，还没按过键',
    none: '未检测到手柄连接（需 XInput 协议，Steam Input 映射的可用）',
    'not-started': '手柄轮询未启动',
  };
  renderBars(
    document.getElementById('gamepad'),
    data.gamepadToday,
    (data.gamepadStatus && GP_STATUS_TEXT[data.gamepadStatus]) || '今天没用过手柄'
  );
  renderTop10(data.top10);
  renderTrend(data.last14);
}

function load() {
  window.petAPI.getStats().then(render);
}

load();
setInterval(load, 5000);

// 横向条形组：条形长度与数值成比例（宽度经 CSSOM 赋值，CSP 不拦）
function renderBars(box, entries, emptyText) {
  if (!entries || !entries.length) {
    box.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  const max = entries[0].count || 1;
  box.innerHTML = '';
  for (const { key, count } of entries) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'bar-key';
    label.title = key;
    label.textContent = key;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = (count / max) * 100 + '%';
    track.appendChild(fill);
    const num = document.createElement('span');
    num.className = 'bar-count';
    num.textContent = count;
    row.append(label, track, num);
    box.appendChild(row);
  }
}

// Top10 横向条形图：CSS 宽度按占比
function renderTop10(top10) {
  renderBars(document.getElementById('top10'), top10, '今天还没敲过键盘');
}

// ===== 最近 14 天：平滑面积图（Catmull-Rom 样条 → 三次贝塞尔 + 线下渐变填充） =====
// 高度/边距固定，宽度按容器实际像素取（viewBox=像素 1:1）。此前 viewBox 448 固定宽 +
// preserveAspectRatio="none" 把整张图随窗口横向拉伸，字号/线宽跟着窗口变、与面板其余
// 文字比例脱节——改为真实像素出图后文字就是 CSS 字号，悬浮取点也全走像素坐标。
const TREND_H = 150;
const TREND_PAD_L = 46; // 左侧留纵轴数值标签位（最宽 "9999"≈24px，>1w 缩写成 "1.8w" 更窄）
const TREND_PAD_R = 30;
// 底部留出刻度线 + 日期标签的空当；顶部留出 max 网格线及其数值标签
const TREND_TOP = 20;
const TREND_BOTTOM = TREND_H - 34;
const TREND_MIN_W = 320; // 容器还没布局出来（clientWidth=0）时的兜底宽，5 秒刷新/resize 会纠正

let trendData = null; // 最近一次的数据：resize 时按新宽度立即重画
let trendPts = []; // 最近一次渲染的数据点：悬浮预览跨 5 秒整页重画取它
let trendHoverXY = null; // 指针最近一次落在图上的事件（重画后恢复悬浮状态用）

function renderTrend(last14) {
  trendData = last14;
  const box = document.getElementById('trend');
  const W = Math.max(box.clientWidth || 0, TREND_MIN_W);
  const max = Math.max(...last14.map((d) => d.total), 1);

  const pts = last14.map((d, i) => {
    const x = Math.round(TREND_PAD_L + (i / (last14.length - 1)) * (W - TREND_PAD_L - TREND_PAD_R));
    const y = Math.round(TREND_BOTTOM - (d.total / max) * (TREND_BOTTOM - TREND_TOP));
    return { x, y, ...d };
  });
  trendPts = pts;

  // Catmull-Rom（均匀参数化，标准系数 /6）转三次贝塞尔：比中点法平滑、无折角
  let path = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = Math.round(p1.x + (p2.x - p0.x) / 6);
    const c1y = Math.round(p1.y + (p2.y - p0.y) / 6);
    const c2x = Math.round(p2.x - (p3.x - p1.x) / 6);
    const c2y = Math.round(p2.y - (p3.y - p1.y) / 6);
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }

  // 面积 = 曲线沿到图底闭合；渐变色由样式表控制（CSP 拦内联样式）
  const area = `${path} L ${pts[pts.length - 1].x} ${TREND_H - 4} L ${pts[0].x} ${TREND_H - 4} Z`;

  const last = pts[pts.length - 1]; // 尾端圆点还要用

  // 纵轴：max 线 + 半程线两条横向网格，数值标签放绘图区左外侧（在图内会重蹈起止点计数压曲线的覆辙）；≥1w 缩写 x.xw 控宽
  const halfY = Math.round((TREND_TOP + TREND_BOTTOM) / 2);
  const fmtAxis = (n) => (n >= 10000 ? (n / 10000).toFixed(n % 10000 === 0 ? 0 : 1) + 'w' : String(n));
  const grid = `
    <line class="trend-grid" x1="${TREND_PAD_L}" y1="${TREND_TOP}" x2="${W - TREND_PAD_R}" y2="${TREND_TOP}" />
    <text class="axis-y" x="${TREND_PAD_L - 6}" y="${TREND_TOP + 4}" text-anchor="end">${fmtAxis(max)}</text>
    <line class="trend-grid" x1="${TREND_PAD_L}" y1="${halfY}" x2="${W - TREND_PAD_R}" y2="${halfY}" />
    <text class="axis-y" x="${TREND_PAD_L - 6}" y="${halfY + 4}" text-anchor="end">${fmtAxis(Math.round(max / 2))}</text>`;

  // 逐日刻度 + 日期标签：窄图（相邻点间距 < 标签宽约 34px）奇偶错排两行，宽图单行即可
  const stagger = ((W - TREND_PAD_L - TREND_PAD_R) / (pts.length - 1)) < 34;
  const axis = pts
    .map((p, i) => {
      const tick = `<line class="axis-tick" x1="${p.x}" y1="${TREND_BOTTOM + 4}" x2="${p.x}" y2="${TREND_BOTTOM + 8}" />`;
      const ly = stagger ? (i % 2 ? TREND_H - 4 : TREND_H - 16) : TREND_H - 10;
      return `${tick}<text class="axis-label" x="${p.x}" y="${ly}" text-anchor="middle">${p.date.slice(5)}</text>`;
    })
    .join('');

  const svg = `
    <svg viewBox="0 0 ${W} ${TREND_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="trend-stop-a" />
          <stop offset="1" class="trend-stop-b" />
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" class="trend-area" />
      <path d="${path}" class="trend-line" />
      <line class="trend-guide hidden" x1="0" y1="${TREND_TOP}" x2="0" y2="${TREND_BOTTOM}" />
      <circle class="trend-hover-dot hidden" cx="0" cy="0" r="4" />
      <circle cx="${last.x}" cy="${last.y}" r="3.5" class="trend-dot">
        <title>${last.date}: ${last.total}</title>
      </circle>
      ${axis}
    </svg>
    <div class="trend-tip hidden"></div>`;
  box.innerHTML = svg;

  // 5 秒重画会连 tooltip 一起重建：指针还停在图上就把悬浮状态原样恢复，别让用户读数读到一半闪没
  if (trendHoverXY) applyTrendHover(trendHoverXY);
}

// ===== 趋势图悬浮预览：指针位置 → 最近日期点，显示竖直虚线 + 高亮圆点 +「MM-DD · 总数」 =====
// 监听挂容器而不是 svg：5 秒重画只换 innerHTML，容器与监听器常驻
const trendBox = document.getElementById('trend');

function applyTrendHover(e) {
  if (!trendPts.length) return;
  const svg = trendBox.querySelector('svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  if (trendPts.length < 2) return;
  // viewBox 与像素 1:1，指针 x 直接是图上坐标；点位等距，用相邻点差当步长吸附最近日期
  const vx = e.clientX - rect.left;
  const step = trendPts[1].x - trendPts[0].x;
  const i = Math.max(0, Math.min(trendPts.length - 1, Math.round((vx - trendPts[0].x) / step)));
  const p = trendPts[i];

  const guide = trendBox.querySelector('.trend-guide');
  if (guide) {
    guide.setAttribute('x1', p.x);
    guide.setAttribute('x2', p.x);
    guide.classList.remove('hidden');
  }
  const dot = trendBox.querySelector('.trend-hover-dot');
  if (dot) {
    dot.setAttribute('cx', p.x);
    dot.setAttribute('cy', p.y);
    dot.classList.remove('hidden');
  }

  const tip = trendBox.querySelector('.trend-tip');
  if (tip) {
    tip.textContent = `${p.date.slice(5)} · ${p.total.toLocaleString()}`;
    // 图上坐标即像素坐标（svg 与容器同宽同位），tip 以容器为定位基准；
    // 位置必须经 CSSOM 赋值，CSP 拦内联 style 属性
    const px = p.x;
    const py = p.y;
    let left = px - tip.offsetWidth / 2;
    left = Math.max(2, Math.min(left, trendBox.clientWidth - tip.offsetWidth - 2));
    tip.style.left = left + 'px';
    const above = py - tip.offsetHeight - 8;
    tip.style.top = (above >= 0 ? above : py + 10) + 'px'; // 贴顶放不下就翻到点下方
    tip.classList.remove('hidden');
  }
}

trendBox.addEventListener('mousemove', (e) => {
  trendHoverXY = e;
  applyTrendHover(e);
});

trendBox.addEventListener('mouseleave', () => {
  trendHoverXY = null;
  for (const cls of ['.trend-guide', '.trend-hover-dot', '.trend-tip']) {
    const el = trendBox.querySelector(cls);
    if (el) el.classList.add('hidden');
  }
});

// 窗口宽度变化 → 立即按新宽重画（几何是像素 1:1 的，宽变了就得重算）；5 秒周期刷新兜底
window.addEventListener('resize', () => {
  if (trendData) renderTrend(trendData);
});
