/**
 * Drawing request mapping (src/drawing/request.ts): validation, the orthonormal frame, tolerances,
 * projected bounds and the cache key. No Wasm.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ViewProjectionRequest } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  fnv1a64,
  orthonormalFrame,
  PROJECTION_FORMAT,
  projectionKey,
  toFacadeRequest,
  tolerancesFor,
  viewBounds,
} from '../../src/drawing/request';

const BOX = {
  min: [0, 0, 0] as [number, number, number],
  max: [40, 30, 10] as [number, number, number],
};
const FRONT = {
  x: [1, 0, 0] as [number, number, number],
  y: [0, 0, 1] as [number, number, number],
};

const request = (extra: Partial<ViewProjectionRequest> = {}): ViewProjectionRequest => ({
  shapeKey: 'part@1',
  frame: FRONT,
  quality: 'exact',
  hidden: true,
  smooth: false,
  ...extra,
});

describe('orthonormalFrame', () => {
  it('normalises x and makes y orthogonal to it (Gram–Schmidt)', () => {
    const f = orthonormalFrame({ x: [2, 0, 0], y: [1, 3, 0] });
    expect(f?.x).toEqual([1, 0, 0]);
    expect(f?.y[0]).toBeCloseTo(0, 15);
    expect(f?.y[1]).toBeCloseTo(1, 15);
  });

  it('rejects zero and parallel vectors', () => {
    expect(orthonormalFrame({ x: [0, 0, 0], y: [0, 1, 0] })).toBeNull();
    expect(orthonormalFrame({ x: [1, 0, 0], y: [2, 0, 0] })).toBeNull();
  });
});

describe('toFacadeRequest', () => {
  it('maps a plain view with the part-size tolerances', () => {
    const r = toFacadeRequest(request(), BOX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      frame: FRONT,
      quality: 'exact',
      hidden: true,
      smooth: false,
      ...tolerancesFor(BOX),
    });
    expect(r.value.section).toBeUndefined();
    expect(r.value.clip).toBeUndefined();
  });

  it('passes a section and a clip through', () => {
    const section = {
      cut: [
        [-5, 15, 10],
        [45, 15, 10],
      ] as [number, number, number][],
      along: [0, 0, -1] as [number, number, number],
      look: [0, 1, 0] as [number, number, number],
      depth: 'slice' as const,
    };
    const r = toFacadeRequest(request({ section, clip: { center: [20, 15], radius: 8 } }), BOX);
    expect(r.ok && r.value.section).toEqual(section);
    expect(r.ok && r.value.clip).toEqual({ center: [20, 15], radius: 8 });
  });

  it.each([
    ['no shape key', request({ shapeKey: '' })],
    ['a non-finite frame', request({ frame: { x: [Number.NaN, 0, 0], y: [0, 1, 0] } })],
    ['a degenerate frame', request({ frame: { x: [1, 0, 0], y: [3, 0, 0] } })],
    ['an unknown quality', request({ quality: 'fast' as 'draft' })],
    [
      'a one-point cut',
      request({ section: { cut: [[0, 0, 0]], along: [0, 0, 1], look: [0, 1, 0], depth: 'full' } }),
    ],
    [
      'a zero sweep direction',
      request({
        section: {
          cut: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          along: [0, 0, 0],
          look: [0, 1, 0],
          depth: 'full',
        },
      }),
    ],
    ['a zero clip radius', request({ clip: { center: [0, 0], radius: 0 } })],
  ])('rejects %s as INVALID_INPUT', (_label, bad) => {
    const r = toFacadeRequest(bad, BOX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });
});

describe('tolerancesFor', () => {
  it('scales with the part and clamps', () => {
    const t = tolerancesFor(BOX);
    const diag = Math.hypot(40, 30, 10);
    expect(t.linearDeflection).toBeCloseTo(diag * 2e-3, 12);
    expect(t.sampleTolerance).toBeCloseTo(diag * 1e-5, 12);
    const tiny = tolerancesFor({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(tiny.linearDeflection).toBe(0.01);
    expect(tiny.sampleTolerance).toBe(1e-4);
    const huge = tolerancesFor({ min: [0, 0, 0], max: [1e4, 1e4, 1e4] });
    expect(huge.linearDeflection).toBe(2);
    expect(huge.sampleTolerance).toBe(0.01);
  });
});

describe('viewBounds', () => {
  it('projects the 8 box corners (front view: x and z)', () => {
    expect(viewBounds(BOX, FRONT)).toEqual({ min: [0, 0], max: [40, 10] });
  });

  it('isometric view of the box', () => {
    const s2 = Math.SQRT2;
    const s6 = Math.sqrt(6);
    const b = viewBounds(BOX, { x: [1 / s2, 1 / s2, 0], y: [-1 / s6, 1 / s6, 2 / s6] });
    expect(b.min[0]).toBeCloseTo(0, 12);
    expect(b.max[0]).toBeCloseTo(70 / s2, 12);
    expect(b.min[1]).toBeCloseTo(-40 / s6, 12);
    expect(b.max[1]).toBeCloseTo((30 + 20) / s6, 12);
  });

  it('a detail view is its clip circle', () => {
    expect(viewBounds(BOX, FRONT, { center: [20, 5], radius: 4 })).toEqual({
      min: [16, 1],
      max: [24, 9],
    });
  });
});

describe('projectionKey', () => {
  it('FNV-1a 64 reference values', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('is stable across property order and changes with any field', () => {
    const a = request();
    const reordered: ViewProjectionRequest = {
      smooth: false,
      hidden: true,
      quality: 'exact',
      frame: { y: FRONT.y, x: FRONT.x },
      shapeKey: 'part@1',
    };
    expect(projectionKey(reordered)).toBe(projectionKey(a));
    expect(projectionKey(a).startsWith('part@1:')).toBe(true);
    expect(projectionKey(request({ quality: 'draft' }))).not.toBe(projectionKey(a));
    expect(projectionKey(request({ hidden: false }))).not.toBe(projectionKey(a));
    expect(projectionKey(request({ shapeKey: 'part@2' }))).not.toBe(projectionKey(a));
    expect(projectionKey(request({ clip: { center: [0, 0], radius: 1 } }))).not.toBe(
      projectionKey(a),
    );
  });

  it('is salted with the projection format, so projections cached without cutFace are not reused', () => {
    const a = request();
    const { shapeKey: _shapeKey, ...rest } = a;
    // M4.1 (ADR-095): section cut edges carry cutFace; the old, unsalted key must not match.
    expect(PROJECTION_FORMAT).toBe(2);
    expect(projectionKey(a)).not.toBe(`part@1:${fnv1a64(canonicalJson(rest))}`);
    expect(projectionKey(a)).toBe(`part@1:${fnv1a64(`v2:${canonicalJson(rest)}`)}`);
  });

  it('canonicalJson drops undefined members and sorts keys', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe('{"a":[1,{"c":2}],"b":1}');
  });
});
