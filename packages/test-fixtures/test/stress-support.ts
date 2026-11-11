/**
 * Shared bits of the stress-part tests: opt-in switch, document editing helpers, timing.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cpus, loadavg } from 'node:os';
import type { Feature, WrenDoc } from '@wren-cad/contracts';

/**
 * The stress goldens and benchmarks run a cold regen of a 100+ feature part (about a minute on an
 * idle machine, several on a loaded one), so they are opt-in: `WREN_STRESS=1 pnpm --filter
 * @wren-cad/test-fixtures test`.
 */
export const stressEnabled = process.env.WREN_STRESS === '1';

export function withParam(doc: WrenDoc, name: string, expr: string): WrenDoc {
  const next = structuredClone(doc);
  const p = next.params.find((x) => x.name === name);
  if (!p) throw new Error(`no parameter ${name}`);
  p.expr = expr;
  return next;
}

/** Edit one feature (a structural clone of the document with `patch` applied). */
export function withFeature(doc: WrenDoc, id: string, patch: (f: Feature) => void): WrenDoc {
  const next = structuredClone(doc);
  const f = next.parts[0]?.features.find((x) => x.id === id);
  if (!f) throw new Error(`no feature ${id}`);
  patch(f);
  return next;
}

export function rollbackTo(doc: WrenDoc, count: number): WrenDoc {
  const next = structuredClone(doc);
  const part = next.parts[0];
  if (part) part.rollbackIndex = count;
  return next;
}

export const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : (s[Math.floor((s.length - 1) / 2)] as number);
};
export const p90 = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0
    ? Number.NaN
    : (s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)] as number);
};

/** `uptime`-style load note, printed next to every table. */
export function loadNote(): string {
  const [a = 0, b = 0, c = 0] = loadavg();
  return `load average ${a.toFixed(1)} ${b.toFixed(1)} ${c.toFixed(1)} on ${cpus().length} cores`;
}

/** Wall and process CPU time of an async step. CPU time is far less sensitive to a loaded machine. */
export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; wallMs: number; cpuMs: number }> {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const value = await fn();
  const wallMs = performance.now() - t0;
  const c = process.cpuUsage(c0);
  return { value, wallMs, cpuMs: (c.user + c.system) / 1000 };
}

export function log(line: string): void {
  process.stderr.write(`${line}\n`);
}
