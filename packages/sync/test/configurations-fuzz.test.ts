// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M3.7 fuzz: random concurrent edits of part configurations (cells set and reset, renames, adds
 * and deletes, the active configuration, features and parameters deleted with their overrides),
 * merged three-way. For every pair:
 *  - the merged and resolved documents are valid, and no override or active configuration points
 *    at something that is gone;
 *  - merge(b, x, x) = x and merge(b, b, x) = merge(b, x, b) = x;
 *  - symmetry: swapping ours and theirs swaps the conflicts; without conflicts the documents and
 *    the merge notes are equal; taking theirs everywhere gives the swapped merge;
 *  - no cell edit, rename, new configuration or active switch is lost without a conflict or a
 *    merge note that says so;
 *  - nothing is invented: every merged cell is ours', theirs' or base's;
 *  - conflict, note and compare texts name things (no raw ids, no "undefined").
 * Seeded (`FUZZ_SEED`, default 2025) so a failure names a reproducible pair.
 */

import type { Configuration, Material, MergeConflict, WrenDoc } from '@wren-cad/contracts';
import { canonicalJson } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  type ConfigurationNote,
  cellsOf,
  conflictSummary,
  docDiffer,
  docMerger,
  mergeNotes,
} from '../src';
import {
  BRASS,
  configsOf,
  configured,
  danglingOverrides,
  editPart,
  LONG,
  P_SPARE,
  partOf,
  removeFeature,
  removeParam,
  STEEL,
} from './support/configurations';
import {
  baseDoc,
  CHAMFER,
  FILLET,
  id,
  P_DEPTH,
  P_WIDTH,
  PART,
  PLANE,
  problems,
} from './support/fixtures';

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
    private readonly offset: number,
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
}

// Small value pools so both sides often pick the same cell and sometimes the same value.
const EXPRS = ['30mm', '45mm', '55mm'];
const NAMES = ['Long', 'Short', 'Wide', 'Mid', 'Tall'];
const MATERIALS: (Material | null)[] = [STEEL, BRASS, null];
const FIELDS: [string, string, string[]][] = [
  [FILLET, '/radius', ['1mm', '3mm']],
  [CHAMFER, '/mode/distance', ['2mm', '0.5mm']],
  [PLANE, '/definition/distance', ['5mm', '8mm']],
];

type Op = { kind: string; detail: string };

