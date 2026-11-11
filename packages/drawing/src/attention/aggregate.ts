/**
 * Needs-attention aggregation for a drawing (ADR-090 §2.7, §4.4): the regen's
 * `AnnotationResolution`s, the semantic `annotationIssues` (packages/document, injected), the
 * placement checks from the layout and the view problems, merged into one searchable list with
 * the sheet, grid zone ("C4") and upstream cause of each entry.
 *
 * Severity: `attention` (drawn in the attention colour; never shown as fine), `warning`
 * (standard mismatch, placed twice, possible configuration mismatch), `info` (not in this
 * configuration: suppression is known exactly, so it is not an error).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationIssue,
  AnnotationResolution,
  AttentionCause,
  Drawing,
  DrawingView,
  GpsStandard,
  Id,
  UnresolvedRef,
  Vec2,
} from '@wren-cad/contracts';
import type { PlacedAnnotation, PlacementIssue } from '../placement/layout';
import { zoneAt } from '../template';
import type { TemplateLayout } from '../template/types';
import type { ViewProblem, ViewSolution } from '../view/solve';
import { viewOutline } from '../view/solve';

export type Severity = 'attention' | 'warning' | 'info';

export type AttentionSubject =
  | { kind: 'drawing' }
  | { kind: 'view'; viewId: Id }
  | { kind: 'annotation'; annotationId: Id; placementId?: Id; viewId?: Id };

export interface AttentionEntry {
  /** Stable key (list identity, dedupe). */
  key: string;
  severity: Severity;
  subject: AttentionSubject;
  sheetId?: Id;
  /** Grid zone on the sheet, when the template has zones. */
  zone?: string;
  message: string;
  cause?: AttentionCause;
  unresolved?: UnresolvedRef[];
  issue?: AnnotationIssue | PlacementIssue | ViewProblem;
}

export interface AttentionInput {
  drawing: Drawing;
  /** The subject part's annotations; undefined = the part is missing (the whole drawing). */
  annotations: readonly Annotation[] | undefined;
  /** Existing configuration ids of the subject part. */
  configurationIds: ReadonlySet<Id>;
  views: ReadonlyMap<Id, ViewSolution>;
  /** Resolutions for a configuration (`null` = Default), as the regen returned them. */
  resolutions: (configurationId: Id | null) => ReadonlyMap<Id, AnnotationResolution> | undefined;
  /** Semantic checks (packages/document `annotationIssues`, injected). */
  annotationIssues: (annotation: Annotation, standard: GpsStandard) => AnnotationIssue[];
  /** Layout results per placement. */
  placed: readonly PlacedAnnotation[];
  /** Template layout per sheet (grid zones). */
  templates: ReadonlyMap<Id, TemplateLayout>;
}

/** The configuration a view shows: absent inherits the drawing's; `null` = Default. */
export function viewConfiguration(drawing: Drawing, view: DrawingView): Id | null {
  if (view.configurationId === undefined) return drawing.configurationId ?? null;
  return view.configurationId;
}

const SEVERITY: Record<AnnotationIssue['kind'], Severity> = {
  valueMismatch: 'attention',
  illegalForStandard: 'attention',
  standardMismatch: 'warning',
  datumUnbound: 'attention',
  duplicateDatumLabel: 'attention',
  duplicateCallout: 'warning',
  refsDoNotFit: 'attention',
  directionMissing: 'attention',
  sourceGone: 'attention',
  configurationMissing: 'attention',
  notMeasurableInView: 'attention',
  placedTwice: 'warning',
};

function annotationName(a: Annotation | undefined): string {
  if (!a) return 'Annotation';
  switch (a.kind) {
    case 'datumFeature':
      return `Datum ${a.label || '?'}`;
    case 'geometricTolerance':
      return 'Feature control frame';
    case 'surfaceFinish':
      return 'Surface texture';
    case 'holeCallout':
      return 'Hole callout';
    case 'note':
      return 'Note';
    default:
      return `${a.kind[0]?.toUpperCase()}${a.kind.slice(1)} dimension`;
  }
}

export function issueMessage(i: AnnotationIssue, name: string): string {
  switch (i.kind) {
    case 'valueMismatch':
      return `${name}: the value ${i.shown} differs from the model (${i.measured})`;
    case 'illegalForStandard':
      return `${name}: ${i.message}`;
    case 'standardMismatch':
      return `${name} follows ${i.annotation}; this drawing uses ${i.drawing}`;
    case 'datumUnbound':
      return `Datum ${i.label} is not defined`;
    case 'duplicateDatumLabel':
      return `Datum letter ${i.label} is used twice`;
    case 'duplicateCallout':
      return `${name}: the hole feature already has a callout`;
    case 'refsDoNotFit':
      return `${name}: ${i.message}`;
    case 'directionMissing':
      return `${name}: choose a direction`;
    case 'sourceGone':
      return `${name}: what drives its value no longer exists`;
    case 'configurationMissing':
      return `Configuration no longer exists (${i.configurationId})`;
    case 'notMeasurableInView':
      return `${name} can't be measured in this view (seen end-on)`;
    case 'placedTwice':
      return `${name} is placed ${i.placementIds.length} times on this drawing`;
  }
}

