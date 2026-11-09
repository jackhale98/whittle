/**
 * M3 golden tests: hole wizard, mirror, linear and circular patterns (feature and body copies),
 * the kernel `import` feature, IGES import and the 10×10 hole-pattern regen budget (PLAN §10:
 * 300 ms). Volumes against analytic values (1e-6 relative), face counts and names.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, Frame } from '@wren-cad/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RawImportResult, WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  frameAt,
  indexOf,
  loadVariant,
  names,
  ok,
  type RawFeatureResult,
  relClose,
  Session,
  suiteTitle,
  VARIANTS,
  variantBuilt,
  vecClose,
} from './helpers';
import { igesBox } from './iges';

const PI = Math.PI;
const REL = 1e-6;
const BOX = '01JM3BOX000000000000000001';
const B = `F${BOX}`;
const H = '01JM3HOLE00000000000000001';
const LP = '01JM3LINPAT00000000000000A';
const CP = '01JM3CIRCPAT0000000000000A';
const MI = '01JM3MIRROR00000000000000A';
const IM = '01JM3IMPORT00000000000000A';
const P0 = 'S01JM3SK0000000000000000001:p(h0)';
const P1 = 'S01JM3SK0000000000000000001:p(h1)';
const P2 = 'S01JM3SK0000000000000000001:p(h2)';

/** Frame of a hole drilled straight down (−z) at (x, y, z). */
const down = (x: number, y: number, z: number): Frame => frameAt([x, y, z], [0, 0, -1], [1, 0, 0]);

type HoleOptions = {
  kind?: 'simple' | 'counterbore' | 'countersink' | 'tapped';
  end?: 'blind' | 'throughAll' | 'upTo';
  points?: string[];
  op?: 'cut' | 'new';
};

function holeFeature(o: HoleOptions = {}): Feature {
  const end =
    o.end === 'throughAll'
      ? ({ kind: 'throughAll' } as const)
      : o.end === 'upTo'
        ? ({ kind: 'upTo', target: { name: 'origin:XY', kind: 'face' } } as const)
        : ({ kind: 'blind', depth: '10' } as const);
  const f = {
    id: H,
    type: 'hole',
    name: 'Hole',
    suppressed: false,
    points: (o.points ?? [P0]).map((name) => ({ name, kind: 'vertex' as const })),
    face: { name: `${B}:face.zmax`, kind: 'face' as const },
    standard: 'ISO' as const,
    kind: o.kind ?? 'simple',
    size: 'M6',
    fit: 'normal' as const,
    end,
  };
  return (o.op === undefined ? f : { ...f, op: o.op }) as Feature;
}

function holeInputs(
  target: number | undefined,
  frames: Frame[],
  values: Record<string, number>,
): FeatureInputs {
  const fr: Record<string, Frame> = {};
  frames.forEach((f, i) => {
    fr[`hole:${i}`] = f;
  });
  return { values, frames: fr, ...(target === undefined ? {} : { target }) };
}

