import { Ruler, X } from 'lucide-react';
import { Segmented } from '../components/controls';
import { Button, cn } from '../components/primitives';
import {
  type Measurement,
  type MeasureTargetItem,
  type MeasureUnits,
  readMeasurement,
  speakMeasurement,
} from '../measure/types';
import { EmptyState } from '../shells/shared';

export interface MeasurePanelProps {
  /** Readings, oldest first. The last one is shown large. */
  measurements: readonly Measurement[];
  /** The picks the current reading is computed from (face, edge, point ...). */
  targets?: readonly MeasureTargetItem[];
  /** A one-line note under the reading (e.g. the kernel's error for the last pick). */
  note?: string | null;
  /** A measurement is being computed (the kernel may still be loading). */
  busy?: boolean;
  units?: MeasureUnits;
  onUnitsChange?(units: MeasureUnits): void;
  onRemoveTarget?(id: string): void;
  onClear?(): void;
  className?: string;
}

/**
 * Measure panel (phone sheet): the latest reading in large tabular figures, the picked targets
 * it came from, and earlier readings. Values come straight from the kernel's `Measurement`.
 */
export function MeasurePanel({
  measurements,
  targets = [],
  units = 'mm',
  onUnitsChange,
  onRemoveTarget,
  onClear,
  note,
  busy,
  className,
}: MeasurePanelProps) {
  const latest = measurements[measurements.length - 1];
  const reading = latest ? readMeasurement(latest, units) : null;
  const earlier = measurements.slice(0, -1).reverse();

  return (
    <div className={cn('flex flex-col gap-3 px-4 pb-4', className)} data-testid="measure-panel">
      {onUnitsChange ? (
        <Segmented
          label="Units"
          size="touch"
          value={units}
          onChange={onUnitsChange}
          options={[
            { value: 'mm', label: 'mm' },
            { value: 'in', label: 'in' },
          ]}
        />
      ) : null}

      {latest && reading ? (
        <section
          aria-label="Latest measurement"
          data-testid="measure-reading"
          data-kind={reading.kind}
          className="rounded-panel bg-surface-2 px-4 py-3"
        >
          <p className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">
            {reading.label}
          </p>
          <p className="tnum mt-0.5 flex items-baseline gap-1.5">
            {reading.kind === 'position' ? null : (
              <>
                <span className="text-[34px] leading-10 font-semibold tracking-tight text-fg">
                  {reading.value}
                </span>
                <span className="text-base font-medium text-fg-muted">{reading.unit}</span>
              </>
            )}
          </p>
          {reading.parts ? (
            <dl className="tnum mt-1.5 grid grid-cols-3 gap-2 text-ui">
              {reading.parts.map((p) => (
                <div key={p.axis} className="rounded-lg bg-surface px-2.5 py-1.5">
                  <dt className="text-2xs text-fg-muted">{p.axis}</dt>
                  <dd className="font-medium text-fg">{p.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {reading.extra ? (
            <dl className="tnum mt-1.5 flex flex-col gap-0.5 text-ui" data-testid="measure-extra">
              {reading.extra.map((x) => (
                <div key={x.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-fg-muted">{x.label}</dt>
                  <dd className="font-medium text-fg">
                    {x.value} {x.unit}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <span role="status" aria-live="polite" className="sr-only">
            {speakMeasurement(latest, units)}
          </span>
        </section>
      ) : busy ? (
        <p className="py-6 text-center text-ui text-fg-muted" role="status" aria-live="polite">
          Measuring…
        </p>
      ) : (
        <EmptyState icon={Ruler} title="Measure" className="py-6">
          Tap two points, edges or faces to read distances and angles.
        </EmptyState>
      )}

      {note ? (
        <p className="text-ui text-danger-text" role="alert" data-testid="measure-note">
          {note}
        </p>
      ) : null}

      {targets.length > 0 ? (
        <section aria-label="Picked targets">
          <h3 className="mb-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
            Picked
          </h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="measure-targets">
            {targets.map((t, i) => (
              <li
                key={t.id}
                className="flex min-h-11 items-center gap-2 rounded-control bg-surface-2 pl-3"
              >
                <span
                  aria-hidden
                  className="tnum flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-2xs font-semibold text-accent-fg"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-ui font-medium">{t.label}</span>
                {onRemoveTarget ? (
                  <button
                    type="button"
                    aria-label={`Remove ${t.label}`}
                    onClick={() => onRemoveTarget(t.id)}
                    className="flex size-11 shrink-0 items-center justify-center rounded-control text-fg-muted active:bg-surface-3"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {earlier.length > 0 ? (
        <section aria-label="Earlier measurements">
          <h3 className="mb-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
            Earlier
          </h3>
          <ul className="m-0 flex list-none flex-col p-0" data-testid="measure-history">
            {earlier.map((m, i) => {
              const r = readMeasurement(m, units);
              if (!r) return null;
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: readings have no ids; the list only grows at the end
                  key={i}
                  className="flex min-h-11 items-center justify-between border-b border-border text-ui last:border-b-0"
                >
                  <span className="text-fg-muted">{r.label}</span>
                  <span className="tnum font-medium text-fg">
                    {r.kind === 'position' ? r.value : `${r.value} ${r.unit}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {onClear && (measurements.length > 0 || targets.length > 0) ? (
        <Button variant="secondary" size="touch" onClick={onClear} className="self-start">
          Clear
        </Button>
      ) : null}
    </div>
  );
}
