/** What the route draws over the sheet, in sheet mm (y up): selection, handles, tool rubber bands. */

import { viewOutline } from '@wren-cad/drawing';
import type { Size } from '@wren-cad/ui/drawing';
import { cutHandlesOf, detailGripsOf, handlesOf } from './interact';
import { leaderHandlesOf } from './interact-leader';
import type { Built } from './pipeline';
import type { DrawingUiState } from './state';

const ACCENT = 'var(--color-accent)';

export function SheetOverlay({
  ui,
  b,
  mm,
  touch,
}: {
  ui: DrawingUiState;
  b: Built;
  mm: number;
  sheet: Size;
  /** Finger or pen: grips are 44 px targets. */
  touch?: boolean;
}) {
  const out: React.ReactNode[] = [];
  const sel = ui.selected;
  if (sel?.kind === 'view' && ui.tool === 'select') {
    const sv = b.build.views.get(sel.id);
    if (sv?.ok) {
      const o = viewOutline(sv);
      const inner: React.ReactNode[] = [];
      out.push(
        <g key="sel-view" data-host={sel.id} data-source={`overlay:view:${sel.id}`}>
          {inner}
        </g>,
      );
      inner.push(
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
          inner.push(
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
  // The cut line's vertices of a selected section sit on its parent: drag to reshape (half and
  // offset sections); the inspector has the same vertices as typed fields.
  if (sel?.kind === 'view' && ui.tool === 'select') {
    const hs = cutHandlesOf(b, sel.id);
    const sv = b.drawing.views.find((v) => v.id === sel.id);
    if (hs.length > 0 && sv?.kind === 'section')
      out.push(
        <g key="cut" data-host={sv.parentId} data-source={`overlay:cut:${sel.id}`}>
          {hs.length > 1 ? (
            <polyline
              points={hs.map((h) => h.at.join(',')).join(' ')}
              fill="none"
              stroke={ACCENT}
              strokeWidth={1.2 * mm}
              strokeDasharray={`${8 * mm} ${3 * mm}`}
            />
          ) : null}
          {hs.map((h) => (
            <circle
              key={`cut${h.index}`}
              cx={h.at[0]}
              cy={h.at[1]}
              r={(touch ? 12 : 5) * mm}
              fill="var(--color-surface)"
              stroke={ACCENT}
              strokeWidth={1.5 * mm}
              data-testid="cut-handle"
              data-index={h.index}
            />
          ))}
        </g>,
      );
    // A detail's circle on its parent: a radius handle and a centre handle (ADR-094).
    const grips = detailGripsOf(b, sel.id);
    const dv = b.drawing.views.find((v) => v.id === sel.id);
    if (grips.length > 0 && dv?.kind === 'detail') {
      const gr = (touch ? 22 : 9) * mm;
      out.push(
        <g key="detail" data-host={dv.parentId} data-source={`overlay:detail:${sel.id}`}>
          {grips.map((gp) => (
            <g key={gp.kind} data-testid="detail-handle" data-kind={gp.kind}>
              <circle
                cx={gp.at[0]}
                cy={gp.at[1]}
                r={gr}
                fill="var(--color-surface)"
                stroke={ACCENT}
                strokeWidth={1.5 * mm}
              />
              <polyline
                points={`${gp.at[0] - 0.55 * gr},${gp.at[1]} ${gp.at[0] + 0.55 * gr},${gp.at[1]}`}
                fill="none"
                stroke={ACCENT}
                strokeWidth={1.5 * mm}
              />
              {gp.kind === 'center' ? (
                <polyline
                  points={`${gp.at[0]},${gp.at[1] - 0.55 * gr} ${gp.at[0]},${gp.at[1] + 0.55 * gr}`}
                  fill="none"
                  stroke={ACCENT}
                  strokeWidth={1.5 * mm}
                />
              ) : null}
            </g>
          ))}
        </g>,
      );
    }
  }
  // The selected dimension's text is a drag target of its own (along the line, above, below): its
  // box is outlined, and on touch it is a 44 px target (pickAt).
  if (sel?.kind === 'placement') {
    const placed = b.build.placed.find((x) => x.placementId === sel.id);
    if (placed && placed.textBox.length > 0)
      out.push(
        <polygon
          key="text-box"
          data-source={`placement:${sel.id}`}
          data-testid="text-grab"
          points={placed.textBox.map((p) => `${p[0]},${p[1]}`).join(' ')}
          fill="none"
          stroke={ACCENT}
          strokeWidth={1 * mm}
          strokeDasharray={`${3 * mm} ${2 * mm}`}
        />,
      );
  }
  // A selected leader's handles: its attach point (held on its line), bends, and "add a bend".
  if (sel?.kind === 'placement' && ui.tool === 'select') {
    for (const h of leaderHandlesOf(b, sel.id)) {
      const k = h.kind === 'bend' ? `lb${h.index}` : `l${h.kind}`;
      out.push(
        <g key={k} data-testid="leader-handle" data-kind={h.kind}>
          <circle
            cx={h.at[0]}
            cy={h.at[1]}
            r={(h.kind === 'addBend' ? 3.5 : 4.5) * mm}
            fill={h.kind === 'attach' ? ACCENT : 'var(--color-surface)'}
            fillOpacity={h.kind === 'attach' ? 0.35 : 1}
            stroke={ACCENT}
            strokeWidth={1.3 * mm}
            strokeDasharray={h.kind === 'addBend' ? `${2 * mm} ${1.5 * mm}` : undefined}
          />
        </g>,
      );
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
