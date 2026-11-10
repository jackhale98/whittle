// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M3.6 fuzz: random concurrent edits of feature tree folders and sketch visibility (made with the
 * document commands, so membership follows edits as in the app), merged three-way. For every pair:
 *  - the merged and resolved documents are valid and every folder is a contiguous,
 *    non-overlapping run (ADR-066);
 *  - merge(b, x, x) = x and merge(b, b, x) = merge(b, x, b) = x;
 *  - symmetry: swapping ours and theirs swaps the conflicts; without conflicts the documents and
 *    the merge notes are equal;
 *  - no folder rename or new member is lost without a conflict or a merge note that says so;
 *  - nothing is invented: every merged folder and folder name is ours' or theirs'.
 * Seeded (`FUZZ_SEED`, default 2025) so a failure names a reproducible pair.
 */

import type { Command, FeatureFolder, MergeConflict, Part, WrenDoc } from '@wren-cad/contracts';
import { canonicalJson } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import { docMerger, mergeNotes } from '../src';
import {
  apply,
  baseDoc,
  CHAMFER,
  FILLET,
  fillet,
  id,
  PART,
  PLANE,
  problems,
  SKETCH,
} from './support/fixtures';
import { folder, folderProblems, withFolders } from './support/folders';

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

const MOUNTING = id(60);
const VIS = ['auto', 'shown', 'hidden'] as const;

