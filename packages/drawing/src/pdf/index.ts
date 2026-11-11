/**
 * `@wren-cad/drawing/pdf`: vector PDF 1.7 at true scale (owner D7), written in-house (no
 * dependency beyond fflate for Flate streams).
 *
 *  - One page per sheet; the MediaBox is the sheet, in points.
 *  - mm → pt happens once, when numbers are written (`× 72 / 25.4`): 100 mm = 283.465 pt, and a
 *    0.35 mm line is `0.992 w`.
 *  - Line widths per role from the ISO 128 line group (one mapping with SVG and DXF); ISO 128-2
 *    dash patterns.
 *  - `/ViewerPreferences << /PrintScaling /None /Enforce [/PrintScaling] >>`, so printing at
 *    "actual size" is the default and the 100 mm reference graduation measures 100 mm.
 *  - Text in the drawing font (Osifont), subset-embedded as a CIDFontType2 (Identity-H, glyph
 *    ids preserved, ToUnicode for copy and search); positions from the same metrics as layout.
 *  - Arcs and ellipses are Bézier curves; splines are flattened to 2 µm.
 *  - Deterministic: no timestamp unless given, subset tag and file ID derived from the content,
 *    so a released drawing re-exports byte for byte.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle } from '@wren-cad/contracts';
import { zlibSync } from 'fflate';
import type { DisplayItem, DisplayList } from '../annotation/display';
import { flattenBSpline } from '../annotation/flatten';
import { roleStroke } from '../annotation/strokes';
import { textWidth } from '../annotation/text';
import { parseTrueType, subsetTrueType, type TrueTypeFont } from './ttf';

export { closeGlyphs, parseTrueType, subsetTrueType, type TrueTypeFont } from './ttf';

/** Points per millimetre: the only unit conversion in the writer. */
export const PT_PER_MM = 72 / 25.4;

export type Rgb = [number, number, number];

export interface PdfSheet {
  list: DisplayList;
  style: Pick<DrawingStyle, 'lineGroup' | 'lineWidths'>;
}

export interface PdfOptions {
  /** The drawing font's TTF bytes (`loadDrawingFont`). */
  font: Uint8Array;
  title?: string;
  /** ISO-8601; absent = no date (reproducible output). */
  creationDate?: string;
  /** Flate-compress streams (default true). */
  compress?: boolean;
  ink?: Rgb;
  attention?: Rgb;
}

const num = (x: number) => {
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) || v === 0 ? '0' : String(v);
};
const P = (mm: number) => num(mm * PT_PER_MM);

/** Cubic Bézier control points for a circular or elliptic arc, ≤ 90° per segment. */
function arcBeziers(
  c: [number, number],
  ux: [number, number],
  uy: [number, number],
  a: number,
  b: number,
  t0: number,
  t1: number,
): { start: [number, number]; curves: [number, number][][] } {
  const at = (t: number): [number, number] => [
    c[0] + a * Math.cos(t) * ux[0] + b * Math.sin(t) * uy[0],
    c[1] + a * Math.cos(t) * ux[1] + b * Math.sin(t) * uy[1],
  ];
  const der = (t: number): [number, number] => [
    -a * Math.sin(t) * ux[0] + b * Math.cos(t) * uy[0],
    -a * Math.sin(t) * ux[1] + b * Math.cos(t) * uy[1],
  ];
  const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 2) - 1e-9));
  const step = (t1 - t0) / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const curves: [number, number][][] = [];
  for (let i = 0; i < n; i++) {
    const s = t0 + i * step;
    const e = s + step;
    const p0 = at(s);
    const p3 = at(e);
    const d0 = der(s);
    const d3 = der(e);
    curves.push([
      [p0[0] + k * d0[0], p0[1] + k * d0[1]],
      [p3[0] - k * d3[0], p3[1] - k * d3[1]],
      p3,
    ]);
  }
  return { start: at(t0), curves };
}

interface FontUse {
  font: TrueTypeFont;
  /** gid → first code point seen (ToUnicode). */
  used: Map<number, number>;
}

