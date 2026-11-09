// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The small file store `SnapshotHistory` runs on: the project's local working copy, addressed by
 * project-relative POSIX paths (`.wren-history/versions/<id>.json`). The app backs it with the
 * working copy (OPFS/IndexedDB), which the sync engine uploads like any other project file, so
 * history travels with the project. Tests use `MemoryHistoryFiles`.
 */

import { sameBytes } from './hash';

export interface HistoryFiles {
  /** The file's bytes, or `null` when it doesn't exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Creates or replaces the file (parent folders are implicit). */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Every file path under `prefix` (recursive, any order). `prefix` ends with `/`. */
  list(prefix: string): Promise<string[]>;
  /** Missing files are fine. */
  remove(path: string): Promise<void>;
}

export class MemoryHistoryFiles implements HistoryFiles {
  readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    const b = this.files.get(path);
    return b === undefined ? null : b.slice();
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  /**
   * What a file sync of two working copies does with append-only history: the union of both
   * sides' files, minus what one side removed and the other never changed. For tests of two
   * devices editing offline.
   */
  static syncUnion(
    a: MemoryHistoryFiles,
    b: MemoryHistoryFiles,
    base: ReadonlyMap<string, Uint8Array>,
  ): void {
    const paths = new Set([...a.files.keys(), ...b.files.keys(), ...base.keys()]);
    for (const p of paths) {
      const [x, y, o] = [a.files.get(p), b.files.get(p), base.get(p)];
      // A removal wins over the other side only if that side left the file as it was.
      const v =
        o !== undefined && x === undefined
          ? sameBytes(y, o)
            ? undefined
            : y
          : o !== undefined && y === undefined
            ? sameBytes(x, o)
              ? undefined
              : x
            : (x ?? y);
      for (const side of [a, b]) {
        if (v === undefined) side.files.delete(p);
        else side.files.set(p, v);
      }
    }
  }
}
