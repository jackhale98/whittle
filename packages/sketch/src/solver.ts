/**
 * `SketchSolverApi` core (synchronous; the worker and Node tests wrap it). Policy:
 *
 *  - planegcs solves the driving constraints. We re-check every residual ourselves and only call
 *    the sketch `solved` when all hold (planegcs can report success on degenerate collapses).
 *  - Reference (driven) dimensions never reach planegcs; they're measured afterwards.
 *  - DOF / per-entity state / redundancy come from our own Jacobian rank analysis (analysis.ts).
 *  - Over-constraint: per connected component of unsatisfied constraints, QuickXplain (Junker
 *    2004) over numeric satisfiability checks finds a *minimal* conflicting set; the lowest-priority
 *    member is relaxed and the search repeats for further conflicts. `fix` constraints are treated
 *    as ground (always present); when a conflict only exists because geometry is fixed, the
 *    explanation says so and removing the fix is offered.
 *  - Dragging: temporary planegcs constraints pull the grabbed geometry toward fixed cursor points
 *    in a dedicated planegcs system that is re-solved in place on every move.
 *  - Rows planegcs can't express (G2 curvature) are finished by Newton steps on our own rows after
 *    planegcs (`Row.gcs === false`); offsets and the derived poles of splines drawn through points
 *    solve downstream of everything else (`offsetSplit`).
 *  - Conflicts list the geometry they act on (`entities`); `fixes[0]` removes the most recently
 *    added constraint of the set (its last by position in the sketch), which is also the one the
 *    relaxed solution leaves out.
 *  - Polish: every accepted solution (solve and drag) gets minimum-norm Newton steps on our own
 *    residuals until driving dimensions and coincidences hold to ~1e-11 mm (polish.ts), so
 *    sketches dimensioned to meet are exactly coplanar (ADR-008 item 9).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchPrimitive } from '@salusoft89/planegcs';
import type {
  DimensionConstraint,
  Id,
  InferenceCandidate,
  SketchConflict,
  SketchConstraint,
  SketchEntityKind,
  SketchSolveInput,
  SketchSolveResult,
  SuggestedFix,
  Vec2,
} from '@wren-cad/contracts';
import { analyzeDof, type DofAnalysis } from './analysis';
import {
  constraintLabel,
  explainConflict,
  fixLabel,
  Namer,
  referencedEntities,
} from './explain';
import { closestParam, paramCurve } from './geometry';
import { Algorithm, GcsSession, type PlanegcsModule } from './gcs';
import { infer } from './inference';
import {
  buildModel,
  entitiesFrom,
  gid,
  isSatisfied,
  measureDimension,
  PRIORITY,
  type Row,
  SketchInputError,
  type SketchModel,
  violatedRows,
} from './model';
import { polish } from './polish';
import { isSketchReference } from './references';

const MAX_CONFLICTS = 8;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface DragTarget {
  /** planegcs p-param index of the cursor point's x. */
  at: number;
  offset: Vec2;
}

interface DragSession {
  input: SketchSolveInput;
  model: SketchModel;
  /** Offsets solved downstream of planegcs (the planegcs system holds `split.upstream`). */
  split: OffsetSplit | null;
  gcs: GcsSession;
  targets: DragTarget[];
  grab: Vec2;
  x: Float64Array;
  analysis: DofAnalysis;
  redundant: Id[];
}

function emptyResult(
  input: SketchSolveInput,
  t0: number,
  status: SketchSolveResult['status'],
  error?: string,
): SketchSolveResult {
  return {
    status,
    ...(error ? { error } : {}),
    entities: input.entities.map((e) => ({ ...e })),
    dof: 0,
    entityDof: {},
    conflicts: [],
    redundant: [],
    driven: {},
    ms: now() - t0,
  };
}

export class SketchSolverCore {
  private readonly gcs: GcsSession;
  private readonly sessions = new Map<number, DragSession>();
  private nextSession = 1;

  constructor(private readonly mod: PlanegcsModule) {
    this.gcs = new GcsSession(mod);
  }

