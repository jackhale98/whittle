/**
 * New-feature factories with sensible defaults, and the tool → selection requirements of the
 * command bar (act-first-select-second, PLAN §9.2). M1 tools wait for a selection and then create
 * their feature (`TOOL_NEEDS`); M3 tools create their feature at once and collect its references
 * field by field (`FEATURE_PICKS`).
 */

import type {
  AxisFeature,
  BodyOp,
  BooleanFeature,
  ChamferFeature,
  CircularPatternFeature,
  CopySource,
  DraftFeature,
  EntityRef,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  HoleFeature,
  Id,
  LinearPatternFeature,
  LoftFeature,
  MirrorFeature,
  Part,
  PickKind,
  PlaneFeature,
  PointFeature,
  PrimitiveFeature,
  PushPullFeature,
  RevolveFeature,
  ShellFeature,
  SketchFeature,
  SweepFeature,
  ThreadFeature,
} from '@wren-cad/contracts';
import { ulid } from '@wren-cad/document';

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
  pushPull: 'Push/pull',
  extrudeCut: 'Cut-extrude',
  revolveCut: 'Cut-revolve',
  sweep: 'Sweep',
  loft: 'Loft',
  shell: 'Shell',
  draft: 'Draft',
  hole: 'Hole',
  thread: 'Thread',
  mirror: 'Mirror',
  linearPattern: 'Linear pattern',
  circularPattern: 'Circular pattern',
  axis: 'Axis',
  point: 'Point',
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

/**
 * Extruded cut (tool `extrudeCut`, ADR-038): the extrude feature with `op: 'cut'`, going into the
 * material (away from the sketch normal), blind by default.
 */
export function newExtrudeCut(part: Pick<Part, 'features'>, profile: EntityRef[]): ExtrudeFeature {
  return {
    ...base(part, 'extrudeCut'),
    type: 'extrude',
    profile,
    direction: 'reverse',
    end: { kind: 'blind', depth: '10 mm' },
    op: 'cut',
  };
}

/** Revolved cut (tool `revolveCut`): the revolve feature with `op: 'cut'`. */
export function newRevolveCut(
  part: Pick<Part, 'features'>,
  profile: EntityRef[],
  axis: EntityRef,
): RevolveFeature {
  return {
    ...base(part, 'revolveCut'),
    type: 'revolve',
    profile,
    axis,
    angle: '360 deg',
    direction: 'normal',
    op: 'cut',
  };
}

/** A hole-style cut: the profile through everything, away from the sketch's normal. */
export function newCut(part: Pick<Part, 'features'>, profile: EntityRef[]): ExtrudeFeature {
  return {
    ...base(part, 'extrude'),
    type: 'extrude',
    profile,
    direction: 'reverse',
    end: { kind: 'throughAll' },
    op: 'cut',
  };
}

