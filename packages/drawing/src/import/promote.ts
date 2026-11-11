/**
 * Promotion of driving sketch and feature dimensions into annotation drafts (ADR-090 §6,
 * ADR-091 "Import planner"). Pure: no ids are minted here, so the anchor queries
 * (`importAnchorQueries`) and the plan see the same drafts.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationSource,
  DimensionConstraint,
  DimensionText,
  EntityRef,
  Expr,
  Feature,
  Id,
  Part,
  SketchFeature,
  Vec3,
} from '@wren-cad/contracts';

export interface SketchFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** An annotation without its id (distributes over the union, unlike `Omit`). */
export type AnnotationDraft = Annotation extends infer A
  ? A extends Annotation
    ? Omit<A, 'id'>
    : never
  : never;

export interface NotPromotable {
  featureId: Id;
  path: string;
  message: string;
}

export type PromotionHint =
  | { kind: 'inPlane'; normal: Vec3; direction?: Vec3 }
  | { kind: 'direction'; direction: Vec3 }
  | { kind: 'circleNormal'; normal: Vec3 }
  | { kind: 'anchors' };

export interface Promotion {
  key: string;
  draft: AnnotationDraft;
  /** Geometry hints for the view choice. */
  hint: PromotionHint;
  /**
   * Ref lists that measure the same value, most preferred first (`draft.refs` is the first). The
   * planner keeps the first whose refs all resolve without a merge (extrude depths: the start
   * face is usually fused away when the extrude adds to or cuts a body, so its own placement
   * plane stands in for it).
   */
  choices?: EntityRef[][];
  /**
   * Index in `choices` whose refs count instances (`DimensionText.count`): the model faces of a
   * patterned or mirrored feature. The draft asks for the count only while that choice is kept.
   */
  countChoice?: number;
}

export function sourceKey(s: AnnotationSource): string {
  switch (s.kind) {
    case 'sketchDimension':
      return `sketch:${s.featureId}:${s.constraintId}`;
    case 'featureField':
      return `feature:${s.featureId}:${s.path}`;
    case 'feature':
      return `feature:${s.featureId}:`;
  }
}

function sketchRef(f: SketchFeature, id: Id): EntityRef {
  const e = f.entities.find((x) => x.id === id);
  const point = e?.kind === 'point' || id === '@origin';
  return { name: `S${f.id}:${point ? 'p' : 'e'}(${id})`, kind: point ? 'vertex' : 'edge' };
}

/**
 * A sketch dimension of a copied extrude's profile: measured between that extrude's faces first,
 * so the label can count the copies (`N×`), with the sketch refs kept as the fallback choice.
 */
function withCopies(
  p: Promotion,
  f: SketchFeature,
  c: DimensionConstraint,
  extrudes: ReadonlyMap<Id, Extract<Feature, { type: 'extrude' }>>,
  copied: ReadonlyMap<Id, number | undefined>,
): Promotion {
  const ex = extrudes.get(f.id);
  if (!ex || !copied.has(ex.id)) return p;
  const n = copied.get(ex.id);
  if (n !== undefined && n <= 1) return p;
  const refs = copiedProfileRefs(f, c, ex);
  if (!refs) return p;
  const text = 'text' in p.draft ? (p.draft.text as DimensionText | undefined) : undefined;
  const draft = { ...p.draft, refs, text: { ...(text ?? {}), count: true } };
  return {
    ...p,
    draft: draft as AnnotationDraft,
    choices: [refs, p.draft.refs],
    countChoice: 0,
  };
}

