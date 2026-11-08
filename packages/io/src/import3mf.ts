// SPDX-License-Identifier: GPL-3.0-or-later
import type { MeshBuffers } from '@whittle/contracts';
import { unzipSync } from 'fflate';
import { checkSize, checkTriangles, type ImportLimits, IoError, resolveLimits } from './errors';
import { meshFromSoup } from './mesh';
import { scanXml } from './xml';

type Mat = number[]; // 12 numbers m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (row-vector convention)
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface ObjectDef {
  id: string;
  name: string;
  type: string;
  /** Flat xyz, in the object's local frame. */
  vertices: number[];
  triangles: number[];
  components: { objectid: string; path?: string; transform: Mat }[];
}

interface ModelFile {
  unitScale: number;
  objects: Map<string, ObjectDef>;
  build: { objectid: string; transform: Mat }[];
}

const UNIT_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

function parseMat(s: string | undefined): Mat {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some((v) => !Number.isFinite(v))) return IDENTITY;
  return n;
}

/** a then b (row-vector convention: p' = p·A·B). */
function mul(a: Mat, b: Mat): Mat {
  const r = new Array<number>(12).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        (a[i * 3] as number) * (b[j] as number) +
        (a[i * 3 + 1] as number) * (b[3 + j] as number) +
        (a[i * 3 + 2] as number) * (b[6 + j] as number);
    }
  }
  for (let j = 0; j < 3; j++) {
    r[9 + j] =
      (a[9] as number) * (b[j] as number) +
      (a[10] as number) * (b[3 + j] as number) +
      (a[11] as number) * (b[6 + j] as number) +
      (b[9 + j] as number);
  }
  return r;
}

function parseModel(xml: string, limits: ImportLimits): ModelFile {
  const objects = new Map<string, ObjectDef>();
  const build: ModelFile['build'] = [];
  let unitScale = 1;
  let cur: ObjectDef | undefined;
  let triCount = 0;
  scanXml(xml, {
    open(name, a) {
      switch (name) {
        case 'model':
          unitScale = UNIT_MM[(a.unit ?? 'millimeter').toLowerCase()] ?? 1;
          break;
        case 'object':
          cur = {
            id: a.id ?? '',
            name: a.name ?? '',
            type: a.type ?? 'model',
            vertices: [],
            triangles: [],
            components: [],
          };
          objects.set(cur.id, cur);
          break;
        case 'vertex':
          if (cur) cur.vertices.push(Number(a.x), Number(a.y), Number(a.z));
          break;
        case 'triangle':
          if (cur) {
            cur.triangles.push(Number(a.v1), Number(a.v2), Number(a.v3));
            if (++triCount > limits.maxTriangles) checkTriangles(triCount, limits, '3MF file');
          }
          break;
        case 'component':
          cur?.components.push({
            objectid: a.objectid ?? '',
            path: a.path,
            transform: parseMat(a.transform),
          });
          break;
        case 'item':
          build.push({ objectid: a.objectid ?? '', transform: parseMat(a.transform) });
          break;
      }
    },
    close(name) {
      if (name === 'object') cur = undefined;
    },
  });
  return { unitScale, objects, build };
}

