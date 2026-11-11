/**
 * Merge sweep (ADR-078 review): references stored before booleans merged coplanar faces must never
 * resolve to another entity now. Six scenarios of flush booleans (a merge of piece #0, of #1, two
 * merges in one operation, a cut floor flush across two slots, a touching pattern, a merged
 * mirror) are built step by step with the real kernel; the walk's merge table is filled from every
 * step's naming map as the regen engine does. Every face, edge and vertex name the pre-ADR-078
 * kernel gave the final body (fixtures/merge-sweep.pre-adr078.json, with its geometry) is resolved
 * through `resolveWithMerges` with its fingerprint. It must land on an entity that contains the
 * old one (same vertex; an edge or face covering it), or stay unresolved: never on another one.
 *
 * Re-record (only from a pre-ADR-078 kernel build, e.g. commit e1b1b6d):
 * Per step: the names after every feature, checked against the new result after that feature.
 * `WREN_UPDATE_MERGE_SWEEP=1 WREN_SWEEP_KERNEL_DIST=<that dist>/ pnpm vitest run test/regen/merge-sweep.test.ts`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Feature,
  FeatureInputs,
  FeatureResult,
  ShapeFingerprints,
  Vec3,
} from '@wren-cad/contracts';
import {
  instantiateKernel,
  type KernelInitModule,
  type WhittleKernelModule,
} from '@wren-cad/kernel';
import { describe, expect, it } from 'vitest';
import { resolveWithMerges } from '../../src/regen/refs';
import type { Candidate, ResolveContext, SubKind } from '../../src/regen/resolve';
import { ModelState, primaryNaming, recordMerges } from '../../src/regen/state';
import { built, fid, skipNote } from './helpers';

const FIXTURE = fileURLToPath(new URL('./fixtures/merge-sweep.pre-adr078.json', import.meta.url));
const UPDATE = process.env.WREN_UPDATE_MERGE_SWEEP === '1';
const DIST =
  process.env.WREN_SWEEP_KERNEL_DIST ??
  fileURLToPath(new URL('../../../kernel/dist/', import.meta.url));

type Geo = { centroid?: Vec3; normal?: Vec3; area?: number; length?: number; point?: Vec3 };
type Entity = { name: string; kind: SubKind; g: Geo };
/** Per scenario, per step: every name of that step's result with its geometry. */
type Fixture = Record<string, Entity[][]>;

interface Step {
  feature: Feature;
  inputs: (prev: number | undefined, tools: Record<string, number>) => FeatureInputs;
  /** A tool solid for copies (not part of the body's history). */
  tool?: string;
}

const frame = (origin: Vec3, z: Vec3 = [0, 0, 1], x: Vec3 = [1, 0, 0]) => ({ origin, z, x });
const boxF = (tag: string, origin: Vec3, op: string): Feature =>
  ({
    id: fid(tag),
    type: 'primitive',
    name: 'Box',
    suppressed: false,
    op,
    shape: 'box',
    dx: '1',
    dy: '1',
    dz: '1',
    frame: frame(origin),
  }) as Feature;
const box = (tag: string, o: Vec3, d: Vec3, op: 'new' | 'add' | 'cut'): Step => ({
  feature: boxF(tag, o, op),
  inputs: (prev) => ({
    values: { '/dx': d[0], '/dy': d[1], '/dz': d[2] },
    ...(op === 'new' || prev === undefined ? {} : { target: prev }),
  }),
});

/** A box at the origin, a slab, two walls and a top T whose piece #0 merges into the box's top. */
const MERGE0: Step[] = [
  box('SWP', [0, 0, 0], [10, 10, 10], 'new'),
  box('SWS', [0, 0, 0], [40, 10, 2], 'add'),
  box('SWWA', [20, 0, 0], [2, 10, 20], 'add'),
  box('SWWB', [30, 0, 0], [2, 10, 20], 'add'),
  box('SWT', [0, 0, 5], [40, 10, 5], 'add'),
];

/** Scenarios that start with merge0: the fixture keeps only their own later steps. */
const PREFIX: Record<string, string> = {
  merge0ThenSplit: 'merge0',
  merge0ThenSlot: 'merge0',
  merge0ThenBoss: 'merge0',
};