export function newPushPull(
  part: Pick<Part, 'features'>,
  faces: EntityRef[],
  distance: string,
): PushPullFeature {
  return { ...base(part, 'pushPull'), type: 'pushPull', faces, distance };
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

/** Command-bar tools that wait for a selection before they create their feature (M1 flow). */
export type ModelTool =
  | 'sketch'
  | 'extrude'
  | 'extrudeCut'
  | 'revolve'
  | 'revolveCut'
  | 'fillet'
  | 'chamfer'
  | 'pushPull';

/** What each command-bar tool needs selected, and where those picks go in the new feature. */
export const TOOL_NEEDS: Record<ModelTool, { kinds: PickKind[]; prompt: string; path: string }> = {
  sketch: { kinds: ['face'], prompt: 'Select a plane or a planar face', path: '/on' },
  extrude: { kinds: ['region'], prompt: 'Select a sketch region to extrude', path: '/profile' },
  extrudeCut: { kinds: ['region'], prompt: 'Select a sketch region to cut', path: '/profile' },
  revolve: { kinds: ['region'], prompt: 'Select a sketch region to revolve', path: '/profile' },
  revolveCut: {
    kinds: ['region'],
    prompt: 'Select a sketch region to cut by revolving',
    path: '/profile',
  },
  fillet: { kinds: ['edge'], prompt: 'Select edges to fillet', path: '/edges' },
  chamfer: { kinds: ['edge'], prompt: 'Select edges to chamfer', path: '/edges' },
  pushPull: { kinds: ['face'], prompt: 'Select a flat face to push or pull', path: '/faces' },
};

export const isModelTool = (t: string): t is ModelTool => Object.hasOwn(TOOL_NEEDS, t);

// ------------------------------------------------------------------------------------- M3 tools

/**
 * M3 tools that open their feature at once and then collect its references one field at a time
 * (PLAN 9.2 act first, select second): the inspector shows the feature, the prompt chip says what
 * to pick, and each pick fills the current field. A selection made first fills the first field
 * when it fits (select first, act second).
 */
export type FeatureTool =
  | 'sweep'
  | 'loft'
  | 'shell'
  | 'draft'
  | 'hole'
  | 'thread'
  | 'mirror'
  | 'linearPattern'
  | 'circularPattern'
  | 'plane'
  | 'axis'
  | 'point';

export interface PickStep {
  /** JSON pointer of the reference field (an array field collects several picks). */
  path: string;
  /** Prompt chip text while this field is being picked. */
  prompt: string;
  /** A list field that usually takes one pick: move on after it (a sweep's profile). */
  once?: boolean;
}

/** The ordered reference fields each M3 tool asks for. */
export const FEATURE_PICKS: Record<FeatureTool, readonly PickStep[]> = {
  sweep: [
    { path: '/profile', prompt: 'Select the profile region to sweep', once: true },
    { path: '/path', prompt: 'Select the path curves, in order' },
  ],
  loft: [{ path: '/sections', prompt: 'Select the section regions, in order' }],
  shell: [{ path: '/openFaces', prompt: 'Select the faces to remove' }],
  draft: [
    { path: '/faces', prompt: 'Select the faces to taper' },
    { path: '/neutral', prompt: 'Select the neutral plane or face' },
  ],
  hole: [
    { path: '/face', prompt: 'Select the flat face to drill' },
    { path: '/points', prompt: 'Select sketch points or reference points for the holes' },
  ],
  thread: [{ path: '/face', prompt: 'Select a cylindrical face to thread' }],
  mirror: [
    { path: '/source/features', prompt: 'Select the features to mirror, in the tree or the model' },
    { path: '/plane', prompt: 'Select the mirror plane' },
  ],
  linearPattern: [
    {
      path: '/source/features',
      prompt: 'Select the features to pattern, in the tree or the model',
    },
    { path: '/direction', prompt: 'Select the direction: an edge, an axis or a plane' },
  ],
  circularPattern: [
    {
      path: '/source/features',
      prompt: 'Select the features to pattern, in the tree or the model',
    },
    { path: '/axis', prompt: 'Select the pattern axis' },
  ],
  plane: [{ path: '/definition/from', prompt: 'Select the plane or face to offset from' }],
  axis: [{ path: '/definition/edge', prompt: 'Select a straight edge for the axis' }],
  point: [],
};

export const isFeatureTool = (t: string): t is FeatureTool => Object.hasOwn(FEATURE_PICKS, t);

/** An empty reference waiting for its pick (the inspector shows "Pick a …"). */
export const unsetRef = (kind: EntityRef['kind']): EntityRef => ({ name: '', kind });

/** An empty or placeholder reference. */
export const isUnset = (r: EntityRef | undefined): boolean => !r || r.name === '';

const featureSource = (ids: readonly Id[]): CopySource => ({
  kind: 'features',
  features: [...ids],
});

export function newSweep(part: Pick<Part, 'features'>, bodyCount: number): SweepFeature {
  return {
    ...base(part, 'sweep'),
    type: 'sweep',
    profile: [],
    path: [],
    orientation: 'followPath',
    op: defaultOp(bodyCount),
  };
}

export function newLoft(part: Pick<Part, 'features'>, bodyCount: number): LoftFeature {
  return {
    ...base(part, 'loft'),
    type: 'loft',
    sections: [],
    ruled: false,
    closed: false,
    op: defaultOp(bodyCount),
  };
}

export function newShell(part: Pick<Part, 'features'>): ShellFeature {
  return {
    ...base(part, 'shell'),
    type: 'shell',
    openFaces: [],
    thickness: '2 mm',
    direction: 'inward',
  };
}

export function newDraft(part: Pick<Part, 'features'>): DraftFeature {
  return {
    ...base(part, 'draft'),
    type: 'draft',
    faces: [],
    neutral: unsetRef('face'),
    angle: '3 deg',
    reverse: false,
  };
}

/** Hole wizard default: an ISO M6 normal-fit clearance hole through everything (ADR-037). */
export function newHole(part: Pick<Part, 'features'>): HoleFeature {
  return {
    ...base(part, 'hole'),
    type: 'hole',
    points: [],
    face: unsetRef('face'),
    standard: 'ISO',
    kind: 'simple',
    size: 'M6',
    fit: 'normal',
    end: { kind: 'throughAll' },
  };
}

export function newThread(part: Pick<Part, 'features'>): ThreadFeature {
  return {
    ...base(part, 'thread'),
    type: 'thread',
    face: unsetRef('face'),
    standard: 'ISO',
    size: 'M6',
  };
}

export function newMirror(part: Pick<Part, 'features'>, sources: readonly Id[]): MirrorFeature {
  return {
    ...base(part, 'mirror'),
    type: 'mirror',
    source: featureSource(sources),
    plane: unsetRef('face'),
  };
}

export function newLinearPattern(
  part: Pick<Part, 'features'>,
  sources: readonly Id[],
): LinearPatternFeature {
  return {
    ...base(part, 'linearPattern'),
    type: 'linearPattern',
    source: featureSource(sources),
    direction: unsetRef('edge'),
    reverse: false,
    count: '3',
    spacing: '10 mm',
  };
}

export function newCircularPattern(
  part: Pick<Part, 'features'>,
  sources: readonly Id[],
): CircularPatternFeature {
  return {
    ...base(part, 'circularPattern'),
    type: 'circularPattern',
    source: featureSource(sources),
    axis: unsetRef('edge'),
    count: '6',
    angle: '360 deg',
    equalSpacing: true,
  };
}

export function newAxis(part: Pick<Part, 'features'>): AxisFeature {
  return {
    ...base(part, 'axis'),
    type: 'axis',
    definition: { kind: 'edge', edge: unsetRef('edge') },
  };
}

export function newPoint(part: Pick<Part, 'features'>): PointFeature {
  return {
    ...base(part, 'point'),
    type: 'point',
    definition: { kind: 'coordinates', x: '0 mm', y: '0 mm', z: '0 mm' },
  };
}

/** A new feature for an M3 tool (references empty; the pick sequence fills them). */
export function newFeatureFor(
  tool: FeatureTool,
  part: Pick<Part, 'features'>,
  ctx: { bodyCount: number; sources: readonly Id[] },
): Feature {
  switch (tool) {
    case 'sweep':
      return newSweep(part, ctx.bodyCount);
    case 'loft':
      return newLoft(part, ctx.bodyCount);
    case 'shell':
      return newShell(part);
    case 'draft':
      return newDraft(part);
    case 'hole':
      return newHole(part);
    case 'thread':
      return newThread(part);
    case 'mirror':
      return newMirror(part, ctx.sources);
    case 'linearPattern':
      return newLinearPattern(part, ctx.sources);
    case 'circularPattern':
      return newCircularPattern(part, ctx.sources);
    case 'plane':
      return newPlane(part, unsetRef('face'));
    case 'axis':
      return newAxis(part);
    case 'point':
      return newPoint(part);
  }
}

/** Context tools for the current selection (select-first-act-second). */
export function contextTools(kinds: readonly PickKind[]): ModelTool[] {
  if (kinds.length === 0) return [];
  const all = (k: PickKind) => kinds.every((x) => x === k);
  if (all('region')) return ['extrude', 'revolve'];
  if (all('edge')) return ['fillet', 'chamfer'];
  if (all('face')) return kinds.length === 1 ? ['sketch', 'pushPull'] : ['pushPull'];
  return [];
}

/**
 * M3 context tools for a selection, after the M1 ones (inspector actions, the touch bubble):
 * regions → cut, sweep, loft; faces → hole (one face), shell, draft; one edge → axis.
 */
export function contextFeatureTools(kinds: readonly PickKind[]): Array<ModelTool | FeatureTool> {
  if (kinds.length === 0) return [];
  const all = (k: PickKind) => kinds.every((x) => x === k);
  if (all('region')) return ['extrudeCut', 'sweep', 'loft'];
  if (all('face')) return kinds.length === 1 ? ['hole', 'shell', 'draft'] : ['shell', 'draft'];
  if (all('edge') && kinds.length === 1) return ['axis'];
  return [];
}

/** Bodies of a feature's output: `B<featureId>` for body-creating features (naming.ts). */
export const bodyIdOf = (featureId: Id): string => `B${featureId}`;

/** Sketch references a feature consumes (its sketches are hidden unless something is picked). */
export function consumedSketchRefs(f: Feature): readonly EntityRef[] {
  switch (f.type) {
    case 'extrude':
    case 'revolve':
      return f.profile;
    case 'sweep':
      return [...f.profile, ...f.path];
    case 'loft':
      return f.sections;
    case 'hole':
      return f.points;
    default:
      return [];
  }
}

export function isSolidFeature(f: Feature): boolean {
  return (
    f.type === 'extrude' ||
    f.type === 'revolve' ||
    f.type === 'primitive' ||
    f.type === 'sweep' ||
    f.type === 'loft'
  );
}
