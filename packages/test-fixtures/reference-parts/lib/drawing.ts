/**
 * A small SVG drawing generator for the reference-part spec drawings: orthographic views drawn in
 * model coordinates, driving-dimension annotations, and Wren's own title block. The sheet is
 * 420 x 297 (user units are millimetres on the sheet). The look is deliberately plain and does not
 * imitate any published drawing template.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Unit } from './types';

type Kind = 'visible' | 'hidden' | 'center';

const STYLE: Record<Kind, string> = {
  visible: 'stroke="#111" stroke-width="0.5" fill="none"',
  hidden: 'stroke="#555" stroke-width="0.3" stroke-dasharray="2 1.2" fill="none"',
  center: 'stroke="#2a5db0" stroke-width="0.25" stroke-dasharray="6 1.5 1 1.5" fill="none"',
};

const f = (n: number): string => String(Math.round(n * 1000) / 1000);
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface DimLabel {
  name: string;
  value: number;
  unit: Unit;
}

export function dimText(l: DimLabel): string {
  const u = l.unit === 'deg' ? '°' : l.unit === 'mm' ? ' mm' : '';
  return `${l.name} = ${l.value}${u}`;
}

export class View {
  private readonly out: string[] = [];
  constructor(
    readonly name: string,
    /** Sheet position of the model-space origin of this view. */
    private readonly ox: number,
    private readonly oy: number,
    /** Sheet millimetres per model millimetre. */
    private readonly s: number,
    private readonly dimensions: string[],
  ) {}

  private X(x: number): number {
    return this.ox + x * this.s;
  }
  private Y(y: number): number {
    return this.oy - y * this.s;
  }

  line(x1: number, y1: number, x2: number, y2: number, kind: Kind = 'visible'): this {
    this.out.push(
      `<line x1="${f(this.X(x1))}" y1="${f(this.Y(y1))}" x2="${f(this.X(x2))}" y2="${f(this.Y(y2))}" ${STYLE[kind]}/>`,
    );
    return this;
  }
  rect(x0: number, y0: number, x1: number, y1: number, kind: Kind = 'visible'): this {
    this.out.push(
      `<rect x="${f(this.X(Math.min(x0, x1)))}" y="${f(this.Y(Math.max(y0, y1)))}" width="${f(Math.abs(x1 - x0) * this.s)}" height="${f(Math.abs(y1 - y0) * this.s)}" ${STYLE[kind]}/>`,
    );
    return this;
  }
  circle(cx: number, cy: number, r: number, kind: Kind = 'visible'): this {
    this.out.push(
      `<circle cx="${f(this.X(cx))}" cy="${f(this.Y(cy))}" r="${f(r * this.s)}" ${STYLE[kind]}/>`,
    );
    return this;
  }
  /** Polyline in model coordinates. */
  path(pts: [number, number][], closed = false, kind: Kind = 'visible'): this {
    const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${f(this.X(x))} ${f(this.Y(y))}`);
    this.out.push(`<path d="${d.join(' ')}${closed ? ' Z' : ''}" ${STYLE[kind]}/>`);
    return this;
  }
  /** Circular arc from angle a0 to a1 (degrees, counter-clockwise in model space). */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, kind: Kind = 'visible'): this {
    const p = (a: number): [number, number] => [
      cx + r * Math.cos((a * Math.PI) / 180),
      cy + r * Math.sin((a * Math.PI) / 180),
    ];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    const large = (((a1 - a0) % 360) + 360) % 360 > 180 ? 1 : 0;
    this.out.push(
      `<path d="M${f(this.X(x0))} ${f(this.Y(y0))} A${f(r * this.s)} ${f(r * this.s)} 0 ${large} 0 ${f(this.X(x1))} ${f(this.Y(y1))}" ${STYLE[kind]}/>`,
    );
    return this;
  }
  centerCross(cx: number, cy: number, r: number): this {
    this.line(cx - r * 1.3, cy, cx + r * 1.3, cy, 'center');
    this.line(cx, cy - r * 1.3, cx, cy + r * 1.3, 'center');
    return this;
  }

  private arrow(x: number, y: number, dx: number, dy: number): string {
    const L = 2.4;
    const W = 0.8;
    const nx = -dy;
    const ny = dx;
    return `<path d="M${f(x)} ${f(y)} L${f(x - dx * L + nx * W)} ${f(y - dy * L + ny * W)} L${f(x - dx * L - nx * W)} ${f(y - dy * L - ny * W)} Z" fill="#111"/>`;
  }

  private label(x: number, y: number, l: DimLabel, anchor = 'middle', rotate = false): void {
    const t = dimText(l);
    const w = t.length * 1.95;
    const x0 = anchor === 'start' ? x : anchor === 'middle' ? x - w / 2 : x - w;
    if (rotate ? false : x0 < 8 || x0 + w > 412 || y < 9 || y > 290)
      throw new Error(
        `drawing label "${t}" is off the sheet (x ${f(x0)}..${f(x0 + w)}, y ${f(y)})`,
      );
    this.dimensions.push(l.name);
    const tr = rotate ? ` transform="rotate(-90 ${f(x)} ${f(y)})"` : '';
    this.out.push(
      `<text data-dim="${esc(l.name)}" data-value="${l.value}" x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-size="3.2" font-family="monospace" fill="#111"${tr}>${esc(t)}</text>`,
    );
  }

  /**
   * Horizontal dimension between model points (x1, y1) and (x2, y2), with the dimension line
   * `offset` model millimetres above (positive) or below (negative) the higher or lower point.
   */
  dimH(x1: number, y1: number, x2: number, y2: number, offset: number, l: DimLabel): this {
    const yl = (offset >= 0 ? Math.max(y1, y2) : Math.min(y1, y2)) + offset;
    const sy = this.Y(yl);
    const a = this.X(Math.min(x1, x2));
    const b = this.X(Math.max(x1, x2));
    const ext = (x: number, y: number) =>
      `<line x1="${f(this.X(x))}" y1="${f(this.Y(y))}" x2="${f(this.X(x))}" y2="${f(sy + (offset >= 0 ? -1.2 : 1.2))}" stroke="#444" stroke-width="0.2"/>`;
    this.out.push(ext(x1, y1), ext(x2, y2));
    this.out.push(
      `<line x1="${f(a)}" y1="${f(sy)}" x2="${f(b)}" y2="${f(sy)}" stroke="#111" stroke-width="0.25"/>`,
    );
    this.out.push(this.arrow(a, sy, -1, 0), this.arrow(b, sy, 1, 0));
    this.label((a + b) / 2, sy + (offset >= 0 ? -1.2 : 4), l);
    return this;
  }

  /** Vertical dimension; the dimension line is `offset` model millimetres right (positive) or left of the points. */
  dimV(x1: number, y1: number, x2: number, y2: number, offset: number, l: DimLabel): this {
    const xl = (offset >= 0 ? Math.max(x1, x2) : Math.min(x1, x2)) + offset;
    const sx = this.X(xl);
    const a = this.Y(Math.min(y1, y2));
    const b = this.Y(Math.max(y1, y2));
    const ext = (x: number, y: number) =>
      `<line x1="${f(this.X(x))}" y1="${f(this.Y(y))}" x2="${f(sx + (offset >= 0 ? -1.2 : 1.2))}" y2="${f(this.Y(y))}" stroke="#444" stroke-width="0.2"/>`;
    this.out.push(ext(x1, y1), ext(x2, y2));
    this.out.push(
      `<line x1="${f(sx)}" y1="${f(a)}" x2="${f(sx)}" y2="${f(b)}" stroke="#111" stroke-width="0.25"/>`,
    );
    this.out.push(this.arrow(sx, a, 0, 1), this.arrow(sx, b, 0, -1));
    this.label(
      sx + (offset >= 0 ? 1.2 : -1.2),
      (a + b) / 2,
      l,
      offset >= 0 ? 'start' : 'end',
      false,
    );
    return this;
  }

  /** Diameter or radius leader from a point on the circle (angle in degrees) out to text. */
  leader(cx: number, cy: number, r: number, angle: number, len: number, l: DimLabel): this {
    const a = (angle * Math.PI) / 180;
    const px = this.X(cx + r * Math.cos(a));
    const py = this.Y(cy + r * Math.sin(a));
    const ex = px + Math.cos(a) * len;
    const ey = py - Math.sin(a) * len;
    this.out.push(
      `<line x1="${f(px)}" y1="${f(py)}" x2="${f(ex)}" y2="${f(ey)}" stroke="#111" stroke-width="0.25"/>`,
    );
    this.out.push(this.arrow(px, py, -Math.cos(a), Math.sin(a)));
    this.label(ex + (Math.cos(a) >= 0 ? 1 : -1), ey, l, Math.cos(a) >= 0 ? 'start' : 'end');
    return this;
  }

  /** Free text note tied to a dimension (angle, count): placed at a model point. */
  note(x: number, y: number, l: DimLabel, anchor: 'start' | 'middle' | 'end' = 'start'): this {
    this.label(this.X(x), this.Y(y), l, anchor);
    return this;
  }

  caption(x: number, y: number, text: string): this {
    this.out.push(
      `<text x="${f(this.X(x))}" y="${f(this.Y(y))}" font-size="3.6" font-family="sans-serif" font-weight="bold" fill="#111">${esc(text)}</text>`,
    );
    return this;
  }

  svg(): string {
    return `<g data-view="${esc(this.name)}">\n${this.out.join('\n')}\n</g>`;
  }
}

export interface TitleInfo {
  id: string;
  title: string;
  material: string;
  density: string;
  level: string;
}

export class Drawing {
  readonly views: View[] = [];
  readonly dimensions: string[] = [];
  constructor(private readonly info: TitleInfo) {}

  view(name: string, ox: number, oy: number, scale: number): View {
    const v = new View(name, ox, oy, scale, this.dimensions);
    this.views.push(v);
    return v;
  }

  render(): string {
    const i = this.info;
    const tb = (x: number, y: number, w: number, h: number, label: string, text: string) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#111" stroke-width="0.3"/>` +
      `<text x="${x + 1.5}" y="${y + 3.2}" font-size="2.2" font-family="sans-serif" fill="#666">${esc(label)}</text>` +
      `<text x="${x + 1.5}" y="${y + h - 2}" font-size="3.6" font-family="sans-serif" fill="#111">${esc(text)}</text>`;
    const block = [
      `<rect x="215" y="257" width="190" height="35" fill="#fff" stroke="#111" stroke-width="0.6"/>`,
      `<text x="218" y="266" font-size="6" font-family="sans-serif" font-weight="bold" fill="#111">Wren reference part</text>`,
      tb(215, 268, 95, 11, 'PART', `${i.id}  ${i.title}`),
      tb(310, 268, 95, 11, 'LEVEL', i.level),
      tb(215, 279, 95, 13, 'MATERIAL', i.material),
      tb(310, 279, 95, 13, 'DENSITY', i.density),
    ];
    const note = [
      `<text x="10" y="284" font-size="2.8" font-family="sans-serif" fill="#444">All dimensions in mm unless marked. Third-angle projection.</text>`,
      `<text x="10" y="288" font-size="2.8" font-family="sans-serif" fill="#444">Original drawing for the Wren certification-style suite; the named values drive the model.</text>`,
    ].join('\n');
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 297" width="420mm" height="297mm" data-part="${esc(i.id)}">`,
      `<title>${esc(`${i.id} ${i.title} - Wren reference part`)}</title>`,
      `<rect x="5" y="5" width="410" height="287" fill="#fff" stroke="#111" stroke-width="0.8"/>`,
      ...this.views.map((v) => v.svg()),
      ...block,
      note,
      `</svg>`,
      ``,
    ].join('\n');
  }
}
