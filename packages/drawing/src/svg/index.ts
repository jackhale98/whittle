/**
 * `@wren-cad/drawing/svg`: the SVG editor model and SVG export from the display list. DOM-free:
 * `svgModel` returns a plain node tree the UI renders (React or anything), grouped by source so a
 * pick maps to a view edge, a placement or a title block slot; `renderSvg` serialises it.
 *
 * Sheet mm, y up: the root group flips y once; text unflips itself. The viewBox is the sheet, and
 * width/height are in mm, so an SVG printed from a browser is at true scale too. Text uses the
 * drawing font with kerning off and positions computed from the same metrics as PDF and DXF.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle } from '@wren-cad/contracts';
import type { DisplayItem, DisplayList, ItemSource } from '../annotation/display';
import { flattenBSpline } from '../annotation/flatten';
import { roleStroke } from '../annotation/strokes';
import { drawingFont, fontSizeFor } from '../annotation/text';

export interface SvgNode {
  tag: string;
  attrs: Record<string, string>;
  children?: (SvgNode | string)[];
}

export interface SvgOptions {
  /** Ink colour (default black). */
  ink?: string;
  /** Needs-attention colour (default `#d0342c`); attention strokes also get a dash pattern. */
  attention?: string;
  /** Paper colour; absent = transparent. */
  paper?: string;
  /** CSS font family for text (the UI declares the self-hosted `@font-face`). */
  fontFamily?: string;
}

const r = (x: number) => {
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
};
const pts = (p: readonly (readonly [number, number])[]) =>
  p.map(([x, y]) => `${r(x)},${r(y)}`).join(' ');

function sourceKey(s: ItemSource | undefined): string {
  if (!s) return 'misc';
  switch (s.kind) {
    case 'view':
      return `view:${s.viewId}`;
    case 'placement':
      return `placement:${s.placementId}`;
    case 'centerMark':
      return `centerMark:${s.viewId}:${s.markId ?? 'auto'}`;
    case 'note':
      return `note:${s.noteId}`;
    case 'table':
      return `table:${s.tableId}`;
    case 'titleBlock':
      return `titleBlock:${s.slot ?? ''}`;
    default:
      return s.kind;
  }
}

/**
 * The view whose sheet space an item is drawn in: moving that view moves the item (ADR-094, the
 * editor translates these groups while a view is dragged). Absent for the template, notes, tables.
 */
function hostOf(s: ItemSource | undefined): string | undefined {
  if (s?.kind === 'view') return s.on ?? s.viewId;
  if (s?.kind === 'centerMark') return s.viewId;
  if (s?.kind === 'placement') return s.viewId;
  return undefined;
}

function arcPath(cx: number, cy: number, rad: number, a0: number, a1: number): string {
  const sweep = a1 - a0;
  const x0 = cx + rad * Math.cos(a0);
  const y0 = cy + rad * Math.sin(a0);
  const x1 = cx + rad * Math.cos(a1);
  const y1 = cy + rad * Math.sin(a1);
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const dir = sweep >= 0 ? 1 : 0;
  return `M${r(x0)} ${r(y0)}A${r(rad)} ${r(rad)} 0 ${large} ${dir} ${r(x1)} ${r(y1)}`;
}