function textOps(item: Extract<DisplayItem, { kind: 'text' }>, fu: FontUse): string {
  const f = fu.font;
  const size = (item.height * f.unitsPerEm) / (f.capHeight || f.unitsPerEm * 0.7);
  let hex = '';
  for (const ch of item.text) {
    const cp = ch.codePointAt(0) ?? 0;
    const gid = f.cmap.get(cp) ?? 0;
    if (!fu.used.has(gid)) fu.used.set(gid, cp);
    hex += gid.toString(16).padStart(4, '0');
  }
  const w = textWidth(item.text, item.height);
  const dx = item.align === 'left' ? 0 : item.align === 'center' ? -w / 2 : -w;
  const dy =
    item.baseline === 'middle' ? -item.height / 2 : item.baseline === 'top' ? -item.height : 0;
  const a = (item.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = item.at[0] + dx * c - dy * s;
  const y = item.at[1] + dx * s + dy * c;
  return `BT /F1 ${P(size)} Tf ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${P(x)} ${P(y)} Tm <${hex}> Tj ET`;
}

function pathOps(item: Exclude<DisplayItem, { kind: 'text' }>): string {
  const pt = (p: readonly [number, number]) => `${P(p[0])} ${P(p[1])}`;
  switch (item.kind) {
    case 'line':
      return `${pt(item.a)} m ${pt(item.b)} l`;
    case 'polyline': {
      const [first, ...rest] = item.points;
      if (!first) return '';
      return `${pt(first)} m ${rest.map((p) => `${pt(p)} l`).join(' ')}${item.closed ? ' h' : ''}`;
    }
    case 'arc':
    case 'ellipse': {
      const isArc = item.kind === 'arc';
      const a = isArc ? item.radius : Math.hypot(item.major[0], item.major[1]);
      const ux: [number, number] = isArc ? [1, 0] : [item.major[0] / a, item.major[1] / a];
      const uy: [number, number] = [-ux[1], ux[0]];
      const b = isArc ? item.radius : a * item.ratio;
      const bz = arcBeziers(item.center, ux, uy, a, b, item.start, item.end);
      return `${pt(bz.start)} m ${bz.curves.map((c) => `${c.map(pt).join(' ')} c`).join(' ')}`;
    }
    case 'spline': {
      const pts = flattenBSpline(item.degree, item.poles, item.knots, 0.002, item.weights);
      const [first, ...rest] = pts;
      return first ? `${pt(first)} m ${rest.map((p) => `${pt(p)} l`).join(' ')}` : '';
    }
    case 'fill':
      return item.loops
        .map((l) => {
          const [first, ...rest] = l;
          return first ? `${pt(first)} m ${rest.map((p) => `${pt(p)} l`).join(' ')} h` : '';
        })
        .join(' ');
  }
}

/** The page content stream for one sheet. */
export function pageContent(sheet: PdfSheet, fu: FontUse, ink: Rgb, attention: Rgb): string {
  const out: string[] = ['1 j 0 J'];
  let lw = '';
  let dash = '';
  let stroke = '';
  let fill = '';
  const color = (c: Rgb) => c.map(num).join(' ');
  for (const item of sheet.list.items) {
    const c = color(item.attention ? attention : ink);
    if (item.kind === 'text' || item.kind === 'fill') {
      if (fill !== c) {
        out.push(`${c} rg`);
        fill = c;
      }
      out.push(item.kind === 'text' ? textOps(item, fu) : `${pathOps(item)} f*`);
      continue;
    }
    const s = roleStroke(item.role, sheet.style);
    const w = P(s.width);
    if (w !== lw) {
      out.push(`${w} w`);
      lw = w;
    }
    const pattern = s.dash.length ? s.dash : item.attention ? [1, 0.6] : [];
    const d = `[${pattern.map(P).join(' ')}] 0 d`;
    if (d !== dash) {
      out.push(d);
      dash = d;
    }
    if (stroke !== c) {
      out.push(`${c} RG`);
      stroke = c;
    }
    const ops = pathOps(item);
    if (ops) out.push(`${ops} S`);
  }
  return out.join('\n');
}

const latin1 = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

/** PDF text string: ASCII as a literal, anything else UTF-16BE hex with a BOM. */
function pdfString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (m) => `\\${m}`)})`;
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex.toUpperCase()}>`;
}

