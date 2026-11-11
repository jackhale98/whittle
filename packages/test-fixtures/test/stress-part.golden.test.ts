/**
 * Stress-part goldens (real kernel): every one of the 100+ features regenerates `ok` (no
 * "needs attention", so every persistent name in the fixture resolves), the volume of selected
 * features equals an analytic value, and the finished part matches regression goldens.
 *
 * Opt-in (`WREN_STRESS=1`): the cold regen takes about a minute on an idle machine.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { WrenDoc } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baselineEnclosureDims,
  ENCLOSURE_PART_ID,
  enclosureDoc,
  enclosureFeatureIds,
  enclosureStepIds,
} from '../stress-part';
import { type Api, kernelBuilt, loadApi } from './kernel-harness';
import { log, rollbackTo, stressEnabled } from './stress-support';

const PI = Math.PI;
const PART = ENCLOSURE_PART_ID;

/** Regression goldens: recorded from this fixture on the kernel with face merging (see README). */
export const GOLDEN = {
  features: 100,
  faces: 409,
  volume: 67976.36102250224,
  area: 61430.580114131124,
};

describe.skipIf(!kernelBuilt || !stressEnabled)('stress part goldens', () => {
  let api: Api;
  let doc: WrenDoc;
  let volumeAt: (stepId: string) => Promise<number>;
  const ids = enclosureFeatureIds();
  const order = enclosureStepIds();

  beforeAll(async () => {
    api = await loadApi();
    doc = enclosureDoc();
    volumeAt = async (stepId) => {
      const k = order.indexOf(stepId) + 1;
      const r = await api.regenerate({
        doc: rollbackTo(doc, k),
        partId: PART,
        quality: 'coarse',
        massProperties: true,
      });
      expect(
        r.features.slice(0, k).every((f) => f.state === 'ok'),
        stepId,
      ).toBe(true);
      const v = r.bodies.reduce((s, b) => s + (b.massProperties?.volume ?? Number.NaN), 0);
      return v;
    };
  }, 120_000);
  afterAll(async () => {
    await api?.closePart(PART);
  });

  it('has 100+ features, unique step ids and a dozen named parameters', () => {
    const f = doc.parts[0]?.features ?? [];
    expect(f.length).toBeGreaterThanOrEqual(100);
    expect(new Set(order).size).toBe(order.length);
    expect(doc.params.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(ids)).toHaveLength(f.length);
  });

  it('every feature ends ok, one body', async () => {
    const r = await api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });
    const bad = r.features
      .map((f, i) => ({ step: order[i], ...f }))
      .filter((f) => f.state !== 'ok');
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
    expect(r.bodies).toHaveLength(1);
    const mp = r.bodies[0]?.massProperties;
    const mesh = r.bodies[0]?.mesh;
    log(
      `[stress] fixture: ${r.features.length} features, ${mesh?.faceNames.length} faces, ${(mesh?.indices.length ?? 0) / 3} triangles (coarse), volume ${mp?.volume}, area ${mp?.area}, mass ${mp?.mass}`,
    );
    expect(mesh?.faceNames.length).toBe(GOLDEN.faces);
    expect(mp?.volume).toBeCloseTo(GOLDEN.volume, 3);
    expect(mp?.area).toBeCloseTo(GOLDEN.area, 2);
  }, 3_600_000);

  it('analytic: drafted box, then per-feature volume deltas', async () => {
    const d = baselineEnclosureDims();
    // The drafted box (before the corner radii): the cross-section is (l - 2 z t)(w - 2 z t).
    const t = Math.tan((d.draft_a * PI) / 180);
    const F = (z: number) =>
      d.length * d.width * z - (d.length + d.width) * t * z * z + (4 / 3) * t * t * z ** 3;
    expect(await volumeAt('dr')).toBeCloseTo(F(d.height), 3);

    const delta = async (step: string, prev: string) =>
      (await volumeAt(step)) - (await volumeAt(prev));
    const tol = (x: number) => Math.max(1e-4 * Math.abs(x), 1e-3);

    // Bottom pockets: area x 0.6 mm, nothing else in the way.
    const lab = await delta('lab', 'lab_sk');
    expect(Math.abs(lab + 40 * 24 * 0.6)).toBeLessThan(tol(lab));
    const bat = await delta('bat', 'bat_sk');
    expect(Math.abs(bat + 40 * 30 * 0.6)).toBeLessThan(tol(bat));
    const foot = await delta('foot_p', 'foot_sk');
    expect(Math.abs(foot + 4 * PI * 25 * 0.6)).toBeLessThan(tol(foot));

    // A rib adds 60 x rib_t x rib_h; five of them; the end ribs add 40 x rib_t x rib_h each.
    const rib = await delta('rib', 'rib_sk');
    expect(Math.abs(rib - 60 * d.rib_t * d.rib_h)).toBeLessThan(tol(rib));
    const ribs = await delta('rib_p', 'rib_sk');
    expect(Math.abs(ribs - 5 * 60 * d.rib_t * d.rib_h)).toBeLessThan(tol(ribs));
    const rib2 = await delta('rib2_m', 'rib2_sk');
    expect(Math.abs(rib2 - 2 * 40 * d.rib_t * d.rib_h)).toBeLessThan(tol(rib2));

    // A boss adds a cylinder; its tapped hole (M3 tap drill 2.5 mm) removes 10 mm of a smaller one.
    const boss = await delta('boss', 'boss_sk');
    expect(Math.abs(boss - PI * (d.boss_d / 2) ** 2 * d.boss_h)).toBeLessThan(tol(boss));
    const hole = await delta('boss_hole', 'boss_pt');
    expect(Math.abs(hole + PI * 1.25 ** 2 * 10)).toBeLessThan(tol(hole));
    const pattern = await delta('boss_x', 'boss_hole');
    expect(
      Math.abs(pattern - 3 * (PI * (d.boss_d / 2) ** 2 * d.boss_h - PI * 1.25 ** 2 * 10)),
    ).toBeLessThan(tol(pattern));

    // A post (5 mm, 8 mm tall) with a 2.5 mm pilot hole 6 mm deep; patterned 2 x 2.
    const post = await delta('post', 'post_sk');
    expect(Math.abs(post - PI * 2.5 ** 2 * 8)).toBeLessThan(tol(post));
    const pilot = await delta('post_hole', 'post_pt');
    expect(Math.abs(pilot + PI * 1.25 ** 2 * 6)).toBeLessThan(tol(pilot));
  }, 3_600_000);
});
