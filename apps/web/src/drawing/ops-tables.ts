/**
 * Sheet tables of the drawing route: the part properties table (PLAN §2.4 P1). One per sheet,
 * added from the toolbar as a single undo step, edited in the inspector, moved by dragging or by
 * typed coordinates. Its values come from the drawing's configuration and are never stored.
 */

import type { DrawingTable, Id, PartPropertiesTable, Vec2 } from '@wren-cad/contracts';
import type { DrawingController } from './controller';
import { host } from './host';

export const DEFAULT_PROPERTY_COLUMNS: PartPropertiesTable['columns'] = [
  'partNumber',
  'description',
  'material',
  'mass',
];

/** The part properties table of the current sheet, if it has one. */
export function sheetPropertiesTable(c: DrawingController): PartPropertiesTable | undefined {
  const b = c.built();
  const sheetId = c.sheet()?.id;
  return b?.drawing.tables.find(
    (t): t is PartPropertiesTable => t.kind === 'partProperties' && t.sheetId === sheetId,
  );
}

/**
 * Adds the part properties table at the top right corner inside the sheet's frame, or selects the
 * one the sheet already has (a second one would only repeat it).
 */
export function addPartPropertiesTable(c: DrawingController): boolean {
  const b = c.built();
  const sheet = c.sheet();
  if (!b || !sheet) return false;
  const existing = sheetPropertiesTable(c);
  if (existing) {
    c.select({ kind: 'table', id: existing.id });
    c.patch({ panel: 'inspector' });
    c.toast('This sheet already has a part properties table.');
    return true;
  }
  const composed = b.build.sheets.find((x) => x.sheetId === sheet.id);
  const frame = composed?.template.frame;
  const position: Vec2 = frame
    ? [frame.max[0], frame.max[1]]
    : [(composed?.list.width ?? 297) - 10, (composed?.list.height ?? 210) - 10];
  const table: PartPropertiesTable = {
    id: host.ulid(),
    sheetId: sheet.id,
    kind: 'partProperties',
    position,
    anchor: 'topRight',
    columns: [...DEFAULT_PROPERTY_COLUMNS],
    rows: { kind: 'drawing' },
  };
  const ok = c.apply(
    { kind: 'addTable', drawingId: b.drawing.id, table },
    'Add part properties table',
  );
  if (ok) {
    c.select({ kind: 'table', id: table.id });
    c.patch({ panel: 'inspector' });
  }
  return ok;
}

export function updateTable(
  c: DrawingController,
  table: DrawingTable,
  label: string,
  key?: string,
): boolean {
  const b = c.built();
  if (!b) return false;
  return c.apply({ kind: 'updateTable', drawingId: b.drawing.id, table }, label, key);
}

export function removeTable(c: DrawingController, tableId: Id): boolean {
  const b = c.built();
  if (!b) return false;
  const ok = c.apply({ kind: 'removeTable', drawingId: b.drawing.id, tableId }, 'Delete table');
  if (ok) c.select(null);
  return ok;
}
