// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Feature tree folder states for merge tests (M3.6, ADR-066). The document package's folder
 * commands are being written in parallel, so these build folder edits directly, following the
 * membership rules in `Command` (contracts/store.ts): removing a feature drops it from its folder
 * (an emptied folder goes); a member moved outside its run leaves; a non-member moved or added
 * strictly inside a run joins.
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

export const renameFolder = (doc: WrenDoc, fid: string, name: string, pid = PART): WrenDoc =>
  editPart(
    doc,
    (p) => {
      const f = p.folders?.find((x) => x.id === fid);
      if (!f) throw new Error(`no folder ${fid}`);
      f.name = name;
    },
    pid,
  );

export const removeFolder = (doc: WrenDoc, fid: string, pid = PART): WrenDoc =>
  editPart(
    doc,
    (p) => {
      p.folders = (p.folders ?? []).filter((f) => f.id !== fid);
      if (p.folders.length === 0) delete p.folders;
    },
    pid,
  );

export const addFolder = (doc: WrenDoc, f: FeatureFolder, pid = PART): WrenDoc =>
  editPart(
    doc,
    (p) => {
      p.folders = [...(p.folders ?? []), structuredClone(f)];
    },
    pid,
  );

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
export function moveFolder(doc: WrenDoc, fid: string, toIndex: number, pid = PART): WrenDoc {
  return editPart(
    doc,
    (p) => {
      const f = p.folders?.find((x) => x.id === fid);
      if (!f) throw new Error(`no folder ${fid}`);
      const run = new Set(f.features);
      const rest = p.features.filter((x) => !run.has(x.id));
      const members = p.features.filter((x) => run.has(x.id));
      const at = Math.max(0, Math.min(rest.length, toIndex));
      for (const g of p.folders ?? []) {
        if (g.id === fid) continue;
        const idx = g.features.map((x) => rest.findIndex((r) => r.id === x));
        if (Math.min(...idx) < at && at <= Math.max(...idx)) throw new Error('inside another folder');
      }
      p.features = [...rest.slice(0, at), ...members, ...rest.slice(at)];
    },
    pid,
  );
}

/** Membership follows a feature that moved, was added or was removed (the `Command` rules). */
function follow(part: Part, moved: string | null, removed: string | null): void {
  const at = new Map(part.features.map((f, i) => [f.id, i]));
  const out: FeatureFolder[] = [];
  for (const f of part.folders ?? []) {
    let members = f.features.filter((x) => x !== removed);
    if (moved !== null) {
      const others = members.filter((x) => x !== moved);
      const pos = others.map((x) => at.get(x) as number);
      const lo = Math.min(...pos);
      const hi = Math.max(...pos);
      const m = at.get(moved) as number;
      if (members.includes(moved)) {
        if (others.length > 0 && (m < lo - 1 || m > hi + 1)) members = others;
      } else if (others.length > 1 && lo < m && m < hi) members = [...others, moved];
    }
    members.sort((a, b) => (at.get(a) as number) - (at.get(b) as number));
    if (members.length > 0) out.push({ ...f, features: members });
  }
  if (out.length > 0) part.folders = out;
  else delete part.folders;
}

export function moveFeatureF(doc: WrenDoc, fid: string, toIndex: number, pid = PART): WrenDoc {
  const next = apply(doc, { kind: 'moveFeature', partId: pid, featureId: fid, toIndex });
  return editPart(next, (p) => follow(p, fid, null), pid);
}

export function removeFeatureF(doc: WrenDoc, fid: string, pid = PART): WrenDoc {
  const next = apply(doc, { kind: 'removeFeature', partId: pid, featureId: fid });
  return editPart(next, (p) => follow(p, null, fid), pid);
}

export function addFeatureF(doc: WrenDoc, feature: Feature, index: number, pid = PART): WrenDoc {
  const next = apply(doc, { kind: 'addFeature', partId: pid, feature, index });
  return editPart(next, (p) => follow(p, feature.id, null), pid);
}

export const setVisibility = (
  doc: WrenDoc,
  sketchId: string,
  visibility: SketchVisibility | undefined,
  pid = PART,
): WrenDoc =>
  editPart(
    doc,
    (p) => {
      const s = p.features.find((f) => f.id === sketchId) as SketchFeature | undefined;
      if (s?.type !== 'sketch') throw new Error(`no sketch ${sketchId}`);
      if (visibility === undefined) delete s.visibility;
      else s.visibility = visibility;
    },
    pid,
  );

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
