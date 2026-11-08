import type { PickKind } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import {
  bestCandidate,
  closestOnPolyline,
  defaultTolerance,
  distPointSegment2D,
  type ProjectFn,
  raycastTriangles,
  sortByDistance,
} from '../src/pick';

/** Orthographic "camera": world (x, y) -> px (x, y); z ignored. */
const ortho: ProjectFn = (x, y, _z, out) => {
  out.x = x;
  out.y = y;
  return true;
};

describe('distPointSegment2D', () => {
  it('measures perpendicular distance inside the segment', () => {
    const r = distPointSegment2D(5, 3, 0, 0, 10, 0);
    expect(r.d).toBeCloseTo(3);
    expect(r.t).toBeCloseTo(0.5);
  });

  it('clamps to the endpoints', () => {
    expect(distPointSegment2D(-4, 3, 0, 0, 10, 0).d).toBeCloseTo(5);
    expect(distPointSegment2D(14, 3, 0, 0, 10, 0).t).toBe(1);
  });

  it('handles a degenerate segment', () => {
    expect(distPointSegment2D(3, 4, 0, 0, 0, 0).d).toBeCloseTo(5);
  });
});

describe('closestOnPolyline', () => {
  const pts = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0]);

  it('finds the closest segment, parameter and world point', () => {
    const h = closestOnPolyline(pts, 0, 3, ortho, 12, 4);
    expect(h?.segment).toBe(1);
    expect(h?.distancePx).toBeCloseTo(2);
    expect(h?.point[0]).toBeCloseTo(10);
    expect(h?.point[1]).toBeCloseTo(4);
  });

  it('honours first/count offsets', () => {
    const all = Float32Array.from([100, 100, 0, 0, 0, 0, 10, 0, 0]);
    const h = closestOnPolyline(all, 1, 2, ortho, 5, 1);
    expect(h?.segment).toBe(0);
    expect(h?.distancePx).toBeCloseTo(1);
  });

  it('treats a single point as a point', () => {
    const h = closestOnPolyline(Float32Array.from([3, 4, 0]), 0, 1, ortho, 0, 0);
    expect(h?.distancePx).toBeCloseTo(5);
  });

  it('skips segments behind the camera', () => {
    const behind: ProjectFn = (x, y, z, out) => {
      out.x = x;
      out.y = y;
      return z >= 0;
    };
    const p = Float32Array.from([0, 0, 0, 10, 0, -1]);
    expect(closestOnPolyline(p, 0, 2, behind, 5, 0)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(closestOnPolyline(pts, 0, 0, ortho, 0, 0)).toBeNull();
  });
});

describe('candidate ordering', () => {
  const c = (kind: PickKind, distancePx: number) => ({ kind, distancePx });

  it('sorts by distance, ties by kind priority', () => {
    const sorted = sortByDistance([
      c('face', 0),
      c('edge', 5),
      c('vertex', 5),
      c('sketchPoint', 2),
    ]);
    expect(sorted.map((x) => x.kind)).toEqual(['face', 'sketchPoint', 'vertex', 'edge']);
  });

  it('best candidate prefers thin things over faces, then distance', () => {
    expect(bestCandidate([c('face', 0), c('edge', 5)])?.kind).toBe('edge');
    expect(bestCandidate([c('edge', 5), c('vertex', 20)])?.kind).toBe('vertex');
    expect(bestCandidate([c('edge', 5), c('edge', 3)])?.distancePx).toBe(3);
    expect(bestCandidate([])).toBeNull();
  });

  it('default tolerances follow the pointer type', () => {
    expect(defaultTolerance('mouse')).toBe(6);
    expect(defaultTolerance('pen')).toBe(10);
    expect(defaultTolerance('touch')).toBe(22);
  });
});

describe('raycastTriangles', () => {
  // Two triangles forming a unit square in z = 0, CCW seen from +z.
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);

  it('hits the nearest triangle with barycentrics', () => {
    const h = raycastTriangles([0.75, 0.25, 5], [0, 0, -1], positions, indices, 0, 2, true);
    expect(h?.tri).toBe(0);
    expect(h?.t).toBeCloseTo(5);
    expect(h?.u).toBeCloseTo(0.5); // weight on vertex b (1,0,0)
    expect(h?.v).toBeCloseTo(0.25); // weight on vertex c (1,1,0)
  });

  it('culls back faces when asked, but not otherwise', () => {
    expect(raycastTriangles([0.5, 0.2, -5], [0, 0, 1], positions, indices, 0, 2, true)).toBeNull();
    expect(
      raycastTriangles([0.5, 0.2, -5], [0, 0, 1], positions, indices, 0, 2, false)?.t,
    ).toBeCloseTo(5);
  });

  it('misses outside and respects the triangle range', () => {
    expect(raycastTriangles([2, 2, 5], [0, 0, -1], positions, indices, 0, 2, true)).toBeNull();
    // Point (0.25, 0.75) lies in the second triangle only.
    expect(
      raycastTriangles([0.25, 0.75, 5], [0, 0, -1], positions, indices, 0, 1, true),
    ).toBeNull();
    expect(raycastTriangles([0.25, 0.75, 5], [0, 0, -1], positions, indices, 1, 1, true)?.tri).toBe(
      1,
    );
  });
});
