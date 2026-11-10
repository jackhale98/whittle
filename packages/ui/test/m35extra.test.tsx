import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DimensionAnnotation,
  DimensionLabel,
  FeatureLineage,
  FeatureTree,
  SelectionInspector,
} from '../src';
import { arcPath, arrowPath } from '../src/sketch/DimensionAnnotation';
import { renderUI } from './helpers';

const press = (el: Element, x: number, y: number, id = 1) =>
  fireEvent.pointerDown(el, {
    clientX: x,
    clientY: y,
    pointerId: id,
    button: 0,
    pointerType: 'mouse',
  });
const drag = (el: Element, x: number, y: number, id = 1) =>
  fireEvent.pointerMove(el, { clientX: x, clientY: y, pointerId: id });
const lift = (el: Element, x: number, y: number, id = 1) =>
  fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId: id });

describe('DimensionLabel drag', () => {
  const mount = (extra = {}) => {
    const onMove = vi.fn();
    const onMoveEnd = vi.fn();
    const onCommit = vi.fn();
    renderUI(
      <DimensionLabel
        x={100}
        y={50}
        kind="length"
        expr="40mm"
        driving
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        onCommit={onCommit}
        {...extra}
      />,
    );
    return { onMove, onMoveEnd, onCommit, btn: screen.getByRole('button') };
  };

  it('dragging moves only the position (relative to where it started) and never edits', () => {
    const { btn, onMove, onMoveEnd, onCommit } = mount();
    press(btn, 100, 50);
    drag(btn, 130, 40);
    expect(onMove).toHaveBeenLastCalledWith(130, 40);
    lift(btn, 150, 60);
    expect(onMoveEnd).toHaveBeenCalledExactlyOnceWith(150, 60);
    fireEvent.click(btn); // the click that ends a drag is swallowed
    expect(screen.queryByTestId('dimension-editor')).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a tap (no movement past the slop) still edits the value', async () => {
    const { btn, onMove } = mount();
    press(btn, 100, 50);
    drag(btn, 102, 51);
    lift(btn, 102, 51);
    expect(onMove).not.toHaveBeenCalled();
    await userEvent.click(btn);
    expect(screen.getByTestId('dimension-editor')).toBeInTheDocument();
  });

  it('works for touch and pen pointers, and ignores a non-primary mouse button', () => {
    const { btn, onMove } = mount();
    for (const pointerType of ['touch', 'pen']) {
      fireEvent.pointerDown(btn, {
        clientX: 100,
        clientY: 50,
        pointerId: 3,
        pointerType,
        button: 0,
      });
      drag(btn, 120, 50, 3);
      lift(btn, 120, 50, 3);
    }
    expect(onMove).toHaveBeenCalledTimes(2);
    onMove.mockClear();
    fireEvent.pointerDown(btn, {
      clientX: 100,
      clientY: 50,
      pointerId: 4,
      pointerType: 'mouse',
      button: 2,
    });
    drag(btn, 150, 50, 4);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('is not draggable without onMove, and another pointer id is ignored', () => {
    const { btn, onMove } = mount();
    press(btn, 100, 50, 1);
    drag(btn, 150, 50, 2);
    expect(onMove).not.toHaveBeenCalled();
    renderUI(<DimensionLabel x={0} y={0} kind="radius" expr="5mm" driving />);
    expect(screen.getAllByRole('button')[1]).not.toHaveAttribute('data-draggable');
  });
});

describe('DimensionAnnotation', () => {
  const geometry = {
    extensions: [
      { a: { x: 10, y: 10 }, b: { x: 10, y: 60 } },
      { a: { x: 110, y: 10 }, b: { x: 110, y: 60 } },
    ],
    line: { a: { x: 10, y: 50 }, b: { x: 110, y: 50 } },
    arrows: [
      { tip: { x: 10, y: 50 }, dir: { x: -1, y: 0 } },
      { tip: { x: 110, y: 50 }, dir: { x: 1, y: 0 } },
    ],
  };

  it('draws extension lines, the dimension line and two arrowheads', () => {
    renderUI(<DimensionAnnotation geometry={geometry} />);
    const svg = screen.getByTestId('dimension-annotation');
    const paths = svg.querySelectorAll('path');
    expect(paths).toHaveLength(4); // strokes, two arrows, hit target
    expect(paths[0]?.getAttribute('d')).toBe('M10 10L10 60M110 10L110 60M10 50L110 50');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses theme tokens for each state and dashes reference dimensions', () => {
    const cls = (p: object) => {
      const { unmount } = renderUI(<DimensionAnnotation geometry={geometry} {...p} />);
      const svg = screen.getByTestId('dimension-annotation');
      const out = [svg.getAttribute('class'), svg.getAttribute('data-state')] as const;
      unmount();
      return out;
    };
    expect(cls({})[0]).toContain('text-fg-muted');
    expect(cls({ hovered: true })).toEqual([expect.stringContaining('text-accent'), 'hover']);
    expect(cls({ selected: true })[1]).toBe('selected');
    expect(cls({ conflicting: true })).toEqual([
      expect.stringContaining('text-danger'),
      'conflict',
    ]);
    const { unmount } = renderUI(<DimensionAnnotation geometry={geometry} driving={false} />);
    expect(screen.getByTestId('dimension-annotation').querySelector('path')).toHaveAttribute(
      'stroke-dasharray',
    );
    unmount();
  });

  it('is hit-testable: hover and click reach the callbacks through the wide stroke', () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    renderUI(<DimensionAnnotation geometry={geometry} onHover={onHover} onSelect={onSelect} />);
    const hit = screen.getByTestId('dimension-hit');
    expect(hit).toHaveAttribute('stroke-width', '12');
    expect(hit.style.pointerEvents).toBe('stroke');
    fireEvent.pointerEnter(hit);
    expect(onHover).toHaveBeenLastCalledWith(true);
    fireEvent.pointerLeave(hit);
    expect(onHover).toHaveBeenLastCalledWith(false);
    fireEvent.click(hit);
    expect(onSelect).toHaveBeenCalled();
  });

  it('extension lines are drawn but never take pointer events (they must not steal geometry picks)', () => {
    renderUI(
      <DimensionAnnotation
        geometry={{
          extensions: [{ a: { x: 0, y: 0 }, b: { x: 0, y: 40 } }],
          line: { a: { x: 0, y: 40 }, b: { x: 80, y: 40 } },
        }}
        onHover={() => {}}
      />,
    );
    const hit = screen.getByTestId('dimension-hit');
    expect(hit.getAttribute('d')).toBe('M0 40L80 40'); // the dimension line only
    const drawn = screen
      .getByTestId('dimension-annotation')
      .querySelector('path')
      ?.getAttribute('d');
    expect(drawn).toContain('M0 0L0 40'); // the extension line is still drawn
  });

  it('without callbacks it lets every pointer through', () => {
    renderUI(<DimensionAnnotation geometry={geometry} />);
    expect(screen.getByTestId('dimension-hit').style.pointerEvents).toBe('none');
  });

  it('radius leaders and angle arcs', () => {
    const { unmount } = renderUI(
      <DimensionAnnotation
        geometry={{ leader: { a: { x: 0, y: 0 }, b: { x: 30, y: -30 } } }}
        label="Radius 5 mm"
      />,
    );
    expect(screen.getByRole('img', { name: 'Radius 5 mm' })).toBeInTheDocument();
    unmount();
    renderUI(
      <DimensionAnnotation
        geometry={{ arc: { center: { x: 0, y: 0 }, radius: 20, start: 0, end: Math.PI / 2 } }}
      />,
    );
    expect(
      screen.getByTestId('dimension-annotation').querySelector('path')?.getAttribute('d'),
    ).toMatch(/^M20 0A20 20 0 0 1 /);
  });

  it('arrow and arc helpers', () => {
    expect(arrowPath({ x: 10, y: 0 }, { x: 5, y: 0 })).toMatch(/^M10 0L1 3\.2L1 -3\.2Z$/);
    expect(arcPath({ center: { x: 0, y: 0 }, radius: 10, start: 0, end: 4 })).toContain(' 0 1 1 '); // large arc
    expect(arcPath({ center: { x: 0, y: 0 }, radius: 10, start: 1, end: 0 })).toContain(' 0 1 1 '); // wraps
  });
});

describe('selection lineage', () => {
  const sel = { kind: 'face', count: 1, label: 'Top face' } as const;

  it('shows "Made by" the feature and its sketch, each with an Edit button', async () => {
    const onEditFeature = vi.fn();
    renderUI(
      <SelectionInspector
        selection={sel}
        lineage={{
          madeBy: { id: 'X1', name: 'Extrude 1' },
          sketch: { id: 'S1', name: 'Sketch 1' },
        }}
        onEditFeature={onEditFeature}
      />,
    );
    const list = screen.getByTestId('selection-lineage');
    expect(within(list).getByText('Extrude 1')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Edit Extrude 1' }));
    expect(onEditFeature).toHaveBeenLastCalledWith('X1');
    await userEvent.click(within(list).getByRole('button', { name: 'Edit Sketch 1' }));
    expect(onEditFeature).toHaveBeenLastCalledWith('S1');
  });

  it('omits the sketch line when there is none, and the whole section without lineage', () => {
    const { unmount } = renderUI(
      <SelectionInspector selection={sel} lineage={{ madeBy: { id: 'X1', name: 'Extrude 1' } }} />,
    );
    expect(screen.getByTestId('selection-lineage').querySelectorAll('li')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull(); // no handler, no button
    unmount();
    renderUI(<SelectionInspector selection={sel} />);
    expect(screen.queryByText('Made by')).toBeNull();
  });
});

describe('FeatureLineage and tree marks', () => {
  const refs = (...n: string[]) => n.map((x) => ({ id: x, name: `Name ${x}` }));

  it('lists parents and children; each is selectable and hover-highlights', async () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    renderUI(
      <FeatureLineage
        parents={refs('S1', 'X1')}
        dependents={refs('F2')}
        onSelect={onSelect}
        onHover={onHover}
      />,
    );
    const parents = document.querySelector('[data-lineage-group="parents"]') as HTMLElement;
    expect(
      within(parents)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Name S1', 'Name X1']);
    await userEvent.click(screen.getByRole('button', { name: 'Name F2' }));
    expect(onSelect).toHaveBeenCalledWith('F2');
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Name S1' }));
    expect(onHover).toHaveBeenLastCalledWith('S1');
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'Name S1' }));
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('says None for an empty side', () => {
    renderUI(<FeatureLineage parents={[]} dependents={[]} onSelect={() => {}} />);
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  it('the tree marks parents and children of the selected feature', () => {
    const items = [
      { id: 'S1', type: 'sketch', name: 'Sketch 1', suppressed: false },
      { id: 'X1', type: 'extrude', name: 'Extrude 1', suppressed: false },
      { id: 'F2', type: 'fillet', name: 'Fillet 2', suppressed: false },
    ] as const;
    renderUI(
      <FeatureTree
        features={items}
        selectedId="X1"
        nestSketches={false}
        lineage={{ parents: ['S1'], children: ['F2'] }}
      />,
    );
    const mark = (id: string) =>
      document.querySelector(`[data-feature-id="${id}"]`)?.getAttribute('data-lineage');
    expect(mark('S1')).toBe('parent');
    expect(mark('F2')).toBe('child');
    expect(mark('X1')).toBeNull();
    expect(screen.getByText(/The selected feature is built from this one/)).toBeInTheDocument();
  });
});
