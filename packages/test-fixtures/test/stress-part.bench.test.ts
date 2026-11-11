/**
 * Stress-part benchmark (Node, single-threaded kernel): how fast is the regen engine on a 100+
 * feature enclosure? Opt-in (`WREN_STRESS=1`); report-only (it asserts correctness, never a time).
 *
 * Scenarios: cold full regen; edit the last feature; a late and a mid feature; the first sketch
 * dimension and the shell wall (full downstream regen); an early fillet radius; suppress and
 * unsuppress an early feature; the undo-equivalent re-regen (cache hit); handle and memory
 * accounting over 50 edits. Each prints median and p90 of wall time and process CPU time (CPU time
 * is the number to trust on a loaded machine) over `WREN_STRESS_RUNS` runs (default 3).
 *
 * `WREN_STRESS_OUT=<file>` also writes the table as JSON; `WREN_KERNEL_DIST=<dir>` benchmarks a
 * different kernel build (the A/B of the face-merge change).
 *
 * `WREN_STRESS_MASS=deferred` (ADR-083) regenerates without mass properties, as the app does for a
 * part without a material: the document's material is dropped and the request does not ask for
 * them. The default (`inline`) asks for them, as a part with a material gets them today. Deferred
 * runs add a row for the separate `massProperties(shape)` fetch of the final body after an edit.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { writeFileSync } from 'node:fs';
import type { Id, WrenDoc } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENCLOSURE_PART_ID, enclosureDoc, enclosureFeatureIds } from '../stress-part';
import { type Api, kernelBuilt, kernelDist, loadApi } from './kernel-harness';
import {
  loadNote,
  log,
  median,
  p90,
  rollbackTo,
  stressEnabled,
  timed,
  withFeature,
  withParam,
} from './stress-support';

/** `WREN_STRESS_ONLY=cold,last,wall` runs just those groups (cold, cached, last, mid, wall, fillet, length, suppress, undo2, memory, rollback). */
const only = process.env.WREN_STRESS_ONLY?.split(',');
const want = (tag: string) => only === undefined || only.includes(tag);
/** Runs of the cheap scenarios (edits of late features). */
const RUNS = Number(process.env.WREN_STRESS_RUNS ?? 3);
/** Runs of the expensive ones (a full regen is minutes on a loaded machine). */
const FULL = Number(process.env.WREN_STRESS_FULL_RUNS ?? 2);
const PART = ENCLOSURE_PART_ID;
/** Mass properties in the regen (`inline`, default) or fetched separately (`deferred`). */
const DEFERRED = process.env.WREN_STRESS_MASS === 'deferred';
const ids = enclosureFeatureIds();

interface Row {
  scenario: string;
  firstChanged: string;
  runs: number;
  wallMedian: number;
  wallP90: number;
  cpuMedian: number;
  cpuP90: number;
  misses: number;
  hits: number;
  coarse: boolean;
}
const rows: Row[] = [];

