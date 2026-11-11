/**
 * A ready-made drawing for tests that start from a document with one (the phone reviews drawings
 * but never creates them): ISO A3, first angle, a front view and its top view.
 */

import type { Drawing } from '@wren-cad/contracts';
import { LATEST_TEMPLATE_VERSION, standardPreset, stylePreset } from '@wren-cad/drawing';

export const FIXTURE_DRAWING_ID = '01J0000000000000000000D001';

export function fixtureDrawing(partId: string): Drawing {
  const sheetId = '01J0000000000000000000D002';
  return {
    id: FIXTURE_DRAWING_ID,
    name: 'Bracket drawing',
    subject: { kind: 'part', partId },
    standard: standardPreset('iso'),
    projection: 'first',
    units: 'mm',
    style: stylePreset('iso'),
    template: { id: 'iso-5457', version: LATEST_TEMPLATE_VERSION['iso-5457'] },
    sheets: [
      {
        id: sheetId,
        name: 'Sheet 1',
        format: { size: 'A3', orientation: 'landscape' },
        scale: '1',
      },
    ],
    views: [
      {
        id: '01J0000000000000000000D003',
        sheetId,
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        layout: { kind: 'free', position: [90, 240] },
      },
      {
        id: '01J0000000000000000000D004',
        sheetId,
        kind: 'projected',
        parentId: '01J0000000000000000000D003',
        from: 'top',
        layout: { kind: 'aligned', distance: 80 },
      },
    ],
    placements: [],
    centerMarks: [],
    tables: [],
    notes: [],
  };
}
