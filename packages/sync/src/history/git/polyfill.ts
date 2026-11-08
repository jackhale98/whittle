// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/git/polyfill.ts (same author, GPL-3.0-or-later).
/**
 * isomorphic-git expects Node's `Buffer`; browsers and workers need the polyfill installed before
 * it runs. `git.ts` imports this module first. In Node the global already exists.
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
