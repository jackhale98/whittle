// SPDX-License-Identifier: GPL-3.0-or-later
import type { MeshBuffers, MeshExporters } from '@wren-cad/contracts';
import { type ImportLimits, IoError } from './errors';
import { toGlb } from './glb';
import { import3mf } from './import3mf';
import { importGlb } from './importGlb';
import { importObj } from './importObj';
import { importStl } from './stl';
import { to3mf } from './threemf';

/** `MeshExporters` implementation (worker-safe, pure TS). */
export const meshExporters: MeshExporters = {
  to3mf: (bodies, unit) => to3mf(bodies, unit),
  toGlb: (bodies) => toGlb(bodies),
};

export type MeshFormat = 'stl' | 'obj' | '3mf' | 'glb';

/** Detect a mesh format from content (preferred) then file extension. */
export function detectMeshFormat(bytes: Uint8Array, fileName?: string): MeshFormat | undefined {
  if (bytes.byteLength >= 4) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '3mf';
    if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46)
      return 'glb';
  }
  const ext = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'stl' || ext === 'obj') return ext;
  if (bytes.byteLength >= 84) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + n * 50 === bytes.byteLength) return 'stl';
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (/^solid/i.test(head)) return 'stl';
  if (/^(#|v |vn |o |f |mtllib)/m.test(head)) return 'obj';
  return undefined;
}

/** Import any supported reference-mesh file (STL, OBJ, 3MF, GLB) into mm `MeshBuffers` bodies. */
export function importMesh(
  bytes: Uint8Array,
  fileName?: string,
  limits?: Partial<ImportLimits>,
): { name: string; mesh: MeshBuffers }[] {
  const base = fileName?.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  switch (detectMeshFormat(bytes, fileName)) {
    case 'stl':
      return importStl(bytes, { name: base, limits });
    case 'obj':
      return importObj(bytes, { name: base, limits });
    case '3mf':
      return import3mf(bytes, { limits });
    case 'glb':
      return importGlb(bytes, { limits });
    default:
      throw new IoError(
        'unsupported',
        `Unrecognised mesh file${fileName ? ` "${fileName}"` : ''}. Supported: STL, OBJ, 3MF, GLB.`,
      );
  }
}