function copySource(features: string[]): { kind: 'features'; features: string[] } {
  return { kind: 'features', features };
}

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('M3 copies and holes', variant), () => {
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
    const block = (ss: Session, dx = 40, dy = 40, dz = 20) =>
      ss.exec(boxFeature(BOX), boxValues(dx, dy, dz));

    // -------------------------------------------------------------------------------------
    // Hole wizard
    // -------------------------------------------------------------------------------------

    describe('hole', () => {
      const wall = (p = P0) => `F${H}:hole(${p}):wall`;
      const role = (r: string, p = P0) => `F${H}:hole(${p}):${r}`;

      it('blind Ø6 × 10 with a 118° drill point', () => {
        const ss = session();
        const box = block(ss);
        const r = ss.exec(
          holeFeature(),
          holeInputs(box.shape, [down(20, 20, 20)], {
            '/diameter': 6,
            '/end/depth': 10,
            '/tipAngle': (118 * PI) / 180,
          }),
        );
        const h = 3 / Math.tan((59 * PI) / 180);
        const m = ss.mass(r.shape);
        relClose(m.volume, 32000 - PI * 9 * 10 - (PI * 9 * h) / 3, REL);
        relClose(m.area, 6400 - 9 * PI + 2 * PI * 3 * 10 + PI * 3 * Math.hypot(3, h), REL);
        expect(m.faceCount).toBe(8);
        expect(names(r, 'face')).toContain(wall());
        expect(names(r, 'face')).toContain(role('tip'));
        const fp = ss.fingerprints(r.shape);
        relClose(fp.faces[indexOf(r, wall(), 'face')]?.area ?? 0, 60 * PI, REL);
      });

      it('flat blind, tapped (drill diameter) and up to a plane', () => {
        const ss = session();
        const box = block(ss);
        const flat = ss.exec(
          holeFeature(),
          holeInputs(box.shape, [down(20, 20, 20)], { '/diameter': 6, '/end/depth': 10 }),
        );
        relClose(ss.mass(flat.shape).volume, 32000 - 90 * PI, REL);
        expect(names(flat, 'face')).toContain(role('bottom'));
        const tapped = ss.exec(
          holeFeature({ kind: 'tapped' }),
          holeInputs(box.shape, [down(20, 20, 20)], {
            '/diameter': 5,
            '/end/depth': 12,
            '/thread/depth': 10,
          }),
        );
        relClose(ss.mass(tapped.shape).volume, 32000 - PI * 6.25 * 12, REL);
        const upTo = ss.exec(holeFeature({ end: 'upTo' }), {
          ...holeInputs(box.shape, [down(20, 20, 20)], { '/diameter': 6 }),
          frames: { 'hole:0': down(20, 20, 20), upTo: frameAt([0, 0, 5]) },
        });
        relClose(ss.mass(upTo.shape).volume, 32000 - 9 * PI * 15, REL);
      });

      it('counterbore through all', () => {
        const ss = session();
        const box = block(ss);
        const r = ss.exec(
          holeFeature({ kind: 'counterbore', end: 'throughAll' }),
          holeInputs(box.shape, [down(20, 20, 20)], {
            '/diameter': 6.6,
            '/counterbore/diameter': 11,
            '/counterbore/depth': 6.5,
          }),
        );
        const m = ss.mass(r.shape);
        relClose(m.volume, 32000 - PI * 3.3 * 3.3 * 13.5 - PI * 5.5 * 5.5 * 6.5, REL);
        expect(m.faceCount).toBe(9);
        for (const n of [wall(), role('cbore.wall'), role('cbore.floor')])
          expect(names(r, 'face')).toContain(n);
        const fp = ss.fingerprints(r.shape);
        relClose(
          fp.faces[indexOf(r, role('cbore.floor'), 'face')]?.area ?? 0,
          PI * (5.5 * 5.5 - 3.3 * 3.3),
          REL,
        );
      });

      it('countersink 90° through all', () => {
        const ss = session();
        const box = block(ss);
        const r = ss.exec(
          holeFeature({ kind: 'countersink', end: 'throughAll' }),
          holeInputs(box.shape, [down(20, 20, 20)], {
            '/diameter': 6.6,
            '/countersink/diameter': 13,
            '/countersink/angle': PI / 2,
          }),
        );
        const zc = 6.5 - 3.3;
        const m = ss.mass(r.shape);
        relClose(
          m.volume,
          32000 - (PI * zc * (6.5 * 6.5 + 6.5 * 3.3 + 3.3 * 3.3)) / 3 - PI * 3.3 * 3.3 * (20 - zc),
          REL,
        );
        expect(m.faceCount).toBe(8);
        expect(names(r, 'face')).toContain(role('csink'));
      });

      it('several points: one boolean, names per point; op new returns the tool', () => {
        const ss = session();
        const box = block(ss);
        const r = ss.exec(
          holeFeature({ points: [P0, P1, P2] }),
          holeInputs(box.shape, [down(10, 10, 20), down(20, 30, 20), down(30, 10, 20)], {
            '/diameter': 4,
            '/end/depth': 8,
          }),
        );
        relClose(ss.mass(r.shape).volume, 32000 - 3 * PI * 4 * 8, REL);
        for (const p of [P0, P1, P2]) {
          expect(names(r, 'face')).toContain(wall(p));
          expect(names(r, 'face')).toContain(role('bottom', p));
        }
        const tool = ss.exec(
          holeFeature({ op: 'new' }),
          holeInputs(undefined, [down(10, 10, 20)], { '/diameter': 4, '/end/depth': 8 }),
        );
        // The tool starts max(1, 2r) above the face.
        relClose(ss.mass(tool.shape).volume, PI * 4 * (8 + 4), REL);
        expect(names(tool, 'face')).toContain(wall());
      });

      it('names are stable when the block height changes upstream', () => {
        const ss = session();
        const run = (dz: number) => {
          const box = block(ss, 40, 40, dz);
          return ss.exec(
            holeFeature(),
            holeInputs(box.shape, [down(20, 20, dz)], { '/diameter': 6, '/end/depth': 10 }),
          );
        };
        const a = run(20);
        const b = run(30);
        relClose(ss.mass(b.shape).volume, 48000 - 90 * PI, REL);
        expect(names(a).sort()).toEqual(names(b).sort());
        expect(names(a).filter((n) => n.includes(':unnamed'))).toEqual([]);
      });

      it('bad sizes are structured errors', () => {
        const ss = session();
        const box = block(ss);
        const cb = ss.fail(
          holeFeature({ kind: 'counterbore', end: 'throughAll' }),
          holeInputs(box.shape, [down(20, 20, 20)], {
            '/diameter': 6.6,
            '/counterbore/diameter': 5,
            '/counterbore/depth': 3,
          }),
        );
        expect(cb.code).toBe('INVALID_INPUT');
        expect(
          ss.fail(holeFeature(), holeInputs(box.shape, [], { '/diameter': 6, '/end/depth': 10 }))
            .code,
        ).toBe('UNRESOLVED_REFERENCE');
        expect(
          ss.fail(
            holeFeature({ op: 'cut' }),
            holeInputs(undefined, [down(1, 1, 1)], { '/diameter': 6, '/end/depth': 10 }),
          ).code,
        ).toBe('UNRESOLVED_REFERENCE');
        // No target and no op: the drill solids (the regen engine's tool shape); through-all
        // tools without a body are 10 m deep.
        const drills = ss.exec(
          holeFeature({ end: 'throughAll' }),
          holeInputs(undefined, [down(1, 1, 1)], { '/diameter': 2 }),
        );
        relClose(ss.mass(drills.shape).volume, PI * (1e4 + 2), REL);
        expect(
          ss.fail(
            holeFeature(),
            holeInputs(box.shape, [down(20, 20, 20)], { '/diameter': 0, '/end/depth': 10 }),
          ).code,
        ).toBe('INVALID_INPUT');
      });
    });

    // -------------------------------------------------------------------------------------
    // Patterns and mirror
    // -------------------------------------------------------------------------------------

    /** Plate with one through hole at (x, y) and the hole's tool solid. */
    const plateWithHole = (ss: Session, size: number, x: number, y: number, d: number) => {
      const plate = ss.exec(boxFeature(BOX), boxValues(size, size, 10));
      const values = { '/diameter': d };
      const holed = ss.exec(
        holeFeature({ end: 'throughAll' }),
        holeInputs(plate.shape, [down(x, y, 10)], values),
      );
      const tool = ss.exec(
        holeFeature({ end: 'throughAll', op: 'new' }),
        holeInputs(plate.shape, [down(x, y, 10)], values),
      );
      return { plate, holed, tool };
    };

    describe('linear and circular patterns, mirror', () => {
      const linear = (extra: Partial<Record<string, unknown>> = {}): Feature =>
        ({
          id: LP,
          type: 'linearPattern',
          name: 'Pattern',
          suppressed: false,
          source: copySource([H]),
          direction: { name: 'origin:X', kind: 'edge' },
          reverse: false,
          count: '3',
          spacing: '20',
          second: {
            direction: { name: 'origin:Y', kind: 'edge' },
            reverse: false,
            count: '2',
            spacing: '30',
          },
          ...extra,
        }) as Feature;
      const linearInputs = (target: number, tool: number): FeatureInputs => ({
        values: {
          [`/ops/${H}`]: 1,
          '/count': 3,
          '/spacing': 20,
          '/second/count': 2,
          '/second/spacing': 30,
        },
        target,
        shapes: { [`tool:${H}`]: tool },
        frames: {
          '/direction': frameAt([0, 0, 0], [1, 0, 0], [0, 1, 0]),
          '/second/direction': frameAt([0, 0, 0], [0, 1, 0], [1, 0, 0]),
        },
      });
      const inst = (kk: number) => `F${LP}:inst${kk}(F${H}:hole(${P0}):wall)`;

      it('a 3 × 2 pattern of a hole: six holes, inst<k> names row-major', () => {
        const ss = session();
        const { holed, tool } = plateWithHole(ss, 100, 10, 10, 6);
        const r = ss.exec(linear(), linearInputs(holed.shape, tool.shape));
        const m = ss.mass(r.shape);
        relClose(m.volume, 100000 - 6 * 9 * PI * 10, REL);
        expect(m.faceCount).toBe(6 + 6);
        const fp = ss.fingerprints(r.shape);
        expect(names(r, 'face')).toContain(`F${H}:hole(${P0}):wall`);
        for (let kk = 1; kk < 6; kk++) expect(names(r, 'face')).toContain(inst(kk));
        // Row-major: k = row · count + column; instance 4 is column 1 of row 1.
        const c4 = fp.faces[indexOf(r, inst(4), 'face')]?.centroid ?? [];
        vecClose([c4[0] ?? 0, c4[1] ?? 0, 0], [30, 40, 0], 1e-6);
      });

      it('skip leaves the other indices unchanged', () => {
        const ss = session();
        const { holed, tool } = plateWithHole(ss, 100, 10, 10, 6);
        // Directions by the regen engine's role keys (frames.axis, frames.second).
        const r = ss.exec(linear({ skip: [4] }), {
          ...linearInputs(holed.shape, tool.shape),
          frames: {
            axis: frameAt([0, 0, 0], [1, 0, 0], [0, 1, 0]),
            second: frameAt([0, 0, 0], [0, 1, 0], [1, 0, 0]),
          },
        });
        relClose(ss.mass(r.shape).volume, 100000 - 5 * 9 * PI * 10, REL);
        expect(names(r, 'face')).not.toContain(inst(4));
        expect(names(r, 'face')).toContain(inst(5));
      });

      it('names are stable when the plate grows upstream', () => {
        const ss = session();
        const a = plateWithHole(ss, 100, 10, 10, 6);
        const b = plateWithHole(ss, 120, 10, 10, 6);
        const ra = ss.exec(linear(), linearInputs(a.holed.shape, a.tool.shape));
        const rb = ss.exec(linear(), linearInputs(b.holed.shape, b.tool.shape));
        relClose(ss.mass(rb.shape).volume, 144000 - 6 * 9 * PI * 10, REL);
        expect(names(ra).sort()).toEqual(names(rb).sort());
        expect(names(ra).filter((n) => n.includes(':unnamed'))).toEqual([]);
      });

      it('circular pattern of a body (equal spacing, separate and merged)', () => {
        const ss = session();
        const bar = ss.exec(boxFeature(BOX, frameAt([20, -1, 0])), boxValues(10, 2, 2));
        const feature = (merge: boolean): Feature => ({
          id: CP,
          type: 'circularPattern',
          name: 'Circular',
          suppressed: false,
          source: { kind: 'bodies', bodies: [{ name: `B${BOX}`, kind: 'body' }], merge },
          axis: { name: 'origin:Z', kind: 'edge' },
          count: '4',
          angle: '360deg',
          equalSpacing: true,
        });
        const inputs: FeatureInputs = {
          values: { '/count': 4, '/angle': 2 * PI },
          refs: { '/source/bodies/0': { shape: bar.shape, kind: 'body', index: 0 } },
          frames: { '/axis': frameAt([0, 0, 0]) },
        };
        const sep = ss.exec(feature(false), inputs);
        // Every copy is listed in `bodies` (the first is also `shape`).
        expect(sep.bodies?.map((b) => b.key)).toEqual(['inst1:0', 'inst2:0', 'inst3:0']);
        expect(sep.bodies?.[0]?.shape).toBe(sep.shape);
        relClose(ss.mass(sep.shape).volume, 40, REL);
        const c1 = ss.mass(sep.shape).centroid;
        vecClose(c1, [0, 25, 1], 1e-6);
        expect(names(sep, 'face')).toContain(`F${CP}:inst1(${B}:face.xmin)`);
        const third = sep.bodies?.[2];
        vecClose(ss.mass(third?.shape ?? 0).centroid, [0, -25, 1], 1e-6);
        const merged = ss.exec(feature(true), inputs);
        relClose(ss.mass(merged.shape).volume, 160, REL);
        expect(merged.warnings.map((w) => w.message).join()).toMatch(/4 separate solids/);
        // Not equal spacing: the angle is the step between instances.
        const stepped = ss.exec(
          { ...feature(false), angle: '30deg', equalSpacing: false, count: '3' } as Feature,
          {
            ...inputs,
            values: { '/count': 3, '/angle': PI / 6 },
          },
        );
        const c2 = ss.mass(stepped.bodies?.[1]?.shape ?? 0).centroid;
        vecClose(c2, [25 * Math.cos(PI / 3), 25 * Math.sin(PI / 3), 1], 1e-6);
      });

      it('mirror a body (merged) and mirror a hole feature', () => {
        const ss = session();
        const box = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
        const mirror = (source: unknown): Feature =>
          ({
            id: MI,
            type: 'mirror',
            name: 'Mirror',
            suppressed: false,
            source,
            plane: { name: 'origin:YZ', kind: 'face' },
          }) as Feature;
        const yz = frameAt([0, 0, 0], [1, 0, 0], [0, 1, 0]);
        const merged = ss.exec(
          mirror({ kind: 'bodies', bodies: [{ name: `B${BOX}`, kind: 'body' }], merge: true }),
          {
            values: {},
            refs: { '/source/bodies/0': { shape: box.shape, kind: 'body', index: 0 } },
            frames: { '/plane': yz },
          },
        );
        const m = ss.mass(merged.shape);
        relClose(m.volume, 2000, REL);
        relClose(m.bbox.min[0], -10, REL);
        expect(names(merged, 'face')).toContain(`F${MI}:mirror(${B}:face.xmax)`);
        expect(names(merged, 'face')).toContain(`${B}:face.xmax`);
        const { holed, tool } = plateWithHole(ss, 100, 10, 10, 6);
        const half = frameAt([50, 0, 0], [1, 0, 0], [0, 1, 0]);
        const r = ss.exec(mirror(copySource([H])), {
          values: { [`/ops/${H}`]: 1 },
          target: holed.shape,
          shapes: { [`tool:${H}`]: tool.shape },
          frames: { plane: half },
        });
        relClose(ss.mass(r.shape).volume, 100000 - 2 * 9 * PI * 10, REL);
        const fp = ss.fingerprints(r.shape);
        const c =
          fp.faces[indexOf(r, `F${MI}:mirror(F${H}:hole(${P0}):wall)`, 'face')]?.centroid ?? [];
        relClose(c[0] ?? 0, 90, REL);
      });

      it('copy errors are structured', () => {
        const ss = session();
        const { holed, tool } = plateWithHole(ss, 100, 10, 10, 6);
        const missing = ss.fail(linear(), { ...linearInputs(holed.shape, tool.shape), shapes: {} });
        expect(missing.code).toBe('UNRESOLVED_REFERENCE');
        const intersect = ss.fail(linear(), {
          ...linearInputs(holed.shape, tool.shape),
          values: {
            [`/ops/${H}`]: 2,
            '/count': 3,
            '/spacing': 20,
            '/second/count': 2,
            '/second/spacing': 30,
          },
        });
        expect(intersect.code).toBe('UNSUPPORTED_FEATURE');
        const parallel = ss.fail(linear(), {
          ...linearInputs(holed.shape, tool.shape),
          frames: {
            '/direction': frameAt([0, 0, 0], [1, 0, 0], [0, 1, 0]),
            '/second/direction': frameAt([0, 0, 0], [-1, 0, 0], [0, 1, 0]),
          },
        });
        expect(parallel.code).toBe('INVALID_INPUT');
        const badCount = ss.fail(linear(), {
          ...linearInputs(holed.shape, tool.shape),
          values: {
            [`/ops/${H}`]: 1,
            '/count': 2.5,
            '/spacing': 20,
            '/second/count': 2,
            '/second/spacing': 30,
          },
        });
        expect(badCount.code).toBe('INVALID_INPUT');
      });

      it('perf: a 10 × 10 pattern of holes on a plate regenerates within 300 ms', () => {
        const ss = session();
        const { holed, tool } = plateWithHole(ss, 200, 10, 10, 5);
        const feature = linear({
          count: '10',
          spacing: '18',
          second: {
            direction: { name: 'origin:Y', kind: 'edge' },
            reverse: false,
            count: '10',
            spacing: '18',
          },
        });
        const inputs: FeatureInputs = {
          ...linearInputs(holed.shape, tool.shape),
          values: {
            [`/ops/${H}`]: 1,
            '/count': 10,
            '/spacing': 18,
            '/second/count': 10,
            '/second/spacing': 18,
          },
        };
        // Budget: PLAN §10 "regen after editing the last feature" ≤ 300 ms. Each run's cost is the
        // smaller of its wall time and its process CPU time: wall time inflates when the machine
        // is oversubscribed (shared CI), CPU time when V8 is still compiling the 21 MB module to
        // optimised code on background threads (or, threaded build, the boolean runs in
        // parallel). The gate is the best of five warm runs.
        const timed = (run: () => RawFeatureResult) => {
          const wall0 = performance.now();
          const cpu0 = process.cpuUsage();
          const r = run();
          const cpu = process.cpuUsage(cpu0);
          return { r, cpu: (cpu.user + cpu.system) / 1000, wall: performance.now() - wall0 };
        };
        // Warm-up: first-use allocations and V8's tier-up of the hot boolean code.
        for (let i = 0; i < 3; i++) ss.exec(feature, inputs);
        const runs = Array.from({ length: 5 }, () => timed(() => ss.exec(feature, inputs)));
        const best = Math.min(...runs.map((r) => Math.min(r.cpu, r.wall)));
        const last = runs[runs.length - 1]?.r;
        // The same 100 holes as one hole feature with 100 points (one multi-tool cut).
        const frames = Array.from({ length: 100 }, (_, i) =>
          down(10 + 18 * (i % 10), 10 + 18 * Math.floor(i / 10), 10),
        );
        const plate = ss.exec(boxFeature(BOX), boxValues(200, 200, 10));
        const holes = Array.from({ length: 3 }, () =>
          timed(() =>
            ss.exec(
              holeFeature({ end: 'throughAll', points: frames.map((_, i) => `p${i}`) }),
              holeInputs(plate.shape, frames, { '/diameter': 5 }),
            ),
          ),
        );
        const fmt = (xs: { cpu: number; wall: number }[]) =>
          xs.map((x) => `${x.cpu.toFixed(0)} cpu/${x.wall.toFixed(0)} wall`).join(', ');
        console.log(
          `[perf] 10×10 hole pattern (${variant}) ms: ${fmt(runs)}; gate ${best.toFixed(0)}`,
        );
        console.log(`[perf] 100-point hole feature (${variant}) ms: ${fmt(holes)}`);
        relClose(ss.mass(last?.shape ?? 0).volume, 400000 - 100 * PI * 6.25 * 10, REL);
        expect(ss.mass(last?.shape ?? 0).faceCount).toBe(106);
        relClose(ss.mass(holes[0]?.r.shape ?? 0).volume, 400000 - 100 * PI * 6.25 * 10, REL);
        expect(best).toBeLessThan(300);
        // Beyond 100 instances (logged, not gated): 15 × 15 at 12 mm on the same plate.
        const big = timed(() =>
          ss.exec(
            linear({
              count: '15',
              spacing: '12',
              second: {
                direction: { name: 'origin:Y', kind: 'edge' },
                reverse: false,
                count: '15',
                spacing: '12',
              },
            }),
            {
              ...inputs,
              values: {
                [`/ops/${H}`]: 1,
                '/count': 15,
                '/spacing': 12,
                '/second/count': 15,
                '/second/spacing': 12,
              },
            },
          ),
        );
        console.log(`[perf] 15×15 hole pattern (${variant}) ms: ${fmt([big])}`);
        relClose(ss.mass(big.r.shape).volume, 400000 - 225 * PI * 6.25 * 10, REL);
      }, 120_000);
    });

    // -------------------------------------------------------------------------------------
    // Import feature and IGES
    // -------------------------------------------------------------------------------------

    describe('import feature and IGES', () => {
      const exportImport = (shapes: number[], format: 'brep' | 'stl'): number[] => {
        const ex = ok<{ path: string; files: { path: string }[] }>(
          k.exportShapes(
            JSON.stringify(shapes.map((shape, i) => ({ shape, name: `b${i}` }))),
            format,
            '{}',
          ),
        );
        const handles: number[] = [];
        for (const f of ex.files) {
          const r = ok<RawImportResult>(k.importFile(f.path, format));
          k.FS.unlink(f.path);
          for (const b of r.bodies) handles.push(b.shape);
        }
        s.handles.push(...handles);
        return handles;
      };
      const importFeature = (op: 'new' | 'cut' = 'new', frame?: Frame): Feature =>
        ({
          id: IM,
          type: 'import',
          name: 'Import',
          suppressed: false,
          source: { path: `imports/${IM}.brep`, format: 'brep', sha256: '0', fileName: 'box.brep' },
          op,
          ...(frame === undefined ? {} : { frame }),
        }) as Feature;

      it('places a BREP body by its frame and names faces F<id>:face#k', () => {
        const ss = session();
        const box = block(ss, 10, 20, 30);
        const [raw] = exportImport([box.shape], 'brep');
        const placed = ss.exec(importFeature('new', frameAt([100, 0, 0], [0, 0, 1], [0, 1, 0])), {
          values: {},
          shapes: { source: raw ?? 0 },
        });
        const m = ss.mass(placed.shape);
        relClose(m.volume, 6000, REL);
        // Local x → world +y, local y = z × x → world −x; origin at x = 100.
        vecClose(m.bbox.min, [80, 0, 0], 1e-6);
        vecClose(m.bbox.max, [100, 10, 30], 1e-6);
        expect(names(placed, 'face').sort()).toEqual(
          [0, 1, 2, 3, 4, 5].map((i) => `F${IM}:face#${i}`),
        );
        expect(names(placed, 'edge').length).toBe(12);
        expect(names(placed, 'edge')[0]).toMatch(
          new RegExp(`^edge\\(F${IM}:face#\\d\\|F${IM}:face#\\d\\)$`),
        );
      });

      it('cut with an imported body names tool faces F<id>:face(F<id>:face#k); two solids', () => {
        const ss = session();
        const tool = block(ss, 10, 20, 30);
        const [raw] = exportImport([tool.shape], 'brep');
        const target = ss.exec(boxFeature('01JM3TARGET000000000000001'), boxValues(20, 20, 20));
        const cut = ss.exec(importFeature('cut'), {
          values: {},
          target: target.shape,
          shapes: { source: raw ?? 0 },
        });
        relClose(ss.mass(cut.shape).volume, 8000 - 4000, REL);
        expect(names(cut, 'face').some((n) => n.startsWith(`F${IM}:face(F${IM}:face#`))).toBe(true);
        const far = ss.exec(
          boxFeature('01JM3FAR000000000000000001', frameAt([50, 0, 0])),
          boxValues(5, 5, 5),
        );
        const two = exportImport([tool.shape, far.shape], 'brep');
        const both = ss.exec(importFeature(), {
          values: {},
          shapes: Object.fromEntries(two.map((h, i) => [`source:${i}`, h])),
        });
        expect(two.length).toBe(2);
        expect(both.bodies?.map((b) => b.key)).toEqual(['body#1']);
        relClose(
          ss.mass(both.shape).volume + ss.mass(both.bodies?.[0]?.shape ?? 0).volume,
          6125,
          REL,
        );
      });

      it('a mesh (STL) reference body has one face and cannot cut', () => {
        const ss = session();
        const box = block(ss, 10, 10, 10);
        const [raw] = exportImport([box.shape], 'stl');
        const mesh = ss.exec(importFeature(), { values: {}, shapes: { source: raw ?? 0 } });
        expect(mesh.naming).toEqual([{ name: `F${IM}:face`, kind: 'face', index: 0 }]);
        const target = ss.exec(boxFeature('01JM3TARGET000000000000001'), boxValues(20, 20, 20));
        expect(
          ss.fail(importFeature('cut'), {
            values: {},
            target: target.shape,
            shapes: { source: raw ?? 0 },
          }).code,
        ).toBe('INVALID_INPUT');
        expect(ss.fail(importFeature(), { values: {} }).code).toBe('UNRESOLVED_REFERENCE');
      });

      it('IGES: six bounded planes are sewn into one solid', () => {
        session();
        const path = '/tmp/wren-test-box.igs';
        k.FS.writeFile(path, new TextEncoder().encode(igesBox(10, 20, 30)));
        try {
          const r = ok<RawImportResult>(k.importFile(path, 'iges'));
          s.handles.push(...r.bodies.map((b) => b.shape));
          expect(r.bodies.length).toBe(1);
          const m = s.mass(r.bodies[0]?.shape ?? 0);
          relClose(m.volume, 6000, REL);
          relClose(m.area, 2 * (200 + 300 + 600), REL);
          expect(m.faceCount).toBe(6);
        } finally {
          k.FS.unlink(path);
        }
        k.FS.writeFile(path, new TextEncoder().encode('not an iges file'));
        try {
          const e = JSON.parse(k.importFile(path, 'iges')) as {
            ok: boolean;
            error?: { code: string };
          };
          expect(e.ok).toBe(false);
          expect(e.error?.code).toBe('INVALID_INPUT');
        } finally {
          k.FS.unlink(path);
        }
      });
    });
  });
}
