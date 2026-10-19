import { bridgeError } from './bridge-protocol.js';

const bad = message => { throw bridgeError('layout-size-required', message, { outcome: 'not-started' }); };
export const finiteSize = n => Number.isFinite(n) && n > 0 && n <= 100000;
export function sizedRoots(cmd) {
  const specs = cmd.specs || (cmd.spec ? [cmd.spec] : []);
  return Array.isArray(specs) && specs.length > 0 && specs.length <= 64 && specs.every(s => s && finiteSize(s.w) && finiteSize(s.h));
}
export function layoutFootprint(cmd, gap = 48) {
  if (!sizedRoots(cmd)) bad('Automatic placement needs a width and height on each top-level frame.');
  const specs = cmd.specs || [cmd.spec];
  if (specs.some(s => (s.x == null) !== (s.y == null))) bad('Supply both x and y, or omit both for automatic arrangement.');
  if (specs.some(s => s.x != null) && specs.some(s => s.x == null)) bad('Use positions for every root, or omit positions for every root.');
  let cursor = 0;
  const placed = specs.map(s => {
    if (s.effects != null && (!Array.isArray(s.effects) || s.effects.length > 32 || s.effects.some(e => !e || typeof e !== 'object'))) bad('Automatic placement accepts up to 32 effects per root.');
    let margin = Math.max(2, Math.abs(s.strokeWidth || 0));
    for (const e of s.effects || []) margin = Math.max(margin, Math.abs(e.x || 0) + Math.abs(e.y ?? 2) + Math.abs(e.spread || 0) + 2 * Math.abs(e.blur ?? 8) + 2);
    // Rotation can extend on either side of the anchor. Reserve conservatively;
    // Figma's measured bounds are checked again before committing any root.
    if (s.rotation) margin += Math.hypot(s.w, s.h);
    const x = s.x ?? cursor + margin, y = s.y ?? margin;
    if (![x, y, margin].every(Number.isFinite)) bad('Layout coordinates and effects must be finite.');
    cursor = x + s.w + margin + gap;
    return { spec: s, x, y, rect: { x: x - margin, y: y - margin, width: s.w + margin * 2, height: s.h + margin * 2 } };
  });
  for (let i = 0; i < placed.length; i++) for (let j = 0; j < i; j++) {
    if (overlap(placed[i].rect, placed[j].rect, 24)) bad('Top-level frames overlap or have less than 24px spacing. Group intentional overlays inside one frame.');
  }
  const x = Math.min(...placed.map(p => p.rect.x)), y = Math.min(...placed.map(p => p.rect.y));
  const width = Math.max(...placed.map(p => p.rect.x + p.rect.width)) - x;
  const height = Math.max(...placed.map(p => p.rect.y + p.rect.height)) - y;
  if (!finiteSize(width) || !finiteSize(height)) bad('The layout footprint is too large for automatic placement.');
  return { x, y, width, height, placed };
}
export function overlap(a, b, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
export function findSpace(size, obstacles, gap = 48) {
  if (obstacles.length > 10512) bad('Too many canvas obstacles to plan a layout safely.');
  for (const r of obstacles) if (!r || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]) && Math.abs(r[k]) <= 1e7) || r.width < 0 || r.height < 0) bad('Canvas bounds could not be verified.');
  // Search vertical intervals at a fixed column in O(n log n). A fresh
  // reservation is added synchronously before another job can use the space.
  const originY = Math.max(0, Math.min(size.y, 1e6));
  const candidate = { x: Math.max(0, Math.min(size.x, 1e6)), y: originY, width: size.width, height: size.height };
  const intervals = obstacles.map(r => ({ ...r, gap: Math.max(gap, r.gutter || 0) }))
    .filter(r => candidate.x < r.x + r.width + r.gap && candidate.x + candidate.width + r.gap > r.x)
    .sort((a, b) => (a.y - a.gap) - (b.y - b.gap));
  for (const r of intervals) {
    if (!overlap(candidate, r, r.gap)) continue;
    candidate.y = r.y + r.height + r.gap;
    if (candidate.y + candidate.height > 1e7) bad('No available canvas space within the placement limit.');
  }
  return candidate;
}
export function positionedCommand(cmd, footprint, rect, pageId) {
  const specs = footprint.placed.map(p => ({ ...p.spec, x: p.x - footprint.x + rect.x, y: p.y - footprint.y + rect.y }));
  const { spec, specs: ignored, placement, ...rest } = cmd;
  return { ...rest, parent: pageId, select: false, zoom: false, specs };
}