function promoteSketch(
  f: SketchFeature,
  c: DimensionConstraint,
  frame: SketchFrame | undefined,
): Promotion | NotPromotable {
  const source: AnnotationSource = { kind: 'sketchDimension', featureId: f.id, constraintId: c.id };
  const key = sourceKey(source);
  const origin = { kind: 'model' as const };
  const kindOf = (id: Id) =>
    f.entities.find((e) => e.id === id)?.kind ?? (id === '@origin' ? 'point' : 'line');
  const normal = frame?.z;
  if (!normal)
    return {
      featureId: f.id,
      path: `/constraints/${c.id}`,
      message: 'The sketch plane is not known yet',
    };
  switch (c.kind) {
    case 'hDistance':
    case 'vDistance': {
      const direction = c.kind === 'hDistance' ? frame.x : frame.y;
      return {
        key,
        draft: {
          kind: 'linear',
          origin,
          refs: [sketchRef(f, c.a), sketchRef(f, c.b)],
          direction,
          source,
        },
        hint: { kind: 'inPlane', normal, direction },
      };
    }
    case 'distance': {
      const points = kindOf(c.a) === 'point' && kindOf(c.b) === 'point';
      return {
        key,
        draft: points
          ? { kind: 'aligned', origin, refs: [sketchRef(f, c.a), sketchRef(f, c.b)], source }
          : { kind: 'linear', origin, refs: [sketchRef(f, c.a), sketchRef(f, c.b)], source },
        hint: { kind: 'inPlane', normal },
      };
    }
    case 'length': {
      const line = f.entities.find((e) => e.id === c.line);
      if (line?.kind !== 'line')
        return {
          featureId: f.id,
          path: `/constraints/${c.id}`,
          message: 'Only straight lengths can be promoted',
        };
      return {
        key,
        draft: {
          kind: 'aligned',
          origin,
          refs: [sketchRef(f, line.start), sketchRef(f, line.end)],
          source,
        },
        hint: { kind: 'inPlane', normal },
      };
    }
    case 'radius':
    case 'diameter':
      return {
        key,
        draft: { kind: c.kind, origin, refs: [sketchRef(f, c.curve)], source },
        hint: { kind: 'circleNormal', normal },
      };
    case 'angle':
      return {
        key,
        draft: { kind: 'angle', origin, refs: [sketchRef(f, c.a), sketchRef(f, c.b)], source },
        hint: { kind: 'inPlane', normal },
      };
    case 'offset':
      return {
        featureId: f.id,
        path: `/constraints/${c.id}`,
        message: 'Offset dimensions are not promotable in M4: use the dimension tool',
      };
  }
}

/** The sketch id a profile or point name comes from (`S<id>:…`). */
function sketchIdOf(name: string | undefined): Id | undefined {
  const m = name ? /^S([^:]+):/.exec(name) : null;
  return m?.[1];
}

// ---------------------------------------------------------------------------------------------
// Pattern and mirror copies (`DimensionText.count`)
// ---------------------------------------------------------------------------------------------

/**
 * Features copied by an active pattern or mirror, with the number of instances the copies give
 * (the original included, skipped positions left out), or `undefined` when that number does not
 * evaluate. The kernel counts what exists (`AnnotationResolution.count`); this only decides
 * whether asking for the count can show more than one.
 */
function copiedFeatures(
  active: readonly Feature[],
  evaluate: PromotionEvaluate | undefined,
): Map<Id, number | undefined> {
  const out = new Map<Id, number | undefined>();
  const num = (e: Expr): number | undefined => {
    const v = evaluate?.(e, 'length');
    return v !== undefined && Number.isFinite(v) ? Math.round(v) : undefined;
  };
  for (const f of active) {
    if (f.type !== 'linearPattern' && f.type !== 'circularPattern' && f.type !== 'mirror') continue;
    if (f.source.kind !== 'features') continue;
    let n: number | undefined;
    if (f.type === 'mirror') n = 2;
    else {
      const a = num(f.count);
      const b = f.type === 'linearPattern' && f.second ? num(f.second.count) : 1;
      n = a !== undefined && b !== undefined ? a * b - new Set(f.skip ?? []).size : undefined;
    }
    for (const id of f.source.features) {
      const was = out.get(id);
      // Copies of copies multiply; an unknown factor makes the product unknown.
      out.set(id, out.has(id) ? (was !== undefined && n !== undefined ? was * n : undefined) : n);
    }
  }
  return out;
}

const REGION = /^S([^:]+):region\(([^|)]*)/;

/**
 * The model faces a size dimension of a copied extrude's profile measures, so that its count is
 * the copies' (`F<extrude>:side(S<sketch>:e(<curve>))`, exact names, never a guess):
 *
 * - a diameter or radius of a profile circle or arc: that curve's side face;
 * - an `hDistance` or `vDistance` between two profile corners: at each corner, the one profile
 *   line through it that is perpendicular to the measuring direction (a rectangle's width and
 *   height). Anything else (the origin, a point on no such line, two lines through one corner)
 *   keeps the sketch refs.
 */