function placementMessage(i: PlacementIssue, name: string): string {
  switch (i.kind) {
    case 'notMeasurableInView':
      return `${name} can't be measured in this view (seen end-on)`;
    case 'layoutDoesNotFit':
      return `${name}: a ${i.layout} placement does not fit a ${i.annotation} annotation`;
    case 'anchorsMissing':
      return `${name}: its geometry could not be found`;
    case 'attachTargetMissing':
      return `${name}: what its leader attaches to is gone`;
    case 'directionMissing':
      return `${name}: choose a direction`;
  }
}

function viewMessage(p: ViewProblem): string {
  switch (p.kind) {
    case 'sheetMissing':
      return 'The view’s sheet no longer exists';
    case 'parentMissing':
      return 'The view this one projects from no longer exists';
    case 'parentCycle':
      return 'Views project from each other in a loop';
    case 'parentUnresolved':
      return 'The view this one projects from needs attention';
    case 'scaleInvalid':
      return `The scale “${p.expr}” is not a positive ratio`;
    case 'rotationInvalid':
      return `The rotation “${p.expr}” is not an angle`;
    case 'cutInvalid':
      return p.message;
    case 'pointUnresolved':
      return `A ${p.path.startsWith('/cut') ? 'cut line point' : 'detail centre'} follows ${p.ref.name}, which no longer exists`;
  }
}

function centre(box: Vec2[]): Vec2 | undefined {
  if (box.length === 0) return undefined;
  const s = box.reduce((a, p) => [a[0] + p[0], a[1] + p[1]] as Vec2, [0, 0] as Vec2);
  return [s[0] / box.length, s[1] / box.length];
}

const ORDER: Record<Severity, number> = { attention: 0, warning: 1, info: 2 };

