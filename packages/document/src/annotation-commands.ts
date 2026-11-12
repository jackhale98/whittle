// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Compiles the M4 annotation commands (ADR-090). Each command is one undo step. Annotations live
 * on the part, sorted by id; removing one also removes its placements and configuration overrides
 * in the same step, and never rebinds anything silently.
 */

import type {
  Annotation,
  AnnotationCommand,
  DatumCompartment,
  Id,
  JsonPatchOp,
  RefPoint,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  annotationProblems,
  annotationRefsProblem,
  describeAnnotation,
  REF_POINTS,
} from './annotations';
import { Checker } from './check';
import {
  type Compiled,
  err,
  firstProblem,
  newIdChecker,
  partIndex,
  plural,
  SortedSet,
} from './command-support';
import { configurationPruneOps } from './configurations';
import { checkPlacement, roundPlacement } from './drawings';
import { markupAnchorOps } from './markup-anchors';
import { diff } from './patch';

type Cmd<K extends AnnotationCommand['kind']> = Extract<AnnotationCommand, { kind: K }>;

export function compileAnnotationCommand(
  doc: WrenDoc,
  cmd: AnnotationCommand,
  used: Set<string>,
): Compiled {
  const pi = partIndex(doc, cmd.partId);
  if (pi < 0) return err(`Part ‘${cmd.partId}’ was not found`);
  switch (cmd.kind) {
    case 'addAnnotation':
      return compileAdd(doc, pi, cmd, used);
    case 'updateAnnotation':
      return compileUpdate(doc, pi, cmd);
    case 'removeAnnotation':
      return compileRemove(doc, pi, cmd);
    case 'reattachAnnotation':
      return compileReattach(doc, pi, cmd);
  }
}

function compileAdd(
  doc: WrenDoc,
  pi: number,
  cmd: Cmd<'addAnnotation'>,
  used: Set<string>,
): Compiled {
  const part = doc.parts[pi] as WrenDoc['parts'][number];
  const a = structuredClone(cmd.annotation);
  const taken = new Set(used);
  const c = newIdChecker(taken);
  const bad = annotationProblems(a);
  if (bad.length > 0) return err(`Invalid annotation: ${bad[0]}`);
  c.id(a.id, 'annotation.id');
  const origin = a.origin;
  if (origin.kind === 'drawing' && !doc.drawings.some((d) => d.id === origin.drawingId)) {
    return err(`Drawing ‘${origin.drawingId}’ was not found`);
  }
  const ops: JsonPatchOp[] = [];
  new SortedSet(`/parts/${pi}/annotations`, part.annotations, ops, true).add(a);
  if (cmd.place) {
    const di = doc.drawings.findIndex((d) => d.id === cmd.place?.drawingId);
    const d = doc.drawings[di];
    if (!d) return err(`Drawing ‘${cmd.place.drawingId}’ was not found`);
    if (d.subject.partId !== cmd.partId) return err('That drawing shows a different part');
    const p = roundPlacement(structuredClone(cmd.place.placement));
    checkPlacement(c, p, 'placement');
    if (p.annotationId !== a.id) return err('The placement must be of the new annotation');
    if (!d.views.some((v) => v.id === p.viewId)) return err(`View ‘${p.viewId}’ was not found`);
    const bad2 = firstProblem(c, 'Invalid placement');
    if (bad2) return bad2;
    new SortedSet(`/drawings/${di}/placements`, d.placements, ops, false).add(p);
  } else {
    const bad2 = firstProblem(c, 'Invalid annotation');
    if (bad2) return bad2;
  }
  return { ok: true, label: `Add ${describeAnnotation(a)}`, ops };
}

function compileUpdate(doc: WrenDoc, pi: number, cmd: Cmd<'updateAnnotation'>): Compiled {
  const part = doc.parts[pi] as WrenDoc['parts'][number];
  const k = (part.annotations ?? []).findIndex((a) => a.id === cmd.annotationId);
  const old = part.annotations?.[k];
  if (!old) return err(`Annotation ‘${cmd.annotationId}’ was not found`);
  if (cmd.annotation.id !== cmd.annotationId) return err('An annotation’s id cannot be changed');
  const bad = annotationProblems(cmd.annotation);
  if (bad.length > 0) return err(`Invalid annotation: ${bad[0]}`);
  return {
    ok: true,
    label: `Edit ${describeAnnotation(cmd.annotation)}`,
    ops: diff(old, cmd.annotation, `/parts/${pi}/annotations/${k}`),
  };
}

