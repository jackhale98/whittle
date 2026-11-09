import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KernelStatus } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { extrudeSample, sampleFeatures, sampleParams, sampleStatuses } from '../harness/fixtures';
import { AppShell, FeatureInspector, type ToolId } from '../src';
import { makeEvaluator } from './helpers';

const ready: KernelStatus = {
  state: 'ready',
  info: { variant: 'threaded', occtVersion: '8.0.1', buildId: 'x', initMs: 800 },
};
const base = { documentName: 'Part 1', kernelStatus: ready, viewport: <canvas /> };
const evaluate = makeEvaluator(sampleParams);

describe('shells with data', () => {
  it('desktop: Features and Params tabs render the data-driven components', async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        tier="desktop"
        {...base}
        featureTree={{
          features: sampleFeatures,
          statuses: sampleStatuses,
          rollbackIndex: 5,
          onRollback: () => {},
        }}
        paramsTable={{ params: sampleParams, evaluate: (e) => evaluate(e) }}
      />,
    );
    expect(screen.getByRole('tree', { name: 'Features' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Rollback bar' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Params' }));
    expect(await screen.findByRole('list', { name: 'Parameters' })).toBeInTheDocument();
  });

  it('desktop: the inspector slot hosts the inspector', () => {
    render(
      <AppShell
        tier="desktop"
        {...base}
        inspector={
          <FeatureInspector feature={extrudeSample} evaluate={evaluate} onChange={() => {}} />
        }
      />,
    );
    const slot = within(screen.getByTestId('right-panel')).getByTestId('inspector-slot');
    expect(within(slot).getByRole('heading', { name: 'Extrude 1' })).toBeInTheDocument();
  });

  it('command bar tools are disabled until enabledTools wires them', async () => {
    const user = userEvent.setup();
    const onTool = vi.fn();
    const { unmount } = render(<AppShell tier="desktop" {...base} onTool={onTool} />);
    // Categories open flyouts; the tools inside are disabled with their own hint.
    await user.click(screen.getByRole('button', { name: 'Extrude, Solid tools' }));
    const extrude0 = within(screen.getByRole('group', { name: 'Solid tools' })).getByRole(
      'button',
      { name: /Extrude/ },
    );
    expect(extrude0).toHaveAttribute('aria-disabled', 'true');
    await user.click(extrude0);
    expect(onTool).not.toHaveBeenCalled();
    unmount();

    const enabled: ToolId[] = ['sketch', 'extrude'];
    render(
      <AppShell
        tier="desktop"
        {...base}
        enabledTools={enabled}
        activeTool="extrude"
        onTool={onTool}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Extrude, Solid tools' }));
    const solid = within(screen.getByRole('group', { name: 'Solid tools' }));
    const extrude = solid.getByRole('button', { name: /Extrude/ });
    expect(extrude).not.toHaveAttribute('aria-disabled');
    expect(extrude).toHaveAttribute('aria-pressed', 'true');
    await user.click(extrude);
    expect(onTool).toHaveBeenCalledWith('extrude');
    await user.click(screen.getByRole('button', { name: 'Fillet, Modify tools' }));
    expect(
      within(screen.getByRole('group', { name: 'Modify tools' })).getByRole('button', {
        name: /Fillet/,
      }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('Export becomes the options popover and emits onExportRequest', async () => {
    const user = userEvent.setup();
    const onExportRequest = vi.fn();
    render(<AppShell tier="desktop" {...base} onExportRequest={onExportRequest} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('button', { name: 'Export STEP' }));
    expect(onExportRequest).toHaveBeenCalledWith({
      target: 'step',
      options: { stepSchema: 'AP214' },
    });
  });

  it('plain Export still calls onExport when no request handler is given', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(<AppShell tier="desktop" {...base} onExport={onExport} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalled();
  });

  it('tablet: history sheet shows the feature count and the tree', async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        tier="tablet"
        {...base}
        featureTree={{ features: sampleFeatures, statuses: sampleStatuses }}
        paramsTable={{ params: sampleParams, evaluate: (e) => evaluate(e) }}
      />,
    );
    expect(screen.getByText('· 6 features')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /History, expand/ }));
    expect(screen.getByRole('tree', { name: 'Features' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Params' }));
    expect(await screen.findByRole('list', { name: 'Parameters' })).toBeInTheDocument();
  });

  it('phone: params and export tabs render the real components', async () => {
    const user = userEvent.setup();
    const onExportRequest = vi.fn();
    render(
      <AppShell
        tier="phone"
        {...base}
        paramsTable={{ params: sampleParams, evaluate: (e) => evaluate(e) }}
        onExportRequest={onExportRequest}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Params' }));
    expect(await screen.findByRole('list', { name: 'Parameters' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('button', { name: 'Export STEP' }));
    expect(onExportRequest).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  });
});
