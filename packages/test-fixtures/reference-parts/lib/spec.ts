/**
 * Generates the committed artefacts of a reference part from its definition: the machine-readable
 * spec (`<id>.spec.json`), the human-readable spec with the mass derivation (`<id>.md`) and the
 * spec drawing (`<id>.svg`).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findMaterial } from '@wren-cad/document';
import { baselineDims, stageDims } from './builder';
import { Drawing } from './drawing';
import { r12 } from './geom';
import { type D, type Dims, dimGetter, type Model, type PartDef, type Step } from './types';

export const SPEC_SCHEMA = 'wren-reference-part/1';

export interface Expected {
  volume_mm3: number;
  mass_g: number;
  area_mm2?: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface PartSpec {
  schema: typeof SPEC_SCHEMA;
  id: string;
  no: number;
  title: string;
  level: string;
  summary: string;
  units: { length: 'mm'; angle: 'deg' };
  material: { libraryId: string; name: string; density: string; density_g_cm3: number };
  dimensions: PartDef['dims'];
  tags: string[];
  standards: { ref: string; value: string }[];
  method: string;
  features: Step[];
  expected: Expected;
  stages: { name: string; set: Record<string, number>; expected: Expected }[];
  drawing: string;
  independent: { tool: string; script: string; results: string };
}

/** g/cm^3 from a library density string such as `2.70 g/cm^3`. */
export function densityGcm3(density: string): number {
  const m = /^([0-9.]+) g\/cm\^3$/.exec(density);
  if (m === null) throw new Error(`unsupported density string: ${density}`);
  return Number(m[1]);
}

export function expectedFor(model: Model, rho: number): Expected {
  const e: Expected = {
    volume_mm3: r12(model.volume),
    mass_g: r12((model.volume * rho) / 1000),
    bbox: {
      min: model.bbox.min.map(r12) as [number, number, number],
      max: model.bbox.max.map(r12) as [number, number, number],
    },
  };
  if (model.area !== undefined) e.area_mm2 = r12(model.area);
  return e;
}

export function specFor(part: PartDef): PartSpec {
  const mat = findMaterial(part.material);
  if (mat === undefined) throw new Error(`${part.id}: unknown material ${part.material}`);
  const rho = densityGcm3(mat.density);
  const base = dimGetter(baselineDims(part));
  return {
    schema: SPEC_SCHEMA,
    id: part.id,
    no: part.no,
    title: part.title,
    level: part.level,
    summary: part.summary,
    units: { length: 'mm', angle: 'deg' },
    material: {
      libraryId: part.material,
      name: mat.name,
      density: mat.density,
      density_g_cm3: rho,
    },
    dimensions: part.dims,
    tags: part.tags,
    standards: part.standards ?? [],
    method: part.method,
    features: part.steps(base),
    expected: expectedFor(part.model(base), rho),
    stages: part.stages.map((s) => ({
      name: s.name,
      set: s.set,
      expected: expectedFor(part.model(dimGetter(stageDims(part, s.set))), rho),
    })),
    drawing: `${part.id}.svg`,
    independent: {
      tool: 'FreeCAD',
      script: `freecad/rp${String(part.no).padStart(2, '0')}.py`,
      results: 'freecad-results.json',
    },
  };
}

