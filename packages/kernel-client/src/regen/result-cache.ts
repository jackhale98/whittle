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
import type { RegenMemoryStats, RegenSlotStats } from './types';

export class ResultCache {
  private readonly core: EngineCore;
  /**
   * Spare entries kept per slot. Configured (device tiers, `configureRegen`): a hard bound.
   * Default (`auto`): at least `DEFAULT_SPARE_RESULTS`, and enough for `AUTO_SPARE_STATES` earlier
   * full states of the part (ADR-084), while the Wasm heap is under `AUTO_SPARE_HEAP_BYTES`.
   */
  maxSpare: number;
  /** `maxSpare` was not configured: scale it with the part (see `spareFor`). */
  auto: boolean;
  maxSlots: number;
  /** Per part, per slot (`'main'` and up to `maxSlots` version slots). */
  readonly parts = new Map<Id, Map<RegenSlot, PartCache>>();
  slotTick = 0;

  constructor(core: EngineCore, maxSpare: number | undefined, maxSlots: number) {
    this.core = core;
    this.maxSpare = maxSpare ?? DEFAULT_SPARE_RESULTS;
    this.auto = maxSpare === undefined;
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
        absorbed: new Map(),
        walk: null,
        annotations: new Map(),
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
    // Version slots (compare, merge preview) and configuration slots (M3.7 background builds) have
    // separate LRU budgets, so a rebuild-all never pushes out a compare in progress.
    const kind = (pc: PartCache) => (pc.slot.startsWith('config:') ? 'config' : 'version');
    const others = [...slots.values()]
      .filter((pc) => pc.slot !== 'main')
      .sort((x, y) => y.used - x.used);
    for (const pc of others.filter((p) => kind(p) === 'version').slice(this.maxSlots)) {
      await this.releaseSlot(partId, pc);
    }
    for (const pc of others.filter((p) => kind(p) === 'config').slice(DEFAULT_CONFIG_SLOTS)) {
      await this.releaseSlot(partId, pc);
    }
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
    for (const e of spare.slice(this.spareFor(pc))) {
      await this.core.releaseEntry(e);
      pc.entries.delete(e.key);
    }
  }

  /**
   * The spare budget of a slot. With the default budget, a 100-feature part whose early feature
   * is edited leaves 100 spare entries per edit, so 128 kept only one earlier state and a second
   * undo was a full regen: the default therefore keeps `AUTO_SPARE_STATES` states of the latest
   * regen's size, unless the Wasm heap has already grown past `AUTO_SPARE_HEAP_BYTES`.
   */
  spareFor(pc: PartCache): number {
    if (!this.auto) return this.maxSpare;
    const heap = this.core.kernel.wasmHeapBytes?.() ?? -1;
    if (heap > AUTO_SPARE_HEAP_BYTES) return this.maxSpare;
    return Math.max(this.maxSpare, AUTO_SPARE_STATES * (pc.latest?.keys.size ?? 0));
  }

  /**
   * Memory guard: entries and handles per part and slot, with the bounds they are evicted to
   * (`RegenMemoryStats` without the per-handle caches).
   */
  memoryStats(): Omit<RegenMemoryStats, 'shapeCaches'> {
    const slots: RegenSlotStats[] = [];
    for (const [partId, bySlot] of this.parts) {
      const ordered = [...bySlot.values()].sort((x, y) =>
        x.slot === 'main' ? -1 : y.slot === 'main' ? 1 : y.used - x.used,
      );
      for (const pc of ordered) {
        let handles = 0;
        for (const e of pc.entries.values()) handles += e.owned.length;
        let importHandles = 0;
        for (const raw of pc.imports.values()) importHandles += raw.shapes.length;
        slots.push({
          partId,
          slot: pc.slot,
          entries: pc.entries.size,
          handles,
          imports: pc.imports.size,
          importHandles,
        });
      }
    }
    // The effective bound (ADR-084): with the automatic budget, the largest slot's.
    let effective = this.maxSpare;
    for (const bySlot of this.parts.values()) {
      for (const pc of bySlot.values()) effective = Math.max(effective, this.spareFor(pc));
    }
    return {
      limits: {
        maxSpareResults: effective,
        maxVersionSlots: this.maxSlots,
        importSpare: IMPORT_SPARE,
      },
      slots,
      entries: slots.reduce((n, s) => n + s.entries, 0),
      handles: slots.reduce((n, s) => n + s.handles, 0),
      ownedHandles: this.core.ownedHandles.size,
    };
  }
}

/** Default spare budget per slot (and the floor of the automatic one). */
export const DEFAULT_SPARE_RESULTS = 128;
/** Earlier full states of a part the default budget keeps (undo depth of early edits). */
export const AUTO_SPARE_STATES = 3;
/** Above this Wasm heap the default budget stops scaling with the part (desktop memory). */
export const AUTO_SPARE_HEAP_BYTES = 1.5 * 2 ** 30;

/** Spare (unused by the latest regen) imported attachments kept per part, LRU. */
const IMPORT_SPARE = 8;

export const DEFAULT_VERSION_SLOTS = 2;
/** Configuration slots kept per part, besides `'main'` (M3.7), their own budget. */
export const DEFAULT_CONFIG_SLOTS = 8;

export function validSlots(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** `'main'`, `version:<id>` or `config:<id>` (non-empty id; Comlink callers are not type-checked). */
export function isSlot(s: unknown): s is RegenSlot {
  return (
    s === 'main' ||
    (typeof s === 'string' &&
      ((s.startsWith('version:') && s.length > 8) || (s.startsWith('config:') && s.length > 7)))
  );
}

export function slotLabel(s: RegenSlot): string {
  if (s === 'main') return 'the live model';
  return s.startsWith('config:')
    ? `configuration ${s.slice('config:'.length)}`
    : `version ${s.slice('version:'.length)}`;
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function validSpare(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}
