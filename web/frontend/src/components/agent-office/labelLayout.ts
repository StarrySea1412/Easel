export interface OfficeLabelAnchor {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
}
export interface OfficeLabelPlacement extends OfficeLabelAnchor { left: number; top: number }
export interface OfficeProtectedArea { left: number; top: number; width: number; height: number }

/** Keep labels close to their 3D anchors without hiding another member's name.
 * Crowded labels remain available in the complete, accessible member list.
 */
export function layoutOfficeLabels(anchors: OfficeLabelAnchor[], width: number, height: number, protectedAreas: OfficeProtectedArea[] = []): OfficeLabelPlacement[] {
  const margin = 10, bottom = 52, gap = 6;
  const placed: OfficeLabelPlacement[] = [];
  const ordered = [...anchors].sort((a, b) => Number(b.selected) - Number(a.selected) || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  for (const anchor of ordered) {
    if (anchor.width + margin * 2 > width || anchor.height + margin + bottom > height) continue;
    const desiredLeft = anchor.x - anchor.width / 2;
    const desiredTop = anchor.y - anchor.height - 10;
    let best: OfficeLabelPlacement | undefined;
    let score = Infinity;
    const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4];
    const candidates = offsets.flatMap(dy => offsets.slice(0, 5).map(dx => ({
      left: Math.max(margin, Math.min(width - anchor.width - margin, desiredLeft + dx * (anchor.width / 2 + gap))),
      top: Math.max(margin, Math.min(height - anchor.height - bottom, desiredTop + dy * (anchor.height + gap))),
    })));
    // Near a crowded desk, the selected label may need a clear edge far from its anchor.
    if (anchor.selected) for (let top = margin; top <= height - anchor.height - bottom; top += anchor.height + gap) {
      candidates.push({ left: margin, top }, { left: width - anchor.width - margin, top });
    }
    for (const { left, top } of candidates) {
      if (protectedAreas.some(area => left < area.left + area.width + gap && left + anchor.width + gap > area.left
        && top < area.top + area.height + gap && top + anchor.height + gap > area.top)) continue;
      if (placed.some(other => left < other.left + other.width + gap && left + anchor.width + gap > other.left
        && top < other.top + other.height + gap && top + anchor.height + gap > other.top)) continue;
      const distance = (left - desiredLeft) ** 2 + (top - desiredTop) ** 2;
      if (distance < score) { best = { ...anchor, left, top }; score = distance; }
    }
    if (best) placed.push(best);
  }
  return placed;
}
