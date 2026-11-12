/**
 * One build of a drawing: model data per configuration → solved views → projections → the
 * drawing package's `buildDrawing` (layout, display lists, needs attention). Async because the
 * projections come from the drawing kernel (a worker); everything else is synchronous data.
 */

import type {
  Annotation,
  Drawing,
  DrawingTable,
  EvalResult,
  Expr,
  GpsStandard,
  HoleCalloutAnnotation,
  HoleFeature,
  Id,
  Part,
  Sheet,
  ViewProjection,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  buildDrawing,
  constructionNames,
  type DrawingBuild,
  defaultIsConstruction,
  type FeatureCalloutData,
  projectionRequest,
  solveViews,
  type TableData,
  type TitleBlockData,
  viewConfiguration,
} from '@wren-cad/drawing';
import type { HoleCalloutData } from '@wren-cad/drawing/annotation';
import { drawingDocument } from '../doc/drawing-support';
import type { ConfigData, ConfigDataSource, ConfigLookup } from './config-data';
import { host } from './host';
import type { DrawingKernel } from './kernel';

const COLUMN_TITLES: Record<string, string> = {
  partNumber: 'PART NO.',
  description: 'DESCRIPTION',
  material: 'MATERIAL',
  mass: 'MASS',
  configuration: 'CONFIGURATION',
};

export interface Built {
  drawing: Drawing;
  part: Part;
  /** The drawing's own configuration. */
  main: ConfigData;
  data: ReadonlyMap<string, ConfigData>;
  build: DrawingBuild;
  projections: ReadonlyMap<Id, ViewProjection>;
  /** `draft` (PolyAlgo, shown first) or `exact` (HLRBRep_Algo: idle, and always for export). */
  quality: 'draft' | 'exact';
  /** Problems of the pipeline itself (a view's projection failed, with the kernel's message). */
  problems: { viewId: Id; message: string }[];
  /** Evaluates an expression as the drawing's configuration sees it. */
  evalLength(expr: Expr): number | undefined;
  /** Table rows as the sheet shows them (import keeps lanes clear of tables). */
  tableData(table: DrawingTable): TableData | undefined;
  /** Annotation expressions: lengths in mm, angles in rad. */
  evaluateAnnotation(expr: Expr, kind: 'length' | 'angle'): number | undefined;
}

export type PipelineResult =
  | { kind: 'ok'; built: Built }
  | { kind: 'pending' }
  | { kind: 'missing'; message: string }
  | { kind: 'error'; message: string };

const evalWith = (doc: WrenDoc) => {
  return (expr: Expr, expected: 'scalar' | 'length' | 'angle'): number | undefined => {
    const r: EvalResult = host.evaluate(expr, expected, doc);
    return r.ok && Number.isFinite(r.value) ? r.value : undefined;
  };
};

/**
 * A chamfer feature's callout numbers (mm, radians): one distance is a 45° chamfer, a distance and
 * an angle are as stated. Absent when the feature is not a chamfer or a value does not evaluate.
 */
export function chamferCalloutData(
  doc: WrenDoc,
  a: Extract<Annotation, { kind: 'chamfer' }>,
): { distance?: number; angle?: number } | undefined {
  if (a.source?.kind !== 'feature') return undefined;
  const featureId = a.source.featureId;
  const f = doc.parts[0]?.features.find((x) => x.id === featureId);
  if (f?.type !== 'chamfer') return undefined;
  const ev = evalWith(doc);
  const distance = ev(f.mode.distance, 'length');
  if (distance === undefined) return undefined;
  if (f.mode.kind === 'distance') return { distance, angle: Math.PI / 4 };
  const angle = ev(f.mode.angle, 'angle');
  return angle === undefined ? { distance } : { distance, angle };
}

