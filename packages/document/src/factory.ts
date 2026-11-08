// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ULIDs and document/part factories.
 *
 * ULID: a tiny local implementation (≈30 lines) instead of the `ulid` package — no dependency, no
 * module-level PRNG assumptions, works in workers, and monotonic within a millisecond.
 */

import { type Id, type Part, SCHEMA_VERSION, type WhittleDoc } from '@whittle/contracts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const APP_ID = 'whittle/0.0.0';

export function isUlid(s: unknown): s is Id {
  return typeof s === 'string' && ULID_RE.test(s);
}

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** A new 26-character ULID. Strictly increasing across calls within one process. */
export function ulid(now: number = Date.now()): Id {
  let time = Math.max(Math.floor(now), lastTime);
  let digits: number[];
  if (time === lastTime) {
    digits = lastRandom.slice();
    let i = 15;
    while (i >= 0) {
      const d = (digits[i] as number) + 1;
      if (d < 32) {
        digits[i] = d;
        break;
      }
      digits[i] = 0;
      i--;
    }
    if (i < 0) {
      // 80-bit overflow: practically unreachable; move to the next millisecond.
      time += 1;
      digits = randomDigits();
    }
  } else {
    digits = randomDigits();
  }
  lastTime = time;
  lastRandom = digits;
  return encodeTime(time) + digits.map((d) => ALPHABET[d]).join('');
}

export interface NewDocOptions {
  name?: string;
  units?: WhittleDoc['units'];
  /** ISO timestamp for `created`/`modified`; default: now. */
  now?: string;
  app?: string;
  /** Adds one empty part with this name. */
  firstPart?: string;
}

export function newPart(name = 'Part 1', id: Id = ulid()): Part {
  return { id, name, features: [], rollbackIndex: 0 };
}

export function newDoc(options: NewDocOptions = {}): WhittleDoc {
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    units: options.units ?? { length: 'mm', angle: 'deg' },
    params: [],
    parts: options.firstPart !== undefined ? [newPart(options.firstPart)] : [],
    assemblies: [],
    drawings: [],
    meta: {
      name: options.name ?? 'Untitled',
      created: now,
      modified: now,
      app: options.app ?? APP_ID,
    },
  };
}
