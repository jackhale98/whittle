// SPDX-License-Identifier: GPL-3.0-or-later
import type { Feature, SketchFeature } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { docDiffer, movedIds, prettyExpr } from '../src';
import {
  apply,
  baseDoc,
  CHAMFER,
  EXTRUDE,
  FILLET,
  featureOf,
  fillet,
  id,
  P_WIDTH,
  PART,
  PLANE,
  SKETCH,
  sk,
} from './support/fixtures';

const summaries = (a = baseDoc(), b = a) => docDiffer.diff(a, b).map((c) => c.summary);

describe('DocDiffer', () => {
  it('no changes, no lines', () => {
    expect(summaries()).toEqual([]);
  });

  it('one line per changed feature field', () => {
    const base = baseDoc();
    const f = featureOf(base, FILLET) as Feature;
    const after = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: FILLET,
      feature: { ...f, radius: '3mm' } as Feature,
    });
    const [c] = docDiffer.diff(base, after);
    expect(c).toMatchObject({
      kind: 'modified',
      summary: 'Fillet 3: radius 2 mm → 3 mm',
      subject: { kind: 'feature', id: FILLET, partId: PART, label: 'Fillet 3' },
      fields: [{ path: '/radius', label: 'radius', before: '2mm', after: '3mm' }],
    });
  });

  it('additions, removals, renames, suppression and moves', () => {
    const base = baseDoc();
    const after = apply(
      base,
      { kind: 'addFeature', partId: PART, feature: fillet(id(90), 'Hole 2') },
      { kind: 'removeFeature', partId: PART, featureId: CHAMFER },
      { kind: 'setSuppressed', partId: PART, featureId: PLANE, suppressed: true },
    );
    const moved = apply(after, { kind: 'moveFeature', partId: PART, featureId: PLANE, toIndex: 0 });
    expect(summaries(base, after)).toEqual([
      'Suppressed Plane 5',
      'Added Hole 2',
      'Removed Chamfer 4',
    ]);
    expect(summaries(after, moved)).toContain('Moved Plane 5 to the top');
    const renamed = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: EXTRUDE,
      feature: { ...(featureOf(base, EXTRUDE) as Feature), name: 'Base' },
    });
    expect(summaries(base, renamed)).toEqual(['Renamed Extrude 2 → Base']);
  });

  it('says where a moved feature went', () => {
    const base = baseDoc();
    const after = apply(base, { kind: 'moveFeature', partId: PART, featureId: FILLET, toIndex: 4 });
    expect(summaries(base, after)).toEqual(['Moved Fillet 3 after Plane 5']);
  });

  it('parameters', () => {
    const base = baseDoc();
    expect(
      summaries(base, apply(base, { kind: 'updateParam', paramId: P_WIDTH, expr: '45mm' })),
    ).toEqual(['Parameter width: 40 mm → 45 mm']);
    expect(
      summaries(base, apply(base, { kind: 'updateParam', paramId: P_WIDTH, name: 'w' })),
    ).toEqual([
      'Renamed parameter width → w',
      // The rename refactor rewrote the sketch dimension that used it.
      'Sketch 1: Length (Line 1) width → w',
    ]);
    expect(
      summaries(
        base,
        apply(base, { kind: 'addParam', param: { id: id(70), name: 'gap', expr: '0.5in' } }),
      ),
    ).toEqual(['Added parameter gap = 0.5 in']);
    expect(summaries(base, apply(base, { kind: 'removeParam', paramId: P_WIDTH }))).toEqual([
      'Removed parameter width',
    ]);
  });

  it('sketch dimensions line by line, geometry summarised', () => {
    const base = baseDoc();
    const s = featureOf(base, SKETCH) as SketchFeature;
    const next: SketchFeature = {
      ...s,
      entities: [
        ...s.entities.map((e) =>
          e.id === sk(3) ? { ...e, x: 45 } : e.id === sk(2) ? { ...e, x: 45 } : e,
        ),
        { id: sk(30), kind: 'point', construction: false, x: 1, y: 1 },
      ],
      constraints: s.constraints.map((c) =>
        c.id === sk(22) ? { ...c, value: '45mm' } : c.id === sk(24) ? { ...c, value: '12' } : c,
      ),
    };
    const after = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: SKETCH,
      feature: next,
    });
    const changes = docDiffer.diff(base, after);
    expect(changes.map((c) => c.summary)).toEqual([
      'Sketch 1: Length (Line 1) width → 45 mm',
      'Sketch 1: Diameter (Circle 1) 10 mm → 12 mm',
      'Sketch 1: added Point 6; changed 2 entities',
    ]);
    expect(changes[0]?.subject).toMatchObject({
      kind: 'sketchConstraint',
      id: sk(22),
      featureId: SKETCH,
      label: 'Length (Line 1) in Sketch 1',
    });
  });

  it('variant changes read as values', () => {
    const base = baseDoc();
    const ext = featureOf(base, EXTRUDE) as Feature;
    const after = apply(base, {
      kind: 'updateFeature',
      partId: PART,
      featureId: EXTRUDE,
      feature: { ...ext, end: { kind: 'throughAll' }, draft: '2deg' } as Feature,
    });
    expect(summaries(base, after)).toEqual([
      'Extrude 2: draft set to 2°, end blind depth → through all',
    ]);
  });

  it('parts, materials, rollback and the document', () => {
    const base = baseDoc();
    const after = apply(
      base,
      { kind: 'renamePart', partId: PART, name: 'Bracket L' },
      {
        kind: 'setMaterial',
        partId: PART,
        material: { libraryId: 'whittle:pla', name: 'PLA', density: '1.24 g/cm^3' },
      },
      { kind: 'setRollback', partId: PART, index: 2 },
      { kind: 'setDocName', name: 'Bracket v2' },
    );
    expect(summaries(base, after)).toEqual([
      'Renamed the document Bracket → Bracket v2',
      'Renamed part Bracket → Bracket L',
      'Bracket L: material Aluminium 6061-T6 → PLA',
      'Bracket L: rolled back to before Fillet 3',
    ]);
    const density = apply(base, {
      kind: 'setMaterial',
      partId: PART,
      material: {
        ...(base.parts[0]?.material as NonNullable<(typeof base.parts)[0]['material']>),
        density: '2.8 g/cm^3',
      },
    });
    expect(summaries(base, density)).toEqual(['Bracket: density 2.70 g/cm^3 → 2.8 g/cm^3']);
  });

  it('adding a feature at the bar is not reported as a rollback change', () => {
    const base = baseDoc();
    const after = apply(base, {
      kind: 'addFeature',
      partId: PART,
      feature: fillet(id(90), 'Fillet 9'),
    });
    expect(summaries(base, after)).toEqual(['Added Fillet 9']);
  });

  it('formats expressions with units and leaves formulas alone', () => {
    expect(prettyExpr('2mm')).toBe('2 mm');
    expect(prettyExpr('30deg')).toBe('30°');
    expect(prettyExpr('40', { length: 'mm', angle: 'deg' }, 'length')).toBe('40 mm');
    expect(prettyExpr('width / 2 + 3mm')).toBe('width / 2 + 3mm');
  });

  it('finds the fewest moved items', () => {
    expect([...movedIds(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a'])]).toEqual(['a']);
    expect([...movedIds(['a', 'b', 'c'], ['a', 'b', 'c'])]).toEqual([]);
  });
});
