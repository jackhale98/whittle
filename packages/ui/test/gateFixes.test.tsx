import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuntimeDiagnostics } from '@wren-cad/contracts';
import { describe, expect, it, vi } from 'vitest';
import { sampleParams } from '../harness/fixtures';
import { AppShell, ChamferIcon, DimensionLabel, featureMeta, tools } from '../src';
import { makeEvaluator, renderUI } from './helpers';

const evaluate = makeEvaluator(sampleParams);

describe('dimension label actions (M1 gate)', () => {
  it('Enter on an unchanged value closes the editor; R/Ø and reference toggles are offered', async () => {
    const onCancel = vi.fn();
    const onToggleKind = vi.fn();
    const onToggleDriving = vi.fn();
    renderUI(
      <DimensionLabel
        x={0}
        y={0}
        kind="diameter"
        expr="8mm"
        driving
        autoEdit
        evaluate={(e) => evaluate(e, 'length')}
        onCancel={onCancel}
        onToggleKind={onToggleKind}
        onToggleDriving={onToggleDriving}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show as radius' }));
    expect(onToggleKind).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'diameter dimension' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('textbox', { name: 'diameter dimension' }));
    await userEvent.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a selected reference dimension offers "Driving"', async () => {
    const onToggleDriving = vi.fn();
    renderUI(
      <DimensionLabel
        x={0}
        y={0}
        kind="length"
        expr="5mm"
        driving={false}
        measured="5.00"
        selected
        onToggleDriving={onToggleDriving}
      />,
    );
    expect(screen.getByRole('button', { name: /Reference dimension/ })).toHaveTextContent('(5.00)');
    await userEvent.click(screen.getByRole('button', { name: 'Make driving dimension' }));
    expect(onToggleDriving).toHaveBeenCalledOnce();
  });
});

describe('shell polish (M1 gate)', () => {
  it('the desktop Runtime block is collapsed by default and opens on demand', async () => {
    const d: RuntimeDiagnostics = {
      tier: 'desktop',
      crossOriginIsolated: true,
      kernelVariant: 'threaded',
      renderBackend: 'webgl2',
      hardwareConcurrency: 8,
      primaryPointer: 'fine',
      serviceWorker: 'active',
      appVersion: '0.1.0+test',
    };
    render(
      <AppShell
        tier="desktop"
        documentName="Part"
        kernelStatus={{ state: 'idle' }}
        viewport={<canvas />}
        diagnostics={d}
      />,
    );
    const details = screen.getByTestId('runtime-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent('threaded · webgl2');
    await userEvent.click(screen.getByText('Runtime'));
    expect(details.open).toBe(true);
    expect(screen.getByTestId('diagnostics')).toBeVisible();
  });

  it('Chamfer has its own icon, distinct from Sketch', () => {
    expect(tools.find((t) => t.id === 'chamfer')?.Icon).toBe(ChamferIcon);
    expect(featureMeta.chamfer.Icon).toBe(ChamferIcon);
    expect(featureMeta.chamfer.Icon).not.toBe(featureMeta.sketch.Icon);
  });
});
