import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExtrudeFeature, Feature, FilletFeature } from '@whittle/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  extrudeSample,
  filletSample,
  sampleLibrary,
  sampleParams,
  sampleStatuses,
} from '../harness/fixtures';
import {
  FeatureInspector,
  ParamsTable,
  PartInspector,
  PromptChip,
  SelectionInspector,
  WhichOneChooser,
} from '../src';
import { makeEvaluator, renderUI } from './helpers';

const evaluate = makeEvaluator(sampleParams);
const lastArg = <T,>(fn: unknown): T =>
  (fn as { mock: { lastCall?: unknown[] } }).mock.lastCall?.[0] as T;

describe('ParamsTable', () => {
  function setup(extra: Partial<React.ComponentProps<typeof ParamsTable>> = {}) {
    const props = {
      params: sampleParams,
      evaluate: (e: string) => evaluate(e),
      onAdd: vi.fn(),
      onUpdate: vi.fn(),
      onRemove: vi.fn(),
      onMove: vi.fn(() => ({ ok: true as const })),
      ...extra,
    };
    renderUI(<ParamsTable {...props} />);
    return props;
  }

  it('shows live evaluated values with units', () => {
    setup();
    const vals = screen.getAllByTestId('param-value').map((n) => n.textContent);
    expect(vals).toEqual(['60 mm', '40 mm', '5 mm', '8.175 mm', '15°', '—']);
  });

  it('shows expression errors inline with the offending span underlined', () => {
    setup();
    const field = screen.getByRole('textbox', { name: 'Expression for bad' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('Unexpected “*”');
    expect(document.querySelector('.decoration-wavy')?.textContent).toBe('*');
  });

  it('commits expression edits via onUpdate', async () => {
    const p = setup();
    const field = screen.getByRole('textbox', { name: 'Expression for height' });
    await userEvent.click(field);
    await userEvent.keyboard('{Control>}a{/Control}width / 2{Enter}');
    expect(p.onUpdate).toHaveBeenCalledWith('P2', { expr: 'width / 2' });
  });

  it('rejects invalid and duplicate names before onUpdate', async () => {
    const p = setup();
    const name = screen.getByRole('textbox', { name: 'Name of parameter height' });
    await userEvent.clear(name);
    await userEvent.type(name, 'width{Enter}');
    expect(screen.getByText('“width” is already used')).toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, '2bad{Enter}');
    expect(screen.getByText(/Use letters, digits and _/)).toBeInTheDocument();
    expect(p.onUpdate).not.toHaveBeenCalled();
    await userEvent.clear(name);
    await userEvent.type(name, 'depth{Enter}');
    expect(p.onUpdate).toHaveBeenCalledWith('P2', { name: 'depth' });
  });

  it('edits and adds descriptions', async () => {
    const p = setup();
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Add description' })[0] as HTMLElement,
    );
    await userEvent.keyboard('Stock height{Enter}');
    expect(p.onUpdate).toHaveBeenCalledWith('P2', { description: 'Stock height' });
  });

  it('adds and removes; deleting a used parameter asks first', async () => {
    const p = setup({ usage: { P1: 3 } });
    await userEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(p.onAdd).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete height' }));
    expect(p.onRemove).toHaveBeenCalledWith('P2');
    await userEvent.click(screen.getByRole('button', { name: 'Delete width' }));
    expect(p.onRemove).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Used by 3 expressions/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(p.onRemove).toHaveBeenLastCalledWith('P1');
  });

  it('Alt+Arrow reorders; a refusal is explained', async () => {
    const onMove = vi.fn(async () => ({ ok: false as const, reason: 'wall depends on width.' }));
    setup({ onMove });
    screen.getByRole('textbox', { name: 'Name of parameter wall' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onMove).toHaveBeenCalledWith('P3', 1);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('wall depends on width.'),
    );
  });

  it('has an empty state with an expression hint', () => {
    renderUI(
      <ParamsTable
        params={[]}
        evaluate={() => ({ ok: false, error: { message: '' } })}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText('No parameters')).toBeInTheDocument();
    expect(screen.getByText('25mm + 1/8in')).toBeInTheDocument();
  });
});

