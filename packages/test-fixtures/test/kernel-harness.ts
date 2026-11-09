/**
 * Real-kernel harness for the reference-part goldens: the Wasm kernel (Node, single-threaded build)
 * and planegcs behind `createModelingApi`, exactly as the kernel-client goldens use them.
 *
 * `createModelingApi` is not in kernel-client's package exports (the worker surface is), so this
 * imports it by relative path. If kernel-client ever exports it, switch to the package import.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BodyResult, Id, MassProperties, WhittleDoc } from '@whittle/contracts';
import { createModelingApi, type ModelingApiDeps } from '../../kernel-client/src/modeling-api';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `packages/kernel/dist`: this checkout's, else `$WHITTLE_KERNEL_DIST`, else the main checkout's
 * (a git worktree has no build of its own).
 */
export function findKernelDist(): string | null {
  const candidates: string[] = [];
  if (process.env.WHITTLE_KERNEL_DIST) candidates.push(process.env.WHITTLE_KERNEL_DIST);
  candidates.push(resolve(here, '../../kernel/dist'));
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: here,
      encoding: 'utf8',
    }).trim();
    candidates.push(resolve(here, common, '../packages/kernel/dist'));
  } catch {
    // not a git checkout
  }
  for (const c of candidates) if (existsSync(`${c}/init.single.js`)) return c;
  return null;
}

export const kernelDist = findKernelDist();
export const kernelBuilt = kernelDist !== null;
export const kernelSkipNote = kernelBuilt
  ? ''
  : ' (SKIPPED: packages/kernel/dist missing; run `pnpm --filter @whittle/kernel build`)';

type Variants = ModelingApiDeps['variants'];

export type Api = ReturnType<typeof createModelingApi>;

export async function loadApi(): Promise<Api> {
  if (kernelDist === null) throw new Error('kernel not built');
  const single = pathToFileURL(`${kernelDist}/init.single.js`).href;
  const variants = {
    single: { load: () => import(single) },
    threaded: { load: () => import(single) },
  } as unknown as Variants;
  const api = createModelingApi({ variants, canUseThreads: () => false });
  const r = await api.init({ variant: 'single' });
  if (!r.ok) throw new Error(`kernel init failed: ${JSON.stringify(r.error)}`);
  return api;
}

export interface Measured {
  states: string[];
  failures: string;
  volume: number;
  /** kg, from the material density. */
  massKg: number;
  area: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  bodies: number;
}

export async function measure(api: Api, doc: WhittleDoc, partId: Id): Promise<Measured> {
  const r = await api.regenerate({ doc, partId, quality: 'coarse', massProperties: true });
  const states = r.features.map((f) => f.state);
  const failures = JSON.stringify(
    r.features
      .map((f, i) => ({ i, ...f }))
      .filter((f) => f.state !== 'ok' && f.state !== 'suppressed'),
    null,
    1,
  );
  const mps = r.bodies.map((b: BodyResult) => b.massProperties).filter(Boolean) as MassProperties[];
  const volume = mps.reduce((s, m) => s + m.volume, 0);
  const massKg = mps.reduce((s, m) => s + (m.mass ?? 0), 0);
  const area = mps.reduce((s, m) => s + m.area, 0);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of mps)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] as number, m.bbox.min[i] as number);
      max[i] = Math.max(max[i] as number, m.bbox.max[i] as number);
    }
  return { states, failures, volume, massKg, area, bbox: { min, max }, bodies: mps.length };
}
