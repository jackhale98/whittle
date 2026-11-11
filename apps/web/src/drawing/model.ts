/**
 * Pure helpers of the drawing route: new drawings, scales, free spots for views, the side a drag
 * means, section and detail geometry. No document access, no kernel: tested in isolation.
 */

import type {
  Drawing,
  DrawingDefaults,
  DrawingView,
  Id,
  IsoCorner,
  Projection,
  SheetFormat,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import {
  alignedDirection,
  generateTemplate,
  LATEST_TEMPLATE_VERSION,
  projectBounds,
  SIDE_VECTORS,
  sideFrame,
  stylePreset,
  type ViewFrame,
  type ViewSide,
} from '@wren-cad/drawing';

/** ISO 5455 / ASME recommended ratios, largest first. */
export const SCALE_SERIES: readonly number[] = [
  10,
  5,
  2,
  1,
  1 / 2,
  1 / 5,
  1 / 10,
  1 / 20,
  1 / 50,
  1 / 100,
];

/** `0.5` → `1/2`, `2` → `2`, `0.2` → `1/5`. */
export function ratioExpr(r: number): string {
  if (r >= 1) return String(Math.round(r * 1000) / 1000);
  const inv = Math.round(1 / r);
  return Math.abs(1 / inv - r) < 1e-9 ? `1/${inv}` : String(Math.round(r * 1e6) / 1e6);
}

/** What a user types for a scale (`1:2`, `2:1`, `0.5`, `1/2`) as an expression, or null. */
export function scaleFromInput(text: string): string | null {
  const t = text.trim().replace(/\s+/g, '');
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return `${m[1]}/${m[2]}`;
  return t === '' ? null : t;
}

/** The scale shown for a ratio: `1:2`, `5:1`, `1:1`. */
export function scaleLabel(r: number): string {
  if (r >= 1) return `${Math.round(r * 1000) / 1000}:1`;
  return `1:${Math.round((1 / r) * 1000) / 1000}`;
}

export interface Rect {
  min: Vec2;
  max: Vec2;
}

export const rectOf = (c: Vec2, w: number, h: number): Rect => ({
  min: [c[0] - w / 2, c[1] - h / 2],
  max: [c[0] + w / 2, c[1] + h / 2],
});

export const overlaps = (a: Rect, b: Rect, gap = 0): boolean =>
  a.min[0] < b.max[0] + gap &&
  a.max[0] > b.min[0] - gap &&
  a.min[1] < b.max[1] + gap &&
  a.max[1] > b.min[1] - gap;

/** The area views may use: the frame minus a margin and minus the title block's strip. */
export function usableArea(format: SheetFormat, template: Drawing['template']): Rect {
  const t = generateTemplate(format, template);
  if (!t.ok) return { min: [20, 20], max: [200, 150] };
  const f = t.layout.frame;
  const tb = t.layout.titleBlock.box;
  const m = 10;
  return {
    min: [f.min[0] + m, Math.max(f.min[1], tb.max[1]) + m],
    max: [f.max[0] - m, f.max[1] - m],
  };
}

/**
 * The largest standard ratio at which the part's three views (plan, elevation and a side) fit the
 * usable area with a gap between them.
 */
export function suggestScale(bounds: { min: Vec3; max: Vec3 }, area: Rect, gap = 40): number {
  const w = bounds.max[0] - bounds.min[0];
  const d = bounds.max[1] - bounds.min[1];
  const h = bounds.max[2] - bounds.min[2];
  const aw = area.max[0] - area.min[0] - gap;
  const ah = area.max[1] - area.min[1] - gap;
  for (const s of SCALE_SERIES) {
    if ((w + d) * s <= aw && (h + d) * s <= ah) return s;
  }
  return SCALE_SERIES[SCALE_SERIES.length - 1] as number;
}

export const DEFAULT_FORMAT: Record<'iso' | 'asme', SheetFormat> = {
  iso: { size: 'A3', orientation: 'landscape' },
  asme: { size: 'ANSI-B', orientation: 'landscape' },
};

export interface NewDrawingInput {
  id: Id;
  sheetId: Id;
  name: string;
  partId: Id;
  defaults: DrawingDefaults;
  scale: number;
  configurationId?: Id | null;
}

/** A new drawing in the project's standard (D10): the style, template and sheet follow it. */
export function newDrawing(input: NewDrawingInput): Drawing {
  const { defaults } = input;
  const family = defaults.standard.family;
  const template = {
    id: family === 'iso' ? ('iso-5457' as const) : ('asme-y14.1' as const),
    version: LATEST_TEMPLATE_VERSION[family === 'iso' ? 'iso-5457' : 'asme-y14.1'],
  };
  return {
    id: input.id,
    name: input.name,
    subject: { kind: 'part', partId: input.partId },
    ...(input.configurationId ? { configurationId: input.configurationId } : {}),
    standard: structuredClone(defaults.standard),
    projection: defaults.projection,
    units: 'mm',
    style: stylePreset(family),
    template,
    sheets: [
      {
        id: input.sheetId,
        name: 'Sheet 1',
        format: DEFAULT_FORMAT[family],
        scale: ratioExpr(input.scale),
      },
    ],
    views: [],
    placements: [],
    centerMarks: [],
    tables: [],
    notes: [],
  };
}

/** Section and detail letters: A, B, C … without I, O, Q (ISO 128-3 avoids them). */
export function nextLetter(used: readonly string[]): string {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (const l of letters) if (!used.includes(l)) return l;
  return `A${used.length}`;
}

/** The side of its parent a view dragged along `dir` (a unit axis) is seen from. */
export function sideForDirection(dir: Vec2, projection: Projection): ViewSide {
  // Aligned direction = third: the side itself; first: its opposite.
  const s: Vec2 = projection === 'third' ? dir : [-dir[0], -dir[1]];
  let best: ViewSide = 'top';
  let bestDot = Number.NEGATIVE_INFINITY;
  for (const k of Object.keys(SIDE_VECTORS) as ViewSide[]) {
    const v = SIDE_VECTORS[k];
    const d = v[0] * s[0] + v[1] * s[1];
    if (d > bestDot) {
      bestDot = d;
      best = k;
    }
  }
  return best;
}

/** The dominant axis of a sheet vector as a unit vector. */
export function dominantAxis(v: Vec2): Vec2 {
  return Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]) || 1, 0] : [0, Math.sign(v[1]) || 1];
}

