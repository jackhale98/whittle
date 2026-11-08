/**
 * Cache keys: a compact canonical JSON (sorted keys, `undefined` dropped) hashed with two
 * independently seeded 53-bit cyrb53 lanes (≈106 bits; collisions are not a practical concern for
 * a per-part cache of a few hundred entries).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Deterministic JSON: object keys sorted, `undefined` members dropped, `-0` written as `0`. */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value === 0 ? 0 : value) : 'null';
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
    }
    default:
      return 'null';
  }
}

function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 28-hex-character content hash of `value`'s canonical JSON. */
export function hashKey(value: unknown): string {
  const s = stableStringify(value);
  return (
    cyrb53(s, 0x9e3779b9).toString(16).padStart(14, '0') +
    cyrb53(s, 0x85ebca6b).toString(16).padStart(14, '0')
  );
}
