/**
 * Least-recently-used map bounded by entry count and by total bytes: the drawing worker's loaded
 * shapes (`DrawingKernelApi.loadShape` keeps "an LRU of shapes"). The newest entry always stays,
 * even when it alone exceeds the byte budget.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface LruLimits {
  maxEntries: number;
  maxBytes: number;
}

export class Lru<V> {
  private readonly map = new Map<string, { value: V; bytes: number }>();
  private total = 0;

  constructor(private readonly limits: LruLimits) {
    if (!(limits.maxEntries >= 1)) throw new Error('Lru: maxEntries must be at least 1');
  }

  /** The value, marked as most recently used. */
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Inserts (or replaces) `key` as most recently used; returns the evicted values, oldest first. */
  set(key: string, value: V, bytes: number): V[] {
    const evicted: V[] = [];
    const old = this.map.get(key);
    if (old !== undefined) {
      this.map.delete(key);
      this.total -= old.bytes;
      if (old.value !== value) evicted.push(old.value);
    }
    this.map.set(key, { value, bytes });
    this.total += bytes;
    while (
      this.map.size > 1 &&
      (this.map.size > this.limits.maxEntries || this.total > this.limits.maxBytes)
    ) {
      const oldest = this.map.keys().next().value as string;
      const e = this.map.get(oldest);
      this.map.delete(oldest);
      if (e !== undefined) {
        this.total -= e.bytes;
        evicted.push(e.value);
      }
    }
    return evicted;
  }

  delete(key: string): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.total -= e.bytes;
    return e.value;
  }

  /** Removes everything; returns the values. */
  clear(): V[] {
    const values = [...this.map.values()].map((e) => e.value);
    this.map.clear();
    this.total = 0;
    return values;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}
