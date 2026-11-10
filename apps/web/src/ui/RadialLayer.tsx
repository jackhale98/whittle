/**
 * The radial menu (PLAN 9.4, ADR-046/049) for the app: contents by selection type (`radial.ts`),
 * Repeat = the last command. Lazy: the menu, its icons and its layout maths load on the first
 * right click, long-press or held key, never on the initial route.
 */

import { type RadialItem, RadialMenu, sketchCurveTools, sketchTools, tools } from '@wren-cad/ui';
import {
  CircleMinus,
  Maximize,
  Redo2,
  Scissors,
  Undo2,
  Box as ViewIcon,
  X as XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useObservable } from '../app/observable';
import { modelRadialIds, type RadialSelection, sketchRadialIds } from '../app/radial';
import type { Workbench } from '../app/workbench';

const ic = 'size-[18px]';

const EXTRA: Record<string, { label: string; icon: ReactNode }> = {
  cut: { label: 'Cut', icon: <CircleMinus className={ic} aria-hidden /> },
  section: { label: 'Section', icon: <Scissors className={ic} aria-hidden /> },
  fit: { label: 'Fit view', icon: <Maximize className={ic} aria-hidden /> },
  iso: { label: 'Isometric', icon: <ViewIcon className={ic} aria-hidden /> },
  undo: { label: 'Undo', icon: <Undo2 className={ic} aria-hidden /> },
  redo: { label: 'Redo', icon: <Redo2 className={ic} aria-hidden /> },
  'sketch:finish': { label: 'Finish sketch', icon: <XIcon className={ic} aria-hidden /> },
};

function itemFor(id: string): RadialItem {
  const extra = EXTRA[id];
  if (extra) return { id, ...extra };
  if (id.startsWith('sketch:')) {
    const tool = id.slice(7);
    const spec = [...sketchTools, ...sketchCurveTools].find((t) => t.id === tool);
    if (spec) return { id, label: spec.label, icon: spec.icon };
  }
  const t = tools.find((x) => x.id === id);
  if (t) return { id, label: t.label, icon: <t.Icon className={ic} aria-hidden /> };
  return { id, label: id };
}

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
  const ids = ui.sketch ? sketchRadialIds() : modelRadialIds(sel);
  const last = wb.lastCommandLabel();
  const label = last ? (tools.find((t) => t.id === last)?.label ?? last) : null;
  return (
    <RadialMenu
      at={{ x: r.x, y: r.y }}
      items={ids.map(itemFor)}
      repeat={{ label: label ?? 'Nothing yet', disabled: !last }}
      source={r.source}
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
