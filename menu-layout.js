// 菜单弹出位置的纯几何布局（无 Electron 依赖，main.js 与测试脚本共用同一份实现）。
// 优先级：①贴桌宠左右侧翼展开（最高，用户要求）；②锚点右侧 → 放不下翻左侧；
// ③仍与桌宠重叠时垂直推到上/下外侧。全程钳制在所在显示器工作区内，四边不越界。
function clamp(v, lo, hi) {
  return Math.min(Math.max(lo, v), hi);
}

function menuLayout({ anchorX, anchorY, W, H, workArea, petBounds }) {
  const wa = workArea;
  const GAP = 8;
  const clampX = (v) => clamp(v, wa.x, wa.x + wa.width - W);
  const clampY = (v) => clamp(v, wa.y, wa.y + wa.height - H);
  // 垂直：从锚点（齿轮）向下展开，底部溢出上移，钳制工作区
  const y = clampY(anchorY);

  // 优先级①：贴桌宠左右侧翼。「放得下」= 钳制后仍保持与桌宠的贴翼间隙（±1px 容差）
  if (petBounds) {
    const xRight = petBounds.x + petBounds.width + GAP;
    if (clampX(xRight) >= xRight - 1) return { x: xRight, y };
    const xLeft = petBounds.x - W - GAP;
    if (clampX(xLeft) <= xLeft + 1) return { x: xLeft, y };
  }

  // 优先级②：锚点右侧，放不下翻左侧
  let x = clampX(anchorX + GAP);
  if (anchorX + GAP + W > wa.x + wa.width) x = clampX(anchorX - W - GAP);

  // 优先级③：与桌宠重叠 → 垂直推到上/下外侧；上下都放不下保持钳制位置（极端小屏兜底）
  if (petBounds) {
    const overlaps =
      x < petBounds.x + petBounds.width + GAP && x + W > petBounds.x - GAP &&
      y < petBounds.y + petBounds.height + GAP && y + H > petBounds.y - GAP;
    if (overlaps) {
      const yAbove = clampY(petBounds.y - H - GAP);
      const yBelow = clampY(petBounds.y + petBounds.height + GAP);
      if (yAbove <= petBounds.y - H - GAP + 1) return { x, y: yAbove };
      if (yBelow >= petBounds.y + petBounds.height + GAP - 1) return { x, y: yBelow };
    }
  }
  return { x, y };
}

module.exports = { menuLayout };
