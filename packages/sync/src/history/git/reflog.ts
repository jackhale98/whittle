// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reflog entries for what Wren does to a repository (`git reflog` then shows Wren's commits,
 * branch switches and fast-forwards, so a user can always find and restore an earlier state).
 * isomorphic-git writes no reflogs. Only written when the repository keeps them (`logs/` exists,
 * as `git init` makes it for working trees).
 */

import type { PromiseFsClient } from 'isomorphic-git';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export interface ReflogEntry {
  /** `refs/heads/main`, or `HEAD`. */
  ref: string;
  from: string | null;
  to: string;
  who: { name: string; email: string; timestamp: number; timezoneOffset: number };
  /** `commit: Wider`, `checkout: moving from main to idea`, `pull: Fast-forward`. */
  message: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** isomorphic-git's offset is `Date#getTimezoneOffset` (minutes west); git writes `+hhmm` east. */
export function tzString(offsetMinutes: number): string {
  const east = -offsetMinutes;
  const sign = east < 0 ? '-' : '+';
  const abs = Math.abs(east);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

async function exists(fs: PromiseFsClient, path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function mkdirp(fs: PromiseFsClient, dir: string): Promise<void> {
  let current = '';
  for (const part of dir.split('/').filter(Boolean)) {
    current += `/${part}`;
    try {
      await fs.promises.mkdir(current);
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
    }
  }
}

/** Appends entries; never throws (a reflog is a convenience, not part of the commit). */
export async function appendReflog(
  fs: PromiseFsClient,
  gitdir: string,
  entries: readonly ReflogEntry[],
): Promise<void> {
  try {
    if (!(await exists(fs, `${gitdir}/logs`))) return;
    for (const e of entries) {
      const file = `${gitdir}/logs/${e.ref}`;
      const subject = e.message.split('\n')[0]?.trim() ?? '';
      const email = e.who.email.replace(/[<>\n]/g, '');
      const name = e.who.name.replace(/[<>\n]/g, '');
      const line = `${e.from ?? ZERO_OID} ${e.to} ${name} <${email}> ${e.who.timestamp} ${tzString(e.who.timezoneOffset)}\t${subject}\n`;
      let before: Uint8Array = new Uint8Array();
      try {
        before = (await fs.promises.readFile(file)) as Uint8Array;
      } catch {
        await mkdirp(fs, file.slice(0, file.lastIndexOf('/')));
      }
      const add = new TextEncoder().encode(line);
      const out = new Uint8Array(before.length + add.length);
      out.set(before, 0);
      out.set(add, before.length);
      await fs.promises.writeFile(file, out);
    }
  } catch {
    // Best effort.
  }
}