const SCENARIOS: Record<string, Step[]> = {
  merge0: MERGE0,
  // Later features on the merged body (review): a notch that splits the bottom front edge (an old
  // `#3` piece is then nearer to `#0` across the notch than to the edge now covering it), a slot,
  // a boss.
  merge0ThenSplit: [...MERGE0, box('SWCUT', [4, -1, -1], [2, 3, 8], 'cut')],
  merge0ThenSlot: [...MERGE0, box('SWSLOT', [5, -1, 3], [1, 12, 1], 'cut')],
  merge0ThenBoss: [...MERGE0, box('SWADD', [10, -3, 0], [10, 3, 5], 'add')],
  merge1: [
    box('SWS', [0, 0, 0], [40, 10, 2], 'new'),
    box('SWWA', [10, 0, 0], [2, 10, 20], 'add'),
    box('SWQ', [12, 0, 0], [10, 10, 10], 'add'),
    box('SWWB', [30, 0, 0], [2, 10, 20], 'add'),
    box('SWT', [0, 0, 5], [40, 10, 5], 'add'),
  ],
  twoMerges: [
    box('SWP', [0, 0, 0], [10, 10, 10], 'new'),
    box('SWS', [0, 0, 0], [50, 10, 2], 'add'),
    box('SWWA', [20, 0, 0], [2, 10, 20], 'add'),
    box('SWWB', [30, 0, 0], [2, 10, 20], 'add'),
    box('SWR', [40, 0, 0], [10, 10, 10], 'add'),
    box('SWT', [0, 0, 5], [50, 10, 5], 'add'),
  ],
  cutFloor: [
    box('SWPL', [0, 0, 0], [40, 10, 10], 'new'),
    box('SWPK', [2, -1, 10], [6, 12, 11], 'cut'),
    box('SWHA', [12, -1, -1], [2, 12, 12], 'cut'),
    box('SWHB', [24, -1, -1], [2, 12, 12], 'cut'),
    box('SWSL', [-1, -1, 5], [42, 12, 4], 'cut'),
  ],
  pattern: [
    box('SWA', [0, 0, 0], [100, 20, 5], 'new'),
    box('SWB', [5, 5, 5], [10, 10, 5], 'add'),
    {
      feature: {
        id: fid('SWLP'),
        type: 'linearPattern',
        name: 'Pattern',
        suppressed: false,
        source: { kind: 'features', features: [fid('SWB')] },
        direction: { name: 'origin:X', kind: 'edge' },
        reverse: false,
        count: '4',
        spacing: '10',
      } as Feature,
      inputs: (prev, tools) => ({
        values: { [`/ops/${fid('SWB')}`]: 0, '/count': 4, '/spacing': 10 },
        ...(prev === undefined ? {} : { target: prev }),
        shapes: { [`tool:${fid('SWB')}`]: tools.SWB as number },
        frames: { '/direction': frame([0, 0, 0], [1, 0, 0], [0, 1, 0]) },
      }),
      tool: 'SWB',
    },
  ],
  mirror: [
    box('SWMB', [0, 0, 0], [10, 10, 10], 'new'),
    box('SWMC', [4, 3, 10], [3, 4, 3], 'add'),
    {
      feature: {
        id: fid('SWMI'),
        type: 'mirror',
        name: 'Mirror',
        suppressed: false,
        source: {
          kind: 'bodies',
          bodies: [{ name: `B${fid('SWMB')}`, kind: 'body' }],
          merge: true,
        },
        plane: { name: 'origin:YZ', kind: 'face' },
      } as Feature,
      inputs: (prev) => ({
        values: {},
        refs: { '/source/bodies/0': { shape: prev as number, kind: 'body', index: 0 } },
        frames: { '/plane': frame([0, 0, 0], [1, 0, 0], [0, 1, 0]) },
      }),
    },
  ],
};

let loaded: Promise<WhittleKernelModule> | undefined;
function loadKernel(): Promise<WhittleKernelModule> {
  loaded ??= load();
  return loaded;
}
async function load(): Promise<WhittleKernelModule> {
  const mod = (await import(pathToFileURL(`${DIST}init.single.js`).href)) as KernelInitModule;
  return instantiateKernel(mod);
}

function exec(k: WhittleKernelModule, f: Feature, inputs: FeatureInputs): FeatureResult {
  const r = JSON.parse(k.execFeature(JSON.stringify(f), JSON.stringify(inputs)));
  if (!r.ok) throw new Error(`${f.type} ${f.id}: ${JSON.stringify(r.error)}`);
  return r.value as FeatureResult;
}

/** Builds a scenario; returns every step's result (the last is the body) and the handles. */
function build(k: WhittleKernelModule, steps: Step[]) {
  const results: FeatureResult[] = [];
  const handles: number[] = [];
  const tools: Record<string, number> = {};
  let prev: number | undefined;
  for (const s of steps) {
    if (s.tool) {
      const src = steps.find((x) => x.feature.id === fid(s.tool as string)) as Step;
      const t = exec(k, { ...src.feature, op: 'new' } as Feature, src.inputs(undefined, tools));
      tools[s.tool] = t.shape;
      handles.push(t.shape);
    }
    const r = exec(k, s.feature, s.inputs(prev, tools));
    handles.push(r.shape);
    results.push(r);
    prev = r.shape;
  }
  return { results, handles, body: results.at(-1) as FeatureResult };
}