function copiedProfileRefs(
  f: SketchFeature,
  c: DimensionConstraint,
  extrude: Extract<Feature, { type: 'extrude' }>,
): EntityRef[] | undefined {
  const m = REGION.exec(extrude.profile[0]?.name ?? '');
  if (!m || m[1] !== f.id) return undefined;
  const loop = new Set((m[2] as string).split(',').filter(Boolean));
  const face = (curve: Id): EntityRef => ({
    name: `F${extrude.id}:side(S${f.id}:e(${curve}))`,
    kind: 'face',
  });
  const byId = new Map(f.entities.map((e) => [e.id, e]));
  if (c.kind === 'diameter' || c.kind === 'radius') {
    const e = byId.get(c.curve);
    return (e?.kind === 'circle' || e?.kind === 'arc') && loop.has(c.curve)
      ? [face(c.curve)]
      : undefined;
  }
  if (c.kind !== 'hDistance' && c.kind !== 'vDistance') return undefined;
  const pt = (id: Id) => {
    const e = byId.get(id);
    return e?.kind === 'point' ? e : undefined;
  };
  // hDistance measures along the sketch x: the lines that give it are vertical.
  const across = c.kind === 'hDistance' ? 'x' : 'y';
  const through = (p: Id): Id | undefined => {
    const lines: Id[] = [];
    for (const e of f.entities) {
      if (e.kind !== 'line' || !loop.has(e.id) || (e.start !== p && e.end !== p)) continue;
      const a = pt(e.start);
      const b = pt(e.end);
      if (!a || !b) continue;
      const d = across === 'x' ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y);
      const l = Math.hypot(a.x - b.x, a.y - b.y);
      if (l > 0 && d <= 1e-9 * Math.max(1, l)) lines.push(e.id);
    }
    return lines.length === 1 ? lines[0] : undefined;
  };
  const la = pt(c.a) ? through(c.a) : undefined;
  const lb = pt(c.b) ? through(c.b) : undefined;
  return la && lb && la !== lb ? [face(la), face(lb)] : undefined;
}

/** Evaluates an expression to mm or rad; `undefined` when it does not evaluate. */
export type PromotionEvaluate = (expr: Expr, kind: 'length' | 'angle') => number | undefined;

/** A full turn (360°, within 1e-9 rad): a revolve with no start and end faces. */
function isFullTurn(expr: Expr, evaluate: PromotionEvaluate | undefined): boolean {
  const v = evaluate?.(expr, 'angle');
  if (v !== undefined) return Math.abs(Math.abs(v) - 2 * Math.PI) < 1e-9;
  // No evaluator: only the literal spellings of a full turn.
  return /^\s*360\s*(deg|°)?\s*$/i.test(expr);
}

