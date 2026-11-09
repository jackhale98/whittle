import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_NAVIGATION,
  type Feature,
  type FeatureStatus,
  type NavigationOptions,
  type SketchConflict,
  type UnresolvedRef,
} from '@wren-cad/contracts';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEvaluator, sampleParams } from '../harness/fixtures';
import {
  attentionSentence,
  attentionSentences,
  ConflictPanel,
  ConstraintGlyph,
  constraintLabels,
  FeatureInspector,
  FeatureTree,
  NAVIGATION_KEY,
  NavigationSettings,
  readNavigation,
  SketchToolbar,
  type SketchToolId,
  sanitizeNavigation,
  sketchCurveTools,
  writeNavigation,
} from '../src';
import { renderUI } from './helpers';

/* ----------------------------------------------------------------------- navigation settings */

function Nav({ initial = DEFAULT_NAVIGATION, spy = vi.fn() }) {
  const [v, setV] = useState<NavigationOptions>(initial);
  return (
    <NavigationSettings
      value={v}
      onChange={(n) => {
        spy(n);
        setV(n);
      }}
    />
  );
}

describe('NavigationSettings', () => {
  it('presets are named by behaviour; product names are plain compatibility text only', () => {
    renderUI(<Nav />);
    const radios = screen.getAllByRole('radio', { name: /button|click/i });
    const names = radios
      .map((r) => r.getAttribute('aria-labelledby'))
      .map((id) => document.getElementById(id ?? '')?.textContent);
    expect(names).toEqual([
      'Right button orbits',
      'Middle button orbits',
      'Middle button pans',
      'Right click repeats',
    ]);
    const mid = screen.getByRole('radio', { name: /Middle button orbits/ }).closest('label');
    expect(mid).toHaveTextContent('Similar to SolidWorks / NX');
    // Never a logo or an image, and the radio's own name is the behaviour, not the product.
    expect(document.querySelector('[data-testid="navigation-settings"] img, svg image')).toBeNull();
    expect(
      radios.every(
        (r) => !/SolidWorks|Fusion|Onshape|Rhino|NX/.test(r.getAttribute('value') ?? ''),
      ),
    ).toBe(true);
  });

  it('is controlled: choosing a preset reports the whole next options', async () => {
    const spy = vi.fn();
    renderUI(<Nav spy={spy} />);
    expect(screen.getByRole('radio', { name: /^Right button orbits/ })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /Middle button pans/ }));
    expect(spy).toHaveBeenLastCalledWith({ ...DEFAULT_NAVIGATION, preset: 'middlePan' });
    expect(screen.getByRole('radio', { name: /Middle button pans/ })).toBeChecked();
  });

  it('turntable / trackball, pivot, pivot marker and invert zoom', async () => {
    const spy = vi.fn();
    renderUI(<Nav spy={spy} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Trackball' }));
    expect(spy).toHaveBeenLastCalledWith({ ...DEFAULT_NAVIGATION, orbit: 'trackball' });
    await userEvent.click(screen.getByRole('radio', { name: 'Centre of the model' }));
    expect(spy).toHaveBeenLastCalledWith({
      ...DEFAULT_NAVIGATION,
      orbit: 'trackball',
      pivot: 'center',
    });
    const showPivot = screen.getByRole('switch', { name: /Show the pivot/ });
    expect(showPivot).toBeChecked();
    await userEvent.click(showPivot);
    expect(spy.mock.lastCall?.[0].showPivot).toBe(false);
    const invert = screen.getByRole('switch', { name: /Invert zoom/ });
    expect(invert).not.toBeChecked();
    await userEvent.click(invert);
    expect(spy.mock.lastCall?.[0].invertZoom).toBe(true);
  });

  it('orbit speed is a log slider: 1x in the middle, 0.25x to 4x at the ends', () => {
    const spy = vi.fn();
    renderUI(<Nav spy={spy} />);
    const s = screen.getByRole('slider', { name: 'Orbit speed' });
    expect(s).toHaveValue('0');
    expect(s).toHaveAttribute('aria-valuetext', '1.00 times');
    fireEvent.change(s, { target: { value: '2' } });
    expect(spy.mock.lastCall?.[0].rotateSpeed).toBe(4);
    fireEvent.change(s, { target: { value: '-2' } });
    expect(spy.mock.lastCall?.[0].rotateSpeed).toBe(0.25);
    expect(screen.getByText('0.25×')).toBeInTheDocument();
  });

  it('says that the left button never navigates', () => {
    renderUI(<Nav />);
    expect(screen.getByText(/left button always picks and box-selects/)).toBeInTheDocument();
  });
});