function geometry(fp: ShapeFingerprints, kind: SubKind, index: number): Geo {
  if (kind === 'face') {
    const f = fp.faces[index];
    return f?.normal
      ? { centroid: f.centroid, normal: f.normal, area: f.area }
      : { centroid: f?.centroid, area: f?.area };
  }
  if (kind === 'edge')
    return { centroid: fp.edges[index]?.centroid, length: fp.edges[index]?.length };
  return { point: fp.vertices[index]?.point };
}

const sub = (a: Vec3, b: Vec3) => a.map((v, i) => v - (b[i] as number)) as Vec3;
const dot = (a: Vec3, b: Vec3) => a.reduce((s, v, i) => s + v * (b[i] as number), 0);
const len = (a: Vec3) => Math.sqrt(dot(a, a));

/**
 * Does the new entity `n` contain the old one `o` (same vertex; an edge or face covering it)?
 * Planes compare without the normal's sign: mirrored copies report inward fingerprint normals
 * (a separate, pre-existing kernel issue), and this is a geometric "same entity" check.
 */
function contains(kind: SubKind, o: Geo, n: Geo): boolean {
  if (kind === 'vertex') return len(sub(o.point as Vec3, n.point as Vec3)) < 1e-6;
  const d = len(sub(o.centroid as Vec3, n.centroid as Vec3));
  if (kind === 'edge') {
    const lo = o.length as number;
    const ln = n.length as number;
    return ln >= lo - 1e-6 && d <= (ln - lo) / 2 + 1e-6;
  }
  if (o.normal && n.normal) {
    if (Math.abs(dot(o.normal, n.normal)) < 0.9999) return false;
    if (Math.abs(dot(sub(o.centroid as Vec3, n.centroid as Vec3), n.normal)) > 1e-6) return false;
  }
  return (n.area as number) >= (o.area as number) - 1e-6 && d <= Math.sqrt(n.area as number);
}

/**
 * `contains`, or exactly: the old entity's centroid lies on the new face / edge (kernel distance,
 * 1e-6 mm) and the new one is at least as large and, for faces, in the same plane and facing.
 * (A long merged face's centroid can be farther than √area from a piece it covers.)
 */
function containsOn(
  k: WhittleKernelModule,
  shape: number,
  kind: SubKind,
  index: number,
  o: Geo,
  n: Geo,
) {
  if (contains(kind, o, n)) return true;
  if (kind === 'vertex') return false;
  if (kind === 'face') {
    if ((n.area as number) < (o.area as number) - 1e-6) return false;
    if (o.normal && n.normal && Math.abs(dot(o.normal, n.normal)) < 0.9999) return false;
  } else if ((n.length as number) < (o.length as number) - 1e-6) {
    return false;
  }
  const q = { a: { shape, kind, index }, b: { point: o.centroid } };
  const m = JSON.parse(k.measure(JSON.stringify(q)));
  return m.ok === true && (m.value.distance?.value ?? 1) <= 1e-6;
}

const fixture: Fixture =
  !UPDATE && existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : {};

