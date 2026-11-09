// SPDX-License-Identifier: GPL-3.0-or-later
import type { MeshBuffers } from '@wren-cad/contracts';
import { checkSize, checkTriangles, type ImportLimits, IoError, resolveLimits } from './errors';
import { MM_TO_M } from './glb';
import { meshFromSoup } from './mesh';

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: unknown;
}
interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string;
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes?: {
    name?: string;
    primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[];
  }[];
  accessors?: Accessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}

type M4 = number[]; // column-major 4x4, glTF convention

const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mulM4(a: M4, b: M4): M4 {
  const r = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let rI = 0; rI < 4; rI++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + rI] as number) * (b[c * 4 + k] as number);
      r[c * 4 + rI] = s;
    }
  }
  return r;
}

function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): M4 {
  const [x, y, z, w] = q as [number, number, number, number];
  const n = Math.hypot(x, y, z, w) || 1;
  const qx = x / n;
  const qy = y / n;
  const qz = z / n;
  const qw = w / n;
  const [sx, sy, sz] = s as [number, number, number];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx,
    2 * (qx * qy + qz * qw) * sx,
    2 * (qx * qz - qy * qw) * sx,
    0,
    2 * (qx * qy - qz * qw) * sy,
    (1 - 2 * (qx * qx + qz * qz)) * sy,
    2 * (qy * qz + qx * qw) * sy,
    0,
    2 * (qx * qz + qy * qw) * sz,
    2 * (qy * qz - qx * qw) * sz,
    (1 - 2 * (qx * qx + qy * qy)) * sz,
    0,
    t[0] as number,
    t[1] as number,
    t[2] as number,
    1,
  ];
}