function promoteFeature(
  f: Feature,
  frames: ReadonlyMap<Id, SketchFrame>,
  sketches: ReadonlyMap<Id, SketchFeature>,
  evaluate?: PromotionEvaluate,
): (Promotion | NotPromotable)[] {
  const origin = { kind: 'model' as const };
  const out: (Promotion | NotPromotable)[] = [];
  const no = (path: string, message: string) => out.push({ featureId: f.id, path, message });
  switch (f.type) {
    case 'extrude': {
      if (f.end.kind !== 'blind') break;
      const sk = sketchIdOf(f.profile[0]?.name);
      const z = sk ? frames.get(sk)?.z : undefined;
      if (!z) {
        no('/end/depth', 'The profile sketch plane is not known yet');
        break;
      }
      const source: AnnotationSource = {
        kind: 'featureField',
        featureId: f.id,
        path: '/end/depth',
      };
      const start: EntityRef = { name: `F${f.id}:start`, kind: 'face' };
      const end: EntityRef = { name: `F${f.id}:end`, kind: 'face' };
      // The start face lies on the profile sketch's plane, unless the extrude is symmetric. An
      // extrude that adds to or cuts a body fuses its start face away, so the sketch's own
      // placement (the plane or face it is on) measures the depth instead.
      const on = sk ? sketches.get(sk)?.on : undefined;
      const placed = on && f.direction !== 'symmetric' ? [{ ...on }, end] : undefined;
      const own = [start, end];
      const choices = placed ? (f.op === 'new' ? [own, placed] : [placed, own]) : [own];
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'linear',
          origin,
          refs: choices[0] as EntityRef[],
          direction: z,
          source,
        },
        hint: { kind: 'direction', direction: z },
        choices,
      });
      break;
    }
    case 'fillet': {
      const edge = f.edges[0];
      if (!edge) break;
      const source: AnnotationSource = { kind: 'featureField', featureId: f.id, path: '/radius' };
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'radius',
          origin,
          refs: [{ name: `F${f.id}:fillet(${edge.name})`, kind: 'face' }],
          source,
        },
        hint: { kind: 'anchors' },
      });
      break;
    }
    case 'chamfer': {
      const edge = f.edges[0];
      if (!edge) break;
      const source: AnnotationSource = { kind: 'feature', featureId: f.id };
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'chamfer',
          origin,
          form:
            f.mode.kind === 'distanceAngle' || f.mode.kind === 'distance'
              ? 'distanceAngle'
              : 'twoDistances',
          refs: [{ name: `F${f.id}:chamfer(${edge.name})`, kind: 'face' }],
          source,
        },
        hint: { kind: 'anchors' },
      });
      break;
    }
    case 'hole': {
      const sk = sketchIdOf(f.points[0]?.name);
      const z = sk ? frames.get(sk)?.z : undefined;
      const source = { kind: 'feature' as const, featureId: f.id };
      if (!z) {
        no('', 'The hole sketch plane is not known yet');
        break;
      }
      out.push({
        key: sourceKey(source),
        draft: { kind: 'holeCallout', origin, refs: [], source },
        hint: { kind: 'circleNormal', normal: z },
      });
      break;
    }
    case 'revolve': {
      // A full revolve has no start and end faces: nothing to measure the angle between.
      if (isFullTurn(f.angle, evaluate)) break;
      const source: AnnotationSource = { kind: 'featureField', featureId: f.id, path: '/angle' };
      out.push({
        key: sourceKey(source),
        draft: {
          kind: 'angle',
          origin,
          refs: [
            { name: `F${f.id}:start`, kind: 'face' },
            { name: `F${f.id}:end`, kind: 'face' },
          ],
          // The start and end faces' outward normals are π − θ apart (kernel-client golden), so
          // the revolve angle θ is their supplement.
          measure: 'supplement',
          source,
        },
        hint: { kind: 'anchors' },
      });
      break;
    }
    case 'shell':
      no('/thickness', 'Shell thickness is not promotable in M4: use the dimension tool');
      break;
    case 'draft':
      no('/angle', 'Draft angles are not promotable in M4: use the dimension tool');
      break;
    case 'linearPattern':
    case 'circularPattern':
      no('', 'Pattern spacing is not promotable in M4: use the dimension tool');
      break;
    default:
      break;
  }
  return out;
}

/** Every promotable driving value of the part's active features, sorted by key. */
export function collectPromotions(
  part: Part,
  frames: ReadonlyMap<Id, SketchFrame>,
  evaluate?: PromotionEvaluate,
): { promotions: Promotion[]; notPromotable: NotPromotable[] } {
  const notPromotable: NotPromotable[] = [];
  const promotions: Promotion[] = [];
  const active = part.features.slice(0, part.rollbackIndex).filter((f) => !f.suppressed);
  const sketches = new Map<Id, SketchFeature>();
  for (const f of part.features) if (f.type === 'sketch') sketches.set(f.id, f);
  const copied = copiedFeatures(active, evaluate);
  // The one active extrude of each profile sketch (a sketch two extrudes use is left alone).
  const extrudes = new Map<Id, Extract<Feature, { type: 'extrude' }>>();
  const shared = new Set<Id>();
  for (const f of active) {
    if (f.type !== 'extrude') continue;
    const sk = sketchIdOf(f.profile[0]?.name);
    if (!sk) continue;
    if (extrudes.has(sk)) shared.add(sk);
    extrudes.set(sk, f);
  }
  for (const sk of shared) extrudes.delete(sk);
  for (const f of active) {
    if (f.type === 'sketch') {
      for (const c of f.constraints) {
        if (!('value' in c) || !(c as DimensionConstraint).driving) continue;
        const d = c as DimensionConstraint;
        const p = promoteSketch(f, d, frames.get(f.id));
        if ('draft' in p) promotions.push(withCopies(p, f, d, extrudes, copied));
        else notPromotable.push(p);
      }
    } else {
      for (const p of promoteFeature(f, frames, sketches, evaluate)) {
        if ('draft' in p) promotions.push(p);
        else notPromotable.push(p);
      }
    }
  }
  promotions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { promotions, notPromotable };
}
