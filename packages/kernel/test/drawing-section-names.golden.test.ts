/**
 * Drawing kernel golden tests, section edge names (M4.1, ADR-095; contracts
 * `ProjectedCurve.cutFace`): every edge of a cut face names the model face the cut passes through
 * along it, and a step between cut segments names none. Real HLR in Node through
 * `DrawingWorkerApi`, both drawing kernel variants, on a BREP the main kernel makes.
 *
 * Part: a 40 × 30 × 10 box with a blind, flat-bottomed Ø10 hole at (20, 15), from the top down to
 * z = 4 (the cutting cylinder runs from z = 4 to z = 14, so the box top is cut, not touched). The
 * front view (x right, z up, looking along +y) shows the cut faces face-on, so view (u, v) = world
 * (x, z). The expected faces are found by geometry (fingerprints), never by guessing names.
 *
 * Cuts, all looking along +y (the material at the viewer's side of the line is removed):
 *  - full: the plane y = 15 through the hole's axis. One cut face, the box section with the hole's
 *    notch: 400 − 10 × 6 = 340 mm². Its eight edges name: the box bottom (z = 0), the sides
 *    (x = 0, x = 40), the box top twice (z = 10 beside the hole), the hole wall twice (x = 15 and
 *    x = 25, one cylinder) and the hole bottom (z = 4).
 *  - offset: y = 15 up to x = 30, a step along the viewing direction, then y = 5. Two cut faces
 *    (240 and 100 mm²). Their edges at x = 30 lie on the step face, which is the cutting tool's
 *    and no model face: they name none. Every other edge projects onto the full cut's edges and
 *    names the same faces.
 *  - bent: y = 15 up to x = 30, then towards (45, 0). The two cut faces meet at x = 30: that edge
 *    is between two cut faces and names none. Seen from the front, the same table as the offset
 *    cut (the bent face's top, bottom and side edges project onto z = 10, z = 0 and x = 40).
 * Each cut in exact (HLRBRep_Algo), draft (HLRBRep_PolyAlgo) and slice (the cut faces only).
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

const BOX = '01JBOX000000000000000SEC01';
const HOLE = '01JHOLE00000000000000SEC02';
const FRONT = { x: [1, 0, 0] as Vec3, y: [0, 0, 1] as Vec3 };
const EPS = 1e-6;

/** The model faces a cut edge can name, by role. */
type FaceRole = 'top' | 'bottom' | 'xmin' | 'xmax' | 'wall' | 'holeBottom';
const ROLES: readonly FaceRole[] = ['top', 'bottom', 'xmin', 'xmax', 'wall', 'holeBottom'];

/** A straight piece of a cut face's boundary in the view, and the face it names (null: none). */
interface Seg {
  a: Vec2;
  b: Vec2;
  face: FaceRole | null;
}
/** The full cut's boundary; the offset and bent cuts project onto the same lines. */
const BOUNDARY: readonly Seg[] = [
  { a: [0, 0], b: [40, 0], face: 'bottom' },
  { a: [0, 0], b: [0, 10], face: 'xmin' },
  { a: [40, 0], b: [40, 10], face: 'xmax' },
  { a: [0, 10], b: [15, 10], face: 'top' },
  { a: [25, 10], b: [40, 10], face: 'top' },
  { a: [15, 4], b: [15, 10], face: 'wall' },
  { a: [25, 4], b: [25, 10], face: 'wall' },
  { a: [15, 4], b: [25, 4], face: 'holeBottom' },
];
/** The offset cut's step and the bent cut's bend. */
const STEP: Seg = { a: [30, 0], b: [30, 10], face: null };

const CUTS = [
  {
    label: 'full cut through the hole axis',
    cut: [
      [-5, 15, 10],
      [45, 15, 10],
    ] as Vec3[],
    faces: ['section:0#0'],
    areas: [340],
    step: false,
  },
  {
    label: 'offset (stepped) cut',
    cut: [
      [-5, 15, 10],
      [30, 15, 10],
      [30, 5, 10],
      [45, 5, 10],
    ] as Vec3[],
    faces: ['section:0#0', 'section:2#0'],
    areas: [240, 100],
    step: true,
  },
  {
    label: 'bent cut (two cut faces meet)',
    cut: [
      [-5, 15, 10],
      [30, 15, 10],
      [45, 0, 10],
    ] as Vec3[],
    faces: ['section:0#0', 'section:1#0'],
    areas: [240, 100],
    step: true,
  },
] as const;