export function drawingFor(part: PartDef): { svg: string; dimensions: string[] } {
  const mat = findMaterial(part.material);
  if (mat === undefined) throw new Error(`${part.id}: unknown material ${part.material}`);
  const dr = new Drawing({
    id: part.id.slice(0, 4).toUpperCase(),
    title: part.title,
    material: mat.name,
    density: mat.density,
    level: part.level,
  });
  part.draw(dimGetter(baselineDims(part)), dr);
  return { svg: dr.render(), dimensions: [...new Set(dr.dimensions)] };
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

export interface FreecadEntry {
  volume: number;
  area: number;
  bbox: { min: number[]; max: number[] };
}
export interface FreecadResults {
  tool: string;
  parts: Record<string, { baseline: FreecadEntry; stages: FreecadEntry[] }>;
}

const num = (x: number, digits = 6): string => String(Number(x.toPrecision(digits)));
const fixed = (x: number, n: number): string => x.toFixed(n);

export function markdownFor(part: PartDef, spec: PartSpec, fc?: FreecadResults): string {
  const d: D = dimGetter(baselineDims(part));
  const model = part.model(d);
  const rho = spec.material.density_g_cm3;
  const L: string[] = [];
  L.push(`# ${spec.id.slice(0, 4).toUpperCase()} ${spec.title}`, '');
  L.push(`${spec.level}. ${spec.summary}`, '');
  L.push(
    '_Original Wren reference part. Not derived from any published exam or textbook drawing._',
    '',
  );
  L.push(
    `Drawing: [${spec.drawing}](${spec.drawing}). Machine-readable spec: [${spec.id}.spec.json](${spec.id}.spec.json).`,
    '',
  );
  L.push('## Material', '');
  L.push(
    `${spec.material.name} (\`${spec.material.libraryId}\`), density ${spec.material.density}.`,
    '',
  );
  L.push('## Driving dimensions', '', '| Name | Value | Meaning |', '| --- | --- | --- |');
  for (const [k, v] of Object.entries(part.dims)) {
    const unit = v.unit === 'deg' ? ' deg' : v.unit === 'mm' ? ' mm' : '';
    L.push(`| \`${k}\` | ${v.value}${unit} | ${v.description} |`);
  }
  L.push('', '## Build intent', '');
  spec.features.forEach((s, i) => {
    L.push(`${i + 1}. **${s.tool}** (\`${s.id}\`): ${s.say}`);
  });
  L.push('', '## Expected result', '');
  L.push('| Quantity | Value |', '| --- | --- |');
  L.push(`| Volume | ${fixed(spec.expected.volume_mm3, 3)} mm^3 |`);
  L.push(`| Mass | ${fixed(spec.expected.mass_g, 4)} g |`);
  if (spec.expected.area_mm2 !== undefined)
    L.push(`| Surface area | ${fixed(spec.expected.area_mm2, 3)} mm^2 |`);
  const b = spec.expected.bbox;
  L.push(
    `| Bounding box | (${b.min.map((x) => num(x)).join(', ')}) to (${b.max.map((x) => num(x)).join(', ')}) mm |`,
  );
  L.push(
    '',
    '## Derivation of the volume',
    '',
    '| Term | Formula | Volume (mm^3) |',
    '| --- | --- | --- |',
  );
  for (const t of model.terms) L.push(`| ${t.label} | \`${t.formula}\` | ${fixed(t.value, 3)} |`);
  L.push(`| **Total** | | **${fixed(model.volume, 3)}** |`);
  L.push(
    '',
    `Mass = volume x density = ${fixed(model.volume, 3)} mm^3 x ${rho} g/cm^3 / 1000 = **${fixed(spec.expected.mass_g, 4)} g**.`,
  );
  L.push('', `Method and accuracy: ${spec.method}`, '');
  if (spec.standards.length > 0) {
    L.push('Standards values used:', '');
    for (const s of spec.standards) L.push(`- ${s.ref}: ${s.value}`);
    L.push('');
  }
  L.push(
    '## Modification stages (CSWP style)',
    '',
    '| Stage | Expected volume (mm^3) | Expected mass (g) |',
    '| --- | --- | --- |',
  );
  L.push(
    `| Stage 1: as drawn | ${fixed(spec.expected.volume_mm3, 3)} | ${fixed(spec.expected.mass_g, 4)} |`,
  );
  for (const s of spec.stages)
    L.push(`| ${s.name} | ${fixed(s.expected.volume_mm3, 3)} | ${fixed(s.expected.mass_g, 4)} |`);
  L.push('');
  const entry = fc?.parts[spec.id];
  if (entry !== undefined && fc !== undefined) {
    L.push(
      '## Independent check',
      '',
      `Built in ${fc.tool} with \`${spec.independent.script}\` (a different construction than Wren's).`,
      '',
    );
    L.push(
      '| Stage | Analytic volume (mm^3) | FreeCAD volume (mm^3) | Difference |',
      '| --- | --- | --- | --- |',
    );
    const rows = [
      { name: 'Stage 1: as drawn', v: spec.expected.volume_mm3 },
      ...spec.stages.map((s) => ({ name: s.name, v: s.expected.volume_mm3 })),
    ];
    const got = [entry.baseline, ...entry.stages];
    rows.forEach((r, i) => {
      const g = got[i];
      if (g === undefined) return;
      L.push(
        `| ${r.name} | ${fixed(r.v, 3)} | ${fixed(g.volume, 3)} | ${((g.volume - r.v) / r.v).toExponential(1)} |`,
      );
    });
    L.push('');
  } else {
    L.push(
      '## Independent check',
      '',
      `Not run yet. Run \`${spec.independent.script}\` in FreeCAD (see README) and record the result in \`${spec.independent.results}\`.`,
      '',
    );
  }
  return `${L.join('\n')}\n`;
}

export type { Dims };
