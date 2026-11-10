/**
 * Spike S0: CalculiX input deck writer. Linear static, C3D10, one isotropic material, constraints
 * and loads referenced by Wren persistent face names (= mesh physical group names). An unknown name
 * is an error ("needs attention"), never a guess.
 *
 * Units: mm, N, MPa, tonne/mm^3.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { TetMesh } from './mesh-format.ts';

export interface Study {
  material: { name: string; E: number; nu: number; density: number };
  /** Faces fixed in x, y, z. */
  fixed: string[];
  /** Total force (N) spread uniformly by area over the named faces. */
  loads: { faces: string[]; force: [number, number, number] }[];
}

export interface DeckInfo {
  deck: string;
  flippedTets: number;
  fixedNodes: number;
  loadedNodes: number;
}

/** Gmsh tet10 → CalculiX/Abaqus C3D10: the last two mid-side nodes swap. */
const GMSH_TO_CCX = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8];
/** CalculiX C3D10 mid-side node k (4..9) sits on this corner edge. */
const CCX_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
];

type V3 = [number, number, number];
const at = (n: number[], i: number): V3 => [n[3 * i] ?? 0, n[3 * i + 1] ?? 0, n[3 * i + 2] ?? 0];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist2 = (a: V3, b: V3) => dot(sub(a, b), sub(a, b));

/** Checks the node-order conversion geometrically on a sample of elements (throws if wrong). */
function checkOrder(nodes: number[], conn: number[], count: number): void {
  for (let e = 0; e < count; e++) {
    const c = conn.slice(10 * e, 10 * e + 10);
    for (let k = 0; k < 6; k++) {
      const m = at(nodes, c[4 + k] ?? 0);
      const own = CCX_EDGES[k] as [number, number];
      const mid = (p: [number, number]): V3 => {
        const a = at(nodes, c[p[0]] ?? 0);
        const b = at(nodes, c[p[1]] ?? 0);
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      };
      const d = dist2(m, mid(own));
      for (const other of CCX_EDGES) {
        if (other !== own && dist2(m, mid(other)) < d) {
          throw new Error(`tet ${e}: mid-side node ${4 + k} is not on edge ${own.join('-')}`);
        }
      }
    }
  }
}

/** CalculiX reads at most 20 characters per number field: 12 significant digits, exponent form. */
const num = (v: number) => v.toExponential(11);

function lines(ids: number[], perLine = 16): string {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += perLine) out.push(ids.slice(i, i + perLine).join(', '));
  return out.join('\n');
}

export function writeDeck(mesh: TetMesh, study: Study, title: string): DeckInfo {
  const groups = new Map(mesh.groups.map((g) => [g.name, g]));
  const need = (name: string) => {
    const g = groups.get(name);
    if (!g) throw new Error(`needs attention: no mesh group for face "${name}"`);
    return g;
  };
  const { nodes } = mesh;
  const nTets = mesh.tet10.length / 10;
  const conn = new Array<number>(mesh.tet10.length);
  let flipped = 0;
  for (let e = 0; e < nTets; e++) {
    const g = mesh.tet10.slice(10 * e, 10 * e + 10);
    let c = GMSH_TO_CCX.map((i) => g[i] ?? 0);
    const [p0, p1, p2, p3] = [0, 1, 2, 3].map((i) => at(nodes, c[i] ?? 0)) as [V3, V3, V3, V3];
    if (dot(cross(sub(p1, p0), sub(p2, p0)), sub(p3, p0)) < 0) {
      // Swap corners 1 and 2 and their edges: (0,1)<->(0,2), (1,3)<->(2,3); (1,2) stays.
      c = [c[0], c[2], c[1], c[3], c[6], c[5], c[4], c[7], c[9], c[8]] as number[];
      flipped++;
    }
    for (let k = 0; k < 10; k++) conn[10 * e + k] = c[k] ?? 0;
  }
  checkOrder(nodes, conn, Math.min(nTets, 500));

  const out: string[] = [`*HEADING\n${title}`, '*NODE'];
  for (let i = 0; i < nodes.length / 3; i++) {
    const [x, y, z] = at(nodes, i);
    out.push(`${i + 1}, ${num(x)}, ${num(y)}, ${num(z)}`);
  }
  out.push('*ELEMENT, TYPE=C3D10, ELSET=SOLID');
  for (let e = 0; e < nTets; e++) {
    out.push(`${e + 1}, ${conn.slice(10 * e, 10 * e + 10).map((n) => n + 1).join(', ')}`);
  }

  const fixed = new Set<number>();
  for (const name of study.fixed) for (const n of need(name).tri6) fixed.add(n + 1);
  out.push('*NSET, NSET=FIXED', lines([...fixed].sort((a, b) => a - b)));

  const m = study.material;
  out.push(
    `*MATERIAL, NAME=${m.name}`,
    '*ELASTIC',
    `${m.E}, ${m.nu}`,
    '*DENSITY',
    `${m.density}`,
    `*SOLID SECTION, ELSET=SOLID, MATERIAL=${m.name}`,
    '*STEP',
    '*STATIC',
    '*BOUNDARY',
    'FIXED, 1, 3',
  );

  // Consistent nodal loads for a uniform traction on 6-node triangles: corners 0, mid-sides A/3.
  const force = new Map<number, V3>();
  for (const load of study.loads) {
    const tris: { mids: number[]; area: number }[] = [];
    let total = 0;
    for (const name of load.faces) {
      const t = need(name).tri6;
      for (let i = 0; i < t.length; i += 6) {
        const [a, b, c] = [t[i], t[i + 1], t[i + 2]].map((n) => at(nodes, n ?? 0)) as [V3, V3, V3];
        const n = cross(sub(b, a), sub(c, a));
        const area = Math.sqrt(dot(n, n)) / 2;
        total += area;
        tris.push({ mids: [t[i + 3], t[i + 4], t[i + 5]] as number[], area });
      }
    }
    for (const tri of tris) {
      const s = tri.area / total / 3;
      for (const n of tri.mids) {
        const f = force.get(n + 1) ?? [0, 0, 0];
        force.set(n + 1, [
          f[0] + s * load.force[0],
          f[1] + s * load.force[1],
          f[2] + s * load.force[2],
        ]);
      }
    }
  }
  out.push('*CLOAD');
  for (const [n, f] of [...force].sort((a, b) => a[0] - b[0])) {
    f.forEach((v, d) => {
      if (v !== 0) out.push(`${n}, ${d + 1}, ${num(v)}`);
    });
  }
  out.push('*NODE FILE', 'U', '*EL FILE', 'S', '*END STEP', '');
  return { deck: out.join('\n'), flippedTets: flipped, fixedNodes: fixed.size, loadedNodes: force.size };
}
