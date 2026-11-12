/**
 * Leader forms of datums and tolerance frames (ADR-094): the rules shared by the layout, the
 * drawing route's tools and drags, and the import planner.
 *
 * - On a surface: the datum triangle's base sits on the line the surface is seen as (or on an
 *   extension of it, `t` outside [0, 1]); a frame's leader ends there in an arrow.
 * - On a feature of size: the datum triangle sits at an end of the size dimension's line, in line
 *   with it (`dimensionLine`, `t` 0 or 1); a frame sits with the dimension's text (`placement`).
 *
 * ISO 5459:2011 §5 and ASME Y14.5-2018 §6.3 both allow a filled or an open datum triangle; Wren
 * draws it filled for every standard it supports (`datumTriangleFilled`), the form both show
 * first. Provisional (secondary sources, owner D9).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AnnotationAnchor, AnnotationPlacement, GpsStandard, Vec2 } from '@wren-cad/contracts';
import { dot2, dot3, norm3 } from '../annotation/geom';
import type { SolvedView } from '../view/solve';
import { projectedSegment, viewDirection } from './anchors';

/** Whether the datum triangle is drawn filled (else open) under a GPS standard. */
export function datumTriangleFilled(standard: GpsStandard): boolean {
  switch (standard) {
    case 'ISO 1101:2017':
    case 'ASME Y14.5-2018':
    case 'ASME Y14.5-2009':
      return true;
  }
}

/** Datum triangle size for text height h: base and height, sheet mm. */
export function datumTriangleSize(h: number): { base: number; height: number } {
  const base = 1.15 * h;
  return { base, height: base * 0.866 };
}

/**
 * `t` of the point of a line nearest `p` (unclamped: below 0 or above 1 is on the line's
 * extension). A zero-length line gives 0.
 */
export function lineParameter(line: readonly [Vec2, Vec2], p: Vec2): number {
  const d: Vec2 = [line[1][0] - line[0][0], line[1][1] - line[0][1]];
  const l2 = d[0] * d[0] + d[1] * d[1];
  if (l2 < 1e-18) return 0;
  return dot2([p[0] - line[0][0], p[1] - line[0][1]], d) / l2;
}

/**
 * The range a stored `LeaderAttach.t` (kind `ref`) may take: [0, 1] is on the projected edge,
 * outside it on the edge's extension line (ADR-094; the document validator allows -10 to 11, ten
 * edge lengths out).
 */
export const ATTACH_T_RANGE: readonly [number, number] = [-10, 11];

/** `t` clamped to what a placement can store. */
export function storableAttachT(t: number): number {
  return Math.max(ATTACH_T_RANGE[0], Math.min(ATTACH_T_RANGE[1], t));
}

/** The end of a dimension line a feature-of-size datum snaps to: the nearer one. */
export function dimensionLineEnd(t: number): 0 | 1 {
  return t < 0.5 ? 0 : 1;
}

/**
 * The faces an edge name says the edge lies between, from the naming rules (contracts
 * naming.ts): `edge(<A>|<B>)` and its split `#k`, the primitive form `F…:edge(<r>|<r>)` (faces
 * `F…:<r>`), a seam `edge(A|A)` (one face) and a free edge `edge(A)`. Anything else: none. A name
 * says which faces meet there; which of them a pick means is a geometric question (the caller
 * checks each against the view), never a guess.
 */
export function edgeFaceNames(edge: string): string[] {
  const primitive = /^(F[0-9A-Za-z]+):edge\(/.exec(edge);
  const start = primitive ? primitive[0].length : edge.startsWith('edge(') ? 5 : -1;
  if (start < 0) return [];
  let depth = 0;
  let from = start;
  const parts: string[] = [];
  for (let i = start; i < edge.length; i++) {
    const ch = edge[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) {
        parts.push(edge.slice(from, i));
        const rest = edge.slice(i + 1);
        if (rest !== '' && !/^#\d+$/.test(rest)) return [];
        const names = parts
          .filter((x) => x !== '')
          .map((x) => (primitive ? `${primitive[1]}:${x}` : x));
        return [...new Set(names)];
      }
      depth--;
    } else if (ch === '|' && depth === 0) {
      parts.push(edge.slice(from, i));
      from = i + 1;
    }
  }
  return [];
}

/**
 * Whether a face anchor is seen edge-on in a view along the picked line (view plane, sheet mm):
 * a plane whose normal lies in the view plane and whose projected outline runs along that line
 * within `tol`. This is how a picked edge maps to the surface it bounds (ADR-094).
 */
export function faceAlongLine(
  v: SolvedView,
  anchor: AnnotationAnchor,
  line: readonly [Vec2, Vec2],
  tol = 0.05,
): boolean {
  if (anchor.kind !== 'plane') return false;
  if (Math.abs(dot3(norm3(anchor.normal), v.frame.n)) > 1e-6) return false;
  const seg = projectedSegment(v, anchor);
  if (!seg) return false;
  const d: Vec2 = [line[1][0] - line[0][0], line[1][1] - line[0][1]];
  const l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return false;
  const n: Vec2 = [-d[1] / l, d[0] / l];
  const off = (p: Vec2) => Math.abs(dot2([p[0] - line[0][0], p[1] - line[0][1]], n));
  return off(seg[0]) <= tol && off(seg[1]) <= tol;
}

/**
 * The default text offset of a datum or frame on a surface: out of the material, along the
 * face's outward normal as seen in the view (`distance` sheet mm); null when the face is not
 * seen edge-on.
 */
export function outwardOffset(
  v: SolvedView,
  anchor: AnnotationAnchor | null | undefined,
  distance: number,
): Vec2 | null {
  if (anchor?.kind !== 'plane') return null;
  if (Math.abs(dot3(norm3(anchor.normal), v.frame.n)) > 1e-6) return null;
  const n = viewDirection(v, anchor.normal);
  return n ? [n[0] * distance, n[1] * distance] : null;
}

/** Whether a placement layout is a leader on another placement (a feature-of-size form). */
export function attachedPlacementId(layout: AnnotationPlacement['layout']): string | undefined {
  return layout.kind === 'leader' && layout.attach.kind !== 'ref'
    ? layout.attach.placementId
    : undefined;
}
