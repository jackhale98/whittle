/**
 * Minimal TrueType reader and glyph subsetter for PDF embedding (no dependency). The subset keeps
 * glyph ids (unused glyphs become empty), so the PDF uses `/CIDToGIDMap /Identity` with 2-byte
 * glyph ids. Composite glyphs pull in their components. Kept tables: head, hhea, maxp, hmtx,
 * loca, glyf, cmap, name (it carries the licence and font exception), OS/2, post (format 3),
 * and cvt / fpgm / prep when present. Layout tables (GSUB, GPOS, GDEF) are dropped: the PDF
 * places glyphs by advance and never shapes.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface TrueTypeFont {
  data: Uint8Array;
  tables: Map<string, { offset: number; length: number }>;
  unitsPerEm: number;
  bbox: [number, number, number, number];
  ascender: number;
  descender: number;
  capHeight: number;
  numGlyphs: number;
  longLoca: boolean;
  /** Code point → glyph id. */
  cmap: Map<number, number>;
  advance(gid: number): number;
  postScriptName: string;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function parseTrueType(data: Uint8Array): TrueTypeFont {
  const d = view(data);
  const tag4 = (o: number) =>
    String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
  const version = d.getUint32(0);
  if (version !== 0x00010000 && tag4(0) !== 'true')
    throw new Error('Not a TrueType font (glyf outlines required)');
  const tables = new Map<string, { offset: number; length: number }>();
  const n = d.getUint16(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    tables.set(tag4(o), { offset: d.getUint32(o + 8), length: d.getUint32(o + 12) });
  }
  const t = (tag: string) => {
    const x = tables.get(tag);
    if (!x) throw new Error(`Font has no ${tag} table`);
    return x.offset;
  };
  const head = t('head');
  const hhea = t('hhea');
  const maxp = t('maxp');
  const hmtx = t('hmtx');
  const numberOfHMetrics = d.getUint16(hhea + 34);
  const cmap = new Map<number, number>();
  const cm = t('cmap');
  const nSub = d.getUint16(cm + 2);
  let f4 = -1;
  let f12 = -1;
  for (let i = 0; i < nSub; i++) {
    const p = d.getUint16(cm + 4 + 8 * i);
    const e = d.getUint16(cm + 6 + 8 * i);
    const off = cm + d.getUint32(cm + 8 + 8 * i);
    const fmt = d.getUint16(off);
    if (p === 3 && e === 10 && fmt === 12) f12 = off;
    if (p === 3 && e === 1 && fmt === 4) f4 = off;
  }
  if (f12 >= 0) {
    const groups = d.getUint32(f12 + 12);
    for (let i = 0; i < groups; i++) {
      const g = f12 + 16 + 12 * i;
      const s = d.getUint32(g);
      const e = d.getUint32(g + 4);
      const gid = d.getUint32(g + 8);
      for (let c = s; c <= e; c++) cmap.set(c, gid + c - s);
    }
  } else if (f4 >= 0) {
    const segX2 = d.getUint16(f4 + 6);
    const ends = f4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = d.getUint16(ends + 2 * s);
      const start = d.getUint16(starts + 2 * s);
      const delta = d.getInt16(deltas + 2 * s);
      const ro = d.getUint16(ranges + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let gid = 0;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          gid = d.getUint16(ranges + 2 * s + ro + 2 * (c - start));
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0) cmap.set(c, gid);
      }
    }
  }
  let capHeight = 0;
  const os2 = tables.get('OS/2');
  if (os2 && d.getUint16(os2.offset) >= 2) capHeight = d.getInt16(os2.offset + 88);
  let postScriptName = 'Font';
  const name = tables.get('name');
  if (name) {
    const count = d.getUint16(name.offset + 2);
    const so = name.offset + d.getUint16(name.offset + 4);
    for (let i = 0; i < count; i++) {
      const r = name.offset + 6 + 12 * i;
      if (d.getUint16(r + 6) !== 6) continue;
      const pid = d.getUint16(r);
      const len = d.getUint16(r + 8);
      const off = so + d.getUint16(r + 10);
      let s = '';
      if (pid === 3 || pid === 0)
        for (let k = 0; k < len; k += 2) s += String.fromCharCode(d.getUint16(off + k));
      else for (let k = 0; k < len; k++) s += String.fromCharCode(d.getUint8(off + k));
      if (s) {
        postScriptName = s.replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, '');
        break;
      }
    }
  }
  return {
    data,
    tables,
    unitsPerEm: d.getUint16(head + 18),
    bbox: [
      d.getInt16(head + 36),
      d.getInt16(head + 38),
      d.getInt16(head + 40),
      d.getInt16(head + 42),
    ],
    ascender: d.getInt16(hhea + 4),
    descender: d.getInt16(hhea + 6),
    capHeight,
    numGlyphs: d.getUint16(maxp + 4),
    longLoca: d.getInt16(head + 50) === 1,
    cmap,
    advance: (gid) => d.getUint16(hmtx + 4 * Math.min(gid, numberOfHMetrics - 1)),
    postScriptName,
  };
}

