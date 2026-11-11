import type { ExtrudeFeature, Vec3 } from '@wren-cad/contracts';
import { ExpressionInput, placeBubble } from '@wren-cad/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import { useChromeObstacles } from './obstacles';

/** Inline depth for the extrude being edited, floating next to its profile. */
export default function ExtrudeDepth({ wb, f }: { wb: Workbench; f: ExtrudeFeature }) {
  const regen = useObservable(wb.regen);
  const ref = useRef<HTMLDivElement>(null);
  const obstacles = useChromeObstacles(wb);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && (size?.w !== el.offsetWidth || size?.h !== el.offsetHeight))
      setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  const v = wb.viewport;
  if (!v || f.end.kind !== 'blind' || !regen) return null;
  const end = f.end;
  const regions = regen.result.sketches.flatMap((s) =>
    s.regions.filter((r) => f.profile.some((p) => p.name === r.name)).map((r) => ({ r, s })),
  );
  const first = regions[0];
  if (!first) return null;
  const { min, max } = first.r.mesh.bbox;
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const p = v.worldToScreen(c);
  if (!p.visible) return null;
  // Beside its profile, but never under the picking chip, the sheet, the rail or the view cube.
  const stage = wb.canvas;
  const at =
    size && stage
      ? placeBubble({
          anchor: p,
          size,
          viewport: { w: stage.clientWidth, h: stage.clientHeight },
          preferred: 'right',
          gap: 6,
          anchorRadius: 18,
          obstacles,
        })
      : null;
  return (
    <div
      ref={ref}
      className="w-panel pointer-events-auto absolute flex items-center gap-2 rounded-[12px] py-1 pr-1 pl-2.5"
      style={{ left: at ? at.left : p.x + 24, top: at ? at.top : p.y - 18 }}
      data-testid="extrude-depth"
    >
      <span className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">Depth</span>
      <div className="w-32">
        <ExpressionInput
          label="Extrude depth"
          value={end.depth}
          evaluate={(e) => wb.evaluate(e, 'length')}
          unitHint="mm"
          onPreview={(depth) =>
            wb.updateFeature({ ...f, end: { kind: 'blind', depth } }, 'preview')
          }
          onCommit={(depth) => wb.updateFeature({ ...f, end: { kind: 'blind', depth } }, 'commit')}
          testId="extrude-depth-input"
        />
      </div>
    </div>
  );
}
