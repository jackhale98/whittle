/**
 * The document's drawings (M4): a section of the part inspector (desktop, tablet) and of the
 * phone's Parts tab. Open, rename, delete and make a new one. It is its own chunk: the list is
 * only needed when the inspector shows the document, and the drawing route itself loads on open.
 */

import type { Drawing } from '@wren-cad/contracts';
import { DrawingList, type DrawingListItem } from '@wren-cad/ui/drawing';
import { useMemo, useSyncExternalStore } from 'react';
import type { Workbench } from '../app/workbench';
import { ensureDrawingSupport } from '../doc/drawing-support';

const summary = (d: Drawing): string =>
  `${d.standard.family === 'iso' ? 'ISO' : 'ASME'} · ${d.projection === 'first' ? 'first' : 'third'} angle · ${d.sheets.length} sheet${d.sheets.length === 1 ? '' : 's'}`;

export default function DrawingsSection({
  wb,
  touch,
  reviewOnly,
}: {
  wb: Workbench;
  touch: boolean;
  reviewOnly: boolean;
}) {
  const doc = useSyncExternalStore(wb.subscribeDoc, wb.getDoc);
  const items = useMemo<DrawingListItem[]>(
    () => doc.drawings.map((d) => ({ id: d.id, name: d.name, summary: summary(d) })),
    [doc.drawings],
  );
  return (
    <section
      className="border-t border-border px-4 py-3"
      aria-label="Drawings"
      data-testid="drawings-section"
    >
      <h3 className="pb-2 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
        Drawings
      </h3>
      <DrawingList
        drawings={items}
        size={touch ? 'touch' : 'md'}
        reviewOnly={reviewOnly}
        {...(doc.parts.length === 0 ? { newDisabled: 'Add a part first' } : {})}
        onOpen={(id) => wb.openDrawing(id)}
        onNew={() => wb.openDrawing(null)}
        onRename={(id, name) => {
          void ensureDrawingSupport().then(() => {
            wb.apply({ kind: 'updateDrawing', drawingId: id, changes: { name } }, 'Rename drawing');
            wb.commit();
          });
        }}
        onDelete={(id) => {
          void ensureDrawingSupport().then(() => {
            wb.apply({ kind: 'removeDrawing', drawingId: id }, 'Delete drawing');
            wb.commit();
          });
        }}
      />
    </section>
  );
}
