/**
 * Text metrics for layout, from the bundled font's advance widths (no font file, no DOM). Text
 * height h is the ISO 3098 nominal height (cap height); the font size every renderer uses is
 * `fontSizeFor(h)`. Kerning is never applied, so SVG, PDF and DXF place text identically.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { OSIFONT_METRICS } from '../font/osifont-metrics';

export interface FontMetrics {
  family: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  capHeight: number;
  missingAdvance: number;
  advance(codePoint: number): number;
  has(codePoint: number): boolean;
}

function fromRuns(m: typeof OSIFONT_METRICS): FontMetrics {
  const table = new Map<number, number>();
  for (const run of m.runs) {
    const first = run[0] ?? 0;
    for (let i = 1; i < run.length; i++) table.set(first + i - 1, run[i] ?? 0);
  }
  return {
    family: m.family,
    unitsPerEm: m.unitsPerEm,
    ascender: m.ascender,
    descender: m.descender,
    capHeight: m.capHeight,
    missingAdvance: m.missingAdvance,
    advance: (cp) => table.get(cp) ?? m.missingAdvance,
    has: (cp) => table.has(cp),
  };
}

let osifont: FontMetrics | undefined;

/** Metrics of the bundled drawing font (Osifont, ADR-091). */
export function drawingFont(): FontMetrics {
  osifont ??= fromRuns(OSIFONT_METRICS);
  return osifont;
}

/** Font size (em, sheet mm) for ISO 3098 text height `h` (cap height). */
export function fontSizeFor(h: number, font: FontMetrics = drawingFont()): number {
  return (h * font.unitsPerEm) / font.capHeight;
}

/** Width of one line of text at height `h`, sheet mm. */
export function textWidth(text: string, h: number, font: FontMetrics = drawingFont()): number {
  let units = 0;
  for (const ch of text) units += font.advance(ch.codePointAt(0) ?? 0);
  return (units * h) / font.capHeight;
}

/** Characters the font lacks, replaced before layout so every renderer shows the same thing. */
const SUBSTITUTES: Record<string, string> = {
  '−': '-',
  '′': "'",
  '″': '"',
  ' ': ' ',
};

export function normalizeText(text: string, font: FontMetrics = drawingFont()): string {
  let out = '';
  for (const ch of text) {
    const sub = SUBSTITUTES[ch];
    out += sub !== undefined && !font.has(ch.codePointAt(0) ?? 0) ? sub : ch;
  }
  return out;
}
