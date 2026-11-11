/**
 * Planar face normals on left-handed placements (fix in whittle_modeling.cpp `planeOf`): the
 * outward normal of a plane is XDir × YDir, which is −Direction() when its gp_Ax3 is indirect.
 * Chamfer faces and mirrored copies have such planes; before the fix their fingerprint normals
 * pointed inward, the chamfer–face angle read 135° instead of 45°, and sketches or holes on those
 * faces took the wrong side.
 *
 * Every body here is convex, so every planar face's outward normal points away from the body's
 * centroid: that holds whichever handedness OCCT happens to give each face, and the twelve box
 * edges plus a mirrored body cover both.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, Measurement, Vec3 } from '@wren-cad/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  frameAt,
  indexOf,
  loadVariant,
  ok,
  type RawFeatureResult,
  relClose,
  Session,
  suiteTitle,
  VARIANTS,
  variantBuilt,
  vecClose,
} from './helpers';

const BOX = '01JBOX0000000000000000NRM1';
const CH = '01JCHAMFER0000000000000NRM';
const MI = '01JMIRROR00000000000000NRM';
const PI = Math.PI;
const ROLES = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'] as const;

/** The twelve edges of a box, as `[faceA, faceB]` with A < B (naming.ts sorts the roles). */
const BOX_EDGES: [string, string][] = [];
for (let i = 0; i < ROLES.length; i++) {
  for (let j = i + 1; j < ROLES.length; j++) {
    const a = ROLES[i] as string;
    const b = ROLES[j] as string;
    if (a[0] !== b[0]) BOX_EDGES.push([a, b]);
  }
}

const dot = (a: readonly number[], b: readonly number[]) =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const sub3 = (a: readonly number[], b: readonly number[]): Vec3 => [
  (a[0] ?? 0) - (b[0] ?? 0),
  (a[1] ?? 0) - (b[1] ?? 0),
  (a[2] ?? 0) - (b[2] ?? 0),
];

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('planar face normals', variant), () => {
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

    /** Every planar face of a convex body has its normal pointing away from the centroid. */
    const expectOutward = (ss: Session, r: RawFeatureResult) => {
      const centroid = ss.mass(r.shape).centroid;
      const fp = ss.fingerprints(r.shape);
      let planar = 0;
      fp.faces.forEach((face, i) => {
        if (face.surface !== 'plane') return;
        planar++;
        const n = face.normal;
        expect(n, `face ${i} has a normal`).toBeDefined();
        const name = r.naming.find((e) => e.kind === 'face' && e.index === i)?.name ?? `#${i}`;
        expect(
          dot(n ?? [0, 0, 0], sub3(face.centroid, centroid)),
          `${name} normal [${n?.join(', ')}] points inward`,
        ).toBeGreaterThan(0);
      });
      expect(planar).toBeGreaterThan(0);
    };

    const chamfer = (edge: string): Feature =>
      ({
        id: CH,
        type: 'chamfer',
        name: 'Chamfer',
        suppressed: false,
        edges: [{ name: edge, kind: 'edge' }],
        mode: { kind: 'distance', distance: '2' },
      }) as Feature;

    it('chamfer faces on all twelve box edges point outward at 45° to both neighbours', () => {
      const ss = session();
      const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
      for (const [a, b] of BOX_EDGES) {
        const edge = `F${BOX}:edge(face.${a}|face.${b})`;
        const r = ss.exec(chamfer(edge), {
          values: { '/mode/distance': 2 },
          target: box.shape,
          refs: {
            '/edges/0': { shape: box.shape, kind: 'edge', index: indexOf(box, edge, 'edge') },
          },
        });
        expectOutward(ss, r);
        const ci = indexOf(r, `F${CH}:chamfer(${edge})`, 'face');
        const n = ss.fingerprints(r.shape).faces[ci]?.normal ?? [0, 0, 0];
        // Outward: the sum of the two neighbours' outward axes, normalised.
        const axis = (role: string): Vec3 => {
          const v: Vec3 = [0, 0, 0];
          v['xyz'.indexOf(role[0] as string)] = role.endsWith('max') ? 1 : -1;
          return v;
        };
        const expected = axis(a).map((c, i) => (c + (axis(b)[i] ?? 0)) / Math.SQRT2);
        vecClose(n, expected, 1e-9);
        for (const role of [a, b]) {
          const m = ok<Measurement>(
            k.measure(
              JSON.stringify({
                a: { shape: r.shape, kind: 'face', index: ci },
                b: {
                  shape: r.shape,
                  kind: 'face',
                  index: indexOf(r, `F${BOX}:face.${role}`, 'face'),
                },
              }),
            ),
          );
          relClose(m.angle ?? 0, PI / 4, 1e-9);
        }
      }
    });

    it('mirrored bodies keep outward normals (merged and separate)', () => {
      const ss = session();
      const box = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
      const mirror = (merge: boolean): Feature =>
        ({
          id: MI,
          type: 'mirror',
          name: 'Mirror',
          suppressed: false,
          source: { kind: 'bodies', bodies: [{ name: `B${BOX}`, kind: 'body' }], merge },
          plane: { name: 'origin:YZ', kind: 'face' },
        }) as Feature;
      const inputs = {
        values: {},
        refs: { '/source/bodies/0': { shape: box.shape, kind: 'body' as const, index: 0 } },
        frames: { '/plane': frameAt([0, 0, 0], [1, 0, 0], [0, 1, 0]) },
      };
      const merged = ss.exec(mirror(true), inputs);
      expectOutward(ss, merged);
      const mirroredXmax = indexOf(merged, `F${MI}:mirror(F${BOX}:face.xmax)`, 'face');
      vecClose(ss.fingerprints(merged.shape).faces[mirroredXmax]?.normal ?? [], [-1, 0, 0], 1e-12);

      const separate = ss.exec(mirror(false), inputs);
      const bodies = separate.bodies?.length ? separate.bodies : [separate];
      for (const body of bodies) {
        const r = { ...separate, shape: body.shape, naming: body.naming } as RawFeatureResult;
        expectOutward(ss, r);
      }
    });
  });
}
