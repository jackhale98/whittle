// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M2.5 acceptance: 1,000 random pairs of concurrent edits, generated from the document command
 * set, merged three-way. For every pair:
 *  - no edit is lost: every change either side made is in the merge or covered by a conflict;
 *  - nothing is invented: every merged value is ours' or theirs';
 *  - the merged (and the resolved) documents are valid (validateDoc + JSON Schema);
 *  - merge(b, x, x) = x and merge(b, b, x) = merge(b, x, b) = x;
 *  - symmetry: swapping ours and theirs swaps the conflicts; without conflicts the documents are
 *    equal, and resolving every conflict to "theirs" gives the swapped merge's document.
 * Seeded (`FUZZ_SEED`, default 2025) so a failure names a reproducible pair.
 */

import type {
  Command,
  Feature,
  MergeConflict,
  MergeResult,
  Part,
  SketchConstraint,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { canonicalJson } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import { docMerger, isCollectionPath, toPointer } from '../src';
import { barIdOf, idsOf, isEntityRef, isObj } from '../src/merge/tree';
import {
  apply,
  baseDoc,
  EXTRUDE,
  FILLET,
  fillet,
  id,
  P_WIDTH,
  PART,
  problems,
  ref,
  SKETCH,
} from './support/fixtures';

const HOT = new Set([SKETCH, EXTRUDE, FILLET]);

// ---------------------------------------------------------------------------------------------
// Seeded PRNG and the edit generator
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  private n = 0;
  constructor(
    readonly rng: () => number,
    private readonly side: 'o' | 't',
    private readonly offset: number,
    /** Hotspot pairs: both sides mostly edit the same few items, so conflicts are common. */
    readonly focus = false,
  ) {}
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T | undefined {
    return xs.length === 0 ? undefined : xs[this.int(0, xs.length - 1)];
  }
  newId(): string {
    return id(this.offset + this.n++);
  }
  newName(): string {
    return `${this.side}_${this.n++}`;
  }
  mm(): string {
    return `${this.int(1, 60)}mm`;
  }
}

function editSketch(g: Gen, s: SketchFeature): SketchFeature {
  const next = structuredClone(s);
  const dims = next.constraints.filter((c) => 'value' in c);
  const points = next.entities.filter((e) => e.kind === 'point');
  const lines = next.entities.filter((e) => e.kind === 'line');
  switch (g.int(0, 5)) {
    case 0: {
      const d = g.pick(dims);
      if (d && 'value' in d) d.value = g.mm();
      break;
    }
    case 1: {
      const p = g.pick(points);
      if (p && p.kind === 'point') {
        p.x = g.int(-50, 50);
        p.y = g.int(-50, 50);
      }
      break;
    }
    case 2:
      next.entities.push({
        id: g.newId(),
        kind: 'point',
        construction: g.rng() < 0.5,
        x: g.int(0, 9),
        y: 1,
      });
      break;
    case 3:
      if (next.constraints.length > 0)
        next.constraints.splice(g.int(0, next.constraints.length - 1), 1);
      break;
    case 4: {
      const l = g.pick(lines);
      if (l)
        next.constraints.push({
          id: g.newId(),
          kind: 'horizontal',
          line: l.id,
        } as SketchConstraint);
      break;
    }
    default: {
      const c = next.entities.find((e) => e.kind === 'circle');
      if (c && c.kind === 'circle') c.radius = g.int(1, 20);
    }
  }
  return next;
}