describe.skipIf(!kernelBuilt || !stressEnabled)('stress part benchmark', () => {
  let api: Api;
  let base: WrenDoc;
  const n = () => base.parts[0]?.features.length ?? 0;

  beforeAll(async () => {
    api = await loadApi();
    base = enclosureDoc();
    if (DEFERRED) delete (base.parts[0] as { material?: unknown }).material;
  }, 120_000);
  afterAll(async () => {
    await api?.closePart(PART);
    const bold = (s: string) => s;
    log(bold(`\n[stress] kernel ${kernelDist}`));
    log(
      `[stress] ${loadNote()}; ${RUNS} runs (cheap) or ${FULL} (full regen) per scenario; features=${n()}; mass properties ${DEFERRED ? 'deferred (no material, fetched separately)' : 'inline (requested)'}`,
    );
    const head = `${'scenario'.padEnd(46)} ${'first changed'.padEnd(12)} ${'hit/miss'.padEnd(9)} ${'wall med'.padStart(9)} ${'wall p90'.padStart(9)} ${'cpu med'.padStart(9)} ${'cpu p90'.padStart(9)}`;
    log(head);
    for (const r of rows) {
      log(
        `${r.scenario.padEnd(46)} ${r.firstChanged.padEnd(12)} ${`${r.hits}/${r.misses}`.padEnd(9)} ${r.wallMedian.toFixed(0).padStart(9)} ${r.wallP90.toFixed(0).padStart(9)} ${r.cpuMedian.toFixed(0).padStart(9)} ${r.cpuP90.toFixed(0).padStart(9)}`,
      );
    }
    if (process.env.WREN_STRESS_OUT) {
      writeFileSync(
        process.env.WREN_STRESS_OUT,
        JSON.stringify({ kernel: kernelDist, load: loadNote(), features: n(), rows }, null, 1),
      );
    }
  });

  const regen = (doc: WrenDoc, quality: 'coarse' | 'fine' = 'coarse') =>
    api.regenerate({
      doc,
      partId: PART as Id,
      quality,
      ...(DEFERRED ? {} : { massProperties: true }),
    });

  async function scenario(
    name: string,
    firstChanged: string,
    runs: number,
    edit: (i: number) => WrenDoc,
    opts: { before?: (i: number) => Promise<void> } = {},
  ): Promise<void> {
    const wall: number[] = [];
    const cpu: number[] = [];
    let hits = 0;
    let misses = 0;
    for (let i = 0; i < runs; i++) {
      await opts.before?.(i);
      const t = await timed(() => regen(edit(i)));
      const r = t.value;
      expect(
        r.features.every((f) => f.state === 'ok' || f.state === 'suppressed'),
        `${name} run ${i}: ${JSON.stringify(r.features.filter((f) => f.state !== 'ok'))}`,
      ).toBe(true);
      wall.push(t.wallMs);
      cpu.push(t.cpuMs);
      hits = r.cache.hits;
      misses = r.cache.misses;
    }
    rows.push({
      scenario: name,
      firstChanged,
      runs,
      wallMedian: median(wall),
      wallP90: p90(wall),
      cpuMedian: median(cpu),
      cpuP90: p90(cpu),
      hits,
      misses,
      coarse: true,
    });
  }

  /** Re-establish the base document in the cache (not timed). */
  const rebase = async () => {
    await regen(base);
  };

  it.skipIf(!want('cold'))(
    'cold full regen',
    async () => {
      await scenario('cold full regen (empty cache)', 'sketch 0', FULL, () => base, {
        before: async () => api.closePart(PART),
      });
      expect(rows.at(-1)?.hits).toBe(0);
    },
    3_600_000,
  );

  it.skipIf(!want('cached'))(
    'all cached (no change)',
    async () => {
      await rebase();
      await scenario('re-regen, nothing changed (all hits)', '-', RUNS * 2, () => base);
      expect(rows.at(-1)?.misses).toBe(0);
    },
    600_000,
  );

  it.skipIf(!want('last'))(
    'edit the last feature',
    async () => {
      await rebase();
      await scenario('edit last feature (ear corner fillet r)', 'ear_f', RUNS * 2, (i) =>
        withFeature(base, ids.ear_f as string, (f) => {
          if (f.type === 'fillet') f.radius = `${3 + 0.1 * (i + 1)} mm`;
        }),
      );
      expect(rows.at(-1)?.misses).toBe(1);
      if (DEFERRED) {
        // What the app then fetches off the critical path: the edited body's mass properties.
        const wall: number[] = [];
        const cpu: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const r = await regen(
            withFeature(base, ids.ear_f as string, (f) => {
              if (f.type === 'fillet') f.radius = `${3.5 + 0.1 * (i + 1)} mm`;
            }),
          );
          const t = await timed(() => api.massProperties(r.bodies[0]?.shape ?? 0));
          expect(t.value.ok).toBe(true);
          wall.push(t.wallMs);
          cpu.push(t.cpuMs);
        }
        rows.push({
          scenario: '  then massProperties(final body), deferred',
          firstChanged: 'ear_f',
          runs: RUNS,
          wallMedian: median(wall),
          wallP90: p90(wall),
          cpuMedian: median(cpu),
          cpuP90: p90(cpu),
          hits: 0,
          misses: 0,
          coarse: true,
        });
      }
    },
    600_000,
  );

  it.skipIf(!want('mid'))(
    'edit a late feature, a mid feature',
    async () => {
      await rebase();
      await scenario('edit late feature (ear_t param)', 'ear', RUNS, (i) =>
        withParam(base, 'ear_t', `${3 + 0.1 * (i + 1)} mm`),
      );
      await rebase();
      await scenario('edit mid feature (vent_pitch param)', 'vent_p', RUNS, (i) =>
        withParam(base, 'vent_pitch', `${5 + 0.1 * (i + 1)} mm`),
      );
    },
    3_600_000,
  );

  it.skipIf(!want('wall'))(
    'edit the shell wall (early, full downstream)',
    async () => {
      await rebase();
      await scenario('edit shell wall (early, full downstream)', 'shell', FULL, (i) =>
        withParam(base, 'wall', `${2.5 + 0.05 * (i + 1)} mm`),
      );
    },
    7_200_000,
  );

  it.skipIf(!want('fillet'))(
    'edit an early fillet radius',
    async () => {
      await scenario('edit fillet_r (rim fillet, early)', 'frim', FULL, (i) =>
        withParam(base, 'fillet_r', `${0.8 + 0.02 * (i + 1)} mm`),
      );
    },
    7_200_000,
  );

  it.skipIf(!want('length'))(
    'edit the first sketch dimension (full regen)',
    async () => {
      await scenario('edit first sketch dim (length, full regen)', 'sketch 0', FULL, (i) =>
        withParam(base, 'length', `${120 + 1 * (i + 1)} mm`),
      );
    },
    7_200_000,
  );

  it.skipIf(!want('suppress'))(
    'suppress / unsuppress an early feature; undo-equivalent',
    async () => {
      await rebase();
      const sup = (on: boolean) =>
        withFeature(base, ids.boss_f as string, (f) => {
          f.suppressed = on;
        });
      await scenario('suppress early feature (boss root fillet)', 'boss_f', FULL, () => sup(true), {
        before: rebase,
      });
      // Unsuppress right after a suppress: the base entries are still in the spare cache.
      await scenario('unsuppress it again (undo: cache hit)', 'boss_f', FULL, () => base, {
        before: async () => {
          await regen(sup(true));
        },
      });
      await rebase();
      await scenario('undo of a late edit (ear_t back: hit)', 'ear', RUNS, () => base, {
        before: async () => {
          await regen(withParam(base, 'ear_t', '3.7 mm'));
        },
      });
    },
    7_200_000,
  );

  it.skipIf(!want('undo2'))(
    'two early edits, then undo both (the second undo must stay a cache hit)',
    async () => {
      await rebase();
      const edits = [withParam(base, 'wall', '2.6 mm'), withParam(base, 'wall', '2.7 mm')];
      await scenario(
        'undo twice after two early edits: 1st undo',
        'shell',
        FULL,
        () => edits[0] as WrenDoc,
        {
          before: async () => {
            await rebase();
            for (const d of edits) await regen(d);
          },
        },
      );
      await scenario('undo twice after two early edits: 2nd undo', 'shell', FULL, () => base, {
        before: async () => {
          await rebase();
          for (const d of edits) await regen(d);
          await regen(edits[0] as WrenDoc);
        },
      });
    },
    7_200_000,
  );

  it.skipIf(!want('memory'))(
    'handle and memory accounting over 50 edits',
    async () => {
      await rebase();
      const f0 = await api.memoryStats();
      const samples: string[] = [];
      const snap = async (label: string) => {
        const m = await api.memoryStats();
        samples.push(
          `${label}: liveHandles ${m.liveHandles}, wasm heap ${(m.wasmHeapBytes / 1048576).toFixed(0)} MB, node rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`,
        );
        return m;
      };
      await snap('after base');
      const wall: number[] = [];
      let last = f0;
      for (let i = 0; i < 50; i++) {
        // 45 edits of late features and 5 of a mid one (an early edit is a minute each on a loaded machine).
        const doc =
          i % 10 === 9
            ? withParam(base, 'vent_pitch', `${5 + 0.01 * (i + 1)} mm`)
            : withFeature(base, ids.ear_f as string, (f) => {
                if (f.type === 'fillet') f.radius = `${3 + 0.01 * (i + 1)} mm`;
              });
        const t = await timed(() => regen(doc));
        expect(t.value.features.every((f) => f.state === 'ok')).toBe(true);
        wall.push(t.wallMs);
        if (i === 9 || i === 24 || i === 49) last = await snap(`after edit ${i + 1}`);
      }
      log(`[stress] 50 edits: ${samples.join(' | ')}`);
      log(`[stress] 50 edits: engine ${JSON.stringify(api.engine.stats(PART))}`);
      await api.closePart(PART);
      const closed = await api.memoryStats();
      log(
        `[stress] after closePart: liveHandles ${closed.liveHandles} (expected 0), wasm heap ${(closed.wasmHeapBytes / 1048576).toFixed(0)} MB`,
      );
      expect(closed.liveHandles).toBe(0);
      expect(last.liveHandles).toBeGreaterThan(0);
      rows.push({
        scenario: '50 edits (45 last-feature, 5 mid), per edit',
        firstChanged: 'mixed',
        runs: 50,
        wallMedian: median(wall),
        wallP90: p90(wall),
        cpuMedian: Number.NaN,
        cpuP90: Number.NaN,
        hits: 0,
        misses: 0,
        coarse: true,
      });
    },
    3_600_000,
  );

  it.skipIf(!want('rollback'))(
    'rollback probe stays a cache hit',
    async () => {
      await rebase();
      const r = await regen(rollbackTo(base, Math.floor(n() / 2)));
      expect(r.cache.misses).toBe(0);
    },
    600_000,
  );
});