function findModelPath(files: Record<string, Uint8Array>): string {
  const rels = files['_rels/.rels'];
  if (rels) {
    let target: string | undefined;
    scanXml(new TextDecoder().decode(rels), {
      open(name, a) {
        if (name === 'Relationship' && a.Type?.endsWith('/3dmodel') && !target) target = a.Target;
      },
      close() {},
    });
    if (target) {
      const p = target.replace(/^\//, '');
      if (files[p]) return p;
    }
  }
  const fallback = Object.keys(files).find((k) => k.toLowerCase() === '3d/3dmodel.model');
  if (fallback) return fallback;
  const any = Object.keys(files).find((k) => k.toLowerCase().endsWith('.model'));
  if (any) return any;
  throw new IoError('malformed', 'The 3MF package has no 3D model part.');
}

/** 3MF to reference bodies: one per build item (components flattened, transforms applied), mm. */
export function import3mf(
  bytes: Uint8Array,
  options: { limits?: Partial<ImportLimits> } = {},
): { name: string; mesh: MeshBuffers }[] {
  const limits = resolveLimits(options.limits);
  checkSize(bytes, limits, '3MF file');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.originalSize > limits.maxBytes) {
          throw new IoError('too-large', `3MF entry "${f.name}" is too large when decompressed.`);
        }
        return !f.name.endsWith('/') && /\.(model|rels)$/i.test(f.name);
      },
    });
  } catch (e) {
    if (e instanceof IoError) throw e;
    throw new IoError('malformed', 'Not a valid 3MF file: the zip archive could not be read.');
  }
  const mainPath = findModelPath(files);
  const dec = new TextDecoder();
  const models = new Map<string, ModelFile>();
  const load = (path: string): ModelFile => {
    const clean = path.replace(/^\//, '');
    let m = models.get(clean);
    if (!m) {
      const data = files[clean];
      if (!data) throw new IoError('malformed', `3MF references a missing part "${clean}".`);
      m = parseModel(dec.decode(data), limits);
      models.set(clean, m);
    }
    return m;
  };
  const main = load(mainPath);

  const bodies: { name: string; mesh: MeshBuffers }[] = [];
  let total = 0;
  const emit = (name: string, soup: number[]): void => {
    if (soup.length === 0) return;
    total += soup.length / 9;
    checkTriangles(total, limits, '3MF file');
    bodies.push({ name, mesh: meshFromSoup(Float32Array.from(soup), name) });
  };

  const flatten = (
    model: ModelFile,
    modelPath: string,
    obj: ObjectDef,
    xf: Mat,
    out: number[],
    depth: number,
  ): void => {
    if (depth > 16) throw new IoError('malformed', '3MF component nesting is too deep.');
    const nv = obj.vertices.length / 3;
    for (let t = 0; t + 2 < obj.triangles.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = obj.triangles[t + k] as number;
        if (!Number.isInteger(vi) || vi < 0 || vi >= nv) {
          throw new IoError(
            'malformed',
            `3MF object "${obj.name || obj.id}" references vertex ${vi} but has ${nv}.`,
          );
        }
        const x = obj.vertices[vi * 3] as number;
        const y = obj.vertices[vi * 3 + 1] as number;
        const z = obj.vertices[vi * 3 + 2] as number;
        if (!Number.isFinite(x + y + z))
          throw new IoError('malformed', '3MF has a non-numeric vertex coordinate.');
        out.push(
          (x * (xf[0] as number) +
            y * (xf[3] as number) +
            z * (xf[6] as number) +
            (xf[9] as number)) *
            model.unitScale,
          (x * (xf[1] as number) +
            y * (xf[4] as number) +
            z * (xf[7] as number) +
            (xf[10] as number)) *
            model.unitScale,
          (x * (xf[2] as number) +
            y * (xf[5] as number) +
            z * (xf[8] as number) +
            (xf[11] as number)) *
            model.unitScale,
        );
      }
      if (out.length / 9 > limits.maxTriangles) checkTriangles(out.length / 9, limits, '3MF file');
    }
    for (const c of obj.components) {
      const childModel = c.path ? load(c.path) : model;
      const childPath = c.path ?? modelPath;
      const child = childModel.objects.get(c.objectid);
      if (!child)
        throw new IoError('malformed', `3MF component references missing object ${c.objectid}.`);
      // Child geometry is in its own frame; component transform composes before the parent's.
      flatten(childModel, childPath, child, mul(c.transform, xf), out, depth + 1);
    }
  };

  const roots = main.build.length
    ? main.build
    : [...main.objects.values()]
        .filter((o) => o.type === 'model')
        .map((o) => ({ objectid: o.id, transform: IDENTITY }));
  for (const item of roots) {
    const obj = main.objects.get(item.objectid);
    if (!obj)
      throw new IoError('malformed', `3MF build item references missing object ${item.objectid}.`);
    if (obj.type === 'support' || obj.type === 'solidsupport') continue;
    const soup: number[] = [];
    flatten(main, mainPath, obj, item.transform, soup, 0);
    emit(obj.name || `3MF body ${bodies.length + 1}`, soup);
  }
  if (bodies.length === 0) throw new IoError('empty', 'The 3MF file contains no triangles.');
  return bodies;
}
