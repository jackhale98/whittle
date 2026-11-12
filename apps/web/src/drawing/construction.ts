/**
 * Construction geometry as pick targets (M4.1, ADR-095). While a measuring tool is active, every
 * construction candidate a view can show (the origin, sketch origins, axes and standalone points,
 * reference features, pitch circles) is drawn over the sheet as a transient chain line and can be
 * picked; a pick stores the exact name drawn under the pointer. Candidates come from the build's
 * configuration data (one `annotationAnchors` call per regen) and are projected once per build.
 */

import type { Id, Vec2 } from '@wren-cad/contracts';
import {
  type ConstructionShape,
  constructionItems,
  constructionKind,
  constructionShapes,
  viewConfiguration,
} from '@wren-cad/drawing';
import type { DisplayItem } from '@wren-cad/drawing/annotation';
import { host } from './host';
import type { Built } from './pipeline';
import type { DrawingTool, EdgePick } from './state';

/** The tools that offer construction geometry: the ones that measure (and reattach). */
export const CONSTRUCTION_TOOLS: ReadonlySet<DrawingTool> = new Set([
  'dimension',
  'angle',
  'ordinate',
  'reattach',
]);

const shapes = new WeakMap<Built, Map<Id, ConstructionShape[]>>();
const items = new WeakMap<Built, Map<Id, DisplayItem[]>>();

/** The construction candidates one view shows, deduplicated by priority (memoised per build). */
export function constructionOf(b: Built, viewId: Id): ConstructionShape[] {
  let m = shapes.get(b);
  if (!m) {
    m = new Map();
    shapes.set(b, m);
  }
  const hit = m.get(viewId);
  if (hit) return hit;
  const sv = b.build.views.get(viewId);
  let out: ConstructionShape[] = [];
  if (sv?.ok) {
    const cfg = b.data.get(host.keyOf(viewConfiguration(b.drawing, sv.view))) ?? b.main;
    out = constructionShapes(sv, cfg.construction ?? []);
  }
  m.set(viewId, out);
  return out;
}

/** Display items of the construction candidates of every view on a sheet (memoised per build). */
export function constructionTargets(b: Built, sheetId: Id): DisplayItem[] {
  let m = items.get(b);
  if (!m) {
    m = new Map();
    items.set(b, m);
  }
  const hit = m.get(sheetId);
  if (hit) return hit;
  const out: DisplayItem[] = [];
  for (const v of b.drawing.views) {
    if (v.sheetId !== sheetId) continue;
    const sv = b.build.views.get(v.id);
    if (sv?.ok) out.push(...constructionItems(sv, constructionOf(b, v.id)));
  }
  m.set(sheetId, out);
  return out;
}

/**
 * The pick of a construction candidate (or a used construction ref drawn on the view) by its
 * exact name: a line, a circle (a pitch circle) or a point, with its view-plane geometry.
 */
export function pickConstruction(b: Built, viewId: Id, name: string, at: Vec2): EdgePick | null {
  let s = constructionOf(b, viewId).find((x) => x.name === name);
  if (!s) {
    // A used ref drawn by the sheet but not offered (another configuration's view, say): its
    // geometry is that of the drawn item.
    const sv = b.build.views.get(viewId);
    const cfg = sv?.ok
      ? (b.data.get(host.keyOf(viewConfiguration(b.drawing, sv.view))) ?? b.main)
      : b.main;
    const anchor = sv?.ok
      ? (cfg.construction ?? []).find((c) => c.name === name)?.anchor
      : undefined;
    if (sv?.ok && anchor) s = constructionShapes(sv, [{ name, anchor }])[0];
  }
  if (!s) return null;
  const kind = constructionKind(name);
  const base = {
    viewId,
    name,
    at,
    construction: true as const,
    ...(kind === 'edge' ? {} : { ref: kind as 'face' | 'vertex' }),
  };
  if (s.kind === 'line') return { ...base, shape: 'line', geom: { a: s.a, b: s.b } };
  if (s.kind === 'circle')
    return {
      ...base,
      shape: 'circle',
      sweep: Math.PI * 2,
      geom: { centre: s.center, radius: s.radius, full: true },
    };
  return { ...base, shape: 'point', geom: { centre: s.at, radius: 0, full: true } };
}
