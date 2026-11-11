import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drawingFont } from '../src/annotation';
import { OSIFONT_METRICS } from '../src/font';
import { closeGlyphs, parseTrueType, subsetTrueType } from '../src/pdf';

const FONT = new Uint8Array(readFileSync(join(__dirname, '../assets/fonts/osifont-lgpl3fe.ttf')));

describe('bundled font', () => {
  it('is the pinned Osifont file (checksum in osifont-NOTICE.txt)', () => {
    expect(createHash('sha256').update(FONT).digest('hex')).toBe(
      '81880ba0a1ba2e15752f5ec536f227a69bec98b73ae8200780804b66750320b6',
    );
  });
  it('generated metrics match the TTF (regenerate with `pnpm metrics`)', () => {
    const f = parseTrueType(FONT);
    expect(OSIFONT_METRICS.unitsPerEm).toBe(f.unitsPerEm);
    expect(OSIFONT_METRICS.capHeight).toBe(f.capHeight);
    const m = drawingFont();
    for (const [cp, gid] of f.cmap)
      expect(m.advance(cp), `U+${cp.toString(16)}`).toBe(f.advance(gid));
    expect(f.postScriptName).toBe('osifont');
  });
});

describe('TrueType subset', () => {
  const f = parseTrueType(FONT);
  const gidOf = (ch: string) => f.cmap.get(ch.codePointAt(0) ?? 0) ?? 0;

  it('keeps used glyphs, empties the rest and preserves glyph ids', () => {
    const used = [gidOf('B'), gidOf('1'), gidOf('Ø')];
    const sub = parseTrueType(subsetTrueType(f, used));
    expect(sub.numGlyphs).toBe(f.numGlyphs);
    const glyphLen = (font: typeof f, gid: number) => {
      const d = new DataView(font.data.buffer, font.data.byteOffset);
      const loca = font.tables.get('loca')!.offset;
      return font.longLoca
        ? d.getUint32(loca + 4 * (gid + 1)) - d.getUint32(loca + 4 * gid)
        : 2 * (d.getUint16(loca + 2 * (gid + 1)) - d.getUint16(loca + 2 * gid));
    };
    for (const g of used) expect(glyphLen(sub, g)).toBeGreaterThan(0);
    expect(glyphLen(sub, gidOf('Q'))).toBe(0);
    expect(sub.advance(gidOf('B'))).toBe(f.advance(gidOf('B')));
    expect(sub.tables.has('GPOS')).toBe(false);
    expect(sub.tables.has('name')).toBe(true);
    expect(sub.data.length).toBeLessThan(FONT.length / 2);
  });
  it('writes valid table checksums and the head checksum adjustment', () => {
    const bytes = subsetTrueType(f, [gidOf('A')]);
    const padded = new Uint8Array((bytes.length + 3) & ~3);
    padded.set(bytes);
    const d = new DataView(padded.buffer);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + d.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });
  it('closes over composite glyph components', () => {
    const all = closeGlyphs(f, [gidOf('Å'), gidOf('é')]);
    expect(all.has(0)).toBe(true);
    expect(all.size).toBeGreaterThanOrEqual(3);
  });
});
