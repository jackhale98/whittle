/**
 * Drawing kernel timing (ADR-090 amendment): draft (HLRBRep_PolyAlgo) and exact (HLRBRep_Algo)
 * projections of the M1 bracket and the stress enclosure, single-threaded drawing kernel in Node,
 * through `DrawingWorkerApi` exactly as the drawing worker runs them. Report-only: it asserts that
 * every view projects with named curves, never a time.
 *
 * PLAN §10 has no HLR budget; the log compares against the nearest one, the 300 ms regen budget
 * ("regen after editing the last feature"), which a draft view must meet to feel as live as the
 * model: drafts are shown first, exact output replaces them when idle (ADR-090 §14).
 *
 * The bracket runs whenever both kernels are built; the stress part is opt-in with
 * `WREN_STRESS=1` (its exact HLR takes long). `WREN_HLR_RUNS` sets the runs per view (default 3,
 * best and median logged).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ShapeForDrawing, Vec3, WrenDoc } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { createDrawingKernelApi, type DrawingWorkerApi } from '../../kernel/src/drawing/api';
import type { DrawingInitModule } from '../../kernel/src/drawing/facade';
import { bracketDoc } from '../../kernel-client/test/regen/bracket';
import { enclosureDoc } from '../stress-part';
import { type Api, kernelBuilt, loadApi } from './kernel-harness';
import { stressEnabled } from './stress-support';

const here = dirname(fileURLToPath(import.meta.url));
const REGEN_BUDGET_MS = 300;
const RUNS = Number(process.env.WREN_HLR_RUNS ?? 3);

/** packages/kernel/drawing/dist: this checkout's, else `$WREN_DRAWING_DIST`, else the main checkout's. */
function findDrawingDist(): string | null {
  const candidates: string[] = [];
  if (process.env.WREN_DRAWING_DIST) candidates.push(process.env.WREN_DRAWING_DIST);
  candidates.push(resolve(here, '../../kernel/drawing/dist'));
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: here,
      encoding: 'utf8',
    }).trim();
    candidates.push(resolve(here, common, '../packages/kernel/drawing/dist'));
  } catch {
    // not a git checkout
  }
  for (const c of candidates) if (existsSync(`${c}/init.single.js`)) return c;
  return null;
}

const drawingDist = findDrawingDist();
const built = kernelBuilt && drawingDist !== null;

const s2 = Math.SQRT2;
const s6 = Math.sqrt(6);
const VIEWS: Record<string, { x: Vec3; y: Vec3 }> = {
  front: { x: [1, 0, 0], y: [0, 0, 1] },
  top: { x: [1, 0, 0], y: [0, 1, 0] },
  right: { x: [0, 1, 0], y: [0, 0, 1] },
  iso: { x: [1 / s2, 1 / s2, 0], y: [-1 / s6, 1 / s6, 2 / s6] },
};

/** The modeling worker's hand-off (`ModelingApi.shapeForDrawing`), as the app passes it on. */
async function shapeFor(api: Api, doc: WrenDoc, key: string): Promise<ShapeForDrawing> {
  const partId = doc.parts[0]?.id ?? '';
  const r = await api.regenerate({ doc, partId, quality: 'coarse', massProperties: false });
  const failed = r.features.filter((f) => f.state !== 'ok' && f.state !== 'suppressed');
  expect(failed, JSON.stringify(failed).slice(0, 400)).toEqual([]);
  const shape = await api.shapeForDrawing(partId);
  if (!shape.ok) throw new Error(JSON.stringify(shape.error));
  return { ...shape.value, key: `${key}:${shape.value.key}` };
}

function drawingApi(): DrawingWorkerApi {
  const init = pathToFileURL(`${drawingDist}/init.single.js`).href;
  const load = () => import(init) as Promise<DrawingInitModule>;
  return createDrawingKernelApi({
    variants: { single: { load }, threaded: { load } },
    canUseThreads: () => false,
  });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

async function timeViews(label: string, shape: ShapeForDrawing): Promise<void> {
  const api = drawingApi();
  const t0 = performance.now();
  const loaded = await api.loadShape(shape);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  const loadMs = performance.now() - t0;
  const rows: string[] = [];
  for (const quality of ['draft', 'exact'] as const) {
    for (const [name, frame] of Object.entries(VIEWS)) {
      const ms: number[] = [];
      let curves = 0;
      let named = 0;
      for (let run = 0; run < RUNS; run++) {
        const r = await api.project({
          shapeKey: shape.key,
          frame,
          quality,
          hidden: true,
          smooth: true,
        });
        if (!r.ok) throw new Error(`${label} ${name} ${quality}: ${JSON.stringify(r.error)}`);
        ms.push(r.value.ms);
        curves = r.value.curves.length;
        named = r.value.curves.filter((c) => c.name !== undefined).length;
      }
      expect(curves).toBeGreaterThan(0);
      if (shape.edgeNames.length > 0) expect(named).toBeGreaterThan(0);
      const best = Math.min(...ms);
      const verdict =
        quality === 'draft'
          ? best <= REGEN_BUDGET_MS
            ? `within the ${REGEN_BUDGET_MS} ms regen budget`
            : `OVER the ${REGEN_BUDGET_MS} ms regen budget`
          : 'exact (report only)';
      rows.push(
        `  ${quality.padEnd(5)} ${name.padEnd(5)} best ${best.toFixed(1).padStart(8)} ms  median ${median(
          ms,
        )
          .toFixed(1)
          .padStart(8)} ms  ${String(curves).padStart(5)} curves (${named} named)  ${verdict}`,
      );
    }
  }
  const stats = await api.stats();
  process.stdout.write(
    `\nHLR timing — ${label}: BREP ${(shape.brep.byteLength / 1024).toFixed(0)} KiB, ${shape.edgeNames.length} named edges, load ${loadMs.toFixed(1)} ms (first load includes kernel init), runs ${RUNS}, kernel ${stats.variant}\n${rows.join('\n')}\n`,
  );
  await api.releaseShape(shape.key);
}

describe.skipIf(!built)('HLR timing: M1 bracket (PLAN §10 report)', () => {
  it('draft and exact views', async () => {
    const api = await loadApi();
    const shape = await shapeFor(api, bracketDoc(), 'bracket');
    await timeViews('M1 bracket', shape);
  }, 600_000);
});

describe.skipIf(!built || !stressEnabled)('HLR timing: stress enclosure (PLAN §10 report)', () => {
  it('draft and exact views', async () => {
    const api = await loadApi();
    const shape = await shapeFor(api, enclosureDoc(), 'enclosure');
    await timeViews('stress enclosure (100+ features)', shape);
  }, 3_600_000);
});
