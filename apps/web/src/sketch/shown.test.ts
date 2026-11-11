import type { SketchFeature } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { displayFeature } from './shown';

const f = (): SketchFeature => ({
  id: 'S1',
  type: 'sketch',
  name: 'Sketch 1',
  suppressed: false,
  on: { name: 'origin:XY', kind: 'face' },
  entities: [{ id: 'P', kind: 'point', construction: false, x: 1, y: 2 }],
  constraints: [],
});

describe('displayFeature (an open sketch drawn for the values in force)', () => {
  it('draws the solved geometry only for the stored entities it was solved from', () => {
    const stored = f();
    const moved = [{ id: 'P', kind: 'point' as const, construction: false, x: 9, y: 9 }];
    const shown = { for: stored.entities, entities: moved, constraints: [] };
    expect(displayFeature(stored, shown).entities).toEqual(moved);
    expect(stored.entities[0]).toMatchObject({ x: 1 }); // the stored sketch is never touched
    // The stored sketch changed since (an edit, undo): the display state is stale and ignored.
    expect(displayFeature({ ...stored, entities: [...stored.entities] }, shown)).toEqual({
      ...stored,
      entities: stored.entities,
    });
    expect(displayFeature(stored, null)).toBe(stored);
  });
});
