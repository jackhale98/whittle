/**
 * The feature-result cache (PLAN §4): per part and slot (`'main'` and LRU version slots), the
 * content-addressed cache entries of the latest regens, evicted down to `maxSpare` spare entries
 * (least recently used first out), and the imported attachments by sha256.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, RegenSlot } from '@wren-cad/contracts';
import type { EngineCore } from './core';
import type { PartCache } from './state';

export class ResultCache {
  private readonly core: EngineCore;
  maxSpare: number;
  maxSlots: number;
  /** Per part, per slot (`'main'` and up to `maxSlots` version slots). */
  readonly parts = new Map<Id, Map<RegenSlot, PartCache>>();
  slotTick = 0;

  constructor(core: EngineCore, maxSpare: number, maxSlots: number) {
    this.core = core;
    this.maxSpare = maxSpare;
    this.maxSlots = maxSlots;
  }

  slotCache(partId: Id, slot: RegenSlot): PartCache | undefined {
    return this.parts.get(partId)?.get(slot);
  }

  partCache(id: Id, slot: RegenSlot): PartCache {
    let slots = this.parts.get(id);
    if (!slots) {
      slots = new Map();
      this.parts.set(id, slots);
    }
    let pc = slots.get(slot);
    if (!pc) {
      pc = {
        slot,
        used: 0,
        entries: new Map(),
        revision: 0,
        tick: 0,
        latest: null,
        lastGood: null,
        imports: new Map(),
        lastResolved: new Map(),
        walk: null,
      };
      slots.set(slot, pc);
    }
    pc.used = ++this.slotTick;
    return pc;
  }

  /** Keeps at most `maxSlots` version slots of a part (LRU out; `'main'` is never evicted). */
  async evictSlots(partId: Id): Promise<void> {
    const slots = this.parts.get(partId);
    if (!slots) return;
    const versions = [...slots.values()]
      .filter((pc) => pc.slot !== 'main')
      .sort((x, y) => y.used - x.used);
    for (const pc of versions.slice(this.maxSlots)) await this.releaseSlot(partId, pc);
  }

  async releaseSlot(partId: Id, pc: PartCache): Promise<void> {
    for (const e of pc.entries.values()) await this.core.releaseEntry(e);
    for (const raw of pc.imports.values()) await this.core.releaseRaw(raw);
    pc.entries.clear();
    pc.imports.clear();
    pc.latest = null;
    pc.lastGood = null;
    const slots = this.parts.get(partId);
    slots?.delete(pc.slot);
    if (slots?.size === 0) this.parts.delete(partId);
  }

  /** Keeps imports used by this regen plus the `IMPORT_SPARE` most recently used others. */
  async evictImports(pc: PartCache, used: Set<string>): Promise<void> {
    for (const sha of used) {
      const raw = pc.imports.get(sha);
      if (raw) raw.lastUsed = pc.tick;
    }
    const spare = [...pc.imports.values()]
      .filter((r) => !used.has(r.sha))
      .sort((a, b) => b.lastUsed - a.lastUsed);
    for (const raw of spare.slice(IMPORT_SPARE)) {
      await this.core.releaseRaw(raw);
      pc.imports.delete(raw.sha);
    }
  }

  async evict(pc: PartCache): Promise<void> {
    const keep = new Set<string>([...(pc.latest?.keys ?? []), ...(pc.lastGood?.keys ?? [])]);
    const spare = [...pc.entries.values()]
      .filter((e) => !keep.has(e.key))
      .sort((a, b) => b.lastUsed - a.lastUsed);
    for (const e of spare.slice(this.maxSpare)) {
      await this.core.releaseEntry(e);
      pc.entries.delete(e.key);
    }
  }
}

/** Spare (unused by the latest regen) imported attachments kept per part, LRU. */
const IMPORT_SPARE = 8;

export const DEFAULT_VERSION_SLOTS = 2;

export function validSlots(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** `'main'` or `version:<non-empty id>` (Comlink callers are not type-checked). */
export function isSlot(s: unknown): s is RegenSlot {
  return s === 'main' || (typeof s === 'string' && s.startsWith('version:') && s.length > 8);
}

export function slotLabel(s: RegenSlot): string {
  return s === 'main' ? 'the live model' : `version ${s.slice('version:'.length)}`;
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function validSpare(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}
