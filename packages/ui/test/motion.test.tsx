import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_MOTION_SETTINGS, type MotionInputState } from '@wren-cad/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commandForButton,
  DEFAULT_MOTION_BUTTONS,
  MOTION_BUTTONS_KEY,
  MOTION_SETTINGS_KEY,
  MotionButtonMapping,
  MotionDiagnostics,
  MotionSettingsSection,
  motionSettingsReducer,
  pressedEdges,
  readButtonMap,
  readMotionSettings,
  sanitizeButtonMap,
  sanitizeMotionSettings,
  setButtonCommand,
  watchButtons,
  writeButtonMap,
  writeMotionSettings,
} from '../src';
import { renderUI } from './helpers';

const dev = { name: 'Test 3D mouse', vendorId: 1, productId: 2 };
const live: MotionInputState = {
  path: 'webhid',
  state: 'live',
  device: dev,
  buttons: [2],
  last: { t: [0.5, -0.25, 0], r: [0, 0, 1], time: 0 },
};

beforeEach(() => localStorage.clear());

describe('3D mouse settings', () => {
  it('defaults, clamps and drops junk', () => {
    expect(sanitizeMotionSettings(null)).toEqual(DEFAULT_MOTION_SETTINGS);
    const s = sanitizeMotionSettings({
      sensitivity: 99,
      deadZone: -1,
      rotate: 'yes',
      invert: { tx: true, zz: true, ry: 1 },
    });
    expect(s.sensitivity).toBe(4);
    expect(s.deadZone).toBe(0);
    expect(s.rotate).toBe(true);
    expect(s.invert).toEqual({ ...DEFAULT_MOTION_SETTINGS.invert, tx: true });
    expect(sanitizeMotionSettings({ sensitivity: 0.01 }).sensitivity).toBe(0.25);
  });

  it('reducer handles each control and reset', () => {
    let s = DEFAULT_MOTION_SETTINGS;
    s = motionSettingsReducer(s, { type: 'sensitivity', value: 2 });
    s = motionSettingsReducer(s, { type: 'invert', axis: 'rz', value: true });
    s = motionSettingsReducer(s, { type: 'dominant', value: true });
    s = motionSettingsReducer(s, { type: 'rotate', value: false });
    s = motionSettingsReducer(s, { type: 'translate', value: false });
    s = motionSettingsReducer(s, { type: 'deadZone', value: 0.1 });
    expect(s).toMatchObject({
      sensitivity: 2,
      dominant: true,
      rotate: false,
      translate: false,
      deadZone: 0.1,
    });
    expect(s.invert.rz).toBe(true);
    expect(motionSettingsReducer(s, { type: 'reset' })).toEqual(DEFAULT_MOTION_SETTINGS);
  });

  it('persists and reads back; broken storage falls back to defaults', () => {
    const s = { ...DEFAULT_MOTION_SETTINGS, sensitivity: 2.5, dominant: true };
    writeMotionSettings(s);
    expect(readMotionSettings()).toEqual(s);
    localStorage.setItem(MOTION_SETTINGS_KEY, '{nope');
    expect(readMotionSettings()).toEqual(DEFAULT_MOTION_SETTINGS);
  });
});

describe('3D mouse button mapping', () => {
  it('defaults: 1 = radial menu, 2 = fit; unmapped = none', () => {
    expect(readButtonMap()).toEqual(DEFAULT_MOTION_BUTTONS);
    expect(commandForButton(DEFAULT_MOTION_BUTTONS, 1)).toBe('radialMenu');
    expect(commandForButton(DEFAULT_MOTION_BUTTONS, 2)).toBe('fit');
    expect(commandForButton(DEFAULT_MOTION_BUTTONS, 7)).toBe('none');
  });

  it('remapping persists, including an explicit none', () => {
    let m = setButtonCommand(DEFAULT_MOTION_BUTTONS, 2, 'viewTop');
    m = setButtonCommand(m, 1, 'none');
    writeButtonMap(m);
    expect(readButtonMap()).toEqual({ 1: 'none', 2: 'viewTop' });
  });

  it('sanitises unknown commands and out-of-range buttons', () => {
    expect(
      sanitizeButtonMap({ 1: 'fit', 2: 'launchMissiles', 0: 'fit', 99: 'fit', x: 'fit' }),
    ).toEqual({
      1: 'fit',
    });
    localStorage.setItem(MOTION_BUTTONS_KEY, '"junk"');
    expect(readButtonMap()).toEqual(DEFAULT_MOTION_BUTTONS);
  });

  it('pressedEdges finds new presses only', () => {
    expect(pressedEdges([1], [1, 2])).toEqual([2]);
    expect(pressedEdges([1, 2], [])).toEqual([]);
  });

  it('watchButtons derives presses from state edges, or uses onButton when offered', () => {
    let push: (s: MotionInputState) => void = () => {};
    const input = {
      state: () => live,
      onState: (l: (s: MotionInputState) => void) => {
        push = l;
        return () => {};
      },
    };
    const press = vi.fn();
    watchButtons(input, press);
    push({ ...live, buttons: [2, 3] });
    push({ ...live, buttons: [2, 3] });
    expect(press.mock.calls).toEqual([[3]]);

    let cb: (b: number, down: boolean) => void = () => {};
    const press2 = vi.fn();
    watchButtons(
      {
        ...input,
        onButton: (l) => {
          cb = l;
          return () => {};
        },
      },
      press2,
    );
    cb(4, true);
    cb(4, false);
    expect(press2.mock.calls).toEqual([[4]]);
  });
});