function itemNode(
  item: DisplayItem,
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
  o: Required<SvgOptions>,
): SvgNode | null {
  const color = item.attention ? o.attention : o.ink;
  if (item.kind === 'text') {
    const font = drawingFont();
    const size = fontSizeFor(item.height, font);
    const dy =
      item.baseline === 'middle' ? item.height / 2 : item.baseline === 'top' ? item.height : 0;
    const anchor = item.align === 'left' ? 'start' : item.align === 'center' ? 'middle' : 'end';
    return {
      tag: 'text',
      attrs: {
        transform: `translate(${r(item.at[0])} ${r(item.at[1])}) scale(1 -1) rotate(${r(-item.angle)})`,
        y: r(dy),
        'font-size': r(size),
        'text-anchor': anchor,
        fill: color,
        stroke: 'none',
      },
      children: [item.text],
    };
  }
  if (item.kind === 'fill') {
    return {
      tag: 'path',
      attrs: {
        d: item.loops.map((l) => `M${pts(l).replace(/ /g, 'L')}Z`).join(''),
        fill: color,
        'fill-rule': 'evenodd',
        stroke: 'none',
      },
    };
  }
  const stroke = roleStroke(item.role, style);
  const attrs: Record<string, string> = {
    stroke: color,
    'stroke-width': r(stroke.width),
    fill: 'none',
  };
  const dash = stroke.dash.length ? stroke.dash : item.attention ? [1, 0.6] : [];
  if (dash.length) attrs['stroke-dasharray'] = dash.map(r).join(' ');
  switch (item.kind) {
    case 'line':
      return {
        tag: 'line',
        attrs: { x1: r(item.a[0]), y1: r(item.a[1]), x2: r(item.b[0]), y2: r(item.b[1]), ...attrs },
      };
    case 'polyline':
      return {
        tag: item.closed ? 'polygon' : 'polyline',
        attrs: { points: pts(item.points), ...attrs },
      };
    case 'arc':
      if (Math.abs(item.end - item.start) >= 2 * Math.PI - 1e-9)
        return {
          tag: 'circle',
          attrs: { cx: r(item.center[0]), cy: r(item.center[1]), r: r(item.radius), ...attrs },
        };
      return {
        tag: 'path',
        attrs: {
          d: arcPath(item.center[0], item.center[1], item.radius, item.start, item.end),
          ...attrs,
        },
      };
    case 'ellipse': {
      const a = Math.hypot(item.major[0], item.major[1]);
      const b = a * item.ratio;
      const rot = Math.atan2(item.major[1], item.major[0]);
      const at = (t: number) => {
        const x = a * Math.cos(t);
        const y = b * Math.sin(t);
        return [
          item.center[0] + x * Math.cos(rot) - y * Math.sin(rot),
          item.center[1] + x * Math.sin(rot) + y * Math.cos(rot),
        ] as const;
      };
      const sweep = item.end - item.start;
      const deg = r((rot * 180) / Math.PI);
      if (Math.abs(sweep) >= 2 * Math.PI - 1e-9) {
        const p0 = at(item.start);
        const p1 = at(item.start + Math.PI);
        return {
          tag: 'path',
          attrs: {
            d: `M${r(p0[0])} ${r(p0[1])}A${r(a)} ${r(b)} ${deg} 0 1 ${r(p1[0])} ${r(p1[1])}A${r(a)} ${r(b)} ${deg} 0 1 ${r(p0[0])} ${r(p0[1])}`,
            ...attrs,
          },
        };
      }
      const p0 = at(item.start);
      const p1 = at(item.end);
      return {
        tag: 'path',
        attrs: {
          d: `M${r(p0[0])} ${r(p0[1])}A${r(a)} ${r(b)} ${deg} ${Math.abs(sweep) > Math.PI ? 1 : 0} 1 ${r(p1[0])} ${r(p1[1])}`,
          ...attrs,
        },
      };
    }
    case 'spline':
      return {
        tag: 'polyline',
        attrs: {
          points: pts(flattenBSpline(item.degree, item.poles, item.knots, 0.005, item.weights)),
          ...attrs,
        },
      };
  }
}

/**
 * Nodes for display items, in paint order and without the per-source grouping: the editor draws a
 * dragged item's preview with these (ADR-094). Same strokes and text as `svgModel`.
 */
export function svgItems(
  items: readonly DisplayItem[],
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
  options: SvgOptions = {},
): SvgNode[] {
  const o: Required<SvgOptions> = {
    ink: options.ink ?? '#000',
    attention: options.attention ?? '#d0342c',
    paper: options.paper ?? 'none',
    fontFamily: options.fontFamily ?? `${drawingFont().family}, sans-serif`,
  };
  const out: SvgNode[] = [];
  for (const item of items) {
    const node = itemNode(item, style, o);
    if (node) out.push(node);
  }
  return out;
}

/** The editor model: groups per source in paint order (`data-source` keys for picking). */
export function svgModel(
  list: DisplayList,
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
  options: SvgOptions = {},
): SvgNode {
  const o: Required<SvgOptions> = {
    ink: options.ink ?? '#000',
    attention: options.attention ?? '#d0342c',
    paper: options.paper ?? 'none',
    fontFamily: options.fontFamily ?? `${drawingFont().family}, sans-serif`,
  };
  const groups: SvgNode[] = [];
  let current: SvgNode | undefined;
  let currentKey = '';
  for (const item of list.items) {
    const node = itemNode(item, style, o);
    if (!node) continue;
    const host = hostOf(item.source);
    const key = `${sourceKey(item.source)}@${host ?? ''}`;
    if (!current || key !== currentKey) {
      current = {
        tag: 'g',
        attrs: { 'data-source': sourceKey(item.source), ...(host ? { 'data-host': host } : {}) },
        children: [],
      };
      if (item.attention) current.attrs['data-attention'] = 'true';
      groups.push(current);
      currentKey = key;
    }
    current.children?.push(node);
  }
  const W = r(list.width);
  const H = r(list.height);
  const children: SvgNode[] = [];
  if (o.paper !== 'none')
    children.push({ tag: 'rect', attrs: { x: '0', y: '0', width: W, height: H, fill: o.paper } });
  children.push({
    tag: 'g',
    attrs: {
      transform: `matrix(1 0 0 -1 0 ${H})`,
      'stroke-linecap': 'butt',
      'stroke-linejoin': 'round',
      'font-family': o.fontFamily,
      style: 'font-kerning:none',
    },
    children: groups,
  });
  return {
    tag: 'svg',
    attrs: {
      xmlns: 'http://www.w3.org/2000/svg',
      width: `${W}mm`,
      height: `${H}mm`,
      viewBox: `0 0 ${W} ${H}`,
    },
    children,
  };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function serializeSvg(node: SvgNode): string {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  if (!node.children?.length) return `<${node.tag}${attrs}/>`;
  const inner = node.children
    .map((c) => (typeof c === 'string' ? esc(c) : serializeSvg(c)))
    .join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/** SVG export of a sheet. */
export function renderSvg(
  list: DisplayList,
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
  options: SvgOptions = {},
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeSvg(svgModel(list, style, options))}\n`;
}