/** One random configuration edit of `doc`, or null when it doesn't apply. */
function randomEdit(g: Gen, doc: WrenDoc): { doc: WrenDoc; op: Op } | null {
  const part = partOf(doc);
  const configs = part.configurations ?? [];
  const c = g.pick(configs);
  const features = new Set(part.features.map((f) => f.id));
  const params = doc.params.map((p) => p.id).filter((p) => [P_WIDTH, P_DEPTH, P_SPARE].includes(p));
  const op = (kind: string, detail = ''): Op => ({ kind, detail });
  const onConfig = (kind: string, edit: (x: Configuration) => void) =>
    c
      ? {
          doc: editPart(doc, (p) => {
            const x = p.configurations?.find((y) => y.id === c.id);
            if (x) edit(x);
          }),
          op: op(kind, c.id),
        }
      : null;
  switch (g.int(0, 15)) {
    case 0:
    case 1: {
      const pid = g.pick(params);
      const v = g.pick(EXPRS) as string;
      return pid
        ? onConfig('setParam', (x) => {
            x.params = { ...x.params, [pid]: v };
          })
        : null;
    }
    case 2: {
      const fid = g.pick([FILLET, CHAMFER, PLANE].filter((f) => features.has(f)));
      const v = g.rng() < 0.7;
      return fid
        ? onConfig('setSuppressed', (x) => {
            x.features ??= {};
            x.features[fid] = { ...x.features[fid], suppressed: v };
          })
        : null;
    }
    case 3: {
      const f = g.pick(FIELDS.filter(([fid]) => features.has(fid)));
      if (!f) return null;
      const [fid, ptr, values] = f;
      const v = g.pick(values) as string;
      return onConfig('setField', (x) => {
        x.features ??= {};
        const o = { ...x.features[fid] };
        o.fields = { ...o.fields, [ptr]: v };
        x.features[fid] = o;
      });
    }
    case 4: {
      const m = g.pick(MATERIALS);
      return onConfig('setMaterial', (x) => {
        x.material = structuredClone(m ?? null);
      });
    }
    case 5: {
      const pn = `BR-${g.int(1, 3)}`;
      return g.rng() < 0.5
        ? onConfig('setProperty', (x) => {
            x.properties = { ...x.properties, partNumber: pn };
          })
        : onConfig('setColor', (x) => {
            x.color = g.pick(['#ff0000', '#00ff00']) as string;
          });
    }
    case 6:
    case 7: {
      const cell = g.pick(cellsOf(c));
      if (!c || !cell) return null;
      return onConfig('resetCell', (x) => {
        let node = x as unknown as Record<string, unknown>;
        for (const s of cell.rel.slice(0, -1)) node = node[s] as Record<string, unknown>;
        delete node[cell.rel[cell.rel.length - 1] as string];
      });
    }
    case 8: {
      const used = new Set(configs.map((x) => x.name));
      const name = g.pick(NAMES.filter((n) => !used.has(n)));
      return name
        ? onConfig('rename', (x) => {
            x.name = name;
          })
        : null;
    }
    case 9: {
      const used = new Set(configs.map((x) => x.name));
      const name = g.pick(NAMES.filter((n) => !used.has(n)));
      if (!name) return null;
      const added: Configuration = { id: g.newId(), name };
      if (g.rng() < 0.5) added.params = { [P_WIDTH]: g.pick(EXPRS) as string };
      return {
        doc: editPart(doc, (p) => {
          p.configurations = [...(p.configurations ?? []), added];
        }),
        op: op('addConfiguration', name),
      };
    }
    case 10:
      return c && g.rng() < 0.6
        ? {
            doc: editPart(doc, (p) => {
              p.configurations = (p.configurations ?? []).filter((x) => x.id !== c.id);
              if (p.activeConfigurationId === c.id) delete p.activeConfigurationId;
            }),
            op: op('removeConfiguration', c.id),
          }
        : null;
    case 11:
    case 14:
    case 15: {
      const to = g.pick([undefined, ...configs.map((x) => x.id)]);
      return {
        doc: editPart(doc, (p) => {
          if (to === undefined) delete p.activeConfigurationId;
          else p.activeConfigurationId = to;
        }),
        op: op('setActive', to ?? 'Default'),
      };
    }
    case 12: {
      if (g.rng() < 0.5) {
        return params.includes(P_SPARE)
          ? { doc: removeParam(doc, P_SPARE), op: op('removeParam') }
          : null;
      }
      const fid = g.pick([FILLET, CHAMFER, PLANE].filter((f) => features.has(f)));
      return fid && g.rng() < 0.6
        ? { doc: removeFeature(doc, fid), op: op('removeFeature', fid) }
        : null;
    }
    default:
      return {
        doc: editPart(doc, (p) => {
          p.properties = { ...p.properties, description: `Bracket ${g.int(1, 3)}` };
        }),
        op: op('setPartProperties'),
      };
  }
}

function edits(g: Gen, base: WrenDoc, count: number): { doc: WrenDoc; ops: Op[] } {
  let doc = base;
  const ops: Op[] = [];
  let tries = 0;
  while (ops.length < count && tries++ < 60) {
    try {
      const next = randomEdit(g, doc);
      if (!next) continue;
      doc = next.doc;
      ops.push(next.op);
    } catch {
      // Not applicable here (a feature something depends on): draw another.
    }
  }
  return { doc, ops };
}

/** Every cell of every configuration, keyed `cid json(rel)`. */
function cellMap(doc: WrenDoc): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const c of configsOf(doc)) {
    for (const cell of cellsOf(c)) m.set(`${c.id} ${JSON.stringify(cell.rel)}`, cell.value);
  }
  return m;
}

