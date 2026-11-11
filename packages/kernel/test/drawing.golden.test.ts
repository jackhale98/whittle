/**
 * Drawing kernel golden tests (ADR-090 amendment): real HLR in Node through `DrawingWorkerApi`,
 * both drawing kernel variants, on BREPs the main kernel makes (as `shapeForDrawing` hands them
 * over). Parts: a 40 × 30 × 10 box with a Ø10 through hole at (20, 15), and a Ø20 × 20 cylinder.
 * Golden numbers are analytic; the counts were cross-checked against OCCT 8.0.1 built natively.
 *
 * Views (frames as `ViewProjectionRequest.frame`; the viewer looks along −x × y):
 *  - front: x right, z up (looks along +y, sees face.ymin);
 *  - top: x right, y up (looks down);
 *  - iso: from (1, −1, 1).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Curve2,
  KernelVariant,
  ProjectedCurve,
  ShapeForDrawing,
  Vec2,
  Vec3,
  ViewProjection,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrawingKernelApi, type DrawingWorkerApi } from '../src/drawing/api';
import type { DrawingInitModule } from '../src/drawing/facade';
import type { WhittleKernelModule } from '../src/index';
import { loadVariant, ok, type RawFeatureResult, Session, variantBuilt } from './helpers';

const drawingDist = fileURLToPath(new URL('../drawing/dist/', import.meta.url));
const DRAWING_INIT: Record<KernelVariant, string> = {
  single: 'init.single.js',
  threaded: 'init.multi.js',
};
const drawingBuilt = (v: KernelVariant) => existsSync(`${drawingDist}${DRAWING_INIT[v]}`);
const loadDrawing = (v: KernelVariant) => () =>
  import(pathToFileURL(`${drawingDist}${DRAWING_INIT[v]}`).href) as Promise<DrawingInitModule>;

const BOX = '01JBOX000000000000000HLR01';
const HOLE = '01JHOLE00000000000000HLR02';
const CYL = '01JCYL000000000000000HLR03';
const TWO_PI = 2 * Math.PI;
const s2 = Math.SQRT2;
const s6 = Math.sqrt(6);
const FRONT = { x: [1, 0, 0] as Vec3, y: [0, 0, 1] as Vec3 };
const TOP = { x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3 };
const ISO = { x: [1 / s2, 1 / s2, 0] as Vec3, y: [-1 / s6, 1 / s6, 2 / s6] as Vec3 };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** `role/edge/kind` counts. */
function census(curves: ProjectedCurve[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of curves) {
    const k = `${c.role}/${c.edge}/${c.curve.kind}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const kinds = (curves: ProjectedCurve[], kind: Curve2['kind']) =>
  curves.filter((c) => c.curve.kind === kind).length;

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Area enclosed by a loop of lines (shoelace on their start points, in loop order). */
function lineLoopArea(loop: Curve2[]): number {
  let a = 0;
  for (const c of loop) {
    if (c.kind !== 'line') throw new Error(`expected lines, got ${c.kind}`);
    a += c.a[0] * c.b[1] - c.b[0] * c.a[1];
  }
  return Math.abs(a) / 2;
}

function sameSegment(c: Curve2, p: Vec2, q: Vec2, eps = 1e-9): boolean {
  if (c.kind !== 'line') return false;
  const d = (u: Vec2, v: Vec2) => Math.hypot(u[0] - v[0], u[1] - v[1]);
  return (d(c.a, p) < eps && d(c.b, q) < eps) || (d(c.a, q) < eps && d(c.b, p) < eps);
}

/** A `ShapeForDrawing` from a main-kernel result: BREP bytes, names by TopExp index, bounds. */
function forDrawing(
  k: WhittleKernelModule,
  s: Session,
  r: RawFeatureResult,
  key: string,
): ShapeForDrawing {
  const ex = ok<{ path: string }>(
    k.exportShapes(JSON.stringify([{ shape: r.shape, name: key }]), 'brep', '{}'),
  );
  const brep = k.FS.readFile(ex.path, { encoding: 'binary' }).slice();
  k.FS.unlink(ex.path);
  const byIndex = (kind: 'edge' | 'face') => {
    const out: string[] = [];
    for (const n of r.naming) if (n.kind === kind) out[n.index] = n.name;
    return Array.from(out, (x) => x ?? '');
  };
  const mp = s.mass(r.shape);
  return { key, brep, edgeNames: byIndex('edge'), faceNames: byIndex('face'), bounds: mp.bbox };
}

// ---------------------------------------------------------------------------------------------

const MAIN_BUILT = variantBuilt('single');

for (const variant of ['single', 'threaded'] as const) {
  const built = MAIN_BUILT && drawingBuilt(variant);
  const title = built
    ? `drawing kernel golden (${variant})`
    : `drawing kernel golden (${variant}) — SKIPPED: build packages/kernel/dist and drawing/dist`;

  describe.skipIf(!built)(title, () => {
    let k: WhittleKernelModule;
    let s: Session;
    let api: DrawingWorkerApi;
    let boxHole: ShapeForDrawing;
    let cylinder: ShapeForDrawing;
    /** TopExp index of the hole's top and bottom rims and of its seam, from fingerprints. */
    let rimTop = -1;
    let rimBottom = -1;

    beforeAll(async () => {
      k = await loadVariant('single');
      s = new Session(k);
      const base = { name: 'F', suppressed: false } as const;
      const box = s.exec(
        {
          ...base,
          id: BOX,
          type: 'primitive',
          op: 'new',
          shape: 'box',
          dx: '40',
          dy: '30',
          dz: '10',
        },
        { values: { '/dx': 40, '/dy': 30, '/dz': 10 } },
      );
      const holed = s.exec(
        {
          ...base,
          id: HOLE,
          type: 'primitive',
          op: 'cut',
          shape: 'cylinder',
          radius: '5',
          height: '10',
          frame: { origin: [20, 15, 0], z: [0, 0, 1], x: [1, 0, 0] },
        },
        { values: { '/radius': 5, '/height': 10 }, target: box.shape },
      );
      const cyl = s.exec(
        {
          ...base,
          id: CYL,
          type: 'primitive',
          op: 'new',
          shape: 'cylinder',
          radius: '10',
          height: '20',
        },
        { values: { '/radius': 10, '/height': 20 } },
      );
      boxHole = forDrawing(k, s, holed, 'box-hole@1');
      cylinder = forDrawing(k, s, cyl, 'cylinder@1');
      const fp = s.fingerprints(holed.shape);
      fp.edges.forEach((e, i) => {
        if (e.curve !== 'circle') return;
        if (close(e.centroid[2], 10, 1e-6)) rimTop = i;
        if (close(e.centroid[2], 0, 1e-6)) rimBottom = i;
      });
      api = createDrawingKernelApi({
        variants: {
          single: { load: loadDrawing('single') },
          threaded: { load: loadDrawing('threaded') },
        },
        canUseThreads: () => variant === 'threaded',
        threads: 2,
      });
      const info = await api.init({ variant });
      if (!info.ok) throw new Error(JSON.stringify(info.error));
      expect(info.value.occtVersion).toBe('8.0.1');
      for (const shape of [boxHole, cylinder]) {
        const r = await api.loadShape({ ...shape, brep: shape.brep.slice() });
        if (!r.ok) throw new Error(JSON.stringify(r.error));
      }
    }, 120_000);

    afterAll(async () => {
      s?.releaseAll();
      if (api) {
        await api.releaseShape(boxHole.key);
        await api.releaseShape(cylinder.key);
        expect((await api.stats()).liveHandles).toBe(0);
      }
    });

    const view = async (
      shape: ShapeForDrawing,
      frame: { x: Vec3; y: Vec3 },
      extra: Partial<ViewProjectionRequest> = {},
    ): Promise<ViewProjection> => {
      const r = await api.project({
        shapeKey: shape.key,
        frame,
        quality: 'exact',
        hidden: true,
        smooth: true,
        ...extra,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };

    it('loads idempotently and reports the BREP counts the names must match', async () => {
      expect(boxHole.edgeNames).toHaveLength(15);
      expect(await api.hasShape(boxHole.key)).toBe(true);
      expect((await api.loadShape({ ...boxHole, brep: boxHole.brep.slice() })).ok).toBe(true);
      const bad = await api.loadShape({
        ...boxHole,
        key: 'box-hole@bad',
        brep: boxHole.brep.slice(),
        edgeNames: boxHole.edgeNames.slice(1),
      });
      expect(bad.ok === false && bad.error.code).toBe('INVALID_INPUT');
    });

    describe('box with a hole, exact', () => {
      it('front view: 4 visible lines, 9 hidden lines and the hidden hole outline', async () => {
        const v = await view(boxHole, FRONT);
        expect(census(v.curves)).toEqual({
          'visible/sharp/line': 4,
          'hidden/sharp/line': 9,
          'hidden/outline/line': 1,
        });
        expect(kinds(v.curves, 'arc')).toBe(0);
        // The visible outline is face.ymin's four edges, by name.
        const visible = v.curves.filter((c) => c.role === 'visible');
        for (const c of visible) expect(c.name).toMatch(/face\.ymin/);
        const rect: [Vec2, Vec2][] = [
          [
            [0, 0],
            [40, 0],
          ],
          [
            [40, 0],
            [40, 10],
          ],
          [
            [40, 10],
            [0, 10],
          ],
          [
            [0, 10],
            [0, 0],
          ],
        ];
        for (const [p, q] of rect)
          expect(visible.some((c) => sameSegment(c.curve, p, q))).toBe(true);
        // The hole: its silhouettes at x = 15 (outline, unnamed) and x = 25 (its seam, named).
        const outline = v.curves.find((c) => c.edge === 'outline');
        expect(outline?.name).toBeUndefined();
        expect(outline && sameSegment(outline.curve, [15, 0], [15, 10])).toBe(true);
        expect(v.bounds).toEqual({ min: [0, 0], max: [40, 10] });
      });

      it('top view: the hole is one exact visible circle and one hidden', async () => {
        const v = await view(boxHole, TOP);
        expect(census(v.curves)).toEqual({
          'visible/sharp/line': 4,
          'visible/sharp/arc': 1,
          'hidden/sharp/line': 4,
          'hidden/sharp/arc': 1,
        });
        for (const role of ['visible', 'hidden'] as const) {
          const arc = v.curves.find((c) => c.role === role && c.curve.kind === 'arc');
          expect(arc?.curve).toEqual({
            kind: 'arc',
            center: [20, 15],
            radius: 5,
            start: 0,
            end: TWO_PI,
          });
          // Names map back: the visible rim is the top circle, the hidden one the bottom.
          expect(arc?.name).toBe(boxHole.edgeNames[role === 'visible' ? rimTop : rimBottom]);
        }
      });

      it('iso view: rims are full exact ellipses (ratio 1/√3), silhouettes hidden', async () => {
        const v = await view(boxHole, ISO);
        expect(census(v.curves)).toEqual({
          'visible/sharp/line': 9,
          'visible/sharp/ellipse': 1,
          'hidden/sharp/line': 3,
          'hidden/sharp/ellipse': 1,
          'hidden/outline/line': 2,
          'hidden/sewn/line': 1,
        });
        const top = v.curves.find((c) => c.role === 'visible' && c.curve.kind === 'ellipse');
        expect(top?.name).toBe(boxHole.edgeNames[rimTop]);
        if (top?.curve.kind !== 'ellipse') return;
        expect(close(top.curve.ratio, 1 / Math.sqrt(3))).toBe(true);
        expect(close(Math.hypot(...top.curve.major), 5)).toBe(true);
        // Centre: (20, 15, 10) projected.
        expect(close(top.curve.center[0], 35 / s2)).toBe(true);
        expect(close(top.curve.center[1], (-20 + 15 + 20) / s6)).toBe(true);
        expect([top.curve.start, top.curve.end]).toEqual([0, TWO_PI]);
      });

      it('hidden: false and smooth: false drop hidden lines and seams', async () => {
        const v = await view(boxHole, ISO, { hidden: false, smooth: false });
        expect(census(v.curves)).toEqual({ 'visible/sharp/line': 9, 'visible/sharp/ellipse': 1 });
      });
    });

    describe('cylinder, exact', () => {
      it('front view: rectangle; the seam is the right silhouette, the left is an outline', async () => {
        const v = await view(cylinder, FRONT);
        expect(census(v.curves)).toEqual({
          'visible/sharp/line': 3,
          'visible/outline/line': 1,
          'hidden/sharp/line': 2,
        });
        const outline = v.curves.find((c) => c.edge === 'outline');
        expect(outline && sameSegment(outline.curve, [-10, 0], [-10, 20])).toBe(true);
        expect(v.bounds).toEqual({ min: [-10, 0], max: [10, 20] });
      });

      it('top view: one exact circle each, centre and radius exact', async () => {
        const v = await view(cylinder, TOP);
        expect(v.curves).toHaveLength(2);
        for (const c of v.curves) {
          expect(c.curve).toEqual({
            kind: 'arc',
            center: [0, 0],
            radius: 10,
            start: 0,
            end: TWO_PI,
          });
        }
        expect(v.curves.find((c) => c.role === 'visible')?.name).toMatch(/face\.zmax/);
        expect(v.curves.find((c) => c.role === 'hidden')?.name).toMatch(/face\.zmin/);
      });

      it('iso view: top rim whole, bottom rim half visible and half hidden', async () => {
        const v = await view(cylinder, ISO);
        expect(census(v.curves)).toEqual({
          'visible/sharp/ellipse': 2,
          'visible/outline/line': 2,
          'visible/sewn/line': 1,
          'hidden/sharp/ellipse': 1,
        });
        const hidden = v.curves.find((c) => c.role === 'hidden');
        if (hidden?.curve.kind !== 'ellipse') throw new Error('expected a hidden ellipse');
        expect(close(hidden.curve.end - hidden.curve.start, Math.PI)).toBe(true);
      });
    });

    describe('draft (PolyAlgo)', () => {
      it('front view: the same visible outline as exact, as lines and polylines', async () => {
        const v = await view(boxHole, FRONT, { quality: 'draft' });
        for (const c of v.curves) expect(['line', 'polyline']).toContain(c.curve.kind);
        const visible = v.curves.filter((c) => c.role === 'visible');
        expect(visible).toHaveLength(4);
        for (const c of visible) expect(c.name).toMatch(/face\.ymin/);
        expect(v.curves.some((c) => c.role === 'hidden' && c.edge === 'outline')).toBe(true);
      });

      it('top view: the hole rim is a closed polyline on the circle', async () => {
        const v = await view(boxHole, TOP, { quality: 'draft' });
        const rim = v.curves.find((c) => c.role === 'visible' && c.curve.kind === 'polyline');
        expect(rim?.name).toBe(boxHole.edgeNames[rimTop]);
        if (rim?.curve.kind !== 'polyline') return;
        for (const p of rim.curve.points) {
          expect(Math.abs(Math.hypot(p[0] - 20, p[1] - 15) - 5)).toBeLessThan(1e-6);
        }
        const first = rim.curve.points[0];
        const last = rim.curve.points.at(-1);
        expect(first).toEqual(last);
      });
    });

    describe('section views', () => {
      const throughHole = {
        cut: [
          [-5, 15, 10],
          [45, 15, 10],
        ] as Vec3[],
        along: [0, 0, -1] as Vec3,
        look: [0, 1, 0] as Vec3,
      };

      it('full section through the hole: two cut faces of 150 mm², the far wall named', async () => {
        const v = await view(boxHole, FRONT, {
          hidden: false,
          section: { ...throughHole, depth: 'full' },
        });
        expect(v.sectionFaces?.map((f) => f.face)).toEqual(['section:0#0', 'section:0#1']);
        for (const f of v.sectionFaces ?? []) {
          expect(f.loops).toHaveLength(1);
          expect(close(lineLoopArea(f.loops[0] ?? []), 150)).toBe(true);
        }
        expect(census(v.curves)).toEqual({ 'visible/sharp/line': 10 });
        // The far half of the hole is seen through the cut: its rims keep their names.
        const named = v.curves.filter((c) => c.name !== undefined).map((c) => c.name);
        expect(named).toContain(boxHole.edgeNames[rimTop]);
        expect(named).toContain(boxHole.edgeNames[rimBottom]);
        expect(v.bounds).toEqual({ min: [0, 0], max: [40, 10] });
      });

      it('slice: only the cut faces, unnamed', async () => {
        const v = await view(boxHole, FRONT, { section: { ...throughHole, depth: 'slice' } });
        expect(census(v.curves)).toEqual({ 'visible/sharp/line': 8 });
        expect(v.curves.every((c) => c.name === undefined)).toBe(true);
        expect(v.sectionFaces).toHaveLength(2);
      });

      it('offset (stepped) section: one face per stepped segment', async () => {
        const v = await view(boxHole, FRONT, {
          hidden: false,
          section: {
            cut: [
              [-5, 15, 10],
              [20, 15, 10],
              [20, 5, 10],
              [45, 5, 10],
            ],
            along: [0, 0, -1],
            look: [0, 1, 0],
            depth: 'full',
          },
        });
        expect(v.sectionFaces?.map((f) => f.face)).toEqual(['section:0#0', 'section:2#0']);
        const areas = (v.sectionFaces ?? []).map((f) => lineLoopArea(f.loops[0] ?? []));
        expect(close(areas[0] ?? 0, 150)).toBe(true);
        expect(close(areas[1] ?? 0, 200)).toBe(true);
      });

      it('a cylinder cut through its axis: one 20 × 20 face', async () => {
        const v = await view(cylinder, FRONT, {
          hidden: false,
          section: {
            cut: [
              [-20, 0, 20],
              [20, 0, 20],
            ],
            along: [0, 0, -1],
            look: [0, 1, 0],
            depth: 'full',
          },
        });
        expect(v.sectionFaces).toHaveLength(1);
        expect(close(lineLoopArea(v.sectionFaces?.[0]?.loops[0] ?? []), 400)).toBe(true);
      });

      it('a cut line along the viewing direction is refused', async () => {
        const r = await api.project({
          shapeKey: boxHole.key,
          frame: FRONT,
          quality: 'exact',
          hidden: false,
          smooth: false,
          section: {
            cut: [
              [20, -5, 10],
              [20, 35, 10],
            ],
            along: [0, 0, -1],
            look: [0, 1, 0],
            depth: 'full',
          },
        });
        expect(r.ok === false && r.error.code).toBe('INVALID_INPUT');
      });
    });

    describe('detail views', () => {
      it('a clip around the hole keeps the two exact rims', async () => {
        const v = await view(boxHole, TOP, { clip: { center: [20, 15], radius: 8 } });
        expect(census(v.curves)).toEqual({ 'visible/sharp/arc': 1, 'hidden/sharp/arc': 1 });
        expect(v.bounds).toEqual({ min: [12, 7], max: [28, 23] });
      });

      it('a clip across the rim keeps one exact arc each, ending on the clip circle', async () => {
        const v = await view(boxHole, TOP, { clip: { center: [25, 15], radius: 3 } });
        expect(census(v.curves)).toEqual({ 'visible/sharp/arc': 1, 'hidden/sharp/arc': 1 });
        const alpha = Math.acos(0.82); // half-angle of the chord: (25 + 25 − 9) / 50
        for (const c of v.curves) {
          if (c.curve.kind !== 'arc') continue;
          expect(c.curve.center).toEqual([20, 15]);
          expect(c.curve.radius).toBe(5);
          expect(close(c.curve.end - c.curve.start, 2 * alpha)).toBe(true);
          expect(close(c.curve.start, TWO_PI - alpha)).toBe(true);
        }
      });

      it('a clip at a corner cuts the outline to 10 mm lines', async () => {
        const v = await view(boxHole, TOP, { clip: { center: [0, 0], radius: 10 } });
        expect(census(v.curves)).toEqual({ 'visible/sharp/line': 2, 'hidden/sharp/line': 2 });
        for (const c of v.curves) {
          if (c.curve.kind !== 'line') continue;
          expect(
            close(Math.hypot(c.curve.b[0] - c.curve.a[0], c.curve.b[1] - c.curve.a[1]), 10),
          ).toBe(true);
        }
      });
    });
  });
}
