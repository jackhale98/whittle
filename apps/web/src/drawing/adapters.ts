/**
 * From the build to what the panels show: rows, texts and inspector inputs. Pure functions over
 * `Built`, so the wording is tested without a browser.
 */

import type {
  Annotation,
  AnnotationResolution,
  DrawingView,
  GeometricCharacteristic,
  Id,
  Part,
} from '@wren-cad/contracts';
import type { AttentionEntry, ImportPlan, TitleBlockCell } from '@wren-cad/drawing';
import type {
  AttentionRow,
  CharacteristicChoice,
  ImportRow,
  TitleBlockRow,
  ViewRow,
} from '@wren-cad/ui/drawing';
import { drawingDocument } from '../doc/drawing-support';
import { host } from './host';
import { scaleLabel, viewName } from './model';
import type { Built } from './pipeline';

const nameOfConfig = (part: Part, id: Id | null): string =>
  id === null
    ? 'Default'
    : (part.configurations?.find((c) => c.id === id)?.name ?? 'Missing configuration');

const configMissing = (part: Part, id: Id | null): boolean =>
  id !== null && !(part.configurations ?? []).some((c) => c.id === id);

/** The sheet's views, parents first, each followed by the views derived from it. */
export function viewRows(b: Built, sheetId: Id): ViewRow[] {
  const views = b.drawing.views.filter((v) => v.sheetId === sheetId);
  const byParent = new Map<Id | null, DrawingView[]>();
  for (const v of views) {
    const k = 'parentId' in v && views.some((x) => x.id === v.parentId) ? v.parentId : null;
    byParent.set(k, [...(byParent.get(k) ?? []), v]);
  }
  const out: ViewRow[] = [];
  const walk = (parent: Id | null, depth: number) => {
    for (const v of byParent.get(parent) ?? []) {
      const s = b.build.views.get(v.id);
      const problem =
        s && !s.ok
          ? (b.build.attention.find((e) => e.subject.kind === 'view' && e.subject.viewId === v.id)
              ?.message ?? 'This view cannot be drawn')
          : undefined;
      out.push({
        id: v.id,
        name: viewName(v),
        depth,
        kind: v.kind,
        scale: s?.ok ? scaleLabel(s.scale) : '',
        ...(v.configurationId !== undefined
          ? {
              configuration: {
                name: nameOfConfig(b.part, v.configurationId),
                ...(configMissing(b.part, v.configurationId) ? { missing: true } : {}),
              },
            }
          : {}),
        ...(problem ? { problem } : {}),
      });
      walk(v.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function annotationTitle(a: Annotation | undefined): string {
  return a ? host.describeAnnotation(a) : 'annotation';
}

export function attentionRows(b: Built): AttentionRow[] {
  const annotations = new Map((b.part.annotations ?? []).map((a) => [a.id, a]));
  const sheets = new Map(b.drawing.sheets.map((s) => [s.id, s.name]));
  return b.build.attention.map((e: AttentionEntry) => {
    const a = e.subject.kind === 'annotation' ? annotations.get(e.subject.annotationId) : undefined;
    const v =
      e.subject.kind === 'view'
        ? b.drawing.views.find((x) => x.id === (e.subject as { viewId: Id }).viewId)
        : undefined;
    return {
      key: e.key,
      severity: e.severity,
      message: e.message,
      ...(e.zone ? { zone: e.zone } : {}),
      ...(e.sheetId && b.drawing.sheets.length > 1 ? { sheet: sheets.get(e.sheetId) ?? '' } : {}),
      title: a ? host.describeAnnotation(a) : v ? viewName(v) : 'drawing',
      ...(e.subject.kind === 'annotation' && (e.unresolved?.length ?? 0) > 0
        ? { reattachable: true }
        : {}),
    };
  });
}

const REASON: Record<string, string> = {
  needsAttention: 'Needs attention in the model first',
  suppressed: 'Not in this configuration',
  noSuitableView: 'No view shows it true-length',
  noGeometry: 'No geometry to place it on',
};

function sourceName(part: Part, a: Annotation): string {
  const s = 'source' in a ? a.source : undefined;
  if (!s) return 'Annotation of the part';
  const f = part.features.find((x) => x.id === s.featureId);
  if (s.kind === 'sketchDimension' && f?.type === 'sketch') {
    const c = f.constraints.find((k) => k.id === s.constraintId);
    return `${f.name}: ${c && 'name' in c && c.name ? c.name : (c?.kind ?? 'dimension')}`;
  }
  return f
    ? `${f.name}${s.kind === 'featureField' ? `: ${s.path.split('/').filter(Boolean).join(' ')}` : ''}`
    : 'The model';
}

export function importRows(plan: ImportPlan, b: Built): ImportRow[] {
  return plan.candidates.map((c) => {
    const view = c.viewId ? b.drawing.views.find((v) => v.id === c.viewId) : undefined;
    return {
      key: c.key,
      title: annotationTitle(c.annotation),
      detail: c.kind === 'promote' ? sourceName(b.part, c.annotation) : 'Annotation of the part',
      kind: c.kind,
      ...(c.reason ? { reason: REASON[c.reason] ?? c.reason } : {}),
      ...(view ? { viewName: viewName(view) } : {}),
    };
  });
}

export function notPromotable(plan: ImportPlan): string[] {
  return plan.notPromotable.map((n) => n.message);
}

export function titleRows(
  b: Built,
  sheetId: Id,
): { rows: TitleBlockRow[]; unused: { slot: string; text: string }[] } {
  const composed = b.build.sheets.find((s) => s.sheetId === sheetId);
  if (!composed) return { rows: [], unused: [] };
  const rows: TitleBlockRow[] = [];
  for (const cell of composed.template.titleBlock.cells as TitleBlockCell[]) {
    const r = composed.titleBlock.slots.get(cell.slot);
    if (!r) continue;
    rows.push({
      slot: cell.slot,
      caption: cell.caption,
      text: r.text,
      source: r.source,
      ...(r.bound !== undefined ? { bound: r.bound } : {}),
      ...(r.warnings ? { warnings: r.warnings } : {}),
    });
  }
  return { rows, unused: composed.titleBlock.unused };
}

/** The value a resolution carries, as text. Absent when it needs attention: nothing stale is shown. */
export function valueText(
  a: Annotation,
  res: AnnotationResolution | undefined,
): string | undefined {
  if (res?.state !== 'ok' || res.value === undefined) return undefined;
  const v = res.value;
  const n = (x: number, d = 3) => String(Number(x.toFixed(d)));
  switch (a.kind) {
    case 'angle':
      return `${n((v * 180) / Math.PI, 2)}°`;
    case 'diameter':
      return `Ø${n(v)} mm`;
    case 'radius':
      return `R${n(v)} mm`;
    case 'datumFeature':
    case 'geometricTolerance':
    case 'note':
    case 'surfaceFinish':
      return undefined;
    default:
      return `${n(v)} mm`;
  }
}

export function sourceText(part: Part, a: Annotation): string | undefined {
  const s = 'source' in a ? a.source : undefined;
  if (!s) return undefined;
  return `Driven by ${sourceName(part, a)}. Change it there: a dimension on a drawing never drives the model.`;
}

export const CHARACTERISTICS: readonly GeometricCharacteristic[] = [
  'straightness',
  'flatness',
  'circularity',
  'cylindricity',
  'lineProfile',
  'surfaceProfile',
  'parallelism',
  'perpendicularity',
  'angularity',
  'position',
  'concentricity',
  'coaxiality',
  'symmetry',
  'circularRunout',
  'totalRunout',
];

export function characteristicChoices(b: Built): CharacteristicChoice[] {
  return CHARACTERISTICS.map((value) => {
    const refusal = drawingDocument().characteristicRefusal(b.drawing.standard.gps, value);
    return { value, ...(refusal ? { refusal } : {}) };
  });
}

export function datumChoices(b: Built): { id: Id; label: string }[] {
  return (b.part.annotations ?? []).flatMap((a) =>
    a.kind === 'datumFeature' ? [{ id: a.id, label: a.label }] : [],
  );
}

export function labelProblem(b: Built, label: string, own: Id): string | undefined {
  const base = drawingDocument().datumLabelProblem(label);
  if (base) return base;
  const dup = (b.part.annotations ?? []).some(
    (a) => a.kind === 'datumFeature' && a.id !== own && a.label === label,
  );
  return dup ? `Datum ${label} is already used` : undefined;
}

/** Messages of the build's needs-attention entries for one annotation. */
export function problemsOf(b: Built, annotationId: Id): string[] {
  return b.build.attention
    .filter((e) => e.subject.kind === 'annotation' && e.subject.annotationId === annotationId)
    .map((e) => e.message);
}
