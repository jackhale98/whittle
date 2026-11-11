import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configColumns,
  configDefault,
  configMaterials,
  configRows,
  configSummaries,
  manyRows,
} from '../harness/configFixtures';
import { makeEvaluator } from '../harness/fixtures';
import {
  ChangedInAllNotice,
  type ConfigColumn,
  ConfigurationPill,
  type ConfigurationPillProps,
  type ConfigurationTableProps,
  configTargetKey,
  FeatureTree,
  type FeatureTreeConfiguration,
  type FeatureTreeItem,
  OverrideMarker,
  ScopeChip,
  useOneShotScope,
} from '../src';
import ConfigurationTable from '../src/config/ConfigurationTable';
import { renderUI } from './helpers';

afterEach(() => vi.useRealTimers());

/* ------------------------------------------------------------------------- pill */

function pill(over: Partial<ConfigurationPillProps> = {}) {
  const props: ConfigurationPillProps = {
    configurations: configSummaries,
    activeId: null,
    defaultStatus: 'ok',
    onSwitch: vi.fn(),
    onCreate: vi.fn(),
    onManage: vi.fn(),
    ...over,
  };
  return { props, ...renderUI(<ConfigurationPill {...props} />) };
}
const trigger = () => screen.getByTestId('configuration-pill');

describe('ConfigurationPill', () => {
  it('always shows the active name; only off-Default configurations carry the tint', () => {
    const a = pill();
    expect(trigger()).toHaveTextContent('Default');
    expect(trigger()).not.toHaveAttribute('data-off-default');
    a.unmount();
    pill({ activeId: 'c-long' });
    expect(trigger()).toHaveTextContent('Long');
    expect(trigger()).toHaveAttribute('data-off-default');
    expect(trigger()).toHaveAccessibleName(/Configuration: Long/);
  });

  it('names a failing active configuration in its label', () => {
    pill({ activeId: 'c-tall' });
    expect(trigger()).toHaveAccessibleName(/Failed/);
  });

  it('one tap opens the list with a status per configuration; picking switches', async () => {
    const { props } = pill();
    await userEvent.click(trigger());
    const list = await screen.findByTestId('configuration-list');
    expect(within(list).getAllByText('OK')).toHaveLength(2);
    expect(within(list).getByText('Needs attention')).toBeInTheDocument();
    expect(within(list).getByText('Failed')).toBeInTheDocument();
    expect(within(list).getByText('Not yet built')).toBeInTheDocument();
    expect(screen.getByTestId('config-row-default')).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByTestId('config-row-c-steel'));
    expect(props.onSwitch).toHaveBeenCalledWith('c-steel');
    expect(screen.queryByTestId('configuration-list')).toBeNull();
  });

  it('switching to Default sends null; picking the active one sends nothing', async () => {
    const { props } = pill({ activeId: 'c-long' });
    await userEvent.click(trigger());
    await userEvent.click(screen.getByTestId('config-row-c-long'));
    expect(props.onSwitch).not.toHaveBeenCalled();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByTestId('config-row-default'));
    expect(props.onSwitch).toHaveBeenCalledWith(null);
  });

  it('New configuration: inline name, From Default / Active (Active preselected)', async () => {
    const { props } = pill({ activeId: 'c-long' });
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole('button', { name: 'New configuration…' }));
    const name = screen.getByRole('textbox', { name: 'New configuration name' });
    expect(name).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'From Active' })).toBeChecked();
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-modal');
    await userEvent.type(name, 'Wide{Enter}');
    expect(props.onCreate).toHaveBeenCalledWith({ name: 'Wide', from: 'active' });
    expect(screen.queryByTestId('configuration-list')).toBeNull();
  });

  it('can create from Default, and refuses empty or duplicate names', async () => {
    const { props } = pill();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole('button', { name: 'New configuration…' }));
    const name = screen.getByRole('textbox', { name: 'New configuration name' });
    await userEvent.type(name, 'long');
    expect(screen.getByRole('alert')).toHaveTextContent('already exists'.replace('already ', ''));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(props.onCreate).not.toHaveBeenCalled();
    await userEvent.clear(name);
    await userEvent.type(name, 'Short');
    await userEvent.click(screen.getByRole('radio', { name: 'From Default' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(props.onCreate).toHaveBeenCalledWith({ name: 'Short', from: 'default' });
  });

  it('Manage… calls back and closes', async () => {
    const { props } = pill();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole('button', { name: 'Manage…' }));
    expect(props.onManage).toHaveBeenCalled();
    expect(screen.queryByTestId('configuration-list')).toBeNull();
  });

  it('the phone chip only switches', async () => {
    pill({ variant: 'chip', size: 'touch' });
    await userEvent.click(trigger());
    expect(await screen.findByTestId('configuration-list')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New configuration…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage…' })).toBeNull();
  });

  it('Escape closes the list and arrows move between rows', async () => {
    pill();
    await userEvent.click(trigger());
    await screen.findByTestId('configuration-list');
    await waitFor(() => expect(screen.getByTestId('config-row-default')).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByTestId('config-row-c-long')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('configuration-list')).toBeNull();
  });
});

