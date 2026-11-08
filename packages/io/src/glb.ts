// SPDX-License-Identifier: GPL-3.0-or-later
import { IoError } from './errors';
import { type NamedMesh, parseColor } from './mesh';

/** glTF is in metres; Whittle meshes are in mm. Positions are scaled by this on export. */
export const MM_TO_M = 0.001;

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

interface GltfJson {
  asset: { version: string; generator: string };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: { name: string; mesh: number }[];
  meshes: {
    name: string;
    primitives: {
      attributes: Record<string, number>;
      indices: number;
      material: number;
      mode: number;
    }[];
  }[];
  materials: {
    name: string;
    pbrMetallicRoughness: {
      baseColorFactor: number[];
      metallicFactor: number;
      roughnessFactor: number;
    };
  }[];
  accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number; target: number }[];
  buffers: { byteLength: number }[];
}

/**
 * glTF 2.0 binary. One node + mesh (single triangle primitive) per body. **Units:** glTF is
 * metres, so POSITION data is pre-scaled by 0.001 (mm to m) rather than putting a scale on a
 * root node; viewers that ignore node scale therefore still show the right size. Normals are
 * unit vectors and are unchanged. Bodies without triangles are omitted.
 */
export function toGlb(bodies: NamedMesh[]): Uint8Array {
  const live = bodies.filter((b) => b.mesh.indices.length >= 3 && b.mesh.positions.length >= 9);
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'Whittle' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const addView = (data: Uint8Array, target: number): number => {
    const pad = (4 - (data.byteLength % 4)) % 4;
    const view = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    chunks.push(data);
    if (pad) chunks.push(new Uint8Array(pad));
    offset += data.byteLength + pad;
    return view;
  };

  live.forEach((body, i) => {
    const { positions, normals, indices } = body.mesh;
    const nv = Math.floor(positions.length / 3);
    const scaled = new Float32Array(nv * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < nv * 3; k++) {
      const x = Math.fround((positions[k] as number) * MM_TO_M);
      scaled[k] = x;
      const a = k % 3;
      if (x < (min[a] as number)) min[a] = x;
      if (x > (max[a] as number)) max[a] = x;
    }
    const nrm = normals.length >= nv * 3 ? normals.subarray(0, nv * 3) : new Float32Array(nv * 3);
    const idx = Uint32Array.from(indices.subarray(0, indices.length - (indices.length % 3)));
    for (const v of idx) {
      if (v >= nv)
        throw new IoError('malformed', `Body "${body.name}" references a missing vertex`);
    }
    const posAcc = json.accessors.length;
    json.accessors.push({
      bufferView: addView(bytesOf(scaled), ARRAY_BUFFER),
      componentType: FLOAT,
      count: nv,
      type: 'VEC3',
      min,
      max,
    });
    const nrmAcc = json.accessors.length;
    json.accessors.push({
      bufferView: addView(bytesOf(nrm), ARRAY_BUFFER),
      componentType: FLOAT,
      count: nv,
      type: 'VEC3',
    });
    const idxAcc = json.accessors.length;
    json.accessors.push({
      bufferView: addView(bytesOf(idx), ELEMENT_ARRAY_BUFFER),
      componentType: UINT,
      count: idx.length,
      type: 'SCALAR',
      min: [idx.reduce((m, v) => Math.min(m, v), idx[0] as number)],
      max: [idx.reduce((m, v) => Math.max(m, v), 0)],
    });
    const rgb = parseColor(body.color) ?? [180, 184, 190];
    const name = body.name || `Body ${i + 1}`;
    json.materials.push({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [
          round6(srgbToLinear(rgb[0])),
          round6(srgbToLinear(rgb[1])),
          round6(srgbToLinear(rgb[2])),
          1,
        ],
        metallicFactor: 0,
        roughnessFactor: 0.6,
      },
    });
    json.meshes.push({
      name,
      primitives: [
        {
          attributes: { POSITION: posAcc, NORMAL: nrmAcc },
          indices: idxAcc,
          material: i,
          mode: 4,
        },
      ],
    });
    json.nodes.push({ name, mesh: i });
    json.scenes[0]?.nodes.push(i);
  });
  json.buffers[0] = { byteLength: offset };

  // Drop empty arrays glTF forbids (empty `nodes`, `meshes`, ... must be omitted).
  const doc: Record<string, unknown> = { ...json };
  for (const k of ['nodes', 'meshes', 'materials', 'accessors', 'bufferViews'] as const) {
    if ((doc[k] as unknown[]).length === 0) delete doc[k];
  }
  if (offset === 0) delete doc.buffers;

  let jsonBytes = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.byteLength + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const hasBin = offset > 0;
  const total = 12 + 8 + jsonBytes.byteLength + (hasBin ? 8 + offset : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  if (hasBin) {
    let p = 20 + jsonBytes.byteLength;
    dv.setUint32(p, offset, true);
    dv.setUint32(p + 4, CHUNK_BIN, true);
    p += 8;
    for (const c of chunks) {
      out.set(c, p);
      p += c.byteLength;
    }
    // Remaining pad bytes are already zero.
  }
  return out;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function bytesOf(a: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}
