/**
 * Test helpers: a tiny sketch builder with readable ids and a shared Node solver core.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  DimensionConstraint,
  GeometricConstraint,
  Id,
  SketchConstraint,
  SketchEntity,
  SketchSolveInput,
  SketchSolveResult,
  Vec2,
} from '@wren-cad/contracts';
import { createSketchSolverCore } from '../src/core';
import type { SketchSolverCore } from '../src/solver';

let corePromise: Promise<SketchSolverCore> | null = null;
export function core(): Promise<SketchSolverCore> {
  corePromise ??= createSketchSolverCore();
  return corePromise;
}

type GeoDraft = GeometricConstraint extends infer C
  ? C extends GeometricConstraint
    ? Omit<C, 'id'>
    : never
  : never;
type DimDraft = DimensionConstraint extends infer C
  ? C extends DimensionConstraint
    ? Omit<C, 'id' | 'value' | 'driving'>
    : never
  : never;

export class SketchBuilder {
  entities: SketchEntity[] = [];
  constraints: SketchConstraint[] = [];
  values: Record<Id, number> = {};
  private n = 0;

  private id(prefix: string): Id {
    this.n++;
    return `${prefix}${this.n}`;
  }

  point(x: number, y: number, id = this.id('p')): Id {
    this.entities.push({ id, kind: 'point', construction: false, x, y });
    return id;
  }
  line(a: Id, b: Id, id = this.id('l')): Id {
    this.entities.push({ id, kind: 'line', construction: false, start: a, end: b });
    return id;
  }
  segment(a: Vec2, b: Vec2): { line: Id; start: Id; end: Id } {
    const start = this.point(a[0], a[1]);
    const end = this.point(b[0], b[1]);
    return { line: this.line(start, end), start, end };
  }
  circle(center: Id, radius: number, id = this.id('c')): Id {
    this.entities.push({ id, kind: 'circle', construction: false, center, radius });
    return id;
  }
  arc(center: Id, start: Id, end: Id, id = this.id('a')): Id {
    this.entities.push({ id, kind: 'arc', construction: false, center, start, end });
    return id;
  }
  ellipse(center: Id, majorRadius: number, minorRadius: number, rotation = 0, id = this.id('e')): Id {
    this.entities.push({ id, kind: 'ellipse', construction: false, center, majorRadius, minorRadius, rotation });
    return id;
  }
  /** Elliptic arc; `start`/`end` are placed on the ellipse at eccentric angles t0/t1 when numbers. */
  ellipticArc(
    center: Id,
    majorRadius: number,
    minorRadius: number,
    rotation: number,
    start: Id,
    end: Id,
    id = this.id('ea'),
  ): Id {
    this.entities.push({
      id,
      kind: 'ellipticArc',
      construction: false,
      center,
      start,
      end,
      majorRadius,
      minorRadius,
      rotation,
    });
    return id;
  }
  bspline(
    poles: Id[],
    options: { degree?: number; periodic?: boolean; knots?: number[]; multiplicities?: number[]; weights?: number[] } = {},
    id = this.id('s'),
  ): Id {
    this.entities.push({
      id,
      kind: 'bspline',
      construction: false,
      poles,
      degree: options.degree ?? 3,
      periodic: options.periodic ?? false,
      ...(options.knots ? { knots: options.knots } : {}),
      ...(options.multiplicities ? { multiplicities: options.multiplicities } : {}),
      ...(options.weights ? { weights: options.weights } : {}),
    });
    return id;
  }
  /** Point on an ellipse (centre c, radii a ≥ b, rotation) at eccentric angle t. */
  pointOnEllipse(c: Vec2, a: number, b: number, rotation: number, t: number): Id {
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    return this.point(
      c[0] + x * Math.cos(rotation) - y * Math.sin(rotation),
      c[1] + x * Math.sin(rotation) + y * Math.cos(rotation),
    );
  }
  geo(c: GeoDraft, id = this.id('k')): Id {
    this.constraints.push({ ...c, id } as SketchConstraint);
    return id;
  }
  dim(c: DimDraft, value: number, driving = true, id = this.id('d')): Id {
    this.constraints.push({ ...c, id, value: String(value), driving } as SketchConstraint);
    if (driving) this.values[id] = value;
    return id;
  }
  remove(id: Id) {
    this.constraints = this.constraints.filter((c) => c.id !== id);
    delete this.values[id];
  }
  input(): SketchSolveInput {
    return {
      entities: structuredClone(this.entities),
      constraints: structuredClone(this.constraints),
      values: { ...this.values },
    };
  }
}

export function pos(result: SketchSolveResult, id: Id): Vec2 {
  const e = result.entities.find((x) => x.id === id);
  if (e?.kind !== 'point') throw new Error(`${id} is not a point`);
  return [e.x, e.y];
}

export function radius(result: SketchSolveResult, id: Id): number {
  const e = result.entities.find((x) => x.id === id);
  if (e?.kind !== 'circle') throw new Error(`${id} is not a circle`);
  return e.radius;
}

export const deg = (d: number) => (d * Math.PI) / 180;

export function entity<K extends SketchEntity['kind']>(
  result: { entities: SketchEntity[] },
  id: Id,
  kind: K,
): Extract<SketchEntity, { kind: K }> {
  const e = result.entities.find((x) => x.id === id);
  if (e?.kind !== kind) throw new Error(`${id} is not a ${kind}`);
  return e as Extract<SketchEntity, { kind: K }>;
}

/** Fixed-corner rectangle with H/V edges, width and height dimensions. */
export function rectangle(b: SketchBuilder, w = 40, h = 20, at: Vec2 = [0, 0], perturb = 3) {
  const p0 = b.point(at[0], at[1]);
  const p1 = b.point(at[0] + w + perturb, at[1] + 1);
  const p2 = b.point(at[0] + w - perturb, at[1] + h + perturb);
  const p3 = b.point(at[0] - 1, at[1] + h - perturb);
  const bottom = b.line(p0, p1);
  const right = b.line(p1, p2);
  const top = b.line(p2, p3);
  const left = b.line(p3, p0);
  b.geo({ kind: 'horizontal', line: bottom });
  b.geo({ kind: 'horizontal', line: top });
  b.geo({ kind: 'vertical', line: right });
  b.geo({ kind: 'vertical', line: left });
  return { p0, p1, p2, p3, bottom, right, top, left };
}