class Gen {
  private n = 0;
  constructor(
    readonly rng: () => number,
    private readonly side: 'o' | 't',
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
  newName(): string {
    return `${this.side}_${this.n++}`;
  }
}

const partOf = (doc: WrenDoc): Part => doc.parts.find((p) => p.id === PART) as Part;

/** A run of features in no folder, or null. */
function freeRun(g: Gen, part: Part): string[] | null {
  const held = new Set((part.folders ?? []).flatMap((f) => f.features));
  const ids = part.features.map((f) => f.id);
  const start = g.int(0, ids.length - 1);
  const len = g.int(1, 3);
  const run = ids.slice(start, start + len);
  return run.length > 0 && run.every((x) => !held.has(x)) ? run : null;
}

function randomCommand(g: Gen, doc: WrenDoc): Command | null {
  const part = partOf(doc);
  const folders = part.folders ?? [];
  const f = g.pick(folders);
  const feature = g.pick(part.features);
  switch (g.int(0, 10)) {
    case 0:
    case 1:
      return f ? { kind: 'renameFolder', partId: PART, folderId: f.id, name: g.newName() } : null;
    case 2: {
      const run = freeRun(g, part);
      return run
        ? {
            kind: 'addFolder',
            partId: PART,
            folder: { id: g.newId(), name: g.newName(), features: run },
          }
        : null;
    }
    case 3:
      return f && g.rng() < 0.5 ? { kind: 'removeFolder', partId: PART, folderId: f.id } : null;
    case 4:
      return f
        ? {
            kind: 'moveFolder',
            partId: PART,
            folderId: f.id,
            toIndex: g.int(0, part.features.length - f.features.length),
          }
        : null;
    case 5:
    case 6:
      return feature
        ? {
            kind: 'moveFeature',
            partId: PART,
            featureId: feature.id,
            toIndex: g.int(0, part.features.length - 1),
          }
        : null;
    case 7:
      return feature && g.rng() < 0.5
        ? { kind: 'removeFeature', partId: PART, featureId: feature.id }
        : null;
    case 8:
      return {
        kind: 'addFeature',
        partId: PART,
        feature: fillet(g.newId(), g.newName(), `${g.int(1, 9)}mm`),
        index: g.int(2, part.features.length),
      };
    case 9:
      return part.features.some((x) => x.id === SKETCH)
        ? {
            kind: 'setSketchVisibility',
            partId: PART,
            featureIds: [SKETCH],
            visibility: g.pick(VIS) as (typeof VIS)[number],
          }
        : null;
    default:
      return { kind: 'renamePart', partId: PART, name: g.newName() };
  }
}

function edits(g: Gen, base: WrenDoc, count: number): { doc: WrenDoc; cmds: Command[] } {
  let doc = base;
  const cmds: Command[] = [];
  let tries = 0;
  while (cmds.length < count && tries++ < 60) {
    const cmd = randomCommand(g, doc);
    if (!cmd) continue;
    try {
      const next = apply(doc, cmd);
      // The merge's inputs must be sound. See the `it.fails` below for the one known way the
      // commands break that today; skip such an edit rather than feed the merge a broken side.
      if (folderProblems(next).length > 0) continue;
      doc = next;
      cmds.push(cmd);
    } catch {
      // Not applicable here (a blocked move, a folder run in the way): draw another.
    }
  }
  return { doc, cmds };
}

const foldersOf = (d: WrenDoc): FeatureFolder[] => partOf(d)?.folders ?? [];
const byId = (d: WrenDoc) => new Map(foldersOf(d).map((f) => [f.id, f]));
/** A conflict on `ptr`, inside it (a folder's name) or around it (the whole part). */
const covered = (cs: readonly MergeConflict[], ptr: string) =>
  cs.some((c) => ptr === c.path || ptr.startsWith(`${c.path}/`) || c.path.startsWith(`${ptr}/`));

/** Folder edits of `side` that the merge dropped without a conflict or a note. */
function lostFolderEdits(
  base: WrenDoc,
  side: WrenDoc,
  other: WrenDoc,
  r: ReturnType<typeof docMerger.merge>,
): string[] {
  const [bm, sm, om, mm] = [byId(base), byId(side), byId(other), byId(r.doc)];
  const live = new Set(partOf(r.doc)?.features.map((f) => f.id) ?? []);
  const notes = mergeNotes(r);
  const ptr = (fid: string) => `/parts/${PART}/folders/${fid}`;
  const out: string[] = [];
  for (const [fid, f] of sm) {
    const b = bm.get(fid);
    const m = mm.get(fid);
    if (covered(r.conflicts, ptr(fid))) continue;
    const explained =
      notes.some((n) => n.change.folderId === fid && n.change.kind === 'removed') ||
      !f.features.some((x) => live.has(x));
    if (!m) {
      // Gone: deleted on the other side (only allowed quietly if side merely lost members).
      const shrunk = b && f.name === b.name && f.features.every((x) => b.features.includes(x));
      if (!explained && !(b && !om.has(fid) && shrunk)) out.push(`folder ${fid} (${f.name}) lost`);
      continue;
    }
    if (b && f.name !== b.name && m.name !== f.name) out.push(`rename of ${fid} to ${f.name} lost`);
    for (const x of f.features) {
      if (b?.features.includes(x) || !live.has(x) || m.features.includes(x)) continue;
      const noted = notes.some((n) => n.change.folderId === fid && n.change.featureIds.includes(x));
      if (!noted && !covered(r.conflicts, `/parts/${PART}/features`)) {
        out.push(`member ${x} of ${fid} lost`);
      }
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

const SEED = Number(process.env.FUZZ_SEED ?? 2025);
const PAIRS = 500;

describe('document commands keep folders sound (fuzz input)', () => {
  // Found by this fuzz (seeds 7 and 42): moving the only member of a one-feature folder strictly
  // inside another folder's run leaves the feature in both folders. A packages/document issue;
  // when it is fixed this test fails and should become a plain `it`.
  it.fails('moving a one-feature folder’s member into another run', () => {
    const base = withFolders(baseDoc(), [folder(MOUNTING, 'Mounting', [FILLET, CHAMFER])]);
    const doc = apply(
      base,
      { kind: 'addFolder', partId: PART, folder: folder(id(70), 'Datums', [PLANE]) },
      { kind: 'moveFeature', partId: PART, featureId: PLANE, toIndex: 3 },
    );
    expect(folderProblems(doc)).toEqual([]);
  });
});

describe('DocMerger fuzz: folders and sketch visibility', () => {
  it(`keeps folders whole over ${PAIRS} random concurrent edit pairs (seed ${SEED})`, () => {
    const base = withFolders(baseDoc(), [folder(MOUNTING, 'Mounting', [FILLET, CHAMFER])]);
    expect(problems(base)).toEqual([]);
    const stats = { clean: 0, conflicts: 0, notes: 0, kinds: new Map<string, number>() };
    for (let pair = 0; pair < PAIRS; pair++) {
      const rng = mulberry32(SEED * 1_000_003 + pair);
      const go = new Gen(rng, 'o', 100_000);
      const gt = new Gen(rng, 't', 200_000);
      const ours = edits(go, base, go.int(1, 4));
      const theirs = edits(gt, base, gt.int(1, 4));
      const [o, t] = [ours.doc, theirs.doc];
      const where = `pair ${pair} (seed ${SEED})\nours: ${JSON.stringify(ours.cmds)}\ntheirs: ${JSON.stringify(theirs.cmds)}`;
      for (const c of [...ours.cmds, ...theirs.cmds])
        stats.kinds.set(c.kind, (stats.kinds.get(c.kind) ?? 0) + 1);
      expect(folderProblems(o), where).toEqual([]);
      expect(folderProblems(t), where).toEqual([]);

      const r = docMerger.merge(base, o, t);
      expect(problems(r.doc), where).toEqual([]);
      expect(folderProblems(r.doc), where).toEqual([]);
      expect(lostFolderEdits(base, o, t, r), `ours lost\n${where}`).toEqual([]);
      expect(lostFolderEdits(base, t, o, r), `theirs lost\n${where}`).toEqual([]);

      // Nothing invented.
      const [om, tm] = [byId(o), byId(t)];
      for (const m of foldersOf(r.doc)) {
        const names = [om.get(m.id)?.name, tm.get(m.id)?.name];
        expect(names, `${where}\ninvented folder ${m.id}`).toContain(m.name);
      }

      // Identities.
      expect(canonicalJson(docMerger.merge(base, o, o).doc), where).toBe(canonicalJson(o));
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
        const text = (x: typeof r) =>
          mergeNotes(x)
            .map((n) => n.summary)
            .sort();
        expect(text(r), where).toEqual(text(s));
      } else {
        stats.conflicts++;
        for (const take of ['ours', 'theirs'] as const) {
          const doc = docMerger.resolve(
            r,
            r.conflicts.map((c) => ({ conflictId: c.id, take })),
          );
          expect(problems(doc), `${where}\nresolved ${take}`).toEqual([]);
          expect(folderProblems(doc), `${where}\nresolved ${take}`).toEqual([]);
          const byPath = docMerger.resolve(
            structuredClone(r),
            r.conflicts.map((c) => ({ conflictId: c.id, take })),
          );
          expect(folderProblems(byPath), `${where}\nresolved ${take} by path`).toEqual([]);
        }
        const all = docMerger.resolve(
          r,
          r.conflicts.map((c) => ({ conflictId: c.id, take: 'theirs' as const })),
        );
        expect(canonicalJson(all), where).toBe(canonicalJson(s.doc));
      }
      if (mergeNotes(r).length > 0) stats.notes++;
    }
    // The generator exercises what it should.
    for (const k of [
      'renameFolder',
      'addFolder',
      'removeFolder',
      'moveFolder',
      'moveFeature',
      'setSketchVisibility',
    ]) {
      expect(stats.kinds.get(k) ?? 0, k).toBeGreaterThan(20);
    }
    expect(stats.clean).toBeGreaterThan(PAIRS / 4);
    expect(stats.conflicts).toBeGreaterThan(10);
    expect(stats.notes).toBeGreaterThan(0);
  });
});
