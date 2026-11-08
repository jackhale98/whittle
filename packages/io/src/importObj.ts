// SPDX-License-Identifier: GPL-3.0-or-later
import type { MeshBuffers } from '@whittle/contracts';
import { checkSize, checkTriangles, type ImportLimits, IoError, resolveLimits } from './errors';
import { meshFromSoup } from './mesh';

interface Group {
  name: string;
  soup: number[];
  nrm: number[];
  allNormals: boolean;
}

/**
 * Wavefront OBJ (v / vn / f, polygons fan-triangulated, negative indices). Units are taken as mm.
 * One body per `o` statement (or a single body when there are none); `g` groups are merged.
 */
export function importObj(
  input: Uint8Array | string,
  options: { name?: string; limits?: Partial<ImportLimits> } = {},
): { name: string; mesh: MeshBuffers }[] {
  const limits = resolveLimits(options.limits);
  if (typeof input !== 'string') checkSize(input, limits, 'OBJ file');
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const v: number[] = [];
  const vn: number[] = [];
  const groups: Group[] = [];
  const newGroup = (name: string): Group => {
    const g: Group = { name, soup: [], nrm: [], allNormals: true };
    groups.push(g);
    return g;
  };
  let cur: Group | undefined;
  let tris = 0;
  const maxVerts = limits.maxTriangles * 3;

  const resolve = (tok: string, count: number, what: string): number => {
    const n = Number.parseInt(tok, 10);
    if (!Number.isFinite(n) || n === 0)
      throw new IoError('malformed', `OBJ has an invalid ${what} index "${tok}".`);
    const i = n > 0 ? n - 1 : count + n;
    if (i < 0 || i >= count)
      throw new IoError('malformed', `OBJ ${what} index ${n} is out of range.`);
    return i;
  };

  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    if (line.length === 0 || line.charCodeAt(0) === 35 /* # */) continue;
    const sp = line.search(/\s/);
    const kw = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    switch (kw) {
      case 'v': {
        const p = rest.split(/\s+/);
        const x = Number(p[0]);
        const y = Number(p[1]);
        const z = Number(p[2]);
        if (!Number.isFinite(x + y + z))
          throw new IoError('malformed', 'OBJ has an invalid vertex line.');
        v.push(x, y, z);
        if (v.length / 3 > maxVerts) throw new IoError('too-large', 'OBJ has too many vertices.');
        break;
      }
      case 'vn': {
        const p = rest.split(/\s+/);
        vn.push(Number(p[0]), Number(p[1]), Number(p[2]));
        break;
      }
      case 'o':
        cur = newGroup(rest || `OBJ body ${groups.length + 1}`);
        break;
      case 'f': {
        const refs = rest.split(/\s+/);
        if (refs.length < 3)
          throw new IoError('malformed', 'OBJ face has fewer than three vertices.');
        cur ??= newGroup(options.name ?? 'OBJ body');
        const corner = refs.map((r) => {
          const parts = r.split('/');
          const vi = resolve(parts[0] as string, v.length / 3, 'vertex');
          const ni = parts[2] ? resolve(parts[2], vn.length / 3, 'normal') : -1;
          return [vi, ni] as const;
        });
        tris += corner.length - 2;
        if (tris > limits.maxTriangles) checkTriangles(tris, limits, 'OBJ file');
        for (let k = 1; k + 1 < corner.length; k++) {
          for (const c of [corner[0], corner[k], corner[k + 1]] as const) {
            const [vi, ni] = c as readonly [number, number];
            cur.soup.push(v[vi * 3] as number, v[vi * 3 + 1] as number, v[vi * 3 + 2] as number);
            if (ni >= 0)
              cur.nrm.push(
                vn[ni * 3] as number,
                vn[ni * 3 + 1] as number,
                vn[ni * 3 + 2] as number,
              );
            else cur.allNormals = false;
          }
        }
        break;
      }
      default:
        break; // vt, g, s, usemtl, mtllib, l, p ... ignored
    }
  }
  const bodies = groups
    .filter((g) => g.soup.length > 0)
    .map((g) => ({
      name: g.name,
      mesh: meshFromSoup(
        Float32Array.from(g.soup),
        g.name,
        g.allNormals && g.nrm.length === g.soup.length ? Float32Array.from(g.nrm) : undefined,
      ),
    }));
  if (bodies.length === 0) throw new IoError('empty', 'The OBJ file contains no faces.');
  return bodies;
}
