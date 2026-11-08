import type { EntityRef, ExtrudeFeature, Feature, SketchFeature } from '@whittle/contracts';
import { DocumentStoreImpl, newDoc } from '@whittle/document';
import { computeNesting, planUnitMove } from '@whittle/ui';
import { describe, expect, it } from 'vitest';
import { reorderFeatures } from './tree-edits';

const xy: EntityRef = { name: 'origin:XY', kind: 'face' };
const sketch = (id: string): SketchFeature => ({
  id,
  type: 'sketch',
  name: `Sketch ${id}`,
  suppressed: false,
  on: xy,
  entities: [],
  constraints: [],
});
const extrude = (id: string, sketchId: string): ExtrudeFeature => ({
  id,
  type: 'extrude',
  name: `Extrude ${id}`,
  suppressed: false,
  profile: [{ name: `S${sketchId}:region(e1)`, kind: 'region' }],
  direction: 'normal',
  end: { kind: 'blind', depth: '10 mm' },
  op: 'new',
});
/** A sketch placed on a face of an earlier feature. */
const sketchOnFace = (id: string, onFeature: string): SketchFeature => ({
  ...sketch(id),
  on: { name: `F${onFeature}:end`, kind: 'face' },
});

function storeWith(features: Feature[]) {
  const doc = newDoc({ firstPart: 'Part 1' });
  const part = doc.parts[0];
  if (!part) throw new Error('no part');
  const store = new DocumentStoreImpl({
    ...doc,
    parts: [{ ...part, features, rollbackIndex: features.length }],
  });
  return { store, partId: part.id };
}
const order = (store: DocumentStoreImpl) => store.getDoc().parts[0]?.features.map((f) => f.id);

describe('reorderFeatures (a feature moves with its nested sketch)', () => {
  const features = [sketch('A'), extrude('E', 'A'), sketch('B'), extrude('F', 'B')];

  it('applies a planned move as one undo step, sketch right before its feature', () => {
    const { store, partId } = storeWith(features);
    const steps = planUnitMove(features, computeNesting(features), 'F', 0);
    expect(steps).toHaveLength(2);
    expect(reorderFeatures(store, partId, steps, 'Move Extrude F')).toEqual({ ok: true });
    expect(order(store)).toEqual(['B', 'F', 'A', 'E']);
    expect(store.getDoc().parts[0]?.rollbackIndex).toBe(4);
    // a single undo restores everything, a single redo reapplies it
    expect(store.undo()).toBe(true);
    expect(order(store)).toEqual(['A', 'E', 'B', 'F']);
    expect(store.canUndo()).toBe(false);
    expect(store.redo()).toBe(true);
    expect(order(store)).toEqual(['B', 'F', 'A', 'E']);
  });

  it('moves down feature-first', () => {
    const { store, partId } = storeWith(features);
    const steps = planUnitMove(features, computeNesting(features), 'E', 1);
    expect(steps.map((s) => s.id)).toEqual(['E', 'A']);
    expect(reorderFeatures(store, partId, steps, 'Move Extrude E').ok).toBe(true);
    expect(order(store)).toEqual(['B', 'F', 'A', 'E']);
    // the nesting is the same afterwards
    const after = store.getDoc().parts[0]?.features ?? [];
    expect([...computeNesting(after).parentOf]).toEqual(
      expect.arrayContaining([
        ['A', 'E'],
        ['B', 'F'],
      ]),
    );
  });

  it('refuses the whole move when a later step is refused, leaving the document and history alone', () => {
    // C is placed on a face of E, so C (and G with it) cannot move above E
    const fs = [sketch('A'), extrude('E', 'A'), sketchOnFace('C', 'E'), extrude('G', 'C')];
    const { store, partId } = storeWith(fs);
    const before = store.getDoc();
    const steps = planUnitMove(fs, computeNesting(fs), 'G', 0);
    const r = reorderFeatures(store, partId, steps, 'Move G');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Can’t move/);
    expect(store.getDoc()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('a single step is also fine', () => {
    const fs = [sketch('A'), extrude('E', 'A'), extrude('X', 'A')];
    const { store, partId } = storeWith(fs);
    expect(reorderFeatures(store, partId, [{ id: 'E', toIndex: 2 }], 'Move E').ok).toBe(true);
    expect(order(store)).toEqual(['A', 'X', 'E']);
  });
});
