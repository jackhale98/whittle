// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M3.6 (ADR-066): feature tree folders and sketch visibility in the structural merge, the merge
 * notes and the version compare. Folder edits go through the document commands
 * (`support/folders.ts`); normalisation is the document package's `normalizeFolders`.
 */

import type { MergeResult, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { canonicalJson, fromFiles, normalizeFolders, toFiles } from '@wren-cad/document';
import { describe, expect, it, vi } from 'vitest';
import {
  conflictSummary,
  docDiffer,
  docMerger,
  folderChangeSummary,
  mergeNotes,
  mergeProjectFiles,
  type NormalizeFolders,
  StructuralMerger,
} from '../src';
import {
  apply,
  baseDoc,
  CHAMFER,
  EXTRUDE,
  FILLET,
  featureOf,
  id,
  PART,
  PLANE,
  problems,
  SKETCH,
  sk,
} from './support/fixtures';
import {
  addFolder,
  folder,
  folderById,
  folderProblems,
  foldersOf,
  moveFeatureF,
  moveFolder,
  removeFeatureF,
  removeFolder,
  renameFolder,
  reorder,
  setMembers,
  setVisibility,
  withFolders,
} from './support/folders';

// Bracket: Sketch 1, Extrude 2, Fillet 3, Chamfer 4, Plane 5.
const MOUNTING = id(60);
const EDGES = id(61);
const featureIds = (d: WrenDoc) =>
  (d.parts.find((p) => p.id === PART)?.features ?? []).map((f) => f.id);
const valid = (r: MergeResult | WrenDoc) => {
  const doc = 'doc' in r ? r.doc : r;
  expect(problems(doc)).toEqual([]);
  expect(folderProblems(doc)).toEqual([]);
};
const notes = (r: MergeResult) => mergeNotes(r).map((n) => n.summary);
/** Base with folder Mounting = Fillet 3, Chamfer 4. */
const mounted = () => withFolders(baseDoc(), [folder(MOUNTING, 'Mounting', [FILLET, CHAMFER])]);
const sketchOf = (d: WrenDoc) => featureOf(d, SKETCH) as SketchFeature;
const setDim = (doc: WrenDoc, value: string) => {
  const s = structuredClone(sketchOf(doc));
  const c = s.constraints.find((x) => x.id === sk(23));
  if (c && 'value' in c) c.value = value;
  return apply(doc, { kind: 'updateFeature', partId: PART, featureId: SKETCH, feature: s });
};

describe('merge report text for normalizeFolders changes', () => {
  const names: Record<string, string> = {
    a: 'Fillet 3',
    b: 'Chamfer 4',
    F: 'Mounting',
    G: 'Edges',
  };
  const name = (x: string) => names[x] ?? x;
  const change = (
    kind: 'missing' | 'shared' | 'extended' | 'trimmed' | 'removed',
    featureIds: string[],
  ) => ({
    folderId: 'G',
    folderName: 'Edges',
    kind,
    featureIds,
  });

  it('reads in plain language, one line per change', () => {
    expect(folderChangeSummary(change('trimmed', ['a']), name)).toBe(
      'Fillet 3 left folder Edges to keep the folder in one piece',
    );
    expect(folderChangeSummary(change('extended', ['a', 'b']), name)).toBe(
      'Fillet 3 and Chamfer 4 joined folder Edges to keep the folder in one piece',
    );
    expect(folderChangeSummary(change('shared', ['a']), name, () => 'F')).toBe(
      'Fillet 3 left folder Edges: it is already in folder Mounting',
    );
    expect(
      folderChangeSummary(change('shared', ['a', 'b']), name, (x) => (x === 'a' ? 'F' : 'H')),
    ).toBe('Fillet 3 and Chamfer 4 left folder Edges: they are already in another folder');
    expect(folderChangeSummary(change('removed', []), name)).toBe(
      'Folder Edges was removed: no features were left in it',
    );
    // Deleted members are already listed as removed features.
    expect(folderChangeSummary(change('missing', ['a']), name)).toBeNull();
  });
});

describe('DocMerger: folders', () => {
  it('a rename on one branch and a moveFolder on the other merge cleanly (PLAN M3.6)', () => {
    const base = mounted();
    const ours = renameFolder(base, MOUNTING, 'Mounting holes');
    // Mounting (Fillet 3, Chamfer 4) moves to the end, after Plane 5.
    const theirs = moveFolder(base, MOUNTING, 3);
    expect(featureIds(theirs)).toEqual([SKETCH, EXTRUDE, PLANE, FILLET, CHAMFER]);
    for (const r of [docMerger.merge(base, ours, theirs), docMerger.merge(base, theirs, ours)]) {
      expect(r.conflicts).toEqual([]);
      expect(featureIds(r.doc)).toEqual([SKETCH, EXTRUDE, PLANE, FILLET, CHAMFER]);
      expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'Mounting holes', [FILLET, CHAMFER])]);
      expect(mergeNotes(r)).toEqual([]);
      valid(r);
    }
  });

  it('a rename merges with features reordered around the folder', () => {
    const base = mounted();
    const ours = renameFolder(base, MOUNTING, 'Edges');
    const theirs = moveFeatureF(base, PLANE, 0); // Plane 5 to the top: the run is untouched
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureIds(r.doc)).toEqual([PLANE, SKETCH, EXTRUDE, FILLET, CHAMFER]);
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'Edges', [FILLET, CHAMFER])]);
    valid(r);
  });

  it('survives a part-level edit on both sides (the folder is merged, not just copied)', () => {
    const base = mounted();
    const ours = renameFolder(
      apply(base, { kind: 'renamePart', partId: PART, name: 'Bracket A' }),
      MOUNTING,
      'M',
    );
    const theirs = moveFolder(
      apply(base, { kind: 'setRollback', partId: PART, index: 4 }),
      MOUNTING,
      3,
    );
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureIds(r.doc)).toEqual([SKETCH, EXTRUDE, PLANE, FILLET, CHAMFER]);
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'M', [FILLET, CHAMFER])]);
    expect(r.doc.parts[0]?.name).toBe('Bracket A');
    valid(r);
  });

  it('add-member on one side and remove-member on the other both apply', () => {
    const base = mounted();
    const ours = setMembers(base, MOUNTING, [FILLET, CHAMFER, PLANE]); // Plane 5 joins at the end
    const theirs = moveFeatureF(base, FILLET, 4); // Fillet 3 moves to the end: leaves
    expect(folderById(theirs, MOUNTING)?.features).toEqual([CHAMFER]);
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureIds(r.doc)).toEqual([SKETCH, EXTRUDE, CHAMFER, PLANE, FILLET]);
    expect(folderById(r.doc, MOUNTING)?.features).toEqual([CHAMFER, PLANE]);
    expect(mergeNotes(r)).toEqual([]);
    valid(r);
    // Symmetric.
    expect(canonicalJson(docMerger.merge(base, theirs, ours).doc)).toBe(canonicalJson(r.doc));
  });

  it('a member deleted on one side drops out quietly', () => {
    const base = mounted();
    const ours = renameFolder(base, MOUNTING, 'Edges');
    const theirs = removeFeatureF(base, CHAMFER);
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'Edges', [FILLET])]);
    expect(mergeNotes(r)).toEqual([]);
    valid(r);
  });

  it('both renaming a folder differently is a name conflict with the usual resolution data', () => {
    const base = mounted();
    const ours = renameFolder(base, MOUNTING, 'Edges');
    const theirs = renameFolder(base, MOUNTING, 'Finishing');
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([
      {
        id: `bothModified:/parts/${PART}/folders/${MOUNTING}/name`,
        kind: 'bothModified',
        path: `/parts/${PART}/folders/${MOUNTING}/name`,
        subject: { kind: 'part', id: PART, label: 'Folder Edges' },
        base: 'Mounting',
        ours: 'Edges',
        theirs: 'Finishing',
      },
    ]);
    expect(conflictSummary(r.conflicts[0] as never)).toBe('Folder Edges name: Edges vs Finishing');
    expect(folderById(r.doc, MOUNTING)?.name).toBe('Edges');
    const c = r.conflicts[0]?.id as string;
    expect(
      folderById(docMerger.resolve(r, [{ conflictId: c, take: 'theirs' }]), MOUNTING)?.name,
    ).toBe('Finishing');
    expect(
      folderById(docMerger.resolve(r, [{ conflictId: c, value: 'Trim' }]), MOUNTING)?.name,
    ).toBe('Trim');
  });

  it('concurrent folders over overlapping runs: the earlier one keeps the shared feature, reported', () => {
    const base = baseDoc();
    const ours = addFolder(base, folder(MOUNTING, 'Mounting', [EXTRUDE, FILLET]));
    const theirs = addFolder(base, folder(EDGES, 'Edges', [FILLET, CHAMFER]));
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([
      folder(MOUNTING, 'Mounting', [EXTRUDE, FILLET]),
      folder(EDGES, 'Edges', [CHAMFER]),
    ]);
    expect(notes(r)).toEqual(['Fillet 3 left folder Edges: it is already in folder Mounting']);
    expect(mergeNotes(r)[0]).toMatchObject({
      kind: 'folderMembership',
      partId: PART,
      subject: { kind: 'part', id: PART, label: 'Folder Edges' },
      change: { kind: 'shared', folderId: EDGES, folderName: 'Edges', featureIds: [FILLET] },
    });
    valid(r);
    const s = docMerger.merge(base, theirs, ours);
    expect(canonicalJson(s.doc)).toBe(canonicalJson(r.doc));
    expect(notes(s)).toEqual(notes(r));
  });

  it('a folder whose only feature another folder claimed is removed, reported', () => {
    const base = withFolders(baseDoc(), [folder(MOUNTING, 'Mounting', [EXTRUDE, FILLET])]);
    // Ours: Chamfer 4 moves inside the run and joins Mounting. Theirs: a new folder holds it.
    const ours = moveFeatureF(base, CHAMFER, 2);
    expect(folderById(ours, MOUNTING)?.features).toEqual([EXTRUDE, CHAMFER, FILLET]);
    const theirs = addFolder(base, folder(EDGES, 'Edges', [CHAMFER]));
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'Mounting', [EXTRUDE, CHAMFER, FILLET])]);
    expect(notes(r)).toEqual([
      'Chamfer 4 left folder Edges: it is already in folder Mounting',
      'Folder Edges was removed: no features were left in it',
    ]);
    valid(r);
  });

  it('a run broken by a move on the other side keeps its longest piece, reported', () => {
    // Mounting = Extrude 2; Edges = Chamfer 4.
    const base = withFolders(baseDoc(), [
      folder(MOUNTING, 'Mounting', [EXTRUDE]),
      folder(EDGES, 'Edges', [CHAMFER]),
    ]);
    const ours = setMembers(base, MOUNTING, [EXTRUDE, FILLET]); // Fillet 3 joins Mounting
    const theirs = moveFeatureF(base, FILLET, 4); // Fillet 3 moves to the end (in no folder there)
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(featureIds(r.doc)).toEqual([SKETCH, EXTRUDE, CHAMFER, PLANE, FILLET]);
    expect(foldersOf(r.doc)).toEqual([
      folder(MOUNTING, 'Mounting', [EXTRUDE]),
      folder(EDGES, 'Edges', [CHAMFER]),
    ]);
    expect(notes(r)).toEqual(['Fillet 3 left folder Mounting to keep the folder in one piece']);
    valid(r);
  });

  it('a run broken over features in no folder closes the gap, reported', () => {
    const base = withFolders(baseDoc(), [folder(MOUNTING, 'Mounting', [EXTRUDE])]);
    const ours = setMembers(base, MOUNTING, [EXTRUDE, FILLET]);
    const theirs = moveFeatureF(base, FILLET, 4);
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([
      folder(MOUNTING, 'Mounting', [EXTRUDE, CHAMFER, PLANE, FILLET]),
    ]);
    expect(notes(r)).toEqual([
      'Chamfer 4 and Plane 5 joined folder Mounting to keep the folder in one piece',
    ]);
    valid(r);
  });

  it('a folder added on one side is kept', () => {
    const base = baseDoc();
    const ours = addFolder(base, folder(MOUNTING, 'Mounting', [FILLET, CHAMFER]));
    const theirs = apply(base, { kind: 'renamePart', partId: PART, name: 'Bracket B' });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'Mounting', [FILLET, CHAMFER])]);
    expect(canonicalJson(docMerger.merge(base, theirs, ours).doc)).toBe(canonicalJson(r.doc));
    valid(r);
  });

  it('deleted on one side and renamed on the other is modifiedDeleted', () => {
    const base = mounted();
    const ours = removeFolder(base, MOUNTING);
    const theirs = renameFolder(base, MOUNTING, 'Edges');
    const r = docMerger.merge(base, ours, theirs);
    const ptr = `/parts/${PART}/folders/${MOUNTING}`;
    expect(r.conflicts).toEqual([
      {
        id: `modifiedDeleted:${ptr}`,
        kind: 'modifiedDeleted',
        path: ptr,
        subject: { kind: 'part', id: PART, label: 'Folder Edges' },
        base: folder(MOUNTING, 'Mounting', [FILLET, CHAMFER]),
        theirs: folder(MOUNTING, 'Edges', [FILLET, CHAMFER]),
      },
    ]);
    expect(conflictSummary(r.conflicts[0] as never)).toBe(
      'Folder Edges: deleted vs Edges (2 features)',
    );
    expect(foldersOf(r.doc)).toEqual([]);
    valid(r);
    const c = r.conflicts[0]?.id as string;
    const kept = docMerger.resolve(r, [{ conflictId: c, take: 'theirs' }]);
    expect(foldersOf(kept)).toEqual([folder(MOUNTING, 'Edges', [FILLET, CHAMFER])]);
    valid(kept);
    // A result that crossed a worker boundary resolves by path, creating the folders array.
    const cloned = docMerger.resolve(structuredClone(r), [{ conflictId: c, take: 'theirs' }]);
    expect(canonicalJson(cloned)).toBe(canonicalJson(kept));
  });

  it('deleted on one side and given a member on the other is modifiedDeleted', () => {
    const base = mounted();
    const ours = setMembers(base, MOUNTING, [FILLET, CHAMFER, PLANE]);
    const theirs = removeFolder(base, MOUNTING);
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts.map((c) => c.kind)).toEqual(['modifiedDeleted']);
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'Mounting', [FILLET, CHAMFER, PLANE])]);
    const gone = docMerger.resolve(r, [
      { conflictId: r.conflicts[0]?.id as string, take: 'theirs' },
    ]);
    expect(foldersOf(gone)).toEqual([]);
    valid(gone);
  });

  it('deleted on one side and only lost a member on the other: the delete wins quietly', () => {
    const base = mounted();
    const ours = removeFolder(base, MOUNTING);
    const theirs = moveFeatureF(base, CHAMFER, 4); // Chamfer 4 leaves the folder
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([]);
    expect(featureIds(r.doc)).toEqual([SKETCH, EXTRUDE, FILLET, PLANE, CHAMFER]);
    expect(canonicalJson(docMerger.merge(base, theirs, ours).doc)).toBe(canonicalJson(r.doc));
    valid(r);
  });

  it('a rename of a folder whose features the other side all deleted needs no decision', () => {
    const base = mounted();
    const ours = renameFolder(base, MOUNTING, 'Edges');
    const theirs = removeFeatureF(removeFeatureF(base, FILLET), CHAMFER); // the folder went too
    expect(foldersOf(theirs)).toEqual([]);
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([]);
    valid(r);
  });

  it('restoring a deleted feature puts it back in its folder when it lands inside the run', () => {
    const base = withFolders(baseDoc(), [folder(MOUNTING, 'Mounting', [EXTRUDE, FILLET, CHAMFER])]);
    const f = featureOf(base, FILLET) as never as Record<string, unknown>;
    const ours = removeFeatureF(base, FILLET);
    const theirs = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: FILLET,
      feature: { ...f, radius: '4mm' } as never,
    });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts.map((c) => c.kind)).toEqual(['modifiedDeleted']);
    const c = r.conflicts[0]?.id as string;
    const doc = docMerger.resolve(r, [{ conflictId: c, take: 'theirs' }]);
    expect(featureIds(doc)).toEqual([SKETCH, EXTRUDE, FILLET, CHAMFER, PLANE]);
    expect(folderById(doc, MOUNTING)?.features).toEqual([EXTRUDE, FILLET, CHAMFER]);
    valid(doc);
    // Without the merge inputs the feature comes back at the end, outside the folder: still valid.
    const byPath = docMerger.resolve(structuredClone(r), [{ conflictId: c, take: 'theirs' }]);
    expect(featureIds(byPath)).toEqual([SKETCH, EXTRUDE, CHAMFER, PLANE, FILLET]);
    expect(folderById(byPath, MOUNTING)?.features).toEqual([EXTRUDE, CHAMFER]);
    valid(byPath);
  });

  it('the folders array order never conflicts and is symmetric when both changed it', () => {
    const base = withFolders(baseDoc(), [
      folder(MOUNTING, 'Mounting', [EXTRUDE]),
      folder(EDGES, 'Edges', [CHAMFER]),
    ]);
    const ours = renameFolder(
      withFolders(base, [
        folder(EDGES, 'Edges', [CHAMFER]),
        folder(MOUNTING, 'Mounting', [EXTRUDE]),
      ]),
      EDGES,
      'E',
    );
    const theirs = renameFolder(base, MOUNTING, 'M');
    const r = docMerger.merge(base, ours, theirs);
    const s = docMerger.merge(base, theirs, ours);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc).map((f) => f.name)).toEqual(['M', 'E']);
    expect(canonicalJson(s.doc)).toBe(canonicalJson(r.doc));
  });

  it('features reordered so a run splits, against a rename: normalised and reported', () => {
    const base = mounted();
    const ours = renameFolder(base, MOUNTING, 'Edges');
    // Theirs puts Plane 5 between Fillet 3 and Chamfer 4 without touching folders (a hand edit).
    const theirs = reorder(base, [SKETCH, EXTRUDE, FILLET, PLANE, CHAMFER]);
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'Edges', [FILLET, PLANE, CHAMFER])]);
    expect(notes(r)).toEqual(['Plane 5 joined folder Edges to keep the folder in one piece']);
    valid(r);
  });

  it('takes an injected normaliser (the seam for the document package)', () => {
    const spy: NormalizeFolders = vi.fn((part) => normalizeFolders(part));
    const merger = new StructuralMerger({ normalizeFolders: spy });
    const base = mounted();
    const r = merger.merge(base, renameFolder(base, MOUNTING, 'A'), moveFolder(base, MOUNTING, 3));
    expect(spy).toHaveBeenCalled();
    expect(foldersOf(r.doc)).toEqual([folder(MOUNTING, 'A', [FILLET, CHAMFER])]);
    const none = new StructuralMerger({ normalizeFolders: (part) => ({ part, changes: [] }) });
    const broken = reorder(base, [SKETCH, EXTRUDE, FILLET, PLANE, CHAMFER]);
    expect(mergeNotes(none.merge(base, renameFolder(base, MOUNTING, 'B'), broken))).toEqual([]);
  });

  it('mergeProjectFiles carries the merge notes', async () => {
    const base = baseDoc();
    const ours = addFolder(base, folder(MOUNTING, 'Mounting', [EXTRUDE, FILLET]));
    const theirs = addFolder(base, folder(EDGES, 'Edges', [FILLET, CHAMFER]));
    const m = await mergeProjectFiles(toFiles(base), toFiles(ours), toFiles(theirs));
    expect(m.merge.conflicts).toEqual([]);
    expect(notes(m.merge)).toEqual([
      'Fillet 3 left folder Edges: it is already in folder Mounting',
    ]);
    expect(foldersOf(fromFiles(m.files))).toHaveLength(2);
  });
});