/** A hole feature's callout numbers, from the table and the feature's own values. */
export function holeCalloutData(
  doc: WrenDoc,
  a: HoleCalloutAnnotation,
  count: number,
): HoleCalloutData | undefined {
  const part = doc.parts[0];
  const f = part?.features.find((x) => x.id === a.source.featureId);
  if (f?.type !== 'hole') return undefined;
  const hole = f as HoleFeature;
  const ev = evalWith(doc);
  const num = (e: Expr | undefined, k: 'length' | 'angle') =>
    e === undefined ? undefined : ev(e, k);
  const r = drawingDocument().resolveHoleSize({
    standard: hole.standard,
    kind: hole.kind,
    size: hole.size,
    fit: hole.fit,
    ...(hole.diameter !== undefined && num(hole.diameter, 'length') !== undefined
      ? { diameter: num(hole.diameter, 'length') as number }
      : {}),
  });
  if (!r.ok) return undefined;
  const depth =
    hole.end.kind === 'blind' ? (num(hole.end.depth, 'length') ?? undefined) : ('thru' as const);
  const kind = hole.kind === 'tapped' ? 'tapped' : hole.kind;
  return {
    count,
    kind,
    diameter: r.value.diameter,
    ...(depth !== undefined ? { depth } : {}),
    ...(r.value.thread
      ? { thread: { designation: hole.size, ...(depth !== undefined ? { depth } : {}) } }
      : {}),
    ...(r.value.counterbore ? { counterbore: r.value.counterbore } : {}),
    ...(r.value.countersink
      ? {
          countersink: {
            diameter: r.value.countersink.diameter,
            angle: (r.value.countersink.angle * 180) / Math.PI,
          },
        }
      : {}),
  };
}

