/**
 * `@wren-cad/drawing/zip`: several export files as one .zip (every sheet of a drawing as SVG or
 * DXF, ADR-094). fflate is already the PDF writer's deflate; the archive is deterministic (fixed
 * timestamps, the given order) so an export of an unchanged drawing is byte for byte the same.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Zippable, zipSync } from 'fflate';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** DOS time can't go before 1980; a fixed stamp keeps the archive reproducible. */
const STAMP = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

/** The entries as one zip archive. Names must be unique; a repeat gets `-2`, `-3`… */
export function zipFiles(entries: readonly ZipEntry[]): Uint8Array {
  const files: Zippable = {};
  const seen = new Map<string, number>();
  for (const e of entries) {
    let name = e.name;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
    }
    files[name] = [e.bytes, { mtime: STAMP }];
  }
  return zipSync(files, { level: 6, mtime: STAMP });
}
