import type { Feature, WrenDoc } from '@wren-cad/contracts';
import { newDoc } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import { featureLineage, selectionLineage } from './lineage';

const SK = '01SKETCH000000000000000000';
const EX = '01EXTRUDE00000000000000000';
const FI = '01FILLET000000000000000000';

const base = { suppressed: false } as const;
const features: Feature[] = [
  {
    ...base,
    id: SK,
    name: 'Sketch 1',
    type: 'sketch',
    on: { name: 'origin:XY', kind: 'face' },
    entities: [],
    constraints: [],
  },
  {
    ...base,
    id: EX,
    name: 'Extrude 1',
    type: 'extrude',
    profile: [{ name: `S${SK}:region(a,b)`, kind: 'region' }],
    direction: 'normal',
    end: { kind: 'blind', depth: '5 mm' },
    op: 'new',
  },
  {
    ...base,
    id: FI,
    name: 'Fillet 1',
    type: 'fillet',
    edges: [{ name: `edge(F${EX}:end|F${EX}:side(S${SK}:e(L1)))`, kind: 'edge' }],
    radius: '1 mm',
  },
];

function doc(): WrenDoc {
  const d = newDoc({ name: 't', firstPart: 'Part 1' });
  const part = d.parts[0];
  if (!part) throw new Error('no part');
  return { ...d, parts: [{ ...part, features }] };
}

describe('selection lineage ("Made by")', () => {
  it('names the feature and its sketch from a persistent name', () => {
    const l = selectionLineage(doc(), `F${EX}:side(S${SK}:e(L1))`);
    expect(l.madeBy).toEqual({ id: EX, name: 'Extrude 1' });
    expect(l.sketch).toEqual({ id: SK, name: 'Sketch 1' });
  });
  it('takes the latest feature in history names such as fillet faces', () => {
    const l = selectionLineage(doc(), `F${FI}:fillet(F${EX}:side(S${SK}:e(L1)))`);
    expect(l.madeBy?.name).toBe('Fillet 1');
    expect(l.sketch?.name).toBe('Sketch 1'); // the sketch of the feature it built on
  });
  it('has nothing for geometry no feature made', () => {
    expect(selectionLineage(doc(), 'origin:XY')).toEqual({});
  });
});

describe('feature lineage (parents and children)', () => {
  it('an extrude is built from its sketch and used by the fillet', () => {
    const l = featureLineage(doc(), EX);
    expect(l.parents.map((p) => p.name)).toEqual(['Sketch 1']);
    expect(l.children.map((p) => p.name)).toEqual(['Fillet 1']);
  });
  it('a fillet is built from the extrude (the latest feature its edge names), not the sketch', () => {
    const l = featureLineage(doc(), FI);
    expect(l.parents.map((p) => p.name)).toEqual(['Extrude 1']);
    expect(l.children).toEqual([]);
  });
  it('a sketch has the extrude as a child', () => {
    expect(featureLineage(doc(), SK).children.map((p) => p.name)).toEqual(['Extrude 1']);
  });
});
