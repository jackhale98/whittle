/**
 * The `drawing` section of every reference-part spec (PLAN section 12 M4 and 12A): its views and
 * dimensions are well-formed, and agree with the committed SVG drawing they were derived from.
 * The M4 E2E (apps/web/e2e/m4-reference-drawings.spec.ts) recreates the drawing from this section.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartSpec } from '../reference-parts/lib/spec';
import { validateDrawingSpec } from '../reference-parts/lib/validate';
import { PARTS } from '../reference-parts/parts';

const dir = fileURLToPath(new URL('../reference-parts/', import.meta.url));
const load = (id: string): PartSpec =>
  JSON.parse(readFileSync(`${dir}${id}.spec.json`, 'utf8')) as PartSpec;

describe('validateDrawingSpec', () => {
  const dims = { w: { value: 10, unit: 'mm' } };
  const view = { id: 'f', caption: 'Front', kind: 'base', orientation: 'front', axes: ['X', 'Z'] };
  const ok = {
    file: 'a.svg',
    projection: 'third',
    views: [view],
    dimensions: [
      {
        name: 'w',
        kind: 'linear',
        value: 10,
        unit: 'mm',
        view: 'f',
        axis: 'h',
        from: [0, 0],
        to: [10, 0],
      },
    ],
  };
  it('accepts a minimal drawing and names what is wrong with a broken one', () => {
    expect(validateDrawingSpec(ok, dims)).toEqual([]);
    const bad = validateDrawingSpec(
      {
        ...ok,
        views: [{ ...view, orientation: 'iso', axes: ['X', '-X'] }],
        dimensions: [
          { ...ok.dimensions[0], value: 11, view: 'nope', tolerance: { plus: -1, minus: 0 } },
        ],
      },
      dims,
    );
    expect(bad.join('\n')).toMatch(/orientation/);
    expect(bad.join('\n')).toMatch(/axes must differ/);
    expect(bad.join('\n')).toMatch(/drawn 11, the part says 10/);
    expect(bad.join('\n')).toMatch(/view nope is not in the drawing/);
    expect(bad.join('\n')).toMatch(/tolerance/);
    expect(validateDrawingSpec({ ...ok, dimensions: [] }, dims)).toContain(
      'driving dimension w is not on the drawing',
    );
  });
});

describe.each(PARTS)('reference part $id: drawing section', (part) => {
  const spec = load(part.id);
  const svg = readFileSync(`${dir}${part.id}.svg`, 'utf8');

  it('is valid against the schema', () => {
    expect(validateDrawingSpec(spec.drawing, spec.dimensions)).toEqual([]);
    expect(spec.drawing.file).toBe(`${part.id}.svg`);
  });

  it('agrees with the SVG: every dimension is in the view the spec says, with the printed value', () => {
    // The SVG groups each view as <g data-view="caption"> ... </g>.
    const groups = new Map<string, string>();
    for (const m of svg.matchAll(/<g data-view="([^"]*)">([\s\S]*?)<\/g>/g))
      groups.set((m[1] as string).replace(/&amp;/g, '&'), m[2] as string);
    expect([...groups.keys()].sort()).toEqual(spec.drawing.views.map((v) => v.caption).sort());
    let total = 0;
    for (const v of spec.drawing.views) {
      const body = groups.get(v.caption) ?? '';
      const inView = [...body.matchAll(/data-dim="([^"]+)" data-value="([^"]+)"/g)].map(
        (m) => [m[1], Number(m[2])] as const,
      );
      const listed = spec.drawing.dimensions.filter((d) => d.view === v.id);
      expect(
        listed.map((d) => [d.name, d.value]),
        `${v.caption}: dimensions`,
      ).toEqual(inView.map(([n, val]) => [n, val]));
      total += listed.length;
    }
    expect(total).toBe(spec.drawing.dimensions.length);
  });

  it('cuts sections across a real, non-degenerate line of a view that is not a section itself', () => {
    const byId = new Map(spec.drawing.views.map((v) => [v.id, v]));
    for (const v of spec.drawing.views.filter((x) => x.kind === 'section')) {
      expect(byId.get(v.parent as string)?.kind, `${v.id} parent`).not.toBe('section');
      const cut = v.section?.cut ?? [];
      const len = cut
        .slice(1)
        .reduce(
          (s, p, i) => s + Math.hypot(p[0] - (cut[i]?.[0] ?? 0), p[1] - (cut[i]?.[1] ?? 0)),
          0,
        );
      expect(len, `${v.id} cut length`).toBeGreaterThan(1);
    }
  });
});
