/// Fuzz: two devices make random concurrent edits (parameters in the same file, attachments,
/// deletions), sync in random orders with random push races and offline spells, and resolve
/// conflicts with random choices. Property: no edit is ever lost. After converging, every value
/// is the last one written by the only device that changed it, or (both changed it) the one the
/// resolver chose, and both devices and the remote agree byte for byte.

import type { DocMerger } from '@wren-cad/contracts';
import { PARAMS_FILE, toFiles } from '@wren-cad/document';
import { afterEach, describe, expect, it } from 'vitest';
import { docMerger } from '../../src/merge/merge';
import { MemoryProvider } from '../../src/providers/memory';
import { Device, LINK, remoteSnapshot } from '../support/device';
import { makeDoc, paramOf, withParam } from '../support/project';

/** Mulberry32: small, seedable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PARAMS = ['p0', 'p1', 'p2', 'p3', 'p4'];
const FILES = ['imports/a.step', 'imports/b.step', 'notes/c.txt'];
const abs = (p: string) => `${LINK.path}/${p}`;

const devices: Device[] = [];
afterEach(() => {
  for (const d of devices.splice(0)) d.engine.dispose();
});

const totals = { conflicts: 0, races: 0, offline: 0 };

async function scenario(seed: number, merger?: DocMerger) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const remote = new MemoryProvider();
  const doc = makeDoc(Object.fromEntries(PARAMS.map((p) => [p, '0 mm'])));
  for (const [p, b] of toFiles(doc)) remote.put(abs(p), b);
  const opts = merger ? { merger } : {};
  const a = new Device(remote, undefined, opts);
  const b = new Device(remote, undefined, opts);
  devices.push(a, b);
  await a.sync();
  await b.sync();

  /** Value → values that replaced it knowingly (a later edit on a device that had it, or a conflict choice). */
  const supersededBy = new Map<string, Set<string>>();
  /** Values a device deleted knowingly (it had them, and deleted the file or took a deletion). */
  const deleted = new Set<string>();
  const link = (from: string | null, to: string | null) => {
    if (from !== null && to === null) deleted.add(from);
    if (from === null || to === null || from === to) return;
    const s = supersededBy.get(from) ?? new Set<string>();
    s.add(to);
    supersededBy.set(from, s);
  };
  const currentValue = (d: Device, key: string): string | null =>
    key.startsWith('param:')
      ? (paramOf(d.doc(), key.slice(6)) ?? null)
      : (d.store.text(key.slice(5)) ?? null);
  const stats = { conflicts: 0, races: 0, offline: 0 };

  for (let round = 0; round < 3; round += 1) {
    const edits: { key: string; value: string }[] = [];
    const edit = (i: 0 | 1) => {
      const d = i === 0 ? a : b;
      const isParam = r() < 0.6;
      const key = isParam ? `param:${pick(PARAMS)}` : `file:${pick(FILES)}`;
      const before = currentValue(d, key);
      const deleting = !isParam && r() < 0.2;
      const value = deleting
        ? null
        : `${seed}-${round}-${i}-${Math.floor(r() * 1e9)}${isParam ? ' mm' : ''}`;
      if (isParam) d.saveDoc(withParam(d.doc(), key.slice(6), value as string));
      else d.save(key.slice(5), value);
      link(before, value);
      if (value !== null) edits.push({ key, value });
    };
    const steps = 2 + Math.floor(r() * 6);
    for (let s = 0; s < steps; s += 1) {
      const i = r() < 0.5 ? 0 : 1;
      edit(i);
      if (r() < 0.3) {
        const d = i === 0 ? a : b;
        // Sometimes the other device edits and syncs while this push is in flight.
        if (r() < 0.35) {
          const other = i === 0 ? b : a;
          remote.beforeWrite = () => {
            remote.beforeWrite = null;
            stats.races += 1;
            edit(i === 0 ? 1 : 0);
            void other.engine.syncNow();
          };
        }
        if (r() < 0.15) {
          remote.online = false;
          stats.offline += 1;
        }
        await d.engine.syncNow();
        remote.online = true;
        remote.beforeWrite = null;
        await a.engine.idle();
        await b.engine.idle();
      }
    }

    // Converge: sync until quiet, resolving conflicts with random choices.
    for (let pass = 0; pass < 12; pass += 1) {
      let busy = false;
      for (const d of [a, b]) {
        const out = await d.engine.syncNow();
        if (!out.ok) throw new Error(`seed ${seed}: ${out.error.message}`);
        if (out.value.pushed || out.value.pulled) busy = true;
        const merge = out.value.merge;
        if (!merge?.conflicts.length) continue;
        busy = true;
        stats.conflicts += merge.conflicts.length;
        const text = (x: unknown, file: boolean): string | null =>
          x === undefined
            ? null
            : file
              ? new TextDecoder().decode(x as Uint8Array)
              : typeof x === 'string'
                ? x // the real merger reports the conflicting leaf (a parameter's expression)
                : ((x as { expr?: string }).expr ?? null);
        const res = merge.conflicts.map((c) => {
          const file = c.file !== undefined || c.id.startsWith('file:');
          const take = r() < 0.5 ? ('ours' as const) : ('theirs' as const);
          const ours = text(c.ours, file);
          const theirs = text(c.theirs, file);
          // The user knowingly replaced the other side with their choice.
          if (take === 'ours') link(theirs, ours);
          else link(ours, theirs);
          return { conflictId: c.id, take };
        });
        const done = await d.engine.resolve(res);
        if (!done.ok) throw new Error(`seed ${seed}: ${done.error.message}`);
      }
      if (!busy && pass > 0) break;
    }

    // Both agree with each other and the remote, with nothing left queued.
    expect(a.snapshot(), `seed ${seed}`).toEqual(b.snapshot());
    expect(remoteSnapshot(remote.files), `seed ${seed}`).toEqual(a.snapshot());
    expect(a.engine.status(), `seed ${seed}`).toMatchObject({ state: 'idle', pending: 0 });
    expect(b.engine.status(), `seed ${seed}`).toMatchObject({ state: 'idle', pending: 0 });

    // No edit lost: every edit's value is the final one, or was knowingly replaced on the way to it.
    const reachable = (from: string): Set<string> => {
      const seen = new Set([from]);
      const queue = [from];
      while (queue.length) {
        const v = queue.shift() as string;
        for (const n of supersededBy.get(v) ?? []) {
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
      return seen;
    };
    const reaches = (from: string, to: string | null) => to !== null && reachable(from).has(to);
    const wasDeletedKnowingly = (v: string) => [...reachable(v)].some((x) => deleted.has(x));
    for (const e of edits) {
      const final = currentValue(a, e.key);
      // A value may only vanish if a device deleted it (or a successor) knowingly: a deletion
      // supersedes it, even when another device's concurrent edit then wins over the deletion.
      if (wasDeletedKnowingly(e.value)) continue;
      expect(
        reaches(e.value, final),
        `seed ${seed}: ${e.key} = ${e.value} lost (final ${final})`,
      ).toBe(true);
    }
  }
  totals.conflicts += stats.conflicts;
  totals.races += stats.races;
  totals.offline += stats.offline;
  return remote.text(abs(PARAMS_FILE));
}

describe('sync fuzz: concurrent edits on two devices', () => {
  it('never loses an edit over 300 random scenarios', async () => {
    const only = Number(process.env.FUZZ_SEED) || 0;
    for (let seed = only || 1; seed <= (only || Number(process.env.FUZZ_N ?? 300)); seed += 1)
      await scenario(seed);
    if (only) return;
    if (process.env.FUZZ_N) console.log(JSON.stringify(totals));
    // The scenarios really exercised conflicts, push races and offline spells.
    expect(totals.conflicts).toBeGreaterThan(50);
    expect(totals.races).toBeGreaterThan(50);
    expect(totals.offline).toBeGreaterThan(20);
  }, 120_000);

  it('never loses an edit with the real structural merger (DocMerger) over 100 scenarios', async () => {
    const before = { ...totals };
    for (let seed = 1001; seed <= 1100; seed += 1) await scenario(seed, docMerger);
    expect(totals.conflicts - before.conflicts).toBeGreaterThan(10);
  }, 120_000);
});
