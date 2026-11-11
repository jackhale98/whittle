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
  EntityRef,
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

function promoteFeature(
  f: Feature,
  frames: ReadonlyMap<Id, SketchFrame>,
  sketches: ReadonlyMap<Id, SketchFeature>,
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
): { promotions: Promotion[]; notPromotable: NotPromotable[] } {
  const notPromotable: NotPromotable[] = [];
  const promotions: Promotion[] = [];
  const active = part.features.slice(0, part.rollbackIndex).filter((f) => !f.suppressed);
  const sketches = new Map<Id, SketchFeature>();
  for (const f of part.features) if (f.type === 'sketch') sketches.set(f.id, f);
  for (const f of active) {
    if (f.type === 'sketch') {
      for (const c of f.constraints) {
        if (!('value' in c) || !(c as DimensionConstraint).driving) continue;
        const p = promoteSketch(f, c as DimensionConstraint, frames.get(f.id));
        if ('draft' in p) promotions.push(p);
        else notPromotable.push(p);
      }
    } else {
      for (const p of promoteFeature(f, frames, sketches)) {
        if ('draft' in p) promotions.push(p);
        else notPromotable.push(p);
      }
    }
  }
  promotions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { promotions, notPromotable };
}
