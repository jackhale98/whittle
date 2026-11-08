/**
 * Mesh cache in the project's `.whittle/` folder (PLAN §4 "meshes are cached in the .whittle file
 * so a document opens and renders before the kernel has loaded", §10 "open a cached document
 * ≤ 500 ms").
 *
 * Layout (paths relative to `.whittle/`, never synced or committed, always regenerable):
 *   meshes/index.json      { version, key, bodies: [{ id, file }], sketches: [...] }
 *   meshes/<bodyId>.bin    one body's fine `MeshBuffers`, compact binary (below)
 *
 * `key` identifies the document content the meshes were computed for (`docKey`): a cache whose
 * key differs from the opened document's is ignored (it is stale), never shown.
 *
 * Body file: "WMB1" · u32 headerBytes · UTF-8 JSON header (padded to 4 bytes) · the typed arrays
 * back to back in header order (`arrays[].type`, `arrays[].length` elements, little endian).
 */

import type { MeshBuffers, ProjectFiles, SketchResult, Vec3, WhittleDoc } from '@whittle/contracts';
import { canonicalJson } from '@whittle/document';

export const MESH_INDEX = 'meshes/index.json';
const MAGIC = 0x31424d57; // "WMB1" little endian
const VERSION = 1;

/** FNV-1a over UTF-16 code units with two seeds → 16 hex chars (not cryptographic). */
function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Content key of a document's geometry inputs (units, params, parts; not names/timestamps of meta). */
export function docKey(doc: WhittleDoc): string {
  return hash64(
    canonicalJson({
      schemaVersion: doc.schemaVersion,
      units: doc.units,
      params: doc.params,
      parts: doc.parts,
    }),
  );
}

type ArrayKey =
  | 'positions'
  | 'normals'
  | 'indices'
  | 'faceRanges'
  | 'edgePositions'
  | 'edgeRanges'
  | 'vertexPositions';
const ARRAYS: readonly { key: ArrayKey; type: 'f32' | 'u32' }[] = [
  { key: 'positions', type: 'f32' },
  { key: 'normals', type: 'f32' },
  { key: 'indices', type: 'u32' },
  { key: 'faceRanges', type: 'u32' },
  { key: 'edgePositions', type: 'f32' },
  { key: 'edgeRanges', type: 'u32' },
  { key: 'vertexPositions', type: 'f32' },
];

interface BodyHeader {
  faceNames: string[];
  edgeNames: string[];
  bbox: { min: Vec3; max: Vec3 };
  arrays: { key: ArrayKey; type: 'f32' | 'u32'; length: number }[];
}

export function encodeMesh(mesh: MeshBuffers): Uint8Array {
  const arrays = ARRAYS.flatMap(({ key, type }) => {
    const a = mesh[key];
    return a ? [{ key, type, length: a.length }] : [];
  });
  const header: BodyHeader = {
    faceNames: mesh.faceNames,
    edgeNames: mesh.edgeNames,
    bbox: mesh.bbox,
    arrays,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - (json.byteLength % 4)) % 4;
  const headerBytes = json.byteLength + pad;
  const dataBytes = arrays.reduce((n, a) => n + a.length * 4, 0);
  const out = new Uint8Array(8 + headerBytes + dataBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, headerBytes, true);
  out.set(json, 8);
  out.fill(0x20, 8 + json.byteLength, 8 + headerBytes); // JSON-safe padding (spaces)
  let at = 8 + headerBytes;
  for (const a of arrays) {
    const src = mesh[a.key] as Float32Array | Uint32Array;
    out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), at);
    at += src.byteLength;
  }
  return out;
}

