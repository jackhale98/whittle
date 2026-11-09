import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KernelStatus } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { AppShell, describeKernelStatus, resolveTransition, StatusChip, springs } from '../src';

const ready: KernelStatus = {
  state: 'ready',
  info: { variant: 'threaded', occtVersion: '8.0.1', buildId: 'x', initMs: 800 },
};

describe('StatusChip', () => {
  it('idle', () => {
    render(<StatusChip status={{ state: 'idle' }} />);
    const chip = screen.getByRole('status');
    expect(chip).toHaveAttribute('data-state', 'idle');
    expect(chip).toHaveTextContent('Kernel idle');
  });

  it('downloading with a known total shows percent and sizes', () => {
    render(
      <StatusChip status={{ state: 'downloading', loaded: 25 * 1048576, total: 100 * 1048576 }} />,
    );
    const chip = screen.getByRole('status');
    expect(chip).toHaveAttribute('data-state', 'downloading');
    expect(chip).toHaveTextContent('Downloading kernel 25%');
    expect(chip).toHaveTextContent('25.0 / 100.0 MB');
  });

  it('downloading with an unknown total is indeterminate', () => {
    const d = describeKernelStatus({ state: 'downloading', loaded: 2 * 1048576 });
    expect(d.progress).toBeNull();
    expect(d.label).toBe('Downloading kernel');
    expect(d.detail).toBe('2.0 MB');
  });

  it('clamps progress to 0..100%', () => {
    expect(describeKernelStatus({ state: 'downloading', loaded: 5, total: 1 }).progress).toBe(1);
  });

  it('compiling', () => {
    render(<StatusChip status={{ state: 'compiling' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Compiling kernel');
  });

  it('ready shows variant and OCCT version, compact hides the detail', () => {
    const { rerender } = render(<StatusChip status={ready} />);
    expect(screen.getByRole('status')).toHaveTextContent('threaded · OCCT 8.0.1');
    rerender(<StatusChip status={ready} compact />);
    expect(screen.getByRole('status')).not.toHaveTextContent('OCCT');
    expect(screen.getByRole('status')).toHaveTextContent('Kernel ready');
  });

  it('error is an alert carrying the message and hint', () => {
    render(
      <StatusChip
        status={{
          state: 'error',
          error: { code: 'INTERNAL', message: 'Boom.', hint: 'Reload.' },
        }}
      />,
    );
    const chip = screen.getByRole('alert');
    expect(chip).toHaveAttribute('data-state', 'error');
    expect(chip).toHaveTextContent('Kernel error');
    expect(chip).toHaveTextContent('Boom. Reload.');
  });
});

describe('AppShell', () => {
  const base = {
    documentName: 'Part 1',
    kernelStatus: ready,
    viewport: <canvas data-testid="cv" />,
  };

  it.each(['desktop', 'tablet', 'phone'] as const)(
    'renders the %s shell with a viewport slot',
    (tier) => {
      render(<AppShell tier={tier} {...base} />);
      const root = screen.getByTestId('app-shell');
      expect(root).toHaveAttribute('data-tier', tier);
      const slot = screen.getByTestId('viewport-slot');
      expect(within(slot).getByTestId('cv')).toBeInTheDocument();
      expect(screen.getByTestId('document-name')).toHaveTextContent('Part 1');
      expect(screen.getByTestId('kernel-status')).toBeInTheDocument();
    },
  );

  it('desktop has the left panel and inspector; phone/tablet do not', () => {
    const { unmount } = render(<AppShell tier="desktop" {...base} />);
    expect(screen.getByTestId('left-panel')).toBeInTheDocument();
    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
    unmount();
    render(<AppShell tier="phone" {...base} />);
    expect(screen.queryByTestId('left-panel')).toBeNull();
  });

  it('opens the command palette with Ctrl+K and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(<AppShell tier="desktop" {...base} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports theme changes', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(<AppShell tier="desktop" {...base} theme="light" onThemeChange={(t) => seen.push(t)} />);
    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(seen).toEqual(['dark']);
  });
});

describe('motion presets', () => {
  it('fast ~180ms, standard ~260ms', () => {
    expect(springs.fast.duration).toBeCloseTo(0.18);
    expect(springs.standard.duration).toBeCloseTo(0.26);
  });
  it('collapse to instant when reduced motion is requested', () => {
    expect(resolveTransition('fast', true)).toEqual({ duration: 0 });
    expect(resolveTransition('standard', false)).toBe(springs.standard);
  });
});
