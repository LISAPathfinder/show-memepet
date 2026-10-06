// 自绘右键菜单：两级导航（主列表 ↔ 子菜单），字号可调并持久化
const FONT_SIZES = [12, 14, 16, 20]; // 四档不变，UI 上以 A−/A+ 递步切换

let state = null;
let level = null; // 当前子菜单项；null = 主列表

function applyFont() {
  document.documentElement.style.fontSize = state.fontSize + 'px';
}

function updateFontRow() {
  const i = FONT_SIZES.indexOf(state.fontSize);
  document.getElementById('font-value').textContent = state.fontSize + 'px';
  document.getElementById('font-minus').disabled = i <= 0;
  document.getElementById('font-plus').disabled = i === FONT_SIZES.length - 1;
}

function stepFont(delta) {
  if (!state) return;
  const i = FONT_SIZES.indexOf(state.fontSize);
  const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, (i === -1 ? 1 : i) + delta))];
  if (next !== state.fontSize) window.petAPI.menuFontSet(next);
}

function renderItemRow(item) {
  const row = document.createElement('div');
  row.className = 'item';
  const mark = document.createElement('span');
  mark.className = 'mark';
  if (item.type === 'checkbox') mark.textContent = item.checked ? '✓' : '';
  if (item.type === 'radio') mark.textContent = item.checked ? '●' : '';
  row.appendChild(mark);
  const label = document.createElement('span');
  label.textContent = item.label;
  row.appendChild(label);
  if (item.submenu) {
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '›';
    row.appendChild(arrow);
  }
  row.addEventListener('click', () => {
    if (item.submenu) {
      level = item;
      render();
      return;
    }
    window.petAPI.menuAction(item.id);
  });
  return row;
}

function renderItems(items) {
  const box = document.getElementById('items');
  box.innerHTML = '';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      box.appendChild(sep);
      continue;
    }
    box.appendChild(renderItemRow(item));
  }
}

function render() {
  const bar = document.getElementById('level-bar');
  if (level) {
    bar.classList.remove('hidden');
    document.getElementById('level-title').textContent = level.label;
    renderItems(level.submenu);
  } else {
    bar.classList.add('hidden');
    renderItems(state.items);
  }
  applyFont();
  updateFontRow();
  // 通知主进程按内容自适应窗口尺寸（改字号后必须重排，否则内容被遮挡）。
  // panel 是 width:max-content，offsetWidth 就是真实内容宽；以前它是普通块级元素、
  // 宽度恒等于窗口宽，改字号后窗口宽度从不跟着变，20px 档长标签被裁
  const panel = document.getElementById('panel');
  requestAnimationFrame(() => {
    const h = panel.offsetHeight + 12;
    window.petAPI.menuResize(panel.offsetWidth + 12, Math.max(h, 120));
  });
}

function init() {
  window.petAPI.getMenuData().then((d) => {
    state = d;
    render();
  });
  document.getElementById('btn-back').addEventListener('click', () => {
    level = null;
    render();
  });
  document.getElementById('font-minus').addEventListener('click', () => stepFont(-1));
  document.getElementById('font-plus').addEventListener('click', () => stepFont(1));
  window.petAPI.onMenuFont((size) => {
    state.fontSize = size;
    render(); // 重排版并重报窗口尺寸，避免内容被遮挡
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (level) {
        level = null;
        render();
      }
    }
  });
}

init();
