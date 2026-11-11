/**
 * Kernel golden (ADR-083): the per-sub-shape memo behind `bounds`, `fingerprints` and the bbox of
 * `massProperties` / `mesh` is invisible. A chain of features (a plate, a through hole, a blind
 * pocket bounded by a B-spline, a fillet) shares most faces from step to step; one kernel instance
 * queries every step in order (warm memo: shared faces come from earlier handles), a second, fresh
 * instance builds the same chain and queries only the last step, then the steps in reverse. Every
 * answer must be byte-identical JSON.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, KernelVariant, SketchEntity } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  circle,
  extrude,
  indexOf,
  line,
  loadVariant,
  profileRefs,
  pt,
  Session,
  sketch,
  sketchInputs,
  suiteTitle,
  VARIANTS,
  variantBuilt,
  vecClose,
} from './helpers';

const BOX = '01JMEMOBOX0000000000000001';
const HOLE_SK = '01JMEMOSK00000000000000001';
const HOLE = '01JMEMOEX00000000000000001';
const ARCH_SK = '01JMEMOSK00000000000000002';
const POCKET = '01JMEMOEX00000000000000002';
const FILLET = '01JMEMOFI00000000000000001';

/** A cubic B-spline arch closed by a line (a free-form pocket outline). */
const arch = (): SketchEntity[] => [
  pt('a', 4, 4),
  pt('b', 24, 4),
  pt('q1', 6, 14),
  pt('q2', 14, 18),
  pt('q3', 22, 12),
  {
    id: 'B1',
    kind: 'bspline',
    poles: ['a', 'q1', 'q2', 'q3', 'b'],
    degree: 3,
    periodic: false,
    construction: false,
  },
  line('L1', 'b', 'a'),
];

/** Builds the chain in `k`; returns every step's shape (all held by the session). */
function chain(s: Session): number[] {
  const plate = s.exec(boxFeature(BOX), boxValues(40, 30, 10));
  const holeSk = s.exec(sketch(HOLE_SK, circle('C', 30, 15, 5)), sketchInputs());
  const hole = s.exec(extrude(HOLE, { end: 'throughAll', op: 'cut' }), {
    values: {},
    target: plate.shape,
    refs: profileRefs(holeSk.shape, [indexOf(holeSk, `S${HOLE_SK}:region(C)`, 'face')]),
  });
  const archSk = s.exec(sketch(ARCH_SK, arch()), sketchInputs());
  const pocket = s.exec(extrude(POCKET, { op: 'cut' }), {
    values: { '/end/depth': 4 },
    target: hole.shape,
    refs: profileRefs(archSk.shape, [indexOf(archSk, `S${ARCH_SK}:region(B1,L1)`, 'face')]),
  });
  const edge = pocket.naming.find(
    (n) => n.kind === 'edge' && n.name.includes('face.xmax') && n.name.includes('face.ymax'),
  );
  if (!edge)
    throw new Error(
      `no plate edge to fillet: ${pocket.naming
        .filter((n) => n.kind === 'edge')
        .map((n) => n.name)
        .join(' ')}`,
    );
  const fillet: Feature = {
    id: FILLET,
    type: 'fillet',
    name: 'Fillet',
    suppressed: false,
    edges: [{ name: edge.name, kind: 'edge' }],
    radius: '1.5',
  } as Feature;
  const inputs: FeatureInputs = {
    values: { '/radius': 1.5 },
    target: pocket.shape,
    refs: { '/edges/0': { shape: pocket.shape, kind: 'edge', index: edge.index } },
  };
  const filleted = s.exec(fillet, inputs);
  return [plate.shape, holeSk.shape, hole.shape, archSk.shape, pocket.shape, filleted.shape];
}

/** Everything the memo feeds, as raw JSON (mesh: its meta, which carries the bbox). */
function answers(k: WhittleKernelModule, shape: number): string[] {
  const bounds = k.bounds as (shape: number) => string;
  const md = new k.MeshData();
  try {
    const meshed = k.mesh(
      shape,
      JSON.stringify({ linearDeflection: 0.05, angularDeflection: 0.5 }),
      md,
    );
    return [
      bounds(shape),
      k.fingerprints(shape),
      k.massProperties(shape, 0),
      meshed,
      md.metaJson(),
    ];
  } finally {
    md.delete();
  }
}

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('sub-shape memo', variant), () => {
    let warm: WhittleKernelModule;
    let fresh: WhittleKernelModule;
    beforeAll(async () => {
      warm = await loadVariant(variant as KernelVariant);
      fresh = await loadVariant(variant as KernelVariant);
    }, 120_000);
    afterAll(() => {
      if (warm) expect(warm.liveHandleCount()).toBe(0);
      if (fresh) expect(fresh.liveHandleCount()).toBe(0);
    });

    it('answers are byte-identical with a warm memo, a cold one and in any order', () => {
      const a = new Session(warm);
      const stepsA = chain(a);
      const inOrder = stepsA.map((shape) => answers(warm, shape));
      // Query the last step again after releasing its predecessors (a sweep in between).
      const last = stepsA.at(-1) as number;
      for (const h of stepsA.slice(0, -1)) warm.release(h);
      a.handles.splice(0, a.handles.length, last);
      expect(answers(warm, last)).toEqual(inOrder.at(-1));

      const b = new Session(fresh);
      const stepsB = chain(b);
      const reversed = [...stepsB].reverse().map((shape) => answers(fresh, shape));
      reversed.reverse();
      expect(reversed).toEqual(inOrder);
      // The chain really shares faces: the fillet's bounds were partly served from memo entries
      // of earlier steps (same values as above), and it is a 3-D box of the plate.
      const box = JSON.parse(inOrder.at(-1)?.[0] ?? '{}') as {
        value: { bbox: { min: number[]; max: number[] }; faceCount: number };
      };
      vecClose(box.value.bbox.min, [0, 0, 0]);
      vecClose(box.value.bbox.max, [40, 30, 10]);
      expect(box.value.faceCount).toBeGreaterThan(10);
      a.releaseAll();
      b.releaseAll();
    });
  });
}
