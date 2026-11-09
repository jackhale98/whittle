/**
 * Import (PLAN §2.5): a CAD or mesh file becomes an `ImportFeature`. Its bytes are an attachment
 * of the project at `imports/<featureId>.<ext>` (never inline in the JSON), identified by sha256.
 */

import type { ImportFeature, Part } from '@wren-cad/contracts';
import { ulid } from '@wren-cad/document';

export type ImportFormat = ImportFeature['source']['format'];

const BY_EXT: Record<string, ImportFormat> = {
  step: 'step',
  stp: 'step',
  iges: 'iges',
  igs: 'iges',
  brep: 'brep',
  brp: 'brep',
  stl: 'stl',
  obj: 'obj',
  '3mf': '3mf',
  glb: 'glb',
};

/**
 * File extensions the Open/Import pickers offer (besides `.wrencad`): every format the engine
 * reads, IGES included since M3 (the kernel's IGES reader sews surface models into solids).
 */
export const IMPORT_EXTENSIONS = Object.keys(BY_EXT).map((e) => `.${e}`);

/** The import format of a file name, or null for anything else. */
export function importFormat(fileName: string): ImportFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase();
  return ext ? (BY_EXT[ext] ?? null) : null;
}

/** Lowercase hex sha256 (WebCrypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "bracket.step" → "bracket"; a unique feature name within the part. */
export function importName(part: Pick<Part, 'features'>, fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '').trim() || 'Import';
  const taken = new Set(part.features.map((f) => f.name));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
}

/** A new import feature for a file, and the attachment path its bytes go to. */
export async function importFeature(
  part: Pick<Part, 'features'>,
  fileName: string,
  bytes: Uint8Array,
): Promise<{ feature: ImportFeature; path: string } | null> {
  const format = importFormat(fileName);
  if (!format) return null;
  const id = ulid();
  const path = `imports/${id}.${format}`;
  const feature: ImportFeature = {
    id,
    type: 'import',
    name: importName(part, fileName),
    suppressed: false,
    source: { path, format, sha256: await sha256Hex(bytes), fileName },
    op: 'new',
  };
  return { feature, path };
}
