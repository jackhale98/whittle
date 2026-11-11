// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Human labels for annotations and drawing content (M4, ADR-090), so the compare panel and the
 * merge report read "Dimension Ø6", "Datum A", "View Front", "Section A–A", "Sheet 2", "Dimension
 * Ø6 in View Front" rather than ids.
 *
 * A dimension shows its value when the document knows it without the kernel: the nominal, or the
 * source (the sketch dimension's or the feature field's expression). Lengths in the document's
 * unit are shown bare (`Ø6`, as on the drawing); other units keep theirs. A measured-only
 * dimension is "Diameter dimension". Projected views are named by the standard view they show
 * when the frame maths says it is exactly one ("View Top"); otherwise "Projected view (top of View
 * Front)".
 */

import type {
  Annotation,
  AnnotationPlacement,
  CenterMark,
  DiffSubject,
  Drawing,
  DrawingTable,
  DrawingView,
  Markup,
  Part,
  Sheet,
  SheetNote,
  WrenDoc,
} from '@wren-cad/contracts';
import { namedViewOf, resolveViewFrame } from '@wren-cad/document/drawing';
import { simpleNumber, type Units } from './format';
import { atPointer, isObj } from './tree';

const cap = (s: string): string => (s === '' ? s : s[0]?.toUpperCase() + s.slice(1));
const words = (camel: string): string => camel.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** At most `max` characters of `text` on one line, with an ellipsis when cut. */
export function snippet(text: string, max = 24): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A value as the drawing shows it: `6` for `6mm` in a millimetre document, `30°`, `0.25 in` in a
 * millimetre document, an expression as typed (shortened).
 */
export function valueText(expr: unknown, units: Units | undefined, angle: boolean): string | null {
  if (typeof expr === 'number') return String(Math.round(expr * 1e6) / 1e6);
  if (typeof expr !== 'string' || expr.trim() === '') return null;
  const m = simpleNumber(expr);
  if (!m) return snippet(expr, 20);
  const unit = m.unit?.toLowerCase();
  if (angle) {
    if (unit === undefined || unit === 'deg' || unit === '°') {
      return (units?.angle ?? 'deg') === 'deg' || unit !== undefined ? `${m.n}°` : `${m.n} rad`;
    }
    return `${m.n} ${unit}`;
  }
  if (unit === undefined || unit === (units?.length ?? 'mm')) return m.n;
  return `${m.n} ${unit === '"' ? 'in' : unit}`;
}

/** The value a dimension shows when the document alone knows it (nominal, else its source). */
function knownValue(a: Annotation, part: Part | undefined): unknown {
  const x = a as unknown as Record<string, unknown>;
  if (x.nominal !== undefined) return x.nominal;
  const source = x.source;
  if (!isObj(source) || part === undefined) return undefined;
  const f = part.features.find((y) => y.id === source.featureId);
  if (!f) return undefined;
  if (source.kind === 'sketchDimension' && f.type === 'sketch') {
    const c = f.constraints.find((y) => y.id === source.constraintId);
    return c && 'value' in c ? (c as { value: unknown }).value : undefined;
  }
  if (source.kind === 'featureField' && typeof source.path === 'string') {
    return atPointer(f, source.path);
  }
  return undefined;
}

function featureName(part: Part | undefined, featureId: unknown): string | undefined {
  return part?.features.find((f) => f.id === featureId)?.name;
}

/** "Dimension Ø6", "Datum A", "Position Ø0.1", "Note “BREAK SHARP EDGES”", "Hole callout Hole 2". */
export function annotationLabel(a: Annotation, part?: Part, doc?: WrenDoc): string {
  const units = doc?.units;
  switch (a.kind) {
    case 'linear':
    case 'aligned':
    case 'ordinate':
    case 'radius':
    case 'diameter':
    case 'angle': {
      const v = valueText(knownValue(a, part), units, a.kind === 'angle');
      if (v === null) return `${cap(a.kind)} dimension`;
      const prefix = a.kind === 'radius' ? 'R' : a.kind === 'diameter' ? 'Ø' : '';
      return `Dimension ${prefix}${v}`;
    }
    case 'chamfer': {
      const v = valueText(knownValue(a, part), units, false);
      if (v !== null) return `Chamfer ${v}`;
      const f = featureName(part, a.source?.kind === 'feature' ? a.source.featureId : undefined);
      return f ? `Chamfer dimension (${f})` : 'Chamfer dimension';
    }
    case 'datumFeature':
      return a.label ? `Datum ${a.label}` : 'Datum';
    case 'geometricTolerance': {
      const shape =
        a.zone?.shape === 'diameter' ? 'Ø' : a.zone?.shape === 'sphericalDiameter' ? 'SØ' : '';
      const v = valueText(a.zone?.value, units, false);
      const name = cap(words(String(a.characteristic)));
      return v === null ? `${name} tolerance` : `${name} ${shape}${v}`;
    }
    case 'note':
      return typeof a.text === 'string' && a.text.trim() !== ''
        ? `Note “${snippet(a.text)}”`
        : 'Note';
    case 'surfaceFinish': {
      const r = Array.isArray(a.requirements) ? a.requirements[0] : undefined;
      const v = r ? valueText(r.value, units, false) : null;
      return r && v !== null ? `Surface finish ${r.parameter} ${v}` : 'Surface finish';
    }
    case 'holeCallout': {
      const f = featureName(part, a.source?.featureId);
      return f ? `Hole callout ${f}` : 'Hole callout';
    }
    default:
      return 'Annotation';
  }
}

