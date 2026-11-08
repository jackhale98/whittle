import type { PickHit } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import {
  labelText,
  type MeasurePick,
  measureLabel,
  measureMarkers,
  measureTargetFor,
  nextPicks,
} from './measure';

const hit = (kind: PickHit['kind'], point: [number, number, number] = [1, 2, 3]): PickHit => ({
  bodyId: 'B1',
  kind,
  index: 4,
  point,
  distancePx: 0,
});

const pick = (id: string, at: [number, number, number] = [0, 0, 0]): MeasurePick => ({
  id,
  label: 'Face',
  kind: 'face',
  target: { bodyId: 'B1', kind: 'face', index: 0 },
  at,
});

describe('measure targets', () => {
  it('body sub-shapes by mesh ordinal, anything else as its point', () => {
    expect(measureTargetFor(hit('edge'))).toEqual({
      kind: 'edge',
      target: { bodyId: 'B1', kind: 'edge', index: 4 },
      at: [1, 2, 3],
    });
    expect(measureTargetFor(hit('region')).target).toEqual({ point: [1, 2, 3] });
  });
  it('keeps up to two picks; a third starts over', () => {
    const a = pick('a');
    const b = pick('b');
    const c = pick('c');
    expect(nextPicks([], a)).toEqual([a]);
    expect(nextPicks([a], b)).toEqual([a, b]);
    expect(nextPicks([a, b], c)).toEqual([c]);
  });
});

describe('measure display', () => {
  it('labels: distance (+ angle), length (+ radius), radius, area, angle, position', () => {
    expect(labelText({ distance: { value: 6, a: [0, 0, 0], b: [0, 0, 6] }, angle: Math.PI })).toBe(
      '6.00 mm · 180.00°',
    );
    expect(labelText({ length: 31.4159, radius: 5 })).toBe('31.42 mm · R 5.00');
    expect(labelText({ radius: 2.5 })).toBe('R 2.50 mm');
    expect(labelText({ area: 1800 })).toBe('1,800.0 mm²');
    expect(labelText({ angle: -Math.PI / 2 })).toBe('−90.00°');
    expect(labelText({ position: [1, -2, 3] })).toBe('1.00, −2.00, 3.00');
    expect(labelText({})).toBeNull();
  });
  it('markers: a dot per pick, the closest points and the line between them', () => {
    const picks = [pick('a', [0, 0, 0]), pick('b', [0, 0, 9])];
    const m = {
      distance: {
        value: 6,
        a: [0, 0, 1] as [number, number, number],
        b: [0, 0, 7] as [number, number, number],
      },
    };
    expect(measureMarkers(picks, m)).toEqual([
      {
        kind: 'point',
        points: [
          [0, 0, 0],
          [0, 0, 9],
        ],
        tone: 'muted',
      },
      {
        kind: 'point',
        points: [
          [0, 0, 1],
          [0, 0, 7],
        ],
        tone: 'accent',
      },
      {
        kind: 'line',
        points: [
          [0, 0, 1],
          [0, 0, 7],
        ],
        tone: 'accent',
      },
    ]);
    expect(measureMarkers([], null)).toEqual([]);
    // Touching targets: no zero-length line.
    expect(
      measureMarkers(picks, { distance: { value: 0, a: [0, 0, 0], b: [0, 0, 0] } }).map(
        (x) => x.kind,
      ),
    ).toEqual(['point', 'point']);
  });
  it('the label sits mid-distance, else at the pick', () => {
    const picks = [pick('a', [4, 4, 4])];
    expect(measureLabel(picks, { distance: { value: 2, a: [0, 0, 0], b: [0, 0, 2] } })?.at).toEqual(
      [0, 0, 1],
    );
    expect(measureLabel(picks, { area: 5 })?.at).toEqual([4, 4, 4]);
    expect(measureLabel(picks, null)).toBeNull();
  });
});
