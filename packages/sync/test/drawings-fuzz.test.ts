// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M4 fuzz: random concurrent edits of part annotations and a drawing (annotations added, edited
 * and removed; placements added, moved and removed; views added and removed; notes and markup
 * added), merged three-way. For every pair:
 *  - unordered collections never give an `order` conflict, and are written sorted by id;
 *  - the merge is deterministic (same bytes twice) and symmetric: swapping the sides swaps the
 *    conflicts, and without conflicts the documents are byte-equal; taking theirs everywhere
 *    gives the swapped merge;
 *  - the merged and resolved documents are valid, and no placement, mark or override points at
 *    something that is gone;
 *  - nothing is lost silently: an annotation or placement a side has that the merge lacks was
 *    deleted by the other side unchanged, or is named by a conflict (or its dependents) or a note;
 *  - adds only: no conflicts at all, and every add is in the result unless a note names it.
 * Seeded (`FUZZ_SEED`, default 2026) so a failure names a reproducible pair.
 */

import type {
  Annotation,
  AnnotationPlacement,
  Command,
  MergeConflict,
  WrenDoc,
} from '@wren-cad/contracts';
import { canonicalJson } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  conflictSummary,
  docDiffer,
  docMerger,
  mergeNotes,
  type StructuralMergeConflict,
} from '../src';
import { DRAWING, drawingDoc, drawingOf, markup, S1, S2, V_FRONT } from './support/drawings';
import { apply, EXTRUDE, id, PART, problems, ref } from './support/fixtures';

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

const SEED = Number(process.env.FUZZ_SEED ?? 2026);
const PAIRS = 160;

type Rand = () => number;
const pick = <T>(rand: Rand, list: readonly T[]): T | undefined =>
  list.length === 0 ? undefined : list[Math.floor(rand() * list.length)];

const part = (doc: WrenDoc) => doc.parts.find((p) => p.id === PART);
const annotationsOf = (doc: WrenDoc): Annotation[] => part(doc)?.annotations ?? [];

function newAnnotation(rand: Rand, aid: string): Annotation {
  const r = rand();
  if (r < 0.4) {
    return {
      id: aid,
      kind: 'note',
      origin: { kind: 'model' },
      refs: [ref(`F${EXTRUDE}:end`)],
      text: `N${aid.slice(-3)}`,
    };
  }
  if (r < 0.6) {
    return {
      id: aid,
      kind: 'datumFeature',
      origin: { kind: 'model' },
      refs: [ref(`F${EXTRUDE}:start`)],
      label: pick(rand, ['B', 'C']) as string,
    };
  }
  return {
    id: aid,
    kind: 'diameter',
    origin: { kind: 'model' },
    refs: [ref(`F${EXTRUDE}:side`)],
    nominal: `${1 + Math.floor(rand() * 9)}mm`,
  };
}

