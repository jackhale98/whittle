// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Feature introspection shared by the evaluator, the store and validation:
 *  - which fields of a feature are `Expr`s, and what dimension each must have;
 *  - which `EntityRef`s a feature holds, and which other features those refs point into.
 *
 * Expected-dimension table (the single source of truth, mirrored in docs/FILE_FORMAT.md):
 *
 *   primitive box          /dx /dy /dz                         length
 *   primitive cylinder     /radius /height                     length
 *   primitive sphere       /radius                             length
 *   sketch                 /constraints/N/value                length (distance, hDistance, vDistance,
 *                                                              length, radius, diameter) or angle (angle);
 *                                                              driven (reference) dimensions are not evaluated
 *   extrude                /end/depth (blind)                  length;  /draft  angle
 *   revolve                /angle                              angle
 *   fillet                 /radius                             length
 *   chamfer                /mode/distance                      length;  /mode/angle (distanceAngle)  angle
 *   pushPull               /distance                           length
 *   plane (offset)         /definition/distance                length
 *   any feature, PMI       /annotations/N/value, /tolerance/upper, /tolerance/lower
 *                                                              angle for `angle` annotations, else length
 *                          /annotations/N/gdt/zone             length
 */

import type {
  EntityRef,
  Feature,
  Id,
  NamedDimension,
  PmiAnnotation,
  SketchConstraint,
} from '@wren-cad/contracts';

export const FEATURE_TYPES = [
  'primitive',
  'sketch',
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'boolean',
  'pushPull',
  'plane',
  'import',
] as const satisfies readonly Feature['type'][];

/**
 * Every feature type the contracts define, for load validation. `FEATURE_TYPES` above is the M1
 * set the evaluation fixtures cover; the M3 types were missing here, so a saved document with a
 * hole, thread, shell, pattern (and the rest) failed validation on load. Compile-time exhaustive.
 */
export const KNOWN_FEATURE_TYPES = [
  ...FEATURE_TYPES,
  'axis',
  'point',
  'shell',
  'draft',
  'sweep',
  'loft',
  'mirror',
  'linearPattern',
  'circularPattern',
  'hole',
  'thread',
] as const satisfies readonly Feature['type'][];

type MissingFeatureTypes = Exclude<Feature['type'], (typeof KNOWN_FEATURE_TYPES)[number]>;
export const _allFeatureTypesListed: [MissingFeatureTypes] extends [never] ? true : never = true;

export interface ExprField {
  /** JSON pointer into the feature, e.g. `/constraints/3/value`. */
  pointer: string;
  expected: NamedDimension;
  /** Set for sketch dimension constraints. */
  constraintId?: Id;
  /** A reference (driven) dimension: measured after solving, so its `Expr` is not evaluated. */
  driven?: boolean;
}

function annotationFields(annotations: PmiAnnotation[] | undefined): ExprField[] {
  const out: ExprField[] = [];
  (annotations ?? []).forEach((a, i) => {
    const dim: NamedDimension = a.kind === 'angle' ? 'angle' : 'length';
    const base = `/annotations/${i}`;
    if (a.value !== undefined) out.push({ pointer: `${base}/value`, expected: dim });
    if (a.tolerance?.upper !== undefined) {
      out.push({ pointer: `${base}/tolerance/upper`, expected: dim });
    }
    if (a.tolerance?.lower !== undefined) {
      out.push({ pointer: `${base}/tolerance/lower`, expected: dim });
    }
    if (a.gdt) out.push({ pointer: `${base}/gdt/zone`, expected: 'length' });
  });
  return out;
}

function constraintExpected(c: SketchConstraint): NamedDimension {
  return c.kind === 'angle' ? 'angle' : 'length';
}

/** Every `Expr` field of a feature with the dimension it must have. */
export function exprFields(feature: Feature): ExprField[] {
  const own = ownExprFields(feature);
  return [...own, ...annotationFields(feature.annotations)];
}

