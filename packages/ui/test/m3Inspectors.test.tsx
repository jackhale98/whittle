import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Feature } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { makeEvaluator, sampleParams } from '../harness/fixtures';
import { feat, holeTables, m3Features, r3 } from '../harness/m3Fixtures';
import { FeatureInspector, type FeatureInspectorProps, HoleWizard } from '../src';
import { resolveHole } from '../src/inspector/holeResolve';
import { renderUI } from './helpers';

const evaluate = makeEvaluator(sampleParams);

function setup(feature: Feature, extra: Partial<FeatureInspectorProps> = {}) {
  const onChange = vi.fn();
  const onPick = vi.fn();
  const onPreview = vi.fn();
  renderUI(
    <FeatureInspector
      feature={feature}
      evaluate={evaluate}
      onChange={onChange}
      onPick={onPick}
      onPreview={onPreview}
      holeTables={holeTables}
      describeFeature={(id) => `Feature ${id}`}
      {...extra}
    />,
  );
  return { onChange, onPick, onPreview };
}

const last = <T extends Feature>(fn: ReturnType<typeof vi.fn>): T => fn.mock.calls.at(-1)?.[0] as T;

async function type(label: string, text: string) {
  const input = screen.getByRole('textbox', { name: label });
  await userEvent.clear(input);
  await userEvent.type(input, `${text}{Enter}`);
}

const notes = () => screen.queryAllByTestId('validation').map((n) => n.textContent ?? '');

describe('every M3 feature opens an inspector', () => {
  it.each(m3Features.filter((f) => f.type !== 'sketch' && f.type !== 'extrude'))(
    '$type renders its name and a body',
    (f) => {
      setup(f);
      expect(screen.getByTestId('feature-inspector')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: f.name })).toBeInTheDocument();
      // a section with fields
      expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
    },
  );
});

describe('shell', () => {
  it('commits thickness expressions with units and the direction', async () => {
    const { onChange } = setup(feat('M9'));
    await type('Thickness', '1.5mm + 0.5mm');
    expect(last<Feature & { thickness: string }>(onChange).thickness).toBe('1.5mm + 0.5mm');
    await userEvent.click(screen.getByRole('radio', { name: 'Outward' }));
    expect(last<Feature & { direction: string }>(onChange).direction).toBe('outward');
  });

  it('picks faces through the repick pattern and removes one', async () => {
    const { onPick, onChange } = setup(feat('M9'));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith('/openFaces');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Face FM2:top' }));
    expect(last<Feature & { openFaces: unknown[] }>(onChange).openFaces).toEqual([]);
  });

  it('shows live validation: bad thickness, nothing picked', () => {
    setup({ ...feat<'shell'>('M9'), openFaces: [], thickness: '0mm' });
    expect(notes().join(' ')).toMatch(/greater than zero/);
    expect(notes().join(' ')).toMatch(/closed hollow/);
    expect(screen.getByRole('button', { name: 'Pick a body' })).toBeInTheDocument();
  });

  it('flags an unknown name in the field itself', async () => {
    setup(feat('M9'));
    const input = screen.getByRole('textbox', { name: 'Thickness' });
    await userEvent.clear(input);
    await userEvent.type(input, 'nope');
    expect(screen.getByText(/Unknown name/)).toBeInTheDocument();
  });

  it('marks an unresolved face as needing attention with a re-pick', async () => {
    const { onPick } = setup(feat('M9'), {
      status: {
        featureId: 'M9',
        state: 'needsAttention',
        cached: false,
        ms: 0,
        unresolved: [{ path: '/openFaces/0', ref: r3('FM2:top', 'face'), reason: 'missing' }],
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /Re-pick Face FM2:top/ }));
    expect(onPick).toHaveBeenCalledWith('/openFaces/0');
  });
});

