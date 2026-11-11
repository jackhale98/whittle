/**
 * The radial menu (PLAN 9.4, ADR-046/049) for the app: contents by selection type (`radial.ts`),
 * or the user's own ring for that context (`radial-config.ts`, ADR-085). Repeat = the last
 * command. Lazy: the menu, its icons and its layout maths load on the first right click,
 * long-press or held key, never on the initial route.
 */

import { canFolder, RadialMenu, tools } from '@wren-cad/ui';
import { useObservable } from '../app/observable';
import { modelRadialIds, type RadialSelection, sketchRadialIds } from '../app/radial';
import { contextOf, customRing, loadRadialConfig, ringToItems } from '../app/radial-config';
import type { Workbench } from '../app/workbench';
import { itemFor } from './radial-registry';

export default function RadialLayer({ wb }: { wb: Workbench }) {
  const ui = useObservable(wb.ui);
  const r = ui.radial;
  if (!r) return null;
  const sel: RadialSelection[] = ui.selection.map((s) => ({
    kind: s.hit.kind,
    ...(s.hit.kind === 'face'
      ? { planar: wb.face(s.hit.bodyId, s.hit.index)?.planar === true }
      : {}),
  }));
  // Several features picked in the tree and none in the viewport: offer "Add to new folder".
  const picked = wb.treeSelection.get();
  const part = wb.part;
  const run = picked.length > 1 ? wb.folderRunOf(picked) : [];
  const folderable =
    !!part &&
    sel.length === 0 &&
    run.length > 1 &&
    canFolder(part.features, part.folders ?? [], run).ok;
  const cfg = loadRadialConfig().config;
  const ctx = contextOf(sel, {
    sketch: !!ui.sketch,
    sketchSelected: (ui.sketch?.selected.length ?? 0) > 0,
    treePicked: picked.length,
  });
  const ring = customRing(cfg, ctx);
  const items = ring
    ? ringToItems(ring, { sel, folderable, sketch: !!ui.sketch }, itemFor)
    : (ui.sketch ? sketchRadialIds() : modelRadialIds(sel, { folderable })).map(itemFor);
  const last = wb.lastCommandLabel();
  const label = last ? (tools.find((t) => t.id === last)?.label ?? last) : null;
  return (
    <RadialMenu
      at={{ x: r.x, y: r.y }}
      items={items}
      repeat={{ label: label ?? 'Nothing yet', disabled: !last }}
      source={r.source}
      flickWindow={cfg.flickWindow}
      drawDelay={cfg.drawAfterDelay ? cfg.flickWindow : 0}
      {...(r.held ? { held: true } : {})}
      {...(r.pointerId !== undefined ? { pointerId: r.pointerId } : {})}
      {...(r.holdCode ? { holdCode: r.holdCode } : {})}
      label={ui.sketch ? 'Sketch radial menu' : 'Radial menu'}
      testId="radial-menu"
      onSelect={(id) => wb.radialAction(id)}
      onCancel={() => wb.patchUi({ radial: null })}
    />
  );
}