function editFeature(g: Gen, f: Feature): Feature {
  if (g.rng() < 0.12) return { ...f, name: g.newName() };
  const x = structuredClone(f) as Feature & Record<string, unknown>;
  switch (x.type) {
    case 'sketch':
      return editSketch(g, x);
    case 'fillet':
      x.radius = g.mm();
      if (g.rng() < 0.2) x.edges = [ref(`F${g.newId()}:edge(a|b)`, 'edge')];
      return x;
    case 'chamfer':
      x.mode =
        g.rng() < 0.3
          ? { kind: 'distanceAngle', distance: g.mm(), angle: `${g.int(10, 80)}deg` }
          : x.mode.kind === 'distance'
            ? { ...x.mode, distance: g.mm() }
            : { ...x.mode, angle: `${g.int(10, 80)}deg` };
      return x;
    case 'extrude':
      if (g.rng() < 0.25)
        x.end = x.end.kind === 'blind' ? { kind: 'throughAll' } : { kind: 'blind', depth: g.mm() };
      else if (x.end.kind === 'blind') x.end = { kind: 'blind', depth: g.mm() };
      else x.direction = x.direction === 'normal' ? 'reverse' : 'normal';
      if (g.rng() < 0.2) x.draft = `${g.int(1, 5)}deg`;
      return x;
    case 'plane':
      if (x.definition.kind === 'offset') x.definition = { ...x.definition, distance: g.mm() };
      return x;
    case 'primitive':
      if (x.shape === 'cylinder') {
        if (g.rng() < 0.5) x.radius = g.mm();
        else x.height = g.mm();
      } else if (x.shape === 'box') x.dz = g.mm();
      else x.radius = g.mm();
      return x;
    default:
      return { ...x, suppressed: !x.suppressed };
  }
}

function newFeature(g: Gen): Feature {
  const fid = g.newId();
  const name = g.newName();
  switch (g.int(0, 2)) {
    case 0:
      return fillet(fid, name, g.mm());
    case 1:
      return {
        id: fid,
        type: 'plane',
        name,
        suppressed: false,
        definition: { kind: 'offset', from: ref('origin:XY'), distance: g.mm() },
      };
    default:
      return {
        id: fid,
        type: 'primitive',
        name,
        suppressed: false,
        shape: 'box',
        op: 'add',
        dx: g.mm(),
        dy: g.mm(),
        dz: g.mm(),
      };
  }
}

function randomCommand(g: Gen, doc: WrenDoc): Command | null {
  const hot = g.focus && g.rng() < 0.8;
  const part = hot
    ? (doc.parts.find((p) => p.id === PART) ?? g.pick(doc.parts))
    : g.pick(doc.parts);
  const hotFeatures = part?.features.filter((f) => HOT.has(f.id)) ?? [];
  const feature = part
    ? g.pick(hot && hotFeatures.length ? hotFeatures : part.features)
    : undefined;
  const param = hot
    ? (doc.params.find((p) => p.id === P_WIDTH) ?? g.pick(doc.params))
    : g.pick(doc.params);
  if (hot && part && g.rng() < 0.25) {
    const any = g.pick(part.features);
    return any
      ? {
          kind: 'moveFeature',
          partId: part.id,
          featureId: any.id,
          toIndex: g.int(0, part.features.length - 1),
        }
      : null;
  }
  switch (g.int(0, 15)) {
    case 0:
    case 1:
    case 2:
      return part && feature
        ? {
            kind: 'updateFeature',
            partId: part.id,
            featureId: feature.id,
            feature: editFeature(g, feature),
          }
        : null;
    case 3:
      return part
        ? {
            kind: 'addFeature',
            partId: part.id,
            feature: newFeature(g),
            ...(g.rng() < 0.6 ? { index: g.int(0, part.rollbackIndex) } : {}),
          }
        : null;
    case 4:
      return part && feature
        ? { kind: 'removeFeature', partId: part.id, featureId: feature.id }
        : null;
    case 5:
      return part && feature
        ? {
            kind: 'moveFeature',
            partId: part.id,
            featureId: feature.id,
            toIndex: g.int(0, part.features.length - 1),
          }
        : null;
    case 6:
      return part && feature
        ? {
            kind: 'setSuppressed',
            partId: part.id,
            featureId: feature.id,
            suppressed: !feature.suppressed,
          }
        : null;
    case 7:
      return part
        ? { kind: 'setRollback', partId: part.id, index: g.int(0, part.features.length) }
        : null;
    case 8:
      return { kind: 'addParam', param: { id: g.newId(), name: g.newName(), expr: g.mm() } };
    case 9:
      return param ? { kind: 'updateParam', paramId: param.id, expr: g.mm() } : null;
    case 10:
      return param
        ? g.rng() < 0.5
          ? { kind: 'updateParam', paramId: param.id, name: g.newName() }
          : {
              kind: 'updateParam',
              paramId: param.id,
              description: g.rng() < 0.3 ? '' : g.newName(),
            }
        : null;
    case 11:
      return param ? { kind: 'removeParam', paramId: param.id } : null;
    case 12:
      return part ? { kind: 'renamePart', partId: part.id, name: g.newName() } : null;
    case 13:
      if (!part) return null;
      if (g.rng() < 0.2) return { kind: 'setMaterial', partId: part.id, material: null };
      return g.rng() < 0.5
        ? {
            kind: 'setMaterial',
            partId: part.id,
            material: { libraryId: 'whittle:pla', name: 'PLA', density: '1.24 g/cm^3' },
          }
        : {
            kind: 'setMaterial',
            partId: part.id,
            material: {
              ...(part.material ?? { name: 'Steel', density: '7.85 g/cm^3' }),
              density: `${g.int(1, 9)} g/cm^3`,
            },
          };
    case 14:
      if (g.rng() < 0.5) return { kind: 'setDocName', name: g.newName() };
      return part
        ? {
            kind: 'patch',
            ops: [
              {
                op: 'add',
                path: `/parts/${doc.parts.indexOf(part as Part)}/color`,
                value: `#${g.int(0x100000, 0xffffff).toString(16)}`,
              },
            ],
          }
        : null;
    default: {
      const pid = g.newId();
      return {
        kind: 'addPart',
        part: { id: pid, name: g.newName(), features: [newFeature(g)], rollbackIndex: 1 },
      };
    }
  }
}

