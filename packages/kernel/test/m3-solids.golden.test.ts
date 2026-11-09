/**
 * M3 golden tests: shell, draft, sweep and loft. Volumes and areas against analytic values
 * (1e-6 relative), face counts, names (naming.ts "M3 additions"), "edit upstream" stability and
 * structured errors that leave the worker usable.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, Frame, ResolvedRef } from '@wren-cad/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  circle,
  frameAt,
  indexOf,
  line,
  loadVariant,
  names,
  pt,
  rect,
  relClose,
  Session,
  sketch,
  sketchInputs,
  suiteTitle,
  VARIANTS,
  variantBuilt,
} from './helpers';

const PI = Math.PI;
const REL = 1e-6;
const BOX = '01JM3BOX000000000000000001';
const B = `F${BOX}`;
const SH = '01JM3SHELL0000000000000001';
const DR = '01JM3DRAFT0000000000000001';
const SW = '01JM3SWEEP0000000000000001';
const LO = '01JM3LOFT00000000000000001';
const SKA = '01JM3SKA000000000000000001';
const SKB = '01JM3SKB000000000000000001';
const SKC = '01JM3SKC000000000000000001';

const face = (shape: number, index: number) => ({ shape, kind: 'face' as const, index });
const edge = (shape: number, index: number) => ({ shape, kind: 'edge' as const, index });

function shellFeature(direction: 'inward' | 'outward' = 'inward', open = 1): Feature {
  return {
    id: SH,
    type: 'shell',
    name: 'Shell',
    suppressed: false,
    openFaces: Array.from({ length: open }, () => ({ name: 'open', kind: 'face' as const })),
    thickness: '2',
    direction,
  };
}

function draftFeature(reverse = false): Feature {
  return {
    id: DR,
    type: 'draft',
    name: 'Draft',
    suppressed: false,
    faces: [{ name: `${B}:face.xmax`, kind: 'face' }],
    neutral: { name: `${B}:face.zmin`, kind: 'face' },
    angle: '5deg',
    reverse,
  };
}

function sweepFeature(
  orientation: 'followPath' | 'fixed',
  op: 'new' | 'cut' = 'new',
  path = 1,
): Feature {
  return {
    id: SW,
    type: 'sweep',
    name: 'Sweep',
    suppressed: false,
    profile: [{ name: 'region', kind: 'region' }],
    path: Array.from({ length: path }, () => ({ name: 'path', kind: 'edge' as const })),
    orientation,
    op,
  };
}

function loftFeature(sections: number, ruled = true, closed = false): Feature {
  return {
    id: LO,
    type: 'loft',
    name: 'Loft',
    suppressed: false,
    sections: Array.from({ length: sections }, () => ({
      name: 'section',
      kind: 'region' as const,
    })),
    ruled,
    closed,
    op: 'new',
  };
}

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('M3 solids', variant), () => {
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

    // -------------------------------------------------------------------------------------
    // Shell
    // -------------------------------------------------------------------------------------

    describe('shell', () => {
      const shellBox = (
        ss: Session,
        dx: number,
        direction: 'inward' | 'outward' = 'inward',
        t = 2,
      ) => {
        const box = ss.exec(boxFeature(BOX), boxValues(dx, 30, 20));
        const r = ss.exec(shellFeature(direction), {
          values: { '/thickness': t },
          target: box.shape,
          refs: { '/openFaces/0': face(box.shape, indexOf(box, `${B}:face.zmax`, 'face')) },
        });
        return { box, r };
      };

      it('open-top box, 2 mm inward: volume, area, 11 faces, shell and rim names', () => {
        const ss = session();
        const { r } = shellBox(ss, 40);
        const m = ss.mass(r.shape);
        relClose(m.volume, 40 * 30 * 20 - 36 * 26 * 18, REL);
        relClose(m.area, 4000 + 3168 + 264, REL);
        expect(m.faceCount).toBe(11);
        const faces = names(r, 'face').sort();
        expect(faces).toEqual(
          [
            `${B}:face.xmax`,
            `${B}:face.xmin`,
            `${B}:face.ymax`,
            `${B}:face.ymin`,
            `${B}:face.zmin`,
            `F${SH}:rim(${B}:face.zmax)`,
            `F${SH}:shell(${B}:face.xmax)`,
            `F${SH}:shell(${B}:face.xmin)`,
            `F${SH}:shell(${B}:face.ymax)`,
            `F${SH}:shell(${B}:face.ymin)`,
            `F${SH}:shell(${B}:face.zmin)`,
          ].sort(),
        );
        const fp = ss.fingerprints(r.shape);
        const floor = fp.faces[indexOf(r, `F${SH}:shell(${B}:face.zmin)`, 'face')];
        relClose(floor?.area ?? 0, 36 * 26, REL);
        relClose(floor?.centroid[2] ?? 0, 2, REL);
        relClose(fp.faces[indexOf(r, `F${SH}:rim(${B}:face.zmax)`, 'face')]?.area ?? 0, 264, REL);
      });

      it('outward keeps the open face plane and grows the outside', () => {
        const ss = session();
        const { r } = shellBox(ss, 40, 'outward');
        const m = ss.mass(r.shape);
        relClose(m.volume, 44 * 34 * 22 - 40 * 30 * 20, REL);
        expect(m.faceCount).toBe(11);
        relClose(m.bbox.max[2], 20, REL);
        relClose(m.bbox.min[0], -2, REL);
        expect(names(r, 'face')).toContain(`F${SH}:shell(${B}:face.xmin)`);
      });

      it('no open faces: a closed hollow solid (inner void)', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(40, 30, 20));
        const r = ss.exec(
          { ...shellFeature('inward', 0), body: { name: `B${BOX}`, kind: 'body' } } as Feature,
          { values: { '/thickness': 2 }, target: box.shape },
        );
        const m = ss.mass(r.shape);
        relClose(m.volume, 24000 - 36 * 26 * 16, REL);
        expect(m.faceCount).toBe(12);
        expect(names(r, 'face')).toContain(`F${SH}:shell(${B}:face.zmax)`);
      });

      it('open-top cylinder, 1 mm inward', () => {
        const ss = session();
        const cyl = ss.exec(
          {
            id: BOX,
            type: 'primitive',
            name: 'Cylinder',
            suppressed: false,
            op: 'new',
            shape: 'cylinder',
            radius: '10',
            height: '20',
          },
          { values: { '/radius': 10, '/height': 20 } },
        );
        const r = ss.exec(shellFeature(), {
          values: { '/thickness': 1 },
          target: cyl.shape,
          refs: { '/openFaces/0': face(cyl.shape, indexOf(cyl, `${B}:face.zmax`, 'face')) },
        });
        relClose(ss.mass(r.shape).volume, PI * (100 * 20 - 81 * 19), REL);
        expect(names(r, 'face').sort()).toEqual(
          [
            `${B}:face.side`,
            `${B}:face.zmin`,
            `F${SH}:rim(${B}:face.zmax)`,
            `F${SH}:shell(${B}:face.side)`,
            `F${SH}:shell(${B}:face.zmin)`,
          ].sort(),
        );
      });

      it('names are stable when the box is resized upstream', () => {
        const ss = session();
        const a = shellBox(ss, 40).r;
        const b = shellBox(ss, 60).r;
        relClose(ss.mass(b.shape).volume, 60 * 30 * 20 - 56 * 26 * 18, REL);
        expect(names(a).sort()).toEqual(names(b).sort());
      });

      it('an over-thick shell is a structured error and the kernel keeps working', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(40, 30, 20));
        const e = ss.fail(shellFeature(), {
          values: { '/thickness': 16 },
          target: box.shape,
          refs: { '/openFaces/0': face(box.shape, indexOf(box, `${B}:face.zmax`, 'face')) },
        });
        expect(e.code).toBe('OPERATION_FAILED');
        expect(e.message).toMatch(/too thick/);
        expect(e.entityRefs).toEqual([`${B}:face.zmax`]);
        const ok = shellBox(ss, 40).r;
        expect(ss.mass(ok.shape).faceCount).toBe(11);
        expect(
          ss.fail(shellFeature(), { values: { '/thickness': 0 }, target: box.shape }).code,
        ).toBe('INVALID_INPUT');
      });
    });

    // -------------------------------------------------------------------------------------
    // Draft
    // -------------------------------------------------------------------------------------

    describe('draft', () => {
      const t5 = Math.tan((5 * PI) / 180);
      const drafted = (ss: Session, reverse: boolean, faceName = `${B}:face.xmax`) => {
        const box = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
        return {
          box,
          r: ss.exec(
            { ...draftFeature(reverse), faces: [{ name: faceName, kind: 'face' }] } as Feature,
            {
              values: { '/angle': (5 * PI) / 180 },
              target: box.shape,
              refs: {
                '/faces/0': face(box.shape, indexOf(box, faceName, 'face')),
                '/neutral': face(box.shape, indexOf(box, `${B}:face.zmin`, 'face')),
              },
            },
          ),
        };
      };

      it('5° on one side face about the bottom: volume, area, names kept', () => {
        const ss = session();
        // Pull direction = the neutral plane's normal on the drafted faces' side (+z: the face is
        // above the bottom); a positive angle narrows the body along it, so the drafted face
        // leans in at the top: its top edge moves by 10·tan 5° in -x (a moulded box with its
        // parting line at the bottom). `reverse` flips the pull direction and the taper.
        const { box, r } = drafted(ss, false);
        const m = ss.mass(r.shape);
        const top = 10 - 10 * t5;
        const cos5 = Math.cos((5 * PI) / 180);
        relClose(m.volume, 1000 - 500 * t5, REL);
        relClose(m.bbox.max[0], 10, REL);
        // xmin + bottom + top + two trapezoid sides + the tilted face.
        relClose(m.area, 100 + 100 + 10 * top + 2 * ((10 + top) / 2) * 10 + 100 / cos5, REL);
        expect(m.faceCount).toBe(6);
        expect(names(r, 'face').sort()).toEqual(names(box, 'face').sort());
        const rev = drafted(ss, true).r;
        const mr = ss.mass(rev.shape);
        relClose(mr.volume, 1000 + 500 * t5, REL);
        relClose(mr.bbox.max[0], 10 + 10 * t5, REL);
        relClose(
          mr.area,
          100 + 100 + 10 * (10 + 10 * t5) + 2 * ((20 + 10 * t5) / 2) * 10 + 100 / cos5,
          REL,
        );
      });

      it('the body narrows away from the neutral plane, whichever way the plane points', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
        const xmax = face(box.shape, indexOf(box, `${B}:face.xmax`, 'face'));
        const run = (
          neutral: { refs?: Record<string, ResolvedRef>; frames?: Record<string, Frame> },
          reverse = false,
        ) => {
          const inputs: FeatureInputs = {
            values: { '/angle': (5 * PI) / 180 },
            target: box.shape,
            refs: { '/faces/0': xmax, ...neutral.refs },
          };
          if (neutral.frames) inputs.frames = neutral.frames;
          return ss.mass(ss.exec(draftFeature(reverse), inputs).shape);
        };
        // Top face as neutral (outward normal +z; the drafted face is below it): the pull is -z,
        // the top edge stays and the bottom edge moves in.
        const topFace = run({
          refs: { '/neutral': face(box.shape, indexOf(box, `${B}:face.zmax`, 'face')) },
        });
        relClose(topFace.volume, 1000 - 500 * t5, REL);
        relClose(topFace.bbox.max[0], 10, REL);
        expect(topFace.centroid[2]).toBeGreaterThan(5);
        // A datum plane through the bottom face acts like the face, pointing up or down.
        for (const z of [1, -1]) {
          const frames = { neutral: frameAt([0, 0, 0], [0, 0, z]) };
          const datum = run({ frames });
          relClose(datum.volume, 1000 - 500 * t5, REL);
          expect(datum.centroid[2]).toBeLessThan(5);
          relClose(run({ frames }, true).volume, 1000 + 500 * t5, REL);
        }
        // Mid-plane neutral (the face is centred on it): the plane's own normal is the pull, so
        // +z narrows the top half and widens the bottom half by the same amount.
        const frames = { neutral: frameAt([0, 0, 5]) };
        const mid = run({ frames });
        relClose(mid.volume, 1000, REL);
        relClose(mid.bbox.max[0], 10 + 5 * t5, REL);
        expect(mid.centroid[2]).toBeLessThan(5);
        expect(run({ frames }, true).centroid[2]).toBeGreaterThan(5);
      });

      it('names are stable when the box is resized upstream', () => {
        const ss = session();
        const a = drafted(ss, false).r;
        const box = ss.exec(boxFeature(BOX), boxValues(10, 25, 10));
        const b = ss.exec(draftFeature(), {
          values: { '/angle': (5 * PI) / 180 },
          target: box.shape,
          refs: {
            '/faces/0': face(box.shape, indexOf(box, `${B}:face.xmax`, 'face')),
            '/neutral': face(box.shape, indexOf(box, `${B}:face.zmin`, 'face')),
          },
        });
        relClose(ss.mass(b.shape).volume, 2500 - 1250 * t5, REL);
        expect(names(b).sort()).toEqual(names(a).sort());
        expect(names(a).filter((n) => n.includes(':unnamed'))).toEqual([]);
      });

      it('a face parallel to the neutral plane cannot be drafted (structured error)', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
        const e = ss.fail(
          { ...draftFeature(), faces: [{ name: `${B}:face.zmax`, kind: 'face' }] } as Feature,
          {
            values: { '/angle': (5 * PI) / 180 },
            target: box.shape,
            refs: {
              '/faces/0': face(box.shape, indexOf(box, `${B}:face.zmax`, 'face')),
              '/neutral': face(box.shape, indexOf(box, `${B}:face.zmin`, 'face')),
            },
          },
        );
        expect(e.code).toBe('OPERATION_FAILED');
        expect(e.entityRefs).toEqual([`${B}:face.zmax`]);
        // Neutral plane as an origin-plane frame.
        const ok = ss.exec(draftFeature(), {
          values: { '/angle': (5 * PI) / 180 },
          target: box.shape,
          refs: { '/faces/0': face(box.shape, indexOf(box, `${B}:face.xmax`, 'face')) },
          frames: { neutral: frameAt([0, 0, 0]) }, // the regen engine's role key
        });
        expect(ss.mass(ok.shape).faceCount).toBe(6);
      });
    });

    // -------------------------------------------------------------------------------------
    // Sweep
    // -------------------------------------------------------------------------------------

    describe('sweep', () => {
      /** A sketch on `plane` and its single region's face index. */
      const region = (
        ss: Session,
        id: string,
        entities: Parameters<typeof sketch>[1],
        plane: Frame,
        name: string,
      ) => {
        const r = ss.exec(sketch(id, entities), sketchInputs(plane));
        return { r, index: indexOf(r, name, 'face') };
      };
      /** Quarter arc of radius R in the XY plane, from (R,0,0) to (0,R,0). */
      const quarterArc = (ss: Session, R: number) => {
        const r = ss.exec(
          sketch(SKB, [
            pt('o', 0, 0),
            pt('a', R, 0),
            pt('b', 0, R),
            { id: 'arc', kind: 'arc', center: 'o', start: 'a', end: 'b', construction: false },
          ]),
          sketchInputs(),
        );
        return { r, index: indexOf(r, `S${SKB}:e(arc)`, 'edge') };
      };

      it('a disc along a quarter arc (follow path) is a quarter torus', () => {
        const ss = session();
        const prof = region(
          ss,
          SKA,
          circle('c', 0, 0, 2),
          frameAt([20, 0, 0], [0, 1, 0], [1, 0, 0]),
          `S${SKA}:region(c)`,
        );
        const path = quarterArc(ss, 20);
        const r = ss.exec(sweepFeature('followPath'), {
          values: {},
          refs: {
            '/profile/0': face(prof.r.shape, prof.index),
            '/path/0': edge(path.r.shape, path.index),
          },
        });
        const m = ss.mass(r.shape);
        relClose(m.volume, PI * 4 * ((PI * 20) / 2), REL);
        relClose(m.area, 2 * PI * 2 * ((PI * 20) / 2) + 2 * PI * 4, REL);
        expect(names(r, 'face').sort()).toEqual(
          [`F${SW}:end`, `F${SW}:side(S${SKA}:e(c))`, `F${SW}:start`].sort(),
        );
      });

      it('fixed orientation translates the disc: V = area × rise along its normal', () => {
        const ss = session();
        const prof = region(
          ss,
          SKA,
          circle('c', 0, 0, 2),
          frameAt([20, 0, 0], [0, 1, 0], [1, 0, 0]),
          `S${SKA}:region(c)`,
        );
        const path = quarterArc(ss, 20);
        const r = ss.exec(sweepFeature('fixed'), {
          values: {},
          refs: {
            '/profile/0': face(prof.r.shape, prof.index),
            '/path/0': edge(path.r.shape, path.index),
          },
        });
        relClose(ss.mass(r.shape).volume, PI * 4 * 20, REL);
      });

      it('names are stable when the path radius changes upstream', () => {
        const ss = session();
        const run = (R: number) => {
          const prof = region(
            ss,
            SKA,
            circle('c', 0, 0, 2),
            frameAt([R, 0, 0], [0, 1, 0], [1, 0, 0]),
            `S${SKA}:region(c)`,
          );
          const path = quarterArc(ss, R);
          return ss.exec(sweepFeature('followPath'), {
            values: {},
            refs: {
              '/profile/0': face(prof.r.shape, prof.index),
              '/path/0': edge(path.r.shape, path.index),
            },
          });
        };
        const a = run(20);
        const b = run(30);
        relClose(ss.mass(b.shape).volume, PI * 4 * ((PI * 30) / 2), REL);
        expect(names(b).sort()).toEqual(names(a).sort());
        expect(names(a).filter((n) => n.includes(':unnamed'))).toEqual([]);
      });

      it('a rectangle along a two-edge path (box), names and both orientations', () => {
        const ss = session();
        const prof = region(
          ss,
          SKA,
          rect(0, 0, 10, 5),
          frameAt([0, 0, 0]),
          `S${SKA}:region(L1,L2,L3,L4)`,
        );
        // Path: two collinear segments up the z axis, from a sketch on the XZ plane.
        const p = ss.exec(
          sketch(SKB, [
            pt('a', 0, 0),
            pt('b', 0, 10),
            pt('c', 0, 30),
            line('l1', 'a', 'b'),
            line('l2', 'b', 'c'),
          ]),
          sketchInputs(frameAt([0, 0, 0], [0, -1, 0], [1, 0, 0])),
        );
        for (const orientation of ['followPath', 'fixed'] as const) {
          const r = ss.exec(sweepFeature(orientation, 'new', 2), {
            values: {},
            refs: {
              '/profile/0': face(prof.r.shape, prof.index),
              '/path/0': edge(p.shape, indexOf(p, `S${SKB}:e(l1)`, 'edge')),
              '/path/1': edge(p.shape, indexOf(p, `S${SKB}:e(l2)`, 'edge')),
            },
          });
          const m = ss.mass(r.shape);
          relClose(m.volume, 10 * 5 * 30, REL);
          relClose(m.area, 2 * 50 + 2 * (10 + 5) * 30, REL);
          for (const l of ['L1', 'L2', 'L3', 'L4']) {
            expect(names(r, 'face').some((n) => n.startsWith(`F${SW}:side(S${SKA}:e(${l}))`))).toBe(
              true,
            );
          }
          expect(names(r, 'face')).toContain(`F${SW}:start`);
          expect(names(r, 'face')).toContain(`F${SW}:end`);
        }
      });

      it('sweep cut removes a groove; a profile with a hole sweeps a tube', () => {
        const ss = session();
        const tube = region(
          ss,
          SKA,
          [...circle('o', 0, 0, 3), ...circle('i', 0, 0, 2)],
          frameAt([0, 0, 0]),
          `S${SKA}:region(o|i)`,
        );
        const p = ss.exec(
          sketch(SKB, [pt('a', 0, 0), pt('b', 0, 25), line('l1', 'a', 'b')]),
          sketchInputs(frameAt([0, 0, 0], [0, -1, 0], [1, 0, 0])),
        );
        const pathRef = edge(p.shape, indexOf(p, `S${SKB}:e(l1)`, 'edge'));
        const t = ss.exec(sweepFeature('followPath'), {
          values: {},
          refs: { '/profile/0': face(tube.r.shape, tube.index), '/path/0': pathRef },
        });
        relClose(ss.mass(t.shape).volume, PI * (9 - 4) * 25, REL);
        expect(names(t, 'face')).toContain(`F${SW}:side(S${SKA}:e(i))`);
        const box = ss.exec(boxFeature(BOX, frameAt([-10, -10, 5])), boxValues(20, 20, 10));
        const cut = ss.exec(sweepFeature('followPath', 'cut'), {
          values: {},
          target: box.shape,
          refs: { '/profile/0': face(tube.r.shape, tube.index), '/path/0': pathRef },
        });
        relClose(ss.mass(cut.shape).volume, 4000 - PI * 5 * 10, REL);
      });

      it('a self-intersecting sweep is a structured error', () => {
        const ss = session();
        const prof = region(
          ss,
          SKA,
          circle('c', 0, 0, 5),
          frameAt([2, 0, 0], [0, 1, 0], [1, 0, 0]),
          `S${SKA}:region(c)`,
        );
        const path = quarterArc(ss, 2);
        const e = ss.fail(sweepFeature('followPath'), {
          values: {},
          refs: {
            '/profile/0': face(prof.r.shape, prof.index),
            '/path/0': edge(path.r.shape, path.index),
          },
        });
        expect(['OPERATION_FAILED', 'OCCT_EXCEPTION']).toContain(e.code);
        // Disconnected path edges.
        const p = ss.exec(
          sketch(SKC, [
            pt('a', 0, 0),
            pt('b', 0, 10),
            pt('c', 5, 20),
            pt('d', 5, 30),
            line('l1', 'a', 'b'),
            line('l2', 'c', 'd'),
          ]),
          sketchInputs(frameAt([0, 0, 0], [0, -1, 0], [1, 0, 0])),
        );
        const e2 = ss.fail(sweepFeature('followPath', 'new', 2), {
          values: {},
          refs: {
            '/profile/0': face(prof.r.shape, prof.index),
            '/path/0': edge(p.shape, indexOf(p, `S${SKC}:e(l1)`, 'edge')),
            '/path/1': edge(p.shape, indexOf(p, `S${SKC}:e(l2)`, 'edge')),
          },
        });
        expect(e2.code).toBe('INVALID_INPUT');
        expect(e2.entityRefs).toEqual([`S${SKC}:e(l2)`]);
      });
    });

    // -------------------------------------------------------------------------------------
    // Loft
    // -------------------------------------------------------------------------------------

    describe('loft', () => {
      const squareAt = (ss: Session, id: string, side: number, z: number) => {
        const h = side / 2;
        const r = ss.exec(sketch(id, rect(-h, -h, h, h)), sketchInputs(frameAt([0, 0, z])));
        return face(r.shape, indexOf(r, `S${id}:region(L1,L2,L3,L4)`, 'face'));
      };
      const discAt = (ss: Session, id: string, radius: number, z: number) => {
        const r = ss.exec(sketch(id, circle('c', 0, 0, radius)), sketchInputs(frameAt([0, 0, z])));
        return face(r.shape, indexOf(r, `S${id}:region(c)`, 'face'));
      };
      const loft = (ss: Session, feature: Feature, sections: ResolvedRef[]) => {
        const refs: NonNullable<FeatureInputs['refs']> = {};
        sections.forEach((r, i) => {
          refs[`/sections/${i}`] = r;
        });
        return ss.exec(feature, { values: {}, refs });
      };

      it('square 20 → square 10 over 10 (ruled): pyramid frustum', () => {
        const ss = session();
        const r = loft(ss, loftFeature(2), [squareAt(ss, SKA, 20, 0), squareAt(ss, SKB, 10, 10)]);
        const m = ss.mass(r.shape);
        relClose(m.volume, (10 / 3) * (400 + 100 + 200), REL);
        const slant = Math.hypot(10, 5);
        relClose(m.area, 400 + 100 + 4 * ((20 + 10) / 2) * slant, REL);
        expect(m.faceCount).toBe(6);
        const faces = names(r, 'face');
        expect(faces).toContain(`F${LO}:start`);
        expect(faces).toContain(`F${LO}:end`);
        for (const l of ['L1', 'L2', 'L3', 'L4'])
          expect(faces).toContain(`F${LO}:side(S${SKA}:e(${l}))`);
      });

      it('disc r10 → disc r5 (smooth): cone frustum; three sections ruled', () => {
        const ss = session();
        const r = loft(ss, loftFeature(2, false), [discAt(ss, SKA, 10, 0), discAt(ss, SKB, 5, 10)]);
        relClose(ss.mass(r.shape).volume, (PI * 10 * (100 + 50 + 25)) / 3, REL);
        const three = loft(ss, loftFeature(3), [
          squareAt(ss, SKA, 20, 0),
          squareAt(ss, SKB, 10, 10),
          squareAt(ss, SKC, 20, 20),
        ]);
        relClose(ss.mass(three.shape).volume, (2 * 7000) / 3, REL);
      });

      it('square to a point: pyramid', () => {
        const ss = session();
        const apex = ss.exec(sketch(SKB, [pt('top', 0, 0)]), sketchInputs(frameAt([0, 0, 15])));
        const r = loft(ss, loftFeature(2), [
          squareAt(ss, SKA, 20, 0),
          { shape: apex.shape, kind: 'vertex', index: indexOf(apex, `S${SKB}:p(top)`, 'vertex') },
        ]);
        relClose(ss.mass(r.shape).volume, (400 * 15) / 3, REL);
        expect(names(r, 'face')).toContain(`F${LO}:start`);
      });

      it('guides are reported as ignored; bad sections are structured errors', () => {
        const ss = session();
        const withGuides = { ...loftFeature(2), guides: [{ name: 'g', kind: 'edge' }] } as Feature;
        const r = loft(ss, withGuides, [squareAt(ss, SKA, 20, 0), squareAt(ss, SKB, 10, 10)]);
        expect(r.warnings.map((w) => w.code)).toContain('UNSUPPORTED_FEATURE');
        expect(
          ss.fail(loftFeature(1), { values: {}, refs: { '/sections/0': squareAt(ss, SKA, 20, 0) } })
            .code,
        ).toBe('INVALID_INPUT');
        const apex = ss.exec(sketch(SKC, [pt('top', 0, 0)]), sketchInputs(frameAt([0, 0, 15])));
        const closedPoint = ss.fail(loftFeature(2, true, true), {
          values: {},
          refs: {
            '/sections/0': squareAt(ss, SKA, 20, 0),
            '/sections/1': { shape: apex.shape, kind: 'vertex', index: 0 },
          },
        });
        expect(closedPoint.code).toBe('INVALID_INPUT');
      });

      it('names are stable when a section changes size upstream', () => {
        const ss = session();
        const a = loft(ss, loftFeature(2), [squareAt(ss, SKA, 20, 0), squareAt(ss, SKB, 10, 10)]);
        const b = loft(ss, loftFeature(2), [squareAt(ss, SKA, 30, 0), squareAt(ss, SKB, 10, 10)]);
        relClose(ss.mass(b.shape).volume, (10 / 3) * (900 + 100 + 300), REL);
        expect(names(b).sort()).toEqual(names(a).sort());
        expect(names(a).filter((n) => n.includes(':unnamed'))).toEqual([]);
      });

      it('loft add onto a box keeps the box names', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX, frameAt([-10, -10, -5])), boxValues(20, 20, 5));
        const add = ss.exec({ ...loftFeature(2), op: 'add' } as Feature, {
          values: {},
          target: box.shape,
          refs: {
            '/sections/0': squareAt(ss, SKA, 20, 0),
            '/sections/1': squareAt(ss, SKB, 10, 10),
          },
        });
        relClose(ss.mass(add.shape).volume, 2000 + 7000 / 3, REL);
        expect(names(add, 'face')).toContain(`${B}:face.zmin`);
        expect(names(add, 'face')).toContain(`F${LO}:end`);
      });
    });
  });
}
