/**
 * PDF structure and true-scale measurement tests. The 1:1 print check (PLAN M4 accept) measures
 * the content stream: a 100 mm edge of the part at 1:1 must be 283.465 pt long, and the 100 mm
 * reference graduation too, with the MediaBox equal to the sheet and PrintScaling None.
 * When poppler's `pdfinfo`/`pdftotext` are installed, the file is also checked with them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PT_PER_MM, parseTrueType, renderPdf } from '../src/pdf';
import { bracketBuild } from './fixtures';

const FONT = new Uint8Array(readFileSync(join(__dirname, '../assets/fonts/osifont-lgpl3fe.ttf')));
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

function pdfFor(scale = '1/1', compress = false) {
  const build = bracketBuild({
    sheets: [
      { id: 'S1', name: 'Sheet 1', format: { size: 'A3', orientation: 'landscape' }, scale },
    ],
  });
  const sheet = build.sheets[0]!;
  const bytes = renderPdf([{ list: sheet.list, style: { lineGroup: 'iso-0.5' } }], {
    font: FONT,
    title: 'Bracket – BRK-001',
    compress,
  });
  return { bytes, text: latin1(bytes), build };
}

/** Objects by number, from the xref (validates every offset). */
function objects(text: string): Map<number, string> {
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
  expect(text.slice(start, start + 4)).toBe('xref');
  const xref = text.slice(start).split('\n');
  const [, count] = (xref[1] ?? '').split(' ').map(Number) as [number, number];
  const out = new Map<number, string>();
  for (let n = 1; n < count; n++) {
    const off = Number((xref[2 + n] ?? '').slice(0, 10));
    expect(text.slice(off).startsWith(`${n} 0 obj\n`), `object ${n} at ${off}`).toBe(true);
    const end = text.indexOf('\nendobj\n', off);
    out.set(n, text.slice(off, end));
  }
  return out;
}

function stream(obj: string): string {
  const i = obj.indexOf('stream\n') + 7;
  const j = obj.lastIndexOf('\nendstream');
  const raw = new Uint8Array(Array.from(obj.slice(i, j), (c) => c.charCodeAt(0)));
  return latin1(obj.includes('/FlateDecode') ? unzlibSync(raw) : raw);
}

/** Every straight segment `x0 y0 m x1 y1 l` in a content stream, in points. */
function segments(content: string): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const re = /(-?[\d.]+) (-?[\d.]+) m (-?[\d.]+) (-?[\d.]+) l S/g;
  for (const m of content.matchAll(re))
    out.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  return out;
}

const len = ([a, b, c, d]: [number, number, number, number]) => Math.hypot(c - a, d - b);

describe('PDF structure', () => {
  const { text } = pdfFor();
  const objs = objects(text);

  it('is PDF 1.7 with a valid xref, trailer and catalog', () => {
    expect(text.startsWith('%PDF-1.7\n')).toBe(true);
    expect(text).toMatch(
      /trailer\n<< \/Size \d+ \/Root 1 0 R \/Info 3 0 R \/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\] >>/,
    );
    expect(objs.get(1)).toContain('/Type /Catalog');
  });
  it('asks viewers to print at actual size (PrintScaling None, enforced)', () => {
    expect(objs.get(1)).toContain(
      '/ViewerPreferences << /PrintScaling /None /Enforce [/PrintScaling] >>',
    );
  });
  it('MediaBox = the sheet: A3 landscape is 1190.551 × 841.89 pt', () => {
    expect(420 * PT_PER_MM).toBeCloseTo(1190.551, 3);
    const page = [...objs.values()].find((o) => o.includes('/Type /Page '));
    expect(page).toContain('/MediaBox [0 0 1190.551 841.89]');
  });
  it('embeds a subset of the drawing font as CIDFontType2 with ToUnicode', () => {
    const type0 = objs.get(4)!;
    expect(type0).toMatch(/\/BaseFont \/[A-Z]{6}\+osifont \/Encoding \/Identity-H/);
    expect(objs.get(5)).toContain('/CIDToGIDMap /Identity');
    const file = objs.get(7)!;
    const length1 = Number(/\/Length1 (\d+)/.exec(file)?.[1]);
    expect(length1).toBeGreaterThan(1000);
    expect(length1).toBeLessThan(FONT.length);
    const sub = parseTrueType(new Uint8Array(Array.from(stream(file), (c) => c.charCodeAt(0))));
    expect(sub.unitsPerEm).toBe(2048);
    expect(stream(objs.get(8)!)).toContain('beginbfchar');
  });
  it('is deterministic (re-exports byte for byte)', () => {
    expect(pdfFor().text).toBe(text);
    expect(pdfFor('1/1', true).text).toBe(pdfFor('1/1', true).text);
  });
});

describe('true scale (measured)', () => {
  it('100 mm = 283.465 pt: the reference graduation', () => {
    const { text } = pdfFor();
    const content = stream([...objects(text).values()].find((o) => o.startsWith(`${10} 0 obj`))!);
    const grad = segments(content).filter(
      (s) => Math.abs(s[0] - 6 * PT_PER_MM) < 1e-3 && s[0] === s[2],
    );
    const bar = grad.find((s) => Math.abs(len(s) - 283.465) < 1e-3);
    expect(bar).toBeDefined();
  });
  it('a 100 mm edge at 1:1 prints 283.465 pt; at 1:2 it prints 141.732 pt', () => {
    for (const [scale, expected] of [
      ['1/1', 283.465],
      ['1/2', 141.732],
    ] as const) {
      const { text } = pdfFor(scale);
      const content = stream([...objects(text).values()].find((o) => o.startsWith(`${10} 0 obj`))!);
      // Visible edges are drawn with the thick width (0.5 mm = 1.417 pt) of the line group.
      const thick = content.split('\n1.417 w\n')[1]?.split(/\n[\d.]+ w\n/)[0] ?? '';
      const horizontal = segments(thick).filter((s) => Math.abs(s[1] - s[3]) < 1e-6);
      expect(
        horizontal.some((s) => Math.abs(len(s) - expected) < 1e-3),
        scale,
      ).toBe(true);
    }
  });
  it('writes ISO 128 line widths in points: 0.35 mm = 0.992 pt', () => {
    const build = bracketBuild();
    const bytes = renderPdf([{ list: build.sheets[0]!.list, style: { lineGroup: 'iso-0.35' } }], {
      font: FONT,
      compress: false,
    });
    const content = latin1(bytes);
    expect(content).toContain('\n0.992 w\n');
    expect(content).toContain('\n0.51 w\n'); // thin 0.18 mm
    expect(content).toContain('\n1.984 w\n'); // the 0.7 mm frame
    expect(content).toContain('[12.246 1.531 0.255 1.531] 0 d'); // centre: 24d/3d/0.5d/3d, d = 0.18 mm
  });
});

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!has('pdfinfo'))('poppler check (when installed)', () => {
  it('pdfinfo reads the page size and pdftotext finds the title block text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wren-pdf-'));
    try {
      const f = join(dir, 'bracket.pdf');
      writeFileSync(f, pdfFor('1/1', true).bytes);
      const info = execFileSync('pdfinfo', [f], { encoding: 'utf8' });
      expect(info).toMatch(/Page size:\s+1190.55 x 841.89 pts/);
      expect(info).toMatch(/PDF version:\s+1.7/);
      const txt = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' });
      expect(txt).toContain('BRK-001');
      expect(txt).toContain('Bracket');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
