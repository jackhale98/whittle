/**
 * Orders sweep path edges into one connected chain (FeatureInputs: "refs['/path/i'] edges,
 * chained in order by the engine"). Pure: works on each edge's end points.
 *
 * Rules: every edge has 0 (closed curve, only as the whole path), 1 or 2 end points; a junction
 * may join at most two edges and the edges must form one chain. An open chain starts at the
 * user's first edge when that edge is an end of the chain, else at the end whose free point has
 * the smaller geometric key. A closed chain starts at the first edge and continues through its
 * end point with the larger geometric key.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec3 } from '@wren-cad/contracts';
import { compareKey } from './datums';
import { dist } from './geometry';

export type ChainResult = { ok: true; order: number[] } | { ok: false; message: string };

export function chainOrder(ends: readonly (readonly Vec3[])[], tol: number): ChainResult {
  const n = ends.length;
  if (n === 0) return { ok: false, message: 'Select the path to sweep along' };
  if (n === 1) return { ok: true, order: [0] };
  // Cluster end points into nodes.
  const nodes: Vec3[] = [];
  const nodeOf = (p: Vec3): number => {
    const i = nodes.findIndex((q) => dist(p, q) <= tol);
    if (i >= 0) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const edgeNodes: number[][] = [];
  for (let i = 0; i < n; i++) {
    const e = ends[i] as readonly Vec3[];
    if (e.length !== 2) {
      return {
        ok: false,
        message: `Path edge ${i + 1} is a closed curve; it can only be swept along on its own`,
      };
    }
    const a = nodeOf(e[0] as Vec3);
    const b = nodeOf(e[1] as Vec3);
    if (a === b) return { ok: false, message: `Path edge ${i + 1} has no length` };
    edgeNodes.push([a, b]);
  }
  const at = new Map<number, number[]>();
  edgeNodes.forEach(([a, b], i) => {
    for (const v of [a, b] as number[]) at.set(v, [...(at.get(v) ?? []), i]);
  });
  if ([...at.values()].some((l) => l.length > 2)) {
    return { ok: false, message: 'The sweep path branches; select one chain of edges' };
  }
  const ends1 = [...at.entries()].filter(([, l]) => l.length === 1).map(([v]) => v);
  let start: number;
  let from: number;
  if (ends1.length === 0) {
    start = 0;
    const [a, b] = edgeNodes[0] as [number, number];
    // Walk out through the end with the larger key: enter at the smaller one.
    from = compareKey(nodes[a] as Vec3, nodes[b] as Vec3) <= 0 ? a : b;
  } else if (ends1.length === 2) {
    const firstIsEnd = ends1.some((v) => at.get(v)?.[0] === 0);
    if (firstIsEnd) {
      start = 0;
      from = ends1.find((v) => at.get(v)?.[0] === 0) as number;
    } else {
      const sorted = [...ends1].sort((x, y) => compareKey(nodes[x] as Vec3, nodes[y] as Vec3));
      from = sorted[0] as number;
      start = (at.get(from) as number[])[0] as number;
    }
  } else {
    return { ok: false, message: 'The sweep path edges are not connected end to end' };
  }
  const order: number[] = [];
  const used = new Set<number>();
  let edge = start;
  let node = from;
  while (!used.has(edge)) {
    used.add(edge);
    order.push(edge);
    const [a, b] = edgeNodes[edge] as [number, number];
    node = a === node ? b : a;
    const next = (at.get(node) ?? []).find((e) => !used.has(e));
    if (next === undefined) break;
    edge = next;
  }
  if (order.length !== n) {
    return { ok: false, message: 'The sweep path edges are not connected end to end' };
  }
  return { ok: true, order };
}
