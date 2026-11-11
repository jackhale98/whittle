import type {
  DimensionConstraint,
  EntityRef,
  ExtrudeFeature,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { newDoc, UNITS } from '@wren-cad/document';
import { RESERVED_WORDS, UNIT_WORDS } from '@wren-cad/ui';
import { describe, expect, it } from 'vitest';
import { fieldLabel, paramUsage } from './param-usage';

const xy: EntityRef = { name: 'origin:XY', kind: 'face' };

const dim = (id: string, kind: 'diameter' | 'length', value: string, driving = true) =>
  ({
    id,
    kind,
    value,
    driving,
    entities: ['E1'],
  }) as unknown as DimensionConstraint;

const sketch = (constraints: DimensionConstraint[]): SketchFeature => ({
  id: 'S1',
  type: 'sketch',
  name: 'Sketch 1',
  suppressed: false,
  on: xy,
  entities: [],
  constraints,
});
const extrude = (depth: string, draft?: string): ExtrudeFeature => ({
  id: 'X1',
  type: 'extrude',
  name: 'Extrude 1',
  suppressed: false,
  profile: [{ name: 'SS1:region(e1)', kind: 'region' }],
  direction: 'normal',
  end: { kind: 'blind', depth },
  op: 'new',
  ...(draft ? { draft } : {}),
});

function docWith(
  params: Array<[string, string]>,
  features: Array<SketchFeature | ExtrudeFeature>,
): WrenDoc {
  const doc = newDoc({ firstPart: 'Part 1' });
  const part = doc.parts[0];
  if (!part) throw new Error('no part');
  return {
    ...doc,
    params: params.map(([name, expr], i) => ({ id: `P${i + 1}`, name, expr })),
    parts: [{ ...part, features, rollbackIndex: features.length }],
  };
}

describe('paramUsage (Params tab "Used by")', () => {
  it('lists features, sketch dimensions and other parameters that use each parameter', () => {
    const doc = docWith(
      [
        ['width', '80 mm'],
        ['half', 'width / 2'],
        ['unused', '1 mm'],
      ],
      [sketch([dim('C1', 'diameter', 'width'), dim('C2', 'length', '5 mm')]), extrude('half + 2')],
    );
    const use = paramUsage(doc);
    expect(use.P1?.map((u) => [u.kind, u.label, u.detail])).toEqual([
      ['param', 'half', undefined],
      ['dimension', 'Sketch 1', 'diameter dimension 1'],
    ]);
    expect(use.P1?.find((u) => u.kind === 'dimension')).toMatchObject({
      featureId: 'S1',
      constraintId: 'C1',
    });
    expect(use.P2?.map((u) => [u.kind, u.label, u.detail])).toEqual([
      ['feature', 'Extrude 1', 'depth'],
    ]);
    expect(use.P2?.[0]).toMatchObject({ featureId: 'X1' });
    expect(use.P3).toEqual([]);
  });

  it('counts a field once however often the name occurs, and skips reference dimensions', () => {
    const doc = docWith(
      [['w', '10 mm']],
      [sketch([dim('C1', 'length', 'w + w * 2'), dim('C2', 'length', 'w', false)])],
    );
    expect(paramUsage(doc).P1).toHaveLength(1);
  });

  it('does not read a function call or a self-reference as a use; a name after a number is one', () => {
    const doc = docWith(
      [
        ['mm_', '1 mm'],
        ['loop', 'loop + 1 mm'],
        ['a', '5'],
      ],
      [extrude('5 a')],
    );
    const use = paramUsage(doc);
    expect(use.P2).toEqual([]);
    // The engine reads `5 a` as 5 * a: a name after a number is a unit only if it IS a unit.
    expect(use.P3?.map((u) => u.label)).toEqual(['Extrude 1']);
  });

  it('a real unit after a number is not a use, even when a parameter has that name', () => {
    const doc = docWith([['mm', '1 mm']], [extrude('5 mm')]);
    expect(paramUsage(doc).P1).toEqual([]);
  });

  it('lists configuration overrides, naming the configuration', () => {
    const base = docWith(
      [
        ['w', '10 mm'],
        ['v', '2 mm'],
      ],
      [extrude('5 mm')],
    );
    const part = base.parts[0];
    if (!part) throw new Error('no part');
    const doc: WrenDoc = {
      ...base,
      parts: [
        {
          ...part,
          configurations: [
            {
              id: 'K1',
              name: 'Long',
              params: { P2: 'w * 2' },
              features: { X1: { fields: { '/end/depth': '3 w', '/draft': 5 } } },
            },
          ],
        },
      ],
    };
    const use = paramUsage(doc).P1 ?? [];
    expect(use.map((u) => [u.kind, u.label, u.detail, u.configurationName])).toEqual([
      ['param', 'v', 'in Long', 'Long'],
      ['feature', 'Extrude 1', 'depth in Long', 'Long'],
    ]);
    expect(use[1]).toMatchObject({ featureId: 'X1', configurationId: 'K1' });
  });

  it('numbers dimensions in a sketch in order', () => {
    const doc = docWith(
      [['w', '10 mm']],
      [sketch([dim('C1', 'length', '5 mm'), dim('C2', 'length', 'w')])],
    );
    expect(paramUsage(doc).P1?.[0]?.detail).toBe('length dimension 2');
  });
});

describe('fieldLabel', () => {
  it('reads a pointer as plain words', () => {
    expect(fieldLabel('/end/depth')).toBe('depth');
    expect(fieldLabel('/tipAngle')).toBe('tip angle');
    expect(fieldLabel('/second/spacing')).toBe('second spacing');
    expect(fieldLabel('/counterbore/diameter')).toBe('counterbore diameter');
    expect(fieldLabel('/annotations/2/tolerance/upper')).toBe('tolerance upper');
  });
});

describe('the UI word lists match the document', () => {
  it('every unit the document knows is refused as a new parameter name', () => {
    for (const unit of UNITS.keys()) expect(UNIT_WORDS).toContain(unit);
  });
  it('built-in names are listed', async () => {
    const { CONSTANTS, FUNCTIONS } = await import('@wren-cad/document');
    for (const name of [...CONSTANTS.keys(), ...FUNCTIONS.keys()]) {
      expect(RESERVED_WORDS).toContain(name);
    }
  });
});
