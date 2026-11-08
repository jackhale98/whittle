/**
 * M2 push/pull golden tests (PLAN §12 M2, naming.ts "M2 additions", ADR-010): volume, area, face
 * counts and names for faces moved along their outward normal. Golden numbers are analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, Frame } from '@whittle/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  circle,
  extrude,
  frameAt,
  indexOf,
  loadVariant,
  meshShape,
  names,
  profileRefs,
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

const BOX = '01JBOX00000000000000000001';
const B2 = '01JBOX00000000000000000002';
const B3 = '01JBOX00000000000000000003';
const PP = '01JPUSHPULL000000000000001';
const P = `F${PP}`;
const SK = '01JSKETCH00000000000000001';
const S = `S${SK}`;
const EX = '01JEXTRUDE0000000000000001';
const E = `F${EX}`;
const CYL = '01JCYLINDER000000000000001';
const PI = Math.PI;

const BOX_FACES = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'].map((r) => `F${BOX}:face.${r}`);

function pushPull(faces: number): Feature {
  return {
    id: PP,
    type: 'pushPull',
    name: 'Push/pull',
    suppressed: false,
    faces: Array.from({ length: faces }, () => ({ name: 'face', kind: 'face' as const })),
    distance: '1 mm',
  };
}

function boxAt(id: string, frame: Frame | undefined, op: 'new' | 'add' = 'new'): Feature {
  return boxFeature(id, frame, op);
}

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('push/pull', variant), () => {
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

    /** Push/pull `faces` (by name) of `body` by `d` mm. */
    const push = (ss: Session, body: RawFeatureResult, faceNames: string[], d: number) =>
      ss.exec(pushPull(faceNames.length), pushInputs(body, faceNames, d));

    const pushInputs = (body: RawFeatureResult, faceNames: string[], d: number): FeatureInputs => {
      const refs: NonNullable<FeatureInputs['refs']> = {};
      faceNames.forEach((n, i) => {
        refs[`/faces/${i}`] = { shape: body.shape, kind: 'face', index: indexOf(body, n, 'face') };
      });
      return { target: body.shape, values: { '/distance': d }, refs };
    };

    /** Names are unique per kind, and the mesh's names line up with the naming map. */
    const checkNaming = (r: RawFeatureResult) => {
      for (const kind of ['face', 'edge', 'vertex'] as const) {
        const n = names(r, kind);
        expect(new Set(n).size, kind).toBe(n.length);
        expect(n.every((x) => x.length > 0 && !x.includes('unnamed'))).toBe(true);
      }
      const m = meshShape(k, r.shape, 0.1);
      for (const n of r.naming) {
        if (n.kind === 'face') expect(m.meta.faceNames[n.index]).toBe(n.name);
      }
    };

    const faceFp = (ss: Session, r: RawFeatureResult, name: string) => {
      const fp = ss.fingerprints(r.shape).faces[indexOf(r, name, 'face')];
      if (!fp) throw new Error(`no fingerprint for ${name}`);
      return fp;
    };

    describe('box top face', () => {
      it('+5 mm: the box gets taller; still six faces with their names, no seam', () => {
        const ss = session();
        const box = ss.exec(boxAt(BOX, undefined), boxValues(40, 30, 10));
        const r = push(ss, box, [`F${BOX}:face.zmax`], 5);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 40 * 30 * 15, 1e-9);
        relClose(mp.area, 2 * (40 * 30 + 40 * 15 + 30 * 15), 1e-9);
        expect([mp.faceCount, mp.edgeCount, mp.vertexCount]).toEqual([6, 12, 8]);
        vecClose(mp.bbox.max, [40, 30, 15]);
        expect(names(r, 'face').sort()).toEqual([...BOX_FACES].sort());
        // The coplanar walls merged into the old side faces, which kept their names.
        expect(names(r, 'face').some((n) => n.startsWith(`${P}:side(`))).toBe(false);
        expect(names(r, 'edge')).toContain(`edge(F${BOX}:face.xmax|F${BOX}:face.zmax)`);
        expect(names(r, 'edge')).toContain(`edge(F${BOX}:face.xmin|F${BOX}:face.ymin)`);
        expect(names(r, 'vertex')).toContain(
          `vertex(F${BOX}:face.xmax|F${BOX}:face.ymax|F${BOX}:face.zmax)`,
        );
        const top = faceFp(ss, r, `F${BOX}:face.zmax`);
        vecClose(top.centroid, [20, 15, 15]);
        vecClose(top.normal ?? [], [0, 0, 1], 1e-12);
        relClose(faceFp(ss, r, `F${BOX}:face.xmin`).area, 30 * 15, 1e-9);
        expect(r.warnings).toEqual([]);
        checkNaming(r);
      });

      it('−3 mm: the box gets lower', () => {
        const ss = session();
        const box = ss.exec(boxAt(BOX, undefined), boxValues(40, 30, 10));
        const r = push(ss, box, [`F${BOX}:face.zmax`], -3);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 40 * 30 * 7, 1e-9);
        relClose(mp.area, 2 * (40 * 30 + 40 * 7 + 30 * 7), 1e-9);
        expect([mp.faceCount, mp.edgeCount, mp.vertexCount]).toEqual([6, 12, 8]);
        expect(names(r, 'face').sort()).toEqual([...BOX_FACES].sort());
        vecClose(faceFp(ss, r, `F${BOX}:face.zmax`).centroid, [20, 15, 7]);
        vecClose(faceFp(ss, r, `F${BOX}:face.zmax`).normal ?? [], [0, 0, 1], 1e-12);
        expect(r.warnings).toEqual([]);
        checkNaming(r);
      });

      it('a side face pulled out, then pushed back, restores the volume', () => {
        const ss = session();
        const box = ss.exec(boxAt(BOX, undefined), boxValues(40, 30, 10));
        const out = push(ss, box, [`F${BOX}:face.xmax`], 7.5);
        relClose(ss.mass(out.shape).volume, 47.5 * 30 * 10, 1e-9);
        const back = push(ss, out, [`F${BOX}:face.xmax`], -7.5);
        const mp = ss.mass(back.shape);
        relClose(mp.volume, 12000, 1e-9);
        expect(mp.faceCount).toBe(6);
        vecClose(mp.bbox.max, [40, 30, 10]);
        expect(names(back, 'face').sort()).toEqual([...BOX_FACES].sort());
      });
    });

    describe('several faces at once', () => {
      /** 60×20×5 plate with two 10×10×5 bosses whose tops are coplanar (z = 10). */
      const plateWithBosses = (ss: Session) => {
        const plate = ss.exec(boxAt(BOX, undefined), boxValues(60, 20, 5));
        const one = ss.exec(boxAt(B2, frameAt([5, 5, 5]), 'add'), {
          ...boxValues(10, 10, 5),
          target: plate.shape,
        });
        return ss.exec(boxAt(B3, frameAt([45, 5, 5]), 'add'), {
          ...boxValues(10, 10, 5),
          target: one.shape,
        });
      };

      it('two coplanar boss tops pulled +5 together', () => {
        const ss = session();
        const body = plateWithBosses(ss);
        const before = ss.mass(body.shape);
        relClose(before.volume, 7000, 1e-9);
        expect(before.faceCount).toBe(16);
        const tops = [`F${B2}:face.zmax`, `F${B3}:face.zmax`];
        const r = push(ss, body, tops, 5);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 6000 + 2 * 10 * 10 * 10, 1e-9);
        relClose(mp.area, before.area + 2 * 4 * 10 * 5, 1e-9);
        expect(mp.faceCount).toBe(16);
        expect(names(r, 'face').sort()).toEqual(names(body, 'face').sort());
        vecClose(faceFp(ss, r, tops[0] as string).centroid, [10, 10, 15]);
        vecClose(faceFp(ss, r, tops[1] as string).centroid, [50, 10, 15]);
        relClose(faceFp(ss, r, `F${B2}:face.xmin`).area, 10 * 10, 1e-9);
        checkNaming(r);
      });

      it('pushed −5, the bosses vanish and the plate top closes (moved faces are swallowed)', () => {
        const ss = session();
        const body = plateWithBosses(ss);
        const r = push(ss, body, [`F${B2}:face.zmax`, `F${B3}:face.zmax`], -5);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 6000, 1e-9);
        expect(mp.faceCount).toBe(6);
        expect(names(r, 'face').sort()).toEqual([...BOX_FACES].sort());
        relClose(faceFp(ss, r, `F${BOX}:face.zmax`).area, 60 * 20, 1e-9);
        checkNaming(r);
      });

      it('one of two coplanar adjacent top faces pulled: a new wall named after the edge', () => {
        const ss = session();
        const a = ss.exec(boxAt(BOX, undefined), boxValues(10, 10, 10));
        const body = ss.exec(boxAt(B2, frameAt([10, 0, 0]), 'add'), {
          ...boxValues(10, 10, 10),
          target: a.shape,
        });
        expect(ss.mass(body.shape).faceCount).toBe(10);
        const r = push(ss, body, [`F${BOX}:face.zmax`], 5);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 2000 + 500, 1e-9);
        expect(mp.faceCount).toBe(11);
        const wall = `${P}:side(edge(F${BOX}:face.zmax|F${B2}:face.zmax))`;
        expect(names(r, 'face').filter((n) => n.startsWith(`${P}:`))).toEqual([wall]);
        const fp = faceFp(ss, r, wall);
        vecClose(fp.centroid, [10, 5, 12.5]);
        vecClose(fp.normal ?? [], [1, 0, 0], 1e-12);
        relClose(fp.area, 50, 1e-9);
        // The moved face keeps its name; its old neighbours grew (walls merged into them).
        vecClose(faceFp(ss, r, `F${BOX}:face.zmax`).centroid, [5, 5, 15]);
        relClose(faceFp(ss, r, `F${BOX}:face.xmin`).area, 150, 1e-9);
        vecClose(faceFp(ss, r, `F${B2}:face.zmax`).centroid, [15, 5, 10]);
        // Adjacent face names sort lexicographically ("F01JBOX…" < "F01JPUSHPULL…").
        expect(names(r, 'edge')).toContain(`edge(F${BOX}:face.zmax|${wall})`);
        expect(names(r, 'edge')).toContain(`edge(F${B2}:face.zmax|${wall})`);
        checkNaming(r);
      });
    });

    describe('faces with holes, pockets, curved faces', () => {
      const plate = [...rect(0, 0, 40, 30), ...circle('C1', 20, 15, 5)];
      const plateRegion = `${S}:region(L1,L2,L3,L4|C1)`;
      const holeWall = `${E}:side(${S}:e(C1))`;

      const holedPlate = (ss: Session) => {
        const sk = ss.exec(sketch(SK, plate), sketchInputs());
        return ss.exec(extrude(EX), {
          values: { '/end/depth': 10 },
          refs: profileRefs(sk.shape, [indexOf(sk, plateRegion, 'face')]),
        });
      };

      it('a face with a hole: +5 and −3 keep the hole; its wall stays one named face', () => {
        const ss = session();
        const body = holedPlate(ss);
        const up = push(ss, body, [`${E}:end`], 5);
        const mu = ss.mass(up.shape);
        relClose(mu.volume, (1200 - 25 * PI) * 15, 1e-9);
        expect(mu.faceCount).toBe(7);
        expect(names(up, 'face').sort()).toEqual(names(body, 'face').sort());
        const wall = faceFp(ss, up, holeWall);
        relClose(wall.area, 2 * PI * 5 * 15, 1e-9);
        expect(wall.surface).toBe('cylinder');
        vecClose(faceFp(ss, up, `${E}:end`).centroid, [20, 15, 15], 1e-6);
        relClose(faceFp(ss, up, `${E}:end`).area, 1200 - 25 * PI, 1e-9);
        checkNaming(up);

        const down = push(ss, body, [`${E}:end`], -3);
        const md = ss.mass(down.shape);
        relClose(md.volume, (1200 - 25 * PI) * 7, 1e-9);
        expect(md.faceCount).toBe(7);
        expect(names(down, 'face').sort()).toEqual(names(body, 'face').sort());
        relClose(faceFp(ss, down, holeWall).area, 2 * PI * 5 * 7, 1e-9);
        checkNaming(down);
      });

      /** 40×30×10 box with a 20×10×4 pocket cut from the top (floor = E:end at z = 6). */
      const pocketed = (ss: Session) => {
        const box = ss.exec(boxAt(BOX, undefined), boxValues(40, 30, 10));
        const sk = ss.exec(sketch(SK, rect(10, 10, 30, 20)), sketchInputs(frameAt([0, 0, 10])));
        const pocket = ss.exec(extrude(EX, { direction: 'reverse', op: 'cut' }), {
          values: { '/end/depth': 4 },
          target: box.shape,
          refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4)`, 'face')]),
        });
        relClose(ss.mass(pocket.shape).volume, 12000 - 800, 1e-9);
        vecClose(faceFp(ss, pocket, `${E}:end`).centroid, [20, 15, 6]);
        return pocket;
      };

      it('a pocket floor pulled up flush closes the pocket: the filled box', () => {
        const ss = session();
        const body = pocketed(ss);
        const r = push(ss, body, [`${E}:end`], 4);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 40 * 30 * 10, 1e-9);
        relClose(mp.area, 2 * (1200 + 400 + 300), 1e-9);
        expect([mp.faceCount, mp.edgeCount, mp.vertexCount]).toEqual([6, 12, 8]);
        expect(names(r, 'face').sort()).toEqual([...BOX_FACES].sort());
        relClose(faceFp(ss, r, `F${BOX}:face.zmax`).area, 1200, 1e-9);
        checkNaming(r);
      });

      it('a pocket floor pulled half way up, and pushed deeper', () => {
        const ss = session();
        const body = pocketed(ss);
        const pocketFaces = names(body, 'face').filter((n) => n.startsWith(`${E}:`));
        expect(pocketFaces).toHaveLength(5);

        const half = push(ss, body, [`${E}:end`], 2);
        const mh = ss.mass(half.shape);
        relClose(mh.volume, 12000 - 400, 1e-9);
        expect(mh.faceCount).toBe(11);
        expect(names(half, 'face').sort()).toEqual(names(body, 'face').sort());
        vecClose(faceFp(ss, half, `${E}:end`).centroid, [20, 15, 8]);
        relClose(faceFp(ss, half, `${E}:side(${S}:e(L1))`).area, 20 * 2, 1e-9);
        checkNaming(half);

        const deeper = push(ss, body, [`${E}:end`], -2);
        const mdp = ss.mass(deeper.shape);
        relClose(mdp.volume, 12000 - 1200, 1e-9);
        expect(mdp.faceCount).toBe(11);
        // The new wall pieces merged into the pocket walls, which keep their names.
        expect(names(deeper, 'face').sort()).toEqual(names(body, 'face').sort());
        relClose(faceFp(ss, deeper, `${E}:side(${S}:e(L1))`).area, 20 * 6, 1e-9);
        vecClose(faceFp(ss, deeper, `${E}:end`).centroid, [20, 15, 4]);
        checkNaming(deeper);
      });

      it('a cylinder side face is UNSUPPORTED_FEATURE naming the face; its flat top works', () => {
        const ss = session();
        const cyl = ss.exec(
          {
            id: CYL,
            type: 'primitive',
            name: 'Cylinder',
            suppressed: false,
            op: 'new',
            shape: 'cylinder',
            radius: '3',
            height: '7',
          },
          { values: { '/radius': 3, '/height': 7 } },
        );
        const side = `F${CYL}:face.side`;
        const e = ss.fail(pushPull(1), pushInputs(cyl, [side], 2));
        expect(e.code).toBe('UNSUPPORTED_FEATURE');
        expect(e.message).toMatch(/face 1 .*curved/i);
        expect(e.entityRefs).toEqual([side]);
        expect(e.detail).toContain(`body face index ${indexOf(cyl, side, 'face')}`);
        // Mixed selections fail on the curved face too.
        const mixed = ss.fail(pushPull(2), pushInputs(cyl, [`F${CYL}:face.zmax`, side], 2));
        expect(mixed.code).toBe('UNSUPPORTED_FEATURE');
        expect(mixed.message).toMatch(/face 2 /);

        const top = push(ss, cyl, [`F${CYL}:face.zmax`], 2);
        const mp = ss.mass(top.shape);
        relClose(mp.volume, PI * 9 * 9, 1e-9);
        expect(mp.faceCount).toBe(3);
        expect(names(top, 'face').sort()).toEqual(names(cyl, 'face').sort());
        checkNaming(top);
      });
    });

    describe('swallowed faces and slanted neighbours', () => {
      it('an inner wall pulled across a slot fills it; walls and floor are swallowed', () => {
        const ss = session();
        const bar = ss.exec(boxAt(BOX, undefined), boxValues(30, 10, 10));
        const u = ss.exec(boxFeature(B2, frameAt([10, 0, 4]), 'cut'), {
          ...boxValues(10, 10, 6),
          target: bar.shape,
        });
        expect(ss.mass(u.shape).faceCount).toBe(10);
        expect(names(u, 'face')).toContain(`F${BOX}:face.zmax#1`);
        const r = push(ss, u, [`F${B2}:face.xmin`], 10);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 3000, 1e-9);
        expect([mp.faceCount, mp.edgeCount, mp.vertexCount]).toEqual([6, 12, 8]);
        // The two top pieces and the new top wall merge into one face; the old piece whose name
        // sorts first keeps it (names that survive one-to-one are never renamed).
        expect(names(r, 'face').sort()).toEqual(
          [...BOX_FACES.filter((n) => !n.endsWith('zmax')), `F${BOX}:face.zmax#0`].sort(),
        );
        relClose(faceFp(ss, r, `F${BOX}:face.zmax#0`).area, 300, 1e-9);
        relClose(faceFp(ss, r, `F${BOX}:face.ymin`).area, 300, 1e-9);
        checkNaming(r);
      });

      it('next to a chamfer the wall stays: F<pp>:side(edge(<top>|<chamfer>))', () => {
        const ss = session();
        const CH = '01JCHAMFER0000000000000001';
        const box = ss.exec(boxAt(BOX, undefined), boxValues(40, 30, 10));
        const edge = `F${BOX}:edge(face.ymin|face.zmax)`;
        const ch = ss.exec(
          {
            id: CH,
            type: 'chamfer',
            name: 'Chamfer',
            suppressed: false,
            edges: [{ name: edge, kind: 'edge' }],
            mode: { kind: 'distance', distance: '2' },
          },
          {
            values: { '/mode/distance': 2 },
            target: box.shape,
            refs: {
              '/edges/0': { shape: box.shape, kind: 'edge', index: indexOf(box, edge, 'edge') },
            },
          },
        );
        const chamferFace = `F${CH}:chamfer(${edge})`;
        expect(names(ch, 'face')).toContain(chamferFace);
        const r = push(ss, ch, [`F${BOX}:face.zmax`], 5);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 12000 - 0.5 * 2 * 2 * 40 + 40 * 28 * 5, 1e-9);
        expect(mp.faceCount).toBe(8);
        const wall = `${P}:side(edge(F${BOX}:face.zmax|${chamferFace}))`;
        expect(names(r, 'face').filter((n) => n.startsWith(`${P}:`))).toEqual([wall]);
        const fp = faceFp(ss, r, wall);
        vecClose(fp.centroid, [20, 2, 12.5]);
        vecClose(fp.normal ?? [], [0, -1, 0], 1e-12);
        relClose(fp.area, 200, 1e-9);
        expect(names(r, 'face')).toContain(chamferFace);
        expect(names(r, 'edge')).toContain(`edge(F${BOX}:face.zmax|${wall})`);
        expect(names(r, 'edge')).toContain(`edge(${chamferFace}|${wall})`);
        checkNaming(r);
      });
    });

    describe('pushing through', () => {
      it('a boss top pushed through boss and plate cuts a clean hole with named walls', () => {
        const ss = session();
        const plate = ss.exec(boxAt(BOX, undefined), boxValues(60, 20, 5));
        const body = ss.exec(boxAt(B2, frameAt([25, 5, 5]), 'add'), {
          ...boxValues(10, 10, 5),
          target: plate.shape,
        });
        const r = push(ss, body, [`F${B2}:face.zmax`], -12);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 6000 - 10 * 10 * 5, 1e-9);
        expect(mp.faceCount).toBe(10);
        expect(r.warnings).toEqual([]);
        const walls = names(r, 'face')
          .filter((n) => n.startsWith(`${P}:`))
          .sort();
        expect(walls).toEqual(
          ['xmax', 'xmin', 'ymax', 'ymin']
            .map((role) => `${P}:side(edge(F${B2}:face.${role}|F${B2}:face.zmax))`)
            .sort(),
        );
        const xmin = faceFp(ss, r, `${P}:side(edge(F${B2}:face.xmin|F${B2}:face.zmax))`);
        vecClose(xmin.centroid, [25, 10, 2.5]);
        // Hole walls face into the hole.
        vecClose(xmin.normal ?? [], [1, 0, 0], 1e-12);
        relClose(xmin.area, 50, 1e-9);
        expect(names(r, 'face').filter((n) => n.startsWith(`F${B2}:`))).toEqual([]);
        relClose(faceFp(ss, r, `F${BOX}:face.zmax`).area, 1200 - 100, 1e-9);
        checkNaming(r);
      });

      it('pushing a face in by the whole thickness or more is a clear error', () => {
        const ss = session();
        const box = ss.exec(boxAt(BOX, undefined), boxValues(40, 30, 10));
        for (const d of [-10, -25]) {
          const e = ss.fail(pushPull(1), pushInputs(box, [`F${BOX}:face.zmax`], d));
          expect(e.code).toBe('OPERATION_FAILED');
          expect(e.message).toMatch(/removes the whole body/);
          expect(e.hint).toBeTruthy();
          expect(e.entityRefs).toEqual([`F${BOX}:face.zmax`]);
        }
      });

      it('a cut right through a bar splits it: two solids and a warning', () => {
        const ss = session();
        const bar = ss.exec(boxAt(BOX, undefined), boxValues(60, 10, 10));
        const notch = ss.exec(boxAt(B2, frameAt([25, 0, 10]), 'add'), {
          ...boxValues(10, 10, 5),
          target: bar.shape,
        });
        const r = push(ss, notch, [`F${B2}:face.zmax`], -15);
        const mp = ss.mass(r.shape);
        relClose(mp.volume, 6000 - 1000, 1e-9);
        expect(r.warnings.map((w) => w.message)).toEqual([
          'The push/pull split the body into 2 separate solids',
        ]);
      });
    });

    describe('input errors', () => {
      it('zero distance, edges, foreign faces, missing values and references', () => {
        const ss = session();
        const box = ss.exec(boxAt(BOX, undefined), boxValues(10, 10, 10));
        const other = ss.exec(boxAt(B2, frameAt([20, 0, 0])), boxValues(5, 5, 5));
        const top = `F${BOX}:face.zmax`;
        expect(ss.fail(pushPull(1), pushInputs(box, [top], 0)).code).toBe('INVALID_INPUT');
        expect(ss.fail(pushPull(1), pushInputs(box, [top], 1e-9)).code).toBe('INVALID_INPUT');
        const edge = ss.fail(pushPull(1), {
          target: box.shape,
          values: { '/distance': 2 },
          refs: { '/faces/0': { shape: box.shape, kind: 'edge', index: 0 } },
        });
        expect(edge.code).toBe('INVALID_INPUT');
        const foreign = ss.fail(pushPull(1), {
          target: box.shape,
          values: { '/distance': 2 },
          refs: { '/faces/0': { shape: other.shape, kind: 'face', index: 0 } },
        });
        expect(foreign.code).toBe('INVALID_INPUT');
        expect(foreign.message).toMatch(/not on the body/);
        expect(
          ss.fail(pushPull(1), { target: box.shape, values: { '/distance': 2 }, refs: {} }).code,
        ).toBe('UNRESOLVED_REFERENCE');
        const noValue = pushInputs(box, [top], 2);
        noValue.values = {};
        expect(ss.fail(pushPull(1), noValue).code).toBe('INVALID_INPUT');
        const stale = pushInputs(box, [top], 2);
        stale.target = 987654;
        expect(ss.fail(pushPull(1), stale).code).toBe('INVALID_HANDLE');
        // The same face twice counts once.
        const twice = ss.exec(pushPull(2), {
          ...pushInputs(box, [top], 2),
          refs: {
            '/faces/0': { shape: box.shape, kind: 'face', index: indexOf(box, top, 'face') },
            '/faces/1': { shape: box.shape, kind: 'face', index: indexOf(box, top, 'face') },
          },
        });
        relClose(ss.mass(twice.shape).volume, 1200, 1e-9);
      });

      it('without inputs.target the body of the first face is used', () => {
        const ss = session();
        const box = ss.exec(boxAt(BOX, undefined), boxValues(10, 10, 10));
        const inputs = pushInputs(box, [`F${BOX}:face.ymin`], 3);
        delete inputs.target;
        const r = ss.exec(pushPull(1), inputs);
        relClose(ss.mass(r.shape).volume, 1300, 1e-9);
        vecClose(ss.mass(r.shape).bbox.min, [0, -3, 0]);
      });
    });
  });
}
