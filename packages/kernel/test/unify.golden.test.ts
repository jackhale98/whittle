/**
 * Golden tests for merging same-domain faces after booleans (ADR-076): face, edge and vertex
 * counts, areas and volumes of fused / cut / intersected boxes and cylinders whose faces end up
 * flush, the naming rule (the earliest-created face keeps its name; absorbed names stay as
 * aliases of the surviving sub-shape) and patterns of bosses whose tops are coplanar. Every
 * number is analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, FeatureResult, NamingEntry } from '@wren-cad/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  frameAt,
  indexOf,
  loadVariant,
  relClose,
  Session,
  suiteTitle,
  VARIANTS,
  variantBuilt,
} from './helpers';

const REL = 1e-9;
const A = '01JUNIFYA00000000000000001';
const B = '01JUNIFYB00000000000000001';
const C = '01JUNIFYC00000000000000001';
const D = '01JUNIFYD00000000000000001';
const LP = '01JUNIFYLP0000000000000001';

/** Primary names (the first entry per kind and index) of a result. */
function primary(r: FeatureResult, kind: NamingEntry['kind']): string[] {
  const seen = new Set<number>();
  const out: string[] = [];
  for (const n of r.naming) {
    if (n.kind !== kind || seen.has(n.index)) continue;
    seen.add(n.index);
    out.push(n.name);
  }
  return out;
}

/** Alias entries (a later entry for an index that already has a name), as name → primary name. */
function aliases(r: FeatureResult, kind: NamingEntry['kind']): Record<string, string> {
  const first = new Map<number, string>();
  const out: Record<string, string> = {};
  for (const n of r.naming) {
    if (n.kind !== kind) continue;
    const p = first.get(n.index);
    if (p === undefined) first.set(n.index, n.name);
    else out[n.name] = p;
  }
  return out;
}