function edits(
  g: Gen,
  base: WrenDoc,
  count: number,
  prefix: Command[] = [],
): { doc: WrenDoc; cmds: Command[] } {
  let doc = apply(base, ...prefix);
  const cmds = [...prefix];
  let tries = 0;
  while (cmds.length < count + prefix.length && tries++ < 50) {
    const cmd = randomCommand(g, doc);
    if (!cmd) continue;
    try {
      doc = apply(doc, cmd);
      cmds.push(cmd);
    } catch {
      // The command doesn't apply here (e.g. a move blocked by a reference): draw another.
    }
  }
  const minutes = g.int(1, 600);
  const modified = new Date(Date.parse(base.meta.modified) + minutes * 60_000).toISOString();
  doc = { ...doc, meta: { ...doc.meta, modified } };
  return { doc, cmds };
}

// ---------------------------------------------------------------------------------------------
// Oracle: flatten a document to id-path → leaf, independent of the merger's walk
// ---------------------------------------------------------------------------------------------

const SKIP = new Set(['/meta/modified', '/meta/created', '/meta/app']);

function flatten(doc: WrenDoc): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (segs: string[], v: unknown): void => {
    const ptr = toPointer(segs);
    if (SKIP.has(ptr)) return;
    if (segs.length === 3 && segs[0] === 'parts' && segs[2] === 'rollbackIndex') return;
    if (isCollectionPath(segs) && Array.isArray(v)) {
      out.set(`${ptr}/@order`, JSON.stringify(idsOf(v)));
      for (const item of v) {
        const iid = (item as { id: string }).id;
        out.set(toPointer([...segs, iid]), '@present');
        walk([...segs, iid], item);
      }
      return;
    }
    if (isObj(v) && !isEntityRef(v)) {
      if (segs.length === 2 && segs[0] === 'parts') out.set(`${ptr}/@bar`, String(barIdOf(v)));
      for (const k of Object.keys(v)) if (v[k] !== undefined) walk([...segs, k], v[k]);
      return;
    }
    out.set(ptr, JSON.stringify(v));
  };
  walk([], doc);
  return out;
}

const covered = (conflicts: readonly MergeConflict[], ptr: string) =>
  conflicts.some((c) => ptr === c.path || ptr.startsWith(`${c.path}/`));