  // -------------------------------------------------------------------------------------------
  // Solve
  // -------------------------------------------------------------------------------------------

  solve(input: SketchSolveInput): SketchSolveResult {
    const t0 = now();
    let model: SketchModel;
    try {
      model = buildModel(input);
    } catch (err) {
      if (err instanceof SketchInputError) return emptyResult(input, t0, 'failed', err.message);
      throw err;
    }
    const namer = new Namer(input.entities);
    const invalidConflicts = [...model.invalid].map(([id, reason]) =>
      invalidConflict(input, id, reason, namer),
    );

    const first = this.solveModel(model, model.x0);
    if (first.ok) {
      const analysis = analyzeDof(model, first.x);
      return this.result(
        model,
        first.x,
        invalidConflicts.length ? 'conflicting' : 'solved',
        invalidConflicts,
        analysis.redundant,
        analysis,
        t0,
      );
    }

    const found = this.findConflicts(model, first.x, namer);
    const relaxed = buildModel(input, { disabled: new Set([...found.blamed]) });
    const second = found.conflicts.length ? this.solveModel(relaxed, relaxed.x0) : first;
    const x = finite(second.x) ? second.x : model.x0;
    const conflicts = [...found.conflicts, ...invalidConflicts];
    const status: SketchSolveResult['status'] =
      found.conflicts.length && second.ok ? 'conflicting' : 'failed';
    const analysis = analyzeDof(relaxed, x);
    if (second.ok) this.addSetValueFixes(found, relaxed, x, namer);
    return this.result(relaxed, x, status, conflicts, analysis.redundant, analysis, t0);
  }

  private result(
    model: SketchModel,
    x: Float64Array,
    status: SketchSolveResult['status'],
    conflicts: SketchConflict[],
    redundant: Id[],
    analysis: DofAnalysis,
    t0: number,
  ): SketchSolveResult {
    return {
      status,
      entities: entitiesFrom(model, x),
      dof: analysis.dof,
      entityDof: analysis.entityDof,
      conflicts,
      redundant,
      driven: measureDriven(model, x),
      ms: now() - t0,
    };
  }

  /**
   * Solves `model` from `x0` (DogLeg, then Levenberg–Marquardt) and verifies every residual.
   * Accepted solutions are polished (`refine`, default on); the conflict search turns it off
   * because it only needs a yes/no answer.
   */
  private solveModel(
    model: SketchModel,
    x0: Float64Array,
    refine = true,
  ): { x: Float64Array; ok: boolean } {
    if (model.rows.length === 0) return { x: Float64Array.from(x0), ok: true };
    const accept = (x: Float64Array) => ({ x: refine ? refined(model, x) : x, ok: true });
    if (isSatisfied(model, x0)) return accept(Float64Array.from(x0));
    // Offsets follow their sources: solve everything else, then the offset geometry.
    const split = offsetSplit(model);
    if (split) {
      const up = this.solveModel(split.upstream, x0, false);
      const y = up.ok ? solveTargets(model, up.x, split) : null;
      if (y) return accept(y);
    }
    let best: Float64Array | null = null;
    let bestErr = Number.POSITIVE_INFINITY;
    const session = this.gcs;
    for (const algorithm of [Algorithm.DogLeg, Algorithm.LevenbergMarquardt]) {
      session.load(model, x0);
      session.solve(algorithm);
      const x = Float64Array.from(x0);
      session.read(x);
      if (!finite(x)) continue;
      if (isSatisfied(model, x)) return accept(x);
      const err = residualNorm(model, x);
      if (err < bestErr) {
        bestErr = err;
        best = x;
      }
    }
    // planegcs' point–line distances are unsigned and can settle an offset on the wrong side;
    // our own rows are signed, so Newton on them finds the intended solution. Rows planegcs has no
    // counterpart for (G2) and spline parameters it left outside a period are finished the same way.
    if (split || model.tsOnly || model.splineIdx.size || model.active.some((c) => c.kind === 'offset')) {
      for (const start of best ? [best, x0] : [x0]) {
        const y = polish(model, start, model.rows, undefined, 30);
        if (isSatisfied(model, y)) return accept(y);
      }
    }
    return { x: best ?? Float64Array.from(x0), ok: false };
  }

