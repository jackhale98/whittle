import type { MotionButtonCommand, MotionInputState, MotionSettings } from '@wren-cad/contracts';
import { useId } from 'react';
import { Field, Section, Switch } from '../components/controls';
import { Button, cn } from '../components/primitives';
import {
  buttonCount,
  commandForButton,
  DEAD_ZONE_RANGE,
  MOTION_AXES,
  MOTION_BUTTON_COMMAND_IDS,
  type MotionAxis,
  type MotionButtonMap,
  SENSITIVITY_RANGE,
} from '../logic/motionSettings';

/* 3D mouse UI (M4.5, ADR-096): settings section, diagnostics panel and button mapping. Inline
   (no dialogs); controlled; the app persists and pushes to the device layer. */

type Size = 'md' | 'touch';

const AXIS_LABEL: Record<MotionAxis, string> = {
  tx: 'Move left / right',
  ty: 'Move up / down',
  tz: 'Push / pull',
  rx: 'Tilt forward / back',
  ry: 'Twist',
  rz: 'Tilt left / right',
};
/** Screen-axis naming used by the contract: x right, y up, z toward the viewer. */
const AXIS_SHORT: Record<MotionAxis, string> = {
  tx: 'X',
  ty: 'Y',
  tz: 'Z',
  rx: 'Rx',
  ry: 'Ry',
  rz: 'Rz',
};

export const MOTION_BUTTON_LABEL: Record<MotionButtonCommand, string> = {
  none: 'Nothing',
  fit: 'Fit to view',
  radialMenu: 'Radial menu',
  repeatLast: 'Repeat last command',
  viewFront: 'Front view',
  viewTop: 'Top view',
  viewRight: 'Right view',
  viewIso: 'Isometric view',
  toggleRotate: 'Toggle rotation',
  toggleDominant: 'Toggle dominant axis',
};

export const WHEEL_NOTE =
  "If zoom feels doubled, turn off the driver's wheel emulation for your browser in the driver's settings. Wren reads the device directly and ignores the duplicate wheel events it can recognise.";

export function deviceName(s: MotionInputState): string | null {
  return s.path === 'webhid' ? s.device.name : null;
}

/** The fix text for each state, shared by the diagnostics panel and tests. */
export const MOTION_STATE_TEXT: Record<
  'unsupported' | 'notPaired' | 'disconnected' | 'noReports' | 'live',
  { title: string; detail: string }
> = {
  unsupported: {
    title: 'Not supported in this browser',
    detail: "This browser can't read a 3D mouse. Use desktop Chrome or Edge.",
  },
  notPaired: {
    title: 'No 3D mouse paired',
    detail: 'Pair your 3D mouse once; the browser asks for permission and remembers it.',
  },
  disconnected: {
    title: 'Paired device not connected',
    detail: 'Plug the 3D mouse in (or wake its receiver). Wren reconnects on its own.',
  },
  noReports: {
    title: 'Connected, but no movement is arriving',
    detail:
      "A vendor driver may be holding the device. Close the driver's app, or allow browser access in the driver's settings, then move the cap again.",
  },
  live: { title: 'Live', detail: 'Move the cap to see the axes respond.' },
};

export function stateKey(s: MotionInputState): keyof typeof MOTION_STATE_TEXT {
  return s.path === 'none' ? s.state : s.state;
}

/* ------------------------------------------------------------------------- settings */

export interface MotionSettingsSectionProps {
  value: MotionSettings;
  onChange(next: MotionSettings): void;
  state: MotionInputState;
  /** Called from the button's click, so the browser sees a user gesture. */
  onPair(): void;
  onOpenDiagnostics?(): void;
  size?: Size;
  className?: string;
}