function ownExprFields(f: Feature): ExprField[] {
  switch (f.type) {
    case 'primitive':
      switch (f.shape) {
        case 'box':
          return [
            { pointer: '/dx', expected: 'length' },
            { pointer: '/dy', expected: 'length' },
            { pointer: '/dz', expected: 'length' },
          ];
        case 'cylinder':
          return [
            { pointer: '/radius', expected: 'length' },
            { pointer: '/height', expected: 'length' },
          ];
        case 'sphere':
          return [{ pointer: '/radius', expected: 'length' }];
      }
      return [];
    case 'sketch': {
      const out: ExprField[] = [];
      f.constraints.forEach((c, i) => {
        if (!('value' in c)) return;
        out.push({
          pointer: `/constraints/${i}/value`,
          expected: constraintExpected(c),
          constraintId: c.id,
          driven: !c.driving,
        });
      });
      return out;
    }
    case 'extrude': {
      const out: ExprField[] = [];
      if (f.end.kind === 'blind') out.push({ pointer: '/end/depth', expected: 'length' });
      if (f.draft !== undefined) out.push({ pointer: '/draft', expected: 'angle' });
      return out;
    }
    case 'revolve':
      return [{ pointer: '/angle', expected: 'angle' }];
    case 'fillet':
      return [{ pointer: '/radius', expected: 'length' }];
    case 'chamfer':
      return f.mode.kind === 'distance'
        ? [{ pointer: '/mode/distance', expected: 'length' }]
        : [
            { pointer: '/mode/distance', expected: 'length' },
            { pointer: '/mode/angle', expected: 'angle' },
          ];
    case 'boolean':
      return [];
    case 'pushPull':
      return [{ pointer: '/distance', expected: 'length' }];
    case 'plane': {
      const d = f.definition;
      if (d.kind === 'offset') return [{ pointer: '/definition/distance', expected: 'length' }];
      if (d.kind === 'angle') return [{ pointer: '/definition/angle', expected: 'angle' }];
      if (d.kind === 'normalToCurve' && 't' in d.at)
        return [{ pointer: '/definition/at/t', expected: 'scalar' }];
      return [];
    }
    case 'import':
      return [];
    case 'axis':
      return [];
    case 'point': {
      const d = f.definition;
      if (d.kind === 'coordinates')
        return ['x', 'y', 'z'].map((k) => ({
          pointer: `/definition/${k}`,
          expected: 'length' as const,
        }));
      if (d.kind === 'alongEdge') return [{ pointer: '/definition/t', expected: 'scalar' }];
      return [];
    }
    case 'shell':
      return [{ pointer: '/thickness', expected: 'length' }];
    case 'draft':
      return [{ pointer: '/angle', expected: 'angle' }];
    case 'sweep':
    case 'loft':
      return [];
    case 'mirror':
      return [];
    case 'linearPattern': {
      const out: ExprField[] = [
        { pointer: '/count', expected: 'scalar' },
        { pointer: '/spacing', expected: 'length' },
      ];
      if (f.second)
        out.push(
          { pointer: '/second/count', expected: 'scalar' },
          { pointer: '/second/spacing', expected: 'length' },
        );
      return out;
    }
    case 'circularPattern':
      return [
        { pointer: '/count', expected: 'scalar' },
        { pointer: '/angle', expected: 'angle' },
      ];
    case 'hole': {
      const out: ExprField[] = [];
      if (f.diameter !== undefined) out.push({ pointer: '/diameter', expected: 'length' });
      if (f.end.kind === 'blind') out.push({ pointer: '/end/depth', expected: 'length' });
      if (f.tipAngle !== undefined) out.push({ pointer: '/tipAngle', expected: 'angle' });
      if (f.counterbore?.diameter !== undefined)
        out.push({ pointer: '/counterbore/diameter', expected: 'length' });
      if (f.counterbore?.depth !== undefined)
        out.push({ pointer: '/counterbore/depth', expected: 'length' });
      if (f.countersink?.diameter !== undefined)
        out.push({ pointer: '/countersink/diameter', expected: 'length' });
      if (f.countersink?.angle !== undefined)
        out.push({ pointer: '/countersink/angle', expected: 'angle' });
      if (f.thread?.depth !== undefined) out.push({ pointer: '/thread/depth', expected: 'length' });
      return out;
    }
    case 'thread':
      return f.length !== undefined ? [{ pointer: '/length', expected: 'length' }] : [];
    default: {
      const _never: never = f;
      return _never;
    }
  }
}

