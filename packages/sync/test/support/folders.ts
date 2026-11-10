// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Feature tree folder states for merge tests (M3.6, ADR-066). Edits a user can make go through the
 * document commands (`addFolder`, `renameFolder`, `removeFolder`, `moveFolder`, `moveFeature`,
 * `setSketchVisibility`, …), so membership follows edits exactly as in the app. `setMembers`,
 * `reorder` and `withFolders` are plain data edits for states no single command makes (another
 * tool's edit, or a precondition).
 */

import type {
  Feature,
  FeatureFolder,
  Part,
  SketchFeature,
  SketchVisibility,
  WrenDoc,
} from '@wren-cad/contracts';
import { apply, PART } from './fixtures';

export const folder = (id: string, name: string, features: string[]): FeatureFolder => ({
  id,
  name,
  features,
});

const partOf = (doc: WrenDoc, pid: string): Part => {
  const p = doc.parts.find((x) => x.id === pid);
  if (!p) throw new Error(`no part ${pid}`);
  return p;
};

/** A copy of `doc` with `edit` applied to one part (a plain data edit, as a command would make). */
export function editPart(doc: WrenDoc, edit: (part: Part) => void, pid = PART): WrenDoc {
  const next = structuredClone(doc);
  edit(partOf(next, pid));
  return next;
}

export const withFolders = (doc: WrenDoc, folders: FeatureFolder[], pid = PART): WrenDoc =>
  editPart(
    doc,
    (p) => {
      p.folders = structuredClone(folders);
    },
    pid,
  );

export const foldersOf = (doc: WrenDoc, pid = PART): FeatureFolder[] =>
  partOf(doc, pid).folders ?? [];

export const folderById = (doc: WrenDoc, fid: string, pid = PART): FeatureFolder | undefined =>
  foldersOf(doc, pid).find((f) => f.id === fid);

export const renameFolder = (doc: WrenDoc, folderId: string, name: string, pid = PART): WrenDoc =>
  apply(doc, { kind: 'renameFolder', partId: pid, folderId, name });

export const removeFolder = (doc: WrenDoc, folderId: string, pid = PART): WrenDoc =>
  apply(doc, { kind: 'removeFolder', partId: pid, folderId });

export const addFolder = (doc: WrenDoc, f: FeatureFolder, pid = PART): WrenDoc =>
  apply(doc, { kind: 'addFolder', partId: pid, folder: structuredClone(f) });

export const setMembers = (doc: WrenDoc, fid: string, features: string[], pid = PART): WrenDoc =>
  editPart(
    doc,
    (p) => {
      const f = p.folders?.find((x) => x.id === fid);
      if (!f) throw new Error(`no folder ${fid}`);
      f.features = features.slice();
    },
    pid,
  );

/** Reorders features to `order` (ids), keeping folders as they are. */
export const reorder = (doc: WrenDoc, order: string[], pid = PART): WrenDoc =>
  editPart(
    doc,
    (p) => {
      const by = new Map(p.features.map((f) => [f.id, f]));
      p.features = order.map((id) => by.get(id) as Feature);
    },
    pid,
  );

/**
 * The `moveFolder` command: the run moves so its first member sits at `toIndex` of the features
 * with the run taken out. Throws when that lands inside another folder's run.
 */
/**
 * The `moveFolder` command: the run moves so its first member sits at `toIndex` of the features
 * with the run taken out.
 */
export const moveFolder = (doc: WrenDoc, folderId: string, toIndex: number, pid = PART): WrenDoc =>
  apply(doc, { kind: 'moveFolder', partId: pid, folderId, toIndex });

export const moveFeatureF = (doc: WrenDoc, featureId: string, toIndex: number, pid = PART) =>
  apply(doc, { kind: 'moveFeature', partId: pid, featureId, toIndex });

export const removeFeatureF = (doc: WrenDoc, featureId: string, pid = PART) =>
  apply(doc, { kind: 'removeFeature', partId: pid, featureId });

export const addFeatureF = (doc: WrenDoc, feature: Feature, index: number, pid = PART) =>
  apply(doc, { kind: 'addFeature', partId: pid, feature, index });

/** `setSketchVisibility`; `undefined` removes the field (an older file, or another tool's edit). */
export function setVisibility(
  doc: WrenDoc,
  sketchId: string,
  visibility: SketchVisibility | undefined,
  pid = PART,
): WrenDoc {
  if (visibility !== undefined) {
    return apply(doc, {
      kind: 'setSketchVisibility',
      partId: pid,
      featureIds: [sketchId],
      visibility,
    });
  }
  return editPart(
    doc,
    (p) => {
      const s = p.features.find((f) => f.id === sketchId) as SketchFeature | undefined;
      if (s?.type !== 'sketch') throw new Error(`no sketch ${sketchId}`);
      delete s.visibility;
    },
    pid,
  );
}

/** Breaks of the folder invariant (ADR-066) in every part of `doc`; empty when it holds. */
export function folderProblems(doc: WrenDoc): string[] {
  const out: string[] = [];
  for (const p of doc.parts) {
    const at = new Map(p.features.map((f, i) => [f.id, i]));
    const owner = new Map<string, string>();
    for (const f of p.folders ?? []) {
      if (f.features.length === 0) out.push(`${p.id}/${f.id}: empty`);
      const pos = f.features.map((x) => at.get(x));
      if (pos.some((x) => x === undefined)) out.push(`${p.id}/${f.id}: missing member`);
      const ok = pos.every((x, i) => i === 0 || x === (pos[i - 1] as number) + 1);
      if (!ok) out.push(`${p.id}/${f.id}: not a contiguous run in history order ${pos.join(',')}`);
      for (const x of f.features) {
        const o = owner.get(x);
        if (o !== undefined) out.push(`${p.id}: ${x} in ${o} and ${f.id}`);
        owner.set(x, f.id);
      }
    }
  }
  return out;
}