/**
 * Patch ops that remove annotations of a part together with everything that hangs on them:
 * placements in every drawing (except `skipDrawingId`, which is being removed whole), markup
 * anchors to those placements, and configuration overrides. Frames bound to a removed datum keep
 * its letter as `{ label }`; a frame's or a datum's `appliesTo` that pointed at a removed dimension
 * stays (ADR-094). Both then show as needs attention, never as a silent rebinding.
 */
export function annotationRemovalOps(
  doc: WrenDoc,
  pi: number,
  ids: ReadonlySet<Id>,
  skipDrawingId?: Id,
): JsonPatchOp[] {
  const part = doc.parts[pi] as WrenDoc['parts'][number];
  const ops: JsonPatchOp[] = [];
  const annotations = new SortedSet(`/parts/${pi}/annotations`, part.annotations, ops, true);
  const letters = new Map<Id, string>();
  for (const a of part.annotations ?? []) {
    if (a.kind === 'datumFeature' && ids.has(a.id)) letters.set(a.id, a.label);
  }
  if (letters.size > 0) {
    for (const a of part.annotations ?? []) {
      if (ids.has(a.id) || a.kind !== 'geometricTolerance' || !a.datums) continue;
      let changed = false;
      const datums: DatumCompartment[] = a.datums.map((comp) => ({
        ...comp,
        datums: comp.datums.map((r) => {
          if ('datum' in r && letters.has(r.datum)) {
            changed = true;
            return { label: letters.get(r.datum) as string };
          }
          return r;
        }),
      }));
      if (changed) annotations.replace({ ...a, datums });
    }
  }
  doc.drawings.forEach((d, di) => {
    if (d.id === skipDrawingId) return;
    const gone = d.placements.filter((p) => ids.has(p.annotationId));
    if (gone.length === 0) return;
    const goneIds = new Set(gone.map((p) => p.id));
    ops.push(...markupAnchorOps(d, `/drawings/${di}`, { placementIds: goneIds }));
    const set = new SortedSet(`/drawings/${di}/placements`, d.placements, ops, false);
    for (const p of gone) set.remove(p.id);
  });
  for (const id of [...ids].sort()) annotations.remove(id);
  ops.push(...configurationPruneOps(part, pi, { annotationIds: ids }));
  return ops;
}

function compileRemove(doc: WrenDoc, pi: number, cmd: Cmd<'removeAnnotation'>): Compiled {
  const part = doc.parts[pi] as WrenDoc['parts'][number];
  const ids = new Set(cmd.annotationIds);
  if (ids.size === 0) return err('Choose at least one annotation to remove');
  for (const id of ids) {
    if (!part.annotations?.some((a) => a.id === id)) return err(`Annotation ‘${id}’ was not found`);
  }
  const first = part.annotations?.find((a) => ids.has(a.id)) as Annotation;
  return {
    ok: true,
    label:
      ids.size === 1
        ? `Delete ${describeAnnotation(first)}`
        : `Delete ${plural(ids.size, 'annotation', 'annotations')}`,
    ops: annotationRemovalOps(doc, pi, ids),
  };
}

function compileReattach(doc: WrenDoc, pi: number, cmd: Cmd<'reattachAnnotation'>): Compiled {
  const part = doc.parts[pi] as WrenDoc['parts'][number];
  const k = (part.annotations ?? []).findIndex((a) => a.id === cmd.annotationId);
  const old = part.annotations?.[k];
  if (!old) return err(`Annotation ‘${cmd.annotationId}’ was not found`);
  const c = new Checker();
  if (!Array.isArray(cmd.refs)) return err('The references must be a list');
  cmd.refs.forEach((r, i) => {
    if (typeof r?.name !== 'string' || r.name === '')
      c.err(`refs[${i}] must be an entity reference`);
  });
  if (cmd.at !== undefined) {
    if (!Array.isArray(cmd.at) || cmd.at.length > cmd.refs.length) {
      c.err('at must not be longer than refs');
    } else {
      cmd.at.forEach((p, i) => {
        if (!(REF_POINTS as readonly string[]).includes(p))
          c.err(`at[${i}] is not a point of an entity`);
      });
    }
  }
  const bad = firstProblem(c, 'Invalid reattach');
  if (bad) return bad;
  const next = { ...old, refs: structuredClone(cmd.refs) } as Annotation;
  const at: RefPoint[] | undefined = cmd.at ?? old.at?.slice(0, cmd.refs.length);
  if (at && at.length > 0) next.at = at;
  else delete next.at;
  const problem = annotationRefsProblem(next);
  if (problem) return err(problem);
  return {
    ok: true,
    label: `Reattach ${describeAnnotation(old)}`,
    ops: diff(old, next, `/parts/${pi}/annotations/${k}`),
  };
}