function collectionAt(doc: WrenDoc, ptr: string): string[] | undefined {
  const flat = flatten(doc).get(`${ptr}/@order`);
  return flat === undefined ? undefined : (JSON.parse(flat) as string[]);
}

/** Every change `side` made relative to `base` is in `merged` or covered by a conflict. */
function lostEdits(
  base: WrenDoc,
  ours: WrenDoc,
  theirs: WrenDoc,
  side: WrenDoc,
  r: MergeResult,
): string[] {
  const fb = flatten(base);
  const fs = flatten(side);
  const fm = flatten(r.doc);
  const lost: string[] = [];
  for (const k of new Set([...fb.keys(), ...fs.keys()])) {
    if (fb.get(k) === fs.get(k)) continue;
    if (k.endsWith('/@order')) {
      const coll = k.slice(0, -'/@order'.length);
      const [b, o, t, s, m] = [base, ours, theirs, side, r.doc].map((d) => collectionAt(d, coll));
      if (!b || !o || !t || !s || !m) continue;
      const common = new Set(b.filter((x) => o.includes(x) && t.includes(x)));
      const only = (xs: string[]) => xs.filter((x) => common.has(x));
      if (JSON.stringify(only(s)) === JSON.stringify(only(b))) continue; // no reorder by side
      if (JSON.stringify(only(m)) === JSON.stringify(only(s)) || covered(r.conflicts, coll))
        continue;
      lost.push(`${k}: order ${JSON.stringify(only(s))} lost`);
      continue;
    }
    if (k.endsWith('/@bar')) {
      const part = k.slice(0, -'/@bar'.length);
      const bar = fs.get(k);
      if (
        fm.get(k) === bar ||
        covered(r.conflicts, `${part}/rollbackIndex`) ||
        covered(r.conflicts, part)
      )
        continue;
      if (bar !== undefined && bar !== 'null' && !fm.has(`${part}/features/${bar}`)) continue; // that feature is gone
      if (!fm.has(part)) continue; // the part is gone
      lost.push(`${k}: bar ${bar} became ${fm.get(k)}`);
      continue;
    }
    if (fm.get(k) === fs.get(k) || covered(r.conflicts, k)) continue;
    lost.push(`${k}: ${fs.get(k) ?? '(deleted)'} became ${fm.get(k) ?? '(absent)'}`);
  }
  return lost;
}

function invented(ours: WrenDoc, theirs: WrenDoc, r: MergeResult): string[] {
  const [fo, ft] = [flatten(ours), flatten(theirs)];
  const out: string[] = [];
  for (const [k, v] of flatten(r.doc)) {
    if (k.endsWith('/@order') || k.endsWith('/@bar')) continue;
    if (fo.get(k) !== v && ft.get(k) !== v) out.push(`${k} = ${v}`);
  }
  return out;
}

const key = (c: MergeConflict, swap: boolean) =>
  JSON.stringify([
    c.id,
    c.kind,
    c.path,
    c.base,
    swap ? c.theirs : c.ours,
    swap ? c.ours : c.theirs,
  ]);

// ---------------------------------------------------------------------------------------------

const SEED = Number(process.env.FUZZ_SEED ?? 2025);
const PAIRS = 1000;

