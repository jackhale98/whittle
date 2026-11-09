/**
 * Regen golden (M3) with the real kernel, "edit upstream, check downstream" (PLAN §7.3 item 5):
 * a pattern of holes, a mirrored boss and a shell after a fillet, plus sweep and loft volumes.
 *
 * These need the kernel engineer's M3 façade (shell, hole, patterns, mirror, sweep, loft, draft).
 * Until that build is in packages/kernel/dist the suite is skipped by a feature check
 * (`m3Kernel()`): it probes the loaded kernel for each feature type.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BodyResult,
  ChamferFeature,
  EntityRef,
  Feature,
  FilletFeature,
  HoleFeature,
  LinearPatternFeature,
  LoftFeature,
  MirrorFeature,
  PlaneFeature,
  ShellFeature,
  SweepFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { RegenOutput } from '../../src/regen/engine';
import {
  type Api,
  describeFailures,
  edgeName,
  extrude,
  faceCentroid,
  fid,
  m3Kernel,
  makeDoc as makeDocFor,
  region,
  relClose,
  Sk,
  side,
  states,
  totalVolume,
  withParams,
} from './helpers';

const m3 = await m3Kernel();
const note = m3 ? '' : ' — SKIPPED: the kernel has no M3 features yet (feature check)';

const PART = fid('MPART');
const S1 = fid('MS1');
const E1 = fid('ME1');
const S2 = fid('MS2');
const H = fid('MH');
const P = fid('MP');
const C = fid('MC');
const top = `F${E1}:end`;

const face = (name: string): EntityRef => ({ name, kind: 'face' });
const edge = (name: string): EntityRef => ({ name, kind: 'edge' });
const makeDoc = (params: Record<string, string>, features: Feature[]) =>
  makeDocFor(params, features, PART);

/** A w × 50 × h plate from the origin. */
function plate(h = '10'): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 80, 50, 'w', '50 mm');
  s.geo({ kind: 'fix', entity: r.a });
  return [s.feature(S1), extrude(E1, [region(S1, 'L1,L2,L3,L4')], h)];
}

function only(r: RegenOutput): BodyResult {
  expect(r.bodies, describeFailures(r)).toHaveLength(1);
  return r.bodies[0] as BodyResult;
}