const MODES = [
  { label: 'exact', quality: 'exact', depth: 'full' },
  { label: 'draft', quality: 'draft', depth: 'full' },
  { label: 'slice', quality: 'exact', depth: 'slice' },
] as const;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A line's ends or a polyline's points; null for any other curve. */
function linePoints(c: Curve2): Vec2[] | null {
  if (c.kind === 'line') return [c.a, c.b];
  if (c.kind === 'polyline') return c.points;
  return null;
}

/** Parameter of `p` along `s` (0 at a, |ab| at b) and its distance from the segment's line. */
function along(p: Vec2, s: Seg): { t: number; off: number } {
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const px = p[0] - s.a[0];
  const py = p[1] - s.a[1];
  return { t: px * ux + py * uy, off: Math.abs(px * uy - py * ux) };
}

const segLength = (s: Seg) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

/** Whether every point of the curve lies on the segment (within EPS). */
function onSeg(c: ProjectedCurve, s: Seg): boolean {
  const pts = linePoints(c.curve);
  if (pts === null || pts.length === 0) return false;
  const len = segLength(s);
  return pts.every((p) => {
    const { t, off } = along(p, s);
    return off <= EPS && t >= -EPS && t <= len + EPS;
  });
}

/** Length of the union of the curves' extents along the segment. */
function covered(curves: ProjectedCurve[], s: Seg): number {
  const spans: [number, number][] = [];
  for (const c of curves) {
    const ts = (linePoints(c.curve) ?? []).map((p) => along(p, s).t);
    if (ts.length > 0) spans.push([Math.min(...ts), Math.max(...ts)]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const [a, b] of spans) {
    const from = Math.max(a, end);
    if (b > from) total += b - from;
    end = Math.max(end, b);
  }
  return total;
}

/** Extent of a curve (its points' bounding diagonal). */
function extent(c: ProjectedCurve): number {
  const pts = linePoints(c.curve) ?? [];
  if (pts.length === 0) return 0;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** Area enclosed by a loop of lines (shoelace on their start points, in loop order). */
function lineLoopArea(loop: Curve2[]): number {
  let a = 0;
  for (const c of loop) {
    if (c.kind !== 'line') throw new Error(`expected lines, got ${c.kind}`);
    a += c.a[0] * c.b[1] - c.b[0] * c.a[1];
  }
  return Math.abs(a) / 2;
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
    ? `drawing kernel golden, section edge names (${variant})`
    : `drawing kernel golden, section edge names (${variant}) — SKIPPED: build packages/kernel/dist and drawing/dist`;

  describe.skipIf(!built)(title, () => {
    let k: WhittleKernelModule;
    let s: Session;
    let api: DrawingWorkerApi;
    let blind: ShapeForDrawing;
    /** The persistent name of each face role, found by geometry. */
    const named = {} as Record<FaceRole, string>;

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
          frame: { origin: [20, 15, 4], z: [0, 0, 1], x: [1, 0, 0] },
        },
        { values: { '/radius': 5, '/height': 10 }, target: box.shape },
      );
      blind = forDrawing(k, s, holed, 'blind-hole@1');
      // The faces by geometry: planes by their centroid, the hole wall by its surface.
      const fp = s.fingerprints(holed.shape);
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
      const pick = (role: FaceRole, test: (f: (typeof fp.faces)[number]) => boolean) => {
        const hits = fp.faces.map((f, i) => (test(f) ? i : -1)).filter((i) => i >= 0);
        if (hits.length !== 1) throw new Error(`expected one ${role} face, found ${hits.length}`);
        const name = blind.faceNames[hits[0] ?? -1];
        if (name === undefined || name === '') throw new Error(`the ${role} face has no name`);
        named[role] = name;
      };
      const plane = (f: (typeof fp.faces)[number]) => f.surface === 'plane';
      pick('top', (f) => plane(f) && near(f.centroid[2], 10));
      pick('bottom', (f) => plane(f) && near(f.centroid[2], 0));
      pick('xmin', (f) => plane(f) && near(f.centroid[0], 0));
      pick('xmax', (f) => plane(f) && near(f.centroid[0], 40));
      pick('holeBottom', (f) => plane(f) && near(f.centroid[2], 4));
      pick('wall', (f) => f.surface === 'cylinder');
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
      const r = await api.loadShape({ ...blind, brep: blind.brep.slice() });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }, 120_000);

    afterAll(async () => {
      s?.releaseAll();
      if (api) {
        await api.releaseShape(blind.key);
        expect((await api.stats()).liveHandles).toBe(0);
      }
    });

    const view = async (extra: Partial<ViewProjectionRequest> = {}): Promise<ViewProjection> => {
      const r = await api.project({
        shapeKey: blind.key,
        frame: FRONT,
        quality: 'exact',
        hidden: true,
        smooth: true,
        ...extra,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };

    it('the model faces are the box and hole faces, all distinct', () => {
      const names = ROLES.map((r) => named[r]);
      expect(new Set(names).size).toBe(ROLES.length);
      for (const r of ['top', 'bottom', 'xmin', 'xmax'] as const) {
        expect(named[r].startsWith(`F${BOX}:`)).toBe(true);
      }
      expect(named.wall.startsWith(`F${HOLE}:`)).toBe(true);
      expect(named.holeBottom.startsWith(`F${HOLE}:`)).toBe(true);
    });

    it('a view without a section has no cut edges', async () => {
      for (const quality of ['exact', 'draft'] as const) {
        const v = await view({ quality });
        expect(v.curves.length).toBeGreaterThan(0);
        for (const c of v.curves) expect(c.cutFace).toBeUndefined();
      }
    });

    for (const cut of CUTS) {
      for (const mode of MODES) {
        it(`${cut.label}, ${mode.label}: every cut edge names the face it cuts${cut.step ? '; the step none' : ''}`, async () => {
          const v = await view({
            quality: mode.quality,
            section: { cut: [...cut.cut], along: [0, 0, -1], look: [0, 1, 0], depth: mode.depth },
          });
          // The cut is the one described above.
          expect(v.sectionFaces?.map((f) => f.face)).toEqual([...cut.faces]);
          (v.sectionFaces ?? []).forEach((f, i) => {
            expect(f.loops).toHaveLength(1);
            expect(Math.abs(lineLoopArea(f.loops[0] ?? []) - (cut.areas[i] ?? 0))).toBeLessThan(
              1e-9,
            );
          });

          const cutEdges = v.curves.filter((c) => c.cutFace !== undefined);
          // Every named cut edge lies on a boundary piece of the face it names.
          for (const c of cutEdges) {
            expect(linePoints(c.curve), `${c.cutFace} on a ${c.curve.kind}`).not.toBeNull();
            const fits = BOUNDARY.filter((sg) => onSeg(c, sg)).map((sg) =>
              sg.face === null ? '' : named[sg.face],
            );
            expect(fits, JSON.stringify(c.curve)).toContain(c.cutFace);
          }
          // Every boundary piece is covered, end to end, by edges naming its face: the top on both
          // sides of the hole, both hole-wall sides by the one cylinder, the hole bottom, the sides.
          for (const sg of BOUNDARY) {
            const face = named[sg.face as FaceRole];
            const mine = cutEdges.filter((c) => c.cutFace === face && onSeg(c, sg));
            expect(
              Math.abs(covered(mine, sg) - segLength(sg)),
              `${sg.face} ${JSON.stringify([sg.a, sg.b])}`,
            ).toBeLessThan(EPS);
          }
          // Exactly the six model faces are named; the hole wall on both sides of the hole.
          expect(new Set(cutEdges.map((c) => c.cutFace))).toEqual(
            new Set(ROLES.map((r) => named[r])),
          );
          // The step (or bend) is drawn, and names no face.
          const onStep = v.curves.filter((c) => onSeg(c, STEP) && extent(c) > EPS);
          if (cut.step) {
            expect(onStep.length).toBeGreaterThan(0);
            for (const c of onStep) expect(c.cutFace).toBeUndefined();
          } else {
            expect(onStep.every((c) => c.cutFace === undefined)).toBe(true);
          }
          // A slice draws the cut faces only: every curve but the step is a named cut edge, all
          // visible and sharp.
          if (mode.depth === 'slice') {
            for (const c of v.curves) {
              expect(c.role).toBe('visible');
              expect(c.edge).toBe('sharp');
              expect(c.name).toBeUndefined();
              if (!onSeg(c, STEP)) expect(c.cutFace, JSON.stringify(c.curve)).toBeDefined();
            }
          }
        });
      }
    }

    it('a cut edge is a section edge only: a detail clip keeps its name', async () => {
      const v = await view({
        hidden: false,
        section: {
          cut: [...CUTS[0].cut],
          along: [0, 0, -1],
          look: [0, 1, 0],
          depth: 'full',
        },
        clip: { center: [15, 7], radius: 2 },
      });
      // The clip circle crosses the hole wall's cut edge (x = 15, z 5…9).
      const wall = v.curves.filter((c) => c.cutFace === named.wall);
      expect(wall.length).toBeGreaterThan(0);
      for (const c of wall) {
        for (const p of linePoints(c.curve) ?? []) {
          expect(Math.abs(p[0] - 15)).toBeLessThan(EPS);
          expect(Math.hypot(p[0] - 15, p[1] - 7)).toBeLessThan(2 + EPS);
        }
      }
    });
  });
}