describe('DocMerger fuzz', () => {
  it(`never loses an edit over ${PAIRS} random concurrent edit pairs (seed ${SEED})`, () => {
    const base = baseDoc();
    expect(problems(base)).toEqual([]);
    const stats = {
      conflicts: 0,
      clean: 0,
      edits: 0,
      kinds: new Map<string, number>(),
      conflictKinds: new Map<string, number>(),
    };
    for (let pair = 0; pair < PAIRS; pair++) {
      const rng = mulberry32(SEED * 1_000_003 + pair);
      const focus = rng() < 0.4;
      const go = new Gen(rng, 'o', 100_000, focus);
      const gt = new Gen(rng, 't', 200_000, focus);
      const ours = edits(go, base, go.int(1, 4));
      // Sometimes both sides make the same first edit (the same command, the same ids).
      const shared = rng() < 0.1 ? ours.cmds.slice(0, 1) : [];
      const theirs = edits(gt, base, gt.int(1, 4), shared);
      const o = ours.doc;
      const t = theirs.doc;
      const where = `pair ${pair} (seed ${SEED})\nours: ${JSON.stringify(ours.cmds)}\ntheirs: ${JSON.stringify(theirs.cmds)}`;
      stats.edits += ours.cmds.length + theirs.cmds.length;
      for (const cmd of [...ours.cmds, ...theirs.cmds])
        stats.kinds.set(cmd.kind, (stats.kinds.get(cmd.kind) ?? 0) + 1);
      expect(problems(o), where).toEqual([]);
      expect(problems(t), where).toEqual([]);

      const r = docMerger.merge(base, o, t);
      expect(problems(r.doc), where).toEqual([]);
      expect(lostEdits(base, o, t, o, r), `ours lost\n${where}`).toEqual([]);
      expect(lostEdits(base, o, t, t, r), `theirs lost\n${where}`).toEqual([]);
      expect(invented(o, t, r), where).toEqual([]);

      // Identities.
      const xx = docMerger.merge(base, o, o);
      expect(xx.conflicts, where).toEqual([]);
      expect(canonicalJson(xx.doc), where).toBe(canonicalJson(o));
      expect(canonicalJson(docMerger.merge(base, base, t).doc), where).toBe(canonicalJson(t));
      expect(canonicalJson(docMerger.merge(base, o, base).doc), where).toBe(canonicalJson(o));

      // Symmetry.
      const s = docMerger.merge(base, t, o);
      expect(r.conflicts.map((c) => key(c, false)).sort(), where).toEqual(
        s.conflicts.map((c) => key(c, true)).sort(),
      );
      if (r.conflicts.length === 0) {
        stats.clean++;
        expect(canonicalJson(r.doc), where).toBe(canonicalJson(s.doc));
      } else {
        stats.conflicts++;
        for (const c of r.conflicts)
          stats.conflictKinds.set(c.kind, (stats.conflictKinds.get(c.kind) ?? 0) + 1);
        const all = (take: 'ours' | 'theirs') =>
          r.conflicts.map((c) => ({ conflictId: c.id, take }));
        const toTheirs = docMerger.resolve(r, all('theirs'));
        expect(canonicalJson(toTheirs), where).toBe(canonicalJson(s.doc));
        expect(canonicalJson(docMerger.resolve(r, all('ours'))), where).toBe(canonicalJson(r.doc));
        // Without its inputs (cloned across a worker), resolving still yields a valid document.
        expect(problems(docMerger.resolve(structuredClone(r), all('theirs'))), where).toEqual([]);
        expect(
          problems(
            docMerger.resolve(
              r,
              r.conflicts.map((c) => ({ conflictId: c.id, take: 'base' as const })),
            ),
          ),
          where,
        ).toEqual([]);
      }
    }
    // The generator must exercise both outcomes and the whole command set.
    expect(stats.clean).toBeGreaterThan(200);
    expect(stats.conflicts).toBeGreaterThan(150);
    for (const k of ['bothModified', 'modifiedDeleted', 'bothAdded', 'order']) {
      expect(stats.conflictKinds.get(k) ?? 0, k).toBeGreaterThan(5);
    }
    console.info(
      `fuzz: ${PAIRS} pairs, ${stats.edits} edits, ${stats.clean} clean, ${stats.conflicts} with conflicts ${JSON.stringify(Object.fromEntries(stats.conflictKinds))}`,
    );
    for (const k of [
      'updateFeature',
      'addFeature',
      'removeFeature',
      'moveFeature',
      'setRollback',
      'addParam',
      'updateParam',
      'removeParam',
      'addPart',
      'setMaterial',
      'patch',
    ]) {
      expect(stats.kinds.get(k) ?? 0, k).toBeGreaterThan(20);
    }
  }, 120_000);
});
