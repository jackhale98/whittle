import { describe, expect, it } from 'vitest';
import { MAX_RADIAL_ITEMS, modelRadialIds, sketchRadialIds, sketchToolOf } from './radial';

describe('radial contents', () => {
  it('never exceeds seven items (Repeat is the eighth slot)', () => {
    const sets = [
      modelRadialIds([]),
      modelRadialIds([{ kind: 'face', planar: true }]),
      modelRadialIds([{ kind: 'face', planar: false }]),
      modelRadialIds([
        { kind: 'face', planar: true },
        { kind: 'face', planar: true },
      ]),
      modelRadialIds([{ kind: 'edge' }]),
      modelRadialIds([{ kind: 'vertex' }]),
      modelRadialIds([{ kind: 'region' }]),
      modelRadialIds([{ kind: 'edge' }, { kind: 'face' }]),
      sketchRadialIds(),
    ];
    for (const s of sets) {
      expect(s.length).toBeLessThanOrEqual(MAX_RADIAL_ITEMS);
      expect(new Set(s).size).toBe(s.length);
    }
  });

  it('is chosen by what is selected', () => {
    expect(modelRadialIds([{ kind: 'face', planar: true }])).toContain('pushPull');
    expect(modelRadialIds([{ kind: 'face', planar: false }])).toContain('thread');
    expect(modelRadialIds([{ kind: 'edge' }])).toEqual(['fillet', 'chamfer', 'measure']);
    expect(modelRadialIds([{ kind: 'region' }])).toContain('extrude');
    expect(modelRadialIds([])).toContain('fit');
  });

  it('maps sketch ids to tools', () => {
    expect(sketchToolOf('sketch:line')).toBe('line');
    expect(sketchToolOf('sketch:finish')).toBeNull();
    expect(sketchToolOf('pushPull')).toBeNull();
  });
});