  private consistent(
    input: SketchSolveInput,
    all: readonly Id[],
    enabled: ReadonlySet<Id>,
    unlinked?: ReadonlySet<Id>,
  ): boolean {
    const disabled = new Set(all.filter((id) => !enabled.has(id)));
    const m = buildModel(input, { disabled, unlinked });
    return this.solveModel(m, m.x0, false).ok;
  }

  // -------------------------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------------------------

  private findConflicts(
    model: SketchModel,
    xBest: Float64Array,
    namer: Namer,
  ): { conflicts: SketchConflict[]; blamed: Set<Id>; sets: Id[][] } {
    const input = model.input;
    const all = model.active.map((c) => c.id);
    const byId = new Map(model.active.map((c) => [c.id, c]));
    const order = new Map(input.constraints.map((c, i) => [c.id, i]));
    const rank = (id: Id) => {
      const c = byId.get(id) as SketchConstraint;
      return PRIORITY[c.kind] * 1e6 + (order.get(id) ?? 0);
    };
    const fixes = model.active.filter((c) => c.kind === 'fix').map((c) => c.id);
    const components = constraintComponents(model);
    const failing = new Set<number>();
    for (const r of violatedRows(model, xBest)) {
      const comp = components.of.get(r.owner);
      if (comp !== undefined) failing.add(comp);
    }

    const conflicts: SketchConflict[] = [];
    const sets: Id[][] = [];
    const blamed = new Set<Id>();
    for (const comp of failing) {
      const work = (components.members[comp] ?? []).filter((id) => byId.get(id)?.kind !== 'fix');
      work.sort((a, b) => rank(a) - rank(b));
      const isOk = (subset: readonly Id[]) =>
        this.consistent(input, all, new Set([...fixes, ...subset]));
      for (let n = 0; n < MAX_CONFLICTS && conflicts.length < MAX_CONFLICTS; n++) {
        if (isOk(work)) break;
        const set = quickXplain([], work, isOk);
        if (set.length === 0) break;
        set.sort((a, b) => rank(a) - rank(b));
        // Fixes that make the set contradictory (the set alone, free to move, may be fine).
        let fixed: Id[] = [];
        if (fixes.length && this.consistent(input, all, new Set(set))) {
          fixed = quickXplain(set, fixes, (s) => this.consistent(input, all, new Set(s)));
        }
        // Linked (converted) geometry that makes the set contradictory: it can't move either.
        let linked: Id[] = [];
        const withFixes = new Set([...fixes, ...set]);
        if (model.linked.length && this.consistent(input, all, withFixes, new Set(model.linked))) {
          linked = quickXplain([], model.linked, (keep) => {
            const kept = new Set(keep);
            const free = new Set(model.linked.filter((id) => !kept.has(id)));
            return this.consistent(input, all, withFixes, free);
          });
        }
        // The most recently added member (last by position) is relaxed and suggested for removal.
        const blame = set.reduce((a, b) => ((order.get(b) ?? 0) > (order.get(a) ?? 0) ? b : a));
        blamed.add(blame);
        work.splice(work.indexOf(blame), 1);
        sets.push(set);
        conflicts.push(
          this.describeConflict(
            set.map((id) => byId.get(id) as SketchConstraint),
            fixed.map((id) => byId.get(id) as SketchConstraint),
            namer,
            input.values,
            linked,
            order,
          ),
        );
      }
    }
    return { conflicts, blamed, sets };
  }

