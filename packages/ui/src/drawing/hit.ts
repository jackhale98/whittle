/**
 * Picking on a sheet: which source (view edge, placement, note, title block cell, view body) is
 * under a sheet point (mm, y up). Works from the display list the SVG is drawn from, so what is
 * picked is exactly what is seen. A pick prefers annotations, then view edges, then regions.
 */

import type { Vec2 } from '@wren-cad/contracts';
import {
  type DisplayItem,
  type DisplayList,
  flattenPrimitive,
  type ItemSource,
  textWidth,
} from '@wren-cad/drawing/annotation';

export interface HitRegion {
  source: ItemSource;
  /** Corners of a box (min, max), sheet mm. */
  min: Vec2;
  max: Vec2;
  /** Lower wins when two regions contain the point. */
  rank?: number;
}

export interface HitResult {
  source: ItemSource;
  /** Distance to the geometry (0 inside a region or a filled shape), sheet mm. */
  dist: number;
  /** The pick was on a drawn line or text (not just inside a region). */
  onGeometry: boolean;
}

const SKIP_ROLES = new Set(['hatch', 'frame']);

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  const t =
    l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

function inLoop(p: Vec2, loop: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i] as Vec2;
    const b = loop[j] as Vec2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** Distance from a point to an item's drawn geometry (Infinity beyond `limit` for speed). */
export function itemDistance(item: DisplayItem, p: Vec2, limit: number): number {
  switch (item.kind) {
    case 'text': {
      const w = textWidth(item.text, item.height);
      const h = item.height;
      const a = (item.angle * Math.PI) / 180;
      const dx = p[0] - item.at[0];
      const dy = p[1] - item.at[1];
      // Into the text's own frame.
      const u = dx * Math.cos(a) + dy * Math.sin(a);
      const v = -dx * Math.sin(a) + dy * Math.cos(a);
      const x0 = item.align === 'left' ? 0 : item.align === 'center' ? -w / 2 : -w;
      const y0 = item.baseline === 'baseline' ? 0 : item.baseline === 'middle' ? -h / 2 : -h;
      const du = Math.max(x0 - u, 0, u - (x0 + w));
      const dv = Math.max(y0 - v, 0, v - (y0 + h));
      return Math.hypot(du, dv);
    }
    case 'fill': {
      for (const l of item.loops) if (inLoop(p, l)) return 0;
      let best = Number.POSITIVE_INFINITY;
      for (const l of item.loops)
        for (let i = 0; i < l.length; i++)
          best = Math.min(best, distToSegment(p, l[i] as Vec2, l[(i + 1) % l.length] as Vec2));
      return best;
    }
    case 'line':
      return distToSegment(p, item.a, item.b);
    default: {
      let best = Number.POSITIVE_INFINITY;
      for (const poly of flattenPrimitive(item, Math.max(limit / 4, 0.02))) {
        for (let i = 0; i + 1 < poly.length; i++)
          best = Math.min(best, distToSegment(p, poly[i] as Vec2, poly[i + 1] as Vec2));
        if (item.kind === 'polyline' && item.closed && poly.length > 2)
          best = Math.min(best, distToSegment(p, poly[poly.length - 1] as Vec2, poly[0] as Vec2));
      }
      return best;
    }
  }
}

function classRank(s: ItemSource | undefined): number {
  switch (s?.kind) {
    case 'placement':
      return 0;
    case 'view':
      return s.edge === undefined ? 2 : 1;
    case 'note':
      return 2;
    case 'centerMark':
      return 3;
    case 'table':
      return 3;
    case 'titleBlock':
      return 4;
    default:
      return 9;
  }
}

/**
 * The best pick at `p` within `tol` mm: nearest geometry of the highest class, else the
 * smallest containing region. `null` when the point is on empty paper.
 */
export function hitTest(
  list: DisplayList,
  p: Vec2,
  tol: number,
  regions: readonly HitRegion[] = [],
): HitResult | null {
  let best: { r: HitResult; rank: number } | null = null;
  for (const item of list.items) {
    const src = item.source;
    if (!src || SKIP_ROLES.has(item.role) || src.kind === 'template' || src.kind === 'scaleBar')
      continue;
    // The title block is picked by cell regions, not by its text.
    if (src.kind === 'titleBlock') continue;
    const d = itemDistance(item, p, tol);
    if (d > tol) continue;
    const rank = classRank(src);
    if (!best || rank < best.rank || (rank === best.rank && d < best.r.dist))
      best = { r: { source: src, dist: d, onGeometry: true }, rank };
  }
  if (best) return best.r;
  let inRegion: { r: HitResult; area: number; rank: number } | null = null;
  for (const g of regions) {
    if (p[0] < g.min[0] || p[0] > g.max[0] || p[1] < g.min[1] || p[1] > g.max[1]) continue;
    const area = (g.max[0] - g.min[0]) * (g.max[1] - g.min[1]);
    const rank = g.rank ?? classRank(g.source);
    if (!inRegion || rank < inRegion.rank || (rank === inRegion.rank && area < inRegion.area))
      inRegion = { r: { source: g.source, dist: 0, onGeometry: false }, area, rank };
  }
  return inRegion?.r ?? null;
}

/** A stable key for a source, matching the SVG model's `data-source`. */
export function sourceKey(s: ItemSource): string {
  switch (s.kind) {
    case 'view':
      return `view:${s.viewId}`;
    case 'placement':
      return `placement:${s.placementId}`;
    case 'centerMark':
      return `centerMark:${s.viewId}:${s.markId ?? 'auto'}`;
    case 'note':
      return `note:${s.noteId}`;
    case 'table':
      return `table:${s.tableId}`;
    case 'titleBlock':
      return `titleBlock:${s.slot ?? ''}`;
    default:
      return s.kind;
  }
}
