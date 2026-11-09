/** M3 harness fixtures: one of every new feature, statuses and small hole tables. */
import type { Feature, FeatureStatus, HoleTable } from '@whittle/contracts';

type K = 'face' | 'edge' | 'region' | 'body' | 'vertex';
export const r3 = (name: string, kind: K) => ({ name, kind });
const skt = (id: string, name: string, on: string): Feature => ({
  id,
  type: 'sketch',
  name,
  suppressed: false,
  on: r3(on, 'face'),
  entities: [],
  constraints: [],
});
const base3 = (id: string, name: string) => ({ id, name, suppressed: false });

/** One of every M3 feature, with the sketches they consume (sweep, loft and hole nest). */
export const m3Features: Feature[] = [
  skt('M1', 'Base sketch', 'origin:XY'),
  {
    ...base3('M2', 'Base'),
    type: 'extrude',
    profile: [r3('SM1:region(e1)', 'region')],
    direction: 'normal',
    end: { kind: 'blind', depth: '30mm' },
    op: 'new',
  },
  skt('M3', 'Rail profile', 'origin:XZ'),
  skt('M4', 'Rail path', 'origin:XY'),
  {
    ...base3('M5', 'Sweep 1'),
    type: 'sweep',
    profile: [r3('SM3:region(e1)', 'region')],
    path: [r3('SM4:e1', 'edge')],
    orientation: 'followPath',
    op: 'add',
  },
  skt('M6', 'Loft section A', 'origin:XY'),
  skt('M7', 'Loft section B', 'origin:XY'),
  {
    ...base3('M8', 'Loft 1'),
    type: 'loft',
    sections: [r3('SM6:region(e1)', 'region'), r3('SM7:region(e1)', 'region')],
    ruled: false,
    closed: false,
    op: 'add',
  },
  {
    ...base3('M9', 'Shell 1'),
    type: 'shell',
    openFaces: [r3('FM2:top', 'face')],
    thickness: '2mm',
    direction: 'inward',
  },
  {
    ...base3('M10', 'Draft 1'),
    type: 'draft',
    faces: [r3('FM2:side(SM1:e1)', 'face')],
    neutral: r3('FM2:start', 'face'),
    angle: '3deg',
    reverse: false,
  },
  skt('M11', 'Hole points', 'FM2:top'),
  {
    ...base3('M12', 'Hole 1'),
    type: 'hole',
    points: [r3('SM11:p(p1)', 'vertex'), r3('SM11:p(p2)', 'vertex')],
    face: r3('FM2:top', 'face'),
    standard: 'ISO',
    kind: 'counterbore',
    size: 'M6',
    fit: 'normal',
    end: { kind: 'blind', depth: '12mm' },
  },
  {
    ...base3('M13', 'Mirror 1'),
    type: 'mirror',
    source: { kind: 'features', features: ['M12'] },
    plane: r3('origin:YZ', 'face'),
  },
  {
    ...base3('M14', 'Linear pattern 1'),
    type: 'linearPattern',
    source: { kind: 'features', features: ['M12'] },
    direction: r3('FM2:edge(e1)', 'edge'),
    reverse: false,
    count: '4',
    spacing: '15mm',
    skip: [2],
  },
  {
    ...base3('M15', 'Circular pattern 1'),
    type: 'circularPattern',
    source: { kind: 'features', features: ['M12'] },
    axis: r3('FM16:axis', 'edge'),
    count: '6',
    angle: '360deg',
    equalSpacing: true,
  },
  {
    ...base3('M16', 'Axis 1'),
    type: 'axis',
    definition: { kind: 'edge', edge: r3('FM2:edge(e2)', 'edge') },
  },
  {
    ...base3('M17', 'Point 1'),
    type: 'point',
    definition: { kind: 'coordinates', x: '10mm', y: '0mm', z: '5mm' },
  },
  {
    ...base3('M18', 'Thread 1'),
    type: 'thread',
    face: r3('FM12:wall', 'face'),
    standard: 'ISO',
    size: 'M6',
  },
];

export const m3Statuses: FeatureStatus[] = m3Features.map((f): FeatureStatus => {
  const ok: FeatureStatus = { featureId: f.id, state: 'ok', cached: true, ms: 3 };
  if (f.id === 'M9') {
    return {
      ...ok,
      state: 'needsAttention',
      cached: false,
      unresolved: [{ path: '/openFaces/0', ref: r3('FM2:top', 'face'), reason: 'missing' }],
    };
  }
  if (f.id === 'M12') {
    return {
      ...ok,
      state: 'error',
      cached: false,
      error: {
        code: 'INTERNAL',
        message: 'The counterbore is deeper than the hole.',
        hint: 'Increase the depth or pick a smaller size.',
      },
    };
  }
  return ok;
});

export const feat = <T extends Feature['type']>(id: string) =>
  m3Features.find((f) => f.id === id) as Extract<Feature, { type: T }>;

/** Small ISO and ANSI hole tables for the wizard (all mm; ANSI converted from inches). */
export const holeTables: Record<'ISO' | 'ANSI', HoleTable> = {
  ISO: {
    standard: 'ISO',
    rows: [
      {
        size: 'M3',
        nominal: 3,
        clearance: { close: 3.2, normal: 3.4, loose: 3.6 },
        counterbore: { diameter: 6, depth: 3.4 },
        countersink: { diameter: 6.94, angle: 90 },
        tap: { drill: 2.5, pitch: 0.5 },
      },
      {
        size: 'M6',
        nominal: 6,
        clearance: { close: 6.4, normal: 6.6, loose: 7 },
        counterbore: { diameter: 11, depth: 6.5 },
        countersink: { diameter: 12.4, angle: 90 },
        tap: { drill: 5, pitch: 1 },
      },
      {
        size: 'M8',
        nominal: 8,
        clearance: { close: 8.4, normal: 9, loose: 10 },
        counterbore: { diameter: 15, depth: 8.5 },
        countersink: { diameter: 17.28, angle: 90 },
        tap: { drill: 6.8, pitch: 1.25 },
      },
    ],
  },
  ANSI: {
    standard: 'ANSI',
    rows: [
      {
        size: '#10',
        nominal: 4.826,
        clearance: { close: 5.055, normal: 5.1816, loose: 5.4864 },
        counterbore: { diameter: 8.382, depth: 4.826 },
        countersink: { diameter: 9.9, angle: 82 },
        tap: { drill: 3.8, pitch: 1.058 },
      },
      {
        size: '1/4',
        nominal: 6.35,
        clearance: { close: 6.5, normal: 6.6, loose: 6.9 },
        counterbore: { diameter: 11.1, depth: 6.35 },
        countersink: { diameter: 12.4, angle: 82 },
        tap: { drill: 5.1, pitch: 1.27 },
      },
    ],
  },
};