describe('3D mouse diagnostics: every state', () => {
  const none = (state: 'unsupported' | 'notPaired' | 'disconnected'): MotionInputState => ({
    path: 'none',
    state,
  });

  it('unsupported says what to use', () => {
    renderUI(<MotionDiagnostics state={none('unsupported')} onPair={() => {}} />);
    expect(screen.getByTestId('motion-state-detail')).toHaveTextContent(
      "This browser can't read a 3D mouse. Use desktop Chrome or Edge.",
    );
    expect(screen.queryByRole('button', { name: 'Pair a 3D mouse' })).toBeNull();
  });

  it('notPaired offers the pair button', async () => {
    const pair = vi.fn();
    renderUI(<MotionDiagnostics state={none('notPaired')} onPair={pair} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pair a 3D mouse' }));
    expect(pair).toHaveBeenCalledOnce();
  });

  it('disconnected says to plug it in', () => {
    renderUI(<MotionDiagnostics state={none('disconnected')} onPair={() => {}} />);
    expect(screen.getByTestId('motion-state-title')).toHaveTextContent(/not connected/i);
  });

  it('noReports names the driver conflict in neutral terms', () => {
    renderUI(
      <MotionDiagnostics
        state={{ path: 'webhid', state: 'noReports', device: dev, buttons: [] }}
        onPair={() => {}}
      />,
    );
    const t = screen.getByTestId('motion-state-detail').textContent ?? '';
    expect(t).toMatch(/vendor driver/);
    expect(t).toMatch(/close the driver's app/i);
    expect(t).toMatch(/allow browser access/i);
    expect(screen.getByTestId('motion-diag-device')).toHaveTextContent('Test 3D mouse');
  });

  it('live shows the device, six axis bars and pressed buttons', () => {
    renderUI(<MotionDiagnostics state={live} onPair={() => {}} />);
    expect(screen.getByTestId('motion-diag-device')).toHaveTextContent('Test 3D mouse');
    const bars = screen.getAllByRole('meter');
    expect(bars).toHaveLength(6);
    expect(bars[0]).toHaveAttribute('aria-valuenow', '0.5');
    expect(bars[1]).toHaveAttribute('aria-valuenow', '-0.25');
    expect(bars[5]).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByTestId('motion-buttons')).toHaveTextContent('Button 2');
  });

  it('always carries the wheel note', () => {
    renderUI(<MotionDiagnostics state={none('notPaired')} onPair={() => {}} />);
    expect(screen.getByTestId('motion-wheel-note')).toHaveTextContent(/wheel emulation/i);
  });
});

describe('3D mouse settings section', () => {
  it('pairs from a click and edits values inline', async () => {
    const pair = vi.fn();
    const change = vi.fn();
    renderUI(
      <MotionSettingsSection
        value={DEFAULT_MOTION_SETTINGS}
        onChange={change}
        state={{ path: 'webhid', state: 'live', device: dev, buttons: [] }}
        onPair={pair}
      />,
    );
    expect(screen.getByTestId('motion-device')).toHaveTextContent('Paired: Test 3D mouse');
    await userEvent.click(screen.getByRole('button', { name: 'Pair a 3D mouse' }));
    expect(pair).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('switch', { name: 'Reverse twist (Rz)' }));
    expect(change).toHaveBeenLastCalledWith({
      ...DEFAULT_MOTION_SETTINGS,
      invert: { ...DEFAULT_MOTION_SETTINGS.invert, rz: true },
    });
    await userEvent.click(screen.getByRole('switch', { name: 'Rotate' }));
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MOTION_SETTINGS, rotate: false });
    expect(screen.getAllByRole('switch')).toHaveLength(9);
  });

  it('shows the unsupported text instead of a pair button', () => {
    renderUI(
      <MotionSettingsSection
        value={DEFAULT_MOTION_SETTINGS}
        onChange={() => {}}
        state={{ path: 'none', state: 'unsupported' }}
        onPair={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Pair a 3D mouse' })).toBeNull();
    expect(screen.getByTestId('motion-unsupported')).toBeInTheDocument();
  });
});

describe('3D mouse button picker', () => {
  it('lists buttons, grows with those seen live, and remaps', async () => {
    const change = vi.fn();
    renderUI(<MotionButtonMapping map={DEFAULT_MOTION_BUTTONS} onChange={change} seen={4} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(4);
    expect(screen.getByRole('combobox', { name: 'Button 2' })).toHaveValue('fit');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Button 2' }), 'viewIso');
    expect(change).toHaveBeenCalledWith({ 1: 'radialMenu', 2: 'viewIso' });
  });
});