const COMP_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_N: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** GLB (binary glTF 2.0) to reference bodies: one per mesh-bearing node, transforms applied, mm. */
export function importGlb(
  bytes: Uint8Array,
  options: { limits?: Partial<ImportLimits> } = {},
): { name: string; mesh: MeshBuffers }[] {
  const limits = resolveLimits(options.limits);
  checkSize(bytes, limits, 'GLB file');
  if (bytes.byteLength < 20) throw new IoError('malformed', 'Not a valid GLB file: too short.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67)
    throw new IoError('malformed', 'Not a GLB file: bad magic.');
  if (dv.getUint32(4, true) !== 2)
    throw new IoError('unsupported', 'Only glTF 2.0 binary files are supported.');
  const total = Math.min(dv.getUint32(8, true), bytes.byteLength);
  let json: Gltf | undefined;
  let bin: Uint8Array | undefined;
  for (let p = 12; p + 8 <= total; ) {
    const len = dv.getUint32(p, true);
    const type = dv.getUint32(p + 4, true);
    const start = p + 8;
    if (start + len > bytes.byteLength)
      throw new IoError('malformed', 'GLB chunk extends past the end of the file.');
    if (type === 0x4e4f534a && !json) {
      try {
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + len))) as Gltf;
      } catch {
        throw new IoError('malformed', 'GLB JSON chunk is not valid JSON.');
      }
    } else if (type === 0x004e4942 && !bin) {
      bin = bytes.subarray(start, start + len);
    }
    p = start + ((len + 3) & ~3);
  }
  if (!json || typeof json !== 'object') throw new IoError('malformed', 'GLB has no JSON chunk.');
  const g = json;
  if (g.buffers?.some((b, i) => b.uri !== undefined && i === 0)) {
    throw new IoError('unsupported', 'GLB files with external buffers are not supported.');
  }

  const readAccessor = (idx: number): { data: Float64Array; n: number } => {
    const acc = g.accessors?.[idx];
    if (!acc) throw new IoError('malformed', `GLB accessor ${idx} is missing.`);
    if (acc.sparse) throw new IoError('unsupported', 'Sparse accessors are not supported.');
    const comps = TYPE_N[acc.type];
    const csz = COMP_SIZE[acc.componentType];
    if (!comps || !csz) throw new IoError('malformed', 'GLB accessor has an unknown type.');
    if (acc.bufferView === undefined)
      return { data: new Float64Array(acc.count * comps), n: comps };
    const bv = g.bufferViews?.[acc.bufferView];
    if (!bv || !bin)
      throw new IoError('malformed', 'GLB accessor references a missing buffer view.');
    if (acc.count * comps > limits.maxTriangles * 9) checkTriangles(acc.count, limits, 'GLB file');
    const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : comps * csz;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const end = base + (acc.count > 0 ? (acc.count - 1) * stride + comps * csz : 0);
    if (end > bin.byteLength || base < 0)
      throw new IoError('malformed', 'GLB accessor reads past the end of the buffer.');
    const bdv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const out = new Float64Array(acc.count * comps);
    const norm = acc.normalized === true;
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * csz;
        let v: number;
        switch (acc.componentType) {
          case 5126:
            v = bdv.getFloat32(o, true);
            break;
          case 5125:
            v = bdv.getUint32(o, true);
            break;
          case 5123:
            v = bdv.getUint16(o, true);
            if (norm) v /= 65535;
            break;
          case 5122:
            v = bdv.getInt16(o, true);
            if (norm) v = Math.max(v / 32767, -1);
            break;
          case 5121:
            v = bdv.getUint8(o);
            if (norm) v /= 255;
            break;
          default:
            v = bdv.getInt8(o);
            if (norm) v = Math.max(v / 127, -1);
        }
        out[i * comps + c] = v;
      }
    }
    return { data: out, n: comps };
  };

  const nodes = g.nodes ?? [];
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? g.scenes?.[0]?.nodes;
  const bodies: { name: string; mesh: MeshBuffers }[] = [];
  let totalTris = 0;
  const visit = (ni: number, parent: M4, depth: number): void => {
    if (depth > 64) throw new IoError('malformed', 'GLB node hierarchy is too deep.');
    const node = nodes[ni];
    if (!node) throw new IoError('malformed', `GLB node ${ni} is missing.`);
    const local =
      node.matrix && node.matrix.length === 16
        ? node.matrix
        : trs(node.translation, node.rotation, node.scale);
    const world = mulM4(parent, local);
    if (node.mesh !== undefined) emitMesh(node.mesh, node.name, world);
    for (const c of node.children ?? []) visit(c, world, depth + 1);
  };

  const emitMesh = (mi: number, nodeName: string | undefined, m: M4): void => {
    const mesh = g.meshes?.[mi];
    if (!mesh) throw new IoError('malformed', `GLB mesh ${mi} is missing.`);
    const soup: number[] = [];
    const nrm: number[] = [];
    let allNormals = true;
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4) continue; // only triangle lists
      const posIdx = prim.attributes.POSITION;
      if (posIdx === undefined) continue;
      const pos = readAccessor(posIdx);
      if (pos.n !== 3) throw new IoError('malformed', 'GLB POSITION must be VEC3.');
      const nv = pos.data.length / 3;
      const nAcc = prim.attributes.NORMAL;
      const nor = nAcc !== undefined ? readAccessor(nAcc) : undefined;
      if (!nor || nor.data.length !== pos.data.length) allNormals = false;
      let index: ArrayLike<number>;
      if (prim.indices !== undefined) index = readAccessor(prim.indices).data;
      else index = Array.from({ length: nv }, (_, i) => i);
      checkTriangles(totalTris + Math.floor(index.length / 3), limits, 'GLB file');
      for (let t = 0; t + 2 < index.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = index[t + k] as number;
          if (vi >= nv || vi < 0)
            throw new IoError('malformed', 'GLB index references a missing vertex.');
          const x = pos.data[vi * 3] as number;
          const y = pos.data[vi * 3 + 1] as number;
          const z = pos.data[vi * 3 + 2] as number;
          // glTF metres to mm.
          const f = 1 / MM_TO_M;
          soup.push(
            ((m[0] as number) * x +
              (m[4] as number) * y +
              (m[8] as number) * z +
              (m[12] as number)) *
              f,
            ((m[1] as number) * x +
              (m[5] as number) * y +
              (m[9] as number) * z +
              (m[13] as number)) *
              f,
            ((m[2] as number) * x +
              (m[6] as number) * y +
              (m[10] as number) * z +
              (m[14] as number)) *
              f,
          );
          if (nor) {
            const a = nor.data[vi * 3] as number;
            const b = nor.data[vi * 3 + 1] as number;
            const c = nor.data[vi * 3 + 2] as number;
            nrm.push(
              (m[0] as number) * a + (m[4] as number) * b + (m[8] as number) * c,
              (m[1] as number) * a + (m[5] as number) * b + (m[9] as number) * c,
              (m[2] as number) * a + (m[6] as number) * b + (m[10] as number) * c,
            );
          }
        }
      }
      totalTris += Math.floor(index.length / 3);
    }
    if (soup.length === 0) return;
    const name = nodeName || mesh.name || `GLB body ${bodies.length + 1}`;
    bodies.push({
      name,
      mesh: meshFromSoup(
        Float32Array.from(soup),
        name,
        allNormals ? Float32Array.from(nrm) : undefined,
      ),
    });
  };

  if (nodes.length > 0) {
    const starts =
      roots ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i)));
    for (const r of starts) visit(r, I4, 0);
  } else {
    for (let i = 0; i < (g.meshes?.length ?? 0); i++) emitMesh(i, undefined, I4);
  }
  if (bodies.length === 0) throw new IoError('empty', 'The GLB file contains no triangle meshes.');
  return bodies;
}