/** Builds the drawing's needs-attention list (deterministic order). */
export function aggregateAttention(input: AttentionInput): AttentionEntry[] {
  const { drawing } = input;
  const out: AttentionEntry[] = [];
  const sheetIndex = new Map(drawing.sheets.map((s, i) => [s.id, i]));
  const viewById = new Map(drawing.views.map((v) => [v.id, v]));
  const zone = (sheetId: Id | undefined, p: Vec2 | undefined) => {
    const t = sheetId ? input.templates.get(sheetId) : undefined;
    const z = t && p ? zoneAt(t, p) : null;
    return z ?? undefined;
  };

  if (!input.annotations) {
    out.push({
      key: 'drawing:subject',
      severity: 'attention',
      subject: { kind: 'drawing' },
      message: 'The part this drawing shows no longer exists',
    });
  }
  if (drawing.configurationId && !input.configurationIds.has(drawing.configurationId)) {
    const issue: AnnotationIssue = {
      kind: 'configurationMissing',
      configurationId: drawing.configurationId,
    };
    out.push({
      key: 'drawing:configuration',
      severity: 'attention',
      subject: { kind: 'drawing' },
      message: issueMessage(issue, ''),
      issue,
    });
  }

  // Views.
  for (const v of drawing.views) {
    const sol = input.views.get(v.id);
    const at = sol?.ok ? sol.position : undefined;
    const base = {
      subject: { kind: 'view' as const, viewId: v.id },
      sheetId: v.sheetId,
      ...(zone(v.sheetId, at) ? { zone: zone(v.sheetId, at) } : {}),
    };
    if (sol && !sol.ok)
      for (const [i, p] of sol.problems.entries()) {
        out.push({
          ...base,
          key: `view:${v.id}:${i}`,
          severity: 'attention',
          message: viewMessage(p),
          issue: p,
        });
      }
    if (typeof v.configurationId === 'string' && !input.configurationIds.has(v.configurationId)) {
      const issue: AnnotationIssue = {
        kind: 'configurationMissing',
        configurationId: v.configurationId,
      };
      out.push({
        ...base,
        key: `view:${v.id}:configuration`,
        severity: 'attention',
        message: issueMessage(issue, ''),
        issue,
      });
    } else if (
      v.configurationId !== undefined &&
      v.configurationId !== (drawing.configurationId ?? null)
    ) {
      out.push({
        ...base,
        key: `view:${v.id}:configurationDiffers`,
        severity: 'warning',
        message: 'This view shows a different configuration from the drawing',
      });
    }
  }

  // Annotations, per placement.
  const anns = new Map((input.annotations ?? []).map((a) => [a.id, a]));
  const issueCache = new Map<Id, AnnotationIssue[]>();
  const issuesOf = (a: Annotation) => {
    let r = issueCache.get(a.id);
    if (!r) {
      r = input.annotationIssues(a, drawing.standard.gps);
      issueCache.set(a.id, r);
    }
    return r;
  };
  const reported = new Set<string>();
  for (const p of input.placed) {
    const a = anns.get(p.annotationId);
    const view = viewById.get(p.viewId);
    const name = annotationName(a);
    const sheetId = view?.sheetId;
    const z =
      zone(sheetId, centre(p.textBox)) ??
      (() => {
        const sol = input.views.get(p.viewId);
        return sol?.ok
          ? zone(sheetId, centre([viewOutline(sol).min, viewOutline(sol).max]))
          : undefined;
      })();
    const subject: AttentionSubject = {
      kind: 'annotation',
      annotationId: p.annotationId,
      placementId: p.placementId,
      viewId: p.viewId,
    };
    const base = { subject, ...(sheetId ? { sheetId } : {}), ...(z ? { zone: z } : {}) };
    const conf = view ? viewConfiguration(drawing, view) : null;
    const res = input.resolutions(conf)?.get(p.annotationId);
    if (p.suppressed) {
      out.push({
        ...base,
        key: `placement:${p.placementId}:suppressed`,
        severity: 'info',
        message: `${name}: not in this configuration`,
      });
      continue;
    }
    if (res?.state === 'needsAttention' || (!res && a)) {
      out.push({
        ...base,
        key: `placement:${p.placementId}:resolution`,
        severity: 'attention',
        message: res?.unresolved?.length
          ? `${name}: ${res.unresolved.length === 1 ? 'a reference' : `${res.unresolved.length} references`} no longer resolve${res.unresolved.length === 1 ? 's' : ''}`
          : res?.error
            ? `${name}: ${res.error.message}`
            : `${name} needs attention`,
        ...(res?.cause ? { cause: res.cause } : {}),
        ...(res?.unresolved ? { unresolved: res.unresolved } : {}),
      });
    }
    for (const [k, i] of p.issues.entries()) {
      out.push({
        ...base,
        key: `placement:${p.placementId}:issue:${k}`,
        severity:
          i.kind === 'layoutDoesNotFit' ||
          i.kind === 'notMeasurableInView' ||
          i.kind === 'anchorsMissing' ||
          i.kind === 'attachTargetMissing' ||
          i.kind === 'directionMissing'
            ? 'attention'
            : 'warning',
        message: placementMessage(i, name),
        issue: i,
      });
    }
    if (a && !reported.has(a.id)) {
      reported.add(a.id);
      for (const [k, i] of issuesOf(a).entries()) {
        out.push({
          ...base,
          key: `annotation:${a.id}:issue:${k}`,
          severity: SEVERITY[i.kind],
          message: issueMessage(i, name),
          issue: i,
        });
      }
    }
  }

  // Placed twice in this drawing (hole callouts may appear in any number of views).
  const byAnnotation = new Map<Id, Id[]>();
  for (const pl of drawing.placements)
    byAnnotation.set(pl.annotationId, [...(byAnnotation.get(pl.annotationId) ?? []), pl.id]);
  for (const [annotationId, ids] of byAnnotation) {
    const a = anns.get(annotationId);
    if (ids.length < 2 || a?.kind === 'holeCallout') continue;
    const issue: AnnotationIssue = { kind: 'placedTwice', placementIds: [...ids].sort() };
    out.push({
      key: `annotation:${annotationId}:placedTwice`,
      severity: 'warning',
      subject: { kind: 'annotation', annotationId },
      message: issueMessage(issue, annotationName(a)),
      issue,
    });
  }

  return out.sort(
    (x, y) =>
      ORDER[x.severity] - ORDER[y.severity] ||
      (sheetIndex.get(x.sheetId ?? '') ?? -1) - (sheetIndex.get(y.sheetId ?? '') ?? -1) ||
      (x.zone ?? '').localeCompare(y.zone ?? '') ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
}

/** Case-insensitive search over messages, zones and ids (the panel's filter). */
export function searchAttention(
  entries: readonly AttentionEntry[],
  query: string,
): AttentionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) =>
    [e.message, e.zone ?? '', e.key, e.cause?.featureId ?? ''].some((s) =>
      s.toLowerCase().includes(q),
    ),
  );
}