  private describeConflict(
    set: SketchConstraint[],
    fixes: SketchConstraint[],
    namer: Namer,
    values: Record<Id, number>,
    linked: Id[],
    order: ReadonlyMap<Id, number>,
  ): SketchConflict {
    const fixedEntities = fixes.map((f) => (f.kind === 'fix' ? f.entity : f.id));
    const suggestions: SuggestedFix[] = [];
    const pos = (c: SketchConstraint) => order.get(c.id) ?? 0;
    const byPosition = [...set].sort((a, b) => pos(a) - pos(b));
    const newest = byPosition[byPosition.length - 1] as SketchConstraint;
    // fixes[0]: remove the most recently added constraint (the research's "propose the last-added
    // constraint"); then the other dimensions (cheapest to change), newest first; then the rest.
    const newestLabel = constraintLabel(newest, namer, values);
    const first = { kind: 'removeConstraint', constraint: newest.id } as const;
    suggestions.push({ label: fixLabel(first, newestLabel, newest), action: first });
    if ('value' in newest) {
      const action = { kind: 'makeReference', constraint: newest.id } as const;
      suggestions.push({ label: fixLabel(action, newestLabel, newest), action });
    }
    const ordered = byPosition
      .slice(0, -1)
      .reverse()
      .sort((a, b) => Number('value' in b) - Number('value' in a));
    for (const c of ordered) {
      const label = constraintLabel(c, namer, values);
      if ('value' in c) {
        const action = { kind: 'makeReference', constraint: c.id } as const;
        suggestions.push({ label: fixLabel(action, label, c), action });
      }
      const action = { kind: 'removeConstraint', constraint: c.id } as const;
      suggestions.push({ label: fixLabel(action, label, c), action });
    }
    for (const f of fixes) {
      const action = { kind: 'removeConstraint', constraint: f.id } as const;
      suggestions.push({ label: fixLabel(action, constraintLabel(f, namer, values), f), action });
    }
    const entities: Id[] = [];
    for (const c of [...byPosition, ...fixes]) {
      for (const id of referencedEntities(c)) {
        if (!isSketchReference(id) && !entities.includes(id)) entities.push(id);
      }
    }
    for (const id of linked) if (!entities.includes(id)) entities.push(id);
    return {
      kind: 'overconstrained',
      constraints: byPosition.map((c) => c.id),
      entities,
      ...(linked.length ? { fixed: [...fixedEntities, ...linked] } : {}),
      explanation: explainConflict(set, fixedEntities, namer, values, linked),
      fixes: suggestions,
    };
  }

