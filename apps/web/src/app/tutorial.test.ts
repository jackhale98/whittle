import type { Feature, SketchFeature, WhittleDoc } from '@whittle/contracts';
import { newDoc } from '@whittle/document';
import { rectangleCornerTool } from '@whittle/sketch';
import { bracketTutorial } from '@whittle/ui';
import { describe, expect, it } from 'vitest';
import {
  hasClosedLoop,
  paramsUsed,
  stepDone,
  type TutorialSnapshot,
  trackParams,
} from './tutorial';

function doc(features: Feature[], params: WhittleDoc['params'] = []): WhittleDoc {
  const d = newDoc({ name: 'T', firstPart: 'P' });
  const part = d.parts[0];
  if (!part) throw new Error('no part');
  return { ...d, params, parts: [{ ...part, features, rollbackIndex: features.length }] };
}

const rect = rectangleCornerTool([0, 0], [60, 40]);
const sketch = (over: Partial<SketchFeature> = {}): SketchFeature => ({
  id: 'S1',
  name: 'Sketch 1',
  type: 'sketch',
  suppressed: false,
  on: { name: 'origin:XY', kind: 'face' },
  entities: [],
  constraints: [],
  ...over,
});
const snap = (d: WhittleDoc, over: Partial<TutorialSnapshot> = {}): TutorialSnapshot => ({
  doc: d,
  statuses: undefined,
  editingDimension: null,
  exports: 0,
  paramsInUse: {},
  ...over,
});
const extrude = (op: 'new' | 'cut', depth = '6 mm'): Feature => ({
  id: op === 'cut' ? 'X2' : 'X1',
  name: 'Extrude',
  type: 'extrude',
  suppressed: false,
  profile: [{ name: 'SS1:region(a)', kind: 'region' }],
  direction: 'normal',
  end: { kind: 'blind', depth },
  op,
});

describe('bracket tutorial conditions', () => {
  it('covers every step of the bracket tutorial', () => {
    const d = doc([]);
    for (const s of bracketTutorial) expect(typeof stepDone(s.id, snap(d))).toBe('boolean');
    expect(stepDone('nope', snap(d))).toBe(false);
  });

  it('sketch → rectangle → dimension', () => {
    expect(stepDone('sketch', snap(doc([])))).toBe(false);
    expect(stepDone('sketch', snap(doc([sketch()])))).toBe(true);
    expect(stepDone('rectangle', snap(doc([sketch()])))).toBe(false);
    const drawn = sketch({ entities: rect.entities, constraints: rect.constraints });
    expect(hasClosedLoop(drawn)).toBe(true);
    expect(stepDone('rectangle', snap(doc([drawn])))).toBe(true);
    const open = sketch({
      entities: rect.entities.filter((_e, i) => i !== rect.entities.length - 1),
    });
    expect(hasClosedLoop(open)).toBe(false);
    const line = rect.entities.find((e) => e.kind === 'line');
    const dim = {
      id: 'D1',
      kind: 'distance' as const,
      a: line?.id ?? '',
      value: '60 mm',
      driving: true,
    };
    const dimensioned = doc([{ ...drawn, constraints: [...drawn.constraints, dim] } as Feature]);
    expect(stepDone('dimension', snap(dimensioned, { editingDimension: 'D1' }))).toBe(false);
    expect(stepDone('dimension', snap(dimensioned))).toBe(true);
  });

  it('extrude, holes (a cut) and fillet need a feature that rebuilt', () => {
    const d = doc([sketch(), extrude('new')]);
    expect(stepDone('extrude', snap(d))).toBe(true);
    expect(stepDone('holes', snap(d))).toBe(false);
    const failing = snap(d, {
      statuses: [{ featureId: 'X1', state: 'error', cached: false, ms: 0 }],
    });
    expect(stepDone('extrude', failing)).toBe(false);
    expect(stepDone('holes', snap(doc([extrude('new'), extrude('cut')])))).toBe(true);
    const fillet: Feature = {
      id: 'F1',
      name: 'Fillet 1',
      type: 'fillet',
      suppressed: false,
      edges: [],
      radius: '3 mm',
    };
    expect(stepDone('fillet', snap(doc([fillet])))).toBe(true);
  });

  it('params: a parameter a feature uses, changed after it was first used', () => {
    const p = { id: 'P1', name: 'param1', expr: '10 mm' };
    const unused = doc([extrude('new')], [p]);
    expect(paramsUsed(unused)).toEqual([]);
    const used = doc([extrude('new', 'param1')], [p]);
    expect(paramsUsed(used)).toEqual(['param1']);
    expect(paramsUsed(doc([extrude('new', 'param10')], [p]))).toEqual([]);
    const first = trackParams({}, used);
    expect(first).toEqual({ seen: { param1: '10 mm' }, changed: false });
    const edited = doc([extrude('new', 'param1')], [{ ...p, expr: '8 mm' }]);
    expect(stepDone('params', snap(used, { paramsInUse: first.seen }))).toBe(false);
    expect(stepDone('params', snap(edited, { paramsInUse: first.seen }))).toBe(true);
  });

  it('export counts exports since the tutorial started', () => {
    expect(stepDone('export', snap(doc([]), { exports: 0 }))).toBe(false);
    expect(stepDone('export', snap(doc([]), { exports: 1 }))).toBe(true);
  });
});
