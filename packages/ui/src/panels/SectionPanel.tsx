import type { EvalResult, Expr } from '@wren-cad/contracts';
import { FlipHorizontal2, Scissors } from 'lucide-react';
import { Field, Segmented, Switch } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn } from '../components/primitives';
import { formatLengthMm, type MeasureUnits, parseLengthMm } from '../measure/types';

export type SectionAxis = 'x' | 'y' | 'z' | 'face';

export interface SectionPanelProps {
  enabled: boolean;
  onEnabledChange(on: boolean): void;
  axis: SectionAxis;
  onAxisChange(axis: SectionAxis): void;
  /** Description of the picked face when `axis` is `face` ("Face · Top"). */
  faceLabel?: string | null;
  /** Starts picking a face in the viewport. */
  onPickFace?(): void;
  /** Plane offset along the axis (or the face normal), mm. */
  offset: number;
  /** Slider range, mm (usually the part's bounding box along the axis). */
  range: { min: number; max: number };
  onOffsetChange(mm: number): void;
  flipped: boolean;
  onFlippedChange(flipped: boolean): void;
  units?: MeasureUnits;
  className?: string;
}

const LENGTH: readonly [number, number, number, number] = [1, 0, 0, 0];

function evaluateLength(units: MeasureUnits) {
  return (expr: Expr): EvalResult => {
    const mm = parseLengthMm(expr, units);
    return mm === null
      ? { ok: false, error: { message: 'Enter a length such as 12 mm or 0.5 in' } }
      : { ok: true, value: mm, dimension: LENGTH, dependsOn: [] };
  };
}

/**
 * Section panel (phone sheet): on/off, axis (X / Y / Z or a picked face), an offset slider with an
 * exact value field (units accepted, keypad on touch) and a flip toggle.
 */
export function SectionPanel({
  enabled,
  onEnabledChange,
  axis,
  onAxisChange,
  faceLabel,
  onPickFace,
  offset,
  range,
  onOffsetChange,
  flipped,
  onFlippedChange,
  units = 'mm',
  className,
}: SectionPanelProps) {
  const span = Math.max(range.max - range.min, 0.001);
  const step = span / 400;
  return (
    <div className={cn('flex flex-col gap-3 px-4 pb-4', className)} data-testid="section-panel">
      <Switch
        checked={enabled}
        onChange={onEnabledChange}
        label="Section view"
        className="min-h-11 w-full"
      />

      <div
        className={cn('flex flex-col gap-3', !enabled && 'opacity-60')}
        data-enabled={enabled || undefined}
      >
        <Field label="Axis">
          <Segmented
            label="Section axis"
            size="touch"
            value={axis}
            onChange={onAxisChange}
            options={[
              { value: 'x', label: 'X' },
              { value: 'y', label: 'Y' },
              { value: 'z', label: 'Z' },
              { value: 'face', label: 'Face' },
            ]}
          />
        </Field>
        {axis === 'face' ? (
          <div className="flex min-h-11 items-center justify-between gap-2 rounded-control bg-surface-2 pl-3">
            <span className="min-w-0 truncate text-ui font-medium" data-testid="section-face">
              {faceLabel ?? 'No face picked'}
            </span>
            {onPickFace ? (
              <Button variant="ghost" size="touch" onClick={onPickFace}>
                {faceLabel ? 'Change' : 'Pick face'}
              </Button>
            ) : null}
          </div>
        ) : null}

        <Field label="Offset">
          <div className="flex items-center gap-3">
            <input
              type="range"
              aria-label="Section offset"
              aria-valuetext={formatLengthMm(offset, units)}
              min={range.min}
              max={range.max}
              step={step}
              value={Math.min(range.max, Math.max(range.min, offset))}
              onChange={(e) => onOffsetChange(Number(e.target.value))}
              className="w-range min-w-0 flex-1"
            />
            <ExpressionInput
              label="Section offset value"
              size="touch"
              align="right"
              className="w-32 shrink-0"
              value={formatLengthMm(offset, units)}
              evaluate={evaluateLength(units)}
              showValue={false}
              onCommit={(expr) => {
                const mm = parseLengthMm(expr, units);
                if (mm !== null) onOffsetChange(mm);
              }}
              testId="section-offset-value"
            />
          </div>
        </Field>

        <button
          type="button"
          role="switch"
          aria-checked={flipped}
          onClick={() => onFlippedChange(!flipped)}
          className={cn(
            'flex min-h-11 items-center gap-2.5 rounded-control px-3 text-left text-ui font-medium transition-colors duration-fast',
            flipped
              ? 'bg-accent-soft text-accent-text'
              : 'bg-surface-2 text-fg active:bg-surface-3',
          )}
        >
          <FlipHorizontal2 className="size-[18px]" aria-hidden />
          Flip side
        </button>
      </div>
      {enabled ? null : (
        <p className="flex items-center gap-2 text-2xs text-fg-muted">
          <Scissors className="size-3.5" aria-hidden /> Turn on to slice the model along the plane.
        </p>
      )}
    </div>
  );
}
