// 挑选表情：状态 ↔ 图片（图片皮肤）或完整 emoji 目录（emoji 皮肤），存 skin.json / emoji-skin.json
const skinName = new URLSearchParams(location.search).get('skin');

const STATE_LABEL = {
  idle: '默认',
  blink: '眨眼',
  happy: '开心',
  sleep: '瞌睡',
  wow: '惊讶',
  remind: '提醒',
  drag: '拖拽',
  move: '移动',
};

let data = null;
let activeState = 'idle';
const mapping = {};

window.petAPI.getPickerData(skinName).then((d) => {
  Object.assign(mapping, d.mapping || {});
  data = d;
  document.getElementById('skin-name').textContent = d.name;
  render();
});

function render() {
  renderStates();
  renderGrid();
  renderSave();
}

function renderStates() {
  const box = document.getElementById('states');
  box.innerHTML = '';
  for (const state of data.states) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (state === activeState ? ' active' : '');
    chip.dataset.state = state;
    const label = document.createElement('span');
    label.textContent = STATE_LABEL[state] || state;
    chip.appendChild(label);
    if (mapping[state]) {
      const tag = document.createElement('span');
      tag.className = 'assigned';
      tag.textContent = '✓';
      tag.title = mapping[state];
      chip.appendChild(tag);
    }
    chip.addEventListener('click', () => {
      activeState = state;
      renderStates();
    });
    box.appendChild(chip);
  }
}

function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  if (data.emoji) {
    // emoji 皮肤：完整 Windows emoji 目录，字符即帧
    const catalog = Array.isArray(window.EMOJI_CATALOG) ? window.EMOJI_CATALOG : [];
    for (const emoji of catalog) {
      const cell = document.createElement('div');
      cell.className = 'emo';
      cell.textContent = emoji;
      cell.title = emoji;
      if (Object.values(mapping).includes(emoji)) cell.classList.add('assigned');
      cell.addEventListener('click', () => {
        mapping[activeState] = emoji;
        // 分配完自动跳到下一个未分配状态
        const next = data.states.find((s) => !mapping[s]);
        activeState = next || activeState;
        render();
      });
      grid.appendChild(cell);
    }
    return;
  }
  for (const { file, url } of data.images) {
    const img = document.createElement('img');
    img.src = url;
    img.title = file;
    img.dataset.file = file;
    if (Object.values(mapping).includes(file)) img.classList.add('assigned');
    img.addEventListener('click', () => {
      mapping[activeState] = file;
      // 分配完自动跳到下一个未分配状态
      const next = data.states.find((s) => !mapping[s]);
      activeState = next || activeState;
      render();
    });
    grid.appendChild(img);
  }
}

function renderSave() {
  const ok = Boolean(mapping.idle);
  document.getElementById('btn-save').disabled = !ok;
  document.getElementById('save-warn').classList.toggle('hidden', ok);
}

document.getElementById('btn-skip').addEventListener('click', () => {
  delete mapping[activeState];
  render();
});

document.getElementById('btn-cancel').addEventListener('click', () => {
  window.petAPI.closePicker();
});

document.getElementById('btn-save').addEventListener('click', () => {
  if (mapping.idle) window.petAPI.saveSkinMapping(skinName, mapping);
});
