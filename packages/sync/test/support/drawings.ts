// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M4 fixtures for the drawing merge tests: the Bracket with part annotations and one drawing
 * (two sheets, a front base view with a projected top view and a section, placements of every
 * annotation, a centre mark, a hole table, a sheet note and a markup). Edits go through the
 * document commands (`apply`), as the store would make them.
 */

import type {
  Annotation,
  AnnotationPlacement,
  Command,
  Drawing,
  DrawingStyle,
  DrawingView,
  Markup,
  WrenDoc,
} from '@wren-cad/contracts';
import { registerDrawingSupport } from '@wren-cad/document/drawing';
import { apply, baseDoc, EXTRUDE, id, PART, ref, SKETCH, sk } from './fixtures';

registerDrawingSupport();

export const A_DIA = id(100);
export const A_LIN = id(101);
export const A_DATUM = id(102);
export const A_NOTE = id(103);
export const DRAWING = id(200);
export const S1 = id(210);
export const S2 = id(211);
export const S3 = id(212);
export const V_FRONT = id(220);
export const V_TOP = id(221);
export const V_SECTION = id(222);
export const P_DIA = id(230);
export const P_LIN = id(231);
export const P_DATUM = id(232);
export const MARK = id(240);
export const HOLES = id(250);
export const NOTE = id(260);
export const MARKUP = id(270);

const model = { kind: 'model' } as const;

export function annotations(): Annotation[] {
  return [
    {
      id: A_DIA,
      kind: 'diameter',
      origin: model,
      refs: [ref(`S${SKETCH}:e(${sk(10)})`, 'edge')],
      nominal: '6mm',
      tolerance: { kind: 'bilateral', upper: '0.1mm', lower: '-0.1mm' },
    },
    {
      id: A_LIN,
      kind: 'linear',
      origin: model,
      refs: [ref(`F${EXTRUDE}:start`), ref(`F${EXTRUDE}:end`)],
      direction: [0, 0, 1],
      source: { kind: 'featureField', featureId: EXTRUDE, path: '/end/depth' },
    },
    {
      id: A_DATUM,
      kind: 'datumFeature',
      origin: model,
      refs: [ref(`F${EXTRUDE}:start`)],
      label: 'A',
    },
    {
      id: A_NOTE,
      kind: 'note',
      origin: model,
      refs: [ref(`F${EXTRUDE}:end`)],
      text: 'BREAK SHARP EDGES',
    },
  ];
}

export const style = (): DrawingStyle => ({
  lineGroup: 'iso-0.35',
  text: { dimension: 3.5, note: 3.5, viewLabel: 5, title: 7 },
  font: 'osifont',
  dimension: {
    extensionGap: 1,
    extensionOvershoot: 1.5,
    arrow: { kind: 'filledClosed', length: 3, angle: 15 },
    firstLane: 10,
    laneSpacing: 7,
    textOrientation: 'aligned',
    textPosition: 'above',
  },
  numbers: {
    decimal: '.',
    lengthPrecision: 2,
    anglePrecision: 1,
    trailingZeros: 'strip',
    angleFormat: 'decimal',
  },
  hatch: { pattern: 'iso-general', angle: 45, spacing: 3 },
  view: {
    lines: 'visible',
    tangentEdges: 'thin',
    centerMarks: true,
    centerLines: true,
    threads: true,
  },
});

export const sheet = (sid: string, name: string) => ({
  id: sid,
  name,
  format: { size: 'A3' as const, orientation: 'landscape' as const },
  scale: '1/2',
});