describe.skipIf(!built)(
  `merge sweep: pre-ADR-078 names never land on another entity${skipNote}`,
  () => {
    if (UPDATE) {
      it('records the pre-ADR-078 names and geometry', async () => {
        const k = await loadKernel();
        const out: Fixture = {};
        for (const [name, steps] of Object.entries(SCENARIOS)) {
          const { results, handles } = build(k, steps);
          out[name] = results.slice(PREFIX[name] ? MERGE0.length : 0).map((r) => {
            const fp = JSON.parse(k.fingerprints(r.shape)).value as ShapeFingerprints;
            return r.naming.map((n) => ({
              name: n.name,
              kind: n.kind,
              g: geometry(fp, n.kind, n.index),
            }));
          });
          for (const h of handles) k.release(h);
        }
        // Compact: numbers to 1e-7 mm, one scenario per line (the file stays small and diffable).
        const round = (_: string, v: unknown) =>
          typeof v === 'number' ? Math.round(v * 1e7) / 1e7 || 0 : v;
        const lines = Object.entries(out).map(
          ([n, s]) => `${JSON.stringify(n)}:${JSON.stringify(s, round)}`,
        );
        writeFileSync(FIXTURE, `{\n${lines.join(',\n')}\n}\n`);
      }, 120_000);
      return;
    }

    it.each(Object.keys(SCENARIOS))(
      '%s',
      async (name) => {
        const k = await loadKernel();
        const { results, handles } = build(k, SCENARIOS[name] as Step[]);
        const prefix = PREFIX[name];
        const steps = [...(prefix ? (fixture[prefix] ?? []) : []), ...(fixture[name] ?? [])];
        expect(steps.length).toBe(results.length);
        const state = new ModelState();
        const wrong: string[] = [];
        const tally = { names: 0, ok: 0, merged: 0, unresolved: 0 };
        let last: { cands: Candidate[]; rc: ResolveContext } | undefined;
        // After every step: the old names of that step against the new result of that step, with
        // the merge table of the steps so far (as the regen engine walks the features).
        for (const [si, body] of results.entries()) {
          recordMerges(state.merged, body.naming);
          const fp = JSON.parse(k.fingerprints(body.shape)).value as ShapeFingerprints;
          const cands: Candidate[] = primaryNaming(body.naming).map((n) => ({
            shape: body.shape,
            kind: n.kind,
            index: n.index,
            name: n.name,
            owner: 'B',
          }));
          const pts = fp.vertices.map((v) => v.point);
          const lo = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i] as number))) as Vec3;
          const hi = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i] as number))) as Vec3;
          // As the regen engine's context (refs.ts): fingerprints and kernel point distances.
          const rc: ResolveContext = {
            diag: len(sub(hi, lo)),
            fingerprints: async () => fp,
            distance: async (c, point) => {
              const q = { a: { shape: c.shape, kind: c.kind, index: c.index }, b: { point } };
              const m = JSON.parse(k.measure(JSON.stringify(q)));
              return m.ok ? (m.value.distance?.value ?? null) : null;
            },
          };
          last = { cands, rc };
          const old = steps[si] ?? [];
          expect(old.length).toBeGreaterThan(0);
          tally.names += old.length;
          for (const o of old) {
            const fingerprint =
              o.kind === 'face'
                ? {
                    centroid: o.g.centroid as Vec3,
                    ...(o.g.normal ? { normal: o.g.normal } : {}),
                    area: o.g.area as number,
                  }
                : o.kind === 'edge'
                  ? { centroid: o.g.centroid as Vec3, length: o.g.length as number }
                  : { centroid: o.g.point as Vec3 };
            const r = await resolveWithMerges(
              { name: o.name, kind: o.kind, fingerprint },
              o.kind,
              cands.filter((c) => c.kind === o.kind),
              state,
              rc,
            );
            if (!r.ok) {
              tally.unresolved++;
              continue;
            }
            if (r.target.via === 'merged') tally.merged++;
            const now = geometry(fp, o.kind, r.target.index);
            if (containsOn(k, body.shape, o.kind, r.target.index, o.g, now)) tally.ok++;
            else
              wrong.push(
                `step ${si} ${o.kind} ${o.name} → ${r.target.name} (${r.target.via}): ${JSON.stringify(o.g)} vs ${JSON.stringify(now)}`,
              );
          }
        }
        const { cands, rc } = last as { cands: Candidate[]; rc: ResolveContext };
        console.log(
          `[merge sweep] ${name}: ${results.length} steps, ${tally.names} names, ok ${tally.ok} (merged ${tally.merged}), unresolved ${tally.unresolved}, wrong ${wrong.length}`,
        );
        expect(wrong).toEqual([]);
        const conflicts = [...state.merged.entries()]
          .filter(([, s]) => s.length > 1)
          .map(([key]) => key);
        console.log(
          `[merge sweep] ${name}: conflicting aliases ${conflicts.length}`,
          conflicts.join(' ; '),
        );
        if (name === 'merge0') {
          // The review's case: two features list this old vertex name for different vertices.
          const P = `F${fid('SWP')}`;
          const v = `vertex(${P}:face.xmax|${P}:face.ymin#0|${P}:face.ymin#1)`;
          expect(conflicts).toContain(`vertex|${v}`);
          const r = await resolveWithMerges(
            { name: v, kind: 'vertex', fingerprint: { centroid: [10, 0, 2] } },
            'vertex',
            cands.filter((c) => c.kind === 'vertex'),
            state,
            rc,
          );
          expect(r.ok).toBe(false);
          expect(!r.ok && r.reason).toBe('ambiguous');
          expect(!r.ok && r.candidates?.length).toBe(2);
        }
        for (const h of handles) k.release(h);
      },
      120_000,
    );
  },
);
