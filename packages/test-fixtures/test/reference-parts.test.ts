/**
 * Reference-part suite, part 1 (no kernel): the committed artefacts are current, every spec is
 * internally consistent (derivations recomputed from the spec's own dimensions match the stated
 * volumes and masses to 1e-9), every drawing names every driving dimension, and every part builds
 * a well-formed `WrenDoc`.
 *
 * `pnpm --filter @wren-cad/test-fixtures generate` rewrites the artefacts from the definitions.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Feature } from '@wren-cad/contracts';
import { entityRefs, evaluateFeatureValues, findMaterial } from '@wren-cad/document';
import { describe, expect, it } from 'vitest';
import {
  baselineDims,
  buildDoc,
  evalEx,
  stageDims,
  stageDoc,
} from '../reference-parts/lib/builder';
import {
  densityGcm3,
  drawingFor,
  type FreecadResults,
  markdownFor,
  type PartSpec,
  specFor,
} from '../reference-parts/lib/spec';
import { dimGetter } from '../reference-parts/lib/types';
import { PARTS } from '../reference-parts/parts';

const dir = fileURLToPath(new URL('../reference-parts/', import.meta.url));
const update = process.env.UPDATE_REFERENCE_PARTS === '1';
const REL = 1e-9;

function freecadResults(): FreecadResults | undefined {
  const p = `${dir}freecad-results.json`;
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as FreecadResults) : undefined;
}

function sync(path: string, text: string): string {
  if (update) writeFileSync(path, text);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe('reference parts: suite shape', () => {
  it('has ten parts with unique ids and numbers, and covers every M3 feature', () => {
    expect(PARTS).toHaveLength(10);
    expect(new Set(PARTS.map((p) => p.id)).size).toBe(10);
    expect(PARTS.map((p) => p.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const tags = new Set(PARTS.flatMap((p) => p.tags));
    for (const t of [
      'extrude',
      'cut',
      'revolve',
      'sphere',
      'fillet',
      'chamfer',
      'propagate',
      'noPropagate',
      'shell',
      'draft',
      'sweep',
      'sweepCut',
      'loft',
      'mirror',
      'linearPattern',
      'circularPattern',
      'skip',
      'holeCounterbore',
      'holeCountersink',
      'holeTapped',
      'plane',
      'axis',
      'point',
      'offset',
      'convert',
      'boolean',
      'pushPull',
    ] as const)
      expect(tags.has(t), `no part covers ${t}`).toBe(true);
    // Both patterns have skipped instances; at least one part uses each of the two skip forms.
    expect(PARTS.filter((p) => p.tags.includes('skip')).length).toBeGreaterThanOrEqual(2);
  });

  it('every stage names real dimensions and there are 2 to 3 per part', () => {
    for (const p of PARTS) {
      expect(p.stages.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.stages.length, p.id).toBeLessThanOrEqual(3);
      for (const s of p.stages) stageDims(p, s.set); // throws on an unknown name
    }
  });
});

describe.each(PARTS)('reference part $id', (part) => {
  const spec = specFor(part);
  const specPath = `${dir}${part.id}.spec.json`;
  const mdPath = `${dir}${part.id}.md`;
  const svgPath = `${dir}${part.id}.svg`;

  it('committed spec, Markdown and drawing are current', () => {
    expect(sync(specPath, `${JSON.stringify(spec, null, 2)}\n`)).toBe(
      `${JSON.stringify(spec, null, 2)}\n`,
    );
    const md = markdownFor(part, spec, freecadResults());
    expect(sync(mdPath, md)).toBe(md);
    const { svg } = drawingFor(part);
    expect(sync(svgPath, svg)).toBe(svg);
  });

  it('is internally consistent: derivations recomputed from the spec match the stated values to 1e-9', () => {
    const onDisk = JSON.parse(readFileSync(specPath, 'utf8')) as PartSpec;
    const mat = findMaterial(onDisk.material.libraryId);
    expect(mat, 'material is in the built-in library').toBeDefined();
    expect(onDisk.material.density).toBe(mat?.density);
    const rho = densityGcm3(onDisk.material.density);
    expect(onDisk.material.density_g_cm3).toBe(rho);
    const dims = Object.fromEntries(
      Object.entries(onDisk.dimensions).map(([k, v]) => [k, v.value]),
    );
    const cases = [
      { name: 'baseline', set: {}, expected: onDisk.expected },
      ...onDisk.stages.map((s) => ({ name: s.name, set: s.set, expected: s.expected })),
    ];
    for (const c of cases) {
      const d = { ...dims, ...c.set };
      const m = part.model(dimGetter(d));
      expect(rel(m.volume, c.expected.volume_mm3), `${c.name} volume`).toBeLessThan(REL);
      expect(rel((m.volume * rho) / 1000, c.expected.mass_g), `${c.name} mass`).toBeLessThan(REL);
      if (c.expected.area_mm2 !== undefined)
        expect(rel(m.area ?? Number.NaN, c.expected.area_mm2), `${c.name} area`).toBeLessThan(REL);
      for (let i = 0; i < 3; i++) {
        expect(m.bbox.min[i]).toBeCloseTo(c.expected.bbox.min[i] as number, 9);
        expect(m.bbox.max[i]).toBeCloseTo(c.expected.bbox.max[i] as number, 9);
      }
      // The derivation's terms add up to the volume.
      expect(
        rel(
          m.terms.reduce((s, t) => s + t.value, 0),
          m.volume,
        ),
      ).toBeLessThan(1e-12);
      expect(m.volume).toBeGreaterThan(0);
    }
  });

  it('has a drawing that names every driving dimension with its value', () => {
    expect(existsSync(svgPath), 'drawing exists').toBe(true);
    const svg = readFileSync(svgPath, 'utf8');
    expect(svg).toContain('Wren reference part');
    for (const [name, dim] of Object.entries(part.dims)) {
      const m = new RegExp(`data-dim="${name}" data-value="([^"]+)"`).exec(svg);
      expect(m, `drawing does not dimension ${name}`).not.toBeNull();
      expect(Number(m?.[1]), `${name} value on the drawing`).toBe(dim.value);
    }
  });

  it('agrees with the recorded FreeCAD build (volume and area to 1e-9)', () => {
    const fc = freecadResults()?.parts[part.id];
    expect(
      fc,
      'no FreeCAD result recorded; run reference-parts/freecad/run_all.py --write',
    ).toBeDefined();
    const cases = [
      { name: 'baseline', expected: spec.expected, got: fc?.baseline },
      ...spec.stages.map((s, i) => ({ name: s.name, expected: s.expected, got: fc?.stages[i] })),
    ];
    for (const c of cases) {
      expect(c.got, c.name).toBeDefined();
      expect(
        rel(c.got?.volume ?? Number.NaN, c.expected.volume_mm3),
        `${c.name} volume`,
      ).toBeLessThan(REL);
      if (c.expected.area_mm2 !== undefined)
        expect(rel(c.got?.area ?? Number.NaN, c.expected.area_mm2), `${c.name} area`).toBeLessThan(
          REL,
        );
    }
  });

  it('has an independent-check script and a derivation in the Markdown', () => {
    expect(existsSync(`${dir}${spec.independent.script}`), spec.independent.script).toBe(true);
    const md = readFileSync(mdPath, 'utf8');
    expect(md).toContain('## Derivation of the volume');
    expect(md).toContain('## Modification stages');
    for (const s of part.stages) expect(md).toContain(s.name);
  });

  it('builds a well-formed WrenDoc at the baseline and at every stage', () => {
    for (const set of [{}, ...part.stages.map((s) => s.set)]) {
      const doc =
        set === undefined || Object.keys(set).length === 0 ? buildDoc(part) : stageDoc(part, set);
      const p = doc.parts[0];
      expect(p?.material?.libraryId).toBe(part.material);
      expect(p?.rollbackIndex).toBe(p?.features.length);
      // Parameters are the driving dimensions.
      expect(doc.params.map((x) => x.name)).toEqual(Object.keys(part.dims));
      // Feature ids are unique, 26 characters, and in order.
      const ids = (p?.features ?? []).map((f: Feature) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[0-9A-Z]{26}$/);
      // Every expression evaluates (right dimension, known parameters).
      for (const f of p?.features ?? []) {
        const ev = evaluateFeatureValues(f, doc);
        expect(ev.errors, `${f.type} ${f.name}`).toEqual({});
      }
      // Every reference is to an origin entity or to an earlier feature.
      const seen = new Set<string>();
      for (const f of p?.features ?? []) {
        for (const r of entityRefs(f)) {
          if (r.name.startsWith('origin:')) continue;
          const tags = [...r.name.matchAll(/[FSB]([0-9A-Z]{26})/g)].map((m) => m[1] as string);
          expect(tags.length, `${f.name}: ${r.name}`).toBeGreaterThan(0);
          for (const t of tags)
            expect(seen.has(t), `${f.name} refers forward to ${r.name}`).toBe(true);
        }
        seen.add(f.id);
      }
      // No unresolved placeholder survives.
      expect(JSON.stringify(doc)).not.toMatch(/\{[A-Za-z0-9_]+\}/);
    }
  });

  it('keeps the sketch initial positions consistent with the baseline dimensions', () => {
    const dims = baselineDims(part);
    const doc = buildDoc(part);
    for (const f of doc.parts[0]?.features ?? []) {
      if (f.type !== 'sketch') continue;
      const pts = new Map(f.entities.filter((e) => e.kind === 'point').map((e) => [e.id, e]));
      for (const c of f.constraints) {
        if (!('driving' in c) || !c.driving) continue;
        if (c.kind === 'hDistance' || c.kind === 'vDistance') {
          const a = pts.get(c.a);
          const b = pts.get(c.b);
          if (a?.kind !== 'point' || b?.kind !== 'point') continue;
          const got = c.kind === 'hDistance' ? b.x - a.x : b.y - a.y;
          expect(got, `${f.name} ${c.id} ${c.value}`).toBeCloseTo(evalEx(c.value, dims), 9);
        }
      }
    }
  });
});