/** The number of a degree or radian expression, for a base view's rotation. */
function angleOf(expr: string): number | undefined {
  const m = simpleNumber(expr);
  if (!m) return undefined;
  const n = Number(m.n);
  const unit = m.unit?.toLowerCase();
  if (unit === 'rad') return n;
  if (unit === undefined || unit === 'deg' || unit === '°') return (n * Math.PI) / 180;
  return undefined;
}

/** "View Front", "View Top", "Section A–A", "Detail B", "Isometric view". */
export function viewLabel(v: DrawingView, drawing?: Drawing, depth = 0): string {
  if (typeof v.label === 'string' && v.label.trim() !== '') return `View ${snippet(v.label)}`;
  switch (v.kind) {
    case 'base': {
      const o = v.orientation;
      if (o?.kind === 'named' && v.rotation === undefined) return `View ${cap(o.name)}`;
      if (o?.kind === 'named') return `View ${cap(o.name)} (rotated)`;
      if (o?.kind === 'isometric') return 'View Isometric';
      return 'View (custom orientation)';
    }
    case 'projected': {
      if (drawing) {
        const f = resolveViewFrame(drawing.views, v.id, angleOf);
        const name = f.ok ? namedViewOf(f.value) : undefined;
        if (name) return `View ${cap(name)}`;
        const parent = drawing.views.find((x) => x.id === v.parentId);
        if (parent && depth < 8) {
          return `Projected view (${v.from} of ${viewLabel(parent, drawing, depth + 1)})`;
        }
      }
      return `Projected view (${v.from})`;
    }
    case 'iso':
      return 'Isometric view';
    case 'section':
      return `Section ${v.letter}–${v.letter}`;
    case 'detail':
      return `Detail ${v.letter}`;
    default:
      return 'View';
  }
}

/** "Sheet 2" (a sheet's own name when it says "Sheet …"), "Sheet Details", or its number. */
export function sheetLabel(s: Sheet, drawing?: Drawing): string {
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  if (name === '') {
    const i = drawing?.sheets.findIndex((x) => x.id === s.id) ?? -1;
    return i >= 0 ? `Sheet ${i + 1}` : 'Sheet';
  }
  return /^sheet\b/i.test(name) ? name : `Sheet ${name}`;
}

const MARK_NAMES: Record<CenterMark['kind'], string> = {
  centerMark: 'Centre mark',
  centerLine: 'Centre line',
  boltCircle: 'Bolt circle',
};

/** The label of a view of `drawing` by id (`View …`), or a placeholder when it is gone. */
export function viewIdLabel(drawing: Drawing | undefined, viewId: string): string {
  const v = drawing?.views.find((x) => x.id === viewId);
  return v ? viewLabel(v, drawing) : 'a removed view';
}

export function centerMarkLabel(m: CenterMark, drawing?: Drawing): string {
  return `${MARK_NAMES[m.kind] ?? 'Centre mark'} in ${viewIdLabel(drawing, m.viewId)}`;
}

export function tableLabel(t: DrawingTable, drawing?: Drawing): string {
  if (t.kind === 'holeTable') return `Hole table of ${viewIdLabel(drawing, t.viewId)}`;
  if (t.kind === 'partProperties') return 'Part properties table';
  return 'Table';
}

export function noteLabel(n: SheetNote): string {
  return typeof n.text === 'string' && n.text.trim() !== '' ? `Note “${snippet(n.text)}”` : 'Note';
}

export function markupLabel(m: Markup): string {
  const by = typeof m.author === 'string' && m.author !== '' ? `Markup by ${m.author}` : 'Markup';
  return typeof m.text === 'string' && m.text.trim() !== '' ? `${by}: “${snippet(m.text)}”` : by;
}

// ---------------------------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------------------------

type Docs = readonly (WrenDoc | undefined)[];

const drawingIn = (d: WrenDoc | undefined, did: string): Drawing | undefined =>
  d?.drawings.find((x) => x.id === did);
