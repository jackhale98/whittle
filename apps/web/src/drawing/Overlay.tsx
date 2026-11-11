/** What the route draws over the sheet, in sheet mm (y up): selection, handles, tool rubber bands. */

import { viewOutline } from '@wren-cad/drawing';
import type { Size } from '@wren-cad/ui/drawing';
import { handlesOf } from './interact';
import type { Built } from './pipeline';
import type { DrawingUiState } from './state';

const ACCENT = 'var(--color-accent)';

export function SheetOverlay({
  ui,
  b,
  mm,
}: {
  ui: DrawingUiState;
  b: Built;
  mm: number;
  sheet: Size;
}) {
  const out: React.ReactNode[] = [];
  const sel = ui.selected;
  if (sel?.kind === 'view' && ui.tool === 'select') {
    const sv = b.build.views.get(sel.id);
    if (sv?.ok) {
      const o = viewOutline(sv);
      out.push(
        <rect
          key="sel"
          x={o.min[0] - 2}
          y={o.min[1] - 2}
          width={o.max[0] - o.min[0] + 4}
          height={o.max[1] - o.min[1] + 4}
          fill="none"
          stroke={ACCENT}
          strokeWidth={1.5 * mm}
          strokeDasharray={`${6 * mm} ${4 * mm}`}
          data-testid="view-selection"
        />,
      );
      if (sv.view.kind !== 'iso' && sv.view.kind !== 'detail') {
        for (const h of handlesOf(sv, mm)) {
          const r = 9 * mm;
          // An arrow pointing out of the view.
          const [dx, dy] = h.dir;
          const tip: [number, number] = [h.at[0] + dx * r * 0.7, h.at[1] + dy * r * 0.7];
          const l: [number, number] = [
            h.at[0] - dx * r * 0.5 - dy * r * 0.7,
            h.at[1] - dy * r * 0.5 + dx * r * 0.7,
          ];
          const rr: [number, number] = [
            h.at[0] - dx * r * 0.5 + dy * r * 0.7,
            h.at[1] - dy * r * 0.5 - dx * r * 0.7,
          ];
          out.push(
            <g key={`h${dx}${dy}`} data-testid="view-handle" data-dir={`${dx},${dy}`}>
              <circle
                cx={h.at[0]}
                cy={h.at[1]}
                r={r * 1.35}
                fill="var(--color-surface)"
                stroke={ACCENT}
                strokeWidth={1.2 * mm}
              />
              <polygon
                points={`${tip[0]},${tip[1]} ${l[0]},${l[1]} ${rr[0]},${rr[1]}`}
                fill={ACCENT}
              />
            </g>,
          );
        }
      }
    }
  }
  const g = ui.ghost;
  if (g?.kind === 'line')
    out.push(
      <line
        key="g"
        x1={g.a[0]}
        y1={g.a[1]}
        x2={g.b[0]}
        y2={g.b[1]}
        stroke={ACCENT}
        strokeWidth={1.5 * mm}
        strokeDasharray={`${10 * mm} ${3 * mm} ${2 * mm} ${3 * mm}`}
      />,
    );
  if (g?.kind === 'circle')
    out.push(
      <circle
        key="g"
        cx={g.at[0]}
        cy={g.at[1]}
        r={g.r}
        fill="none"
        stroke={ACCENT}
        strokeWidth={1.5 * mm}
        strokeDasharray={`${6 * mm} ${4 * mm}`}
      />,
    );
  if (g?.kind === 'rect')
    out.push(
      <rect
        key="g"
        x={g.min[0]}
        y={g.min[1]}
        width={g.max[0] - g.min[0]}
        height={g.max[1] - g.min[1]}
        fill="rgba(11,95,232,0.08)"
        stroke={ACCENT}
        strokeWidth={1.5 * mm}
        strokeDasharray={`${6 * mm} ${4 * mm}`}
      />,
    );
  for (const p of ui.hint?.picks ?? [])
    out.push(
      <circle
        key={`p${p.name}`}
        cx={p.at[0]}
        cy={p.at[1]}
        r={5 * mm}
        fill={ACCENT}
        fillOpacity={0.35}
        stroke={ACCENT}
        strokeWidth={1.2 * mm}
      />,
    );
  return <>{out}</>;
}