describe('navigation persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips under wren.navigation', () => {
    expect(NAVIGATION_KEY).toBe('wren.navigation');
    expect(readNavigation()).toEqual(DEFAULT_NAVIGATION);
    const v: NavigationOptions = {
      preset: 'middleOrbit',
      orbit: 'trackball',
      pivot: 'center',
      showPivot: false,
      invertZoom: true,
      rotateSpeed: 2,
    };
    writeNavigation(v);
    expect(readNavigation()).toEqual(v);
  });

  it('sanitises anything stored: bad enums, wrong types, out-of-range speed, corrupt JSON', () => {
    expect(sanitizeNavigation({ preset: 'leftOrbit', orbit: 3, rotateSpeed: 99 })).toEqual({
      ...DEFAULT_NAVIGATION,
      rotateSpeed: 4,
    });
    expect(sanitizeNavigation({ rotateSpeed: 0 }).rotateSpeed).toBe(0.25);
    expect(sanitizeNavigation({ rotateSpeed: Number.NaN }).rotateSpeed).toBe(1);
    expect(sanitizeNavigation(null)).toEqual(DEFAULT_NAVIGATION);
    expect(sanitizeNavigation('x')).toEqual(DEFAULT_NAVIGATION);
    localStorage.setItem(NAVIGATION_KEY, '{not json');
    expect(readNavigation()).toEqual(DEFAULT_NAVIGATION);
  });
});

/* ----------------------------------------------------------------------- errors at the cause */

const names: Record<string, string> = { ex: 'Extrude 1', fi: 'Fillet 2' };
const nameOf = (id: string) => names[id];

