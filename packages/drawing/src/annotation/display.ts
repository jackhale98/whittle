/**
 * The display list: the one drawing representation every renderer reads (SVG editor model, PDF,
 * DXF; M5 tessellates the same primitives onto annotation planes). Coordinates are sheet mm,
 * origin bottom-left, y up (annotation layouts built in a local frame are moved with
 * `transformItems`). Nothing here is stored in the document.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, Vec2 } from '@wren-cad/contracts';
import { add2, rotate2, scale2 } from './geom';

/**
 * What a stroke is, which fixes its width (thick or thin of the line group) and its line type
 * (ISO 128-2). One mapping (`roleStroke`) serves SVG, PDF and DXF.
 */
export type StrokeRole =
  /** Visible outlines and edges: thick, continuous. */
  | 'visible'
  /** Hidden edges: thin, dashed. */
  | 'hidden'
  /** Tangent (smooth) edges shown thin. */
  | 'tangent'
  /** Centre lines and centre marks: thin, long-dash dot. */
  | 'center'
  /** Dimension, extension and leader lines, arrowheads, annotation symbols: thin. */
  | 'dimension'
  /** Section hatching: thin. */
  | 'hatch'
  /** Cutting-plane line: thin long-dash dot (thick at the ends and bends: `cuttingPlaneEnd`). */
  | 'cuttingPlane'
  | 'cuttingPlaneEnd'
  /** Drawing frame and title block outer lines: thick. */
  | 'frame'
  /** Title block grid, zone dividers, trim marks, the reference graduation: thin. */
  | 'thin'
  /** Text (its stroke width is the lettering's line width, ISO 3098: h/10). */
  | 'text';

export type LineType = 'continuous' | 'dashed' | 'center';

/** Which document object an item draws (for picking in the SVG editor and DXF layer choice). */
export type ItemSource =
  | { kind: 'template' }
  | { kind: 'titleBlock'; slot?: string }
  /**
   * `edge`: the model edge's persistent name. `face`: the face an outline (or a seam on a
   * silhouette) outlines (`ProjectedCurve.face`), so a pick on it can be a face ref. `on`: the
   * view whose sheet space the item is drawn in when that is not `viewId` itself (a section's
   * cutting plane and a detail's circle are drawn on their parent): moving that view moves them.
   * A placement's `viewId` is the view it is dimensioning, for the same reason (ADR-094).
   * `cut` (M4.1, ADR-095): a section's cut-face edge, the persistent name of the model face the cut
   * passes through along it (`ProjectedCurve.cutFace`); a pick on it refs that face.
   * `construction` (M4.1): a construction ref drawn as a thin chain line (`origin:Y`,
   * `S<id>:e(@x)`, `F<id>:pitch`...), the exact name a pick on it stores.
   */
  | {
      kind: 'view';
      viewId: Id;
      edge?: string;
      face?: string;
      cut?: string;
      construction?: string;
      on?: Id;
    }
  | { kind: 'placement'; placementId: Id; annotationId: Id; viewId?: Id }
  | { kind: 'centerMark'; viewId: Id; markId?: Id }
  | { kind: 'note'; noteId: Id }
  | { kind: 'table'; tableId: Id }
  | { kind: 'scaleBar' };

export type TextAlign = 'left' | 'center' | 'right';
/** Vertical anchor of a text item: its baseline, the middle of the cap height, or cap top. */
export type TextBaseline = 'baseline' | 'middle' | 'top';

export type Primitive =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'polyline'; points: Vec2[]; closed?: boolean }
  /** CCW from `start` to `end` (radians); a full circle is 0 → 2π. */
  | { kind: 'arc'; center: Vec2; radius: number; start: number; end: number }
  /** CCW elliptic arc; `major` is the semi-major axis vector, `ratio` minor/major. */
  | { kind: 'ellipse'; center: Vec2; major: Vec2; ratio: number; start: number; end: number }
  | { kind: 'spline'; degree: number; poles: Vec2[]; knots: number[]; weights?: number[] }
  /** Filled region (arrowheads, datum triangles), even-odd. */
  | { kind: 'fill'; loops: Vec2[][] }
  /**
   * One line of text. `height` is the ISO 3098 nominal height h (cap height), sheet mm;
   * `angle` degrees CCW. Symbols are never text: they are paths from the symbol library.
   */
  | {
      kind: 'text';
      at: Vec2;
      text: string;
      height: number;
      angle: number;
      align: TextAlign;
      baseline: TextBaseline;
    };

export interface ItemMeta {
  role: StrokeRole;
  source?: ItemSource;
  /** Drawn in the needs-attention colour and pattern (never a stale value). */
  attention?: boolean;
}

export type DisplayItem = Primitive & ItemMeta;

/** A sheet's display list: sheet size and its items, in paint order. */
export interface DisplayList {
  width: number;
  height: number;
  items: DisplayItem[];
}

/** A 2D similarity transform: rotate by `angle` (rad), scale by `scale`, then translate by `at`. */
export interface Placement2 {
  at: Vec2;
  angle?: number;
  scale?: number;
}

export function applyPoint(p: Vec2, t: Placement2): Vec2 {
  return add2(rotate2(scale2(p, t.scale ?? 1), t.angle ?? 0), t.at);
}

/** Moves primitives laid out in a local frame onto the sheet. */
export function transformPrimitive<P extends Primitive>(p: P, t: Placement2): P {
  const s = t.scale ?? 1;
  const ang = t.angle ?? 0;
  const pt = (q: Vec2) => applyPoint(q, t);
  switch (p.kind) {
    case 'line':
      return { ...p, a: pt(p.a), b: pt(p.b) };
    case 'polyline':
      return { ...p, points: p.points.map(pt) };
    case 'arc':
      return {
        ...p,
        center: pt(p.center),
        radius: p.radius * s,
        start: p.start + ang,
        end: p.end + ang,
      };
    case 'ellipse':
      return { ...p, center: pt(p.center), major: rotate2(scale2(p.major, s), ang) };
    case 'spline':
      return { ...p, poles: p.poles.map(pt) };
    case 'fill':
      return { ...p, loops: p.loops.map((l) => l.map(pt)) };
    case 'text':
      return {
        ...p,
        at: pt(p.at),
        height: p.height * s,
        angle: p.angle + (ang * 180) / Math.PI,
      };
  }
}

export function transformItems(items: readonly DisplayItem[], t: Placement2): DisplayItem[] {
  return items.map((i) => transformPrimitive(i, t));
}

/** Tags primitives with a role (and optionally a source and the attention flag). */
export function withMeta(prims: readonly Primitive[], meta: ItemMeta): DisplayItem[] {
  return prims.map((p) => ({ ...p, ...meta }) as DisplayItem);
}