  /**
   * For each dimension in a conflict, the value it would need to agree with everything else:
   * measured in the relaxed solution (blamed dimension) or by solving without it.
   */
  private addSetValueFixes(
    found: { conflicts: SketchConflict[]; blamed: Set<Id>; sets: Id[][] },
    relaxed: SketchModel,
    xRelaxed: Float64Array,
    namer: Namer,
  ) {
    const input = relaxed.input;
    const byId = new Map(input.constraints.map((c) => [c.id, c]));
    found.conflicts.forEach((conflict) => {
      const extra: SuggestedFix[] = [];
      for (const id of conflict.constraints) {
        const c = byId.get(id);
        if (!c || !('value' in c)) continue;
        let value: number | null = null;
        if (found.blamed.has(id)) {
          value = measureDimension(relaxed, id, xRelaxed);
        } else {
          // Everything else of this conflict stays on; other conflicts stay relaxed.
          const others = [...found.blamed].filter((b) => !conflict.constraints.includes(b));
          const without = buildModel(input, { disabled: new Set([...others, id]) });
          const s = this.solveModel(without, without.x0);
          if (s.ok) value = measureDimension(without, id, s.x);
        }
        if (value === null || !Number.isFinite(value)) continue;
        const signed = c.kind === 'angle' || c.kind === 'hDistance' || c.kind === 'vDistance';
        if (c.kind === 'offset' ? Math.abs(value) <= 1e-9 : !signed && value <= 1e-9) continue;
        if (c.kind === 'angle') value = normalizeAngleNear(value, input.values[id] ?? value);
        const action = { kind: 'setValue', constraint: id, value } as const;
        extra.push({
          label: fixLabel(
            action,
            constraintLabel(c as DimensionConstraint, namer, input.values),
            c,
          ),
          action,
        });
      }
      // After the suggestion (fixes[0]): a value change keeps every constraint.
      conflict.fixes.splice(1, 0, ...extra);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Drag
  // -------------------------------------------------------------------------------------------

  beginDrag(input: SketchSolveInput, entity: Id, grab: Vec2): { session: number } {
    const base = this.solve(input);
    const solvedInput: SketchSolveInput = { ...input, entities: base.entities };
    const blamed = new Set(
      base.conflicts
        .filter((c) => c.kind !== 'unsupported')
        .map((c) => c.constraints[c.constraints.length - 1] as Id),
    );
    const model = buildModel(solvedInput, { disabled: blamed });
    const x = Float64Array.from(model.x0);
    const extra: SketchPrimitive[] = [];
    const cursors: { id: string; offset: Vec2 }[] = [];
    const pointTarget = (pointId: Id) => {
      const i = model.pointIdx.get(pointId);
      if (i === undefined || (model.grounded[i] && model.grounded[i + 1])) return;
      const p: Vec2 = [x[i] as number, x[i + 1] as number];
      const id = `d:${cursors.length}`;
      cursors.push({ id, offset: [p[0] - grab[0], p[1] - grab[1]] });
      extra.push({ id, type: 'point', x: p[0], y: p[1], fixed: true });
      extra.push({
        id: `${id}:c`,
        type: 'p2p_coincident',
        p1_id: gid(pointId),
        p2_id: id,
        temporary: true,
      });
    };
    const e = model.index.get(entity);
    if (e) {
      switch (e.kind) {
        case 'point':
          pointTarget(e.id);
          break;
        case 'line':
          pointTarget(e.start);
          pointTarget(e.end);
          break;
        case 'circle':
        case 'arc': {
          const c = model.pointIdx.get(e.center) as number;
          const center: Vec2 = [x[c] as number, x[c + 1] as number];
          const r =
            e.kind === 'circle'
              ? (x[model.radiusIdx.get(e.id) as number] as number)
              : Math.hypot(
                  (x[model.pointIdx.get(e.start) as number] as number) - center[0],
                  (x[(model.pointIdx.get(e.start) as number) + 1] as number) - center[1],
                );
          if (Math.hypot(grab[0] - center[0], grab[1] - center[1]) < 0.5 * r) {
            pointTarget(e.center);
          } else {
            const id = 'd:0';
            cursors.push({ id, offset: [0, 0] });
            extra.push({ id, type: 'point', x: grab[0], y: grab[1], fixed: true });
            extra.push(
              e.kind === 'circle'
                ? {
                    id: `${id}:c`,
                    type: 'point_on_circle',
                    p_id: id,
                    c_id: gid(e.id),
                    temporary: true,
                  }
                : {
                    id: `${id}:c`,
                    type: 'point_on_arc',
                    p_id: id,
                    a_id: gid(e.id),
                    temporary: true,
                  },
            );
          }
          break;
        }
        case 'ellipse':
        case 'ellipticArc': {
          const el = model.ellipseIdx.get(e.id) as { focus: number; radmin: number };
          const c = model.pointIdx.get(e.center) as number;
          const b = Math.abs(x[el.radmin] as number);
          if (Math.hypot(grab[0] - (x[c] as number), grab[1] - (x[c + 1] as number)) < 0.5 * b) {
            pointTarget(e.center);
          } else {
            const id = 'd:0';
            cursors.push({ id, offset: [0, 0] });
            extra.push({ id, type: 'point', x: grab[0], y: grab[1], fixed: true });
            extra.push({
              id: `${id}:c`,
              type: 'point_on_ellipse',
              p_id: id,
              e_id: gid(e.id),
              temporary: true,
            });
          }
          break;
        }
        case 'bspline': {
          // The curve point under the cursor follows it (at a fixed curve parameter).
          const curve = paramCurve(model.index, e);
          if (!curve) break;
          const u = closestParam(curve, grab, 32 * e.poles.length);
          const at = curve.at(u);
          const id = 'd:0';
          cursors.push({ id, offset: [at[0] - grab[0], at[1] - grab[1]] });
          extra.push({ id, type: 'point', x: at[0], y: at[1], fixed: true });
          extra.push({
            id: `${id}:c`,
            type: 'point_on_bspline',
            p_id: id,
            b_id: gid(e.id),
            pointparam: u,
            temporary: true,
          });
          break;
        }
      }
    }
    const split = offsetSplit(model, entity);
    const gcs = new GcsSession(this.mod);
    gcs.load(split ? split.upstream : model, x, extra);
    const targets = cursors.map((c) => ({ at: gcs.extraPointIndex(c.id), offset: c.offset }));
    const analysis = analyzeDof(model, x);
    const session = this.nextSession++;
    this.sessions.set(session, {
      input: solvedInput,
      model,
      split,
      gcs,
      targets,
      grab,
      x,
      analysis,
      redundant: base.redundant,
    });
    return { session };
  }

  drag(session: number, to: Vec2): SketchSolveResult {
    const t0 = now();
    const s = this.sessions.get(session);
    if (!s) throw new Error(`No drag session ${session}`);
    for (const t of s.targets) {
      s.gcs.setFixedParam(t.at, to[0] + t.offset[0]);
      s.gcs.setFixedParam(t.at + 1, to[1] + t.offset[1]);
    }
    let status: SketchSolveResult['status'] = 'solved';
    if (s.targets.length) {
      s.gcs.solve(Algorithm.DogLeg);
      let x: Float64Array | null = Float64Array.from(s.x);
      s.gcs.read(x);
      if (!finite(x)) x = null;
      else if (s.split) {
        const up = s.split.upstream;
        if (!isSatisfied(up, x) && finishes(up)) x = polish(up, x, up.rows, undefined, 12);
        x = isSatisfied(up, x) ? solveTargets(s.model, x, s.split) : null;
      } else if (!isSatisfied(s.model, x)) {
        // Rows planegcs can't express: a minimum-norm Newton correction of its answer.
        const y = finishes(s.model) ? polish(s.model, x, s.model.rows, undefined, 12) : null;
        x = y && isSatisfied(s.model, y) ? y : null;
      }
      if (x) {
        s.x = refined(s.model, x);
      } else {
        // Keep the last good state; re-seed planegcs from it so the next move starts clean.
        status = 'failed';
        const extra = s.gcs.wrapper.sketch_index
          .get_primitives()
          .filter((p) => p.id.startsWith('d:'));
        s.gcs.load(s.split ? s.split.upstream : s.model, s.x, extra);
        for (const t of s.targets) {
          s.gcs.setFixedParam(t.at, to[0] + t.offset[0]);
          s.gcs.setFixedParam(t.at + 1, to[1] + t.offset[1]);
        }
      }
    }
    return {
      status,
      entities: entitiesFrom(s.model, s.x),
      dof: s.analysis.dof,
      entityDof: s.analysis.entityDof,
      conflicts: [],
      redundant: s.redundant,
      driven: measureDriven(s.model, s.x),
      ms: now() - t0,
    };
  }

  endDrag(session: number): SketchSolveResult {
    const s = this.sessions.get(session);
    if (!s) throw new Error(`No drag session ${session}`);
    this.sessions.delete(session);
    s.gcs.dispose();
    return this.solve({ ...s.input, entities: entitiesFrom(s.model, s.x) });
  }

  infer(
    input: SketchSolveInput,
    cursor: Vec2,
    drawing: { kind: SketchEntityKind; from?: Vec2 } | null,
    tolerance: number,
  ): InferenceCandidate[] {
    return infer(input, cursor, drawing, tolerance);
  }

  dispose() {
    for (const s of this.sessions.values()) s.gcs.dispose();
    this.sessions.clear();
    this.gcs.dispose();
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Downstream stages: offsets, and the derived poles of splines drawn through points (their
 * through points sit at knots, so those poles are a linear function of the through points and the
 * handle poles; DECISIONS "Sketch B-splines"). When nothing else constrains a stage's geometry, the
 * rest can be solved without it (`upstream`, a smaller planegcs system) and the stage afterwards by
 * Newton on its rows with everything else held (`solveTargets`, sparse). So dragging a through
 * point moves only it and reshapes its spline; the other through points stay put. Null when no
 * stage qualifies (a user constraint touches its geometry, or the drag grabs it): then everything
 * solves together.
 */
export interface OffsetSplit {
  upstream: SketchModel;
  rows: Row[];
  /** Grounding for the downstream stage: everything but the stage geometry. */
  ground: Uint8Array;
}

interface Stage {
  /** Constraints whose rows are the stage's (disabled upstream). */
  owners: Set<Id>;
  target: Set<number>;
  /** Entities whose internal rows belong to the stage (offset arcs). */
  internalOf: Set<Id>;
}

export function offsetSplit(model: SketchModel, dragged?: Id): OffsetSplit | null {
  const stages: Stage[] = [];
  const offsets = model.active.filter((c) => c.kind === 'offset');
  if (offsets.length) {
    const target = new Set<number>();
    const targetEntities = new Set<Id>();
    for (const c of offsets) {
      for (const t of c.targets) {
        targetEntities.add(t);
        for (const i of model.entityParams.get(t) ?? []) if (!model.grounded[i]) target.add(i);
      }
    }
    for (const c of offsets)
      for (const src of c.sources)
        for (const i of model.entityParams.get(src) ?? []) target.delete(i);
    if (target.size)
      stages.push({ owners: new Set(offsets.map((c) => c.id)), target, internalOf: targetEntities });
  }
  for (const g of model.interpolations)
    stages.push({ owners: new Set(g.constraints), target: new Set(g.derived), internalOf: new Set() });
  if (stages.length === 0) return null;
  const draggedParams = new Set(dragged !== undefined ? (model.entityParams.get(dragged) ?? []) : []);
  const rows: Row[] = [];
  const owners = new Set<Id>();
  const target = new Set<number>();
  for (const st of stages) {
    if ([...st.target].some((i) => draggedParams.has(i))) continue;
    const mine: Row[] = [];
    let ok = true;
    for (const r of model.rows) {
      if (st.owners.has(r.owner)) {
        mine.push(r);
        continue;
      }
      if (!r.params.some((i) => st.target.has(i))) continue;
      if (r.internal && st.internalOf.has(r.owner)) mine.push(r);
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    rows.push(...mine);
    for (const o of st.owners) owners.add(o);
    for (const i of st.target) target.add(i);
  }
  if (target.size === 0) return null;
  const ground = new Uint8Array(model.grounded.length).fill(1);
  for (const i of target) ground[i] = 0;
  const disabled = new Set([...(model.options.disabled ?? []), ...owners]);
  const upstream = buildModel(model.input, { ...model.options, disabled });
  // Same parameter layout, or the stages can't be handed over.
  if (upstream.x0.length !== model.x0.length) return null;
  return { upstream, rows, ground };
}

/** The offset geometry solved from fixed sources (null when the offset rows can't all hold). */
function solveTargets(
  model: SketchModel,
  x: Float64Array,
  split: OffsetSplit,
): Float64Array | null {
  const y = polish({ ...model, grounded: split.ground }, x, split.rows, undefined, 16);
  return isSatisfied(model, y) ? y : null;
}

/** Whether Newton should finish planegcs' answer (rows it can't express, spline parameters). */
function finishes(model: SketchModel): boolean {
  return model.tsOnly || model.splineIdx.size > 0;
}

/** Polished `x` when it still passes the solver's own check, else `x` unchanged. */
function refined(model: SketchModel, x: Float64Array): Float64Array {
  const p = polish(model, x);
  return isSatisfied(model, p) ? p : x;
}

function finite(x: Float64Array): boolean {
  for (const v of x) if (!Number.isFinite(v)) return false;
  return true;
}

function residualNorm(model: SketchModel, x: Float64Array): number {
  let s = 0;
  for (const r of model.rows) {
    const v = r.f(x);
    s += Number.isFinite(v) ? v * v : 1e30;
  }
  return s;
}

function measureDriven(model: SketchModel, x: Float64Array): Record<Id, number> {
  const out: Record<Id, number> = {};
  for (const c of model.input.constraints) {
    if (!('value' in c) || c.driving) continue;
    const v = measureDimension(model, c.id, x);
    if (v !== null) out[c.id] = v;
  }
  return out;
}

function normalizeAngleNear(v: number, ref: number): number {
  // Measured angles are in [0, 2π); keep the sign convention of the user's value.
  if (ref < 0 && v > Math.PI) return v - 2 * Math.PI;
  return v;
}

function invalidConflict(
  input: SketchSolveInput,
  id: Id,
  reason: string,
  namer: Namer,
): SketchConflict {
  const c = input.constraints.find((k) => k.id === id) as SketchConstraint;
  const label = constraintLabel(c, namer, input.values);
  const action = { kind: 'removeConstraint', constraint: id } as const;
  return {
    kind: 'unsupported',
    constraints: [id],
    entities: [...new Set(referencedEntities(c))].filter((e) => !isSketchReference(e)),
    explanation: `${label}: ${reason}`,
    fixes: [{ label: fixLabel(action, label, c), action }],
  };
}

/** Connected components of constraints linked through shared variable parameters. */
function constraintComponents(model: SketchModel): { of: Map<Id, number>; members: Id[][] } {
  const parent = new Map<Id, Id>();
  const find = (a: Id): Id => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r) as Id;
    parent.set(a, r);
    return r;
  };
  const union = (a: Id, b: Id) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const owners = new Set<Id>();
  for (const c of model.active) owners.add(c.id);
  for (const r of model.rows) owners.add(r.owner);
  for (const o of owners) parent.set(o, o);
  const byParam = new Map<number, Id>();
  const link = (r: Row) => {
    for (const p of r.params) {
      if (model.grounded[p]) continue;
      const prev = byParam.get(p);
      if (prev === undefined) byParam.set(p, r.owner);
      else union(prev, r.owner);
    }
  };
  for (const r of model.rows) link(r);
  const of = new Map<Id, number>();
  const members: Id[][] = [];
  const rootIdx = new Map<Id, number>();
  for (const c of model.active) {
    const root = find(c.id);
    let k = rootIdx.get(root);
    if (k === undefined) {
      k = members.length;
      rootIdx.set(root, k);
      members.push([]);
    }
    (members[k] as Id[]).push(c.id);
    of.set(c.id, k);
  }
  // Internal rows (arc rules) map to their component through the arc's id.
  for (const r of model.rows) {
    if (!r.internal) continue;
    const k = rootIdx.get(find(r.owner));
    if (k !== undefined) of.set(r.owner, k);
  }
  return { of, members };
}

/**
 * QuickXplain (Junker, AAAI 2004): a minimal subset X of `candidates` such that
 * `background ∪ X` is inconsistent, assuming `background ∪ candidates` is and `background` isn't.
 */
export function quickXplain<T>(
  background: readonly T[],
  candidates: readonly T[],
  consistent: (set: readonly T[]) => boolean,
): T[] {
  if (candidates.length === 0) return [];
  if (consistent([...background, ...candidates])) return [];
  const rec = (b: readonly T[], delta: boolean, c: readonly T[]): T[] => {
    if (delta && !consistent(b)) return [];
    if (c.length === 1) return [...c];
    const k = Math.ceil(c.length / 2);
    const c1 = c.slice(0, k);
    const c2 = c.slice(k);
    const d2 = rec([...b, ...c1], c1.length > 0, c2);
    const d1 = rec([...b, ...d2], d2.length > 0, c1);
    return [...d1, ...d2];
  };
  return rec(background, false, candidates);
}