const box = (id: string, origin: [number, number, number], op: 'new' | 'add' | 'cut' | 'intersect') =>
  boxFeature(id, frameAt(origin), op);

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('unify same-domain faces', variant), () => {
    let k: WhittleKernelModule;
    let s: Session;
    let baseline = 0;

    beforeAll(async () => {
      k = await loadVariant(variant);
      baseline = k.liveHandleCount();
    }, 60_000);

    afterEach(() => {
      s?.releaseAll();
      expect(k.liveHandleCount()).toBe(baseline);
    });

    afterAll(() => {
      if (k) expect(k.liveHandleCount()).toBe(baseline);
    });

    const session = () => {
      s = new Session(k);
      return s;
    };

    const add = (ss: Session, target: number, f: Feature, values: FeatureInputs['values']) =>
      ss.exec(f, { values, target });

    it('box beside box, flush top: one top face; the earlier box keeps its names', () => {
      const ss = session();
      const a = ss.exec(box(A, [0, 0, 0], 'new'), boxValues(40, 30, 20));
      const r = add(ss, a.shape, box(B, [40, 0, 0], 'add'), boxValues(30, 30, 20).values);
      const m = ss.mass(r.shape);
      expect([m.faceCount, m.edgeCount, m.vertexCount]).toEqual([6, 12, 8]);
      relClose(m.volume, 70 * 30 * 20, REL);
      relClose(m.area, 2 * (70 * 30 + 70 * 20 + 30 * 20), REL);
      expect(primary(r, 'face').sort()).toEqual(
        [
          `F${A}:face.xmin`,
          `F${B}:face.xmax`,
          `F${A}:face.ymin`,
          `F${A}:face.ymax`,
          `F${A}:face.zmin`,
          `F${A}:face.zmax`,
        ].sort(),
      );
      // The second box's flush faces are aliases of the merged ones.
      expect(aliases(r, 'face')).toEqual({
        [`F${B}:face.ymin`]: `F${A}:face.ymin`,
        [`F${B}:face.ymax`]: `F${A}:face.ymax`,
        [`F${B}:face.zmin`]: `F${A}:face.zmin`,
        [`F${B}:face.zmax`]: `F${A}:face.zmax`,
      });
      // Edges merge the same way: the top front edge is one edge, under the earlier name, and the
      // second box's piece is an alias of it.
      const top = `edge(F${A}:face.ymin|F${A}:face.zmax)`;
      const edges = aliases(r, 'edge');
      expect(edges[`edge(F${B}:face.ymin|F${B}:face.zmax)`]).toBe(top);
      const fp = ss.fingerprints(r.shape);
      relClose(fp.edges[indexOf(r, top, 'edge')]?.length ?? 0, 70, REL);
      relClose(fp.faces[indexOf(r, `F${A}:face.zmax`, 'face')]?.area ?? 0, 70 * 30, REL);
      // Aliases point at the very same sub-shape.
      expect(indexOf(r, `F${B}:face.zmax`, 'face')).toBe(indexOf(r, `F${A}:face.zmax`, 'face'));
    });

    it('the face that was on the body wins even when the new face sorts first', () => {
      const ss = session();
      // B was created first here; A (a smaller name) is the tool.
      const b = ss.exec(box(B, [0, 0, 0], 'new'), boxValues(40, 30, 20));
      const r = add(ss, b.shape, box(A, [40, 0, 0], 'add'), boxValues(30, 30, 20).values);
      expect(primary(r, 'face')).toContain(`F${B}:face.zmax`);
      expect(aliases(r, 'face')[`F${A}:face.zmax`]).toBe(`F${B}:face.zmax`);
    });

    it('box stacked on a box of the same footprint: the sides merge, the top is the new one', () => {
      const ss = session();
      const a = ss.exec(box(A, [0, 0, 0], 'new'), boxValues(40, 30, 20));
      const r = add(ss, a.shape, box(B, [0, 0, 20], 'add'), boxValues(40, 30, 10).values);
      const m = ss.mass(r.shape);
      expect([m.faceCount, m.edgeCount, m.vertexCount]).toEqual([6, 12, 8]);
      relClose(m.volume, 40 * 30 * 30, REL);
      expect(primary(r, 'face')).toContain(`F${B}:face.zmax`);
      expect(primary(r, 'face')).toContain(`F${A}:face.zmin`);
      expect(primary(r, 'face')).not.toContain(`F${A}:face.zmax`);
      for (const side of ['xmin', 'xmax', 'ymin', 'ymax']) {
        expect(aliases(r, 'face')[`F${B}:face.${side}`]).toBe(`F${A}:face.${side}`);
      }
    });

    it('partly flush: only the coplanar faces merge, the rest keep their seams and names', () => {
      const ss = session();
      // A 10-wide block on the plate's back edge, flush with the back and the top of nothing:
      // back faces merge (y = 30), left and right do not (the block is narrower).
      const a = ss.exec(box(A, [0, 0, 0], 'new'), boxValues(40, 30, 10));
      const r = add(ss, a.shape, box(B, [10, 20, 10], 'add'), boxValues(10, 10, 15).values);
      const m = ss.mass(r.shape);
      relClose(m.volume, 40 * 30 * 10 + 10 * 10 * 15, REL);
      // Plate 6 + block top, front, left, right; the block's back merged into the plate's back.
      expect(m.faceCount).toBe(10);
      expect(aliases(r, 'face')).toEqual({ [`F${B}:face.ymax`]: `F${A}:face.ymax` });
      const fp = ss.fingerprints(r.shape);
      relClose(fp.faces[indexOf(r, `F${A}:face.ymax`, 'face')]?.area ?? 0, 40 * 10 + 10 * 15, REL);
    });

    it('cut: a new floor flush with an earlier step merges into it (earlier name kept)', () => {
      const ss = session();
      const a = ss.exec(box(A, [0, 0, 0], 'new'), boxValues(20, 10, 10));
      // Step: remove x ∈ [10, 20], z ∈ [5, 10] → floor F{C}:face.zmin at z = 5.
      const step = add(ss, a.shape, box(C, [10, -1, 5], 'cut'), boxValues(11, 12, 6).values);
      expect(ss.mass(step.shape).faceCount).toBe(8);
      // Widen it: remove x ∈ [5, 11] → its floor lands flush with the step's.
      const r = add(ss, step.shape, box(D, [5, -1, 5], 'cut'), boxValues(6, 12, 6).values);
      const m = ss.mass(r.shape);
      relClose(m.volume, 20 * 10 * 10 - 15 * 10 * 5, REL);
      expect([m.faceCount, m.edgeCount, m.vertexCount]).toEqual([8, 18, 12]);
      expect(aliases(r, 'face')).toEqual({
        [`F${D}:face.zmin`]: `F${C}:face.zmin`,
      });
      const fp = ss.fingerprints(r.shape);
      relClose(fp.faces[indexOf(r, `F${C}:face.zmin`, 'face')]?.area ?? 0, 15 * 10, REL);
    });

    it('intersect: tool and body faces in one plane become one face (the body face kept)', () => {
      const ss = session();
      const a = ss.exec(box(A, [0, 0, 0], 'new'), boxValues(30, 10, 10));
      // A slot x ∈ [10, 20], z ∈ [5, 10]: floor F{C}:face.zmin at z = 5.
      const u = add(ss, a.shape, box(C, [10, -1, 5], 'cut'), boxValues(10, 12, 6).values);
      // Keep z ≤ 5: the tool's top meets the slot floor in one plane.
      const r = add(ss, u.shape, box(D, [-1, -1, -1], 'intersect'), boxValues(32, 12, 6).values);
      const m = ss.mass(r.shape);
      relClose(m.volume, 30 * 10 * 5, REL);
      expect([m.faceCount, m.edgeCount, m.vertexCount]).toEqual([6, 12, 8]);
      const top = primary(r, 'face').find((n) => n.startsWith(`F${C}:face.zmin`));
      expect(top).toBe(`F${C}:face.zmin`);
      const fp = ss.fingerprints(r.shape);
      relClose(fp.faces[indexOf(r, `F${C}:face.zmin`, 'face')]?.area ?? 0, 30 * 10, REL);
      // The tool's top (split in two by the slot floor before the merge) is an alias of it.
      for (const [alias, into] of Object.entries(aliases(r, 'face'))) {
        expect(alias.startsWith(`F${D}:face.zmax`)).toBe(true);
        expect(into).toBe(`F${C}:face.zmin`);
      }
      expect(Object.keys(aliases(r, 'face')).length).toBeGreaterThan(0);
    });

    it('coaxial cylinders of one radius: one side face', () => {
      const ss = session();
      const cyl = (id: string, z: number, op: 'new' | 'add') =>
        ({
          id,
          type: 'primitive',
          name: 'Cyl',
          suppressed: false,
          op,
          shape: 'cylinder',
          radius: '5',
          height: '10',
          frame: frameAt([0, 0, z]),
        }) as Feature;
      const a = ss.exec(cyl(A, 0, 'new'), { values: { '/radius': 5, '/height': 10 } });
      const r = ss.exec(cyl(B, 10, 'add'), {
        values: { '/radius': 5, '/height': 10 },
        target: a.shape,
      });
      const m = ss.mass(r.shape);
      relClose(m.volume, Math.PI * 25 * 20, 1e-9);
      expect(m.faceCount).toBe(3);
      expect(primary(r, 'face').sort()).toEqual(
        [`F${A}:face.side`, `F${A}:face.zmin`, `F${B}:face.zmax`].sort(),
      );
      expect(aliases(r, 'face')).toEqual({ [`F${B}:face.side`]: `F${A}:face.side` });
    });

    it('nothing flush: no merge, no aliases, names as before', () => {
      const ss = session();
      const a = ss.exec(box(A, [0, 0, 0], 'new'), boxValues(40, 30, 10));
      const r = add(ss, a.shape, box(B, [10, 10, 10], 'add'), boxValues(10, 10, 5).values);
      const m = ss.mass(r.shape);
      expect(m.faceCount).toBe(6 + 5);
      expect(aliases(r, 'face')).toEqual({});
      expect(aliases(r, 'edge')).toEqual({});
      expect(aliases(r, 'vertex')).toEqual({});
    });

    describe('pattern of bosses on a plate', () => {
      const pattern = (spacing: number): Feature =>
        ({
          id: LP,
          type: 'linearPattern',
          name: 'Pattern',
          suppressed: false,
          source: { kind: 'features', features: [B] },
          direction: { name: 'origin:X', kind: 'edge' },
          reverse: false,
          count: '4',
          spacing: String(spacing),
        }) as Feature;
      const run = (ss: Session, spacing: number) => {
        const plate = ss.exec(box(A, [0, 0, 0], 'new'), boxValues(100, 20, 5));
        const boss = add(ss, plate.shape, box(B, [5, 5, 5], 'add'), boxValues(10, 10, 5).values);
        const tool = ss.exec(box(B, [5, 5, 5], 'new'), boxValues(10, 10, 5));
        return ss.exec(pattern(spacing), {
          values: { [`/ops/${B}`]: 0, '/count': 4, '/spacing': spacing },
          target: boss.shape,
          shapes: { [`tool:${B}`]: tool.shape },
          frames: { '/direction': frameAt([0, 0, 0], [1, 0, 0], [0, 1, 0]) },
        });
      };

      it('apart: coplanar tops stay separate faces, each with its own name', () => {
        const ss = session();
        const r = run(ss, 20);
        const m = ss.mass(r.shape);
        relClose(m.volume, 100 * 20 * 5 + 4 * 500, REL);
        expect(m.faceCount).toBe(6 + 4 * 5);
        expect(primary(r, 'face')).toContain(`F${B}:face.zmax`);
        for (let i = 1; i < 4; i++) expect(primary(r, 'face')).toContain(`F${LP}:inst${i}(F${B}:face.zmax)`);
        expect(aliases(r, 'face')).toEqual({});
      });

      it('touching: the tops (and fronts, backs) merge; the original boss keeps its names', () => {
        const ss = session();
        const r = run(ss, 10);
        const m = ss.mass(r.shape);
        relClose(m.volume, 100 * 20 * 5 + 4 * 500, REL);
        // Plate 6 + one 40 × 10 × 5 block on it (top, front, back, two ends).
        expect(m.faceCount).toBe(6 + 5);
        const fp = ss.fingerprints(r.shape);
        relClose(fp.faces[indexOf(r, `F${B}:face.zmax`, 'face')]?.area ?? 0, 400, REL);
        const al = aliases(r, 'face');
        for (let i = 1; i < 4; i++) {
          expect(al[`F${LP}:inst${i}(F${B}:face.zmax)`]).toBe(`F${B}:face.zmax`);
          expect(al[`F${LP}:inst${i}(F${B}:face.ymin)`]).toBe(`F${B}:face.ymin`);
        }
        expect(primary(r, 'face')).toContain(`F${LP}:inst3(F${B}:face.xmax)`);
      });
    });
  });
}
