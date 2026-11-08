/**
 * New-feature factories with sensible defaults, and the tool → selection requirements of the
 * command bar (act-first-select-second, PLAN §9.2).
 */

import type {
  BodyOp,
  BooleanFeature,
  ChamferFeature,
  EntityRef,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  Id,
  Part,
  PickKind,
  PlaneFeature,
  PrimitiveFeature,
  RevolveFeature,
  SketchFeature,
} from '@whittle/contracts';
import { ulid } from '@whittle/document';

const BASE_NAMES: Record<string, string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  boolean: 'Boolean',
  plane: 'Plane',
  box: 'Box',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
};

/** "Extrude 3": one more than the highest existing number for that base name. */
export function nextName(part: Pick<Part, 'features'>, base: string): string {
  const label = BASE_NAMES[base] ?? base;
  const re = new RegExp(`^${label} (\\d+)$`);
  let n = 0;
  for (const f of part.features) {
    const m = re.exec(f.name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${label} ${n + 1}`;
}

const base = (part: Pick<Part, 'features'>, kind: string) => ({
  id: ulid(),
  name: nextName(part, kind),
  suppressed: false,
});

export function newSketch(part: Pick<Part, 'features'>, on: EntityRef): SketchFeature {
  return { ...base(part, 'sketch'), type: 'sketch', on, entities: [], constraints: [] };
}

/** Bodies exist → add to them; otherwise a new body (Onshape-style default). */
export const defaultOp = (bodyCount: number): BodyOp => (bodyCount > 0 ? 'add' : 'new');

export function newExtrude(
  part: Pick<Part, 'features'>,
  profile: EntityRef[],
  bodyCount: number,
): ExtrudeFeature {
  return {
    ...base(part, 'extrude'),
    type: 'extrude',
    profile,
    direction: 'normal',
    end: { kind: 'blind', depth: '10 mm' },
    op: defaultOp(bodyCount),
  };
}

/** An origin axis lying in the profile's sketch plane (revolve default). */
export function defaultAxisFor(sketch: SketchFeature | undefined): EntityRef {
  const on = sketch?.on.name;
  if (on === 'origin:XZ' || on === 'origin:YZ') return { name: 'origin:Z', kind: 'edge' };
  return { name: 'origin:Y', kind: 'edge' };
}

export function newRevolve(
  part: Pick<Part, 'features'>,
  profile: EntityRef[],
  axis: EntityRef,
  bodyCount: number,
): RevolveFeature {
  return {
    ...base(part, 'revolve'),
    type: 'revolve',
    profile,
    axis,
    angle: '360 deg',
    direction: 'normal',
    op: defaultOp(bodyCount),
  };
}

export function newFillet(part: Pick<Part, 'features'>, edges: EntityRef[]): FilletFeature {
  return { ...base(part, 'fillet'), type: 'fillet', edges, radius: '2 mm' };
}

export function newChamfer(part: Pick<Part, 'features'>, edges: EntityRef[]): ChamferFeature {
  return {
    ...base(part, 'chamfer'),
    type: 'chamfer',
    edges,
    mode: { kind: 'distance', distance: '1 mm' },
  };
}

export function newBoolean(
  part: Pick<Part, 'features'>,
  target: EntityRef,
  tools: EntityRef[],
): BooleanFeature {
  return { ...base(part, 'boolean'), type: 'boolean', op: 'cut', target, tools, keepTools: false };
}

export function newPlane(part: Pick<Part, 'features'>, from: EntityRef): PlaneFeature {
  return {
    ...base(part, 'plane'),
    type: 'plane',
    definition: { kind: 'offset', from, distance: '20 mm' },
  };
}

export function newBox(part: Pick<Part, 'features'>): PrimitiveFeature {
  return {
    ...base(part, 'box'),
    type: 'primitive',
    shape: 'box',
    dx: '40 mm',
    dy: '30 mm',
    dz: '20 mm',
    op: 'new',
  };
}

export function newCylinder(part: Pick<Part, 'features'>): PrimitiveFeature {
  return {
    ...base(part, 'cylinder'),
    type: 'primitive',
    shape: 'cylinder',
    radius: '10 mm',
    height: '20 mm',
    op: 'new',
  };
}

export type ModelTool = 'sketch' | 'extrude' | 'revolve' | 'fillet' | 'chamfer';

/** What each command-bar tool needs selected, and where those picks go in the new feature. */
export const TOOL_NEEDS: Record<ModelTool, { kinds: PickKind[]; prompt: string; path: string }> = {
  sketch: { kinds: ['face'], prompt: 'Select a plane or a planar face', path: '/on' },
  extrude: { kinds: ['region'], prompt: 'Select a sketch region to extrude', path: '/profile' },
  revolve: { kinds: ['region'], prompt: 'Select a sketch region to revolve', path: '/profile' },
  fillet: { kinds: ['edge'], prompt: 'Select edges to fillet', path: '/edges' },
  chamfer: { kinds: ['edge'], prompt: 'Select edges to chamfer', path: '/edges' },
};

/** Context tools for the current selection (select-first-act-second). */
export function contextTools(kinds: readonly PickKind[]): ModelTool[] {
  if (kinds.length === 0) return [];
  const all = (k: PickKind) => kinds.every((x) => x === k);
  if (all('region')) return ['extrude', 'revolve'];
  if (all('edge')) return ['fillet', 'chamfer'];
  if (all('face') && kinds.length === 1) return ['sketch'];
  return [];
}

/** Bodies of a feature's output: `B<featureId>` for body-creating features (naming.ts). */
export const bodyIdOf = (featureId: Id): string => `B${featureId}`;

export function isSolidFeature(f: Feature): boolean {
  return f.type === 'extrude' || f.type === 'revolve' || f.type === 'primitive';
}