export function MotionSettingsSection({
  value,
  onChange,
  state,
  onPair,
  onOpenDiagnostics,
  size = 'md',
  className,
}: MotionSettingsSectionProps) {
  const touch = size === 'touch';
  const sensId = useId();
  const dzId = useId();
  const set = (patch: Partial<MotionSettings>) => onChange({ ...value, ...patch });
  const name = deviceName(state);
  const sw = touch ? 'min-h-11' : '';
  return (
    <Section title="3D mouse" className={className}>
      <div data-testid="motion-settings" className="flex flex-col gap-2.5">
        {state.path === 'none' && state.state === 'unsupported' ? (
          <p className="text-xs text-fg-muted" data-testid="motion-unsupported">
            {MOTION_STATE_TEXT.unsupported.detail}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size={size} onClick={onPair} data-testid="motion-pair">
              Pair a 3D mouse
            </Button>
            <span className="text-xs text-fg-muted" data-testid="motion-device">
              {name ? `Paired: ${name}` : 'No device paired'}
            </span>
          </div>
        )}
        <Field label="Sensitivity">
          <div className="flex items-center gap-3">
            <input
              id={sensId}
              type="range"
              aria-label="3D mouse sensitivity"
              min={Math.log2(SENSITIVITY_RANGE.min)}
              max={Math.log2(SENSITIVITY_RANGE.max)}
              step={0.05}
              value={Math.log2(value.sensitivity)}
              aria-valuetext={`${value.sensitivity.toFixed(2)} times`}
              onChange={(e) =>
                set({ sensitivity: Math.round(2 ** Number(e.target.value) * 20) / 20 })
              }
              className={cn('min-w-0 flex-1 accent-[var(--color-accent)]', touch && 'h-11')}
            />
            <output htmlFor={sensId} className="tnum w-12 text-right text-ui">
              {value.sensitivity.toFixed(2)}×
            </output>
          </div>
        </Field>
        <Field label="Dead zone" hint="Ignore tiny movements near the centre.">
          <div className="flex items-center gap-3">
            <input
              id={dzId}
              type="range"
              aria-label="3D mouse dead zone"
              min={DEAD_ZONE_RANGE.min}
              max={DEAD_ZONE_RANGE.max}
              step={0.01}
              value={value.deadZone}
              aria-valuetext={`${Math.round(value.deadZone * 100)} percent`}
              onChange={(e) => set({ deadZone: Number(e.target.value) })}
              className={cn('min-w-0 flex-1 accent-[var(--color-accent)]', touch && 'h-11')}
            />
            <output htmlFor={dzId} className="tnum w-12 text-right text-ui">
              {Math.round(value.deadZone * 100)}%
            </output>
          </div>
        </Field>
        <Switch
          label="Rotate"
          checked={value.rotate}
          onChange={(v) => set({ rotate: v })}
          className={sw}
        />
        <Switch
          label="Pan and zoom"
          checked={value.translate}
          onChange={(v) => set({ translate: v })}
          className={sw}
        />
        <Switch
          label="Dominant axis only"
          checked={value.dominant}
          onChange={(v) => set({ dominant: v })}
          className={sw}
        />
        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
          <legend className="mb-1 text-xs font-medium text-fg-muted">Invert axes</legend>
          <div className="grid grid-cols-2 gap-x-3">
            {MOTION_AXES.map((a) => (
              <Switch
                key={a}
                label={`Invert ${AXIS_SHORT[a]}`}
                checked={value.invert[a]}
                onChange={(v) => set({ invert: { ...value.invert, [a]: v } })}
                className={touch ? 'min-h-11' : 'min-h-7'}
              />
            ))}
          </div>
        </fieldset>
        {onOpenDiagnostics ? (
          <div>
            <Button
              variant="ghost"
              size={size}
              onClick={onOpenDiagnostics}
              data-testid="motion-open-diagnostics"
            >
              3D mouse diagnostics
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------- diagnostics */

export interface MotionDiagnosticsProps {
  state: MotionInputState;
  onPair(): void;
  /** Names of pressed buttons are "Button n"; the keymap editor maps them. */
  size?: Size;
  className?: string;
}

function AxisBar({ axis, value }: { axis: MotionAxis; value: number }) {
  const v = Math.max(-1, Math.min(1, value));
  const pct = Math.abs(v) * 50;
  return (
    <div className="flex items-center gap-2" data-axis={axis}>
      <span className="w-6 text-xs font-medium text-fg-muted">{AXIS_SHORT[axis]}</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot draw a bar from the centre (signed axis) */}
      <div
        role="meter"
        aria-label={AXIS_LABEL[axis]}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={Math.round(v * 100) / 100}
        aria-valuetext={`${Math.round(v * 100)} percent`}
        className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-border)]"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 bg-accent"
          style={v >= 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
        />
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />
      </div>
      <span className="tnum w-10 text-right text-2xs text-fg-muted">{v.toFixed(2)}</span>
    </div>
  );
}

/**
 * Diagnostics (PLAN M4.5): never silent. One status line per `MotionInputState` with the plain
 * fix, the live axes and pressed buttons when live, and the wheel-emulation note.
 */
export function MotionDiagnostics({
  state,
  onPair,
  size = 'md',
  className,
}: MotionDiagnosticsProps) {
  const key = stateKey(state);
  const text = MOTION_STATE_TEXT[key];
  const last = state.path === 'webhid' ? state.last : undefined;
  const buttons = state.path === 'webhid' ? state.buttons : [];
  return (
    <div
      data-testid="motion-diagnostics"
      data-state={key}
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        <p className="m-0 text-ui font-semibold" data-testid="motion-state-title">
          {text.title}
        </p>
        <p className="m-0 text-xs text-fg-muted" data-testid="motion-state-detail">
          {text.detail}
        </p>
      </div>
      {key === 'notPaired' ? (
        <div>
          <Button variant="primary" size={size} onClick={onPair} data-testid="motion-pair-diag">
            Pair a 3D mouse
          </Button>
        </div>
      ) : null}
      {state.path === 'webhid' ? (
        <p className="m-0 text-ui" data-testid="motion-diag-device">
          {state.device.name}
        </p>
      ) : null}
      {key === 'live' ? (
        <>
          <div className="flex flex-col gap-1.5" data-testid="motion-axes">
            {MOTION_AXES.map((a) => (
              <AxisBar
                key={a}
                axis={a}
                value={last ? ((a[0] === 't' ? last.t : last.r)[a.charCodeAt(1) - 120] ?? 0) : 0}
              />
            ))}
          </div>
          <p className="m-0 text-xs" data-testid="motion-buttons">
            <span className="font-medium text-fg-muted">Pressed buttons: </span>
            {buttons.length ? buttons.map((b) => `Button ${b}`).join(', ') : 'none'}
          </p>
        </>
      ) : null}
      <p className="m-0 text-2xs text-fg-subtle" data-testid="motion-wheel-note">
        {WHEEL_NOTE}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------- button mapping */

export interface MotionButtonMappingProps {
  map: MotionButtonMap;
  onChange(next: MotionButtonMap): void;
  /** Highest button number seen live so far (the list grows as buttons are pressed). */
  seen: number;
  /** Buttons pressed right now, for a visible hint. */
  pressed?: readonly number[];
  size?: Size;
  className?: string;
}

export function MotionButtonMapping({
  map,
  onChange,
  seen,
  pressed = [],
  size = 'md',
  className,
}: MotionButtonMappingProps) {
  const touch = size === 'touch';
  const n = buttonCount(map, seen);
  const rows = Array.from({ length: n }, (_, i) => i + 1);
  return (
    <section
      aria-labelledby="motion-map-h"
      data-testid="motion-button-map"
      className={cn('flex flex-col gap-2', className)}
    >
      <h3
        id="motion-map-h"
        className="text-2xs font-semibold tracking-wider text-fg-muted uppercase"
      >
        3D mouse buttons
      </h3>
      <p className="m-0 text-2xs text-fg-subtle">
        Buttons appear as you press them. Press a button on the device to find its number.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map((b) => (
          <li key={b} className="flex items-center gap-2" data-button={b}>
            <label
              htmlFor={`motion-btn-${b}`}
              className={cn(
                'w-20 shrink-0 text-ui',
                pressed.includes(b) && 'font-semibold text-accent',
              )}
            >
              Button {b}
            </label>
            <select
              id={`motion-btn-${b}`}
              value={commandForButton(map, b)}
              onChange={(e) => onChange({ ...map, [b]: e.target.value as MotionButtonCommand })}
              className={cn(
                'min-w-0 flex-1 rounded-control bg-surface-2 px-2 text-ui text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
                touch ? 'h-11' : 'h-8',
              )}
            >
              {MOTION_BUTTON_COMMAND_IDS.map((c) => (
                <option key={c} value={c}>
                  {MOTION_BUTTON_LABEL[c]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}