export function decodeMesh(bytes: Uint8Array): MeshBuffers {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || view.getUint32(0, true) !== MAGIC)
    throw new Error('not a Whittle mesh cache file');
  const headerBytes = view.getUint32(4, true);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerBytes)),
  ) as BodyHeader;
  // Copy into a fresh, aligned buffer (zip entries are not 4-byte aligned).
  const data = bytes.slice(8 + headerBytes);
  const out: Partial<Record<ArrayKey, Float32Array | Uint32Array>> = {};
  let at = 0;
  for (const a of header.arrays) {
    const n = a.length;
    if (at + n * 4 > data.byteLength) throw new Error('truncated mesh cache file');
    out[a.key] =
      a.type === 'f32' ? new Float32Array(data.buffer, at, n) : new Uint32Array(data.buffer, at, n);
    at += n * 4;
  }
  const f32 = (k: ArrayKey) => (out[k] as Float32Array | undefined) ?? new Float32Array(0);
  const u32 = (k: ArrayKey) => (out[k] as Uint32Array | undefined) ?? new Uint32Array(0);
  return {
    positions: f32('positions'),
    normals: f32('normals'),
    indices: u32('indices'),
    faceRanges: u32('faceRanges'),
    edgePositions: f32('edgePositions'),
    edgeRanges: u32('edgeRanges'),
    ...(out.vertexPositions ? { vertexPositions: out.vertexPositions as Float32Array } : {}),
    faceNames: header.faceNames,
    edgeNames: header.edgeNames,
    bbox: header.bbox,
  };
}

/** Sketch overlays as plain JSON (polylines are small; regions are not needed before the kernel). */
interface SketchRecord {
  featureId: string;
  curves: { entity: string; points: number[]; construction: boolean }[];
  points?: { entity: string; at: Vec3; construction: boolean }[];
  frame: SketchResult['frame'];
}

interface MeshIndex {
  version: number;
  key: string;
  bodies: { id: string; file: string }[];
  sketches: SketchRecord[];
}

export interface CachedGeometry {
  key: string;
  bodies: { id: string; mesh: MeshBuffers }[];
  sketches: SketchResult[];
}

const fileFor = (id: string) => `meshes/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.bin`;

/** Cache files for the fine meshes of one regen result. */
export function encodeCache(geometry: CachedGeometry): ProjectFiles {
  const files: ProjectFiles = new Map();
  const index: MeshIndex = {
    version: VERSION,
    key: geometry.key,
    bodies: geometry.bodies.map((b) => ({ id: b.id, file: fileFor(b.id) })),
    sketches: geometry.sketches.map((s) => ({
      featureId: s.featureId,
      curves: s.curves.map((c) => ({
        entity: c.entity,
        points: Array.from(c.points, (v) => Math.round(v * 1e4) / 1e4),
        construction: c.construction,
      })),
      ...(s.points ? { points: s.points } : {}),
      frame: s.frame,
    })),
  };
  for (const b of geometry.bodies) files.set(fileFor(b.id), encodeMesh(b.mesh));
  files.set(MESH_INDEX, new TextEncoder().encode(`${JSON.stringify(index)}\n`));
  return files;
}

/** Cached geometry for `key`, or null when the cache is absent, stale or unreadable. */
export function decodeCache(cache: ProjectFiles, key: string): CachedGeometry | null {
  const raw = cache.get(MESH_INDEX);
  if (!raw) return null;
  try {
    const index = JSON.parse(new TextDecoder().decode(raw)) as MeshIndex;
    if (index.version !== VERSION || index.key !== key) return null;
    const bodies = index.bodies.map((b) => {
      const bytes = cache.get(b.file);
      if (!bytes) throw new Error(`missing ${b.file}`);
      return { id: b.id, mesh: decodeMesh(bytes) };
    });
    const sketches: SketchResult[] = index.sketches.map((s) => ({
      featureId: s.featureId,
      curves: s.curves.map((c) => ({
        entity: c.entity,
        points: new Float32Array(c.points),
        construction: c.construction,
      })),
      ...(s.points ? { points: s.points } : {}),
      regions: [],
      frame: s.frame,
    }));
    return { key, bodies, sketches };
  } catch {
    return null;
  }
}

/** The cache without the mesh files (replacing them). */
export function withoutMeshes(cache: ProjectFiles): ProjectFiles {
  const out: ProjectFiles = new Map();
  for (const [k, v] of cache) if (!k.startsWith('meshes/')) out.set(k, v);
  return out;
}
