/**
 * The one shape every sheet drag takes (ADR-094): a preview drawn straight onto the sheet, the
 * build held, and one edit on release (one undo step). Escape or a cancel leaves nothing behind.
 * Its own module so drags outside interact.ts (leader handles) use it without an import cycle.
 */

import type { AnnotationPlacement, Id } from '@wren-cad/contracts';
import type { PlacedAnnotation } from '@wren-cad/drawing';
import type { DisplayItem } from '@wren-cad/drawing/annotation';
import type { SvgNode } from '@wren-cad/drawing/svg';
import type {
  SheetDrag,
  SheetPointer,
  SheetTransient,
  SheetTransientFrame,
  SheetTransientSpec,
} from '@wren-cad/ui/drawing';
import type { DrawingController } from './controller';
import type { Built } from './pipeline';

/** What a drag frame is: the preview to show, and the one edit to make if it is released here. */
export interface DragFrame {
  frame: SheetTransientFrame;
  /** The edit to commit on release; `null` when it would change nothing. */
  commit: (() => void) | null;
}

/**
 * A drag that stores nothing until it is released. The preview (`spec`: groups moved or hidden,
 * `frame`: translation and extra nodes) is drawn straight onto the sheet, once per animation
 * frame; the build is held; release makes the one edit, which is one undo step. Escape or a cancel
 * leaves nothing behind: the document was never touched.
 */
export function previewDrag(
  c: DrawingController,
  spec: SheetTransientSpec,
  at: (p: SheetPointer) => DragFrame | null,
): SheetDrag {
  let tr: SheetTransient | null = null;
  c.hold();
  const show = (p: SheetPointer): DragFrame | null => {
    const f = at(p);
    if (!f) return null;
    tr ??= c.transient(spec);
    tr.update(f.frame);
    return f;
  };
  return {
    move(p) {
      show(p);
    },
    up(p, moved) {
      const f = moved ? show(p) : null;
      if (f?.commit) {
        f.commit();
        c.commit();
        tr?.end('hold');
      } else tr?.end('cancel');
      c.resume();
    },
    cancel() {
      tr?.end('cancel');
      c.resume();
    },
  };
}

/** Preview geometry, drawn in the selection style. */
export const PREVIEW_NODE = (children: SvgNode[]): SvgNode => ({
  tag: 'g',
  attrs: { 'data-selected': 'true' },
  children,
});

/** The leaders attached to a placement (a frame under its text, a datum on its line). */
export function followersOf(b: Built, placementId: Id): AnnotationPlacement[] {
  return b.drawing.placements.filter(
    (f) =>
      f.layout.kind === 'leader' &&
      f.layout.attach.kind !== 'ref' &&
      f.layout.attach.placementId === placementId,
  );
}

/**
 * One placement laid out again with `next`, and the leaders attached to it laid out against that
 * (they follow it during the drag): the preview of a placement drag. Null when it cannot be laid
 * out (its view or annotation is not in the build).
 */
export function placementPreview(
  b: Built,
  next: AnnotationPlacement,
): { placed: PlacedAnnotation; items: DisplayItem[] } | null {
  const r = b.build.relayout(next);
  if (!r) return null;
  const moved = new Map([[next.id, r]]);
  const items = [...r.items];
  for (const f of followersOf(b, next.id)) {
    const fr = b.build.relayout(f, moved);
    if (fr) items.push(...fr.items);
  }
  return { placed: r, items };
}