const partIn = (d: WrenDoc | undefined, pid: string | undefined): Part | undefined =>
  pid === undefined ? undefined : d?.parts.find((x) => x.id === pid);

/** An annotation's label read in the first version that has it, or `fallback`. */
export function annotationLabelIn(
  docs: Docs,
  pid: string | undefined,
  aid: string,
  fallback = 'a removed annotation',
): string {
  for (const d of docs) {
    const part = partIn(d, pid);
    const a = part?.annotations?.find((x) => x.id === aid);
    if (a) return annotationLabel(a, part, d);
  }
  return fallback;
}

/** "Dimension Ø6 in View Front", read in `doc` (names that are gone there come from `docs`). */
export function placementLabel(
  p: { annotationId: string; viewId: string },
  drawing: Drawing,
  docs: Docs,
): string {
  const pid = drawing.subject?.partId;
  const annotation = annotationLabelIn(docs, pid, p.annotationId);
  let view: string | undefined;
  for (const d of docs) {
    const dr = drawingIn(d, drawing.id);
    const v = dr?.views.find((x) => x.id === p.viewId);
    if (v) {
      view = viewLabel(v, dr);
      break;
    }
  }
  return `${annotation} in ${view ?? viewIdLabel(drawing, p.viewId)}`;
}

/** Whether any of `docs` has more than one drawing (labels then name the drawing too). */
const manyDrawings = (docs: Docs): boolean => docs.some((d) => (d?.drawings.length ?? 0) > 1);

/** `['parts', pid, 'annotations', aid, …]`: the annotation's subject. */
export function annotationSubject(docs: Docs, pid: string, aid: string | undefined): DiffSubject {
  if (aid === undefined) {
    const part = docs.map((d) => partIn(d, pid)).find((p) => p !== undefined);
    return { kind: 'part', id: pid, label: `Annotations in ${part?.name ?? pid}` };
  }
  return {
    kind: 'annotation',
    id: aid,
    partId: pid,
    label: annotationLabelIn(docs, pid, aid, `Annotation ${aid}`),
  };
}

const COLLECTION_KIND = {
  sheets: 'sheet',
  views: 'view',
  placements: 'placement',
  centerMarks: 'view',
  tables: 'drawingTable',
  notes: 'sheetNote',
  markup: 'markup',
} as const;

const ORDER_LABEL: Record<keyof typeof COLLECTION_KIND, string> = {
  sheets: 'Sheet order',
  views: 'Views',
  placements: 'Placements',
  centerMarks: 'Centre marks',
  tables: 'Tables',
  notes: 'Sheet notes',
  markup: 'Markup',
};

/**
 * `['drawings', did, <collection>, id, …]`: the subject of an item of a drawing, labelled in the
 * first version that has it. A centre mark has no subject kind of its own: it is shown as part of
 * its view (`kind: 'view'`, the view's id). `undefined` for any other path.
 */
export function drawingItemSubject(
  docs: Docs,
  did: string,
  coll: string,
  itemId: string | undefined,
): DiffSubject | undefined {
  if (!(coll in COLLECTION_KIND)) return undefined;
  const key = coll as keyof typeof COLLECTION_KIND;
  const name = docs.map((d) => drawingIn(d, did)).find((x) => x !== undefined)?.name ?? did;
  if (itemId === undefined) {
    return { kind: 'drawing', id: did, label: `${ORDER_LABEL[key]} in ${name}` };
  }
  const where = manyDrawings(docs) ? ` in ${name}` : '';
  for (const d of docs) {
    const drawing = drawingIn(d, did);
    const list = drawing?.[key] as { id: string }[] | undefined;
    const item = list?.find((x) => x.id === itemId);
    if (!drawing || !item) continue;
    let label: string;
    let id = itemId;
    switch (key) {
      case 'sheets':
        label = sheetLabel(item as Sheet, drawing);
        break;
      case 'views':
        label = viewLabel(item as DrawingView, drawing);
        break;
      case 'placements':
        label = placementLabel(item as unknown as AnnotationPlacement, drawing, docs);
        break;
      case 'centerMarks':
        label = centerMarkLabel(item as CenterMark, drawing);
        id = (item as CenterMark).viewId;
        break;
      case 'tables':
        label = tableLabel(item as DrawingTable, drawing);
        break;
      case 'notes':
        label = noteLabel(item as SheetNote);
        break;
      case 'markup':
        label = markupLabel(item as Markup);
        break;
    }
    return { kind: COLLECTION_KIND[key], id, drawingId: did, label: `${label}${where}` };
  }
  return {
    kind: COLLECTION_KIND[key],
    id: itemId,
    drawingId: did,
    label: `${cap(words(key))} ${itemId}`,
  };
}
