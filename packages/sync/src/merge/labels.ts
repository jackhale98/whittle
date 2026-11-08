// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Human labels for what a conflict or a change is about ("Fillet 3", "Parameter width",
 * "Line 2 in Sketch 1"). Sketch geometry is named like the sketcher names it (`Namer`: kind and
 * 1-based ordinal in the sketch's entity order), so the merge UI and the solver messages agree.
 */

import type {
  DiffSubject,
  Feature,
  Param,
  Part,
  SketchConstraint,
  SketchFeature,
  WhittleDoc,
} from '@whittle/contracts';
import { constraintLabel, Namer } from '@whittle/sketch';
import { getAtSegs, type Segs } from './tree';

const META_LABEL: Record<string, string> = {
  name: 'Document name',
  partNumber: 'Part number',
  created: 'Created',
  modified: 'Modified',
  app: 'Saved by',
  id: 'Document id',
};

/** First version (in preference order) that has something at `segs`. */
function find<T>(docs: readonly (WhittleDoc | undefined)[], segs: Segs): T | undefined {
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
export function subjectAt(segs: Segs, docs: readonly (WhittleDoc | undefined)[]): DiffSubject {
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
