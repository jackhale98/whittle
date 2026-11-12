/**
 * One call from data to sheets: solve views, lay out every placement in its view's
 * configuration, compose each sheet and aggregate needs attention. Everything model-side is
 * injected (expression evaluation, resolutions, projections, issues, title block data), so this
 * runs in any worker or in tests against mocks.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationIssue,
  AnnotationPlacement,
  AnnotationResolution,
  Drawing,
  DrawingTable,
  Expr,
  GpsStandard,
  Id,
  Sheet,
  TitleBlockFields,
  Vec3,
  ViewProjection,
} from '@wren-cad/contracts';
import type { FitDeviationLookup } from '../annotation/tolerance';
import { type AttentionEntry, aggregateAttention, viewConfiguration } from '../attention/aggregate';
import {
  type FeatureCalloutData,
  layoutPlacement,
  layoutView,
  type PlacedAnnotation,
  type PlacementContext,
} from '../placement/layout';
import type { TitleBlockData } from '../template/title-block';
import type { TemplateLayout } from '../template/types';
import { type ExprEvaluator, type RefResolver, solveViews, type ViewSolution } from '../view/solve';
import { type ComposedSheet, composeSheet, type SheetInput, type TableData } from './compose';

export interface DrawingBuildInput {
  drawing: Drawing;
  /** Subject part's annotations; undefined = the part is missing. */
  annotations: readonly Annotation[] | undefined;
  configurationIds: ReadonlySet<Id>;
  /** Part bounds (`ShapeForDrawing.bounds`). */
  bounds: { min: Vec3; max: Vec3 };
  /** Drawing expressions: scales (`ratio`) and rotations (`angle`). */
  evaluate: ExprEvaluator;
  /** Annotation expressions: lengths in mm, angles in rad. */
  evaluateAnnotation: (expr: Expr, kind: 'length' | 'angle') => number | undefined;
  resolveRef?: RefResolver;
  projections: ReadonlyMap<Id, ViewProjection>;
  resolutions: (configurationId: Id | null) => ReadonlyMap<Id, AnnotationResolution> | undefined;
  annotationIssues: (annotation: Annotation, standard: GpsStandard) => AnnotationIssue[];
  /** Title block data for a sheet (1-based index and count included). */
  titleBlock: (sheet: Sheet, index: number, count: number) => TitleBlockData;
  projectFields?: TitleBlockFields;
  fitDeviations?: FitDeviationLookup;
  features?: FeatureCalloutData;
  tables?: (table: DrawingTable) => TableData | undefined;
  centerMarkAnchors?: SheetInput['centerMarkAnchors'];
}

export interface DrawingBuild {
  views: Map<Id, ViewSolution>;
  placed: PlacedAnnotation[];
  sheets: ComposedSheet[];
  attention: AttentionEntry[];
  /**
   * Lays out one placement as the build did, with `placement` in place of its stored one (a drag's
   * preview: ADR-094). Cheap (one placement); touches nothing in the build. `undefined` when the
   * placement's view or annotation is not in it.
   */
  relayout(placement: AnnotationPlacement): PlacedAnnotation | undefined;
}

export function buildDrawing(input: DrawingBuildInput): DrawingBuild {
  const { drawing } = input;
  const views = solveViews({
    drawing,
    bounds: input.bounds,
    evaluate: input.evaluate,
    ...(input.resolveRef ? { resolveRef: input.resolveRef } : {}),
  });
  const annotations = new Map((input.annotations ?? []).map((a) => [a.id, a]));
  const placed: PlacedAnnotation[] = [];
  const contexts = new Map<Id, Omit<PlacementContext, 'placed'>>();
  for (const v of drawing.views) {
    const sol = views.get(v.id);
    if (!sol?.ok || !input.annotations) continue;
    const res = input.resolutions(viewConfiguration(drawing, v)) ?? new Map();
    const ctx: Omit<PlacementContext, 'placed'> = {
      view: sol,
      style: drawing.style,
      standard: drawing.standard.gps,
      evaluate: input.evaluateAnnotation,
      annotations,
      resolutions: res,
      ...(input.fitDeviations ? { fitDeviations: input.fitDeviations } : {}),
      ...(input.features ? { features: input.features } : {}),
    };
    contexts.set(v.id, ctx);
    placed.push(
      ...layoutView(
        drawing.placements.filter((p) => p.viewId === v.id),
        ctx,
      ),
    );
  }
  const count = drawing.sheets.length;
  const sheets = drawing.sheets.map((s, i) =>
    composeSheet({
      drawing,
      sheetId: s.id,
      views,
      projections: input.projections,
      placed,
      titleBlock: input.titleBlock(s, i + 1, count),
      ...(input.projectFields ? { projectFields: input.projectFields } : {}),
      ...(input.tables ? { tables: input.tables } : {}),
      ...(input.centerMarkAnchors ? { centerMarkAnchors: input.centerMarkAnchors } : {}),
    }),
  );
  const templates = new Map<Id, TemplateLayout>(sheets.map((s) => [s.sheetId, s.template]));
  const attention = aggregateAttention({
    drawing,
    annotations: input.annotations,
    configurationIds: input.configurationIds,
    views,
    resolutions: input.resolutions,
    annotationIssues: input.annotationIssues,
    placed,
    templates,
  });
  let placedById: Map<Id, PlacedAnnotation> | undefined;
  const placedMap = () => {
    if (!placedById) placedById = new Map(placed.map((x) => [x.placementId, x]));
    return placedById;
  };
  const relayout = (placement: AnnotationPlacement): PlacedAnnotation | undefined => {
    const ctx = contexts.get(placement.viewId);
    const a = annotations.get(placement.annotationId);
    if (!ctx || !a) return undefined;
    return layoutPlacement(placement, a, {
      ...ctx,
      placed: placedMap(),
    });
  };
  return { views, placed, sheets, attention, relayout };
}
