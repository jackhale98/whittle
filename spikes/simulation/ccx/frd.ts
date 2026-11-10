/**
 * Spike S0: minimal reader for CalculiX ASCII result files (.frd). Reads the node block (2C) and
 * the nodal result blocks (100C) of the last step: DISP (D1..D3) and STRESS (SXX SYY SZZ SXY SYZ
 * SZX), and derives von Mises. Fixed-width records (values are E12.5 and can touch each other):
 *   ' -1' + node id (I10 in long format, I5 in short) + n × E12.5
 * Binary .frd (OUTPUT=BINARY) is not supported.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface FrdResult {
  /** CalculiX node id -> index into the arrays below. */
  nodeIds: Int32Array;
  coords: Float64Array;
  /** Per node, xyz (mm). */
  disp: Float64Array;
  /** Per node: SXX SYY SZZ SXY SYZ SZX (MPa), extrapolated and averaged by CalculiX. */
  stress: Float64Array;
  vonMises: Float64Array;
}

function values(line: string, start: number, n: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < n; i++) v.push(Number(line.slice(start + 12 * i, start + 12 * (i + 1))));
  return v;
}

export function parseFrd(text: string): FrdResult {
  const ls = text.split('\n');
  const ids: number[] = [];
  const xyz: number[] = [];
  const index = new Map<number, number>();
  let disp: Float64Array | undefined;
  let stress: Float64Array | undefined;
  let i = 0;
  const idWidth = (fmtField: string) => (fmtField.trim() === '0' ? 5 : 10);
  while (i < ls.length) {
    const l = ls[i] ?? '';
    if (l.startsWith('    2C')) {
      const w = idWidth(l.slice(l.length - 2));
      i++;
      while (i < ls.length && !(ls[i] ?? '').startsWith(' -3')) {
        const r = ls[i] ?? '';
        const id = Number(r.slice(3, 3 + w));
        index.set(id, ids.length);
        ids.push(id);
        xyz.push(...values(r, 3 + w, 3));
        i++;
      }
    } else if (l.startsWith('  100C')) {
      const w = idWidth(l.slice(l.length - 2));
      const head = ls[i + 1] ?? '';
      const name = head.slice(5, 13).trim();
      const ncomp = name === 'DISP' ? 3 : name === 'STRESS' ? 6 : 0;
      const target = new Float64Array(ids.length * Math.max(ncomp, 1));
      i += 2;
      while (i < ls.length && !(ls[i] ?? '').startsWith(' -3')) {
        const r = ls[i] ?? '';
        if (ncomp > 0 && r.startsWith(' -1')) {
          const k = index.get(Number(r.slice(3, 3 + w)));
          if (k !== undefined) target.set(values(r, 3 + w, ncomp), k * ncomp);
        }
        i++;
      }
      if (name === 'DISP') disp = target;
      if (name === 'STRESS') stress = target;
    }
    i++;
  }
  if (!disp || !stress) throw new Error('frd: DISP or STRESS block missing');
  const vm = new Float64Array(ids.length);
  for (let k = 0; k < ids.length; k++) {
    const [sx, sy, sz, txy, tyz, tzx] = stress.subarray(6 * k, 6 * k + 6);
    vm[k] = Math.sqrt(
      0.5 * (((sx ?? 0) - (sy ?? 0)) ** 2 + ((sy ?? 0) - (sz ?? 0)) ** 2 + ((sz ?? 0) - (sx ?? 0)) ** 2) +
        3 * ((txy ?? 0) ** 2 + (tyz ?? 0) ** 2 + (tzx ?? 0) ** 2),
    );
  }
  return {
    nodeIds: Int32Array.from(ids),
    coords: Float64Array.from(xyz),
    disp,
    stress,
    vonMises: vm,
  };
}