export async function runPipeline(
  wbDoc: WrenDoc,
  drawingId: Id,
  source: ConfigDataSource,
  kernel: DrawingKernel,
  quality: 'draft' | 'exact' = 'draft',
): Promise<PipelineResult> {
  const drawing = wbDoc.drawings.find((d) => d.id === drawingId);
  if (!drawing) return { kind: 'missing', message: 'This drawing no longer exists' };
  const part = wbDoc.parts.find((p) => p.id === drawing.subject.partId);
  if (!part) return { kind: 'missing', message: 'The part this drawing shows no longer exists' };

  const mainId = drawing.configurationId ?? null;
  const wanted = new Map<string, Id | null>([[host.keyOf(mainId), mainId]]);
  for (const v of drawing.views) {
    const c = viewConfiguration(drawing, v);
    wanted.set(host.keyOf(c), c);
  }
  const lookups = new Map<string, ConfigLookup>();
  await Promise.all(
    [...wanted].map(async ([k, id]) => {
      lookups.set(k, await source.get(id));
    }),
  );
  const mainLookup = lookups.get(host.keyOf(mainId));
  if (!mainLookup?.ok) {
    if (mainLookup?.reason === 'pending') return { kind: 'pending' };
    return {
      kind: mainLookup?.reason === 'missing' ? 'missing' : 'error',
      message: mainLookup?.message ?? 'The drawing could not be built',
    };
  }
  const main = mainLookup.data;
  const data = new Map<string, ConfigData>();
  for (const [k, l] of lookups) if (l.ok) data.set(k, l.data);

  const ev = evalWith(main.doc);
  const evaluate = (expr: Expr, kind: 'ratio' | 'angle') =>
    ev(expr, kind === 'ratio' ? 'scalar' : 'angle');
  const evaluateAnnotation = (expr: Expr, kind: 'length' | 'angle') => ev(expr, kind);
  const bounds = main.shape.bounds;

  // Frames first (they decide what to project), then one projection per view.
  const solved = solveViews({ drawing, bounds, evaluate });
  const projections = new Map<Id, ViewProjection>();
  const problems: Built['problems'] = [];
  let degraded = false;
  await Promise.all(
    [...solved.values()].map(async (s) => {
      if (!s.ok) return;
      const cfg = data.get(host.keyOf(viewConfiguration(drawing, s.view))) ?? main;
      const r = await kernel.project(cfg.shape, projectionRequest(s, cfg.shape.key, quality));
      if (r.ok) {
        projections.set(s.view.id, r.value);
        return;
      }
      problems.push({ viewId: s.view.id, message: r.error.message });
      if (quality === 'exact') {
        // Show the draft rather than nothing; the build is then not exact (export refuses it).
        const d = await kernel.project(cfg.shape, projectionRequest(s, cfg.shape.key, 'draft'));
        if (d.ok) {
          projections.set(s.view.id, d.value);
          degraded = true;
        }
      }
    }),
  );

  const mainPart = main.doc.parts.find((p) => p.id === part.id);
  const annotations: Annotation[] = mainPart?.annotations ?? [];
  // Construction refs a placement uses are drawn (ADR-095): the origin, sketch origins and axes,
  // reference features and pitch circles by name, and the sketch points the views offer.
  const standalone = mainPart ? constructionNames(mainPart) : new Set<string>();
  const isConstruction = (n: string) => defaultIsConstruction(n) || standalone.has(n);
  const resolutionsFor = (c: Id | null) => data.get(host.keyOf(c))?.resolutions;
  const holeFor: FeatureCalloutData['hole'] = (a) =>
    holeCalloutData(main.doc, a, main.resolutions.get(a.id)?.instances?.length ?? 1);
  const titleBlock = (sheet: Sheet, index: number, count: number): TitleBlockData => {
    const cfgName =
      mainId === null ? undefined : part.configurations?.find((c) => c.id === mainId)?.name;
    const mass = main.mass;
    return {
      title: wbDoc.meta.name,
      partNumber: host.partNumberFor(wbDoc, part.id, mainId),
      ...(part.properties?.description ? { description: part.properties.description } : {}),
      ...(part.material?.name ? { material: part.material.name } : {}),
      ...(mass === 'building' ? { mass } : mass !== undefined ? { mass: mass * 1000 } : {}),
      massUnit: 'g',
      ...(cfgName ? { configuration: cfgName } : {}),
      ...(ev(sheet.scale, 'scalar') !== undefined
        ? { scale: ev(sheet.scale, 'scalar') as number }
        : {}),
      projection: drawing.projection,
      units: 'mm',
      standard: drawing.standard,
      sheet: { index, count },
    };
  };
  const tableData = (t: DrawingTable): TableData | undefined => {
    if (t.kind !== 'partProperties') return undefined;
    const tb = titleBlock(drawing.sheets[0] as Sheet, 1, drawing.sheets.length);
    const kg = t.massUnit === 'kg';
    const cells: Record<string, string> = {
      partNumber: tb.partNumber,
      description: tb.description ?? '',
      material: tb.material ?? '',
      mass:
        typeof tb.mass === 'number'
          ? kg
            ? `${Number((tb.mass / 1000).toPrecision(4))} kg`
            : `${Number(tb.mass.toPrecision(4))} g`
          : '',
      configuration: tb.configuration ?? 'Default',
    };
    return {
      header: t.columns.map((c) => COLUMN_TITLES[c] ?? c),
      rows: [t.columns.map((c) => cells[c] ?? '')],
    };
  };
  const build = buildDrawing({
    drawing,
    annotations,
    configurationIds: new Set((part.configurations ?? []).map((c) => c.id)),
    bounds,
    evaluate,
    evaluateAnnotation,
    projections,
    resolutions: resolutionsFor,
    annotationIssues: (a: Annotation, standard: GpsStandard) =>
      drawingDocument().annotationIssues(main.doc, part.id, a, standard),
    titleBlock,
    ...(wbDoc.drawingDefaults?.fields ? { projectFields: wbDoc.drawingDefaults.fields } : {}),
    fitDeviations: drawingDocument().fitToleranceDeviations,
    features: { hole: holeFor, chamfer: (a) => chamferCalloutData(main.doc, a) },
    tables: tableData,
    isConstruction,
  });
  return {
    kind: 'ok',
    built: {
      drawing,
      part,
      main,
      data,
      build,
      projections,
      quality: degraded ? 'draft' : quality,
      problems,
      evalLength: (e) => ev(e, 'length'),
      tableData,
      evaluateAnnotation,
    },
  };
}