describe('PartInspector / MaterialPicker', () => {
  function setup(material?: React.ComponentProps<typeof PartInspector>['part']['material']) {
    const onSetMaterial = vi.fn();
    renderUI(
      <PartInspector
        part={{ name: 'Bracket', material }}
        library={sampleLibrary}
        evaluate={(e) => evaluate(e, 'density')}
        mass={{
          volume: 31250,
          area: 8420.5,
          mass: material ? 0.0843 : undefined,
          centroid: [30.125, 20, 6.5],
        }}
        onSetMaterial={onSetMaterial}
      />,
    );
    return onSetMaterial;
  }

  it('prompts to assign a material and reads out geometry without mass', () => {
    setup();
    expect(screen.getByText('No material assigned.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign material' })).toBeInTheDocument();
    const mass = screen.getByTestId('mass-readout');
    expect(within(mass).getByText('31.25 cm³')).toBeInTheDocument();
    expect(mass.querySelector('[data-prop="mass"]')).toHaveTextContent('—');
    expect(screen.getByText('Assign a material to see mass.')).toBeInTheDocument();
  });

  it('formats mass, surface area and centre of mass', () => {
    setup({ libraryId: 'whittle:al-6061', name: 'Aluminium 6061-T6', density: '2.70 g/cm^3' });
    const mass = screen.getByTestId('mass-readout');
    expect(mass.querySelector('[data-prop="mass"]')).toHaveTextContent('84.3 g');
    expect(mass.querySelector('[data-prop="area"]')).toHaveTextContent('84.205 cm²');
    expect(mass.querySelector('[data-prop="com"]')).toHaveTextContent('30.125, 20, 6.5 mm');
    expect(screen.getByText('Aluminium 6061-T6')).toBeInTheDocument();
    expect(screen.queryByText('Assign a material to see mass.')).toBeNull();
  });

  it('uses a custom format prop', () => {
    renderUI(
      <PartInspector
        part={{ name: 'P' }}
        library={[]}
        evaluate={(e) => evaluate(e, 'density')}
        onSetMaterial={() => {}}
        mass={{ volume: 16387.064, mass: 0.1, centroid: [0, 0, 0] }}
        format={{
          volume: (v) => `${(v / 16387.064).toFixed(2)} in³`,
          area: String,
          mass: (k) => `${(k * 2.2046).toFixed(2)} lb`,
          length: String,
        }}
      />,
    );
    expect(screen.getByText('1.00 in³')).toBeInTheDocument();
    expect(screen.getByText('0.22 lb')).toBeInTheDocument();
  });

  it('searches the library by name and category and selects', async () => {
    const onSet = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Assign material' }));
    const search = await screen.findByRole('searchbox');
    expect(
      screen
        .getAllByRole('button', { pressed: false })
        .filter((b) => b.hasAttribute('data-material')),
    ).toHaveLength(sampleLibrary.length);
    await userEvent.type(search, 'plast');
    const names = () =>
      Array.from(document.querySelectorAll('[data-material]')).map(
        (b) => b.querySelector('span:nth-of-type(2)')?.textContent,
      );
    expect(names()).toEqual(['ABS', 'PLA', 'PETG', 'Nylon 6/6']);
    await userEvent.clear(search);
    await userEvent.type(search, '6061');
    expect(names()).toEqual(['Aluminium 6061-T6']);
    await userEvent.click(document.querySelector('[data-material]') as HTMLElement);
    expect(onSet).toHaveBeenCalledWith({
      libraryId: 'whittle:al-6061',
      name: 'Aluminium 6061-T6',
      density: '2.70 g/cm^3',
      appearance: '#c9ced6',
    });
  });

  it('keyboard: ArrowDown from the search moves into the list', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Assign material' }));
    const search = await screen.findByRole('searchbox');
    search.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.hasAttribute('data-material')).toBe(true);
    await userEvent.keyboard('{ArrowUp}');
    expect(search).toHaveFocus();
  });

  it('no results offers a custom material seeded with the query', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Assign material' }));
    await userEvent.type(await screen.findByRole('searchbox'), 'unobtainium');
    expect(screen.getByRole('status')).toHaveTextContent('No materials match');
    await userEvent.click(screen.getByRole('button', { name: 'Create a custom material' }));
    expect(screen.getByDisplayValue('unobtainium')).toBeInTheDocument();
  });

  it('custom material: needs a name and a valid density with units', async () => {
    const onSet = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Assign material' }));
    await userEvent.click(await screen.findByRole('radio', { name: 'Custom' }));
    const apply = screen.getByRole('button', { name: 'Apply material' });
    expect(apply).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('e.g. Cast iron'), 'Cast iron');
    const density = screen.getByRole('textbox', { name: 'Density' });
    await userEvent.click(density);
    await userEvent.keyboard('7 mm');
    expect(apply).toBeDisabled(); // a length is not a density
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Expected another kind of value, got a length/,
    );
    await userEvent.keyboard('{Control>}a{/Control}7.2 g/cm^3');
    expect(apply).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Colour #b08d57' }));
    await userEvent.click(apply);
    expect(onSet).toHaveBeenCalledWith({
      name: 'Cast iron',
      density: '7.2 g/cm^3',
      appearance: '#b08d57',
    });
  });

  it('can remove the material', async () => {
    const onSet = setup({ name: 'Steel', density: '7.85 g/cm^3' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onSet).toHaveBeenCalledWith(null);
  });
});

