import type { NavigationOptions, NavigationPreset } from '@wren-cad/contracts';
import { useId } from 'react';
import { Field, Section, Segmented, Switch } from '../components/controls';
import { cn } from '../components/primitives';

export interface NavigationSettingsProps {
  value: NavigationOptions;
  onChange(next: NavigationOptions): void;
  /**
   * M3.8: "Right click finishes the current sketch tool" (ends a line chain or spline instead of
   * opening the radial menu). The section shows when `onRightClickFinishesChange` is given.
   */
  rightClickFinishes?: boolean;
  onRightClickFinishesChange?(on: boolean): void;
  size?: 'md' | 'touch';
  className?: string;
}

interface PresetInfo {
  id: NavigationPreset;
  /** Named by behaviour. */
  title: string;
  detail: string;
  /** Plain compatibility text only: never a preset name, logo or product styling. */
  similarTo: string;
}

export const NAVIGATION_PRESETS: readonly PresetInfo[] = [
  {
    id: 'rightOrbit',
    title: 'Right button orbits',
    detail:
      'Right-drag orbits, middle-drag pans, the wheel zooms. A right click opens the radial menu.',
    similarTo: 'Similar to Onshape',
  },
  {
    id: 'middleOrbit',
    title: 'Middle button orbits',
    detail:
      'Middle-drag orbits, Ctrl + middle-drag pans. A middle click on the model sets the pivot. A right click opens the radial menu.',
    similarTo: 'Similar to SolidWorks / NX',
  },
  {
    id: 'middlePan',
    title: 'Middle button pans',
    detail: 'Middle-drag pans, Shift + middle-drag orbits. A right click opens the radial menu.',
    similarTo: 'Similar to Fusion',
  },
  {
    id: 'rightOrbitRepeat',
    title: 'Right click repeats',
    detail:
      'As "Right button orbits", but a quick right click repeats the last command; hold it for the radial menu.',
    similarTo: 'Similar to Rhino',
  },
];

/** Speed is chosen on a log scale so 1x sits in the middle of 0.25x to 4x. */
const toSlider = (speed: number) => Math.log2(speed);
const fromSlider = (v: number) => Math.round(2 ** v * 20) / 20;

/**
 * Navigation settings (PLAN M3.5, ADR-046): the mouse preset by behaviour, turntable or trackball,
 * pivot under the cursor or at the centre, the pivot marker, invert zoom and orbit speed, and the
 * projection (ADR-098: orthographic by default, perspective as a setting).
 * Controlled; the app persists it (`readNavigation` / `writeNavigation`) and passes it to the
 * viewport's `setNavigation`. Left drag is never navigation under any preset.
 */
export function NavigationSettings({
  value,
  onChange,
  rightClickFinishes = true,
  onRightClickFinishesChange,
  size = 'md',
  className,
}: NavigationSettingsProps) {
  const touch = size === 'touch';
  const name = useId();
  const speedId = useId();
  const set = <K extends keyof NavigationOptions>(k: K, v: NavigationOptions[K]) =>
    onChange({ ...value, [k]: v });
  const sz = touch ? 'touch' : 'md';

  return (
    <div data-testid="navigation-settings" className={cn('flex min-w-0 flex-col', className)}>
      <Section title="Mouse buttons">
        <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
          <legend className="sr-only">Mouse button mapping</legend>
          {NAVIGATION_PRESETS.map((p) => {
            const on = value.preset === p.id;
            const base = `${name}-${p.id}`;
            return (
              <label
                key={p.id}
                data-preset={p.id}
                className={cn(
                  'flex cursor-pointer gap-2.5 rounded-control p-2.5 shadow-[inset_0_0_0_1px_var(--color-border)] transition-colors duration-fast has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent hover:bg-surface-2',
                  on && 'bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--color-accent)]',
                  touch && 'min-h-14',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={p.id}
                  checked={on}
                  aria-labelledby={`${base}-t`}
                  aria-describedby={`${base}-d ${base}-s`}
                  onChange={() => set('preset', p.id)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span id={`${base}-t`} className="block text-ui font-medium">
                    {p.title}
                  </span>
                  <span id={`${base}-d`} className="mt-0.5 block text-xs text-fg-muted">
                    {p.detail}
                  </span>
                  <span id={`${base}-s`} className="mt-0.5 block text-2xs text-fg-subtle">
                    {p.similarTo}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="text-2xs text-fg-subtle">
          The left button always picks and box-selects; it never orbits. Drag left to right to
          select what lies entirely inside the box, right to left to select anything it touches.
        </p>
      </Section>

      <Section title="Orbit">
        <Field label="Orbit style">
          <Segmented
            label="Orbit style"
            size={sz}
            value={value.orbit}
            onChange={(v) => set('orbit', v)}
            options={[
              { value: 'turntable', label: 'Turntable' },
              { value: 'trackball', label: 'Trackball' },
            ]}
          />
        </Field>
        <Field
          label="Orbit around"
          hint="Under the cursor turns about the surface point where the drag starts; if there is none, about the centre of what is visible."
        >
          <Segmented
            label="Orbit pivot"
            size={sz}
            value={value.pivot}
            onChange={(v) => set('pivot', v)}
            options={[
              { value: 'cursor', label: 'Under the cursor' },
              { value: 'center', label: 'Centre of the model' },
            ]}
          />
        </Field>
        <Switch
          label="Show the pivot while orbiting"
          checked={value.showPivot}
          onChange={(v) => set('showPivot', v)}
          className={touch ? 'min-h-11' : ''}
        />
        <Field label="Orbit speed">
          <div className="flex items-center gap-3">
            <input
              id={speedId}
              type="range"
              aria-label="Orbit speed"
              min={-2}
              max={2}
              step={0.05}
              value={toSlider(value.rotateSpeed)}
              aria-valuetext={`${value.rotateSpeed.toFixed(2)} times`}
              onChange={(e) => set('rotateSpeed', fromSlider(Number(e.target.value)))}
              className={cn('min-w-0 flex-1 accent-[var(--color-accent)]', touch && 'h-11')}
            />
            <output htmlFor={speedId} className="tnum w-12 text-right text-ui">
              {value.rotateSpeed.toFixed(2)}×
            </output>
          </div>
        </Field>
      </Section>

      <Section title="View">
        <Field
          label="Projection"
          hint="Orthographic keeps parallel edges parallel: a hole seen straight on shows no wall, and size does not change with depth. Perspective is the camera view, for presentation."
        >
          <Segmented
            label="Projection"
            size={sz}
            value={value.projection}
            onChange={(v) => set('projection', v)}
            options={[
              { value: 'orthographic', label: 'Orthographic' },
              { value: 'perspective', label: 'Perspective' },
            ]}
          />
        </Field>
      </Section>

      <Section title="Zoom">
        <Switch
          label="Invert zoom direction"
          checked={value.invertZoom}
          onChange={(v) => set('invertZoom', v)}
          className={touch ? 'min-h-11' : ''}
        />
      </Section>

      {onRightClickFinishesChange ? (
        <Section title="Sketching">
          <Switch
            label="Right click finishes the current sketch tool"
            checked={rightClickFinishes}
            onChange={onRightClickFinishesChange}
            className={touch ? 'min-h-11' : ''}
          />
          <p className="text-2xs text-fg-subtle">
            A right click ends a line chain where it is and finishes a spline with the points placed
            so far. With nothing in progress it opens the radial menu; right-drag still navigates.
          </p>
        </Section>
      ) : null}
    </div>
  );
}
