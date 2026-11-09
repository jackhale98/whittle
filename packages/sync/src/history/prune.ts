// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which automatic snapshots to drop (PrunePolicy, PLAN §8A.3): keep every one younger than
 * `keepAllForMs`; then the newest per hour until `hourlyForMs`; then the newest per day. Named
 * versions are never candidates, and neither is anything in `keep` (released versions, the
 * version the working copy is on). Buckets are per branch.
 */

import type { PrunePolicy } from '@wren-cad/contracts';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_PRUNE_POLICY: PrunePolicy = { keepAllForMs: DAY_MS, hourlyForMs: 7 * DAY_MS };

export interface PruneCandidate {
  id: string;
  /** ISO-8601. */
  at: string;
  auto?: boolean;
  branch?: string;
}

/** Ids of automatic snapshots the policy drops. */
export function selectPrunable(
  versions: readonly PruneCandidate[],
  keep: ReadonlySet<string>,
  policy: Partial<PrunePolicy> = {},
  now: Date = new Date(),
): string[] {
  const keepAll = policy.keepAllForMs ?? DEFAULT_PRUNE_POLICY.keepAllForMs;
  const hourly = Math.max(keepAll, policy.hourlyForMs ?? DEFAULT_PRUNE_POLICY.hourlyForMs);
  const t = now.getTime();
  const newest = new Map<string, PruneCandidate>();
  const drop: string[] = [];
  const autos = versions
    .filter((v) => v.auto && !keep.has(v.id))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  for (const v of autos) {
    const when = Date.parse(v.at);
    const age = t - when;
    if (!Number.isFinite(when) || age < keepAll) continue;
    const size = age < hourly ? HOUR_MS : DAY_MS;
    const bucket = `${v.branch ?? ''}\u0000${size}\u0000${Math.floor(when / size)}`;
    if (newest.has(bucket)) drop.push(v.id);
    else newest.set(bucket, v);
  }
  return drop;
}