/** One random command against `doc`, or `null` when there is nothing to do. */
function randomCommand(
  rand: Rand,
  doc: WrenDoc,
  next: () => string,
  addsOnly: boolean,
): Command | null {
  const d = drawingOf(doc);
  const annotations = annotationsOf(doc);
  const ops = addsOnly
    ? ['addAnnotation', 'place', 'place', 'addView', 'note', 'markup']
    : [
        'addAnnotation',
        'place',
        'place',
        'addView',
        'note',
        'markup',
        'editAnnotation',
        'movePlacement',
        'removePlacement',
        'removeAnnotation',
        'removeView',
        'editView',
        'removeSheet',
      ];
  switch (pick(rand, ops)) {
    case 'addAnnotation': {
      const annotation = newAnnotation(rand, next());
      if (rand() < 0.5) return { kind: 'addAnnotation', partId: PART, annotation };
      const view = pick(rand, d.views);
      if (!view) return { kind: 'addAnnotation', partId: PART, annotation };
      const placement: AnnotationPlacement = {
        id: next(),
        viewId: view.id,
        annotationId: annotation.id,
        layout: { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [5, 5] },
      };
      return { kind: 'placeAnnotations', drawingId: DRAWING, items: [{ placement, annotation }] };
    }
    case 'place': {
      const a = pick(rand, annotations);
      const view = pick(rand, d.views);
      if (!a || !view) return null;
      if (d.placements.some((p) => p.viewId === view.id && p.annotationId === a.id)) return null;
      const placement: AnnotationPlacement = {
        id: next(),
        viewId: view.id,
        annotationId: a.id,
        layout: { kind: 'lane', side: pick(rand, ['top', 'bottom'] as const) ?? 'top', lane: 0 },
      };
      return {
        kind: 'placeAnnotations',
        drawingId: DRAWING,
        items: [{ placement }],
        allowDuplicate: true,
      };
    }
    case 'addView': {
      const parent = d.views.find((v) => v.id === V_FRONT) ?? pick(rand, d.views);
      const vid = next();
      if (!parent || rand() < 0.3) {
        return {
          kind: 'addView',
          drawingId: DRAWING,
          view: {
            id: vid,
            sheetId: pick(rand, [S1, S2]) as string,
            kind: 'base',
            orientation: { kind: 'named', name: 'right' },
            layout: { kind: 'free', position: [50 + Math.floor(rand() * 100), 60] },
          },
        };
      }
      return {
        kind: 'addView',
        drawingId: DRAWING,
        view: {
          id: vid,
          sheetId: parent.sheetId,
          kind: 'iso',
          parentId: parent.id,
          corner: 'topRight',
          layout: { kind: 'free', position: [300, 50 + Math.floor(rand() * 100)] },
        },
      };
    }
    case 'note':
      return {
        kind: 'addSheetNote',
        drawingId: DRAWING,
        note: { id: next(), sheetId: S1, position: [10, 10], text: 'NOTE' },
      };
    case 'markup':
      return { kind: 'addMarkup', drawingId: DRAWING, markup: markup(next(), 'Fuzz') };
    case 'editAnnotation': {
      const a = pick(rand, annotations);
      if (!a) return null;
      const changed = { ...a, suppressed: !a.suppressed } as Annotation;
      if (a.kind === 'diameter' && rand() < 0.6) {
        (changed as { nominal?: string }).nominal = `${10 + Math.floor(rand() * 9)}mm`;
        changed.suppressed = a.suppressed;
      }
      return { kind: 'updateAnnotation', partId: PART, annotationId: a.id, annotation: changed };
    }
    case 'movePlacement': {
      const p = pick(rand, d.placements);
      if (!p) return null;
      const moved: AnnotationPlacement = {
        ...p,
        layout: { kind: 'offset', distance: 1 + Math.floor(rand() * 20) },
      };
      return { kind: 'updatePlacements', drawingId: DRAWING, placements: [moved] };
    }
    case 'removePlacement': {
      const p = pick(rand, d.placements);
      return p ? { kind: 'removePlacements', drawingId: DRAWING, placementIds: [p.id] } : null;
    }
    case 'removeAnnotation': {
      const a = pick(rand, annotations);
      return a ? { kind: 'removeAnnotation', partId: PART, annotationIds: [a.id] } : null;
    }
    case 'removeView': {
      const v = pick(rand, d.views);
      return v ? { kind: 'removeViews', drawingId: DRAWING, viewIds: [v.id] } : null;
    }
    case 'editView': {
      const v = pick(rand, d.views);
      if (!v) return null;
      if (rand() < 0.4) {
        const sheetId = pick(rand, d.sheets)?.id ?? v.sheetId;
        return { kind: 'updateView', drawingId: DRAWING, view: { ...v, sheetId } };
      }
      if (v.layout.kind !== 'free') return null;
      return {
        kind: 'updateView',
        drawingId: DRAWING,
        view: { ...v, layout: { kind: 'free', position: [10 + Math.floor(rand() * 300), 99] } },
      } as Command;
    }
    case 'removeSheet': {
      if (d.sheets.length < 2 || rand() < 0.5) return null;
      const s = pick(rand, d.sheets);
      return s ? { kind: 'removeSheet', drawingId: DRAWING, sheetId: s.id } : null;
    }
    default:
      return null;
  }
}

