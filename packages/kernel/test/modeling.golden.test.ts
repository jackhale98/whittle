/**
 * M1 modeling golden tests: sketch regions, extrude, revolve, fillet, chamfer, boolean, plane,
 * primitives, persistent naming (naming.ts) and the "edit upstream" stability scenarios
 * (PLAN §7.3). Golden numbers are analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, NamingEntry } from '@whittle/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  circle,
  extrude,
  frameAt,
  indexOf,
  line,
  loadVariant,
  meshShape,
  names,
  profileRefs,
  pt,
  type RawFeatureResult,
  rect,
  relClose,
  Session,
  sketch,
  sketchInputs,
  suiteTitle,
  VARIANTS,
  variantBuilt,
  vecClose,
} from './helpers';

const SK = '01JSKETCH00000000000000001';
const S = `S${SK}`;
const EX = '01JEXTRUDE0000000000000001';
const E = `F${EX}`;
const FI = '01JFILLET00000000000000001';
const BOX = '01JBOX00000000000000000001';

const PI = Math.PI;

function regionNames(r: RawFeatureResult): string[] {
  return names(r, 'face').filter((n) => n.startsWith(`${S}:region(`));
}

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('modeling', variant), () => {
    let k: WhittleKernelModule;
    let s: Session;
    let baseline = 0;

    beforeAll(async () => {
      k = await loadVariant(variant);
      baseline = k.liveHandleCount();
    }, 60_000);

    afterEach(() => {
      s?.releaseAll();
      expect(k.liveHandleCount()).toBe(baseline);
    });

    afterAll(() => {
      if (k) expect(k.liveHandleCount()).toBe(baseline);
    });

    const session = () => {
      s = new Session(k);
      return s;
    };

    /** Sketch + blind extrude of the given entities; returns both results. */
    const sketchAndExtrude = (
      ss: Session,
      entities: Parameters<typeof sketch>[1],
      region: string,
      depth = 10,
      feature: Feature = extrude(EX),
      extra: Partial<FeatureInputs> = {},
    ) => {
      const sk = ss.exec(sketch(SK, entities), sketchInputs());
      const ex = ss.exec(feature, {
        values: { '/end/depth': depth },
        refs: profileRefs(sk.shape, [indexOf(sk, region, 'face')]),
        ...extra,
      });
      return { sk, ex };
    };

    // ---------------------------------------------------------------------------------------
    // Sketch regions
    // ---------------------------------------------------------------------------------------

    describe('sketch', () => {
      it('rectangle with a circular hole: the plate region has one inner loop', () => {
        const ss = session();
        const r = ss.exec(
          sketch(SK, [...rect(0, 0, 40, 30), ...circle('C1', 20, 15, 5)]),
          sketchInputs(),
        );
        expect(regionNames(r).sort()).toEqual([`${S}:region(C1)`, `${S}:region(L1,L2,L3,L4|C1)`]);
        expect(r.regions).toEqual([`${S}:region(C1)`, `${S}:region(L1,L2,L3,L4|C1)`]);
        const fp = ss.fingerprints(r.shape);
        const plate = indexOf(r, `${S}:region(L1,L2,L3,L4|C1)`, 'face');
        const disk = indexOf(r, `${S}:region(C1)`, 'face');
        relClose(fp.faces[plate]?.area ?? 0, 1200 - 25 * PI, 1e-9);
        relClose(fp.faces[disk]?.area ?? 0, 25 * PI, 1e-9);
        vecClose(fp.faces[plate]?.normal ?? [], [0, 0, 1], 1e-12);
        expect(fp.faces[plate]?.surface).toBe('plane');
        // Curves and points by entity id; the circle's centre is a free vertex.
        expect(names(r, 'edge').sort()).toEqual(
          ['C1', 'L1', 'L2', 'L3', 'L4'].map((id) => `${S}:e(${id})`).sort(),
        );
        expect(names(r, 'vertex').sort()).toEqual(
          ['C1c', 'p1', 'p2', 'p3', 'p4'].map((id) => `${S}:p(${id})`).sort(),
        );
        vecClose(r.frame?.origin ?? [], [0, 0, 0], 1e-12);
        vecClose(r.frame?.z ?? [], [0, 0, 1], 1e-12);
        vecClose(r.frame?.x ?? [], [1, 0, 0], 1e-12);
        const e1 = fp.edges[indexOf(r, `${S}:e(L1)`, 'edge')];
        vecClose(e1?.centroid ?? [], [20, 0, 0]);
        expect(e1?.curve).toBe('line');
      });

      it('two disjoint rectangles give two regions', () => {
        const ss = session();
        const r = ss.exec(
          sketch(SK, [...rect(0, 0, 10, 10), ...rect(20, 0, 30, 10, 'q', 'M')]),
          sketchInputs(),
        );
        expect(regionNames(r).sort()).toEqual([
          `${S}:region(L1,L2,L3,L4)`,
          `${S}:region(M1,M2,M3,M4)`,
        ]);
      });

      it('nested loops: plate, ring and core', () => {
        const ss = session();
        const r = ss.exec(
          sketch(SK, [
            ...rect(0, 0, 40, 40),
            ...circle('C1', 20, 20, 10),
            ...circle('C2', 20, 20, 4),
          ]),
          sketchInputs(),
        );
        expect(regionNames(r).sort()).toEqual(
          [`${S}:region(C1|C2)`, `${S}:region(C2)`, `${S}:region(L1,L2,L3,L4|C1)`].sort(),
        );
        const fp = ss.fingerprints(r.shape);
        relClose(
          fp.faces[indexOf(r, `${S}:region(C1|C2)`, 'face')]?.area ?? 0,
          PI * (100 - 16),
          1e-9,
        );
      });

      it('overlapping rectangles split each other; split curves get #k', () => {
        const ss = session();
        const r = ss.exec(
          sketch(SK, [...rect(0, 0, 20, 20), ...rect(10, 10, 30, 30, 'q', 'M')]),
          sketchInputs(),
        );
        const regions = regionNames(r).sort();
        expect(regions).toHaveLength(3);
        // Lens (overlap) is bounded by L2, L3 (pieces) and M1, M4 (pieces).
        expect(regions).toContain(`${S}:region(L2,L3,M1,M4)`);
        const fp = ss.fingerprints(r.shape);
        const lens = indexOf(r, `${S}:region(L2,L3,M1,M4)`, 'face');
        relClose(fp.faces[lens]?.area ?? 0, 100, 1e-9);
        // L2 (x = 20, y 0..20) is cut at y = 10 by M1 → two pieces ordered by centroid.
        const l2 = [`${S}:e(L2)#0`, `${S}:e(L2)#1`].map((n) => fp.edges[indexOf(r, n, 'edge')]);
        vecClose(l2[0]?.centroid ?? [], [20, 5, 0]);
        vecClose(l2[1]?.centroid ?? [], [20, 15, 0]);
        expect(names(r, 'edge')).not.toContain(`${S}:e(L2)`);
        expect(names(r, 'edge')).toContain(`${S}:e(L1)`);
      });

      it('open polylines and construction geometry make no region', () => {
        const ss = session();
        const r = ss.exec(
          sketch(SK, [
            pt('a', 0, 0),
            pt('b', 10, 0),
            pt('c', 10, 10),
            line('l1', 'a', 'b'),
            line('l2', 'b', 'c'),
            line('k', 'c', 'a', true),
          ]),
          sketchInputs(),
        );
        expect(regionNames(r)).toEqual([]);
        expect(r.regions).toEqual([]);
        expect(names(r, 'edge').sort()).toEqual([`${S}:e(k)`, `${S}:e(l1)`, `${S}:e(l2)`]);
        // Free (construction) curves still get display polylines.
        const m = meshShape(k, r.shape, 0.1);
        expect(m.edgeRanges.length).toBe(6);
        for (let e = 0; e < 3; e++) expect(m.edgeRanges[2 * e + 1]).toBeGreaterThanOrEqual(2);
      });

      it('arcs close loops with lines (slot) and sit on a placed plane', () => {
        const ss = session();
        // Slot: two lines and two arcs, centred on (0,0), 20 long, 6 wide, on z = 5.
        const r = ss.exec(
          sketch(SK, [
            pt('a', -10, -3),
            pt('b', 10, -3),
            pt('c', 10, 3),
            pt('d', -10, 3),
            pt('cr', 10, 0),
            pt('cl', -10, 0),
            line('bot', 'a', 'b'),
            { id: 'ar', kind: 'arc', center: 'cr', start: 'b', end: 'c', construction: false },
            line('top', 'c', 'd'),
            { id: 'al', kind: 'arc', center: 'cl', start: 'd', end: 'a', construction: false },
          ]),
          sketchInputs(frameAt([0, 0, 5])),
        );
        expect(regionNames(r)).toEqual([`${S}:region(al,ar,bot,top)`]);
        const fp = ss.fingerprints(r.shape);
        const f = fp.faces[indexOf(r, `${S}:region(al,ar,bot,top)`, 'face')];
        relClose(f?.area ?? 0, 20 * 6 + PI * 9, 1e-9);
        vecClose(f?.centroid ?? [], [0, 0, 5]);
      });

      it('rejects broken sketches with structured errors', () => {
        const ss = session();
        const zero = ss.fail(
          sketch(SK, [pt('a', 1, 1), pt('b', 1, 1), line('l', 'a', 'b')]),
          sketchInputs(),
        );
        expect(zero.code).toBe('INVALID_INPUT');
        expect(zero.entityRefs).toEqual([`${S}:e(l)`]);
        expect(ss.fail(sketch(SK, [line('l', 'a', 'b')]), sketchInputs()).code).toBe(
          'INVALID_INPUT',
        );
        expect(
          ss.fail(
            sketch(SK, [
              pt('c', 0, 0),
              { id: 'o', kind: 'circle', center: 'c', radius: 0, construction: false },
            ]),
            sketchInputs(),
          ).code,
        ).toBe('INVALID_INPUT');
      });
    });

    // ---------------------------------------------------------------------------------------
    // Extrude
    // ---------------------------------------------------------------------------------------

    describe('extrude', () => {
      const plate = [...rect(0, 0, 40, 30), ...circle('C1', 20, 15, 5)];
      const plateRegion = `${S}:region(L1,L2,L3,L4|C1)`;

      it('40×30 plate with a Ø10 hole by 10: volume, faces, names', () => {
        const ss = session();
        const { ex } = sketchAndExtrude(ss, plate, plateRegion);
        const mp = ss.mass(ex.shape);
        relClose(mp.volume, 40 * 30 * 10 - PI * 25 * 10, 1e-9);
        expect(mp.faceCount).toBe(7);
        vecClose(mp.bbox.min, [0, 0, 0]);
        vecClose(mp.bbox.max, [40, 30, 10]);
        const faces = names(ex, 'face').sort();
        expect(faces).toEqual(
          [
            `${E}:end`,
            `${E}:side(${S}:e(C1))`,
            `${E}:side(${S}:e(L1))`,
            `${E}:side(${S}:e(L2))`,
            `${E}:side(${S}:e(L3))`,
            `${E}:side(${S}:e(L4))`,
            `${E}:start`,
          ].sort(),
        );
        for (const kind of ['face', 'edge', 'vertex'] as const) {
          const n = names(ex, kind);
          expect(new Set(n).size, kind).toBe(n.length);
        }
        expect(names(ex, 'edge')).toContain(`edge(${E}:end|${E}:side(${S}:e(L1)))`);
        expect(names(ex, 'edge')).toContain(`edge(${E}:side(${S}:e(L1))|${E}:side(${S}:e(L2)))`);
        // The hole's seam: the cylinder face meets itself.
        expect(names(ex, 'edge')).toContain(`edge(${E}:side(${S}:e(C1))|${E}:side(${S}:e(C1)))`);
        expect(names(ex, 'vertex')).toContain(
          `vertex(${E}:end|${E}:side(${S}:e(L1))|${E}:side(${S}:e(L2)))`,
        );
        const fp = ss.fingerprints(ex.shape);
        vecClose(fp.faces[indexOf(ex, `${E}:end`, 'face')]?.normal ?? [], [0, 0, 1], 1e-12);
        vecClose(fp.faces[indexOf(ex, `${E}:start`, 'face')]?.normal ?? [], [0, 0, -1], 1e-12);
        vecClose(
          fp.faces[indexOf(ex, `${E}:side(${S}:e(L1))`, 'face')]?.normal ?? [],
          [0, -1, 0],
          1e-12,
        );
        // Mesh names line up with the naming map.
        const m = meshShape(k, ex.shape, 0.05);
        for (const n of ex.naming) {
          if (n.kind === 'face') expect(m.meta.faceNames[n.index]).toBe(n.name);
          if (n.kind === 'edge') expect(m.meta.edgeNames[n.index]).toBe(n.name);
        }
      });

      it('symmetric and reverse directions', () => {
        const ss = session();
        const sym = sketchAndExtrude(
          ss,
          plate,
          plateRegion,
          10,
          extrude(EX, { direction: 'symmetric' }),
        );
        const mp = ss.mass(sym.ex.shape);
        vecClose(mp.bbox.min, [0, 0, -5]);
        vecClose(mp.bbox.max, [40, 30, 5]);
        relClose(mp.volume, 12000 - 250 * PI, 1e-9);
        const rev = sketchAndExtrude(
          ss,
          plate,
          plateRegion,
          4,
          extrude(EX, { direction: 'reverse' }),
        );
        const mr = ss.mass(rev.ex.shape);
        vecClose(mr.bbox.min, [0, 0, -4]);
        vecClose(mr.bbox.max, [40, 30, 0]);
        // Start stays on the sketch plane.
        const fp = ss.fingerprints(rev.ex.shape);
        vecClose(
          fp.faces[indexOf(rev.ex, `${E}:start`, 'face')]?.centroid ?? [],
          [20, 15, 0],
          1e-6,
        );
      });

      it('two regions extrude together (start/end split #k)', () => {
        const ss = session();
        const sk = ss.exec(
          sketch(SK, [...rect(0, 0, 10, 10), ...rect(20, 0, 30, 10, 'q', 'M')]),
          sketchInputs(),
        );
        const ex = ss.exec(extrude(EX, { profiles: 2 }), {
          values: { '/end/depth': 5 },
          refs: profileRefs(sk.shape, [
            indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face'),
            indexOf(sk, `${S}:region(M1,M2,M3,M4)`, 'face'),
          ]),
        });
        relClose(ss.mass(ex.shape).volume, 1000, 1e-9);
        const fp = ss.fingerprints(ex.shape);
        vecClose(fp.faces[indexOf(ex, `${E}:end#0`, 'face')]?.centroid ?? [], [5, 5, 5]);
        vecClose(fp.faces[indexOf(ex, `${E}:end#1`, 'face')]?.centroid ?? [], [25, 5, 5]);
      });

      it('throughAll cut through a box', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(40, 30, 10));
        const sk = ss.exec(sketch(SK, circle('C1', 20, 15, 5)), sketchInputs(frameAt([0, 0, 10])));
        const cut = ss.exec(extrude(EX, { end: 'throughAll', direction: 'reverse', op: 'cut' }), {
          values: {},
          target: box.shape,
          refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(C1)`, 'face')]),
        });
        const mp = ss.mass(cut.shape);
        relClose(mp.volume, 12000 - 250 * PI, 1e-9);
        expect(mp.faceCount).toBe(7);
        expect(cut.warnings).toEqual([]);
        const faces = names(cut, 'face');
        // Box faces survive with their names; the hole wall comes from the tool.
        for (const role of ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax']) {
          expect(faces).toContain(`F${BOX}:face.${role}`);
        }
        expect(faces).toContain(`${E}:side(${S}:e(C1))`);
        // Cutting away from the body is a warning, not an error.
        const miss = ss.exec(extrude(EX, { end: 'throughAll', direction: 'normal', op: 'cut' }), {
          values: {},
          target: box.shape,
          refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(C1)`, 'face')]),
        });
        expect(miss.warnings[0]?.message).toMatch(/does not touch/);
      });

      it('up to a parallel plane and up to a tilted plane', () => {
        const ss = session();
        const sk = ss.exec(sketch(SK, rect(0, 0, 10, 10)), sketchInputs());
        const refs = profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face')]);
        const plane = ss.exec(
          {
            id: '01JPLANE000000000000000001',
            type: 'plane',
            name: 'Plane',
            suppressed: false,
            definition: {
              kind: 'offset',
              from: { name: 'origin:XY', kind: 'face' },
              distance: '7',
            },
          },
          { values: { '/definition/distance': 7 }, frames: { from: frameAt([0, 0, 0]) } },
        );
        expect(names(plane, 'face')).toEqual(['F01JPLANE000000000000000001:plane']);
        expect(plane.frame?.origin).toEqual([0, 0, 7]);
        const upTo = ss.exec(extrude(EX, { end: 'upTo' }), {
          values: {},
          refs: { ...refs, '/end/target': { shape: plane.shape, kind: 'face', index: 0 } },
        });
        relClose(ss.mass(upTo.shape).volume, 700, 1e-9);
        // Tilted: z = 5 + 0.2 x  → volume = ∫∫ (5 + 0.2x) dA = 500 + 0.2·500 = 600.
        const n = [-0.2, 0, 1];
        const len = Math.hypot(...n);
        const tilted = ss.exec(extrude(EX, { end: 'upTo' }), {
          values: {},
          refs,
          frames: { upTo: { origin: [0, 0, 5], z: [-0.2 / len, 0, 1 / len], x: [1, 0, 0.2] } },
        });
        relClose(ss.mass(tilted.shape).volume, 600, 1e-7);
        expect(names(tilted, 'face')).toContain(`${E}:end`);
        expect(names(tilted, 'face')).toContain(`${E}:start`);
        expect(names(tilted, 'face')).toHaveLength(6);
      });

      it('extrude add onto a box keeps both name sets', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(40, 30, 10));
        const sk = ss.exec(sketch(SK, rect(10, 10, 20, 20)), sketchInputs(frameAt([0, 0, 10])));
        const boss = ss.exec(extrude(EX, { op: 'add' }), {
          values: { '/end/depth': 5 },
          target: box.shape,
          refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face')]),
        });
        relClose(ss.mass(boss.shape).volume, 12000 + 500, 1e-9);
        const faces = names(boss, 'face');
        expect(faces).toContain(`F${BOX}:face.zmax`);
        expect(faces).toContain(`${E}:end`);
        expect(faces).toContain(`${E}:side(${S}:e(L1))`);
        expect(faces).not.toContain(`${E}:start`); // merged into the box top
      });

      it('errors: no profile, zero depth, draft, through-all without a body', () => {
        const ss = session();
        const sk = ss.exec(sketch(SK, rect(0, 0, 10, 10)), sketchInputs());
        const refs = profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face')]);
        expect(ss.fail(extrude(EX), { values: { '/end/depth': 5 } }).code).toBe(
          'UNRESOLVED_REFERENCE',
        );
        expect(ss.fail(extrude(EX), { values: { '/end/depth': 0 }, refs }).code).toBe(
          'INVALID_INPUT',
        );
        expect(
          ss.fail(extrude(EX), { values: { '/end/depth': 5, '/draft': 0.1 }, refs }).code,
        ).toBe('UNSUPPORTED_FEATURE');
        expect(ss.fail(extrude(EX, { end: 'throughAll' }), { values: {}, refs }).code).toBe(
          'INVALID_INPUT',
        );
        expect(
          ss.fail(extrude(EX, { op: 'cut' }), { values: { '/end/depth': 5 }, refs }).code,
        ).toBe('INVALID_INPUT');
        const bad = ss.fail(extrude(EX), {
          values: { '/end/depth': 5 },
          refs: { '/profile/0': { shape: sk.shape, kind: 'face', index: 99 } },
        });
        expect(bad.code).toBe('UNRESOLVED_REFERENCE');
        expect(
          ss.fail(extrude(EX), {
            values: { '/end/depth': 5 },
            refs: { '/profile/0': { shape: 424242, kind: 'face', index: 0 } },
          }).code,
        ).toBe('INVALID_HANDLE');
      });
    });

    // ---------------------------------------------------------------------------------------
    // Revolve
    // ---------------------------------------------------------------------------------------

    describe('revolve', () => {
      // Sketch on the XZ plane (v → world Z): rectangle r 10..20, z 0..5; revolve about world Z.
      const xz = frameAt([0, 0, 0], [0, -1, 0], [1, 0, 0]);
      const revolve = (angle: number, direction: 'normal' | 'reverse' | 'symmetric' = 'normal') =>
        ({
          id: EX,
          type: 'revolve',
          name: 'Revolve',
          suppressed: false,
          profile: [{ name: 'region', kind: 'region' }],
          axis: { name: 'origin:Z', kind: 'edge' },
          angle: String(angle),
          direction,
          op: 'new',
        }) as Feature;
      const run = (ss: Session, angle: number, direction?: 'normal' | 'reverse' | 'symmetric') => {
        const sk = ss.exec(sketch(SK, rect(10, 0, 20, 5)), sketchInputs(xz));
        return ss.exec(revolve(angle, direction), {
          values: { '/angle': angle },
          refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face')]),
          frames: { axis: frameAt([0, 0, 0], [0, 0, 1], [1, 0, 0]) },
        });
      };

      it('360° gives an annulus ring; no caps', () => {
        const ss = session();
        const r = run(ss, 2 * PI);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, PI * (400 - 100) * 5, 1e-9);
        expect(mp.faceCount).toBe(4);
        const faces = names(r, 'face');
        expect(faces).not.toContain(`${E}:start`);
        expect(faces.sort()).toEqual(
          ['L1', 'L2', 'L3', 'L4'].map((l) => `${E}:side(${S}:e(${l}))`).sort(),
        );
      });

      it('90° quarter ring with start/end caps; symmetric keeps the volume', () => {
        const ss = session();
        const r = run(ss, PI / 2);
        relClose(ss.mass(r.shape).volume, (PI * 300 * 5) / 4, 1e-9);
        const faces = names(r, 'face');
        expect(faces).toContain(`${E}:start`);
        expect(faces).toContain(`${E}:end`);
        expect(faces).toHaveLength(6);
        const fp = ss.fingerprints(r.shape);
        vecClose(fp.faces[indexOf(r, `${E}:start`, 'face')]?.centroid ?? [], [15, 0, 2.5], 1e-6);
        const sym = run(ss, PI / 2, 'symmetric');
        const ms = ss.mass(sym.shape);
        relClose(ms.volume, (PI * 300 * 5) / 4, 1e-9);
        expect(Math.abs(ms.centroid[1])).toBeLessThan(1e-9);
      });

      it('rejects a profile crossing the axis', () => {
        const ss = session();
        const sk = ss.exec(sketch(SK, rect(-5, 0, 5, 5)), sketchInputs(xz));
        const e = ss.fail(revolve(PI), {
          values: { '/angle': PI },
          refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face')]),
          frames: { axis: frameAt([0, 0, 0], [0, 0, 1], [1, 0, 0]) },
        });
        expect(e.code).toBe('OPERATION_FAILED');
        expect(e.message).toMatch(/crosses the revolve axis/);
        expect(ss.fail(revolve(0), { values: { '/angle': 0 } }).code).toBe('UNRESOLVED_REFERENCE');
      });

      it('revolves about a sketch construction line', () => {
        const ss = session();
        const sk = ss.exec(
          sketch(SK, [
            ...rect(10, 0, 20, 5),
            pt('a0', 0, -1),
            pt('a1', 0, 1),
            line('ax', 'a0', 'a1', true),
          ]),
          sketchInputs(xz),
        );
        const r = ss.exec(revolve(2 * PI), {
          values: { '/angle': 2 * PI },
          refs: {
            ...profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face')]),
            '/axis': { shape: sk.shape, kind: 'edge', index: indexOf(sk, `${S}:e(ax)`, 'edge') },
          },
        });
        relClose(ss.mass(r.shape).volume, PI * 300 * 5, 1e-9);
      });
    });

    // ---------------------------------------------------------------------------------------
    // Fillet / chamfer
    // ---------------------------------------------------------------------------------------

    describe('fillet and chamfer', () => {
      const edgeXY = `F${BOX}:edge(face.xmin|face.ymin)`; // along z, length 30
      const fillet = (radius: number) =>
        ({
          id: FI,
          type: 'fillet',
          name: 'Fillet',
          suppressed: false,
          edges: [{ name: edgeXY, kind: 'edge' }],
          radius: String(radius),
        }) as Feature;
      const chamfer = (mode: 'distance' | 'distanceAngle') =>
        ({
          id: FI,
          type: 'chamfer',
          name: 'Chamfer',
          suppressed: false,
          edges: [{ name: edgeXY, kind: 'edge' }],
          mode:
            mode === 'distance'
              ? { kind: 'distance', distance: '2' }
              : { kind: 'distanceAngle', distance: '2', angle: '30deg' },
        }) as Feature;

      const withBox = (ss: Session) => {
        const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
        const refs = {
          '/edges/0': {
            shape: box.shape,
            kind: 'edge' as const,
            index: indexOf(box, edgeXY, 'edge'),
          },
        };
        return { box, refs };
      };

      it('fillets a box edge r = 2: volume, names', () => {
        const ss = session();
        const { box, refs } = withBox(ss);
        const r = ss.exec(fillet(2), { values: { '/radius': 2 }, target: box.shape, refs });
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 6000 - (1 - PI / 4) * 4 * 30, 1e-9);
        expect(mp.faceCount).toBe(7);
        const faces = names(r, 'face');
        expect(faces).toContain(`F${FI}:fillet(${edgeXY})`);
        for (const role of ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax']) {
          expect(faces).toContain(`F${BOX}:face.${role}`);
        }
        const fp = ss.fingerprints(r.shape);
        expect(fp.faces[indexOf(r, `F${FI}:fillet(${edgeXY})`, 'face')]?.surface).toBe('cylinder');
        relClose(
          fp.faces[indexOf(r, `F${FI}:fillet(${edgeXY})`, 'face')]?.area ?? 0,
          (PI / 2) * 2 * 30,
          1e-9,
        );
        expect(names(r, 'edge')).toContain(`edge(F${BOX}:face.xmin|F${FI}:fillet(${edgeXY}))`);
      });

      it('radius too large: structured error with a hint, nothing leaked', () => {
        const ss = session();
        const { box, refs } = withBox(ss);
        const before = k.liveHandleCount();
        let raw = '';
        expect(() => {
          raw = k.execFeature(
            JSON.stringify(fillet(15)),
            JSON.stringify({ values: { '/radius': 15 }, target: box.shape, refs }),
          );
        }).not.toThrow();
        const e = JSON.parse(raw) as {
          ok: false;
          error: { code: string; message: string; hint?: string; entityRefs?: string[] };
        };
        expect(e.ok).toBe(false);
        expect(e.error.code).toBe('OPERATION_FAILED');
        expect(e.error.message).toBe('Fillet radius is too large for this edge');
        const hint = /^Try ≤ ([\d.]+) mm$/.exec(e.error.hint ?? '');
        expect(hint, e.error.hint).not.toBeNull();
        const max = Number(hint?.[1]);
        expect(max).toBeGreaterThan(5);
        expect(max).toBeLessThanOrEqual(10);
        expect(e.error.entityRefs).toEqual([edgeXY]);
        expect(k.liveHandleCount()).toBe(before);
        // The hinted radius works.
        const r = ss.exec(fillet(max), { values: { '/radius': max }, target: box.shape, refs });
        expect(ss.mass(r.shape).volume).toBeLessThan(6000);
      });

      it('fillet input errors', () => {
        const ss = session();
        const { box, refs } = withBox(ss);
        expect(ss.fail(fillet(0), { values: { '/radius': 0 }, target: box.shape, refs }).code).toBe(
          'INVALID_INPUT',
        );
        expect(ss.fail(fillet(1), { values: { '/radius': 1 }, target: box.shape }).code).toBe(
          'INVALID_INPUT',
        );
        expect(
          ss.fail(fillet(1), {
            values: { '/radius': 1 },
            target: box.shape,
            refs: { '/edges/0': { shape: box.shape, kind: 'face', index: 0 } },
          }).code,
        ).toBe('INVALID_INPUT');
        const other = ss.exec(boxFeature(BOX), boxValues(1, 1, 1));
        expect(
          ss.fail(fillet(1), {
            values: { '/radius': 1 },
            target: other.shape,
            refs,
          }).code,
        ).toBe('INVALID_INPUT');
      });

      it('chamfer distance and distance-angle volumes', () => {
        const ss = session();
        const { box, refs } = withBox(ss);
        const d = ss.exec(chamfer('distance'), {
          values: { '/mode/distance': 2 },
          target: box.shape,
          refs,
        });
        relClose(ss.mass(d.shape).volume, 6000 - 0.5 * 2 * 2 * 30, 1e-9);
        expect(names(d, 'face')).toContain(`F${FI}:chamfer(${edgeXY})`);
        const da = ss.exec(chamfer('distanceAngle'), {
          values: { '/mode/distance': 2, '/mode/angle': PI / 6 },
          target: box.shape,
          refs,
        });
        relClose(ss.mass(da.shape).volume, 6000 - 0.5 * 2 * (2 * Math.tan(PI / 6)) * 30, 1e-9);
        const tooBig = ss.fail(chamfer('distance'), {
          values: { '/mode/distance': 25 },
          target: box.shape,
          refs,
        });
        expect(tooBig.code).toBe('OPERATION_FAILED');
        expect(tooBig.entityRefs).toEqual([edgeXY]);
        expect(
          ss.fail(chamfer('distanceAngle'), {
            values: { '/mode/distance': 2, '/mode/angle': 2 },
            target: box.shape,
            refs,
          }).code,
        ).toBe('INVALID_INPUT');
      });
    });

    // ---------------------------------------------------------------------------------------
    // Boolean, primitives, plane
    // ---------------------------------------------------------------------------------------

    describe('boolean and primitives', () => {
      const BOOL = '01JBOOLEAN0000000000000001';
      const B2 = '01JBOX00000000000000000002';
      const booleanFeature = (op: 'add' | 'cut' | 'intersect') =>
        ({
          id: BOOL,
          type: 'boolean',
          name: 'Boolean',
          suppressed: false,
          op,
          target: { name: `B${BOX}`, kind: 'body' },
          tools: [{ name: `B${B2}`, kind: 'body' }],
          keepTools: false,
        }) as Feature;

      it('add / cut / intersect with tool-face names', () => {
        const ss = session();
        const a = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
        const b = ss.exec(boxFeature(B2, frameAt([5, 0, 0])), boxValues(10, 10, 10));
        const refs = {
          '/target': { shape: a.shape, kind: 'body' as const, index: 0 },
          '/tools/0': { shape: b.shape, kind: 'body' as const, index: 0 },
        };
        const add = ss.exec(booleanFeature('add'), { values: {}, refs });
        relClose(ss.mass(add.shape).volume, 1500, 1e-9);
        const cut = ss.exec(booleanFeature('cut'), { values: {}, refs });
        relClose(ss.mass(cut.shape).volume, 500, 1e-9);
        expect(names(cut, 'face')).toContain(`F${BOOL}:face(F${B2}:face.xmin)`);
        expect(names(cut, 'face')).toContain(`F${BOX}:face.xmin`);
        const common = ss.exec(booleanFeature('intersect'), { values: {}, refs });
        relClose(ss.mass(common.shape).volume, 500, 1e-9);
        expect(names(common, 'face')).toContain(`F${BOOL}:face(F${B2}:face.xmin)`);
        expect(names(common, 'face')).toContain(`F${BOX}:face.xmax`);
        // Disjoint intersect is an error.
        const far = ss.exec(boxFeature(B2, frameAt([50, 0, 0])), boxValues(1, 1, 1));
        expect(
          ss.fail(booleanFeature('intersect'), {
            values: {},
            refs: { ...refs, '/tools/0': { shape: far.shape, kind: 'body', index: 0 } },
          }).code,
        ).toBe('OPERATION_FAILED');
        expect(
          ss.fail(booleanFeature('cut'), { values: {}, refs: { '/target': refs['/target'] } }).code,
        ).toBe('UNRESOLVED_REFERENCE');
      });

      it('cylinder and sphere primitives', () => {
        const ss = session();
        const cyl = ss.exec(
          {
            id: B2,
            type: 'primitive',
            name: 'Cyl',
            suppressed: false,
            op: 'new',
            shape: 'cylinder',
            radius: '3',
            height: '7',
          },
          { values: { '/radius': 3, '/height': 7 } },
        );
        relClose(ss.mass(cyl.shape).volume, PI * 9 * 7, 1e-9);
        expect(names(cyl, 'face').sort()).toEqual([
          `F${B2}:face.side`,
          `F${B2}:face.zmax`,
          `F${B2}:face.zmin`,
        ]);
        expect(names(cyl, 'edge').sort()).toEqual(
          [
            `F${B2}:edge(face.side|face.side)`,
            `F${B2}:edge(face.side|face.zmax)`,
            `F${B2}:edge(face.side|face.zmin)`,
          ].sort(),
        );
        expect(names(cyl, 'vertex').sort()).toEqual([
          `F${B2}:vertex(face.side|face.zmax)`,
          `F${B2}:vertex(face.side|face.zmin)`,
        ]);
        const sph = ss.exec(
          {
            id: B2,
            type: 'primitive',
            name: 'Sph',
            suppressed: false,
            op: 'new',
            shape: 'sphere',
            radius: '2',
          },
          { values: { '/radius': 2 } },
        );
        relClose(ss.mass(sph.shape).volume, (4 / 3) * PI * 8, 1e-9);
        expect(names(sph, 'face')).toEqual([`F${B2}:face.sphere`]);
        // Primitive with op cut against a target.
        const box = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
        const hole = ss.exec(
          {
            id: B2,
            type: 'primitive',
            name: 'Cyl',
            suppressed: false,
            op: 'cut',
            shape: 'cylinder',
            radius: '2',
            height: '10',
            frame: frameAt([5, 5, 0]),
          },
          { values: { '/radius': 2, '/height': 10 }, target: box.shape },
        );
        relClose(ss.mass(hole.shape).volume, 1000 - PI * 4 * 10, 1e-9);
        expect(names(hole, 'face')).toContain(`F${B2}:face.side`);
      });

      it('plane from an explicit frame and offset from a face', () => {
        const ss = session();
        const P = '01JPLANE000000000000000002';
        const p = ss.exec(
          {
            id: P,
            type: 'plane',
            name: 'Plane',
            suppressed: false,
            definition: { kind: 'frame', frame: frameAt([1, 2, 3], [0, 1, 0], [1, 0, 0]) },
          },
          { values: {} },
        );
        expect(names(p, 'face')).toEqual([`F${P}:plane`]);
        vecClose(ss.fingerprints(p.shape).faces[0]?.normal ?? [], [0, 1, 0], 1e-12);
        const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
        const off = ss.exec(
          {
            id: P,
            type: 'plane',
            name: 'Plane',
            suppressed: false,
            definition: { kind: 'offset', from: { name: 'x', kind: 'face' }, distance: '5' },
          },
          {
            values: { '/definition/distance': 5 },
            refs: {
              '/definition/from': {
                shape: box.shape,
                kind: 'face',
                index: indexOf(box, `F${BOX}:face.zmax`, 'face'),
              },
            },
          },
        );
        const f = ss.fingerprints(off.shape).faces[0];
        vecClose(f?.normal ?? [], [0, 0, 1], 1e-12);
        vecClose(f?.centroid ?? [], [5, 10, 35], 1e-9);
        expect(
          ss.fail(
            {
              id: P,
              type: 'plane',
              name: 'P',
              suppressed: false,
              definition: { kind: 'offset', from: { name: 'x', kind: 'face' }, distance: '1' },
            },
            { values: { '/definition/distance': 1 } },
          ).code,
        ).toBe('UNRESOLVED_REFERENCE');
      });

      it('unknown feature types and malformed inputs are structured errors', () => {
        const ss = session();
        expect(
          ss.fail({ id: 'X', type: 'loft', name: 'P', suppressed: false }, { values: {} }).code,
        ).toBe('UNSUPPORTED_FEATURE');
        // pushPull is supported from M2: a missing distance is an input error.
        expect(
          ss.fail({ id: 'X', type: 'pushPull', name: 'P', suppressed: false }, { values: {} }).code,
        ).toBe('INVALID_INPUT');
        expect(err2(k.execFeature('{"id":"x","type":"sketch"}', '{"values":{}}'))).toBe(
          'INVALID_INPUT',
        );
        expect(err2(k.execFeature('{"id":"x","type":"extrude"}', '{"refs":[]}'))).toBe(
          'INVALID_INPUT',
        );
      });
    });

    // ---------------------------------------------------------------------------------------
    // Persistent naming: edit upstream, check downstream (PLAN §7.3 step 5)
    // ---------------------------------------------------------------------------------------

    describe('naming stability', () => {
      const edgeName = `edge(${E}:end|${E}:side(${S}:e(L1)))`;

      const build = (ss: Session, width: number) => {
        const { ex } = sketchAndExtrude(ss, rect(0, 0, width, 30), `${S}:region(L1,L2,L3,L4)`);
        const idx = indexOf(ex, edgeName, 'edge');
        const fp = ss.fingerprints(ex.shape).edges[idx];
        const fil = ss.exec(
          {
            id: FI,
            type: 'fillet',
            name: 'Fillet',
            suppressed: false,
            edges: [{ name: edgeName, kind: 'edge' }],
            radius: '2',
          },
          {
            values: { '/radius': 2 },
            target: ex.shape,
            refs: { '/edges/0': { shape: ex.shape, kind: 'edge', index: idx } },
          },
        );
        return { ex, fp, fil };
      };

      it('a filleted edge keeps its name when the sketch width changes', () => {
        const ss = session();
        const a = build(ss, 40);
        const b = build(ss, 60);
        // The same name designates the corresponding edge (top front edge, along x).
        vecClose(a.fp?.centroid ?? [], [20, 0, 10]);
        vecClose(b.fp?.centroid ?? [], [30, 0, 10]);
        relClose(a.fp?.length ?? 0, 40);
        relClose(b.fp?.length ?? 0, 60);
        relClose(ss.mass(a.fil.shape).volume, 40 * 30 * 10 - (1 - PI / 4) * 4 * 40, 1e-9);
        relClose(ss.mass(b.fil.shape).volume, 60 * 30 * 10 - (1 - PI / 4) * 4 * 60, 1e-9);
        const filletFace = `F${FI}:fillet(${edgeName})`;
        expect(names(a.fil, 'face')).toContain(filletFace);
        expect(names(b.fil, 'face')).toContain(filletFace);
        // Every name downstream is identical across the edit.
        expect(names(a.fil).sort()).toEqual(names(b.fil).sort());
        expect(names(a.ex).sort()).toEqual(names(b.ex).sort());
      });

      it('a slot that splits a face yields deterministic #0/#1 suffixes', () => {
        const SLOT = '01JSLOT0000000000000000001';
        const SLOTSK = '01JSLOTSK00000000000000001';
        const runOnce = (ss: Session) => {
          const { ex } = sketchAndExtrude(ss, rect(0, 0, 40, 30), `${S}:region(L1,L2,L3,L4)`);
          const sk = ss.exec(
            sketch(SLOTSK, rect(15, -5, 25, 35)),
            sketchInputs(frameAt([0, 0, 10])),
          );
          const cut = ss.exec(
            { ...extrude(SLOT, { direction: 'reverse', op: 'cut' }) },
            {
              values: { '/end/depth': 5 },
              target: ex.shape,
              refs: profileRefs(sk.shape, [indexOf(sk, `S${SLOTSK}:region(L1,L2,L3,L4)`, 'face')]),
            },
          );
          return cut;
        };
        const ss = session();
        const first = runOnce(ss);
        const second = runOnce(ss);
        relClose(ss.mass(first.shape).volume, 12000 - 10 * 30 * 5, 1e-9);
        const tops = names(first, 'face')
          .filter((n) => n.startsWith(`${E}:end`))
          .sort();
        expect(tops).toEqual([`${E}:end#0`, `${E}:end#1`]);
        const fp = ss.fingerprints(first.shape);
        vecClose(fp.faces[indexOf(first, `${E}:end#0`, 'face')]?.centroid ?? [], [7.5, 15, 10]);
        vecClose(fp.faces[indexOf(first, `${E}:end#1`, 'face')]?.centroid ?? [], [32.5, 15, 10]);
        // Slot floor = tool end cap... the cut's start cap lies on the body top (removed), the
        // floor is the tool's end.
        expect(names(first, 'face')).toContain(`F${SLOT}:end`);
        const stable = (r: RawFeatureResult) =>
          r.naming.map((n: NamingEntry) => `${n.kind}:${n.index}:${n.name}`).sort();
        expect(stable(second)).toEqual(stable(first));
        // Front/back faces are notched but not split: names unchanged.
        expect(names(first, 'face')).toContain(`${E}:side(${S}:e(L1))`);
      });
    });

    describe('mesh caching', () => {
      it('honours a coarser request after a finer one', () => {
        const ss = session();
        const cyl = ss.exec(
          {
            id: BOX,
            type: 'primitive',
            name: 'Cyl',
            suppressed: false,
            op: 'new',
            shape: 'cylinder',
            radius: '10',
            height: '10',
          },
          { values: { '/radius': 10, '/height': 10 } },
        );
        const fine = meshShape(k, cyl.shape, 0.005, 0.1).indices.length;
        const coarse = meshShape(k, cyl.shape, 1, 0.5).indices.length;
        const fineAgain = meshShape(k, cyl.shape, 0.005, 0.1).indices.length;
        expect(coarse).toBeLessThan(fine / 4);
        expect(fineAgain).toBe(fine);
      });
    });
  });
}

function err2(json: string): string {
  const r = JSON.parse(json) as { ok: boolean; error?: { code: string } };
  if (r.ok) throw new Error(`expected error, got ${json.slice(0, 300)}`);
  return r.error?.code ?? '';
}