const pointerOf = (cid: string, rel: readonly string[]) =>
  `/parts/${PART}/configurations/${[cid, ...rel].map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;

/** A conflict on `ptr`, inside it or around it (the whole configuration, the whole part). */
const covered = (cs: readonly MergeConflict[], ptr: string) =>
  cs.some((c) => ptr === c.path || ptr.startsWith(`${c.path}/`) || c.path.startsWith(`${ptr}/`));

/** Configuration edits of `side` the merge dropped without a conflict or a note. */
function lostEdits(base: WrenDoc, side: WrenDoc, r: ReturnType<typeof docMerger.merge>): string[] {
  const out: string[] = [];
  const notes = mergeNotes(r).filter((n): n is ConfigurationNote => n.kind !== 'folderMembership');
  const pruned = (cid: string, target: string) =>
    notes.some(
      (n) =>
        n.kind === 'configurationOverridesRemoved' &&
        n.configurationIds.includes(cid) &&
        n.targetId === target,
    );
  const [bc, sc, mc] = [cellMap(base), cellMap(side), cellMap(r.doc)];
  const equalJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of new Set([...bc.keys(), ...sc.keys()])) {
    const [b, s, m] = [bc.get(key), sc.get(key), mc.get(key)];
    if (equalJson(b, s) || equalJson(s, m)) continue;
    const [cid, relJson] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const rel = JSON.parse(relJson) as string[];
    if (covered(r.conflicts, pointerOf(cid, rel))) continue;
    if (rel[0] === 'features' || rel[0] === 'params') {
      if (pruned(cid, rel[1] as string)) continue;
    }
    // The other side deleted the whole configuration and this side didn't touch it otherwise.
    out.push(`cell ${key}: ${JSON.stringify(s)} → merged ${JSON.stringify(m)}`);
  }
  const [bm, sm, mm] = [configsOf(base), configsOf(side), configsOf(r.doc)].map(
    (l) => new Map(l.map((c) => [c.id, c])),
  );
  for (const [cid, c] of sm ?? []) {
    const b = bm?.get(cid);
    const m = mm?.get(cid);
    if (covered(r.conflicts, pointerOf(cid, []))) continue;
    if (!b && !m) out.push(`new configuration ${c.name} lost`);
    if (b && m && c.name !== b.name && m.name !== c.name) out.push(`rename to ${c.name} lost`);
  }
  const [ba, sa, ma] = [base, side, r.doc].map((d) => partOf(d).activeConfigurationId);
  if (sa !== ba && ma !== sa) {
    const fallback = notes.some((n) => n.kind === 'activeConfigurationFallback');
    if (!fallback && !covered(r.conflicts, `/parts/${PART}/activeConfigurationId`)) {
      out.push(`active ${sa} lost`);
    }
  }
  return out;
}

/** Merged cells that no version has. */
function invented(base: WrenDoc, o: WrenDoc, t: WrenDoc, merged: WrenDoc): string[] {
  const maps = [cellMap(base), cellMap(o), cellMap(t)];
  const out: string[] = [];
  for (const [key, v] of cellMap(merged)) {
    if (!maps.some((m) => m.has(key) && JSON.stringify(m.get(key)) === JSON.stringify(v))) {
      out.push(key);
    }
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

const readable = (texts: readonly string[]) =>
  texts.filter((t) => /01J\d{10}|undefined|\[object/.test(t));

const SEED = Number(process.env.FUZZ_SEED ?? 2025);
const PAIRS = 400;

describe('DocMerger fuzz: part configurations', () => {
  it(`merges configurations by cell over ${PAIRS} random concurrent edit pairs (seed ${SEED})`, () => {
    const base = editPart(configured(baseDoc()), (p) => {
      p.activeConfigurationId = LONG;
    });
    expect(problems(base)).toEqual([]);
    const stats = {
      clean: 0,
      conflicts: 0,
      notes: new Map<string, number>(),
      ops: new Map<string, number>(),
    };
    for (let pair = 0; pair < PAIRS; pair++) {
      const rng = mulberry32(SEED * 1_000_003 + pair);
      const go = new Gen(rng, 300_000);
      const gt = new Gen(rng, 400_000);
      const ours = edits(go, base, go.int(1, 5));
      const theirs = edits(gt, base, gt.int(1, 5));
      const [o, t] = [ours.doc, theirs.doc];
      const where = `pair ${pair} (seed ${SEED})\nours: ${JSON.stringify(ours.ops)}\ntheirs: ${JSON.stringify(theirs.ops)}`;
      for (const x of [...ours.ops, ...theirs.ops])
        stats.ops.set(x.kind, (stats.ops.get(x.kind) ?? 0) + 1);
      expect(problems(o), where).toEqual([]);
      expect(problems(t), where).toEqual([]);

      const r = docMerger.merge(base, o, t);
      expect(problems(r.doc), where).toEqual([]);
      expect(danglingOverrides(r.doc), where).toEqual([]);
      expect(lostEdits(base, o, r), `ours lost\n${where}`).toEqual([]);
      expect(lostEdits(base, t, r), `theirs lost\n${where}`).toEqual([]);
      expect(invented(base, o, t, r.doc), `invented\n${where}`).toEqual([]);
      const texts = [
        ...r.conflicts.map(conflictSummary),
        ...mergeNotes(r).map((n) => n.summary),
        ...docDiffer.diff(base, r.doc).map((c) => c.summary),
      ];
      expect(readable(texts), where).toEqual([]);

      // Identities.
      expect(canonicalJson(docMerger.merge(base, o, o).doc), where).toBe(canonicalJson(o));
      expect(canonicalJson(docMerger.merge(base, base, t).doc), where).toBe(canonicalJson(t));
      expect(canonicalJson(docMerger.merge(base, o, base).doc), where).toBe(canonicalJson(o));

      // Symmetry.
      const s = docMerger.merge(base, t, o);
      expect(r.conflicts.map((c) => key(c, false)).sort(), where).toEqual(
        s.conflicts.map((c) => key(c, true)).sort(),
      );
      const noteText = (x: typeof r) =>
        mergeNotes(x)
          .map((n) => n.summary)
          .sort();
      if (r.conflicts.length === 0) {
        stats.clean++;
        expect(canonicalJson(r.doc), where).toBe(canonicalJson(s.doc));
        expect(noteText(r), where).toEqual(noteText(s));
      } else {
        stats.conflicts++;
        for (const take of ['ours', 'theirs'] as const) {
          const choices = r.conflicts.map((c) => ({ conflictId: c.id, take }));
          const doc = docMerger.resolve(r, choices);
          expect(problems(doc), `${where}\nresolved ${take}`).toEqual([]);
          expect(danglingOverrides(doc), `${where}\nresolved ${take}`).toEqual([]);
          const byPath = docMerger.resolve(structuredClone(r), choices);
          expect(problems(byPath), `${where}\nresolved ${take} by path`).toEqual([]);
          expect(danglingOverrides(byPath), `${where}\nresolved ${take} by path`).toEqual([]);
        }
        const all = docMerger.resolve(
          r,
          r.conflicts.map((c) => ({ conflictId: c.id, take: 'theirs' as const })),
        );
        expect(canonicalJson(all), where).toBe(canonicalJson(s.doc));
      }
      for (const n of mergeNotes(r)) stats.notes.set(n.kind, (stats.notes.get(n.kind) ?? 0) + 1);
    }
    // The generator exercises what it should.
    for (const k of [
      'setParam',
      'setSuppressed',
      'setField',
      'setMaterial',
      'resetCell',
      'rename',
      'addConfiguration',
      'removeConfiguration',
      'setActive',
      'removeFeature',
      'removeParam',
    ]) {
      expect(stats.ops.get(k) ?? 0, k).toBeGreaterThan(20);
    }
    expect(stats.clean).toBeGreaterThan(PAIRS / 5);
    expect(stats.conflicts).toBeGreaterThan(PAIRS / 5);
    for (const k of [
      'configurationOverridesRemoved',
      'configurationDuplicateName',
      'activeConfigurationFallback',
    ]) {
      expect(stats.notes.get(k) ?? 0, k).toBeGreaterThan(0);
    }
  }, 60_000);
});
