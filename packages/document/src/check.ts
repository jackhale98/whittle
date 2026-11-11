// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Small structural-validation toolkit shared by `validateDoc` (annotations, drawings) and the
 * command compilers. A `Checker` collects human-readable problems with their paths; it never
 * throws on malformed input.
 */

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class Checker {
  readonly errs: string[] = [];

  /** `onId` registers an id in the document-wide id space (see `validateDoc`). */
  constructor(readonly onId?: (v: unknown, path: string) => void) {}

  err(message: string): void {
    this.errs.push(message);
  }

  id(v: unknown, path: string): void {
    if (this.onId) this.onId(v, path);
    else if (typeof v !== 'string' || v === '') this.err(`${path} must be a non-empty string`);
  }

  obj(v: unknown, path: string): v is Obj {
    if (isObj(v)) return true;
    this.err(`${path} must be an object`);
    return false;
  }

  arr(v: unknown, path: string): v is unknown[] {
    if (Array.isArray(v)) return true;
    this.err(`${path} must be an array`);
    return false;
  }

  str(v: unknown, path: string): v is string {
    if (typeof v === 'string') return true;
    this.err(`${path} must be a string`);
    return false;
  }

  nonEmpty(v: unknown, path: string): v is string {
    if (!this.str(v, path)) return false;
    if (v === '') {
      this.err(`${path} must not be empty`);
      return false;
    }
    return true;
  }

  bool(v: unknown, path: string): v is boolean {
    if (typeof v === 'boolean') return true;
    this.err(`${path} must be true or false`);
    return false;
  }

  num(
    v: unknown,
    path: string,
    opts: { min?: number; exclusiveMin?: number; max?: number; int?: boolean } = {},
  ): v is number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.err(`${path} must be a finite number`);
      return false;
    }
    if (opts.int && !Number.isInteger(v)) {
      this.err(`${path} must be an integer`);
      return false;
    }
    if (opts.min !== undefined && v < opts.min) {
      this.err(`${path} must be at least ${opts.min}`);
      return false;
    }
    if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) {
      this.err(`${path} must be greater than ${opts.exclusiveMin}`);
      return false;
    }
    if (opts.max !== undefined && v > opts.max) {
      this.err(`${path} must be at most ${opts.max}`);
      return false;
    }
    return true;
  }

  oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): v is T {
    if ((allowed as readonly unknown[]).includes(v)) return true;
    this.err(`${path} must be one of ${allowed.join(', ')}`);
    return false;
  }

  vec2(v: unknown, path: string): boolean {
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return true;
    }
    this.err(`${path} must be two finite numbers`);
    return false;
  }

  vec3(v: unknown, path: string): boolean {
    if (
      Array.isArray(v) &&
      v.length === 3 &&
      v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return true;
    }
    this.err(`${path} must be three finite numbers`);
    return false;
  }

  /** A JSON pointer string starting with `/`. */
  pointer(v: unknown, path: string): v is string {
    if (!this.str(v, path)) return false;
    if (!v.startsWith('/') || v.length < 2) {
      this.err(`${path} must be a JSON pointer starting with ‘/’`);
      return false;
    }
    return true;
  }
}

/** Code-unit comparison (the order `canonicalJson` sorts keys in), so sorts never depend on locale. */
export const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function sortedById<T extends { id: string }>(list: readonly T[]): T[] {
  return list.slice().sort(byId);
}

export function isSortedById(list: readonly { id: string }[]): boolean {
  for (let i = 1; i < list.length; i++) {
    if ((list[i - 1] as { id: string }).id > (list[i] as { id: string }).id) return false;
  }
  return true;
}
