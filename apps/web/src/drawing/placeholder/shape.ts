/**
 * PLACEHOLDER drawing kernel, part 1: the shape it loads (ADR-092).
 *
 * The real HLR drawing worker (kernel workstream) reads the BREP in `ShapeForDrawing.brep`. This
 * placeholder cannot: it works from the regen's render meshes (triangles plus the B-rep edge
 * polylines), so `brep` carries those meshes in a tiny binary layout. The same `ShapeForDrawing`
 * type crosses the same `DrawingKernelApi`, so swapping the real worker in changes only
 * `shapeFor` in `source.ts`.
 *
 * Layout (little endian): magic `WRENPH01`, u32 bodies, then per body four u32 counts
 * (position floats, indices, edge-position floats, edge-range words) and the four arrays.
 */

import type { RegenResult, ShapeForDrawing, Vec3 } from '@wren-cad/contracts';

export const PLACEHOLDER_MAGIC = 'WRENPH01';

export interface PlaceholderBody {
  positions: Float32Array;
  indices: Uint32Array;
  edgePositions: Float32Array;
  edgeRanges: Uint32Array;
}

export function encodePlaceholderShape(bodies: readonly PlaceholderBody[]): Uint8Array {
  let size = 8 + 4;
  for (const b of bodies) {
    size +=
      16 +
      4 * (b.positions.length + b.indices.length + b.edgePositions.length + b.edgeRanges.length);
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = PLACEHOLDER_MAGIC.charCodeAt(i);
  dv.setUint32(8, bodies.length, true);
  let o = 12;
  for (const b of bodies) {
    dv.setUint32(o, b.positions.length, true);
    dv.setUint32(o + 4, b.indices.length, true);
    dv.setUint32(o + 8, b.edgePositions.length, true);
    dv.setUint32(o + 12, b.edgeRanges.length, true);
    o += 16;
    for (const a of [b.positions, b.indices, b.edgePositions, b.edgeRanges]) {
      out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
      o += a.byteLength;
    }
  }
  return out;
}

export function decodePlaceholderShape(bytes: Uint8Array): PlaceholderBody[] | null {
  if (bytes.length < 12) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PLACEHOLDER_MAGIC.charCodeAt(i)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(8, true);
  const bodies: PlaceholderBody[] = [];
  let o = 12;
  const take = <T extends Float32Array | Uint32Array>(
    ctor: new (b: ArrayBuffer) => T,
    count: number,
  ): T => {
    // Copy: the view's offset is not guaranteed to be aligned.
    const copy = bytes.slice(o, o + count * 4).buffer as ArrayBuffer;
    o += count * 4;
    return new ctor(copy);
  };
  for (let i = 0; i < n; i++) {
    const np = dv.getUint32(o, true);
    const ni = dv.getUint32(o + 4, true);
    const ne = dv.getUint32(o + 8, true);
    const nr = dv.getUint32(o + 12, true);
    o += 16;
    bodies.push({
      positions: take(Float32Array, np),
      indices: take(Uint32Array, ni),
      edgePositions: take(Float32Array, ne),
      edgeRanges: take(Uint32Array, nr),
    });
  }
  return bodies;
}

/** FNV-1a over the float bits: equal meshes give equal keys. */
function fnv(h: number, v: number): number {
  return Math.imul(h ^ v, 16777619) >>> 0;
}

export function placeholderKey(bodies: readonly PlaceholderBody[]): string {
  let h = 2166136261;
  for (const b of bodies) {
    const f = new Uint32Array(b.positions.buffer, b.positions.byteOffset, b.positions.length);
    for (let i = 0; i < f.length; i += 1) h = fnv(h, f[i] as number);
    for (let i = 0; i < b.indices.length; i += 1) h = fnv(h, b.indices[i] as number);
    h = fnv(h, b.edgePositions.length);
  }
  return `ph-${h.toString(16)}`;
}

/** The placeholder's `ShapeForDrawing` for a regen result (all bodies, one compound). */
export function shapeFromRegen(result: RegenResult): ShapeForDrawing {
  const bodies: PlaceholderBody[] = [];
  const edgeNames: string[] = [];
  const faceNames: string[] = [];
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const b of result.bodies) {
    const m = b.mesh;
    bodies.push({
      positions: m.positions,
      indices: m.indices,
      edgePositions: m.edgePositions,
      edgeRanges: m.edgeRanges,
    });
    edgeNames.push(...m.edgeNames);
    faceNames.push(...m.faceNames);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, m.bbox.min[k] as number);
      max[k] = Math.max(max[k] as number, m.bbox.max[k] as number);
    }
  }
  if (bodies.length === 0) {
    min.fill(0);
    max.fill(0);
  }
  return {
    key: placeholderKey(bodies),
    brep: encodePlaceholderShape(bodies),
    edgeNames,
    faceNames,
    bounds: { min, max },
  };
}