describe('DocMerger: sketch visibility', () => {
  it('merges as a field: one side shows the sketch, the other edits it', () => {
    const base = baseDoc();
    const ours = setVisibility(base, SKETCH, 'shown');
    const theirs = setDim(base, '35mm');
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(sketchOf(r.doc).visibility).toBe('shown');
    expect(sketchOf(r.doc).constraints.find((c) => c.id === sk(23))).toMatchObject({
      value: '35mm',
    });
    valid(r);
  });

  it('a new value from theirs is taken (absent in base)', () => {
    const base = baseDoc();
    const r = docMerger.merge(base, setDim(base, '31mm'), setVisibility(base, SKETCH, 'hidden'));
    expect(r.conflicts).toEqual([]);
    expect(sketchOf(r.doc).visibility).toBe('hidden');
    expect(r.autoMerged).toBe(1);
  });

  it('shown against hidden is a conflict that reads well', () => {
    const base = baseDoc();
    const r = docMerger.merge(
      base,
      setVisibility(base, SKETCH, 'shown'),
      setVisibility(base, SKETCH, 'hidden'),
    );
    const ptr = `/parts/${PART}/features/${SKETCH}/visibility`;
    expect(r.conflicts).toEqual([
      {
        id: `bothModified:${ptr}`,
        kind: 'bothModified',
        path: ptr,
        subject: { kind: 'feature', id: SKETCH, partId: PART, label: 'Sketch 1' },
        base: 'auto',
        ours: 'shown',
        theirs: 'hidden',
      },
    ]);
    expect(conflictSummary(r.conflicts[0] as never)).toBe('Sketch 1 visibility: shown vs hidden');
    const c = r.conflicts[0]?.id as string;
    expect(sketchOf(docMerger.resolve(r, [{ conflictId: c, take: 'theirs' }])).visibility).toBe(
      'hidden',
    );
    const back = docMerger.resolve(r, [{ conflictId: c, take: 'base' }]);
    expect(sketchOf(back).visibility ?? 'auto').toBe('auto');
    valid(back);
    expect(
      sketchOf(docMerger.resolve(structuredClone(r), [{ conflictId: c, take: 'theirs' }]))
        .visibility,
    ).toBe('hidden');
  });

  it('absent and auto are the same value', () => {
    const shown = setVisibility(baseDoc(), SKETCH, 'shown');
    // Base shown; ours resets with 'auto', theirs by removing the field: no conflict.
    const r = docMerger.merge(
      shown,
      setVisibility(shown, SKETCH, 'auto'),
      setVisibility(shown, SKETCH, undefined),
    );
    expect(r.conflicts).toEqual([]);
    expect(sketchOf(r.doc).visibility ?? 'auto').toBe('auto');
    // Base absent; ours writes 'auto' (no change of meaning), theirs hides: theirs wins cleanly.
    const base = baseDoc();
    const s = docMerger.merge(
      base,
      setVisibility(base, SKETCH, 'auto'),
      setVisibility(base, SKETCH, 'hidden'),
    );
    expect(s.conflicts).toEqual([]);
    expect(sketchOf(s.doc).visibility).toBe('hidden');
    // 'auto' against hidden from a shown base is a real conflict, shown as automatic.
    const t = docMerger.merge(
      shown,
      setVisibility(shown, SKETCH, undefined),
      setVisibility(shown, SKETCH, 'hidden'),
    );
    expect(t.conflicts.map((c) => [c.ours, c.theirs])).toEqual([['auto', 'hidden']]);
    expect(conflictSummary(t.conflicts[0] as never)).toBe(
      'Sketch 1 visibility: automatic vs hidden',
    );
  });

  it('deleting a sketch the other side showed is the usual feature conflict', () => {
    const base = withFolders(baseDoc(), []);
    const ours = setVisibility(base, SKETCH, 'shown');
    const theirs = apply(base, { kind: 'removeFeature', partId: PART, featureId: SKETCH });
    const r = docMerger.merge(base, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.path])).toEqual([
      ['modifiedDeleted', `/parts/${PART}/features/${SKETCH}`],
    ]);
  });
});