function randomSide(rand: Rand, base: WrenDoc, next: () => string, addsOnly: boolean): WrenDoc {
  let doc = base;
  const n = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    const cmd = randomCommand(rand, doc, next, addsOnly);
    if (!cmd) continue;
    try {
      doc = apply(doc, cmd);
    } catch {
      // A command the document refuses (e.g. a view that can't be removed): skip it.
    }
  }
  return doc;
}

const sorted = (ids: readonly string[]) =>
  ids.every((x, i) => i === 0 || (ids[i - 1] as string) < x);

function checkInvariants(doc: WrenDoc, where: string): void {
  expect(problems(doc), where).toEqual([]);
  const annotations = annotationsOf(doc);
  expect(sorted(annotations.map((a) => a.id)), `${where}: annotations sorted`).toBe(true);
  const live = new Set(annotations.map((a) => a.id));
  for (const d of doc.drawings) {
    for (const k of ['views', 'placements', 'centerMarks', 'tables', 'notes', 'markup'] as const) {
      const ids = ((d[k] ?? []) as { id: string }[]).map((x) => x.id);
      expect(sorted(ids), `${where}: ${k} sorted`).toBe(true);
    }
    const views = new Set(d.views.map((v) => v.id));
    for (const p of d.placements) {
      expect(live.has(p.annotationId) && views.has(p.viewId), `${where}: placement ${p.id}`).toBe(
        true,
      );
    }
    for (const m of d.centerMarks) expect(views.has(m.viewId), `${where}: mark`).toBe(true);
  }
}

/** Ids a conflict names: its subject and its dependents. */
function conflictIds(conflicts: readonly MergeConflict[]): Set<string> {
  const out = new Set<string>();
  for (const c of conflicts) {
    if (c.subject.id) out.add(c.subject.id);
    out.add(c.path.split('/').pop() as string);
    for (const d of (c as StructuralMergeConflict).dependents ?? []) {
      out.add(d.path.split('/').pop() as string);
    }
  }
  return out;
}

function noteIds(r: ReturnType<typeof docMerger.merge>): Set<string> {
  const out = new Set<string>();
  for (const n of mergeNotes(r)) {
    for (const x of (n as { ids?: string[] }).ids ?? []) out.add(x);
  }
  return out;
}

function checkNoSilentLoss(
  b: WrenDoc,
  o: WrenDoc,
  t: WrenDoc,
  r: ReturnType<typeof docMerger.merge>,
  where: string,
): void {
  const named = new Set([...conflictIds(r.conflicts), ...noteIds(r)]);
  const sides: [WrenDoc, WrenDoc][] = [
    [o, t],
    [t, o],
  ];
  for (const [side, other] of sides) {
    const merged = new Set(annotationsOf(r.doc).map((a) => a.id));
    const baseA = new Map(annotationsOf(b).map((a) => [a.id, a]));
    const otherA = new Set(annotationsOf(other).map((a) => a.id));
    for (const a of annotationsOf(side)) {
      if (merged.has(a.id)) continue;
      const deletedUnchanged =
        baseA.has(a.id) && !otherA.has(a.id) && canonicalJson(baseA.get(a.id)) === canonicalJson(a);
      expect(deletedUnchanged || named.has(a.id), `${where}: annotation ${a.id} lost`).toBe(true);
    }
    const mergedP = new Set(drawingOf(r.doc).placements.map((p) => p.id));
    const baseP = new Map(drawingOf(b).placements.map((p) => [p.id, p]));
    const otherP = new Set(drawingOf(other).placements.map((p) => p.id));
    for (const p of drawingOf(side).placements) {
      if (mergedP.has(p.id)) continue;
      const deletedUnchanged =
        baseP.has(p.id) && !otherP.has(p.id) && canonicalJson(baseP.get(p.id)) === canonicalJson(p);
      expect(deletedUnchanged || named.has(p.id), `${where}: placement ${p.id} lost`).toBe(true);
    }
  }
}

