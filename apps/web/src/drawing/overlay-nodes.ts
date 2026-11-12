/**
 * Overlay shapes as SVG nodes, for the drag previews (ADR-094): the same handles and guides the
 * route's React overlay draws for the stored state, drawn here for the state under the pointer.
 * Sheet mm, y up; `mm` is the size of one screen pixel.
 */

import type { Vec2 } from '@wren-cad/contracts';
import type { SvgNode } from '@wren-cad/drawing/svg';
import type { TextSide } from './drag-math';

export const ACCENT = 'var(--color-accent)';

const n = (x: number) => String(Math.round(x * 1000) / 1000);

const el = (
  tag: string,
  attrs: Record<string, string>,
  children?: (SvgNode | string)[],
): SvgNode => (children ? { tag, attrs, children } : { tag, attrs });

export function selectionRect(min: Vec2, max: Vec2, mm: number): SvgNode {
  return el('rect', {
    x: n(min[0] - 2),
    y: n(min[1] - 2),
    width: n(max[0] - min[0] + 4),
    height: n(max[1] - min[1] + 4),
    fill: 'none',
    stroke: ACCENT,
    'stroke-width': n(1.5 * mm),
    'stroke-dasharray': `${n(6 * mm)} ${n(4 * mm)}`,
  });
}

/** A round grip: a disc with an accent ring (`r` in screen px). */
export function grip(at: Vec2, mm: number, r = 9, attrs: Record<string, string> = {}): SvgNode {
  return el('circle', {
    cx: n(at[0]),
    cy: n(at[1]),
    r: n(r * mm),
    fill: 'var(--color-surface)',
    stroke: ACCENT,
    'stroke-width': n(1.5 * mm),
    ...attrs,
  });
}

/** The cut line of a section and its vertices. */
export function cutLineNodes(points: readonly Vec2[], mm: number, r: number): SvgNode[] {
  const out: SvgNode[] = [];
  if (points.length > 1)
    out.push(
      el('polyline', {
        points: points.map((p) => `${n(p[0])},${n(p[1])}`).join(' '),
        fill: 'none',
        stroke: ACCENT,
        'stroke-width': n(1.2 * mm),
        'stroke-dasharray': `${n(8 * mm)} ${n(3 * mm)}`,
      }),
    );
  for (const p of points) out.push(grip(p, mm, r));
  return out;
}

/** A detail circle's grips: the radius handle on its east side, the centre handle at its centre. */
export function detailGripNodes(
  centre: Vec2,
  r: number,
  mm: number,
  gripR: number,
  centreToo: boolean,
): SvgNode[] {
  const out: SvgNode[] = [grip([centre[0] + r, centre[1]], mm, gripR)];
  // A double arrow across the radius handle.
  const a = 0.55 * gripR * mm;
  out.push(
    el('polyline', {
      points: `${n(centre[0] + r - a)},${n(centre[1])} ${n(centre[0] + r + a)},${n(centre[1])}`,
      fill: 'none',
      stroke: ACCENT,
      'stroke-width': n(1.5 * mm),
    }),
  );
  if (centreToo) {
    out.push(grip(centre, mm, gripR));
    const c = 0.5 * gripR * mm;
    out.push(
      el('polyline', {
        points: `${n(centre[0] - c)},${n(centre[1])} ${n(centre[0] + c)},${n(centre[1])}`,
        fill: 'none',
        stroke: ACCENT,
        'stroke-width': n(1.5 * mm),
      }),
      el('polyline', {
        points: `${n(centre[0])},${n(centre[1] - c)} ${n(centre[0])},${n(centre[1] + c)}`,
        fill: 'none',
        stroke: ACCENT,
        'stroke-width': n(1.5 * mm),
      }),
    );
  }
  return out;
}

const SIDE_LABEL: Record<TextSide, string> = {
  above: 'Above the line',
  inline: 'In the line',
  below: 'Below the line',
};

/**
 * The hint while a dimension's text is dragged: the three places it snaps to along the dimension
 * line (above, inline, below), the chosen one drawn solid, and its name by the pointer.
 */
export function textSideHint(
  line: [Vec2, Vec2],
  h: number,
  side: TextSide,
  at: Vec2,
  mm: number,
): SvgNode[] {
  const dx = line[1][0] - line[0][0];
  const dy = line[1][1] - line[0][1];
  const l = Math.hypot(dx, dy) || 1;
  const u: Vec2 = [dx / l, dy / l];
  const nn: Vec2 = [-u[1], u[0]];
  const pad = 6;
  const from: Vec2 = [line[0][0] - u[0] * pad, line[0][1] - u[1] * pad];
  const to: Vec2 = [line[1][0] + u[0] * pad, line[1][1] + u[1] * pad];
  const out: SvgNode[] = [];
  for (const s of ['above', 'inline', 'below'] as const) {
    const o = s === 'above' ? 0.9 * h : s === 'below' ? -0.9 * h : 0;
    const on = s === side;
    out.push(
      el('line', {
        x1: n(from[0] + nn[0] * o),
        y1: n(from[1] + nn[1] * o),
        x2: n(to[0] + nn[0] * o),
        y2: n(to[1] + nn[1] * o),
        stroke: ACCENT,
        'stroke-width': n((on ? 2 : 1) * mm),
        'stroke-opacity': on ? '1' : '0.45',
        ...(on ? {} : { 'stroke-dasharray': `${n(4 * mm)} ${n(4 * mm)}` }),
      }),
    );
  }
  out.push(
    el(
      'text',
      {
        transform: `translate(${n(at[0] + 14 * mm)} ${n(at[1] - 16 * mm)}) scale(1 -1)`,
        'font-size': n(12 * mm),
        'font-family': 'sans-serif',
        fill: ACCENT,
        stroke: 'none',
        'data-testid': 'text-side-hint',
        'data-side': side,
      },
      [SIDE_LABEL[side]],
    ),
  );
  return out;
}

/** A dashed outline of a dimension's text box (the selected dimension's grab area). */
export function textBoxOutline(box: readonly Vec2[], mm: number): SvgNode {
  return el('polygon', {
    points: box.map((p) => `${n(p[0])},${n(p[1])}`).join(' '),
    fill: 'none',
    stroke: ACCENT,
    'stroke-width': n(1 * mm),
    'stroke-dasharray': `${n(3 * mm)} ${n(2 * mm)}`,
  });
}
