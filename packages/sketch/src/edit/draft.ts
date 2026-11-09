/**
 * Shared plumbing for the sketch-editing operations (M3): the result type and a mutable working
 * copy of a sketch that records what was created, removed and why.
 *
 * Every operation is a pure function `(sketch, …) → SketchEditResult`: the input is never
 * mutated; the result is a whole new sketch plus a patch summary (created / removed entities and
 * constraints) and a human `description` for the undo label.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  GeometricConstraintDraft,
  Id,
  SketchConstraint,
  SketchEntity,
  Vec2,
} from '@wren-cad/contracts';
import { constraintLabel, Namer } from '../explain';
import { arcGeom, indexEntities } from '../geometry';
import { constraintRefs, isSketchReference } from '../references';
import { newId } from '../tools';
import type { Curve } from './curves';

/** The editable part of a sketch feature (`SketchFeature` minus its plane and name). */
export interface SketchData {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export interface SketchEdit {
  /** The whole sketch after the edit (the input is not mutated). */
  sketch: SketchData;
  /** Undo label, e.g. "Offset 4 entities by 5 mm". */
  description: string;
  /** New entity ids, in creation order. */
  created: Id[];
  /** Entity ids that were removed. */
  removed: Id[];
  /** Existing entity ids whose geometry or definition changed (same id). */
  changed: Id[];
  addedConstraints: Id[];
  removedConstraints: Id[];
  /** Plain-language notes: dropped segments, dropped constraints and why. */
  notes: string[];
}

export type SketchEditResult = ({ ok: true } & SketchEdit) | { ok: false; reason: string };

export interface EditOptions {
  /** Id generator (default ULID). */
  id?: () => Id;
  /** Evaluated dimension values, only used to word notes ("Length 30 mm (Line 2)"). */
  values?: Record<Id, number>;
}

/** A constraint without its id (distributes over the union). */
export type ConstraintDraft = SketchConstraint extends infer C
  ? C extends SketchConstraint
    ? Omit<C, 'id'>
    : never
  : never;

export const refuse = (reason: string): SketchEditResult => ({ ok: false, reason });

/** Typical sketch size, mm (≥ 1), for tolerances. */
export function sketchScale(entities: readonly SketchEntity[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let extra = 0;
  for (const e of entities) {
    if (e.kind === 'point') {
      minX = Math.min(minX, e.x);
      maxX = Math.max(maxX, e.x);
      minY = Math.min(minY, e.y);
      maxY = Math.max(maxY, e.y);
    } else if (e.kind === 'circle') extra = Math.max(extra, 2 * e.radius);
    else if (e.kind === 'ellipse' || e.kind === 'ellipticArc')
      extra = Math.max(extra, 2 * e.majorRadius);
  }
  const ext = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;
  return Math.max(1, ext, extra);
}

export class SketchDraft {
  readonly entities: SketchEntity[];
  constraints: SketchConstraint[];
  readonly namer: Namer;
  readonly scale: number;
  readonly created: Id[] = [];
  readonly removed: Id[] = [];
  readonly changed = new Set<Id>();
  readonly addedConstraints: Id[] = [];
  readonly removedConstraints: Id[] = [];
  readonly notes: string[] = [];
  private readonly index: Map<Id, SketchEntity>;
  private readonly nextId: () => Id;
  private readonly values: Record<Id, number>;

  constructor(sketch: SketchData, options: EditOptions = {}) {
    this.entities = sketch.entities.map((e) => structuredClone(e));
    this.constraints = sketch.constraints.map((c) => structuredClone(c));
    this.index = indexEntities(this.entities);
    this.namer = new Namer(sketch.entities);
    this.scale = sketchScale(sketch.entities);
    this.nextId = options.id ?? newId;
    this.values = options.values ?? {};
  }

  /** Length tolerance, mm. */
  get tol(): number {
    return 1e-9 * this.scale;
  }

  get(id: Id): SketchEntity | undefined {
    return this.index.get(id);
  }

  name(id: Id): string {
    const n = this.namer.entity(id);
    if (n !== 'unknown geometry') return n;
    const e = this.index.get(id);
    return e ? `the new ${e.kind}` : n;
  }

  label(c: SketchConstraint): string {
    return constraintLabel(c, this.namer, this.values);
  }

  pos(id: Id): Vec2 {
    if (id === '@origin') return [0, 0];
    const p = this.index.get(id);
    if (p?.kind !== 'point') throw new Error(`${id} is not a point`);
    return [p.x, p.y];
  }

  setPos(id: Id, p: Vec2) {
    const e = this.index.get(id);
    if (e?.kind !== 'point') throw new Error(`${id} is not a point`);
    e.x = p[0];
    e.y = p[1];
    this.touch(id);
  }

  /** Marks an existing entity as changed (ignored for entities created by this edit). */
  touch(id: Id) {
    if (!this.created.includes(id)) this.changed.add(id);
  }

  /** Curve geometry of a line, arc or circle (null for points and ellipses). */
  curve(id: Id): Curve | null {
    const e = this.index.get(id);
    if (!e) return null;
    if (e.kind === 'line') return { kind: 'line', a: this.pos(e.start), b: this.pos(e.end) };
    if (e.kind === 'circle') return { kind: 'circle', c: this.pos(e.center), r: e.radius };
    if (e.kind === 'arc') {
      const g = arcGeom(this.index, e);
      return { kind: 'arc', c: g.c, r: g.r, a0: g.a0, sweep: g.sweep };
    }
    return null;
  }

  private add<E extends SketchEntity>(e: E): Id {
    this.entities.push(e);
    this.index.set(e.id, e);
    this.created.push(e.id);
    return e.id;
  }

  /** Adds a complete entity (its id included) as created by this edit. */
  addEntity(e: SketchEntity): Id {
    return this.add(e);
  }

  point(p: Vec2, construction = false): Id {
    return this.add({ id: this.nextId(), kind: 'point', construction, x: p[0], y: p[1] });
  }

  line(start: Id, end: Id, construction = false): Id {
    return this.add({ id: this.nextId(), kind: 'line', construction, start, end });
  }

  arc(center: Id, start: Id, end: Id, construction = false): Id {
    return this.add({ id: this.nextId(), kind: 'arc', construction, center, start, end });
  }

  circle(center: Id, radius: number, construction = false): Id {
    return this.add({ id: this.nextId(), kind: 'circle', construction, center, radius });
  }

  /** Replaces an entity's definition in place (same id and position in the list). */
  replace(e: SketchEntity) {
    const i = this.entities.findIndex((x) => x.id === e.id);
    if (i < 0) throw new Error(`No entity ${e.id}`);
    this.entities[i] = e;
    this.index.set(e.id, e);
    this.touch(e.id);
  }

  constrain(c: GeometricConstraintDraft): Id {
    const id = this.nextId();
    this.constraints.push({ ...c, id } as SketchConstraint);
    this.addedConstraints.push(id);
    return id;
  }

  /** Adds a full constraint (dimensions) with a fresh id. */
  addConstraint(c: ConstraintDraft): Id {
    const id = this.nextId();
    this.constraints.push({ ...c, id } as SketchConstraint);
    this.addedConstraints.push(id);
    return id;
  }

  newId(): Id {
    return this.nextId();
  }

  constraint(id: Id): SketchConstraint | undefined {
    return this.constraints.find((c) => c.id === id);
  }

  /** Removes a constraint, with a note saying why (omit `why` for silent bookkeeping). */
  dropConstraint(id: Id, why?: string) {
    const c = this.constraints.find((k) => k.id === id);
    if (!c) return;
    this.constraints = this.constraints.filter((k) => k.id !== id);
    if (this.addedConstraints.includes(id)) {
      this.addedConstraints.splice(this.addedConstraints.indexOf(id), 1);
      return;
    }
    this.removedConstraints.push(id);
    if (why) this.notes.push(`Removed ‘${this.label(c)}’: ${why}`);
  }

  /** Replaces a constraint in place (same id). */
  updateConstraint(c: SketchConstraint) {
    const i = this.constraints.findIndex((k) => k.id === c.id);
    if (i >= 0) this.constraints[i] = c;
  }

  /** Constraints that refer to `id`. */
  constraintsOn(id: Id): SketchConstraint[] {
    return this.constraints.filter((c) => constraintRefs(c).includes(id));
  }

  /** Entities (other than `except`) that use point `pid` as an end, centre or pole. */
  pointUsers(pid: Id, except?: Id): SketchEntity[] {
    return this.entities.filter((e) => {
      if (e.id === except) return false;
      if (e.kind === 'line') return e.start === pid || e.end === pid;
      if (e.kind === 'arc') return e.start === pid || e.end === pid || e.center === pid;
      if (e.kind === 'circle' || e.kind === 'ellipse') return e.center === pid;
      if (e.kind === 'ellipticArc') return e.start === pid || e.end === pid || e.center === pid;
      if (e.kind === 'bspline') return e.poles.includes(pid);
      return false;
    });
  }

  removeEntity(id: Id) {
    const i = this.entities.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.entities.splice(i, 1);
    this.index.delete(id);
    const ci = this.created.indexOf(id);
    if (ci >= 0) this.created.splice(ci, 1);
    else this.removed.push(id);
    this.changed.delete(id);
  }

  /** Removes point `pid` when no entity uses it any more, with the constraints on it. */
  dropIfOrphan(pid: Id, why: string) {
    if (this.pointUsers(pid).length > 0) return;
    for (const c of this.constraintsOn(pid)) this.dropConstraint(c.id, why);
    this.removeEntity(pid);
  }

  /**
   * Drops constraints that refer to geometry no longer in the sketch. Offsets lose only the
   * pairs whose source or target is gone.
   */
  private sweep() {
    const exists = (id: Id) => isSketchReference(id) || this.index.has(id);
    for (const c of [...this.constraints]) {
      if (c.kind === 'offset') {
        const keep = c.targets
          .map((t, i) => [c.sources[i] as Id, t] as const)
          .filter(([s, t]) => exists(s) && exists(t));
        if (keep.length === c.targets.length) continue;
        if (keep.length === 0) {
          this.dropConstraint(c.id, 'its geometry was removed');
          continue;
        }
        this.updateConstraint({
          ...c,
          sources: keep.map(([s]) => s),
          targets: keep.map(([, t]) => t),
        });
        continue;
      }
      if (!constraintRefs(c).every(exists)) this.dropConstraint(c.id, 'its geometry was removed');
    }
  }

  finish(description: string): { ok: true } & SketchEdit {
    this.sweep();
    return {
      ok: true,
      sketch: { entities: this.entities, constraints: this.constraints },
      description,
      created: [...this.created],
      removed: [...this.removed],
      changed: [...this.changed].filter((id) => this.index.has(id)),
      addedConstraints: [...this.addedConstraints],
      removedConstraints: [...this.removedConstraints],
      notes: [...this.notes],
    };
  }
}

/** Union–find of point ids joined by `coincident` constraints. */
export function coincidenceRoots(constraints: readonly SketchConstraint[]): (id: Id) => Id {
  const parent = new Map<Id, Id>();
  const find = (id: Id): Id => {
    let r = id;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r) as Id;
    return r;
  };
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue;
    const a = find(c.a);
    const b = find(c.b);
    if (a !== b) parent.set(a, b);
  }
  return find;
}

export function formatMm(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return `${Object.is(r, -0) ? 0 : r} mm`;
}
