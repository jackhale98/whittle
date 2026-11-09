import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandBar, type ToolId, ToolRail, toolGroups, toolHint, tools } from '../src';
import { LAST_TOOLS_KEY } from '../src/components/CommandBar';
import { reservedKeys } from '../src/components/tools';
import { renderUI } from './helpers';

const ALL: readonly ToolId[] = tools.map((t) => t.id);
/** Today's flat bar had ten controls (nine tools and More); grouping must never exceed that. */
const LEGACY_CONTROLS = 10;

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

const bar = () => screen.getByRole('toolbar', { name: 'Modeling tools' });
const categories = () => within(bar()).getAllByRole('button');

describe('CommandBar (grouped)', () => {
  it('renders one control per category plus More, never more than the old flat bar', () => {
    renderUI(<CommandBar enabledTools={ALL} />);
    expect(categories()).toHaveLength(toolGroups.length + 1);
    expect(categories().length).toBeLessThanOrEqual(LEGACY_CONTROLS);
    // every tool is still reachable: in a flyout or as a direct button
    const direct = toolGroups.filter((g) => g.tools.length === 1).map((g) => g.tools[0]);
    for (const id of direct) expect(bar().querySelector(`[data-tool="${id}"]`)).not.toBeNull();
  });

  it('keeps the width bound as tools are added: the control count is the group count', () => {
    // The bar is a function of toolGroups, not of the tool count.
    expect(toolGroups.length + 1).toBeLessThanOrEqual(LEGACY_CONTROLS);
    const grouped = toolGroups.flatMap((g) => g.tools);
    expect(new Set(grouped).size).toBe(grouped.length); // a tool lives in exactly one group
    expect(new Set(grouped)).toEqual(new Set(ALL)); // and every tool lives in a group
  });

  it('click opens the flyout, picking runs the tool and closes it', async () => {
    const onTool = vi.fn();
    renderUI(<CommandBar enabledTools={ALL} onTool={onTool} />);
    const solid = screen.getByRole('button', { name: 'Extrude, Solid tools' });
    expect(solid).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(solid);
    expect(solid).toHaveAttribute('aria-expanded', 'true');
    const flyout = within(screen.getByRole('group', { name: 'Solid tools' }));
    await userEvent.click(flyout.getByRole('button', { name: /^Revolve(?!d)/ }));
    expect(onTool).toHaveBeenCalledExactlyOnceWith('revolve');
    expect(screen.queryByRole('group', { name: 'Solid tools' })).toBeNull();
    // the category now shows the last-used tool
    expect(screen.getByRole('button', { name: 'Revolve, Solid tools' })).toBeInTheDocument();
  });

  it('single-tool groups are direct buttons', async () => {
    const onTool = vi.fn();
    renderUI(<CommandBar enabledTools={ALL} onTool={onTool} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sketch' }));
    expect(onTool).toHaveBeenCalledWith('sketch');
    await userEvent.click(screen.getByRole('button', { name: 'Hole' }));
    expect(onTool).toHaveBeenLastCalledWith('hole');
    expect(screen.queryByTestId('tool-flyout')).toBeNull();
  });

  it('persists the last-used tool per group across remounts', async () => {
    const first = renderUI(<CommandBar enabledTools={ALL} onTool={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fillet, Modify tools' }));
    await userEvent.click(screen.getByRole('button', { name: /Chamfer/ }));
    expect(JSON.parse(localStorage.getItem(LAST_TOOLS_KEY) ?? '{}')).toEqual({ modify: 'chamfer' });
    first.unmount();
    renderUI(<CommandBar enabledTools={ALL} />);
    expect(screen.getByRole('button', { name: 'Chamfer, Modify tools' })).toBeInTheDocument();
  });

  it('remembers tools that start from a shortcut (the active tool changes)', () => {
    const { rerender } = renderUI(<CommandBar enabledTools={ALL} activeTool={null} />);
    expect(screen.getByRole('button', { name: 'Extrude, Solid tools' })).toBeInTheDocument();
    rerender(<CommandBar enabledTools={ALL} activeTool="revolve" />);
    expect(screen.getByRole('button', { name: 'Revolve, Solid tools' })).toHaveAttribute(
      'data-active',
    );
    expect(JSON.parse(localStorage.getItem(LAST_TOOLS_KEY) ?? '{}').solid).toBe('revolve');
  });

  it('ignores corrupt or unavailable storage', () => {
    localStorage.setItem(LAST_TOOLS_KEY, '{not json');
    renderUI(<CommandBar enabledTools={ALL} />);
    expect(screen.getByRole('button', { name: 'Extrude, Solid tools' })).toBeInTheDocument();
    localStorage.setItem(LAST_TOOLS_KEY, JSON.stringify({ solid: 'fillet', modify: 'nope' }));
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderUI(<CommandBar enabledTools={ALL} activeTool="chamfer" />);
      expect(screen.getAllByRole('toolbar', { name: 'Modeling tools' }).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      set.mockRestore();
    }
  });

  it('disabled tools carry their own hint, not a blanket one', async () => {
    renderUI(<CommandBar enabledTools={['sketch', 'extrude', 'fillet']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fillet, Modify tools' }));
    const flyout = within(screen.getByRole('group', { name: 'Modify tools' }));
    const shell = flyout.getByRole('button', { name: /Shell/ });
    expect(shell).toHaveAttribute('aria-disabled', 'true');
    expect(shell).toHaveTextContent('Not available yet');
    expect(toolHint('hole')).toBe('Not available yet');
    expect(toolHint('chamfer')).toBe('Not available yet');
    expect(toolHint('chamfer')).not.toMatch(/M1/);
    expect(screen.getByRole('button', { name: 'Hole' })).toHaveAttribute('aria-disabled', 'true');
  });

  describe('keyboard', () => {
    it('roves across the categories with one tab stop', async () => {
      renderUI(<CommandBar enabledTools={ALL} />);
      expect(categories().filter((b) => b.tabIndex === 0).length).toBeLessThanOrEqual(1);
      categories()[0]?.focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(categories()[1]).toHaveFocus();
      await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowLeft}');
      expect(categories()[2]).toHaveFocus();
    });

    it('ArrowUp or Enter opens, arrows move inside, Enter picks, Escape closes', async () => {
      const onTool = vi.fn();
      renderUI(<CommandBar enabledTools={ALL} onTool={onTool} />);
      const solid = screen.getByRole('button', { name: 'Extrude, Solid tools' });
      solid.focus();
      await userEvent.keyboard('{ArrowUp}');
      const flyout = screen.getByRole('group', { name: 'Solid tools' });
      await vi.waitFor(() =>
        expect(within(flyout).getByRole('button', { name: /^Extrude(?!d)/ })).toHaveFocus(),
      );
      await userEvent.keyboard('{ArrowDown}');
      expect(within(flyout).getByRole('button', { name: /Extruded cut/ })).toHaveFocus();
      await userEvent.keyboard('{ArrowUp}{ArrowUp}'); // wraps to the last
      expect(within(flyout).getByRole('button', { name: /Loft/ })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: 'Solid tools' })).toBeNull();
      expect(solid).toHaveFocus();

      await userEvent.keyboard('{Enter}');
      // Wait for focus to land in the flyout (its first item), not just for it to exist: on a slow
      // runner the arrow key otherwise reaches the category button before the flyout takes focus.
      await vi.waitFor(() =>
        expect(
          within(screen.getByRole('group', { name: 'Solid tools' })).getByRole('button', {
            name: /^Extrude(?!d)/,
          }),
        ).toHaveFocus(),
      );
      await userEvent.keyboard('{ArrowDown}{Enter}');
      expect(onTool).toHaveBeenCalledExactlyOnceWith('extrudeCut');
      expect(screen.getByRole('button', { name: 'Extruded cut, Solid tools' })).toHaveFocus();
    });

    it('disabled tools stay focusable but do not run', async () => {
      const onTool = vi.fn();
      renderUI(<CommandBar enabledTools={['fillet', 'chamfer']} onTool={onTool} />);
      screen.getByRole('button', { name: 'Fillet, Modify tools' }).focus();
      await userEvent.keyboard('{Enter}');
      await vi.waitFor(() =>
        expect(screen.getByRole('button', { name: /Fillet/, pressed: false })).toHaveFocus(),
      );
      await userEvent.keyboard('{ArrowDown}{ArrowDown}');
      const shell = screen.getByRole('button', { name: /Shell/ });
      expect(shell).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      expect(onTool).not.toHaveBeenCalled();
    });
  });

  describe('touch on a desktop', () => {
    const press = (el: Element, y: number, pointerType = 'touch') =>
      fireEvent.pointerDown(el, { pointerType, clientX: 10, clientY: y, pointerId: 1 });

    it('a long press opens the flyout (and the click that follows keeps it open)', () => {
      vi.useFakeTimers();
      renderUI(<CommandBar enabledTools={ALL} />);
      const solid = screen.getByRole('button', { name: 'Extrude, Solid tools' });
      press(solid, 100);
      expect(screen.queryByTestId('tool-flyout')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByTestId('tool-flyout')).toBeInTheDocument();
      fireEvent.pointerUp(solid);
      fireEvent.click(solid);
      expect(screen.getByTestId('tool-flyout')).toBeInTheDocument();
    });

    it('a quick touch tap is a click and opens it once', () => {
      vi.useFakeTimers();
      renderUI(<CommandBar enabledTools={ALL} />);
      const solid = screen.getByRole('button', { name: 'Extrude, Solid tools' });
      press(solid, 100);
      fireEvent.pointerUp(solid);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('tool-flyout')).toBeNull(); // timer cleared by the release
      fireEvent.click(solid);
      expect(screen.getByTestId('tool-flyout')).toBeInTheDocument();
    });

    it('dragging up opens the flyout; releasing over a tool picks it', () => {
      const onTool = vi.fn();
      renderUI(<CommandBar enabledTools={ALL} onTool={onTool} />);
      const solid = screen.getByRole('button', { name: 'Extrude, Solid tools' });
      press(solid, 100);
      fireEvent.pointerMove(solid, {
        pointerType: 'touch',
        clientX: 10,
        clientY: 70,
        pointerId: 1,
      });
      const flyout = screen.getByTestId('tool-flyout');
      const target = within(flyout).getByRole('button', { name: /^Revolve(?!d)/ });
      const original = document.elementFromPoint;
      document.elementFromPoint = () => target;
      try {
        fireEvent.pointerUp(document, { pointerType: 'touch', clientX: 10, clientY: 20 });
      } finally {
        document.elementFromPoint = original;
      }
      expect(onTool).toHaveBeenCalledExactlyOnceWith('revolve');
      expect(screen.queryByTestId('tool-flyout')).toBeNull();
    });

    it('mouse presses do not start the hold', () => {
      vi.useFakeTimers();
      renderUI(<CommandBar enabledTools={ALL} />);
      press(screen.getByRole('button', { name: 'Extrude, Solid tools' }), 100, 'mouse');
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(screen.queryByTestId('tool-flyout')).toBeNull();
    });
  });

  it('More opens the palette', async () => {
    const onMore = vi.fn();
    renderUI(<CommandBar enabledTools={ALL} onMore={onMore} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(onMore).toHaveBeenCalled();
  });
});

describe('M3 tool groups', () => {
  const ids = (g: string) => toolGroups.find((x) => x.id === g)?.tools;

  it('puts the M3 tools in their categories', () => {
    expect(ids('solid')).toEqual([
      'extrude',
      'extrudeCut',
      'revolve',
      'revolveCut',
      'pushPull',
      'sweep',
      'loft',
    ]);
    expect(ids('modify')).toEqual(['fillet', 'chamfer', 'shell', 'draft', 'thread']);
    expect(ids('hole')).toEqual(['hole']);
    expect(ids('pattern')).toEqual(['mirror', 'linearPattern', 'circularPattern']);
    expect(ids('reference')).toEqual(['plane', 'axis', 'point']);
  });

  it('has no coming-in hints left, and no legacy catch-all pattern tool', () => {
    expect(tools.some((t) => t.comingIn)).toBe(false);
    expect(tools.some((t) => (t.id as string) === 'pattern')).toBe(false);
  });

  it('shortcuts are unique and clear of the reserved keys', () => {
    const keys = tools.flatMap((t) => (t.shortcut ? [t.shortcut] : []));
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(reservedKeys).not.toContain(k);
    // the PLAN 9.4 keys keep their tools
    expect(Object.fromEntries(tools.map((t) => [t.id, t.shortcut]))).toMatchObject({
      sketch: 'S',
      extrude: 'E',
      revolve: 'R',
      fillet: 'F',
      chamfer: 'C',
      measure: 'M',
    });
  });

  it('the Reference flyout lists plane, axis and point and runs them', async () => {
    const onTool = vi.fn();
    renderUI(<CommandBar enabledTools={ALL} onTool={onTool} />);
    await userEvent.click(screen.getByRole('button', { name: 'Plane, Reference tools' }));
    const fly = within(screen.getByRole('group', { name: 'Reference tools' }));
    expect(fly.getAllByRole('button').map((b) => b.getAttribute('data-tool'))).toEqual([
      'plane',
      'axis',
      'point',
    ]);
    await userEvent.click(fly.getByRole('button', { name: /Axis/ }));
    expect(onTool).toHaveBeenCalledExactlyOnceWith('axis');
  });

  it('the Pattern flyout lists mirror, linear and circular', async () => {
    renderUI(<CommandBar enabledTools={ALL} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mirror, Pattern tools' }));
    const fly = within(screen.getByRole('group', { name: 'Pattern tools' }));
    for (const n of [/Mirror/, /Linear pattern/, /Circular pattern/])
      expect(fly.getByRole('button', { name: n })).toBeInTheDocument();
  });

  it('the tablet rail renders the same groups, including Reference and Pattern', () => {
    renderUI(<ToolRail enabledTools={ALL} />);
    const rail = screen.getByRole('toolbar', { name: 'Modeling tools' });
    for (const g of toolGroups)
      expect(rail.querySelector(`[data-tool-group="${g.id}"]`)).not.toBeNull();
  });

  it('cut tools sit next to extrude and revolve with their own labels and shortcuts', () => {
    const t = (id: string) => tools.find((x) => x.id === id);
    expect(t('extrudeCut')).toMatchObject({ label: 'Extruded cut', shortcut: '⇧E' });
    expect(t('revolveCut')).toMatchObject({ label: 'Revolved cut', shortcut: '⇧R' });
    expect(t('extrudeCut')?.Icon).not.toBe(t('extrude')?.Icon);
    expect(t('revolveCut')?.Icon).not.toBe(t('revolve')?.Icon);
  });

  it('the rail shows a chevron on every multi-tool group, and labels in the flyout', async () => {
    renderUI(<ToolRail enabledTools={ALL} />);
    const solid = screen.getByRole('button', { name: 'Solid tools' });
    expect(within(solid).getByTestId('group-chevron')).toBeInTheDocument();
    await userEvent.click(solid);
    const fly = within(screen.getByTestId('tool-flyout'));
    expect(fly.getByText('Revolved cut')).toBeInTheDocument();
    expect(fly.getByText('Revolve')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sketch' }).querySelector('[data-testid="group-chevron"]'),
    ).toBeNull();
  });
});
