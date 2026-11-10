/**
 * Configuration slots (M3.7): `config:<id>` is a valid regen slot with its own LRU budget, so a
 * rebuild-all never evicts the version slots that compare and merge preview use.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import type { EngineCore } from '../../src/regen/core';
import { DEFAULT_CONFIG_SLOTS, isSlot, ResultCache, slotLabel } from '../../src/regen/result-cache';

describe('config slots', () => {
  it('accepts config:<id> and rejects empty ids', () => {
    expect(isSlot('config:abc')).toBe(true);
    expect(isSlot('config:')).toBe(false);
    expect(isSlot('version:a')).toBe(true);
    expect(isSlot('other:a')).toBe(false);
    expect(slotLabel('config:abc')).toBe('configuration abc');
  });

  it('keeps version and configuration slots in separate LRU budgets', async () => {
    const core = {
      releaseEntry: async () => {},
      releaseRaw: async () => {},
    } as unknown as EngineCore;
    const cache = new ResultCache(core, 2, 2);
    for (const s of ['version:a', 'version:b']) cache.partCache('p', s as never);
    for (let i = 0; i < DEFAULT_CONFIG_SLOTS + 3; i++) {
      cache.partCache('p', `config:${i}` as never);
      await cache.evictSlots('p');
    }
    const slots = [...(cache.parts.get('p')?.keys() ?? [])];
    expect(slots.filter((s) => s.startsWith('version:'))).toHaveLength(2);
    expect(slots.filter((s) => s.startsWith('config:'))).toHaveLength(DEFAULT_CONFIG_SLOTS);
  });
});
