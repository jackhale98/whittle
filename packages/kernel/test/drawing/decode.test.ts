/**
 * Drawing result decoding (src/drawing/decode.ts): `Curve2` validation and normalisation, edge
 * index → persistent name, section face names. No Wasm.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { decodeCurve, decodeProjection } from '../../src/drawing/decode';

const TWO_PI = 2 * Math.PI;
const line = { kind: 'line', a: [0, 0], b: [1, 0] };

describe('decodeCurve', () => {
  it('accepts every Curve2 kind', () => {
    expect(decodeCurve(line)).toEqual(line);
    expect(decodeCurve({ kind: 'arc', center: [1, 2], radius: 3, start: 0.5, end: 2 })).toEqual({
      kind: 'arc',
      center: [1, 2],
      radius: 3,
      start: 0.5,
      end: 2,
    });
    expect(
      decodeCurve({ kind: 'ellipse', center: [0, 0], major: [5, 0], ratio: 0.5, start: 0, end: 1 }),
    ).toMatchObject({ kind: 'ellipse', ratio: 0.5 });
    expect(
      decodeCurve({
        kind: 'bspline',
        degree: 2,
        poles: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
        knots: [0, 0, 0, 1, 1, 1],
        weights: [1, 0.7, 1],
      }),
    ).toMatchObject({ kind: 'bspline', weights: [1, 0.7, 1] });
    expect(
      decodeCurve({
        kind: 'polyline',
        points: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      }),
    ).toMatchObject({ kind: 'polyline' });
  });

  it('normalises a full circle to 0 → 2π', () => {
    expect(
      decodeCurve({ kind: 'arc', center: [0, 0], radius: 1, start: 1, end: 1 + TWO_PI - 1e-12 }),
    ).toEqual({ kind: 'arc', center: [0, 0], radius: 1, start: 0, end: TWO_PI });
  });

  it.each([
    ['an unknown kind', { kind: 'spiral' }],
    ['a non-finite point', { kind: 'line', a: [0, Number.NaN], b: [1, 0] }],
    ['a reversed arc', { kind: 'arc', center: [0, 0], radius: 1, start: 2, end: 1 }],
    ['an arc over 2π', { kind: 'arc', center: [0, 0], radius: 1, start: 0, end: 7 }],
    ['a zero radius', { kind: 'arc', center: [0, 0], radius: 0, start: 0, end: 1 }],
    [
      'an ellipse ratio over 1',
      { kind: 'ellipse', center: [0, 0], major: [1, 0], ratio: 2, start: 0, end: 1 },
    ],
    [
      'a B-spline with the wrong knot count',
      {
        kind: 'bspline',
        degree: 1,
        poles: [
          [0, 0],
          [1, 1],
        ],
        knots: [0, 0, 1],
      },
    ],
    [
      'decreasing knots',
      {
        kind: 'bspline',
        degree: 1,
        poles: [
          [0, 0],
          [1, 1],
        ],
        knots: [0, 1, 0, 1],
      },
    ],
    [
      'a weight per pole missing',
      {
        kind: 'bspline',
        degree: 1,
        poles: [
          [0, 0],
          [1, 1],
        ],
        knots: [0, 0, 1, 1],
        weights: [1],
      },
    ],
    ['a one-point polyline', { kind: 'polyline', points: [[0, 0]] }],
  ])('rejects %s', (_label, bad) => {
    expect(decodeCurve(bad)).toBeNull();
  });
});

describe('decodeProjection', () => {
  const names = ['F1:edge(a|b)', '', 'F1:edge(c|d)'];
  const faces = ['F1:face.side', '', 'F1:face.top'];
  const raw = (curves: unknown[], sectionFaces: unknown[] = []) => ({
    curves,
    sectionFaces,
    stats: { hlrMs: 1, cutMs: 0, edges: 3, faces: 2 },
  });

  it('maps edge indices to names; outlines, −1 and empty names stay unnamed', () => {
    const r = decodeProjection(
      raw([
        { role: 'visible', edge: 'sharp', index: 0, curve: line },
        { role: 'hidden', edge: 'smooth', index: 2, curve: line },
        { role: 'visible', edge: 'sharp', index: 1, curve: line },
        { role: 'visible', edge: 'outline', index: -1, curve: line },
        { role: 'visible', edge: 'outline', index: 0, curve: line },
      ]),
      names,
      faces,
      false,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.curves.map((c) => c.name)).toEqual([
      'F1:edge(a|b)',
      'F1:edge(c|d)',
      undefined,
      undefined,
      undefined,
    ]);
    expect(r.value.curves[1]).toMatchObject({ role: 'hidden', edge: 'smooth' });
    expect(r.value.sectionFaces).toBeUndefined();
  });

  it('an unnamed shape gives unnamed curves', () => {
    const r = decodeProjection(
      raw([{ role: 'visible', edge: 'sharp', index: 7, curve: line }]),
      [],
      [],
      false,
    );
    expect(r.ok && r.value.curves[0]?.name).toBeUndefined();
  });

  it('never guesses: an index past the names is an INTERNAL error', () => {
    const r = decodeProjection(
      raw([{ role: 'visible', edge: 'sharp', index: 3, curve: line }]),
      names,
      faces,
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INTERNAL');
  });

  it('names outlines by the face they outline; −1, absent and empty names stay unnamed', () => {
    const r = decodeProjection(
      raw([
        { role: 'visible', edge: 'outline', index: -1, face: 0, curve: line },
        { role: 'hidden', edge: 'outline', index: -1, face: 2, curve: line },
        { role: 'visible', edge: 'outline', index: -1, face: 1, curve: line },
        { role: 'visible', edge: 'outline', index: -1, face: -1, curve: line },
        { role: 'visible', edge: 'outline', index: -1, curve: line },
      ]),
      names,
      faces,
      false,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.curves.map((c) => c.face)).toEqual([
      'F1:face.side',
      'F1:face.top',
      undefined,
      undefined,
      undefined,
    ]);
    for (const c of r.value.curves) expect(c.name).toBeUndefined();
    expect(r.value.curves[1]).toMatchObject({ role: 'hidden', edge: 'outline' });
  });

  it('a seam on a silhouette keeps its edge name and names its face', () => {
    const r = decodeProjection(
      raw([
        { role: 'visible', edge: 'sharp', index: 0, face: 0, curve: line },
        { role: 'hidden', edge: 'sewn', index: 2, face: -1, curve: line },
      ]),
      names,
      faces,
      false,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.curves).toEqual([
      { role: 'visible', edge: 'sharp', name: 'F1:edge(a|b)', face: 'F1:face.side', curve: line },
      { role: 'hidden', edge: 'sewn', name: 'F1:edge(c|d)', curve: line },
    ]);
  });

  it('an unnamed shape gives unnamed outlines', () => {
    const r = decodeProjection(
      raw([{ role: 'visible', edge: 'outline', index: -1, face: 4, curve: line }]),
      [],
      [],
      false,
    );
    expect(r.ok && r.value.curves[0]?.face).toBeUndefined();
  });

  it('never guesses: a face past the names is an INTERNAL error', () => {
    const r = decodeProjection(
      raw([{ role: 'visible', edge: 'outline', index: -1, face: 3, curve: line }]),
      names,
      faces,
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INTERNAL');
      expect(r.error.message).toMatch(/face names/);
    }
  });

  it('rejects malformed curves and roles', () => {
    for (const bad of [
      { role: 'ghost', edge: 'sharp', index: 0, curve: line },
      { role: 'visible', edge: 'iso', index: 0, curve: line },
      { role: 'visible', edge: 'sharp', index: 0.5, curve: line },
      { role: 'visible', edge: 'outline', index: -1, face: '0', curve: line },
      { role: 'visible', edge: 'outline', index: -1, face: 1.5, curve: line },
      { role: 'visible', edge: 'sharp', index: 0, curve: { kind: 'line', a: [0, 0] } },
    ]) {
      const r = decodeProjection(raw([bad]), names, faces, false);
      expect(r.ok).toBe(false);
    }
    expect(decodeProjection({ nope: true }, names, faces, false).ok).toBe(false);
  });

  it('names section faces section:<segment>#<k> in the kernel order', () => {
    const loop = [line, { kind: 'line', a: [1, 0], b: [0, 0] }];
    const r = decodeProjection(
      raw(
        [],
        [
          { segment: 0, loops: [loop] },
          { segment: 0, loops: [loop, loop] },
          { segment: 2, loops: [loop] },
        ],
      ),
      names,
      faces,
      true,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sectionFaces?.map((f) => f.face)).toEqual([
      'section:0#0',
      'section:0#1',
      'section:2#0',
    ]);
    expect(r.value.sectionFaces?.[1]?.loops).toHaveLength(2);
  });

  it('a malformed section loop fails', () => {
    const r = decodeProjection(
      raw([], [{ segment: 0, loops: [[{ kind: 'x' }]] }]),
      names,
      faces,
      true,
    );
    expect(r.ok).toBe(false);
  });
});
