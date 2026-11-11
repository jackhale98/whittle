/**
 * Regen golden (ADR-078): booleans merge the coplanar faces they leave side by side. On the M1
 * bracket the plate's and the upright's back faces (and both side faces) become one face each;
 * references to the absorbed upright faces resolve to the merged face through the kernel's merge
 * aliases, reported as `merged` (never healed, never guessed), and come back to their own faces
 * when an edit un-merges them. Shell then works on the bracket; its volumes are analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BodyResult,
  EntityRef,
  Feature,
  ShellFeature,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { RegenOutput } from '../../src/regen/engine';
import type { RegenFeatureStatus } from '../../src/regen/types';
import { B, BRACKET_DIMS, type BracketDims, bracketDoc, bracketVolume } from './bracket';
import {
  type Api,
  describeFailures,
  edgeName,
  extrude,
  fid,
  fillet,
  m3Kernel,
  makeDoc,
  region,
  relClose,
  Sk,
  side,
  states,
  totalVolume,
  withParams,
} from './helpers';

const m3 = await m3Kernel();
const note = m3 ? '' : ' — SKIPPED: no kernel with the M3 features (feature check)';

const PART = fid('PART');
const SH = fid('USH');
const face = (name: string): EntityRef => ({ name, kind: 'face' });

const plateBack = side(B.E1, B.S1, 'L3');
const uprightBack = side(B.E3, B.S3, 'M3');
const plateLeft = side(B.E1, B.S1, 'L4');
const uprightLeft = side(B.E3, B.S3, 'M4');
const plateRight = side(B.E1, B.S1, 'L2');
const uprightRight = side(B.E3, B.S3, 'M2');
const uprightTop = `F${B.E3}:end`;

const K = 1 - Math.PI / 4;

/**
 * Analytic volume of the void a shell of wall `t` leaves in the bracket (sharp joins): the body
 * eroded by `t`, except at the open face. The L profile (y–z) is eroded and extruded over
 * x ∈ [t, W − t]; the concave bend fillet grows to r + t, the chamfer line moves in by t, the
 * plate's front corner fillets shrink to r − t and the holes grow to r + t.
 */
function voidVolume(d: BracketDims, t: number, open: 'none' | 'top' | 'back'): number {
  const { width: W, depth: D, thickness: T, height: H } = d;
  const c = d.chamfer_d;
  const s2 = Math.SQRT2;
  let profile: number;
  if (open === 'top') {
    profile = (D - 2 * t) * (T - 2 * t) + (T - 2 * t) * (H + t) - 0.5 * (c - t + t * s2) ** 2;
  } else if (open === 'back') {
    profile = (D - t) * (T - 2 * t) + (T - t) * H - 0.5 * (c - 2 * t + t * s2) ** 2;
  } else {
    profile = (D - 2 * t) * (T - 2 * t) + (T - 2 * t) * H - 0.5 * (c - 2 * t + t * s2) ** 2;
  }
  profile += K * (d.bend_r + t) ** 2;
  return (
    (W - 2 * t) * profile -
    2 * K * (d.corner_r - t) ** 2 * (T - 2 * t) -
    2 * Math.PI * (d.hole_d / 2 + t) ** 2 * (T - 2 * t)
  );
}

function shell(
  openFaces: EntityRef[],
  thickness: string,
  extra: Partial<ShellFeature> = {},
): ShellFeature {
  return {
    id: SH,
    type: 'shell',
    name: 'Shell',
    suppressed: false,
    openFaces,
    thickness,
    direction: 'inward',
    ...extra,
  };
}

function withFeatures(doc: WrenDoc, ...features: Feature[]): WrenDoc {
  const next = structuredClone(doc);
  const p = next.parts[0];
  if (!p) throw new Error('no part');
  p.features.push(...features);
  p.rollbackIndex = p.features.length;
  return next;
}

function only(r: RegenOutput): BodyResult {
  expect(r.bodies, describeFailures(r)).toHaveLength(1);
  return r.bodies[0] as BodyResult;
}