describe('draft', () => {
  it('edits the angle, flips, and validates 90 degrees', async () => {
    const { onChange } = setup(feat('M10'));
    await userEvent.click(screen.getByRole('switch', { name: 'Reverse direction' }));
    expect(last<Feature & { reverse: boolean }>(onChange).reverse).toBe(true);
    await type('Angle', '5deg');
    expect(last<Feature & { angle: string }>(onChange).angle).toBe('5deg');
  });

  it('warns for 90 degrees and above', () => {
    setup({ ...feat<'draft'>('M10'), angle: '90deg' });
    expect(notes().join(' ')).toMatch(/less than 90/);
  });

  it('picks the neutral plane', async () => {
    const { onPick } = setup(feat('M10'));
    await userEvent.click(screen.getByRole('button', { name: 'Change Face FM2:start' }));
    expect(onPick).toHaveBeenCalledWith('/neutral');
  });
});

describe('sweep and loft', () => {
  it('sweep: orientation, profile and path pickers, operation', async () => {
    const { onChange, onPick } = setup(feat('M5'));
    await userEvent.click(screen.getByRole('radio', { name: 'Fixed' }));
    expect(last<Feature & { orientation: string }>(onChange).orientation).toBe('fixed');
    const path = within(screen.getByRole('list', { name: 'Path' }));
    await userEvent.click(path.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith('/path');
    await userEvent.click(screen.getByRole('radio', { name: 'Cut' }));
    expect(last<Feature & { op: string }>(onChange).op).toBe('cut');
  });

  it('sweep without profile or path says what is missing', () => {
    setup({ ...feat<'sweep'>('M5'), profile: [], path: [] });
    expect(notes().join(' ')).toMatch(/profile and a path/);
  });

  it('loft: ruled and closed switches, guides, section validation', async () => {
    const { onChange } = setup({
      ...feat<'loft'>('M8'),
      sections: [r3('SM6:region(e1)', 'region')],
    });
    expect(notes().join(' ')).toMatch(/at least two sections/);
    await userEvent.click(screen.getByRole('switch', { name: /Ruled/ }));
    expect(last<Feature & { ruled: boolean }>(onChange).ruled).toBe(true);
    await userEvent.click(screen.getByRole('switch', { name: /Closed/ }));
    expect(last<Feature & { closed: boolean }>(onChange).closed).toBe(true);
  });

  it('loft: closing needs three sections, guides are best effort', () => {
    setup({ ...feat<'loft'>('M8'), closed: true, guides: [r3('SM6:e9', 'edge')] });
    expect(notes().join(' ')).toMatch(/three or more/);
    expect(notes().join(' ')).toMatch(/best effort/);
  });
});

describe('mirror and patterns', () => {
  it('mirror: feature source chips, plane picker, switch to bodies', async () => {
    const { onChange, onPick } = setup(feat('M13'));
    expect(screen.getByText('Feature M12')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith('/source/features');
    await userEvent.click(screen.getByRole('button', { name: 'Change Face origin:YZ' }));
    expect(onPick).toHaveBeenCalledWith('/plane');
    await userEvent.click(screen.getByRole('radio', { name: 'Bodies' }));
    expect(last<Feature & { source: unknown }>(onChange).source).toEqual({
      kind: 'bodies',
      bodies: [],
      merge: true,
    });
  });

  it('mirror: bodies source has a merge switch', async () => {
    const { onChange } = setup({
      ...feat<'mirror'>('M13'),
      source: { kind: 'bodies', bodies: [r3('B1', 'body')], merge: true },
    });
    await userEvent.click(screen.getByRole('switch', { name: /Merge/ }));
    expect(last<Feature & { source: { merge: boolean } }>(onChange).source.merge).toBe(false);
  });

  it('linear pattern: count, spacing, flip, units', async () => {
    const { onChange } = setup(feat('M14'));
    await type('Count', '5');
    expect(last<Feature & { count: string }>(onChange).count).toBe('5');
    await type('Spacing', '2in');
    expect(last<Feature & { spacing: string }>(onChange).spacing).toBe('2in');
    await userEvent.click(screen.getByRole('switch', { name: 'Flip direction' }));
    expect(last<Feature & { reverse: boolean }>(onChange).reverse).toBe(true);
  });

  it('linear pattern: skip toggles per instance, the original is fixed', async () => {
    const { onChange } = setup(feat('M14'));
    const grid = within(screen.getByTestId('skip-grid'));
    expect(grid.getAllByRole('button')).toHaveLength(4);
    expect(grid.getByRole('button', { name: 'Instance 1 (original)' })).toBeDisabled();
    expect(grid.getByRole('button', { name: 'Instance 3: skipped' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(grid.getByRole('button', { name: 'Instance 2: included' }));
    expect(last<Feature & { skip: number[] }>(onChange).skip).toEqual([1, 2]);
    await userEvent.click(grid.getByRole('button', { name: 'Instance 3: skipped' }));
    expect('skip' in last<Feature>(onChange)).toBe(false);
  });

  it('linear pattern: adds and removes the second direction; the grid is rows x columns', async () => {
    const { onChange } = setup(feat('M14'));
    await userEvent.click(screen.getByRole('button', { name: 'Add direction 2' }));
    const next = last<Feature & { second: { count: string } }>(onChange);
    expect(next.second.count).toBe('2');
  });

  it('linear pattern: a second direction multiplies the instances', () => {
    setup({
      ...feat<'linearPattern'>('M14'),
      skip: [],
      second: { direction: r3('E2', 'edge'), reverse: false, count: '3', spacing: '5mm' },
    });
    expect(within(screen.getByTestId('skip-grid')).getAllByRole('button')).toHaveLength(12);
  });

  it('linear pattern: rejects a fractional count and zero spacing', () => {
    setup({ ...feat<'linearPattern'>('M14'), count: '2.5', spacing: '0mm' });
    expect(notes().join(' ')).toMatch(/whole number/);
    expect(notes().join(' ')).toMatch(/Spacing of zero/);
  });

  it('circular pattern: angle, equal spacing, axis', async () => {
    const { onChange, onPick } = setup(feat('M15'));
    await type('Angle', '180deg');
    expect(last<Feature & { angle: string }>(onChange).angle).toBe('180deg');
    await userEvent.click(screen.getByRole('switch', { name: /Equal spacing/ }));
    expect(last<Feature & { equalSpacing: boolean }>(onChange).equalSpacing).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Change Edge FM16:axis' }));
    expect(onPick).toHaveBeenCalledWith('/axis');
    expect(within(screen.getByTestId('skip-grid')).getAllByRole('button')).toHaveLength(6);
  });

  it('a count of 1 shows no instance grid', () => {
    setup({ ...feat<'circularPattern'>('M15'), count: '1' });
    expect(screen.queryByTestId('skip-grid')).toBeNull();
  });
});

describe('thread', () => {
  it('lists sizes from the table, changes standard, edits length', async () => {
    const { onChange } = setup(feat('M18'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Size' }), 'M8');
    expect(last<Feature & { size: string }>(onChange).size).toBe('M8');
    await userEvent.click(screen.getByRole('radio', { name: 'ANSI' }));
    expect(last<Feature & { standard: string; size: string }>(onChange)).toMatchObject({
      standard: 'ANSI',
      size: '#10',
    });
    await type('Length', '8mm');
    expect(last<Feature & { length: string }>(onChange).length).toBe('8mm');
  });

  it('flags a non-positive length', () => {
    setup({ ...feat<'thread'>('M18'), length: '0mm' });
    expect(notes().join(' ')).toMatch(/greater than zero/);
  });
});

describe('reference geometry', () => {
  const plane = (definition: unknown, extra: object = {}) =>
    ({
      id: 'R',
      type: 'plane',
      name: 'Plane 9',
      suppressed: false,
      definition,
      ...extra,
    }) as Feature;

  it('plane: kind select swaps in a default definition', async () => {
    const { onChange } = setup(
      plane({ kind: 'offset', from: r3('origin:XY', 'face'), distance: '10mm' }),
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Definition' }),
      'threePoints',
    );
    expect(last<Feature & { definition: { kind: string } }>(onChange).definition.kind).toBe(
      'threePoints',
    );
  });

  it('plane: three-point pickers, flip normal', async () => {
    const { onChange, onPick } = setup(
      plane({
        kind: 'threePoints',
        points: [r3('P1', 'vertex'), r3('', 'vertex'), r3('', 'vertex')],
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change Vertex P1' }));
    expect(onPick).toHaveBeenCalledWith('/definition/points/0');
    const second = within(screen.getByRole('list', { name: 'Point 2' }));
    await userEvent.click(second.getByRole('button', { name: 'Pick a point or vertex' }));
    expect(onPick).toHaveBeenCalledWith('/definition/points/1');
    await userEvent.click(screen.getByRole('switch', { name: 'Flip normal' }));
    expect(last<Feature & { flip: boolean }>(onChange).flip).toBe(true);
  });

  it('plane: angle, midplane, through-point and normal-to-curve fields', async () => {
    const view = (d: unknown) => {
      document.body.innerHTML = '';
      return setup(plane(d));
    };
    const a = view({
      kind: 'angle',
      from: r3('origin:XY', 'face'),
      axis: r3('E1', 'edge'),
      angle: '30deg',
    });
    await type('Angle', '45deg');
    expect(last<Feature & { definition: { angle: string } }>(a.onChange).definition.angle).toBe(
      '45deg',
    );
  });

  it('plane: normal to curve toggles between parameter and point, validates 0 to 1', async () => {
    const { onChange } = setup(
      plane({ kind: 'normalToCurve', curve: r3('E1', 'edge'), at: { t: '1.5' } }),
    );
    expect(notes().join(' ')).toMatch(/0 \(start\) to 1/);
    await userEvent.click(screen.getByRole('radio', { name: 'At a point' }));
    expect(
      last<Feature & { definition: { at: { kind: string } } }>(onChange).definition.at.kind,
    ).toBe('vertex');
  });

  it('plane: the other definitions render their pickers', () => {
    for (const [d, labels] of [
      [
        { kind: 'midplane', a: r3('A', 'face'), b: r3('B', 'face') },
        ['First plane', 'Second plane'],
      ],
      [
        { kind: 'throughPoint', from: r3('A', 'face'), point: r3('P', 'vertex') },
        ['Parallel to', 'Through point'],
      ],
    ] as const) {
      document.body.innerHTML = '';
      setup(plane(d));
      for (const l of labels) expect(screen.getByRole('list', { name: l })).toBeInTheDocument();
    }
  });

  it('plane: a frame plane keeps its custom-frame description', () => {
    setup(
      plane({
        kind: 'frame',
        frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
      }),
    );
    expect(screen.getByText(/positioned by origin and normal/)).toBeInTheDocument();
  });

  it('axis: kind select and per-kind pickers', async () => {
    const { onChange, onPick } = setup(feat('M16'));
    await userEvent.click(screen.getByRole('button', { name: 'Change Edge FM2:edge(e2)' }));
    expect(onPick).toHaveBeenCalledWith('/definition/edge');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Definition' }),
      'pointNormal',
    );
    expect(last<Feature & { definition: { kind: string } }>(onChange).definition.kind).toBe(
      'pointNormal',
    );
  });

  it('point: coordinates are inline expressions with units', async () => {
    const { onChange } = setup(feat('M17'));
    await type('Y', '2in');
    expect(last<Feature & { definition: { y: string } }>(onChange).definition.y).toBe('2in');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Definition' }), 'vertex');
    expect(last<Feature & { definition: { kind: string } }>(onChange).definition.kind).toBe(
      'vertex',
    );
  });

  it('point: position along an edge must stay within 0 to 1', () => {
    setup({
      id: 'T',
      type: 'point',
      name: 'Point 3',
      suppressed: false,
      definition: { kind: 'alongEdge', edge: r3('E', 'edge'), t: '2' },
    });
    expect(notes().join(' ')).toMatch(/0 \(start\) to 1/);
  });
});

describe('fillet and chamfer propagate along tangent edges', () => {
  const fillet = (propagate?: boolean): Feature => ({
    id: 'F',
    type: 'fillet',
    name: 'Fillet 1',
    suppressed: false,
    edges: [r3('FM2:e1', 'edge')],
    radius: '2mm',
    ...(propagate === undefined ? {} : { propagate }),
  });

  it('is on by default (absent means true) and toggles off and on', async () => {
    const { onChange } = setup(fillet());
    const sw = screen.getByRole('switch', { name: 'Propagate along tangent edges' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    expect(last<Feature & { propagate: boolean }>(onChange).propagate).toBe(false);
  });

  it('shows off when false, and chamfer has it too', async () => {
    setup(fillet(false));
    expect(screen.getByRole('switch', { name: 'Propagate along tangent edges' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    document.body.innerHTML = '';
    const { onChange } = setup({
      id: 'C',
      type: 'chamfer',
      name: 'Chamfer 1',
      suppressed: false,
      edges: [r3('FM2:e1', 'edge')],
      mode: { kind: 'distance', distance: '1mm' },
    });
    await userEvent.click(screen.getByRole('switch', { name: 'Propagate along tangent edges' }));
    expect(last<Feature & { propagate: boolean }>(onChange).propagate).toBe(false);
  });
});

describe('hole wizard', () => {
  const hole = feat<'hole'>('M12');
  const resolved = () => within(screen.getByTestId('hole-resolved'));

  it('resolves dimensions from the table, read-only, per kind and fit', () => {
    setup(hole);
    expect(resolved().getByText('6.6 mm')).toBeInTheDocument(); // M6 normal clearance
    expect(resolved().getByText('Counterbore Ø')).toBeInTheDocument();
    expect(resolved().getByText('11 mm')).toBeInTheDocument();
    expect(resolved().getByText('6.5 mm')).toBeInTheDocument();
    expect(within(screen.getByTestId('hole-resolved')).queryAllByRole('textbox')).toHaveLength(0);
  });

  it('changes with fit, kind and size', async () => {
    const { onChange } = setup(hole);
    await userEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    expect(last<Feature & { fit: string }>(onChange).fit).toBe('loose');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Size' }), 'M8');
    expect(last<Feature & { size: string }>(onChange).size).toBe('M8');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Hole type' }), 'tapped');
    expect(last<Feature & { kind: string }>(onChange).kind).toBe('tapped');
  });

  it('shows tap drill and pitch for tapped holes and hides fit', () => {
    setup({ ...hole, kind: 'tapped', size: 'M8' });
    expect(resolved().getByText('Tap drill Ø')).toBeInTheDocument();
    expect(resolved().getByText('6.8 mm')).toBeInTheDocument();
    expect(resolved().getByText('1.25 mm')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Clearance fit' })).toBeNull();
  });

  it('shows the countersink angle', () => {
    setup({ ...hole, kind: 'countersink', standard: 'ANSI', size: '1/4' });
    expect(resolved().getByText('82°')).toBeInTheDocument();
    expect(resolved().getByText('12.4 mm')).toBeInTheDocument();
  });

  it('switching standard picks the same size when it exists, else the first', async () => {
    const { onChange } = setup(hole);
    await userEvent.click(screen.getByRole('radio', { name: 'ANSI (inch)' }));
    expect(last<Feature & { standard: string; size: string }>(onChange)).toMatchObject({
      standard: 'ANSI',
      size: '#10',
    });
  });

  it('override diameter: toggle on seeds the table value, edits, toggle off removes it', async () => {
    const { onChange } = setup(hole);
    expect(screen.queryByRole('textbox', { name: 'Diameter' })).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Override diameter' }));
    expect(last<Feature & { diameter: string }>(onChange).diameter).toBe('6.6mm');
  });

  it('an override replaces the table value and is labelled', async () => {
    const { onChange } = setup({ ...hole, diameter: '7.2mm' });
    expect(resolved().getByText('7.2 mm')).toBeInTheDocument();
    expect(resolved().getByText('override')).toBeInTheDocument();
    await type('Diameter', '7.5mm');
    expect(last<Feature & { diameter: string }>(onChange).diameter).toBe('7.5mm');
    await userEvent.click(screen.getByRole('switch', { name: 'Override diameter' }));
    expect('diameter' in last<Feature>(onChange)).toBe(false);
  });

  it('tapped override is the drill diameter', () => {
    setup({ ...hole, kind: 'tapped', size: 'M6', diameter: '5.1mm' });
    expect(screen.getByRole('textbox', { name: 'Drill diameter' })).toBeInTheDocument();
  });

  it('end condition, depth and tip angle', async () => {
    const { onChange } = setup(hole);
    await type('Depth', '20mm');
    expect(last<Feature & { end: { depth: string } }>(onChange).end.depth).toBe('20mm');
    await userEvent.click(screen.getByRole('switch', { name: /Drill point/ }));
    expect(last<Feature & { tipAngle: string }>(onChange).tipAngle).toBe('118deg');
    await userEvent.click(screen.getByRole('radio', { name: 'Through all' }));
    expect(last<Feature & { end: { kind: string } }>(onChange).end.kind).toBe('throughAll');
  });

  it('tip angle is validated and only offered for blind holes', () => {
    setup({ ...hole, tipAngle: '200deg' });
    expect(notes().join(' ')).toMatch(/between 0° and 180°/);
    document.body.innerHTML = '';
    setup({ ...hole, end: { kind: 'throughAll' } });
    expect(screen.queryByRole('switch', { name: /Drill point/ })).toBeNull();
  });

  it('blind depth must exceed a counterbore', () => {
    setup({ ...hole, end: { kind: 'blind', depth: '5mm' } });
    expect(notes().join(' ')).toMatch(/deeper than its counterbore/);
  });

  it('up to picks a face', async () => {
    const { onPick } = setup({ ...hole, end: { kind: 'upTo', target: r3('', 'face') } });
    await userEvent.click(
      within(screen.getByRole('list', { name: 'Up to' })).getByRole('button', {
        name: 'Pick a face',
      }),
    );
    expect(onPick).toHaveBeenCalledWith('/end/target');
  });

  it('placement: points are picked on a face, with a hint when there are none', async () => {
    const { onPick } = setup({ ...hole, points: [] });
    expect(notes().join(' ')).toMatch(/Each point becomes one hole/);
    await userEvent.click(screen.getByRole('button', { name: 'Pick a sketch point or vertex' }));
    expect(onPick).toHaveBeenCalledWith('/points');
  });

  it('an unknown size is reported, not guessed', () => {
    setup({ ...hole, size: 'M5' });
    expect(notes().join(' ')).toMatch(/M5 is not in the ISO table/);
    expect(screen.queryByTestId('hole-resolved')).toBeNull();
  });

  it('a missing table is reported', () => {
    setup(hole, { holeTables: {} });
    expect(notes().join(' ')).toMatch(/not loaded/);
  });

  it('the standalone HoleWizard takes HoleTable props', async () => {
    const onChange = vi.fn();
    renderUI(
      <HoleWizard
        feature={hole}
        tables={[holeTables.ISO]}
        evaluate={evaluate}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('hole-resolved')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Close' }));
    expect(onChange).toHaveBeenCalled();
  });

  it('uses the host formatter for displayed lengths (inch users)', () => {
    setup(hole, {
      formatValue: (v, d) => (d[0] === 1 ? `${(v / 25.4).toFixed(3)} in` : `${v}`),
    });
    expect(resolved().getByText('0.260 in')).toBeInTheDocument(); // 6.6 mm
  });
});

describe('resolveHole (pure)', () => {
  const row = holeTables.ISO.rows[1];
  it('picks clearance by fit, tap drill for tapped, applies the override', () => {
    if (!row) throw new Error('fixture');
    const dia = (kind: 'simple' | 'tapped', fit: 'close' | 'normal' | 'loose', o?: number) =>
      resolveHole({ kind, fit, size: 'M6' }, row, o)[0]?.value;
    expect(dia('simple', 'close')).toBe(6.4);
    expect(dia('simple', 'loose')).toBe(7);
    expect(dia('tapped', 'normal')).toBe(5);
    expect(dia('simple', 'normal', 6.9)).toBe(6.9);
    expect(
      resolveHole({ kind: 'simple', fit: 'normal', size: 'M6' }, row, 6.9)[0]?.overridden,
    ).toBe(true);
  });
});