/* ------------------------------------------------------------------------- table */

function table(over: Partial<ConfigurationTableProps> = {}) {
  const props: ConfigurationTableProps = {
    columns: configColumns,
    rows: configRows,
    defaultRow: configDefault,
    activeId: 'c-long',
    onEdit: vi.fn(),
    onPaste: vi.fn(),
    onJumpToField: vi.fn(),
    onActivate: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    evaluate: makeEvaluator([]),
    materials: configMaterials,
    ...over,
  };
  return { props, ...renderUI(<ConfigurationTable {...props} />) };
}
const key = (i: number) => configTargetKey((configColumns[i] as ConfigColumn).target);
const cellBtn = (r: number, c: number) =>
  screen.getByTestId(`cell-${r}-${c}`).querySelector('[data-cell]') as HTMLElement;

describe('ConfigurationTable', () => {
  it('shows a row per configuration with status, mass and the active mark', () => {
    table();
    const grid = screen.getByRole('table', { name: 'Configuration values' });
    for (const n of ['Default', 'Long', 'Steel', 'Tall', 'Prototype'])
      expect(within(grid).getByRole('rowheader', { name: new RegExp(n) })).toBeInTheDocument();
    expect(within(grid).getByText('Needs attention')).toBeInTheDocument();
    expect(within(grid).getByText('168.4 g')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('row-c-long').querySelector('th') as HTMLElement).getByText(
        'Active',
      ),
    ).toBeInTheDocument();
  });

  it('highlights cells that differ from Default, and only those', () => {
    table();
    const overridden = Array.from(document.querySelectorAll('[data-overridden]'));
    // Long: width, hole size, part number; Steel: material, fillet; Prototype: height
    expect(overridden).toHaveLength(6);
    expect(screen.getByTestId('cell-1-0')).toHaveAttribute('data-overridden');
    expect(screen.getByTestId('cell-0-0')).not.toHaveAttribute('data-overridden');
    expect(screen.getByTestId('cell-2-0')).not.toHaveAttribute('data-overridden');
  });

  it('plain numbers show their unit; inherited values and placeholders are shown', () => {
    table();
    expect(cellBtn(0, 0)).toHaveTextContent('40 mm');
    expect(cellBtn(1, 1)).toHaveTextContent('20 mm'); // inherited
    expect(cellBtn(1, 3)).toHaveTextContent('M6 clearance'); // option label
    expect(cellBtn(3, 6)).toHaveTextContent('BR-100'); // inherited part number
  });

  it('edits a cell inline with an expression and emits one edit', async () => {
    const { props } = table();
    cellBtn(1, 0).focus();
    await userEvent.keyboard('{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Long, Width' });
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, '2 * 45 mm{Enter}');
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onEdit).toHaveBeenCalledWith([
      { configurationId: 'c-long', target: { kind: 'param', paramId: 'p-w' }, value: '2 * 45 mm' },
    ]);
    // the editor closes and focus returns to the cell
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Long, Width' })).toBeNull());
    expect(cellBtn(1, 0)).toHaveFocus();
  });

  it('keeps an invalid expression on screen instead of discarding it', async () => {
    const { props } = table();
    cellBtn(1, 0).focus();
    await userEvent.keyboard('{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Long, Width' });
    await userEvent.clear(input);
    await userEvent.type(input, '3 +* ');
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'Long, Width' })).toBeInTheDocument();
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('Escape cancels an edit', async () => {
    const { props } = table();
    cellBtn(2, 0).focus();
    await userEvent.keyboard('{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Steel, Width' });
    await userEvent.type(input, '9');
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it("editing an inherited cell to Default's own value creates no override", async () => {
    const { props } = table();
    cellBtn(2, 0).focus();
    await userEvent.keyboard('{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Steel, Width' });
    await userEvent.clear(input);
    await userEvent.type(input, '40 mm{Enter}');
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('editing the Default row edits Default (configurationId null)', async () => {
    const { props } = table();
    cellBtn(0, 1).focus();
    await userEvent.keyboard('{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Default, Height' });
    await userEvent.clear(input);
    await userEvent.type(input, '22 mm{Enter}');
    expect(props.onEdit).toHaveBeenCalledWith([
      { configurationId: null, target: { kind: 'param', paramId: 'p-h' }, value: '22 mm' },
    ]);
  });

  it('Reset to default on an overridden cell clears the override (no value)', async () => {
    const { props } = table();
    await userEvent.click(screen.getByRole('button', { name: 'Reset Long, Width to default' }));
    expect(props.onEdit).toHaveBeenCalledWith([
      { configurationId: 'c-long', target: { kind: 'param', paramId: 'p-w' } },
    ]);
    // inherited cells have no reset
    expect(screen.queryByRole('button', { name: 'Reset Long, Height to default' })).toBeNull();
  });

  it('Delete resets the focused overridden cell', async () => {
    const { props } = table();
    cellBtn(1, 3).focus();
    await userEvent.keyboard('{Delete}');
    expect(props.onEdit).toHaveBeenCalledWith([
      { configurationId: 'c-long', target: { kind: 'field', featureId: 'h1', path: '/size' } },
    ]);
  });

  it("toggles a suppression cell in place, and shows every configuration's state", async () => {
    const { props } = table();
    expect(cellBtn(0, 4)).toHaveTextContent('Active');
    expect(cellBtn(2, 4)).toHaveTextContent('Suppressed');
    expect(cellBtn(1, 4)).toHaveTextContent('Active'); // inherited
    await userEvent.click(cellBtn(1, 4));
    expect(props.onEdit).toHaveBeenCalledWith([
      { configurationId: 'c-long', target: { kind: 'suppressed', featureId: 'f1' }, value: true },
    ]);
  });

  it('option and material cells edit with a select', async () => {
    const { props } = table();
    cellBtn(3, 3).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Tall, Hole 1 size' }),
      'M5',
    );
    expect(props.onEdit).toHaveBeenLastCalledWith([
      {
        configurationId: 'c-tall',
        target: { kind: 'field', featureId: 'h1', path: '/size' },
        value: 'M5',
      },
    ]);
    cellBtn(1, 5).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Long, Material' }),
      'wren:steel-1018',
    );
    expect(props.onEdit).toHaveBeenLastCalledWith([
      {
        configurationId: 'c-long',
        target: { kind: 'material' },
        value: expect.objectContaining({ libraryId: 'wren:steel-1018' }),
      },
    ]);
  });

  it('double-click on a feature-field cell jumps to the field; Alt+Enter too', async () => {
    const { props } = table();
    await userEvent.dblClick(cellBtn(1, 2));
    expect(props.onJumpToField).toHaveBeenCalledWith('e1', '/end/depth');
    cellBtn(1, 3).focus();
    await userEvent.keyboard('{Alt>}{Enter}{/Alt}');
    expect(props.onJumpToField).toHaveBeenLastCalledWith('h1', '/size');
    // a parameter cell is not a feature field: double-click edits it
    await userEvent.dblClick(cellBtn(1, 0));
    expect(await screen.findByRole('textbox', { name: 'Long, Width' })).toBeInTheDocument();
    expect(props.onJumpToField).toHaveBeenCalledTimes(2);
  });

  it('transposes: configurations become columns, and back', async () => {
    table();
    const toggle = screen.getByTestId('transpose');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('columnheader', { name: /Long/ })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('columnheader', { name: /Long/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Width/ })).toBeInTheDocument();
    // the same cell, still addressed by (configuration, field)
    expect(cellBtn(1, 0)).toHaveTextContent('80 mm');
    await userEvent.click(toggle);
    expect(screen.queryByRole('columnheader', { name: /Long/ })).toBeNull();
  });

  it('arrow keys follow the layout, also when transposed', async () => {
    table();
    cellBtn(0, 0).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(cellBtn(1, 0)).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(cellBtn(1, 1)).toHaveFocus();
    await userEvent.click(screen.getByTestId('transpose'));
    cellBtn(1, 1).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(cellBtn(1, 2)).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(cellBtn(2, 2)).toHaveFocus();
  });

  it('collapses and expands column groups', async () => {
    table();
    expect(screen.getByRole('columnheader', { name: /Width/ })).toBeInTheDocument();
    const g = screen.getByTestId('group-parameters');
    expect(g).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(g);
    expect(g).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('columnheader', { name: /Width/ })).toBeNull();
    expect(screen.queryByTestId('cell-1-0')?.textContent).not.toContain('80 mm');
    // other groups stay
    expect(screen.getByTestId('group-suppression')).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(g);
    expect(screen.getByRole('columnheader', { name: /Width/ })).toBeInTheDocument();
  });

  it('collapsed groups can be controlled by the app', async () => {
    const onChange = vi.fn();
    table({ collapsedGroups: ['material'], onCollapsedGroupsChange: onChange });
    expect(screen.getByTestId('group-material')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByTestId('group-parameters'));
    expect(onChange).toHaveBeenCalledWith(['material', 'parameters']);
  });

  it('pastes a TSV block as one batch: creates configurations and updates cells', () => {
    const { props } = table();
    const region = screen
      .getByTestId('configuration-table')
      .querySelector('[role="presentation"]') as HTMLElement;
    cellBtn(1, 0).focus();
    fireEvent.paste(region, {
      clipboardData: {
        getData: () =>
          '\tWidth\tHeight\nLong\t90 mm\t25 mm\nShort\t30 mm\t10 mm\nTall\t45 mm\t20 mm',
      },
    });
    expect(props.onPaste).toHaveBeenCalledTimes(1);
    const plan = vi.mocked(props.onPaste).mock.calls[0]?.[0];
    expect(plan?.create).toEqual(['Short']);
    expect(plan?.edits).toHaveLength(5);
    expect(screen.getByTestId('paste-note')).toHaveTextContent(
      'Pasted 5 cells, created 1 configuration',
    );
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('reports pasted cells it cannot apply and calls nothing when none apply', () => {
    const { props } = table({ evaluate: makeEvaluator([]) });
    const region = screen
      .getByTestId('configuration-table')
      .querySelector('[role="presentation"]') as HTMLElement;
    fireEvent.paste(region, { clipboardData: { getData: () => '\tWidth\nLong\t(((' } });
    expect(props.onPaste).not.toHaveBeenCalled();
    expect(screen.getByTestId('paste-note')).toHaveTextContent('Nothing pasted');
    expect(screen.getByRole('listitem')).toBeInTheDocument();
  });

  it('a single pasted value goes to the focused cell', () => {
    const { props } = table();
    const region = screen
      .getByTestId('configuration-table')
      .querySelector('[role="presentation"]') as HTMLElement;
    act(() => cellBtn(2, 0).focus());
    fireEvent.paste(region, { clipboardData: { getData: () => '55 mm' } });
    expect(props.onEdit).toHaveBeenCalledWith([
      { configurationId: 'c-steel', target: { kind: 'param', paramId: 'p-w' }, value: '55 mm' },
    ]);
  });

  it('row actions: make active, rename, remove', async () => {
    const { props } = table();
    await userEvent.click(screen.getByRole('button', { name: 'Make Steel active' }));
    expect(props.onActivate).toHaveBeenCalledWith('c-steel');
    await userEvent.dblClick(screen.getByText('Tall'));
    const input = screen.getByRole('textbox', { name: 'Rename Tall' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Taller{Enter}');
    expect(props.onRename).toHaveBeenCalledWith('c-tall', 'Taller');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Prototype' }));
    expect(props.onRemove).toHaveBeenCalledWith('c-new');
  });

  it('windows a 50-configuration table instead of rendering every row', () => {
    const wide: ConfigColumn[] = Array.from({ length: 30 }, (_, i) => ({
      target: { kind: 'param', paramId: `p${i}` },
      label: `P${i}`,
      kind: 'expr' as const,
    }));
    const t0 = performance.now();
    table({ columns: wide, rows: manyRows(50), defaultRow: { values: {} } });
    const rowsShown = document.querySelectorAll('tbody tr[data-testid]').length;
    expect(rowsShown).toBeLessThan(51);
    expect(rowsShown).toBeGreaterThan(10);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '53');
  });

  it('does not use a dialog and every key stays addressable by configTargetKey', () => {
    table();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(key(0)).toBe('param:p-w');
  });
});

/* ------------------------------------------------------------------------- markers and scope */

describe('OverrideMarker', () => {
  it('renders nothing when not overridden', () => {
    const { container } = renderUI(<OverrideMarker overridden={false} configurationName="Long" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('names the configuration and resets', async () => {
    const onReset = vi.fn();
    renderUI(
      <OverrideMarker overridden configurationName="Long" fieldLabel="Width" onReset={onReset} />,
    );
    expect(screen.getByTestId('override-marker')).toHaveTextContent('Override in Long');
    await userEvent.click(screen.getByRole('button', { name: 'Reset Width to default' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
  it('is only a badge without onReset', () => {
    renderUI(<OverrideMarker overridden configurationName="Long" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

function ScopeHost({
  activeIsDefault = false,
  configId = 'c1',
  commit,
}: {
  activeIsDefault?: boolean;
  configId?: string;
  commit(s: string): void;
}) {
  const one = useOneShotScope(activeIsDefault, configId);
  return (
    <div>
      <ScopeChip
        configurationName="Long"
        activeIsDefault={activeIsDefault}
        scope={one.scope}
        onScopeChange={one.setScope}
      />
      <button type="button" onClick={() => commit(one.consume())}>
        commit
      </button>
      <button type="button" onClick={() => commit(one.resolve(false))}>
        peek
      </button>
    </div>
  );
}

describe('ScopeChip (one-shot scope, trap T1)', () => {
  it('is hidden while Default is active', () => {
    renderUI(<ScopeHost activeIsDefault commit={() => {}} />);
    expect(screen.queryByTestId('scope-chip')).toBeNull();
  });

  it('applies to one edit and never persists', async () => {
    const commit = vi.fn();
    renderUI(<ScopeHost commit={commit} />);
    const chip = screen.getByRole('button', { name: 'This configuration only' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'commit' }));
    expect(commit).toHaveBeenLastCalledWith('configuration');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'commit' }));
    expect(commit).toHaveBeenLastCalledWith('all');
  });

  it('toggling off, and switching configuration, drop the choice', async () => {
    const commit = vi.fn();
    const view = renderUI(<ScopeHost commit={commit} />);
    const chip = screen.getByTestId('scope-chip');
    await userEvent.click(chip);
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole('button', { name: 'commit' }));
    expect(commit).toHaveBeenLastCalledWith('all');
    await userEvent.click(chip);
    view.rerender(<ScopeHost commit={commit} configId="c2" />);
    await waitFor(() =>
      expect(screen.getByTestId('scope-chip')).toHaveAttribute('aria-pressed', 'false'),
    );
  });

  it('resolve() follows the rule without consuming', async () => {
    const seen: string[] = [];
    renderUI(<ScopeHost commit={(s) => seen.push(s)} />);
    await userEvent.click(screen.getByRole('button', { name: 'peek' }));
    await userEvent.click(screen.getByTestId('scope-chip'));
    await userEvent.click(screen.getByRole('button', { name: 'peek' }));
    await userEvent.click(screen.getByRole('button', { name: 'peek' }));
    expect(seen).toEqual(['all', 'configuration', 'configuration']);
  });
});

describe('ChangedInAllNotice', () => {
  it('says how many configurations changed and offers Undo and Dismiss, without a dialog', async () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    renderUI(<ChangedInAllNotice count={4} onUndo={onUndo} onDismiss={onDismiss} />);
    const n = screen.getByRole('status');
    expect(n).toHaveTextContent('Changed in all 4 configurations');
    await userEvent.click(within(n).getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalled();
    await userEvent.click(within(n).getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('auto-dismisses, and stays while hovered', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    renderUI(
      <ChangedInAllNotice count={2} onUndo={() => {}} onDismiss={onDismiss} autoDismissMs={1000} />,
    );
    const n = screen.getByTestId('changed-in-all');
    fireEvent.pointerEnter(n);
    act(() => void vi.advanceTimersByTime(5000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(n);
    act(() => void vi.advanceTimersByTime(1000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('uses the singular for one', () => {
    renderUI(
      <ChangedInAllNotice count={1} onUndo={() => {}} onDismiss={() => {}} autoDismissMs={0} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Changed in all 1 configuration');
    expect(screen.getByRole('status')).not.toHaveTextContent('configurations');
  });
});

/* ------------------------------------------------------------------------- tree */

const feats: FeatureTreeItem[] = [
  { id: 's1', name: 'Sketch 1', type: 'sketch', suppressed: false },
  { id: 'f1', name: 'Fillet 1', type: 'fillet', suppressed: false },
  { id: 'f2', name: 'Fillet 2', type: 'fillet', suppressed: true },
];

function tree(cfg: Partial<FeatureTreeConfiguration>, actions: 'full' | 'review' = 'full') {
  const configuration: FeatureTreeConfiguration = {
    activeName: 'Long',
    isDefault: false,
    count: 2,
    onSuppress: vi.fn(),
    ...cfg,
  };
  const onSuppress = vi.fn();
  renderUI(
    <FeatureTree
      features={feats}
      actions={actions}
      onSuppress={onSuppress}
      configuration={configuration}
      onSelect={() => {}}
    />,
  );
  return { configuration, onSuppress };
}
const menuFor = async (name: RegExp) => {
  fireEvent.contextMenu(screen.getByRole('treeitem', { name }));
  return screen.findByRole('menu');
};

describe('FeatureTree configuration scope', () => {
  it('full mode offers this-configuration-only and all', async () => {
    const { configuration, onSuppress } = tree({});
    const menu = await menuFor(/^Fillet 1/);
    expect(within(menu).queryByRole('menuitem', { name: 'Suppress' })).toBeNull();
    await userEvent.click(
      within(menu).getByRole('menuitem', { name: /Suppress in this configuration only/ }),
    );
    expect(configuration.onSuppress).toHaveBeenCalledWith('f1', true, 'configuration');
    const menu2 = await menuFor(/^Fillet 1/);
    await userEvent.click(
      within(menu2).getByRole('menuitem', { name: 'Suppress in all configurations' }),
    );
    expect(configuration.onSuppress).toHaveBeenLastCalledWith('f1', true, 'all');
    expect(onSuppress).not.toHaveBeenCalled();
  });

  it('flips to Unsuppress for a suppressed feature, and offers Reset while overridden', async () => {
    const { configuration } = tree({ overriddenSuppression: ['f2'], onResetSuppression: vi.fn() });
    const menu = await menuFor(/^Fillet 2/);
    expect(
      within(menu).getByRole('menuitem', { name: /Unsuppress in this configuration only/ }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(menu).getByRole('menuitem', { name: 'Reset to default suppression' }),
    );
    expect(configuration.onResetSuppression).toHaveBeenCalledWith('f2');
  });

  it('review mode (phone): one clearly labelled item that applies to the active configuration', async () => {
    const { configuration } = tree({}, 'review');
    const menu = await menuFor(/^Fillet 1/);
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items.filter((t) => /Suppress/.test(t ?? ''))).toHaveLength(1);
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Suppress in Long only/ }));
    expect(configuration.onSuppress).toHaveBeenCalledWith('f1', true, 'configuration');
  });

  it('with Default active the one item says all configurations', async () => {
    const { configuration } = tree({ isDefault: true, activeName: 'Default' });
    const menu = await menuFor(/^Fillet 1/);
    await userEvent.click(
      within(menu).getByRole('menuitem', { name: /^Suppress in all configurations/ }),
    );
    expect(configuration.onSuppress).toHaveBeenCalledWith('f1', true, 'all');
  });

  it('without configurations the plain Suppress stays', async () => {
    const { onSuppress } = tree({ count: 0 });
    const menu = await menuFor(/^Fillet 1/);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Suppress' }));
    expect(onSuppress).toHaveBeenCalledWith('f1', true);
  });

  it('marks a row whose suppression the active configuration overrides', () => {
    tree({ overriddenSuppression: ['f1'] });
    const row = screen.getByRole('treeitem', { name: /^Fillet 1/ });
    expect(within(row).getByTestId('suppress-override-marker')).toBeInTheDocument();
    expect(row).toHaveAccessibleName(/Suppression overridden in Long/);
    expect(
      within(screen.getByRole('treeitem', { name: /^Fillet 2/ })).queryByTestId(
        'suppress-override-marker',
      ),
    ).toBeNull();
  });
});

/* A host that keeps the overrides in state, like the app does. */
function Host() {
  const [rows, setRows] = useState(configRows);
  return (
    <ConfigurationTable
      columns={configColumns}
      rows={rows}
      defaultRow={configDefault}
      activeId={null}
      onPaste={() => {}}
      onEdit={(edits) =>
        setRows((rs) =>
          rs.map((r) => {
            const e = edits.find((x) => x.configurationId === r.id);
            if (!e) return r;
            const k = configTargetKey(e.target);
            const { [k]: _gone, ...rest } = r.overrides;
            return {
              ...r,
              overrides: e.value === undefined ? rest : { ...rest, [k]: e.value },
            };
          }),
        )
      }
    />
  );
}

describe('controlled table host', () => {
  it('re-renders from app state after an edit', async () => {
    renderUI(<Host />);
    expect(screen.getByTestId('cell-1-0')).toHaveAttribute('data-overridden');
    await userEvent.click(screen.getByRole('button', { name: 'Reset Long, Width to default' }));
    expect(screen.getByTestId('cell-1-0')).not.toHaveAttribute('data-overridden');
    expect(cellBtn(1, 0)).toHaveTextContent('40 mm');
  });
});
