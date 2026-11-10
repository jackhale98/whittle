import type { FeatureStatus, FilletFeature, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { newDoc } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import { describeEdgeName, explainStatus, followBlockedCauses } from './explain';

const SK = '01SKETCH000000000000000000';
const EX = '01EXTRUDE00000000000000000';
const FI = '01FILLET000000000000000000';

const sketch: SketchFeature = {
  id: SK,
  name: 'Sketch 1',
  suppressed: false,
  type: 'sketch',
  on: { name: 'origin:XY', kind: 'face' },
  entities: [
    { id: 'p1', kind: 'point', x: 0, y: 0, construction: false },
    { id: 'p2', kind: 'point', x: 10, y: 0, construction: false },
    { id: 'L1', kind: 'line', start: 'p1', end: 'p2', construction: false },
    { id: 'c', kind: 'point', x: 10, y: 5, construction: false },
    { id: 'p3', kind: 'point', x: 10, y: 10, construction: false },
    { id: 'A1', kind: 'arc', center: 'c', start: 'p2', end: 'p3', construction: false },
  ],
  constraints: [],
};

const top = (e: string) => `edge(F${EX}:end|F${EX}:side(S${SK}:e(${e})))`;

function docWith(propagate: boolean | undefined): WrenDoc {
  const d = newDoc({ name: 't', firstPart: 'Part 1' });
  const fillet: FilletFeature = {
    id: FI,
    name: 'Fillet 1',
    suppressed: false,
    type: 'fillet',
    edges: [{ name: top('L1'), kind: 'edge' }],
    radius: '1 mm',
    ...(propagate === undefined ? {} : { propagate }),
  };
  const extrude = {
    id: EX,
    name: 'Extrude 1',
    suppressed: false,
    type: 'extrude' as const,
    profile: [],
    direction: 'normal' as const,
    end: { kind: 'blind' as const, depth: '5 mm' },
    op: 'new' as const,
  };
  const part = d.parts[0];
  if (!part) throw new Error('no part');
  return { ...d, parts: [{ ...part, features: [sketch, extrude, fillet] }] };
}

const refused: FeatureStatus = {
  featureId: FI,
  state: 'error',
  cached: false,
  ms: 1,
  error: {
    code: 'UNSUPPORTED_FEATURE',
    message: 'The fillet cannot stop at tangent edges: 1 tangent edges continue the selection',
    entityRefs: [top('L1'), top('A1')],
  },
};

describe('explainStatus (propagate: false, ADR-040)', () => {
  it('names the tangent edges that would be pulled in and how to proceed', () => {
    const s = explainStatus(docWith(false), refused);
    expect(s.error?.message).toBe(
      'The fillet can’t stop at a tangent edge: 1 tangent edge continues the selection (the edge between the end face of Extrude 1 and the side of Arc 1 (Extrude 1)).',
    );
    expect(s.error?.hint).toMatch(/Propagate along tangent edges/);
    expect(s.error?.code).toBe('UNSUPPORTED_FEATURE');
    expect(s.error?.entityRefs).toEqual(refused.error?.entityRefs);
  });

  it('leaves other errors and propagating blends alone', () => {
    expect(explainStatus(docWith(true), refused)).toBe(refused);
    expect(explainStatus(docWith(undefined), refused)).toBe(refused);
    const other = { ...refused, error: { code: 'INVALID_INPUT' as const, message: 'x' } };
    expect(explainStatus(docWith(false), other)).toBe(other);
  });

  it('describes edges from their persistent names', () => {
    expect(describeEdgeName(docWith(false), top('L1'))).toBe(
      'the edge between the end face of Extrude 1 and the side of Line 1 (Extrude 1)',
    );
    expect(describeEdgeName(docWith(false), 'nonsense')).toBe('an edge');
  });
});

describe('followBlockedCauses (errors at the root cause)', () => {
  const st = (featureId: string, state: FeatureStatus['state'], cause?: FeatureStatus['cause']) =>
    ({ featureId, state, cached: false, ms: 0, ...(cause ? { cause } : {}) }) as FeatureStatus;

  it('follows blocked links to the first feature that is not blocked', () => {
    const out = followBlockedCauses([
      st('A', 'error'),
      st('B', 'blocked', { featureId: 'A', kind: 'failed' }),
      st('C', 'blocked', { featureId: 'B', kind: 'failed' }),
    ]);
    expect(out[2]?.cause).toEqual({ featureId: 'A', kind: 'failed' });
    expect(out[1]?.cause).toEqual({ featureId: 'A', kind: 'failed' });
  });
  it('never invents a cause and survives cycles', () => {
    const none = st('B', 'blocked');
    expect(followBlockedCauses([none])[0]).toBe(none);
    const out = followBlockedCauses([
      st('A', 'blocked', { featureId: 'B', kind: 'failed' }),
      st('B', 'blocked', { featureId: 'A', kind: 'failed' }),
    ]);
    expect(out).toHaveLength(2);
  });
});
