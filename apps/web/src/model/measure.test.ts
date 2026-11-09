import type { PickHit, Vec3 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  labelText,
  type MeasurePick,
  measureLabel,
  measureMarkers,
  measureTargetFor,
  nextPicks,
  pickIdentity,
  remapPicks,
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

describe('measure picks across regens', () => {
  const mesh = (faces: string[], edges: string[] = [], vertices: number[] = []) => ({
    faceNames: faces,
    edgeNames: edges,
    vertexPositions: new Float32Array(vertices),
  });
  const at = (
    kind: 'face' | 'edge' | 'vertex',
    index: number,
    extra: Partial<MeasurePick> = {},
  ): MeasurePick => ({
    id: `${kind}${index}`,
    label: kind,
    kind,
    target: { bodyId: 'B1', kind, index },
    at: [0, 0, 0],
    ...extra,
  });

  it('records the persistent name (faces, edges) or the position (vertices) of a pick', () => {
    const m = mesh(['Ftop', 'Fside'], ['edge(a|b)'], [0, 0, 0, 1, 2, 3]);
    expect(pickIdentity({ bodyId: 'B1', kind: 'face', index: 1 }, m)).toEqual({ name: 'Fside' });
    expect(pickIdentity({ bodyId: 'B1', kind: 'edge', index: 0 }, m)).toEqual({
      name: 'edge(a|b)',
    });
    expect(pickIdentity({ bodyId: 'B1', kind: 'vertex', index: 1 }, m)).toEqual({
      vertexAt: [1, 2, 3],
    });
    expect(pickIdentity({ bodyId: 'B1', kind: 'face', index: 9 }, m)).toEqual({});
    expect(pickIdentity({ point: [0, 0, 0] }, m)).toEqual({});
  });

  it('re-finds faces and edges by name after an edit, dropping names that are gone', () => {
    const point: Vec3 = [1, 1, 1];
    const picks: MeasurePick[] = [
      at('face', 0, { name: 'Ftop' }),
      at('edge', 0, { name: 'edge(a|b)' }),
      at('face', 1, { name: 'Fpocket' }),
      { id: 'pt', label: 'Point', kind: 'point', target: { point }, at: point },
    ];
    // An undo removed the pocket and reordered the faces and edges.
    const after = mesh(['Fside', 'Fbottom', 'Ftop'], ['x', 'edge(a|b)']);
    const out = remapPicks(picks, [{ id: 'B1', mesh: after }]);
    expect(out.map((p) => p.id)).toEqual(['face0', 'edge0', 'pt']);
    expect(out[0]?.target).toEqual({ bodyId: 'B1', kind: 'face', index: 2 });
    expect(out[1]?.target).toEqual({ bodyId: 'B1', kind: 'edge', index: 1 });
    // Unchanged geometry keeps the very same picks.
    const same = remapPicks(picks.slice(0, 1), [{ id: 'B1', mesh: mesh(['Ftop']) }]);
    expect(same[0]).toBe(picks[0]);
  });

  it('never keeps an ordinal it cannot vouch for: unnamed picks, moved vertices, gone bodies', () => {
    const m = mesh(['Ftop'], [], [5, 5, 5]);
    expect(remapPicks([at('face', 0)], [{ id: 'B1', mesh: m }])).toEqual([]);
    const v = at('vertex', 0, { vertexAt: [5, 5, 5] });
    expect(remapPicks([v], [{ id: 'B1', mesh: m }])).toEqual([v]);
    expect(remapPicks([v], [{ id: 'B1', mesh: mesh(['Ftop'], [], [6, 5, 5]) }])).toEqual([]);
    expect(remapPicks([at('face', 0, { name: 'Ftop' })], [])).toEqual([]);
  });
});
