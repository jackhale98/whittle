/**
 * Reference-part suite, part 2 (real kernel): every part is regenerated through the kernel-client
 * engine with the real Wasm kernel, at the baseline and at every CSWP-style stage, and its volume
 * and mass are checked against the spec to 0.1 % (PLAN section 12, M3 acceptance).
 *
 * Parts that use a feature whose kernel or regeneration support has not landed yet are skipped
 * with an explicit `test.skip` and a reason. When a workstream merges, delete its line from
 * `PENDING` below: the parts that need it then run for real.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineDims, buildDoc, stageDims, stageDoc } from '../reference-parts/lib/builder';
import { dimGetter, type Step } from '../reference-parts/lib/types';
import { PARTS } from '../reference-parts/parts';
import { type Api, kernelBuilt, kernelSkipNote, loadApi, measure } from './kernel-harness';

/**
 * Features (or sketch operations) the engine in this checkout cannot regenerate yet. The lead
 * removes entries as the M3 workstreams merge and re-runs the suite.
 */
const PENDING: Record<string, string> = {
  shell: 'M3 kernel shell (kernel-engineer)',
  draft: 'M3 kernel draft (kernel-engineer)',
  sweep: 'M3 kernel sweep and sweep-cut (kernel-engineer)',
  loft: 'M3 kernel loft (kernel-engineer)',
  mirror: 'M3 mirror regen (kernel-engineer, modeling-engineer)',
  linearPattern: 'M3 linear pattern regen (kernel-engineer, modeling-engineer)',
  circularPattern: 'M3 circular pattern regen (kernel-engineer, modeling-engineer)',
  hole: 'M3 hole wizard regen and tables (modeling-engineer)',
  axis: 'M3 reference axes (modeling-engineer)',
  point: 'M3 reference points (modeling-engineer)',
  'sketch.offset': 'M3 offset entities and the offset dimension in the solver (sketch-engineer)',
  'sketch.convert':
    'M3 convert entities, linked sketch geometry (sketch-engineer, modeling-engineer)',
};

function needs(steps: Step[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    out.add(s.tool);
    for (const o of s.ops ?? []) {
      if (o.op === 'offsetRect') out.add('sketch.offset');
      if (o.op === 'convert') out.add('sketch.convert');
    }
  }
  return [...out].filter((k) => k in PENDING).sort();
}

const TOL = 1e-3; // 0.1 %

describe.skipIf(!kernelBuilt)(`reference parts on the real kernel${kernelSkipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 120_000);
  afterAll(async () => {
    for (const p of PARTS) await api.closePart(buildDoc(p).parts[0]?.id ?? '');
  });

  for (const part of PARTS) {
    const pending = needs(part.steps(dimGetter(baselineDims(part))));
    if (pending.length > 0) {
      const why = pending.map((k) => `${k}: ${PENDING[k]}`).join('; ');
      test.skip(`${part.id}: baseline and ${part.stages.length} stages [SKIPPED, not yet supported: ${why}]`, () => {});
      continue;
    }
    const cases = [
      { name: 'Stage 1: as drawn', set: {} as Record<string, number> },
      ...part.stages,
    ];
    test.each(cases)(
      `$name`,
      async ({ name, set }) => {
        const baseline = Object.keys(set).length === 0 && name.startsWith('Stage 1');
        const doc = baseline ? buildDoc(part) : stageDoc(part, set);
        const dims = baseline ? baselineDims(part) : stageDims(part, set);
        const model = part.model(dimGetter(dims));
        const rho = Number(/^([0-9.]+) g/.exec(doc.parts[0]?.material?.density ?? '')?.[1]);
        const m = await measure(api, doc, doc.parts[0]?.id ?? '');
        expect(
          m.states.every((s) => s === 'ok'),
          `${part.id} ${name}: ${m.failures}`,
        ).toBe(true);
        expect(m.bodies, 'one body').toBe(1);
        expect(Math.abs(m.volume - model.volume) / model.volume, 'volume').toBeLessThan(TOL);
        const massG = m.massKg * 1000;
        const expectedMassG = (model.volume * rho) / 1000;
        expect(
          Math.abs(massG - expectedMassG) / expectedMassG,
          `mass ${massG} g vs ${expectedMassG} g`,
        ).toBeLessThan(TOL);
        if (model.area !== undefined)
          expect(Math.abs(m.area - model.area) / model.area, 'area').toBeLessThan(TOL);
        for (let i = 0; i < 3; i++) {
          const span = (model.bbox.max[i] as number) - (model.bbox.min[i] as number);
          expect(
            Math.abs((m.bbox.min[i] as number) - (model.bbox.min[i] as number)),
            `bbox min ${i}`,
          ).toBeLessThan(TOL * span + 1e-6);
          expect(
            Math.abs((m.bbox.max[i] as number) - (model.bbox.max[i] as number)),
            `bbox max ${i}`,
          ).toBeLessThan(TOL * span + 1e-6);
        }
      },
      60_000,
    );
  }
});