describe.skipIf(!m3)(`regen golden: booleans merge coplanar faces (ADR-078)${note}`, () => {
  const api = m3 as Api;
  const regen = (doc: WrenDoc) =>
    api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });

  /** Faces of `body` whose plane is `normal · p = offset` (planar faces only). */
  async function facesOnPlane(body: BodyResult, normal: [number, number, number], offset: number) {
    const fp = await api.fingerprints(body.shape);
    if (!fp.ok) throw new Error('fingerprints');
    return fp.value.faces
      .map((f, i) => ({ f, name: body.mesh.faceNames[i] as string }))
      .filter(
        ({ f }) =>
          f.normal?.every((v, j) => Math.abs(v - (normal[j] as number)) < 1e-9) === true &&
          Math.abs(f.centroid.reduce((s, v, j) => s + v * (normal[j] as number), 0) - offset) <
            1e-6,
      );
  }

  it('the bracket: one back face and one face per side; volume unchanged', async () => {
    const r = await regen(bracketDoc());
    expect(states(r), describeFailures(r)).toEqual(Array(9).fill('ok'));
    const body = only(r);
    const d = BRACKET_DIMS;
    relClose(totalVolume(r.bodies), bracketVolume(d), 1e-9);
    // 17 faces before ADR-078: the back and both sides were split at the plate's top.
    expect(body.mesh.faceNames).toHaveLength(14);
    const back = await facesOnPlane(body, [0, 1, 0], d.depth);
    expect(back.map((b) => b.name)).toEqual([plateBack]);
    relClose(back[0]?.f.area ?? 0, d.width * (d.thickness + d.height), 1e-9);
    const left = await facesOnPlane(body, [-1, 0, 0], 0);
    expect(left.map((b) => b.name)).toEqual([plateLeft]);
    // Plate side (short of the corner fillet) + upright side + the bend fillet's end − the
    // chamfer's end.
    relClose(
      left[0]?.f.area ?? 0,
      (d.depth - d.corner_r) * d.thickness +
        d.thickness * d.height +
        K * d.bend_r ** 2 -
        0.5 * d.chamfer_d ** 2,
      1e-9,
    );
    const right = await facesOnPlane(body, [1, 0, 0], d.width);
    expect(right.map((b) => b.name)).toEqual([plateRight]);
    for (const absorbed of [uprightBack, uprightLeft, uprightRight]) {
      expect(body.mesh.faceNames).not.toContain(absorbed);
    }
    // Every feature after the upright resolved its references by name.
    for (const f of r.features as RegenFeatureStatus[]) {
      expect(f.merged, f.featureId).toBeUndefined();
      expect(f.rebound, f.featureId).toBeUndefined();
    }
  }, 120_000);

  it('a ref to an absorbed face resolves to the merged face, reported as merged, and returns to its own face when un-merged', async () => {
    // The bracket's upright with a gap from the back edge; a boss sketched on its back face.
    const s1 = new Sk();
    const r1 = s1.rect('p', 'L', 0, 0, 80, 50, 'width', 'depth');
    s1.geo({ kind: 'fix', entity: r1.a });
    const s3 = new Sk();
    s3.point('o', 0, 0, true);
    s3.geo({ kind: 'fix', entity: 'o' });
    const r3 = s3.rect('q', 'M', 0, 42, 80, 50, 'width', 'thickness');
    s3.geo({ kind: 'verticalPoints', a: 'o', b: r3.a });
    s3.dim({ kind: 'vDistance', a: 'o', b: r3.a }, 'depth - thickness - gap');
    const S4 = fid('US4');
    const E4 = fid('UE4');
    const s4 = new Sk();
    s4.circle('c', -40, 28, 3);
    const sketchOnBack: SketchFeature = s4.feature(S4, face(uprightBack), 'On the back');
    const plateTop: EntityRef = { name: `F${B.E1}:end`, kind: 'face' };
    const doc = makeDoc(
      { width: '80 mm', depth: '50 mm', thickness: '8 mm', height: '40 mm', gap: '0 mm' },
      [
        s1.feature(B.S1),
        extrude(B.E1, [region(B.S1, 'L1,L2,L3,L4')], 'thickness'),
        s3.feature(B.S3, plateTop, 'Upright'),
        extrude(B.E3, [region(B.S3, 'M1,M2,M3,M4')], 'height', 'add'),
        sketchOnBack,
        extrude(E4, [region(S4, 'c')], '5', 'add'),
      ],
      PART,
    );
    const boss = Math.PI * 9 * 5;

    const flush = await regen(doc);
    expect(states(flush), describeFailures(flush)).toEqual(Array(6).fill('ok'));
    const sk = flush.features[4] as RegenFeatureStatus;
    expect(sk.merged).toEqual([{ path: '/on', name: uprightBack, into: plateBack }]);
    expect(sk.rebound).toBeUndefined();
    expect(sk.unresolved).toBeUndefined();
    relClose(totalVolume(flush.bodies), 80 * 50 * 8 + 80 * 8 * 40 + boss, 1e-9);
    const bossFaces = await facesOnPlane(only(flush), [0, 1, 0], 55);
    expect(bossFaces).toHaveLength(1);

    // Un-merged: the stored name was not healed, so it is the upright's own face again.
    const gap = await regen(withParams(doc, { gap: '5 mm' }));
    expect(states(gap), describeFailures(gap)).toEqual(Array(6).fill('ok'));
    const sk2 = gap.features[4] as RegenFeatureStatus;
    expect(sk2.merged).toBeUndefined();
    expect(sk2.rebound).toBeUndefined();
    expect(only(gap).mesh.faceNames).toContain(uprightBack);
    relClose(totalVolume(gap.bodies), 80 * 50 * 8 + 80 * 8 * 40 + boss, 1e-9);
    expect(await facesOnPlane(only(gap), [0, 1, 0], 50)).toHaveLength(2);
  }, 120_000);

  it('an absorbed edge name (the upright back corner) resolves to the merged full-height edge', async () => {
    // The plate's and the upright's back-left vertical edges are one edge after the merge, named
    // from the surviving faces; the upright's old name is its alias.
    const uprightCorner = edgeName(uprightBack, uprightLeft);
    const merged = edgeName(plateBack, plateLeft);
    const r = await regen(
      withFeatures(
        bracketDoc(),
        fillet(fid('UFI'), [{ name: uprightCorner, kind: 'edge' }], '2 mm'),
      ),
    );
    expect(states(r), describeFailures(r)).toEqual(Array(10).fill('ok'));
    const st = r.features[9] as RegenFeatureStatus;
    expect(st.merged).toEqual([{ path: '/edges/0', name: uprightCorner, into: merged }]);
    const d = BRACKET_DIMS;
    relClose(totalVolume(r.bodies), bracketVolume(d) - K * 4 * (d.thickness + d.height), 1e-9);
  }, 120_000);

  it('shell 1 mm and 2 mm with the upright top open: analytic volume', async () => {
    const d = BRACKET_DIMS;
    for (const t of [1, 2]) {
      const r = await regen(withFeatures(bracketDoc(), shell([face(uprightTop)], `${t} mm`)));
      expect(states(r), describeFailures(r)).toEqual(Array(10).fill('ok'));
      relClose(totalVolume(r.bodies), bracketVolume(d) - voidVolume(d, t, 'top'), 1e-6);
    }
  }, 120_000);

  it('shell 2 mm, closed and with the back open (picked as both absorbed faces)', async () => {
    const d = BRACKET_DIMS;
    const closed = await regen(
      withFeatures(bracketDoc(), shell([], '2 mm', { body: { name: `B${B.E1}`, kind: 'body' } })),
    );
    expect(states(closed), describeFailures(closed)).toEqual(Array(10).fill('ok'));
    relClose(totalVolume(closed.bodies), bracketVolume(d) - voidVolume(d, 2, 'none'), 1e-6);

    // The plate's and the upright's back faces are one face now: both picks are that face.
    const back = await regen(
      withFeatures(bracketDoc(), shell([face(plateBack), face(uprightBack)], '2 mm')),
    );
    expect(states(back), describeFailures(back)).toEqual(Array(10).fill('ok'));
    const st = back.features[9] as RegenFeatureStatus;
    expect(st.merged).toEqual([{ path: '/openFaces/1', name: uprightBack, into: plateBack }]);
    relClose(totalVolume(back.bodies), bracketVolume(d) - voidVolume(d, 2, 'back'), 1e-6);
    const rims = only(back).mesh.faceNames.filter((n) => n.startsWith(`F${SH}:rim(`));
    expect(rims).toEqual([`F${SH}:rim(${plateBack})`]);
  }, 120_000);

  it('shell 2 mm with the plate front open (tangent to both corner fillets)', async () => {
    // OCCT's thick solid cannot open a face that runs tangentially into kept faces; the kernel
    // hollows by booleans then: the closed 2 mm void plus the slab through the front between the
    // fillets' tangent lines (W − 2 r wide, t deep, T − 2t high).
    const d = BRACKET_DIMS;
    const t = 2;
    const r = await regen(
      withFeatures(bracketDoc(), shell([face(side(B.E1, B.S1, 'L1'))], `${t} mm`)),
    );
    expect(states(r), describeFailures(r)).toEqual(Array(10).fill('ok'));
    const slab = (d.width - 2 * d.corner_r) * t * (d.thickness - 2 * t);
    relClose(totalVolume(r.bodies), bracketVolume(d) - voidVolume(d, t, 'none') - slab, 1e-6);
    const names = only(r).mesh.faceNames;
    expect(names.some((n) => n.startsWith(`F${SH}:rim(${side(B.E1, B.S1, 'L1')})`))).toBe(true);
    expect(names).not.toContain(side(B.E1, B.S1, 'L1'));
  }, 120_000);

  it('shell 5 mm: too thick for the 8 mm walls (precise error); fine on a 16 mm bracket', async () => {
    // Inward 5 mm needs walls over 10 mm (the plate and the upright are 8 mm), and with the top
    // open the 2 mm chamfer's offset meets the inner back wall below the top for
    // t > (T − c) / (1 + √2) (2.49 mm at T = 8, 5.80 mm at T = 16).
    const thin = await regen(withFeatures(bracketDoc(), shell([face(uprightTop)], '5 mm')));
    const st = thin.features[9] as RegenFeatureStatus;
    expect(st.state).toBe('error');
    expect(st.error?.code).toBe('OPERATION_FAILED');
    expect(st.error?.message).toMatch(/too thick/);
    expect(st.error?.entityRefs).toEqual([uprightTop]);

    const thick = { ...BRACKET_DIMS, thickness: 16, corner_r: 8 };
    const doc = withParams(withFeatures(bracketDoc(), shell([face(uprightTop)], '5 mm')), {
      thickness: '16 mm',
      corner_r: '8 mm',
    });
    const r = await regen(doc);
    expect(states(r), describeFailures(r)).toEqual(Array(10).fill('ok'));
    relClose(totalVolume(r.bodies), bracketVolume(thick) - voidVolume(thick, 5, 'top'), 1e-6);
  }, 120_000);
});
