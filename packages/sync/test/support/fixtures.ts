// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Command,
  EntityRef,
  Feature,
  FilletFeature,
  Part,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { SCHEMA_VERSION } from '@wren-cad/contracts';
import { applyPatch, compileCommand, validateDoc } from '@wren-cad/document';
import { Ajv, type ValidateFunction } from 'ajv';

/** Deterministic 26-char ULID-shaped ids. */
export const id = (n: number): string => `01J${String(n).padStart(23, '0')}`;

export const ref = (name: string, kind: EntityRef['kind'] = 'face'): EntityRef => ({ name, kind });

export const PART = id(1);
export const PIN = id(2);
export const P_WIDTH = id(10);
export const P_DEPTH = id(11);
export const P_HEIGHT = id(12);
export const SKETCH = id(20);
export const EXTRUDE = id(21);
export const FILLET = id(22);
export const CHAMFER = id(23);
export const PLANE = id(24);
export const HOLE = id(25);
export const CYL = id(30);

/** Sketch entity / constraint ids: `sk(1)` … */
export const sk = (k: number): string => id(2000 + k);

export function sketch(): SketchFeature {
  return {
    id: SKETCH,
    type: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    on: ref('origin:XY'),
    entities: [
      { id: sk(1), kind: 'point', construction: false, x: 0, y: 0 },
      { id: sk(2), kind: 'point', construction: false, x: 40, y: 0 },
      { id: sk(3), kind: 'point', construction: false, x: 40, y: 30 },
      { id: sk(4), kind: 'point', construction: false, x: 0, y: 30 },
      { id: sk(5), kind: 'line', construction: false, start: sk(1), end: sk(2) },
      { id: sk(6), kind: 'line', construction: false, start: sk(2), end: sk(3) },
      { id: sk(7), kind: 'line', construction: false, start: sk(3), end: sk(4) },
      { id: sk(8), kind: 'line', construction: false, start: sk(4), end: sk(1) },
      { id: sk(9), kind: 'point', construction: false, x: 20, y: 15 },
      { id: sk(10), kind: 'circle', construction: false, center: sk(9), radius: 5 },
    ],
    constraints: [
      { id: sk(20), kind: 'horizontal', line: sk(5) },
      { id: sk(21), kind: 'vertical', line: sk(6) },
      { id: sk(22), kind: 'length', line: sk(5), value: 'width', driving: true },
      { id: sk(23), kind: 'length', line: sk(6), value: '30mm', driving: true },
      { id: sk(24), kind: 'diameter', curve: sk(10), value: '10', driving: true },
    ],
  };
}

export function fillet(fid = FILLET, name = 'Fillet 3', radius = '2mm'): FilletFeature {
  return {
    id: fid,
    type: 'fillet',
    name,
    suppressed: false,
    edges: [ref(`F${EXTRUDE}:edge(end|side)`, 'edge')],
    radius,
  };
}

export function bracket(): Part {
  const features: Feature[] = [
    sketch(),
    {
      id: EXTRUDE,
      type: 'extrude',
      name: 'Extrude 2',
      suppressed: false,
      profile: [ref(`S${SKETCH}:region(${sk(5)},${sk(6)})`, 'region')],
      direction: 'normal',
      end: { kind: 'blind', depth: 'depth' },
      op: 'new',
    },
    fillet(),
    {
      id: CHAMFER,
      type: 'chamfer',
      name: 'Chamfer 4',
      suppressed: false,
      edges: [ref(`F${EXTRUDE}:edge(start|side)`, 'edge')],
      mode: { kind: 'distance', distance: '1mm' },
    },
    {
      id: PLANE,
      type: 'plane',
      name: 'Plane 5',
      suppressed: false,
      definition: { kind: 'offset', from: ref('origin:XY'), distance: 'height / 2' },
    },
  ];
  return {
    id: PART,
    name: 'Bracket',
    features,
    rollbackIndex: features.length,
    material: {
      libraryId: 'whittle:aluminium-6061-t6',
      name: 'Aluminium 6061-T6',
      density: '2.70 g/cm^3',
    },
  };
}

export function baseDoc(): WrenDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    units: { length: 'mm', angle: 'deg' },
    params: [
      { id: P_WIDTH, name: 'width', expr: '40mm', description: 'Overall width' },
      { id: P_DEPTH, name: 'depth', expr: '20mm' },
      { id: P_HEIGHT, name: 'height', expr: '10mm' },
    ],
    parts: [
      bracket(),
      {
        id: PIN,
        name: 'Pin',
        features: [
          {
            id: CYL,
            type: 'primitive',
            name: 'Cylinder 1',
            suppressed: false,
            shape: 'cylinder',
            op: 'new',
            radius: '3mm',
            height: '25mm',
          },
        ],
        rollbackIndex: 1,
      },
    ],
    assemblies: [],
    drawings: [{ id: id(40), name: 'Sheet 1' }],
    meta: {
      id: id(50),
      name: 'Bracket',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      app: 'wren/0.0.0',
    },
  };
}

/** Applies document commands in order (as the store would). Throws on a command that fails. */
export function apply(doc: WrenDoc, ...cmds: Command[]): WrenDoc {
  let cur = doc;
  for (const cmd of cmds) {
    const c = compileCommand(cur, cmd);
    if (!c.ok) throw new Error(`${cmd.kind}: ${c.error}`);
    cur = applyPatch(cur, c.ops).doc;
  }
  return cur;
}

export function featureOf(doc: WrenDoc, fid: string, pid = PART): Feature | undefined {
  return doc.parts.find((p) => p.id === pid)?.features.find((f) => f.id === fid);
}

// ---------------------------------------------------------------------------------------------
// Validation: the document package's structural validator and its published JSON Schema
// ---------------------------------------------------------------------------------------------

const schemaPath = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'document',
  'schema',
  'wren-document.schema.json',
);
let schema: ValidateFunction | undefined;

/** Problems with `doc`: `validateDoc` plus the JSON Schema (empty when valid). */
export function problems(doc: unknown): string[] {
  schema ??= new Ajv({ allErrors: true, strict: true }).compile(
    JSON.parse(readFileSync(schemaPath, 'utf8')),
  );
  const errs = validateDoc(doc);
  if (!schema(doc)) {
    for (const e of schema.errors ?? []) errs.push(`${e.instancePath} ${e.message}`);
  }
  return errs;
}