/** 64-bit FNV-1a, twice with different seeds: a deterministic 128-bit content id. */
function fnv(bytes: Uint8Array, seed: bigint): string {
  let h = seed;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

function subsetTag(gids: number[]): string {
  const bytes = latin1(gids.join(','));
  const h = fnv(bytes, 0xcbf29ce484222325n);
  let tag = '';
  for (let i = 0; i < 6; i++)
    tag += String.fromCharCode(65 + (Number.parseInt(h.slice(2 * i, 2 * i + 2), 16) % 26));
  return tag;
}

function toUnicode(used: Map<number, number>): string {
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [gid, cp] of chunk) {
      const u =
        cp > 0xffff
          ? String.fromCodePoint(cp)
              .split('')
              .map((c) => c.charCodeAt(0).toString(16).padStart(4, '0'))
              .join('')
          : cp.toString(16).padStart(4, '0');
      lines.push(`<${gid.toString(16).padStart(4, '0')}> <${u}>`);
    }
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

/** Writes the PDF. */
export function renderPdf(sheets: readonly PdfSheet[], options: PdfOptions): Uint8Array {
  if (sheets.length === 0) throw new Error('A PDF needs at least one sheet');
  const compress = options.compress ?? true;
  const ink = options.ink ?? [0, 0, 0];
  const attention = options.attention ?? [0.816, 0.204, 0.173];
  const font = parseTrueType(options.font);
  const fu: FontUse = { font, used: new Map([[0, 0]]) };
  const contents = sheets.map((s) => pageContent(s, fu, ink, attention));

  // Object numbering: 1 catalog, 2 pages, 3 info, 4 Type0, 5 CIDFont, 6 descriptor, 7 font file,
  // 8 ToUnicode, then per page: page, content.
  const objects: (Uint8Array | string)[] = [];
  const set = (n: number, body: Uint8Array | string) => {
    objects[n] = body;
  };
  const stream = (dict: string, data: Uint8Array, extra = ''): Uint8Array => {
    const body = compress ? zlibSync(data, { level: 9 }) : data;
    const head = latin1(
      `<< /Length ${body.length}${compress ? ' /Filter /FlateDecode' : ''}${extra}${dict ? ` ${dict}` : ''} >>\nstream\n`,
    );
    const tail = latin1('\nendstream');
    const out = new Uint8Array(head.length + body.length + tail.length);
    out.set(head);
    out.set(body, head.length);
    out.set(tail, head.length + body.length);
    return out;
  };

  const gids = [...fu.used.keys()].sort((a, b) => a - b);
  const tag = subsetTag(gids);
  const baseFont = `${tag}+${font.postScriptName}`;
  const scale = 1000 / font.unitsPerEm;
  const sub = subsetTrueType(font, gids);
  const widths = gids.map((g) => `${g} [${Math.round(font.advance(g) * scale)}]`).join(' ');
  const pageBase = 9;
  const kids = sheets.map((_, i) => `${pageBase + 2 * i} 0 R`).join(' ');

  set(
    1,
    '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None /Enforce [/PrintScaling] >> >>',
  );
  set(2, `<< /Type /Pages /Kids [${kids}] /Count ${sheets.length} >>`);
  const info = [`/Producer ${pdfString('Wren')}`];
  if (options.title) info.push(`/Title ${pdfString(options.title)}`);
  if (options.creationDate) {
    const d = options.creationDate
      .replace(/[-:]/g, '')
      .replace('T', '')
      .replace(/\..*$/, '')
      .replace(/Z$/, '');
    info.push(`/CreationDate (D:${d.slice(0, 14)}Z)`);
  }
  set(3, `<< ${info.join(' ')} >>`);
  set(
    4,
    `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 8 0 R >>`,
  );
  set(
    5,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW ${Math.round(font.advance(0) * scale)} /W [${widths}] /CIDToGIDMap /Identity >>`,
  );
  const [x0, y0, x1, y1] = font.bbox.map((v) => Math.round(v * scale));
  set(
    6,
    `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 4 /FontBBox [${x0} ${y0} ${x1} ${y1}] /ItalicAngle 0 /Ascent ${Math.round(font.ascender * scale)} /Descent ${Math.round(font.descender * scale)} /CapHeight ${Math.round(font.capHeight * scale)} /StemV 80 /FontFile2 7 0 R >>`,
  );
  set(7, stream('', sub, ` /Length1 ${sub.length}`));
  set(8, stream('', latin1(toUnicode(fu.used))));
  sheets.forEach((s, i) => {
    const page = pageBase + 2 * i;
    set(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${P(s.list.width)} ${P(s.list.height)}] /Resources << /Font << /F1 4 0 R >> >> /Contents ${page + 1} 0 R >>`,
    );
    set(page + 1, stream('', latin1(contents[i] ?? '')));
  });

  // Serialise with an exact xref.
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array) => {
    chunks.push(b);
    length += b.length;
  };
  push(latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'));
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    const body = objects[n];
    if (body === undefined) continue;
    offsets[n] = length;
    push(latin1(`${n} 0 obj\n`));
    push(typeof body === 'string' ? latin1(body) : body);
    push(latin1('\nendobj\n'));
  }
  const xrefAt = length;
  const count = objects.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  const all = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const id = fnv(all, 0xcbf29ce484222325n) + fnv(all, 0x84222325cbf29ce4n);
  push(
    latin1(
      `${xref}trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    ),
  );
  const out = new Uint8Array(length);
  o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