/** Half extent (sheet mm) of a view's outline along a sheet axis. */
export function halfExtent(
  frame: ViewFrame,
  bounds: { min: Vec3; max: Vec3 },
  scale: number,
  axis: Vec2,
): number {
  const b = projectBounds(frame, bounds);
  return ((axis[0] !== 0 ? b.max[0] - b.min[0] : b.max[1] - b.min[1]) * scale) / 2;
}

/**
 * Centre-to-centre distance of a projected view from its parent: the dragged distance, but never
 * so small that the outlines touch.
 */
export function alignedDistance(
  parent: { frame: ViewFrame; scale: number },
  side: ViewSide,
  bounds: { min: Vec3; max: Vec3 },
  projection: Projection,
  dragged: number | null,
  gap = 25,
): number {
  const dir = alignedDirection(SIDE_VECTORS[side], projection);
  const axis: Vec2 = dir;
  const child = sideFrame(parent.frame, SIDE_VECTORS[side]);
  const min =
    halfExtent(parent.frame, bounds, parent.scale, axis) +
    halfExtent(child, bounds, parent.scale, axis) +
    gap;
  return dragged === null ? min : Math.max(min, dragged);
}

/**
 * The first free spot for a new view of size `w × h`, trying `prefer` first then a grid of
 * positions in `area` that do not overlap `taken`. Falls back to `prefer`.
 */
export function freeSpot(
  taken: readonly Rect[],
  w: number,
  h: number,
  area: Rect,
  prefer: Vec2[] = [],
  gap = 12,
): Vec2 {
  const fits = (c: Vec2) => {
    const r = rectOf(c, w, h);
    return (
      r.min[0] >= area.min[0] &&
      r.max[0] <= area.max[0] &&
      r.min[1] >= area.min[1] &&
      r.max[1] <= area.max[1] &&
      !taken.some((t) => overlaps(r, t, gap))
    );
  };
  for (const c of prefer) if (fits(c)) return c;
  const stepX = Math.max(10, w / 2);
  const stepY = Math.max(10, h / 2);
  for (let y = area.max[1] - h / 2; y >= area.min[1] + h / 2; y -= stepY)
    for (let x = area.min[0] + w / 2; x <= area.max[0] - w / 2; x += stepX)
      if (fits([x, y])) return [x, y];
  return prefer[0] ?? [(area.min[0] + area.max[0]) / 2, (area.min[1] + area.max[1]) / 2];
}

/** A snapped detail scale: about `target` mm across on the sheet for a circle of `radius`. */
export function detailScale(radius: number, parentScale: number, target = 55): number {
  const want = target / (2 * radius);
  // The largest series ratio not above `want` that still enlarges the parent.
  const enlargements = SCALE_SERIES.filter((s) => s > parentScale + 1e-9);
  return enlargements.find((s) => s <= want) ?? enlargements.at(-1) ?? parentScale * 2;
}

/** Display labels of a view for lists and the sheet tabs. */
export function viewName(v: DrawingView): string {
  if (v.label) return v.label;
  switch (v.kind) {
    case 'base':
      return v.orientation.kind === 'named'
        ? `${v.orientation.name[0]?.toUpperCase()}${v.orientation.name.slice(1)} view`
        : v.orientation.kind === 'isometric'
          ? 'Isometric view'
          : 'View';
    case 'projected':
      return `${v.from[0]?.toUpperCase()}${v.from.slice(1)} view`;
    case 'iso':
      return 'Isometric view';
    case 'section':
      return `Section ${v.letter}–${v.letter}`;
    case 'detail':
      return `Detail ${v.letter}`;
  }
}

export type { IsoCorner };
