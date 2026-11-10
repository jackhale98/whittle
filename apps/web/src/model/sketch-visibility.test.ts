import type { Feature, SketchFeature } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { isConsumed, sketchShown, type VisibilityContext } from './sketch-visibility';

const sketch = (id: string, visibility?: SketchFeature['visibility']): SketchFeature =>
  ({
    id,
    name: id,
    type: 'sketch',
    suppressed: false,
    plane: { name: 'origin:XY', kind: 'face' },
    entities: [],
    constraints: [],
    ...(visibility ? { visibility } : {}),
  }) as unknown as SketchFeature;
const extrude = (id: string, from: string): Feature =>
  ({
    id,
    name: id,
    type: 'extrude',
    suppressed: false,
    profile: [{ name: `S${from}:region(a)`, kind: 'region' }],
    direction: 'normal',
    end: { kind: 'blind', depth: '1' },
    op: 'new',
  }) as unknown as Feature;

const ctx = (features: Feature[], over: Partial<VisibilityContext> = {}): VisibilityContext => ({
  features,
  rollback: features.length,
  wantRegions: false,
  ...over,
});

describe('sketchShown (the one resolver for the viewport and the tree eye)', () => {
  it('auto: shown until a feature consumes it', () => {
    const s = sketch('A');
    expect(sketchShown(s, ctx([s]))).toBe(true);
    const f = [s, extrude('E', 'A')];
    expect(sketchShown(s, ctx(f))).toBe(false);
    expect(sketchShown(sketch('A', 'auto'), ctx(f))).toBe(false);
  });
  it('shown shows a consumed sketch; hidden hides an unconsumed one', () => {
    const consumed = [sketch('A', 'shown'), extrude('E', 'A')];
    expect(sketchShown(consumed[0] as SketchFeature, ctx(consumed))).toBe(true);
    const lone = sketch('A', 'hidden');
    expect(sketchShown(lone, ctx([lone]))).toBe(false);
  });
  it('picking a region brings a hidden sketch back; the active sketch is always shown', () => {
    const s = sketch('A', 'hidden');
    expect(sketchShown(s, ctx([s], { wantRegions: true }))).toBe(true);
    expect(sketchShown(s, ctx([s], { activeSketch: 'A' }))).toBe(true);
  });
  it('a rolled-back or suppressed sketch is never shown, whatever its setting (gate B2)', () => {
    for (const vis of [undefined, 'auto', 'shown'] as const) {
      const s = sketch('B', vis);
      const f = [sketch('A'), extrude('E', 'A'), s];
      expect(sketchShown(s, ctx(f, { rollback: 2 })), String(vis)).toBe(false);
      expect(sketchShown(s, ctx(f, { rollback: 2, wantRegions: true })), String(vis)).toBe(false);
      const off = { ...s, suppressed: true } as SketchFeature;
      expect(sketchShown(off, ctx([sketch('A'), off])), String(vis)).toBe(false);
    }
    // Sketch mode on it still shows it (its session owns the overlay).
    const s = sketch('B', 'shown');
    expect(sketchShown(s, ctx([s], { rollback: 0, activeSketch: 'B' }))).toBe(true);
  });
  it('editing the consuming feature shows an automatic sketch, not a hidden one', () => {
    const e = extrude('E', 'A');
    const auto = [sketch('A'), e];
    expect(sketchShown(auto[0] as SketchFeature, ctx(auto, { editing: e }))).toBe(true);
    const hidden = [sketch('A', 'hidden'), e];
    expect(sketchShown(hidden[0] as SketchFeature, ctx(hidden, { editing: e }))).toBe(false);
  });
  it('a rolled-back consumer no longer consumes the sketch', () => {
    const f = [sketch('A'), extrude('E', 'A')];
    expect(isConsumed(ctx(f, { rollback: 1 }), 'A')).toBe(false);
    expect(sketchShown(f[0] as SketchFeature, ctx(f, { rollback: 1 }))).toBe(true);
    expect(sketchShown(f[0] as SketchFeature, ctx(f, { rollback: 2 }))).toBe(false);
  });
});