describe('DocDiffer: folders and sketch visibility', () => {
  const summaries = (a: WrenDoc, b: WrenDoc) => docDiffer.diff(a, b).map((c) => c.summary);

  it('folder added, renamed, membership, removed', () => {
    const base = baseDoc();
    const added = addFolder(base, folder(MOUNTING, 'Mounting', [EXTRUDE, FILLET, CHAMFER]));
    expect(docDiffer.diff(base, added)).toEqual([
      {
        kind: 'added',
        subject: { kind: 'part', id: PART, label: 'Folder Mounting' },
        fields: [{ path: '/features', label: 'features', after: [EXTRUDE, FILLET, CHAMFER] }],
        summary: 'Added folder Mounting with Extrude 2, Fillet 3 and Chamfer 4',
      },
    ]);
    const renamed = renameFolder(added, MOUNTING, 'Edges');
    expect(docDiffer.diff(added, renamed)).toEqual([
      {
        kind: 'renamed',
        subject: { kind: 'part', id: PART, label: 'Folder Edges' },
        fields: [{ path: '/name', label: 'name', before: 'Mounting', after: 'Edges' }],
        summary: 'Renamed folder Mounting → Edges',
      },
    ]);
    const grown = setMembers(added, MOUNTING, [EXTRUDE, FILLET, CHAMFER, PLANE]);
    expect(summaries(added, grown)).toEqual(['Folder Mounting: added Plane 5']);
    const moved = moveFeatureF(added, CHAMFER, 4); // to the end: leaves the folder
    expect(folderById(moved, MOUNTING)?.features).toEqual([EXTRUDE, FILLET]);
    const lines = summaries(added, moved);
    expect(lines).toHaveLength(2);
    expect(lines.filter((x) => x.startsWith('Moved '))).toHaveLength(1);
    expect(lines).toContain('Folder Mounting: removed Chamfer 4');
    const both = renameFolder(
      setMembers(added, MOUNTING, [FILLET, CHAMFER, PLANE]),
      MOUNTING,
      'Edges',
    );
    expect(summaries(added, both)).toEqual([
      'Renamed folder Mounting → Edges, added Plane 5, removed Extrude 2',
    ]);
    expect(summaries(added, removeFolder(added, MOUNTING))).toEqual(['Removed folder Mounting']);
  });

  it('a deleted member is listed once, as the feature removal', () => {
    const before = mounted();
    expect(summaries(before, removeFeatureF(before, CHAMFER))).toEqual(['Removed Chamfer 4']);
  });

  it('a folder moved as a whole is one line', () => {
    const planes = withFolders(baseDoc(), [folder(MOUNTING, 'Datums', [PLANE])]);
    expect(docDiffer.diff(planes, moveFolder(planes, MOUNTING, 0))).toEqual([
      {
        kind: 'moved',
        subject: { kind: 'part', id: PART, label: 'Folder Datums' },
        summary: 'Moved folder Datums to the top',
      },
    ]);
    // Fillet 3 and Chamfer 4 after Plane 5: one line, never one per member. (Which of the folder
    // and Plane 5 "moved" is a tie, as for any two items swapping places.)
    const before = mounted();
    const lines = summaries(before, moveFolder(before, MOUNTING, 3));
    expect(lines).toHaveLength(1);
    expect(['Moved folder Mounting after Plane 5', 'Moved Plane 5 after Extrude 2']).toContain(
      lines[0],
    );
  });

  it('a move inside a folder is a feature move, not a folder move', () => {
    const before = withFolders(baseDoc(), [
      folder(MOUNTING, 'Mounting', [EXTRUDE, FILLET, CHAMFER]),
    ]);
    const after = moveFeatureF(before, CHAMFER, 2); // between Extrude 2 and Fillet 3
    expect(folderById(after, MOUNTING)?.features).toEqual([EXTRUDE, CHAMFER, FILLET]);
    const lines = summaries(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Moved (Chamfer 4|Fillet 3) after /);
  });

  it('sketch visibility reads as a field, absent = automatic', () => {
    const base = baseDoc();
    const shown = setVisibility(base, SKETCH, 'shown');
    expect(docDiffer.diff(base, shown)).toEqual([
      {
        kind: 'modified',
        subject: { kind: 'feature', id: SKETCH, partId: PART, label: 'Sketch 1' },
        fields: [{ path: '/visibility', label: 'visibility', before: 'auto', after: 'shown' }],
        summary: 'Sketch 1: visibility automatic → shown',
      },
    ]);
    expect(summaries(shown, setVisibility(shown, SKETCH, 'hidden'))).toEqual([
      'Sketch 1: visibility shown → hidden',
    ]);
    expect(summaries(base, setVisibility(base, SKETCH, 'auto'))).toEqual([]);
    const renamed = apply(setVisibility(base, SKETCH, 'hidden'), {
      kind: 'updateFeature',
      partId: PART,
      featureId: SKETCH,
      feature: { ...sketchOf(setVisibility(base, SKETCH, 'hidden')), name: 'Profile' },
    });
    expect(summaries(base, renamed)).toEqual([
      'Renamed Sketch 1 → Profile, visibility automatic → hidden',
    ]);
  });
});
