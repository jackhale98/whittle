// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Human labels for what a conflict or a change is about ("Fillet 3", "Parameter width",
 * "Line 2 in Sketch 1"). Sketch geometry is named like the sketcher names it (`Namer`: kind and
 * 1-based ordinal in the sketch's entity order), so the merge UI and the solver messages agree.
 */

import type {
  DiffSubject,
  Feature,
  FeatureFolder,
  MergeConflict,
  Param,
  Part,
  SketchConstraint,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { constraintLabel, Namer } from '@wren-cad/sketch';
import type { FolderChange } from './folders';
import { formatValue, plural } from './format';
import { fromPointer, getAtSegs, isObj, type Segs } from './tree';

const META_LABEL: Record<string, string> = {
  name: 'Document name',
  partNumber: 'Part number',
  created: 'Created',
  modified: 'Modified',
  app: 'Saved by',
  id: 'Document id',
};

/** First version (in preference order) that has something at `segs`. */
function find<T>(docs: readonly (WrenDoc | undefined)[], segs: Segs): T | undefined {
  for (const d of docs) {
    const v = d === undefined ? undefined : getAtSegs(d, segs);
    if (v !== undefined) return v as T;
  }
  return undefined;
}

export function entityLabel(sketch: SketchFeature, entityId: string): string {
  return `${new Namer(sketch.entities).entity(entityId)} in ${sketch.name}`;
}

export function constraintText(sketch: SketchFeature, c: SketchConstraint): string {
  return constraintLabel(c, new Namer(sketch.entities), {});
}

/**
 * The subject of the value at `segs`. `docs` are the versions to take names from, most preferred
 * first (for a conflict: ours, theirs, base; for a diff: after, before).
 */
export function subjectAt(segs: Segs, docs: readonly (WrenDoc | undefined)[]): DiffSubject {
  const [top, id, sub, fid, coll, itemId] = segs;
  if (top === 'meta') {
    return { kind: 'doc', label: META_LABEL[id ?? ''] ?? (id ? `Document ${id}` : 'Document') };
  }
  if (top === 'units') return { kind: 'doc', label: id ? `Units (${id})` : 'Units' };
  if (top === 'params') {
    if (id === undefined) return { kind: 'doc', label: 'Parameter order' };
    const p = find<Param>(docs, ['params', id]);
    return { kind: 'param', id, label: `Parameter ${p?.name ?? id}` };
  }
  if (top === 'drawings' || top === 'assemblies') {
    const kind = top === 'drawings' ? 'drawing' : 'assembly';
    if (id === undefined)
      return { kind: 'doc', label: top === 'drawings' ? 'Drawing order' : 'Assembly order' };
    const x = find<{ name: string }>(docs, [top, id]);
    return { kind, id, label: x?.name ?? id };
  }
  if (top === 'parts') {
    if (id === undefined) return { kind: 'doc', label: 'Part order' };
    const part = find<Part>(docs, ['parts', id]);
    const partName = part?.name ?? id;
    if (sub === 'material')
      return { kind: 'material', partId: id, label: `Material of ${partName}` };
    if (sub === 'folders') {
      // Contracts have no folder subject yet: a folder is shown as part of its part.
      if (fid === undefined) return { kind: 'part', id, label: `Folders in ${partName}` };
      const folder = find<FeatureFolder>(docs, ['parts', id, 'folders', fid]);
      return { kind: 'part', id, label: `Folder ${folder?.name ?? fid}` };
    }
    if (sub !== 'features') return { kind: 'part', id, label: partName };
    if (fid === undefined) return { kind: 'part', id, label: `Feature order in ${partName}` };
    const feature = find<Feature>(docs, ['parts', id, 'features', fid]);
    const name = feature?.name ?? fid;
    if (feature?.type === 'sketch' && (coll === 'entities' || coll === 'constraints')) {
      const sketchSegs = ['parts', id, 'features', fid];
      if (itemId === undefined) {
        return {
          kind: 'feature',
          id: fid,
          partId: id,
          label: coll === 'entities' ? `Geometry order in ${name}` : `Constraint order in ${name}`,
        };
      }
      // Name the item in the version that has it, so the ordinal matches what that user saw.
      const itemSegs = [...sketchSegs, coll, itemId];
      for (const d of docs) {
        const s = d === undefined ? undefined : (getAtSegs(d, sketchSegs) as SketchFeature);
        const item = d === undefined ? undefined : getAtSegs(d, itemSegs);
        if (s?.type !== 'sketch' || item === undefined) continue;
        if (coll === 'entities') {
          return {
            kind: 'sketchEntity',
            id: itemId,
            partId: id,
            featureId: fid,
            label: entityLabel(s, itemId),
          };
        }
        return {
          kind: 'sketchConstraint',
          id: itemId,
          partId: id,
          featureId: fid,
          label: `${constraintText(s, item as SketchConstraint)} in ${s.name}`,
        };
      }
      return {
        kind: coll === 'entities' ? 'sketchEntity' : 'sketchConstraint',
        id: itemId,
        partId: id,
        featureId: fid,
        label: `${itemId} in ${name}`,
      };
    }
    if (coll === 'annotations') {
      return { kind: 'feature', id: fid, partId: id, label: `Annotation on ${name}` };
    }
    return { kind: 'feature', id: fid, partId: id, label: name };
  }
  return { kind: 'doc', label: top === 'schemaVersion' ? 'Document version' : 'Document' };
}

/** "radius", "depth", "distance": the last meaningful segment of a field path inside a subject. */
export function fieldLabel(rel: Segs): string {
  const last = rel[rel.length - 1] ?? '';
  return FIELD_LABEL[last] ?? last;
}

const FIELD_LABEL: Record<string, string> = {
  expr: 'value',
  dx: 'X size',
  dy: 'Y size',
  dz: 'Z size',
  on: 'sketch plane',
  keepTools: 'keep tools',
  rollbackIndex: 'rollback',
  partNumber: 'part number',
  libraryId: 'library material',
  color: 'colour',
  openFaces: 'open faces',
  equalSpacing: 'equal spacing',
  tipAngle: 'tip angle',
};

// ---------------------------------------------------------------------------------------------
// Folders and sketch visibility (M3.6)
// ---------------------------------------------------------------------------------------------

/** "automatic", "shown", "hidden" (absent = automatic). */
export function visibilityText(v: unknown): string {
  return v === undefined || v === 'auto' ? 'automatic' : String(v);
}

/**
 * The merge report's line for one normalisation change, or `null` when it needs none (a member
 * that was deleted). `name` gives a feature's or folder's display name by id.
 */
export function folderChangeSummary(
  change: FolderChange,
  name: (id: string) => string,
): string | null {
  const folder = name(change.folderId);
  if (change.kind === 'removed')
    return `Folder ${folder} was removed: none of its features are left`;
  const feature = name(change.featureId);
  if (change.kind === 'joined') {
    return `${feature} joined folder ${folder} to keep the folder in one piece`;
  }
  if (change.reason === 'split')
    return `${feature} left folder ${folder} to keep the folder in one piece`;
  if (change.reason === 'shared') {
    return `${feature} left folder ${folder}: it is already in folder ${name(change.keptBy)}`;
  }
  return null;
}

/** Number of segments that select a conflict's subject (the rest is the field inside it). */
function subjectDepth(segs: Segs): number {
  const [top, , sub, , coll] = segs;
  if (top === 'parts') {
    if (sub === 'features') return coll === 'entities' || coll === 'constraints' ? 6 : 4;
    if (sub === 'folders') return 4;
    if (sub === 'material') return 3;
    return 2;
  }
  if (top === 'params' || top === 'drawings' || top === 'assemblies') return 2;
  return segs.length; // document fields: the subject's label already names the field
}

/** The field a conflict is about inside its subject ("visibility", "radius"), or `''`. */
export function conflictField(c: Pick<MergeConflict, 'path' | 'file'>): string {
  if (c.file !== undefined) return '';
  const segs = fromPointer(c.path);
  const rel = segs.slice(subjectDepth(segs));
  return rel.length === 0 ? '' : fieldLabel(rel);
}

/** One side's value of a conflict as short text: "shown", "2 mm", "Mounting (3 features)". */
export function conflictValueText(value: unknown, c: Pick<MergeConflict, 'path' | 'file'>): string {
  const segs = c.file === undefined ? fromPointer(c.path) : [];
  const leaf = segs[segs.length - 1];
  if (segs.length === 5 && segs[2] === 'features' && leaf === 'visibility') {
    return visibilityText(value);
  }
  if (value === undefined) return 'deleted';
  if (segs.length === 4 && segs[2] === 'folders' && isObj(value)) {
    const f = value as Partial<FeatureFolder>;
    const n = Array.isArray(f.features) ? f.features.length : 0;
    return `${f.name ?? 'Folder'} (${plural(n, 'feature')})`;
  }
  return formatValue(value) ?? 'changed';
}

/** One line for a conflict: "Sketch 2 visibility: shown vs hidden", "Folder Mounting name: A vs B". */
export function conflictSummary(c: MergeConflict): string {
  const field = conflictField(c);
  const what = field ? `${c.subject.label} ${field}` : c.subject.label;
  return `${what}: ${conflictValueText(c.ours, c)} vs ${conflictValueText(c.theirs, c)}`;
}