describe('FeatureInspector', () => {
  function setup(
    feature: Feature,
    over: Partial<React.ComponentProps<typeof FeatureInspector>> = {},
  ) {
    const props = {
      feature,
      evaluate,
      onChange: vi.fn(),
      onPick: vi.fn(),
      onPreview: vi.fn(),
      ...over,
    };
    renderUI(<FeatureInspector {...props} />);
    return props;
  }

  it('extrude: segmented controls change direction, end condition and operation', async () => {
    const p = setup(extrudeSample);
    await userEvent.click(screen.getByRole('radio', { name: 'Symmetric' }));
    expect(p.onChange).toHaveBeenLastCalledWith({ ...extrudeSample, direction: 'symmetric' });
    await userEvent.click(screen.getByRole('radio', { name: 'Through all' }));
    expect(lastArg<ExtrudeFeature>(p.onChange).end).toEqual({ kind: 'throughAll' });
    await userEvent.click(screen.getByRole('radio', { name: 'Cut' }));
    expect(lastArg<ExtrudeFeature>(p.onChange).op).toBe('cut');
  });

  it('extrude: depth is an expression field that commits and previews', async () => {
    const p = setup(extrudeSample);
    const depth = screen.getByRole('textbox', { name: 'Depth' });
    await userEvent.click(depth);
    await userEvent.keyboard('{Control>}a{/Control}25mm');
    expect(p.onPreview).toHaveBeenLastCalledWith({
      ...extrudeSample,
      end: { kind: 'blind', depth: '25mm' },
    });
    await userEvent.keyboard('{Enter}');
    expect(p.onChange).toHaveBeenLastCalledWith({
      ...extrudeSample,
      end: { kind: 'blind', depth: '25mm' },
    });
  });

  it('extrude: scope controls appear for add/cut/intersect only', async () => {
    const { unmount } = renderUI(<span />);
    unmount();
    setup({ ...extrudeSample, op: 'cut' } as Feature);
    expect(screen.getByRole('radio', { name: 'Choose bodies' })).toBeInTheDocument();
  });

  it('extrude: pick chips show refs, remove, and start picking', async () => {
    const p = setup(extrudeSample, { pickingPath: null });
    const chips = screen.getByRole('list', { name: 'Profile' });
    expect(within(chips).getByText('Region F1:region(0)')).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole('button', { name: 'Add' }));
    expect(p.onPick).toHaveBeenCalledWith('/profile');
    await userEvent.click(within(chips).getByRole('button', { name: /Remove Region/ }));
    expect(lastArg<ExtrudeFeature>(p.onChange).profile).toEqual([]);
  });

  it('shows the picking prompt on the active field', () => {
    setup({ ...extrudeSample, profile: [] }, { pickingPath: '/profile' });
    expect(screen.getByRole('button', { name: 'Select a sketch region' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('fillet: error banner with hint, needs-attention chip with re-pick', async () => {
    const status = {
      featureId: 'F3',
      state: 'needsAttention' as const,
      cached: false,
      ms: 0,
      unresolved: [
        {
          path: '/edges/1',
          ref: filletSample.edges[1] as FilletFeature['edges'][number],
          reason: 'missing' as const,
        },
      ],
    };
    const onRepick = vi.fn();
    const p = setup(filletSample, { status, onRepick });
    expect(screen.getByRole('alert')).toHaveTextContent('A reference needs your attention.');
    await userEvent.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Re-pick' }),
    );
    expect(onRepick).toHaveBeenCalledOnce();
    const chips = screen.getByRole('list', { name: 'Edges' });
    const bad = chips.querySelector('[data-state="needs-attention"]');
    expect(bad).toHaveTextContent('Edge F2:side(e7)');
    await userEvent.click(
      within(chips).getByRole('button', { name: /Re-pick Edge F2:side\(e7\) \(missing\)/ }),
    );
    expect(p.onPick).toHaveBeenCalledWith('/edges/1');
  });

  it('pick fields use the right article ("Select an edge")', async () => {
    setup(filletSample, { pickingPath: '/edges' });
    expect(screen.getByRole('button', { name: 'Select an edge' })).toBeInTheDocument();
  });

  it('fillet: error status shows message and hint', () => {
    setup(filletSample, { status: sampleStatuses[2] });
    expect(screen.getByRole('alert')).toHaveTextContent('Reduce the radius below 2.4 mm.');
  });

  it('chamfer: mode switch adds an angle field', async () => {
    const chamfer = {
      ...extrudeSample,
      id: 'C',
      type: 'chamfer',
      name: 'Chamfer 1',
      edges: [],
      mode: { kind: 'distance', distance: '2mm' },
    } as unknown as Feature;
    const p = setup(chamfer);
    await userEvent.click(screen.getByRole('radio', { name: 'Distance + angle' }));
    expect(p.onChange).toHaveBeenCalledWith({
      ...chamfer,
      mode: { kind: 'distanceAngle', distance: '2mm', angle: '45deg' },
    });
  });

  it('renders every other M1 type without crashing', () => {
    const types: Feature[] = [
      {
        id: 'r',
        type: 'revolve',
        name: 'Revolve',
        suppressed: false,
        profile: [],
        axis: { name: '', kind: 'edge' },
        angle: '360deg',
        direction: 'normal',
        op: 'new',
      },
      {
        id: 'b',
        type: 'boolean',
        name: 'Boolean',
        suppressed: false,
        op: 'cut',
        target: { name: 'B1', kind: 'body' },
        tools: [],
        keepTools: false,
      },
      {
        id: 'p',
        type: 'plane',
        name: 'Plane',
        suppressed: false,
        definition: { kind: 'offset', from: { name: 'origin:XY', kind: 'face' }, distance: '10mm' },
      },
      {
        id: 'x',
        type: 'primitive',
        name: 'Box',
        suppressed: false,
        op: 'new',
        shape: 'box',
        dx: '10mm',
        dy: '20mm',
        dz: '5mm',
      },
      {
        id: 's',
        type: 'sketch',
        name: 'Sketch',
        suppressed: false,
        on: { name: 'origin:XY', kind: 'face' },
        entities: [],
        constraints: [],
      },
      { id: 'u', type: 'pushPull', name: 'Push', suppressed: false, faces: [], distance: '3mm' },
    ];
    for (const f of types) {
      const { unmount } = renderUI(
        <FeatureInspector
          feature={f}
          evaluate={evaluate}
          onChange={() => {}}
          onEditSketch={() => {}}
        />,
      );
      expect(screen.getByTestId('feature-inspector')).toHaveTextContent(f.name);
      unmount();
    }
  });
});

describe('SelectionInspector, PromptChip, WhichOneChooser', () => {
  it('empty and hint states', () => {
    renderUI(<SelectionInspector selection={{ kind: 'none' }} />);
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
  });

  it('selection facts and actions', async () => {
    const onAction = vi.fn();
    renderUI(
      <SelectionInspector
        selection={{ kind: 'edge', count: 3, details: [['Length', '60 mm']] }}
        actions={[{ id: 'fillet', label: 'Fillet', shortcut: 'F' }]}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('3 edges')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Fillet/ }));
    expect(onAction).toHaveBeenCalledWith('fillet');
  });

  it('prompt chip is a polite status and cancels', async () => {
    const onCancel = vi.fn();
    renderUI(<PromptChip onCancel={onCancel}>Select a face or sketch region</PromptChip>);
    expect(screen.getByRole('status')).toHaveTextContent('Select a face or sketch region');
    await userEvent.click(screen.getByRole('button', { name: /cancel selection/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('chooser lists candidates, previews on focus, picks and dismisses with Esc', async () => {
    const onPick = vi.fn();
    const onHover = vi.fn();
    const onDismiss = vi.fn();
    renderUI(
      <WhichOneChooser
        at={{ x: 100, y: 100 }}
        onPick={onPick}
        onHover={onHover}
        onDismiss={onDismiss}
        candidates={[
          { id: 'f', kind: 'face', label: 'Top face' },
          { id: 'e', kind: 'edge', label: 'Edge', detail: '60 mm' },
          { id: 'v', kind: 'vertex', label: 'Corner' },
        ]}
      />,
    );
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.getAttribute('data-kind'))).toEqual(['face', 'edge', 'vertex']);
    expect(opts[0]).toHaveFocus();
    expect(onHover).toHaveBeenLastCalledWith('f');
    await userEvent.keyboard('{ArrowDown}');
    expect(opts[1]).toHaveFocus();
    expect(onHover).toHaveBeenLastCalledWith('e');
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('e');
    await userEvent.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalled();
  });
});
