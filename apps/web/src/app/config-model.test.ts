import type { Configuration, Feature } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  changedPointers,
  inheritCount,
  isMissingActive,
  mergeIssueStatuses,
  planFeatureEdit,
  summarizeMass,
} from './config-model';

const hole = (radius: string): Feature => ({
  id: 'H',
  type: 'primitive',
  name: 'Hole',
  suppressed: false,
  op: 'cut',
  shape: 'cylinder',
  radius,
  height: '40 mm',
});

describe('planFeatureEdit (scope at the point of edit)', () => {
  const raw = hole('4 mm');
  it('edits Default for an inherited value, and says which target', () => {
    const cfg: Configuration = { id: 'B', name: 'B' };
    const p = planFeatureEdit(raw, raw, hole('5 mm'), cfg, false);
    expect(p.overrides).toEqual([]);
    expect((p.defaultFeature as { radius: string }).radius).toBe('5 mm');
    expect(p.inherited).toEqual({ kind: 'field', featureId: 'H', path: '/radius' });
  });
  it('writes an override for an overridden value and leaves Default alone', () => {
    const cfg: Configuration = {
      id: 'B',
      name: 'B',
      features: { H: { fields: { '/radius': '6 mm' } } },
    };
    const p = planFeatureEdit(raw, hole('6 mm'), hole('7 mm'), cfg, false);
    expect(p.defaultFeature).toBeNull();
    expect(p.overrides).toEqual([{ path: '/radius', value: '7 mm' }]);
  });
  it('the chip routes one edit to the configuration; no state is kept', () => {
    const cfg: Configuration = { id: 'B', name: 'B' };
    const on = planFeatureEdit(raw, raw, hole('5 mm'), cfg, true);
    expect(on.overrides).toEqual([{ path: '/radius', value: '5 mm' }]);
    expect(on.defaultFeature).toBeNull();
    const off = planFeatureEdit(raw, raw, hole('5 mm'), cfg, false);
    expect(off.overrides).toEqual([]);
  });
  it('an override edited back to the Default value is cleared (sparse)', () => {
    const cfg: Configuration = {
      id: 'B',
      name: 'B',
      features: { H: { fields: { '/radius': '6 mm' } } },
    };
    const p = planFeatureEdit(raw, hole('6 mm'), hole('4 mm'), cfg, false);
    expect(p.overrides).toEqual([{ path: '/radius' }]);
  });
  it('never writes the override value into Default', () => {
    const cfg: Configuration = {
      id: 'B',
      name: 'B',
      features: { H: { fields: { '/radius': '6 mm' } } },
    };
    const eff = hole('6 mm');
    const next = { ...eff, height: '30 mm' } as Feature;
    const p = planFeatureEdit(raw, eff, next, cfg, false);
    expect((p.defaultFeature as { radius: string; height: string }).radius).toBe('4 mm');
    expect((p.defaultFeature as { height: string }).height).toBe('30 mm');
  });
});

describe('configuration helpers', () => {
  it('changedPointers lists leaf differences', () => {
    expect(changedPointers({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toEqual(['/b/c']);
  });
  it('inheritCount counts Default and the configurations that do not override', () => {
    const part = {
      id: 'P',
      name: 'P',
      features: [],
      rollbackIndex: 0,
      configurations: [
        { id: 'A', name: 'A', params: { x: '1 mm' } },
        { id: 'B', name: 'B' },
      ],
    };
    expect(inheritCount(part, { kind: 'param', paramId: 'x' })).toBe(2);
    expect(inheritCount(part, { kind: 'param', paramId: 'y' })).toBe(3);
  });
  it('a missing active id is detected, Default is not missing', () => {
    const base = { id: 'P', name: 'P', features: [], rollbackIndex: 0 };
    expect(isMissingActive({ ...base, activeConfigurationId: 'X' })).toBe(true);
    expect(isMissingActive(base)).toBe(false);
    expect(
      isMissingActive({
        ...base,
        configurations: [{ id: 'X', name: 'X' }],
        activeConfigurationId: 'X',
      }),
    ).toBe(false);
  });
  it('merges issues into statuses without hiding kernel errors', () => {
    const s = mergeIssueStatuses(
      [
        { featureId: 'a', state: 'ok', cached: false, ms: 0 },
        { featureId: 'b', state: 'error', cached: false, ms: 0 },
      ],
      [
        {
          configurationId: 'c',
          target: { kind: 'field', featureId: 'a', path: '/x' },
          reason: 'bad',
        },
        { configurationId: 'c', target: { kind: 'suppressed', featureId: 'b' }, reason: 'bad' },
      ],
      'Long',
    );
    expect(s[0]?.state).toBe('needsAttention');
    expect(s[0]?.error?.message).toContain('In Long');
    expect(s[1]?.state).toBe('error');
  });
  it('sums mass over bodies', () => {
    const m = summarizeMass([
      { massProperties: { volume: 2, area: 1, centroid: [0, 0, 0], mass: 1 } },
      { massProperties: { volume: 2, area: 1, centroid: [2, 0, 0], mass: 3 } },
    ] as unknown as Parameters<typeof summarizeMass>[0]);
    expect(m?.mass).toBe(4);
    expect(m?.centroid[0]).toBe(1);
  });
});
