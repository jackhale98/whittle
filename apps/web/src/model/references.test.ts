import type { Feature, PickHit, ReferenceResult } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { refForHit } from '../selection/pick';
import {
  isOriginName,
  isReferenceName,
  originShown,
  referenceName,
  referenceRef,
  referenceShown,
  viewportReferences,
} from './references';

const base = { suppressed: false, name: 'x' };
const plane = (id: string, visibility?: 'auto' | 'shown' | 'hidden', name = 'Plane 1'): Feature =>
  ({
    ...base,
    id,
    name,
    type: 'plane',
    definition: { kind: 'offset', from: { name: 'origin:XY', kind: 'face' }, distance: '5 mm' },
    ...(visibility ? { visibility } : {}),
  }) as Feature;
const axis = (id: string, visibility?: 'hidden'): Feature =>
  ({
    ...base,
    id,
    name: 'Axis 1',
    type: 'axis',
    definition: {
      kind: 'twoPoints',
      a: { name: 'a', kind: 'vertex' },
      b: { name: 'b', kind: 'vertex' },
    },
    ...(visibility ? { visibility } : {}),
  }) as Feature;
const frame = {
  origin: [0, 0, 5],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as ReferenceResult['frame'];
const res = (id: string, kind: ReferenceResult['kind']): ReferenceResult => ({
  featureId: id,
  kind,
  frame,
  extent: 60,
});

describe('reference geometry in the view (ADR-093)', () => {
  it('names and entity kinds: plane = face, axis = edge, point = vertex', () => {
    expect(referenceName('01A', 'plane')).toBe('F01A:plane');
    expect(referenceRef('01A', 'plane')).toEqual({ name: 'F01A:plane', kind: 'face' });
    expect(referenceRef('01A', 'axis')).toEqual({ name: 'F01A:axis', kind: 'edge' });
    expect(referenceRef('01A', 'point')).toEqual({ name: 'F01A:point', kind: 'vertex' });
    expect(isReferenceName('F01A:axis')).toBe(true);
    expect(isReferenceName('F01A:face.top')).toBe(false);
    expect(isOriginName('origin:XZ')).toBe(true);
    expect(isOriginName('origin:W')).toBe(false);
  });

  it('absent or auto is shown, hidden is not; an unevaluated reference is never shown', () => {
    const ev = new Set(['P1']);
    expect(referenceShown(plane('P1'), ev)).toBe(true);
    expect(referenceShown(plane('P1', 'auto'), ev)).toBe(true);
    expect(referenceShown(plane('P1', 'shown'), ev)).toBe(true);
    expect(referenceShown(plane('P1', 'hidden'), ev)).toBe(false);
    expect(referenceShown(plane('P2'), ev)).toBe(false); // suppressed / failed / rolled back: no result
  });

  it('hands the viewport only shown references, labelled with the feature name', () => {
    const features = [plane('P1'), axis('A1', 'hidden'), plane('P2', undefined, 'Mid')];
    const { refs, shown } = viewportReferences(
      { references: [res('P1', 'plane'), res('A1', 'axis'), res('P2', 'plane')] },
      features,
    );
    expect(refs.map((r) => [r.name, r.label, r.kind])).toEqual([
      ['FP1:plane', 'Plane 1', 'plane'],
      ['FP2:plane', 'Mid', 'plane'],
    ]);
    expect([...shown].sort()).toEqual(['P1', 'P2']);
    expect(viewportReferences(undefined, features).refs).toEqual([]);
  });

  it('origin planes: the toggle, or while the sketch plane chooser is open', () => {
    expect(originShown(false, false)).toBe(false);
    expect(originShown(true, false)).toBe(true);
    expect(originShown(false, true)).toBe(true);
  });

  it('a picked plane, axis or point is its own EntityRef, no kernel query', async () => {
    const never = async () => {
      throw new Error('the engine must not be asked');
    };
    const h = (bodyId: string, kind: PickHit['kind']): PickHit => ({
      bodyId,
      kind,
      index: 0,
      entity: 'reference',
      point: [0, 0, 0],
      distancePx: 0,
    });
    expect(await refForHit(h('FP1:plane', 'face'), 'part', never)).toEqual({
      name: 'FP1:plane',
      kind: 'face',
    });
    expect(await refForHit(h('FA1:axis', 'edge'), 'part', never)).toEqual({
      name: 'FA1:axis',
      kind: 'edge',
    });
    expect(await refForHit(h('origin:XY', 'face'), 'part', never)).toEqual({
      name: 'origin:XY',
      kind: 'face',
    });
    expect(await refForHit(h('FQ:point', 'vertex'), 'part', never)).toEqual({
      name: 'FQ:point',
      kind: 'vertex',
    });
  });
});