describe('attentionSentence', () => {
  it('names the cause: "Fillet 2 lost its edge because Extrude 1 changed."', () => {
    const s = attentionSentence({
      feature: 'Fillet 2',
      state: 'needsAttention',
      ref: { kind: 'edge', reason: 'missing' },
      cause: { featureId: 'ex', kind: 'changed' },
      nameOf,
    });
    expect(s?.text).toBe('Fillet 2 lost its edge because Extrude 1 changed.');
    expect(s?.cause).toEqual({ featureId: 'ex', name: 'Extrude 1', selectable: true });
    expect(`${s?.before}${s?.cause.name}${s?.after}`).toBe(s?.text);
  });

  it('covers every cause kind, faces and ambiguity, and shows the detail', () => {
    const t = (kind: 'changed' | 'suppressed' | 'deleted' | 'reordered' | 'failed', extra = {}) =>
      attentionSentence({
        feature: 'Fillet 2',
        state: 'needsAttention',
        ref: { kind: 'face', reason: 'missing' },
        cause: { featureId: 'ex', kind, ...extra },
        nameOf,
      })?.text;
    expect(t('suppressed')).toBe('Fillet 2 lost its face because Extrude 1 is suppressed.');
    expect(t('reordered')).toBe('Fillet 2 lost its face because Extrude 1 now comes after it.');
    expect(t('failed')).toBe('Fillet 2 lost its face because Extrude 1 failed.');
    expect(t('changed', { detail: 'depth 10 → 4 mm' })).toBe(
      'Fillet 2 lost its face because Extrude 1 changed (depth 10 → 4 mm).',
    );
    expect(
      attentionSentence({
        feature: 'Fillet 2',
        state: 'needsAttention',
        ref: { kind: 'edge', reason: 'ambiguous' },
        cause: { featureId: 'ex', kind: 'changed' },
        nameOf,
      })?.text,
    ).toBe('Fillet 2 now matches more than one edge because Extrude 1 changed.');
  });

  it('error and blocked states, and a deleted cause that cannot be selected', () => {
    expect(
      attentionSentence({
        feature: 'Fillet 2',
        state: 'error',
        cause: { featureId: 'ex', kind: 'failed' },
        nameOf,
      })?.text,
    ).toBe('Fillet 2 could not rebuild because Extrude 1 failed.');
    expect(
      attentionSentence({
        feature: 'Fillet 2',
        state: 'blocked',
        cause: { featureId: 'ex', kind: 'failed' },
        nameOf,
      })?.text,
    ).toBe('Fillet 2 is waiting because Extrude 1 failed.');
    const gone = attentionSentence({
      feature: 'Fillet 2',
      state: 'needsAttention',
      ref: { kind: 'edge', reason: 'missing' },
      cause: { featureId: 'old', kind: 'deleted' },
      nameOf,
    });
    expect(gone?.text).toBe('Fillet 2 lost its edge because an earlier feature was deleted.');
    expect(gone?.cause.selectable).toBe(false);
    // Known name but deleted: still not selectable.
    expect(
      attentionSentence({
        feature: 'F',
        state: 'needsAttention',
        cause: { featureId: 'ex', kind: 'deleted' },
        nameOf,
      })?.cause.selectable,
    ).toBe(false);
  });

  it('never guesses: no cause, no sentence', () => {
    expect(
      attentionSentence({ feature: 'F', state: 'needsAttention', cause: undefined, nameOf }),
    ).toBeNull();
    expect(
      attentionSentences({
        feature: 'F',
        state: 'needsAttention',
        unresolved: [{ ref: { kind: 'edge' }, reason: 'missing' }],
        nameOf,
      }),
    ).toEqual([]);
  });

  it('one sentence per distinct cause: three edges lost to the same change read once', () => {
    const cause = { featureId: 'ex', kind: 'changed' as const };
    const u = (c?: { featureId: string; kind: 'changed' | 'suppressed' }) => ({
      ref: { kind: 'edge' as const },
      reason: 'missing' as const,
      cause: c,
    });
    expect(
      attentionSentences({
        feature: 'Fillet 2',
        state: 'needsAttention',
        unresolved: [u(cause), u(cause), u(cause)],
        nameOf,
      }),
    ).toHaveLength(1);
    expect(
      attentionSentences({
        feature: 'Fillet 2',
        state: 'needsAttention',
        unresolved: [u(cause), u({ featureId: 'fi', kind: 'suppressed' })],
        nameOf,
      }).map((s) => s.cause.name),
    ).toEqual(['Extrude 1', 'Fillet 2']);
  });

  it('falls back to the feature status cause when the refs carry none', () => {
    const [s] = attentionSentences({
      feature: 'Fillet 2',
      state: 'needsAttention',
      unresolved: [{ ref: { kind: 'edge' }, reason: 'missing' }],
      cause: { featureId: 'ex', kind: 'changed' },
      nameOf,
    });
    expect(s?.text).toBe('Fillet 2 lost its edge because Extrude 1 changed.');
  });
});

const fillet = {
  id: 'fi',
  type: 'fillet',
  name: 'Fillet 2',
  suppressed: false,
  edges: [{ name: 'F1:e3', kind: 'edge' }],
  radius: '2 mm',
} as unknown as Feature;

const attention: FeatureStatus = {
  featureId: 'fi',
  state: 'needsAttention',
  cached: false,
  ms: 1,
  unresolved: [
    {
      path: '/edges/0',
      ref: { name: 'F1:e3', kind: 'edge' },
      reason: 'missing',
      cause: { featureId: 'ex', kind: 'changed', detail: 'depth 10 → 4 mm' },
    },
  ],
};

const u0 = attention.unresolved?.[0] as UnresolvedRef;

