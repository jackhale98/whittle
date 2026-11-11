/**
 * Implied constraints while drawing (PLAN M3.8): the bookkeeping that keeps "what the glyph
 * promised" equal to "what is committed" without over-constraining the sketch.
 *
 * - {@link AlignmentClasses}: which points already share an x or a y through constraints
 *   (coincident, horizontal / vertical lines, horizontal / vertical point pairs, points on the
 *   axes, fixed points). A new horizontal / vertical relation between two points of one class is
 *   redundant (the solver would report it), so drawing leaves it out and shows no glyph for it.
 * - {@link reusePoints}: a placed point that landed on an existing point becomes that point (no
 *   duplicate point, no `coincident`), in every entity and constraint of a tool's fragment.
 *
 * Pure; ids may be inference placeholders (`@cursor`, `@drawing`, …) for constraints not yet bound.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchConstraint, SketchEntity } from '@wren-cad/contracts';
import { SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS } from './references';
import type { SketchFragment } from './tools';

/** A constraint with or without its id (drafts and committed ones read the same). */
type AnyConstraint = SketchConstraint | (Partial<Pick<SketchConstraint, 'id'>> & { kind: string });

/** All fixed geometry (the origin, `fix`ed points) shares one class on both axes. */
const FIXED = '@fixed';

class UnionFind {
  private readonly parent = new Map<Id, Id>();
  find(id: Id): Id {
    let r = id;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r) as Id;
    // Path compression keeps repeated queries cheap on large sketches.
    let c = id;
    while (c !== r) {
      const next = this.parent.get(c) as Id;
      this.parent.set(c, r);
      c = next;
    }
    return r;
  }
  join(a: Id, b: Id): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(ra, rb);
    return true;
  }
}

export type Axis = 'x' | 'y';

/** Points known (by constraint) to share an x (`x` classes) or a y (`y` classes). */
export class AlignmentClasses {
  private readonly x = new UnionFind();
  private readonly y = new UnionFind();
  private readonly ends = new Map<Id, readonly [Id, Id]>();

  constructor(entities: readonly SketchEntity[], constraints: readonly AnyConstraint[] = []) {
    for (const e of entities) if (e.kind === 'line') this.ends.set(e.id, [e.start, e.end]);
    this.x.join(SKETCH_ORIGIN, FIXED);
    this.y.join(SKETCH_ORIGIN, FIXED);
    for (const c of constraints) this.add(c);
  }

  /** Registers a line drawn in the same edit (so `horizontal` on it can be judged). */
  line(id: Id, start: Id, end: Id): void {
    this.ends.set(id, [start, end]);
  }

  same(axis: Axis, a: Id, b: Id): boolean {
    const uf = axis === 'x' ? this.x : this.y;
    return uf.find(a) === uf.find(b);
  }

  /** The point pairs a constraint aligns, per axis (empty for constraints that align nothing). */
  private joins(c: AnyConstraint): Array<[Axis, Id, Id]> {
    const k = c as Record<string, unknown> & { kind: string };
    const s = (v: unknown) => (typeof v === 'string' ? v : null);
    switch (k.kind) {
      case 'coincident': {
        const a = s(k.a);
        const b = s(k.b);
        return a && b
          ? [
              ['x', a, b],
              ['y', a, b],
            ]
          : [];
      }
      case 'horizontalPoints':
      case 'verticalPoints': {
        const a = s(k.a);
        const b = s(k.b);
        return a && b ? [[k.kind === 'horizontalPoints' ? 'y' : 'x', a, b]] : [];
      }
      case 'horizontal':
      case 'vertical': {
        const ends = this.ends.get(s(k.line) ?? '');
        return ends ? [[k.kind === 'horizontal' ? 'y' : 'x', ends[0], ends[1]]] : [];
      }
      case 'pointOn': {
        const p = s(k.point);
        if (!p) return [];
        if (k.on === SKETCH_X_AXIS) return [['y', p, SKETCH_ORIGIN]];
        if (k.on === SKETCH_Y_AXIS) return [['x', p, SKETCH_ORIGIN]];
        return [];
      }
      case 'fix': {
        const id = s(k.entity);
        if (!id) return [];
        const ends = this.ends.get(id);
        const pts = ends ? [...ends] : [id];
        return pts.flatMap(
          (p): Array<[Axis, Id, Id]> => [
            ['x', p, FIXED],
            ['y', p, FIXED],
          ],
        );
      }
      default:
        return [];
    }
  }

  /**
   * True when every alignment `c` makes already holds: adding it would be redundant. Constraints
   * that align nothing (tangent, pointOn a curve, …) are never redundant here.
   */
  redundant(c: AnyConstraint): boolean {
    const j = this.joins(c);
    return j.length > 0 && j.every(([axis, a, b]) => this.same(axis, a, b));
  }

  /** Records `c`'s alignments. */
  add(c: AnyConstraint): void {
    for (const [axis, a, b] of this.joins(c)) (axis === 'x' ? this.x : this.y).join(a, b);
  }

  /** Adds `c` unless it is redundant; returns whether it was added. */
  take(c: AnyConstraint): boolean {
    if (this.redundant(c)) return false;
    this.add(c);
    return true;
  }
}

/**
 * The fragment with some of its points replaced by existing ones (`map`: fragment point id →
 * existing point id). The fragment's own point entities in `map` are dropped and every reference
 * to them (ends, centres, poles, through points, constraints) points at the existing point.
 */
export function reusePoints(frag: SketchFragment, map: ReadonlyMap<Id, Id>): SketchFragment {
  if (map.size === 0) return frag;
  const re = (id: Id) => map.get(id) ?? id;
  const entities = frag.entities
    .filter((e) => !(e.kind === 'point' && map.has(e.id)))
    .map((e): SketchEntity => {
      switch (e.kind) {
        case 'line':
          return { ...e, start: re(e.start), end: re(e.end) };
        case 'circle':
        case 'ellipse':
          return { ...e, center: re(e.center) };
        case 'arc':
        case 'ellipticArc':
          return { ...e, center: re(e.center), start: re(e.start), end: re(e.end) };
        case 'bspline':
          return {
            ...e,
            poles: e.poles.map(re),
            ...(e.through ? { through: e.through.map(re) } : {}),
          };
        default:
          return e;
      }
    });
  const constraints = frag.constraints.map((c) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (k === 'id' || k === 'kind' || k === 'value' || k === 'label') out[k] = v;
      else if (typeof v === 'string') out[k] = re(v);
      else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? re(x) : x));
      else out[k] = v;
    }
    return out as unknown as SketchConstraint;
  });
  return { entities, constraints };
}
