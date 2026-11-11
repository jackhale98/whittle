/**
 * Shared DXF pieces: the tag writer, number and text encoding, layers per line role, and ISO
 * 128-2 line types in absolute mm (`$LTSCALE = 1`).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle } from '@wren-cad/contracts';
import type { DisplayItem, StrokeRole } from '../annotation/display';
import { dashPattern, lineWidths, roleStroke } from '../annotation/strokes';

/** Group code / value pairs, one per line each, CRLF-free (LF), as LibreCAD and ezdxf read them. */
export class DxfTags {
  private lines: string[] = [];
  push(code: number, value: string | number): this {
    let v: string;
    if (typeof value === 'string') v = value;
    else if (isFloatCode(code)) v = dxfFloat(value);
    else v = String(Math.round(value));
    this.lines.push(String(code).padStart(3, ' '), v);
    return this;
  }
  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/** Group codes whose values are doubles (written with a decimal point for strict readers). */
export function isFloatCode(code: number): boolean {
  return (
    (code >= 10 && code <= 59) ||
    (code >= 110 && code <= 149) ||
    (code >= 210 && code <= 239) ||
    (code >= 460 && code <= 469) ||
    (code >= 1010 && code <= 1059)
  );
}

/** A double: like `dxfNum`, always with a decimal point (`10.0`). */
export function dxfFloat(x: number): string {
  const s = dxfNum(x);
  return s.includes('.') ? s : `${s}.0`;
}

/** Fixed-point, at most 6 decimals, no exponent, no `-0`. */
export function dxfNum(x: number): string {
  if (Number.isInteger(x)) return String(x);
  const v = Math.round(x * 1e6) / 1e6;
  if (v === 0) return '0.0';
  let s = v.toFixed(6).replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  return s;
}

/**
 * DXF text: `%%c` Ø, `%%d` °, `%%p` ±; other non-ASCII as `\U+XXXX` (read by AutoCAD, LibreCAD,
 * QCAD and ezdxf alike).
 */
export function dxfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === 'Ø' || ch === '⌀') out += '%%c';
    else if (ch === '°') out += '%%d';
    else if (ch === '±') out += '%%p';
    else if (ch === '%') out += '%';
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp <= 0xffff) out += `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += '?';
  }
  return out;
}

export interface DxfLayer {
  name: string;
  /** ACI colour. */
  color: number;
  linetype: string;
  /** Lineweight in 1/100 mm (R2000). */
  lineweight: number;
}

export const ROLE_LAYERS: Readonly<Record<StrokeRole, string>> = {
  visible: 'VISIBLE',
  hidden: 'HIDDEN',
  tangent: 'TANGENT',
  center: 'CENTER',
  dimension: 'DIMENSION',
  hatch: 'HATCH',
  cuttingPlane: 'CUTTING_PLANE',
  cuttingPlaneEnd: 'CUTTING_PLANE',
  frame: 'FRAME',
  thin: 'FRAME_THIN',
  text: 'TEXT',
};

/** Valid DXF lineweights (1/100 mm). */
const LINEWEIGHTS = [
  0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200,
  211,
];

export function lineweight(mm: number): number {
  const v = Math.round(mm * 100);
  return LINEWEIGHTS.reduce((best, w) => (Math.abs(w - v) < Math.abs(best - v) ? w : best), 0);
}

const LAYER_COLORS: Record<string, number> = {
  VISIBLE: 7,
  HIDDEN: 8,
  TANGENT: 8,
  CENTER: 4,
  DIMENSION: 3,
  HATCH: 8,
  CUTTING_PLANE: 1,
  FRAME: 7,
  FRAME_THIN: 7,
  TEXT: 7,
};

/** One layer per role (the cutting plane's thick ends share its layer with an entity lineweight). */
export function layersFor(style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>): DxfLayer[] {
  const seen = new Map<string, DxfLayer>();
  for (const [role, name] of Object.entries(ROLE_LAYERS) as [StrokeRole, string][]) {
    if (seen.has(name)) continue;
    const s = roleStroke(role, style);
    seen.set(name, {
      name,
      color: LAYER_COLORS[name] ?? 7,
      linetype:
        s.type === 'dashed' ? 'DASHED_ISO' : s.type === 'center' ? 'CENTER_ISO' : 'CONTINUOUS',
      lineweight: lineweight(s.width),
    });
  }
  return [...seen.values()];
}

export interface DxfLinetype {
  name: string;
  description: string;
  /** Pattern elements, mm: dash > 0, gap < 0, dot 0. */
  pattern: number[];
}

/** ISO 128-2 dashed and long-dash dot at the thin line width (dash lengths in multiples of d). */
export function linetypesFor(style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>): DxfLinetype[] {
  const d = lineWidths(style).thin;
  const signed = (p: number[]) => p.map((x, i) => (i % 2 === 0 ? x : -x));
  return [
    {
      name: 'DASHED_ISO',
      description: 'ISO 128 dashed __ __ __',
      pattern: signed(dashPattern('dashed', d)),
    },
    {
      name: 'CENTER_ISO',
      description: 'ISO 128 long-dash dot ____ . ____',
      pattern: signed(dashPattern('center', d)),
    },
  ];
}

/** Entity-level lineweight override where the role differs from its layer (cutting-plane ends). */
export function entityLineweight(
  item: DisplayItem,
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>,
): number | undefined {
  return item.role === 'cuttingPlaneEnd'
    ? lineweight(roleStroke(item.role, style).width)
    : undefined;
}

/** Text alignment codes (72 horizontal, 73 vertical). */
export function textAlign(item: Extract<DisplayItem, { kind: 'text' }>): { h: number; v: number } {
  const h = item.align === 'left' ? 0 : item.align === 'center' ? 1 : 2;
  const v = item.baseline === 'baseline' ? 0 : item.baseline === 'middle' ? 2 : 3;
  return { h, v };
}

/** Degrees in [0, 360) for ARC angles. */
export function deg(rad: number): number {
  const d = (rad * 180) / Math.PI;
  const m = ((d % 360) + 360) % 360;
  return Math.abs(m - 360) < 1e-9 ? 0 : m;
}

/** Fan triangulation of a convex-ish loop (arrowheads, dots) for SOLID entities. */
export function fanTriangles(loop: readonly (readonly [number, number])[]): [number, number][][] {
  const out: [number, number][][] = [];
  const p0 = loop[0];
  if (!p0) return out;
  for (let i = 1; i + 1 < loop.length; i++) {
    const a = loop[i] as [number, number];
    const b = loop[i + 1] as [number, number];
    out.push([[p0[0], p0[1]], a, b]);
  }
  return out;
}