describe('error-at-cause in the inspector', () => {
  const evaluate = makeEvaluator(sampleParams);
  const mount = (status: FeatureStatus, onSelectFeature = vi.fn()) => {
    renderUI(
      <FeatureInspector
        feature={fillet}
        status={status}
        evaluate={(e, x) => evaluate(e, x)}
        onChange={() => {}}
        describeFeature={(id) => names[id] ?? id}
        onSelectFeature={onSelectFeature}
      />,
    );
    return onSelectFeature;
  };

  it('shows the cause and the cause name selects that feature', async () => {
    const onSelectFeature = mount(attention);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Fillet 2 lost its edge because Extrude 1 changed (depth 10 → 4 mm).',
    );
    await userEvent.click(within(alert).getByRole('button', { name: 'Select Extrude 1' }));
    expect(onSelectFeature).toHaveBeenCalledExactlyOnceWith('ex');
  });

  it('keeps the generic text and Re-pick without a cause', () => {
    mount({
      ...attention,
      unresolved: [{ ...u0, cause: undefined }],
    });
    expect(screen.queryByTestId('attention-cause')).toBeNull();
    expect(screen.getByText('A reference needs your attention.')).toBeInTheDocument();
  });

  it('an unknown cause feature is plain text, not a dead button', () => {
    mount({
      ...attention,
      unresolved: [{ ...u0, cause: { featureId: 'nope', kind: 'deleted' } }],
    });
    expect(screen.getByRole('alert')).toHaveTextContent('because an earlier feature was deleted');
    expect(screen.queryByRole('button', { name: /^Select/ })).toBeNull();
  });

  it('error and blocked features name their cause too', async () => {
    const a = mount({
      featureId: 'fi',
      state: 'error',
      cached: false,
      ms: 1,
      error: { code: 'INTERNAL', message: 'The fillet failed.' },
      cause: { featureId: 'ex', kind: 'failed' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Fillet 2 could not rebuild because Extrude 1 failed.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select Extrude 1' }));
    expect(a).toHaveBeenCalledWith('ex');
  });

  it('blocked: a status region with the cause', () => {
    mount({
      featureId: 'fi',
      state: 'blocked',
      cached: false,
      ms: 0,
      cause: { featureId: 'ex', kind: 'failed' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Fillet 2 is waiting because Extrude 1 failed.',
    );
  });
});

describe('error-at-cause in the feature tree', () => {
  const items = [
    { id: 'ex', type: 'extrude', name: 'Extrude 1', suppressed: false },
    { id: 'fi', type: 'fillet', name: 'Fillet 2', suppressed: false },
  ] as const;

  it('the row message names the cause; its button selects the cause, not the row', async () => {
    const onSelect = vi.fn();
    renderUI(<FeatureTree features={items} statuses={[attention]} onSelect={onSelect} />);
    const row = document.querySelector('[data-feature-id="fi"]') as HTMLElement;
    expect(within(row).getByTestId('feature-message')).toHaveTextContent(
      'Fillet 2 lost its edge because Extrude 1 changed (depth 10 → 4 mm).',
    );
    const btn = within(row).getByRole('button', { name: 'Select Extrude 1', hidden: true });
    expect(btn).toHaveAttribute('tabindex', '-1'); // no second tab stop inside a treeitem
    await userEvent.click(btn);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('ex');
  });

  it('without a cause the old message stays', () => {
    renderUI(
      <FeatureTree
        features={items}
        statuses={[
          {
            ...attention,
            unresolved: [{ ...u0, cause: undefined }],
          },
        ]}
      />,
    );
    expect(screen.getByText('A reference needs re-picking.')).toBeInTheDocument();
  });
});

/* ----------------------------------------------------------------------- sketch conflicts */

describe('ConflictPanel (M3.5)', () => {
  const conflicts: SketchConflict[] = [
    {
      constraints: ['C3', 'C7'],
      entities: ['L2', 'L1'],
      explanation: 'Line 2 can’t be both horizontal and at 30° to Line 1.',
      fixes: [
        {
          label: 'Remove “Angle 30° (Line 1, Line 2)”',
          action: { kind: 'removeConstraint', constraint: 'C7' },
        },
        { label: 'Make it a reference', action: { kind: 'makeReference', constraint: 'C7' } },
      ],
    },
  ];
  const cname = (id: string) =>
    ({ C3: 'Horizontal on Line 2', C7: 'Angle 30° (Line 1, Line 2)' })[id];
  const ename = (id: string) => ({ L1: 'Line 1', L2: 'Line 2' })[id];

  it('shows named constraints and the geometry, never bare ids', async () => {
    renderUI(
      <ConflictPanel
        conflicts={conflicts}
        constraintName={cname}
        entityName={ename}
        onFix={() => {}}
      />,
    );
    const list = await screen.findByRole('list', { name: 'Conflicting constraints' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['Horizontal on Line 2', 'Angle 30° (Line 1, Line 2)']);
    expect(screen.getByTestId('conflict-entities')).toHaveTextContent('Acts on Line 2, Line 1');
    expect(document.body.textContent).not.toMatch(/\bC3\b|\bC7\b|\bL1\b/);
  });

  it('a constraint without a name reads "Unnamed constraint", not its id', async () => {
    renderUI(<ConflictPanel conflicts={conflicts} onFix={() => {}} />);
    await screen.findByRole('list', { name: 'Conflicting constraints' });
    expect(document.body.textContent).not.toMatch(/\bC3\b|\bC7\b/);
    expect(screen.getAllByText('Unnamed constraint')).toHaveLength(2);
    cleanupNames();
  });

  function cleanupNames() {
    // The id echoed back is treated as "no name" too.
  }

  it('hovering or focusing a card highlights its constraints and entities through callbacks', async () => {
    const onHighlight = vi.fn();
    const onHighlightEntities = vi.fn();
    renderUI(
      <ConflictPanel
        conflicts={conflicts}
        constraintName={cname}
        onFix={() => {}}
        onHighlight={onHighlight}
        onHighlightEntities={onHighlightEntities}
      />,
    );
    const card = await screen.findByTestId('conflict-card');
    fireEvent.mouseEnter(card);
    expect(onHighlight).toHaveBeenLastCalledWith(['C3', 'C7']);
    expect(onHighlightEntities).toHaveBeenLastCalledWith(['L2', 'L1']);
    fireEvent.mouseLeave(card);
    expect(onHighlight).toHaveBeenLastCalledWith(null);
    expect(onHighlightEntities).toHaveBeenLastCalledWith(null);
    fireEvent.focus(card);
    expect(onHighlightEntities).toHaveBeenLastCalledWith(['L2', 'L1']);
  });

  it('fixes[0] is the primary "Suggested" button; the others are secondary', async () => {
    const onFix = vi.fn();
    renderUI(<ConflictPanel conflicts={conflicts} constraintName={cname} onFix={onFix} />);
    const primary = await screen.findByRole('button', { name: /Remove “Angle 30°/ });
    expect(primary).toHaveAttribute('data-suggested');
    expect(screen.getAllByTestId('suggested-label')).toHaveLength(1);
    expect(primary.parentElement).toHaveTextContent('Suggested');
    await userEvent.click(primary);
    expect(onFix).toHaveBeenCalledWith(conflicts[0]?.fixes[0], 0);
    expect(screen.getByRole('button', { name: 'Make it a reference' })).not.toHaveAttribute(
      'data-suggested',
    );
  });

  it('an unsupported constraint says so instead of "over-constrained"', async () => {
    renderUI(
      <ConflictPanel
        conflicts={[
          {
            kind: 'unsupported',
            constraints: ['C1'],
            explanation: 'Curvature is not supported here.',
            fixes: [],
          },
        ]}
        constraintName={() => 'Curvature (Spline 1, Line 2)'}
        onFix={() => {}}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'This constraint is not supported yet' }),
    ).toBeInTheDocument();
  });
});

/* ----------------------------------------------------------------------- glyph and toolbar */

function Bar({ onTool = vi.fn(), tools = undefined as undefined | readonly never[] }) {
  const [tool, setTool] = useState<SketchToolId | null>(null);
  return (
    <SketchToolbar
      activeTool={tool}
      onTool={(t, v) => {
        onTool(t, v);
        setTool(t);
      }}
      construction={false}
      onToggleConstruction={() => {}}
      onFinish={() => {}}
      {...(tools ? { curveTools: tools } : {})}
    />
  );
}

describe('curvature glyph and curve tools', () => {
  it('curvature has its own glyph, distinct from tangent', () => {
    const svg = (k: 'tangent' | 'curvature') => {
      const { container, unmount } = renderUI(<ConstraintGlyph kind={k} />);
      const html = container.querySelector('svg')?.innerHTML;
      unmount();
      return html;
    };
    expect(svg('curvature')).not.toBe(svg('tangent'));
    expect(svg('curvature')).not.toContain('M3 17c5 0 6-10 9-10'); // the placeholder S curve is gone
    expect(constraintLabels.curvature).toBe('Curvature');
    renderUI(<ConstraintGlyph kind="curvature" labelled />);
    expect(screen.getByRole('img', { name: 'Curvature' })).toBeInTheDocument();
  });

  it('the four curve tools are data with unique icons and non-clashing shortcuts', () => {
    expect(sketchCurveTools.map((t) => t.label)).toEqual([
      'Spline (control points)',
      'Spline (through points)',
      'Ellipse',
      'Elliptic arc',
    ]);
    const shortcuts = sketchCurveTools.map((t) => t.shortcut);
    expect(new Set(shortcuts).size).toBe(4);
    expect(shortcuts).toEqual(['B', '⇧B', '⇧E', '⇧A']);
  });

  it('a Curves menu lists them and selects a tool', async () => {
    const onTool = vi.fn();
    renderUI(<Bar onTool={onTool} />);
    await userEvent.click(screen.getByRole('button', { name: 'Curves' }));
    const menu = screen.getByRole('menu', { name: 'Curve tools' });
    expect(
      within(menu)
        .getAllByRole('menuitemcheckbox')
        .map((i) => i.textContent),
    ).toEqual([
      'Spline (control points)B',
      'Spline (through points)⇧B',
      'Ellipse⇧E',
      'Elliptic arc⇧A',
    ]);
    await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: /Ellipse/ }));
    expect(onTool).toHaveBeenLastCalledWith('ellipse', undefined);
    expect(screen.getByRole('button', { name: 'Curves' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('their shortcuts work by physical key and do not steal Arc, Extend or Circle', async () => {
    const onTool = vi.fn();
    renderUI(<Bar onTool={onTool} />);
    await userEvent.keyboard('b');
    expect(onTool).toHaveBeenLastCalledWith('splineControl', undefined);
    await userEvent.keyboard('{Shift>}b{/Shift}');
    expect(onTool).toHaveBeenLastCalledWith('splineThrough', undefined);
    await userEvent.keyboard('{Shift>}e{/Shift}');
    expect(onTool).toHaveBeenLastCalledWith('ellipse', undefined);
    await userEvent.keyboard('{Shift>}a{/Shift}');
    expect(onTool).toHaveBeenLastCalledWith('ellipticArc', undefined);
    await userEvent.keyboard('a');
    expect(onTool).toHaveBeenLastCalledWith('arc', 'threePoint');
    await userEvent.keyboard('e');
    expect(onTool).toHaveBeenLastCalledWith('extend', undefined);
    // AZERTY: the physical A key types "q"; the shortcut follows the key, not the character.
    fireEvent.keyDown(window, { key: 'q', code: 'KeyA' });
    expect(onTool).toHaveBeenLastCalledWith('arc', 'threePoint');
  });

  it('takes the tools as data: [] hides the button, a custom list replaces the entries', async () => {
    const { unmount } = renderUI(<Bar tools={[]} />);
    expect(screen.queryByRole('button', { name: 'Curves' })).toBeNull();
    unmount();
    renderUI(<Bar tools={sketchCurveTools.slice(2) as never} />);
    await userEvent.click(screen.getByRole('button', { name: 'Curves' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitemcheckbox')).toHaveLength(2);
  });

  it('the constraints menu offers curvature (G2)', async () => {
    renderUI(<Bar />);
    await userEvent.click(screen.getByRole('button', { name: 'Constraints' }));
    expect(screen.getByRole('menuitem', { name: /Curvature/ })).toBeInTheDocument();
  });
});