/** Every persistent topology reference held by a feature (including PMI annotation refs). */
export function entityRefs(f: Feature): EntityRef[] {
  const refs: EntityRef[] = [];
  const scope = (s: { kind: string; bodies?: EntityRef[] } | undefined): void => {
    if (s && s.kind === 'bodies' && s.bodies) refs.push(...s.bodies);
  };
  switch (f.type) {
    case 'primitive':
      scope(f.scope);
      break;
    case 'sketch':
      refs.push(f.on);
      for (const e of f.entities) if (e.source) refs.push(e.source.ref); // M3 linked entities
      break;
    case 'extrude':
      refs.push(...f.profile);
      if (f.end.kind === 'upTo') refs.push(f.end.target);
      scope(f.scope);
      break;
    case 'revolve':
      refs.push(...f.profile, f.axis);
      scope(f.scope);
      break;
    case 'fillet':
    case 'chamfer':
      refs.push(...f.edges);
      break;
    case 'boolean':
      refs.push(f.target, ...f.tools);
      break;
    case 'pushPull':
      refs.push(...f.faces);
      break;
    case 'plane': {
      const d = f.definition;
      if (d.kind === 'offset' || d.kind === 'throughPoint') refs.push(d.from);
      if (d.kind === 'throughPoint') refs.push(d.point);
      if (d.kind === 'threePoints') refs.push(...d.points);
      if (d.kind === 'angle') refs.push(d.from, d.axis);
      if (d.kind === 'normalToCurve') {
        refs.push(d.curve);
        if (!('t' in d.at)) refs.push(d.at);
      }
      if (d.kind === 'midplane') refs.push(d.a, d.b);
      break;
    }
    case 'import':
      scope(f.scope);
      break;
    case 'axis': {
      const d = f.definition;
      if (d.kind === 'twoPoints' || d.kind === 'twoPlanes') refs.push(d.a, d.b);
      if (d.kind === 'edge') refs.push(d.edge);
      if (d.kind === 'cylinder') refs.push(d.face);
      if (d.kind === 'pointNormal') refs.push(d.point, d.plane);
      break;
    }
    case 'point': {
      const d = f.definition;
      if (d.kind === 'vertex') refs.push(d.vertex);
      if (d.kind === 'center') refs.push(d.of);
      if (d.kind === 'alongEdge') refs.push(d.edge);
      if (d.kind === 'intersection') refs.push(d.a, d.b);
      break;
    }
    case 'shell':
      refs.push(...f.openFaces);
      if (f.body) refs.push(f.body);
      break;
    case 'draft':
      refs.push(...f.faces, f.neutral);
      break;
    case 'sweep':
      refs.push(...f.profile, ...f.path);
      scope(f.scope);
      break;
    case 'loft':
      refs.push(...f.sections, ...(f.guides ?? []));
      scope(f.scope);
      break;
    case 'mirror':
    case 'linearPattern':
    case 'circularPattern': {
      if (f.source.kind === 'bodies') refs.push(...f.source.bodies);
      if (f.type === 'mirror') refs.push(f.plane);
      if (f.type === 'linearPattern') {
        refs.push(f.direction);
        if (f.second) refs.push(f.second.direction);
      }
      if (f.type === 'circularPattern') refs.push(f.axis);
      break;
    }
    case 'hole':
      refs.push(...f.points, f.face);
      if (f.end.kind === 'upTo') refs.push(f.end.target);
      break;
    case 'thread':
      refs.push(f.face);
      break;
    default: {
      const _never: never = f;
      return _never;
    }
  }
  for (const a of f.annotations ?? []) refs.push(...a.refs);
  return refs;
}

/** Does `name` (a persistent name) point into the feature with id `id`? Tags: `F<id>:`, `S<id>:`, `B<id>`. */
export function nameTouchesFeature(name: string, id: Id): boolean {
  if (name.includes(`F${id}:`) || name.includes(`S${id}:`)) return true;
  let from = 0;
  const tag = `B${id}`;
  for (;;) {
    const at = name.indexOf(tag, from);
    if (at < 0) return false;
    const after = name[at + tag.length];
    if (after === undefined || !/[0-9A-Za-z]/.test(after)) return true;
    from = at + 1;
  }
}

/** Does feature `f` reference geometry produced by the feature with id `id`? */
export function featureReferences(f: Feature, id: Id): boolean {
  return entityRefs(f).some((r) => nameTouchesFeature(r.name, id));
}