function pairs(
  addsOnly: boolean,
  seed: number,
): { b: WrenDoc; o: WrenDoc; t: WrenDoc; tag: string }[] {
  const rand = mulberry32(seed);
  let counter = 5000;
  // Interleaved ids: both sides draw from one sequence, so their adds sort into each other.
  const next = () => {
    counter += 1 + Math.floor(rand() * 3);
    return id(counter);
  };
  const base = drawingDoc();
  const out = [];
  for (let i = 0; i < PAIRS; i++) {
    // A base that already went through a few edits now and then.
    const b = i % 4 === 0 ? randomSide(rand, base, next, true) : base;
    out.push({
      b,
      o: randomSide(rand, b, next, addsOnly),
      t: randomSide(rand, b, next, addsOnly),
      tag: `seed ${seed} pair ${i}`,
    });
  }
  return out;
}

describe('drawing merge fuzz', () => {
  it('concurrent adds of annotations and placements never conflict and are all kept', () => {
    for (const { b, o, t, tag } of pairs(true, SEED)) {
      const r = docMerger.merge(b, o, t);
      expect(r.conflicts, tag).toEqual([]);
      checkInvariants(r.doc, tag);
      const s = docMerger.merge(b, t, o);
      expect(canonicalJson(s.doc), `${tag}: symmetric`).toBe(canonicalJson(r.doc));
      expect(canonicalJson(docMerger.merge(b, o, t).doc), `${tag}: deterministic`).toBe(
        canonicalJson(r.doc),
      );
      const named = noteIds(r);
      for (const side of [o, t]) {
        const as = new Set(annotationsOf(r.doc).map((a) => a.id));
        for (const a of annotationsOf(side)) expect(as.has(a.id), `${tag}: ${a.id}`).toBe(true);
        const ps = new Set(drawingOf(r.doc).placements.map((p) => p.id));
        for (const p of drawingOf(side).placements) {
          expect(ps.has(p.id) || named.has(p.id), `${tag}: placement ${p.id}`).toBe(true);
        }
      }
    }
  });

  it('mixed concurrent edits: no order conflicts, deterministic, symmetric, valid, nothing lost silently', () => {
    let conflicted = 0;
    let dependents = 0;
    for (const { b, o, t, tag } of pairs(false, SEED + 1)) {
      const r = docMerger.merge(b, o, t);
      expect(
        r.conflicts.filter((c) => c.kind === 'order'),
        tag,
      ).toEqual([]);
      for (const c of r.conflicts) {
        const text = conflictSummary(c);
        expect(text, tag).not.toMatch(/undefined|01J0/);
      }
      if (r.conflicts.length > 0) conflicted++;
      if (r.conflicts.some((c) => (c as StructuralMergeConflict).dependents)) dependents++;
      checkInvariants(r.doc, tag);
      checkNoSilentLoss(b, o, t, r, tag);
      expect(canonicalJson(docMerger.merge(b, o, t).doc), `${tag}: deterministic`).toBe(
        canonicalJson(r.doc),
      );
      const s = docMerger.merge(b, t, o);
      expect(s.conflicts.map((c) => c.id).sort(), `${tag}: same conflicts`).toEqual(
        r.conflicts.map((c) => c.id).sort(),
      );
      if (r.conflicts.length === 0) {
        expect(canonicalJson(s.doc), `${tag}: symmetric`).toBe(canonicalJson(r.doc));
      } else {
        const theirs = docMerger.resolve(
          r,
          r.conflicts.map((c) => ({ conflictId: c.id, take: 'theirs' as const })),
        );
        checkInvariants(theirs, `${tag}: theirs`);
        expect(canonicalJson(theirs), `${tag}: theirs = swapped`).toBe(canonicalJson(s.doc));
        // The same choices across a worker boundary.
        const byPath = docMerger.resolve(
          structuredClone(r),
          r.conflicts.map((c) => ({ conflictId: c.id, take: 'theirs' as const })),
        );
        checkInvariants(byPath, `${tag}: by path`);
      }
      for (const c of docDiffer.diff(b, r.doc)) {
        expect(c.summary, `${tag}: compare`).not.toMatch(/undefined|01J0/);
      }
    }
    // The generator reaches the interesting cases.
    expect(conflicted).toBeGreaterThan(5);
    expect(dependents).toBeGreaterThan(2);
  });
});