describe.skipIf(!m3)(`regen golden (M3): edit upstream${note}`, () => {
  const api = m3 as Api;
  const regen = (doc: WrenDoc) =>
    api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });

  describe('a pattern of holes', () => {
    const wall = (k: number) => {
      const w = `F${H}:hole(S${S2}:p(p)):wall`;
      return k === 0 ? w : `F${P}:inst${k}(${w})`;
    };
    function features(extra: Partial<LinearPatternFeature> = {}): Feature[] {
      const s = new Sk();
      s.point('p', 15, 25);
      s.dim({ kind: 'hDistance', a: '@origin', b: 'p' }, '15 mm');
      s.dim({ kind: 'vDistance', a: '@origin', b: 'p' }, '25 mm');
      const hole: HoleFeature = {
        id: H,
        type: 'hole',
        name: 'Hole',
        suppressed: false,
        points: [{ name: `S${S2}:p(p)`, kind: 'vertex' }],
        face: face(top),
        standard: 'ISO',
        kind: 'simple',
        size: 'M6',
        fit: 'normal',
        end: { kind: 'throughAll' },
      };
      const pattern: LinearPatternFeature = {
        id: P,
        type: 'linearPattern',
        name: 'Holes',
        suppressed: false,
        source: { kind: 'features', features: [H] },
        direction: edge('origin:X'),
        reverse: false,
        count: 'n',
        spacing: 's',
        ...extra,
      };
      return [...plate(), s.feature(S2, face(top), 'Hole points'), hole, pattern];
    }
    const holeVolume = (n: number) => n * Math.PI * 3.3 ** 2 * 10;

    it('volumes and instance names through width, count and spacing edits', async () => {
      const doc = makeDoc({ w: '80 mm', n: '3', s: '20 mm' }, features());
      const r = await regen(doc);
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      relClose(totalVolume(r.bodies), 80 * 50 * 10 - holeVolume(3), 1e-6);
      const names = only(r).mesh.faceNames;
      for (const k of [0, 1, 2]) expect(names.some((n) => n.startsWith(wall(k)))).toBe(true);

      // A chamfer on instance 2's rim, picked by name from the model.
      const rim = only(r).mesh.edgeNames.find((n) => n.includes(wall(2)) && n.includes(top));
      expect(rim).toBeDefined();
      const chamfer: ChamferFeature = {
        id: C,
        type: 'chamfer',
        name: 'Chamfer',
        suppressed: false,
        edges: [edge(rim as string)],
        mode: { kind: 'distance', distance: '1 mm' },
      };
      const withChamfer = makeDoc({ w: '80 mm', n: '3', s: '20 mm' }, [...features(), chamfer]);
      const c0 = await regen(withChamfer);
      expect(states(c0), describeFailures(c0)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      const at0 = await faceCentroid(api, only(c0), wall(2));

      const edits: Record<string, string>[] = [{ w: '120 mm' }, { n: '4' }, { s: '25 mm' }];
      for (const edit of edits) {
        const e = await regen(withParams(withChamfer, edit));
        expect(states(e), `${JSON.stringify(edit)} ${describeFailures(e)}`).toEqual([
          'ok',
          'ok',
          'ok',
          'ok',
          'ok',
          'ok',
        ]);
        expect(e.features[5]?.rebound).toBeUndefined();
      }
      const spaced = await regen(withParams(withChamfer, { s: '25 mm' }));
      const at1 = await faceCentroid(api, only(spaced), wall(2));
      expect((at1?.[0] ?? 0) - (at0?.[0] ?? 0)).toBeCloseTo(10, 6);

      // Skipping instance 1 keeps instance 2's name; dropping to two instances loses it.
      const skipped = makeDoc({ w: '80 mm', n: '3', s: '20 mm' }, [
        ...features({ skip: [1] }),
        chamfer,
      ]);
      const sk = await regen(skipped);
      expect(states(sk), describeFailures(sk)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      relClose(totalVolume(sk.bodies), totalVolume(c0.bodies) + holeVolume(1), 1e-6);
      const two = await regen(withParams(withChamfer, { n: '2', s: '40 mm' }));
      expect(states(two)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'needsAttention']);
      expect(two.features[5]?.unresolved?.[0]?.reason).toBe('missing');
    }, 120_000);
  });

  it('a mirrored boss follows its mirror plane; a fillet on the copy keeps its edge', async () => {
    const S3 = fid('MS3');
    const E3 = fid('ME3');
    const PL = fid('MPL');
    const M = fid('MM');
    const s = new Sk();
    s.circle('c', 20, 25, 5);
    s.dim({ kind: 'hDistance', a: '@origin', b: 'cc' }, '20 mm');
    s.dim({ kind: 'vDistance', a: '@origin', b: 'cc' }, '25 mm');
    s.dim({ kind: 'radius', curve: 'c' }, '5 mm');
    const plane: PlaneFeature = {
      id: PL,
      type: 'plane',
      name: 'Middle',
      suppressed: false,
      definition: { kind: 'offset', from: face('origin:YZ'), distance: 'w / 2' },
    };
    const mirror: MirrorFeature = {
      id: M,
      type: 'mirror',
      name: 'Mirror',
      suppressed: false,
      source: { kind: 'features', features: [E3] },
      plane: face(`F${PL}:plane`),
    };
    const base = [
      ...plate(),
      s.feature(S3, face(top), 'Boss'),
      extrude(E3, [region(S3, 'c')], '8', 'add'),
      plane,
      mirror,
    ];
    const doc = makeDoc({ w: '80 mm' }, base);
    const r = await regen(doc);
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const boss = Math.PI * 25 * 8;
    relClose(totalVolume(r.bodies), 80 * 50 * 10 + 2 * boss, 1e-6);
    const copyTop = `F${M}:mirror(F${E3}:end)`;
    expect((await faceCentroid(api, only(r), copyTop))?.[0]).toBeCloseTo(60, 6);
    const rim = only(r).mesh.edgeNames.find((n) => n.includes(copyTop));
    expect(rim).toBeDefined();
    const fillet: FilletFeature = {
      id: fid('MFI'),
      type: 'fillet',
      name: 'Fillet',
      suppressed: false,
      edges: [edge(rim as string)],
      radius: '1 mm',
    };
    const withFillet = makeDoc({ w: '80 mm' }, [...base, fillet]);
    const f0 = await regen(withFillet);
    expect(states(f0), describeFailures(f0)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const wide = await regen(withParams(withFillet, { w: '100 mm' }));
    expect(states(wide), describeFailures(wide)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(wide.features[6]?.rebound).toBeUndefined();
    relClose(totalVolume(wide.bodies) - totalVolume(f0.bodies), (100 - 80) * 50 * 10, 1e-6);
  }, 120_000);

  it('through-all cuts are patterned (with a skip) and mirrored, through upstream edits', async () => {
    // Regression (rp10-comb-plate): the tool of a through-all extrude was built as the feature
    // alone with op `new`, which the kernel refuses ("Through all needs a body to go through"),
    // so every pattern or mirror of a through-all cut failed.
    const S5 = fid('MTS5');
    const E5 = fid('MTE5');
    const LP = fid('MTLP');
    const S6 = fid('MTS6');
    const E6 = fid('MTE6');
    const PL = fid('MTPL');
    const M = fid('MTM');
    // A 4 × 30 slot on Top (the plate's bottom face), cut through all both ways.
    const slot = new Sk();
    const q = slot.rect('q', 'Q', 8, 10, 12, 40, '4 mm', '30 mm');
    slot.dim({ kind: 'hDistance', a: '@origin', b: q.a }, '8 mm');
    slot.dim({ kind: 'vDistance', a: '@origin', b: q.a }, '10 mm');
    // A Ø6 hole sketched on the plate's top face, cut through all one way (down).
    const hole = new Sk();
    hole.circle('c', 20, 25, 3);
    hole.dim({ kind: 'hDistance', a: '@origin', b: 'cc' }, '20 mm');
    hole.dim({ kind: 'vDistance', a: '@origin', b: 'cc' }, '25 mm');
    hole.dim({ kind: 'radius', curve: 'c' }, '3 mm');
    const pattern: LinearPatternFeature = {
      id: LP,
      type: 'linearPattern',
      name: 'Slots',
      suppressed: false,
      source: { kind: 'features', features: [E5] },
      direction: edge('origin:X'),
      reverse: false,
      count: 'n',
      spacing: '10 mm',
      // Instance 1 (x = 18…22) would cut into the hole.
      skip: [1],
    };
    const plane: PlaneFeature = {
      id: PL,
      type: 'plane',
      name: 'Middle',
      suppressed: false,
      definition: { kind: 'offset', from: face('origin:YZ'), distance: 'w / 2' },
    };
    const mirror: MirrorFeature = {
      id: M,
      type: 'mirror',
      name: 'Mirror',
      suppressed: false,
      source: { kind: 'features', features: [E6] },
      plane: face(`F${PL}:plane`),
    };
    const doc = makeDoc({ w: '80 mm', h: '10 mm', n: '4' }, [
      ...plate('h'),
      slot.feature(S5, 'origin:XY', 'Slot'),
      extrude(E5, [region(S5, 'Q1,Q2,Q3,Q4')], 'throughAll', 'cut', 'symmetric'),
      pattern,
      hole.feature(S6, face(top), 'Hole'),
      extrude(E6, [region(S6, 'c')], 'throughAll', 'cut', 'reverse'),
      plane,
      mirror,
    ]);
    const expected = (w: number, h: number, n: number) =>
      w * 50 * h - (n - 1) * 4 * 30 * h - 2 * Math.PI * 9 * h;
    const cases: [Record<string, string>, number, number, number][] = [
      [{}, 80, 10, 4],
      // Thicker than the first tools reach: the copies' tools grow with the body.
      [{ h: '300 mm' }, 80, 300, 4],
      [{ n: '5' }, 80, 10, 5],
      [{ w: '120 mm' }, 120, 10, 4],
    ];
    for (const [edit, w, h, n] of cases) {
      const r = await regen(withParams(doc, edit));
      expect(states(r), `${JSON.stringify(edit)} ${describeFailures(r)}`).toEqual(
        Array(9).fill('ok'),
      );
      const m = only(r).massProperties;
      relClose(m?.volume ?? Number.NaN, expected(w, h, n), 1e-6);
      expect(m?.bbox.min[2]).toBeCloseTo(0, 6);
      expect(m?.bbox.max[2]).toBeCloseTo(h, 6);
      // The mirrored hole's wall sits at x = w − 20 ± 3, through the full thickness.
      const wall = only(r).mesh.faceNames.find((x) => x.startsWith(`F${M}:mirror(`));
      expect(wall, only(r).mesh.faceNames.join(' ')).toBeDefined();
      const c = await faceCentroid(api, only(r), wall as string);
      expect(c?.[0]).toBeCloseTo(w - 20, 6);
      expect(c?.[2]).toBeCloseTo(h / 2, 6);
    }
  }, 120_000);

  it('a shell after a fillet: analytic volume, inner floor stays referable through edits', async () => {
    const FI = fid('MSF');
    const SH = fid('MSH');
    const S4 = fid('MS4');
    const E4 = fid('ME4');
    const corners = [
      ['L1', 'L2'],
      ['L2', 'L3'],
      ['L3', 'L4'],
      ['L4', 'L1'],
    ].map(([a, b]) => edge(edgeName(side(E1, S1, a as string), side(E1, S1, b as string))));
    const fillet: FilletFeature = {
      id: FI,
      type: 'fillet',
      name: 'Corners',
      suppressed: false,
      edges: corners,
      radius: 'r',
    };
    const shell: ShellFeature = {
      id: SH,
      type: 'shell',
      name: 'Shell',
      suppressed: false,
      openFaces: [face(top)],
      thickness: '2 mm',
      direction: 'inward',
    };
    const s = new Sk();
    const q = s.rect('q', 'Q', 30, 20, 40, 30, '10 mm', '10 mm');
    s.dim({ kind: 'hDistance', a: '@origin', b: q.a }, '30 mm');
    s.dim({ kind: 'vDistance', a: '@origin', b: q.a }, '20 mm');
    const floor = `F${SH}:shell(F${E1}:start)`;
    const doc = makeDoc({ w: '80 mm', r: '4 mm' }, [
      ...plate('30'),
      fillet,
      shell,
      s.feature(S4, face(floor), 'On the floor'),
      extrude(E4, [region(S4, 'Q1,Q2,Q3,Q4')], '3', 'add'),
    ]);
    const volume = (w: number, r: number) => {
      const d = 50;
      const h = 30;
      const t = 2;
      const outer = w * d - (4 - Math.PI) * r * r;
      const inner = (w - 2 * t) * (d - 2 * t) - (4 - Math.PI) * (r - t) ** 2;
      return outer * h - inner * (h - t) + 10 * 10 * 3;
    };
    for (const p of [
      { w: '80 mm', r: '4 mm' },
      { w: '90 mm', r: '4 mm' },
      { w: '90 mm', r: '6 mm' },
    ]) {
      const e = await regen(withParams(doc, p));
      expect(states(e), `${JSON.stringify(p)} ${describeFailures(e)}`).toEqual([
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
      ]);
      expect(e.features[4]?.rebound).toBeUndefined();
      relClose(totalVolume(e.bodies), volume(Number.parseFloat(p.w), Number.parseFloat(p.r)), 1e-6);
    }
  }, 120_000);

  it('sweep and loft volumes', async () => {
    const prof = new Sk();
    prof.circle('c', 0, 0, 2);
    const path = new Sk();
    path.point('a', 0, 0);
    path.point('b', 0, 50);
    path.line('l', 'a', 'b');
    const sweep: SweepFeature = {
      id: fid('MSW'),
      type: 'sweep',
      name: 'Sweep',
      suppressed: false,
      profile: [region(fid('MSP'), 'c')],
      path: [edge(`S${fid('MSQ')}:e(l)`)],
      orientation: 'followPath',
      op: 'new',
    };
    const r = await regen(
      makeDoc({}, [prof.feature(fid('MSP')), path.feature(fid('MSQ'), 'origin:XZ'), sweep]),
    );
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok']);
    relClose(totalVolume(r.bodies), Math.PI * 4 * 50, 1e-6);

    const a = new Sk();
    a.rect('a', 'A', -10, -10, 10, 10);
    const b = new Sk();
    b.rect('b', 'B', -5, -5, 5, 5);
    const up: PlaneFeature = {
      id: fid('MUP'),
      type: 'plane',
      name: 'Up',
      suppressed: false,
      definition: { kind: 'offset', from: face('origin:XY'), distance: '30 mm' },
    };
    const loft: LoftFeature = {
      id: fid('MLO'),
      type: 'loft',
      name: 'Loft',
      suppressed: false,
      sections: [region(fid('MLA'), 'A1,A2,A3,A4'), region(fid('MLB'), 'B1,B2,B3,B4')],
      ruled: true,
      closed: false,
      op: 'new',
    };
    const l = await regen(
      makeDoc({}, [
        a.feature(fid('MLA')),
        up,
        b.feature(fid('MLB'), face(`F${up.id}:plane`)),
        loft,
      ]),
    );
    expect(states(l), describeFailures(l)).toEqual(['ok', 'ok', 'ok', 'ok']);
    relClose(totalVolume(l.bodies), (30 / 3) * (400 + 100 + 200), 1e-6);
  }, 120_000);
});