function glyphRange(f: TrueTypeFont, gid: number): [number, number] {
  const d = view(f.data);
  const loca = f.tables.get('loca')?.offset ?? 0;
  const a = f.longLoca ? d.getUint32(loca + 4 * gid) : 2 * d.getUint16(loca + 2 * gid);
  const b = f.longLoca ? d.getUint32(loca + 4 * (gid + 1)) : 2 * d.getUint16(loca + 2 * (gid + 1));
  return [a, b];
}

/** Glyph ids a composite glyph refers to. */
function components(f: TrueTypeFont, gid: number): number[] {
  const d = view(f.data);
  const glyf = f.tables.get('glyf')?.offset ?? 0;
  const [a, b] = glyphRange(f, gid);
  if (b <= a) return [];
  let p = glyf + a;
  if (d.getInt16(p) >= 0) return [];
  p += 10;
  const out: number[] = [];
  for (;;) {
    const flags = d.getUint16(p);
    out.push(d.getUint16(p + 2));
    p += 4;
    p += flags & 0x0001 ? 4 : 2; // ARG_1_AND_2_ARE_WORDS
    if (flags & 0x0008)
      p += 2; // WE_HAVE_A_SCALE
    else if (flags & 0x0040)
      p += 4; // X_AND_Y_SCALE
    else if (flags & 0x0080) p += 8; // TWO_BY_TWO
    if (!(flags & 0x0020)) break; // MORE_COMPONENTS
  }
  return out;
}

/** The used glyph set closed over composite components (always with glyph 0). */
export function closeGlyphs(f: TrueTypeFont, gids: Iterable<number>): Set<number> {
  const keep = new Set<number>([0]);
  const stack = [...gids];
  while (stack.length) {
    const g = stack.pop() as number;
    if (g >= f.numGlyphs || keep.has(g)) continue;
    keep.add(g);
    stack.push(...components(f, g));
  }
  return keep;
}

function checksum(bytes: Uint8Array): number {
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  const d = view(padded);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + d.getUint32(i)) >>> 0;
  return sum;
}

/** A gid-preserving subset of the font with only `gids` (and their components) kept. */
export function subsetTrueType(f: TrueTypeFont, gids: Iterable<number>): Uint8Array {
  const keep = closeGlyphs(f, gids);
  const src = f.data;
  const glyfOff = f.tables.get('glyf')?.offset ?? 0;
  // glyf + long loca.
  const parts: Uint8Array[] = [];
  const loca = new Uint8Array(4 * (f.numGlyphs + 1));
  const ld = view(loca);
  let pos = 0;
  for (let g = 0; g < f.numGlyphs; g++) {
    ld.setUint32(4 * g, pos);
    if (!keep.has(g)) continue;
    const [a, b] = glyphRange(f, g);
    if (b <= a) continue;
    const len = (b - a + 3) & ~3;
    const chunk = new Uint8Array(len);
    chunk.set(src.subarray(glyfOff + a, glyfOff + b));
    parts.push(chunk);
    pos += len;
  }
  ld.setUint32(4 * f.numGlyphs, pos);
  const glyf = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    glyf.set(p, o);
    o += p.length;
  }
  const copy = (tag: string) => {
    const t = f.tables.get(tag);
    return t ? src.slice(t.offset, t.offset + t.length) : undefined;
  };
  const head = copy('head') as Uint8Array;
  view(head).setUint32(8, 0); // checkSumAdjustment, set below
  view(head).setInt16(50, 1); // long loca
  const post = new Uint8Array(32);
  const srcPost = copy('post');
  if (srcPost) post.set(srcPost.subarray(0, 32));
  view(post).setUint32(0, 0x00030000); // format 3: no glyph names
  const tables: [string, Uint8Array][] = [];
  const add = (tag: string, bytes: Uint8Array | undefined) => {
    if (bytes) tables.push([tag, bytes]);
  };
  add('OS/2', copy('OS/2'));
  add('cmap', copy('cmap'));
  add('cvt ', copy('cvt '));
  add('fpgm', copy('fpgm'));
  add('glyf', glyf);
  add('head', head);
  add('hhea', copy('hhea'));
  add('hmtx', copy('hmtx'));
  add('loca', loca);
  add('maxp', copy('maxp'));
  add('name', copy('name'));
  add('post', post);
  add('prep', copy('prep'));
  tables.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const n = tables.length;
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  const searchRange = (1 << es) * 16;
  const headerLen = 12 + 16 * n;
  let total = headerLen;
  for (const [, b] of tables) total += (b.length + 3) & ~3;
  const out = new Uint8Array(total);
  const d = view(out);
  d.setUint32(0, 0x00010000);
  d.setUint16(4, n);
  d.setUint16(6, searchRange);
  d.setUint16(8, es);
  d.setUint16(10, n * 16 - searchRange);
  let off = headerLen;
  let headAt = 0;
  tables.forEach(([tag, b], i) => {
    const r = 12 + 16 * i;
    for (let k = 0; k < 4; k++) d.setUint8(r + k, tag.charCodeAt(k));
    d.setUint32(r + 4, checksum(b));
    d.setUint32(r + 8, off);
    d.setUint32(r + 12, b.length);
    out.set(b, off);
    if (tag === 'head') headAt = off;
    off += (b.length + 3) & ~3;
  });
  view(out).setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}