export function drawing(): Drawing {
  return {
    id: DRAWING,
    name: 'Bracket drawing',
    subject: { kind: 'part', partId: PART },
    standard: { family: 'iso', gps: 'ISO 1101:2017', surfaceFinish: 'ISO 21920-1:2021' },
    projection: 'first',
    units: 'mm',
    style: style(),
    template: { id: 'iso-5457', version: 1 },
    sheets: [sheet(S1, 'Sheet 1'), sheet(S2, 'Sheet 2')],
    views: [
      {
        id: V_FRONT,
        sheetId: S1,
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        layout: { kind: 'free', position: [120, 150] },
      },
      {
        id: V_TOP,
        sheetId: S1,
        kind: 'projected',
        parentId: V_FRONT,
        from: 'top',
        layout: { kind: 'aligned', distance: 70 },
      },
      {
        id: V_SECTION,
        sheetId: S2,
        kind: 'section',
        parentId: V_FRONT,
        letter: 'A',
        cut: [
          { kind: 'free', at: [-30, 0] },
          { kind: 'free', at: [30, 0] },
        ],
        look: 'left',
        layout: { kind: 'free', position: [200, 150] },
      },
    ],
    placements: [
      {
        id: P_DIA,
        viewId: V_FRONT,
        annotationId: A_DIA,
        layout: { kind: 'radial', angle: 45, distance: 6 },
      },
      {
        id: P_LIN,
        viewId: V_FRONT,
        annotationId: A_LIN,
        layout: { kind: 'lane', side: 'bottom', lane: 0 },
      },
      {
        id: P_DATUM,
        viewId: V_TOP,
        annotationId: A_DATUM,
        layout: { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [8, 8] },
      },
    ],
    centerMarks: [
      {
        id: MARK,
        viewId: V_FRONT,
        kind: 'centerMark',
        refs: [ref(`S${SKETCH}:e(${sk(10)})`, 'edge')],
      },
    ],
    tables: [
      {
        id: HOLES,
        sheetId: S1,
        kind: 'holeTable',
        position: [10, 280],
        anchor: 'topLeft',
        viewId: V_FRONT,
        origin: { kind: 'free', at: [0, 0] },
        holes: 'all',
      },
    ],
    notes: [{ id: NOTE, sheetId: S1, position: [15, 40], text: 'ALL DIMENSIONS IN MM' }],
    markup: [markup(MARKUP, 'Ana')],
  };
}

export function markup(mid: string, author: string, text?: string): Markup {
  return {
    id: mid,
    sheetId: S1,
    versionId: 'v1',
    author,
    at: '2026-01-02T03:04:05.000Z',
    strokes: [
      {
        points: [
          [1, 1],
          [5, 5],
        ],
        width: 0.5,
      },
    ],
    ...(text === undefined ? {} : { text }),
  };
}

/** The Bracket document with annotations and a drawing. */
export function drawingDoc(): WrenDoc {
  const doc = baseDoc();
  const part = doc.parts.find((p) => p.id === PART);
  if (part) part.annotations = annotations();
  doc.drawings = [drawing()];
  return doc;
}

export const run = (doc: WrenDoc, ...cmds: Command[]): WrenDoc => apply(doc, ...cmds);

export const drawingOf = (doc: WrenDoc, did = DRAWING): Drawing =>
  doc.drawings.find((d) => d.id === did) as Drawing;

export const viewOf = (doc: WrenDoc, vid: string): DrawingView =>
  drawingOf(doc).views.find((v) => v.id === vid) as DrawingView;

export const placementOf = (doc: WrenDoc, pid: string): AnnotationPlacement | undefined =>
  drawingOf(doc).placements.find((p) => p.id === pid);

export const annotationOf = (doc: WrenDoc, aid: string): Annotation | undefined =>
  doc.parts.find((p) => p.id === PART)?.annotations?.find((a) => a.id === aid);

/** `updateView` with a change to one view. */
export function editView(doc: WrenDoc, vid: string, change: Partial<DrawingView>): WrenDoc {
  const view = { ...viewOf(doc, vid), ...change } as DrawingView;
  return run(doc, { kind: 'updateView', drawingId: DRAWING, view });
}

/** `updateAnnotation` with a change to one annotation. */
export function editAnnotation(
  doc: WrenDoc,
  aid: string,
  change: Record<string, unknown>,
): WrenDoc {
  const annotation = { ...annotationOf(doc, aid), ...change } as Annotation;
  return run(doc, { kind: 'updateAnnotation', partId: PART, annotationId: aid, annotation });
}

/** `updatePlacements` with a change to one placement. */
export function editPlacement(
  doc: WrenDoc,
  pid: string,
  change: Partial<AnnotationPlacement>,
): WrenDoc {
  const p = { ...placementOf(doc, pid), ...change } as AnnotationPlacement;
  return run(doc, { kind: 'updatePlacements', drawingId: DRAWING, placements: [p] });
}

/** Places an annotation in a view (`placeAnnotations`). */
export function place(
  doc: WrenDoc,
  pid: string,
  viewId: string,
  annotationId: string,
  annotation?: Annotation,
): WrenDoc {
  const placement: AnnotationPlacement = {
    id: pid,
    viewId,
    annotationId,
    layout: { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [5, 5] },
  };
  return run(doc, {
    kind: 'placeAnnotations',
    drawingId: DRAWING,
    items: [annotation ? { placement, annotation } : { placement }],
    // A second placement of an annotation in another view is allowed by hand.
    allowDuplicate: true,
  });
}
