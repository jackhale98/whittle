import type { EvalResult, Expr } from '@wren-cad/contracts';
import { Link2, Link2Off, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Segmented, Switch } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn, Kbd } from '../components/primitives';
import type { FormatValue } from '../format';

/**
 * Interaction chrome for the M3 sketch-editing tools (PLAN 9.1, 9.2). Everything here is
 * presentational and controlled: the host (apps/web, with packages/sketch) owns the sketch logic,
 * draws the preview, and passes state in. Panels float over the viewport like the prompt chip;
 * none is a dialog. Enter applies and Esc cancels (the host listens, the buttons show the keys).
 */

export type SketchEditToolId =
  | 'offset'
  | 'convert'
  | 'trim'
  | 'extend'
  | 'sketchFillet'
  | 'sketchChamfer'
  | 'sketchMirror';

type Size = 'md' | 'touch';

interface FrameProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  /** Apply / Cancel row; omit for tools that act on each click (trim, extend). */
  onApply?(): void;
  onCancel?(): void;
  applyLabel?: string;
  applyDisabled?: boolean;
  size?: Size;
  testId: string;
  className?: string;
}

function Frame({
  title,
  icon,
  children,
  onApply,
  onCancel,
  applyLabel = 'Apply',
  applyDisabled,
  size = 'md',
  testId,
  className,
}: FrameProps) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className={cn(
        'w-panel pointer-events-auto flex w-[min(100vw-24px,300px)] flex-col gap-2.5 rounded-panel p-3',
        className,
      )}
    >
      <h3 className="flex items-center gap-1.5 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
        {icon}
        {title}
      </h3>
      {children}
      {onApply || onCancel ? (
        <div className="flex justify-end gap-1.5">
          {onCancel ? (
            <Button variant="ghost" size={size} onClick={onCancel} aria-keyshortcuts="Escape">
              Cancel <Kbd>Esc</Kbd>
            </Button>
          ) : null}
          {onApply ? (
            <Button
              variant="primary"
              size={size}
              onClick={onApply}
              disabled={applyDisabled}
              aria-keyshortcuts="Enter"
            >
              {applyLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

interface ValueProps {
  value: Expr;
  evaluate?(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  unitHint?: string;
  onPreview?(expr: Expr): void;
  onCommit(expr: Expr): void;
  size?: Size;
}

function Value({
  label,
  value,
  evaluate,
  formatValue,
  unitHint = 'mm',
  onPreview,
  onCommit,
  size,
  autoFocus,
}: ValueProps & { label: string; autoFocus?: boolean }) {
  return (
    <ExpressionInput
      label={label}
      value={value}
      evaluate={evaluate}
      formatValue={formatValue}
      unitHint={unitHint}
      size={size}
      autoFocus={autoFocus}
      onPreview={onPreview}
      onCommit={onCommit}
    />
  );
}

/* ------------------------------------------------------------------------- offset */

export interface OffsetPanelProps extends ValueProps {
  /** Which side of the chain the copy goes: left or right of its direction. */
  side: 'left' | 'right';
  both: boolean;
  /** Chain length being offset (entities). Zero = nothing picked yet. */
  count: number;
  onSide(side: 'left' | 'right'): void;
  onBoth(both: boolean): void;
  onApply(): void;
  onCancel(): void;
  className?: string;
}

/** Offset entities: distance chip, side and "both sides" toggles, live preview count. */
export function OffsetPanel({
  side,
  both,
  count,
  onSide,
  onBoth,
  onApply,
  onCancel,
  className,
  size,
  ...value
}: OffsetPanelProps) {
  const ok = value.evaluate ? (value.evaluate(value.value)?.ok ?? true) : true;
  return (
    <Frame
      title="Offset"
      testId="offset-panel"
      size={size}
      className={className}
      onApply={onApply}
      onCancel={onCancel}
      applyDisabled={count === 0 || !ok}
    >
      <Labelled label="Distance">
        <Value label="Offset distance" size={size} autoFocus {...value} />
      </Labelled>
      <Segmented
        label="Offset side"
        size={size}
        value={side}
        disabled={both}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ]}
        onChange={onSide}
      />
      <Switch label="Both sides" checked={both} onChange={onBoth} />
      <p className="tnum text-xs text-fg-muted" data-testid="offset-preview">
        {count === 0
          ? 'Select a line, arc or chain to offset.'
          : `Preview: ${count} ${count === 1 ? 'entity' : 'entities'}${both ? ', both sides' : ` to the ${side}`}`}
      </p>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- convert entities */

export interface ConvertPanelProps {
  /** What is being picked from the model. */
  source: 'edges' | 'face';
  /** Entities picked so far. */
  count: number;
  /** Some picks will be fitted (approximate) rather than exact. */
  approximateCount?: number;
  onSource(source: 'edges' | 'face'): void;
  onApply(): void;
  onCancel(): void;
  size?: Size;
  className?: string;
}

/** Convert entities: pick model edges or a whole face outline; the result stays linked. */
export function ConvertPanel({
  source,
  count,
  approximateCount = 0,
  onSource,
  onApply,
  onCancel,
  size,
  className,
}: ConvertPanelProps) {
  return (
    <Frame
      title="Convert entities"
      icon={<Link2 className="size-3.5" aria-hidden />}
      testId="convert-panel"
      size={size}
      className={className}
      onApply={onApply}
      onCancel={onCancel}
      applyLabel="Convert"
      applyDisabled={count === 0}
    >
      <Segmented
        label="Convert from"
        size={size}
        value={source}
        options={[
          { value: 'edges', label: 'Edges' },
          { value: 'face', label: 'Face outline' },
        ]}
        onChange={onSource}
      />
      <p className="tnum text-xs text-fg-muted" data-testid="convert-count">
        {count === 0
          ? source === 'face'
            ? 'Select a face on the model.'
            : 'Select edges on the model.'
          : `${count} ${count === 1 ? 'edge' : 'edges'} selected`}
      </p>
      {approximateCount > 0 ? (
        <p role="status" className="text-xs text-warning-text">
          {approximateCount} will be fitted as a chain of lines (approximate).
        </p>
      ) : null}
      <p className="text-2xs text-fg-subtle">
        Converted geometry stays linked to the model and follows it.
      </p>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- linked entities */

export type LinkedState = 'linked' | 'approximate' | 'lost';

/** Stroke styling for the host's sketch overlay: linked is dashed accent, lost is a faint ghost. */
export const linkedEntityStyle: Record<
  LinkedState,
  { stroke: string; dash: string; opacity: number; label: string }
> = {
  linked: { stroke: 'var(--color-accent)', dash: '7 3', opacity: 1, label: 'Linked to model' },
  approximate: {
    stroke: 'var(--color-accent)',
    dash: '2 3',
    opacity: 1,
    label: 'Linked, approximate',
  },
  lost: {
    stroke: 'var(--color-warning)',
    dash: '3 5',
    opacity: 0.55,
    label: 'Source lost',
  },
};

/** A 28 px sample of how a linked entity is drawn. */
export function LinkedSwatch({ state }: { state: LinkedState }) {
  const s = linkedEntityStyle[state];
  return (
    <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden data-linked-state={state}>
      <line
        x1="1"
        y1="5"
        x2="27"
        y2="5"
        stroke={s.stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={s.dash}
        opacity={s.opacity}
      />
    </svg>
  );
}

export interface LinkedEntityPanelProps {
  state: LinkedState;
  /** Display name of the model source, e.g. "Edge F2:top(e1)". */
  sourceLabel: string;
  /** Number of selected linked entities. */
  count?: number;
  onUnlink(): void;
  /** Lost sources only: pick the replacement (never done silently). */
  onRepick?(): void;
  size?: Size;
  className?: string;
}

/**
 * Selection panel for a linked entity: shows the source, "Unlink" (delete the link, keep the
 * geometry), and for a lost source the ghost styling note with "Re-pick".
 */
export function LinkedEntityPanel({
  state,
  sourceLabel,
  count = 1,
  onUnlink,
  onRepick,
  size,
  className,
}: LinkedEntityPanelProps) {
  const lost = state === 'lost';
  return (
    <Frame
      title="Linked geometry"
      icon={<Link2 className="size-3.5" aria-hidden />}
      testId="linked-panel"
      size={size}
      className={className}
    >
      <div
        className={cn(
          'flex items-center gap-2 rounded-control p-2 text-xs',
          lost ? 'bg-warning-soft text-warning-text' : 'bg-surface-2 text-fg',
        )}
        data-state={state}
      >
        <LinkedSwatch state={state} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{linkedEntityStyle[state].label}</span>
          <span className="block truncate text-fg-muted" title={sourceLabel}>
            {lost ? `Was: ${sourceLabel}` : sourceLabel}
          </span>
        </span>
      </div>
      {lost ? (
        <p role="alert" className="text-xs text-warning-text">
          The model geometry this followed is gone. Wren will not guess: re-pick the new source, or
          unlink to keep it as plain sketch geometry.
        </p>
      ) : null}
      {state === 'approximate' ? (
        <p className="text-xs text-fg-muted">
          Fitted as lines; it follows the model but is not exact.
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        {lost && onRepick ? (
          <Button
            variant="secondary"
            size={size}
            icon={<RefreshCw className="size-3.5" aria-hidden />}
            onClick={onRepick}
          >
            Re-pick
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size={size}
          icon={<Link2Off className="size-3.5" aria-hidden />}
          onClick={onUnlink}
        >
          {count > 1 ? `Unlink ${count}` : 'Unlink'}
        </Button>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- trim / extend */

export interface TrimExtendPanelProps {
  mode: 'trim' | 'extend';
  onMode(mode: 'trim' | 'extend'): void;
  onDone(): void;
  size?: Size;
  className?: string;
}

/** Trim and extend act on every click, so the panel is a mode switch and a hint, no Apply. */
export function TrimExtendPanel({ mode, onMode, onDone, size, className }: TrimExtendPanelProps) {
  return (
    <Frame
      title="Trim / extend"
      testId="trim-panel"
      size={size}
      className={className}
      onCancel={onDone}
    >
      <Segmented
        label="Trim or extend"
        size={size}
        value={mode}
        options={[
          { value: 'trim', label: 'Trim' },
          { value: 'extend', label: 'Extend' },
        ]}
        onChange={onMode}
      />
      <p className="text-xs text-fg-muted">
        {mode === 'trim'
          ? 'Click the part of a curve to remove, up to its nearest crossings.'
          : 'Click near the end of a curve to extend it to the next boundary.'}
      </p>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- fillet / chamfer */

export interface SketchCornerPanelProps extends ValueProps {
  kind: 'fillet' | 'chamfer';
  onKind(kind: 'fillet' | 'chamfer'): void;
  /** Corners picked so far. */
  count: number;
  onApply(): void;
  onCancel(): void;
  className?: string;
}

/** Sketch fillet and chamfer: kind switch and a radius (or distance) chip. */
export function SketchCornerPanel({
  kind,
  onKind,
  count,
  onApply,
  onCancel,
  className,
  size,
  ...value
}: SketchCornerPanelProps) {
  const label = kind === 'fillet' ? 'Radius' : 'Distance';
  const ok = value.evaluate ? (value.evaluate(value.value)?.ok ?? true) : true;
  return (
    <Frame
      title="Sketch corner"
      testId="corner-panel"
      size={size}
      className={className}
      onApply={onApply}
      onCancel={onCancel}
      applyDisabled={count === 0 || !ok}
    >
      <Segmented
        label="Corner type"
        size={size}
        value={kind}
        options={[
          { value: 'fillet', label: 'Fillet' },
          { value: 'chamfer', label: 'Chamfer' },
        ]}
        onChange={onKind}
      />
      <Labelled label={label}>
        <Value label={`Corner ${label.toLowerCase()}`} size={size} autoFocus {...value} />
      </Labelled>
      <p className="tnum text-xs text-fg-muted" data-testid="corner-count">
        {count === 0
          ? 'Click a corner, or drag across several.'
          : `${count} ${count === 1 ? 'corner' : 'corners'} selected`}
      </p>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- mirror */

export interface SketchMirrorPanelProps {
  /** Entities chosen to mirror. */
  count: number;
  /** The mirror line, once picked. */
  axisLabel: string | null;
  /** Which pick the next click answers. */
  phase: 'entities' | 'axis';
  onPhase(phase: 'entities' | 'axis'): void;
  onApply(): void;
  onCancel(): void;
  size?: Size;
  className?: string;
}

/** Sketch mirror: choose entities, then the mirror line; the copies stay symmetric. */
export function SketchMirrorPanel({
  count,
  axisLabel,
  phase,
  onPhase,
  onApply,
  onCancel,
  size,
  className,
}: SketchMirrorPanelProps) {
  return (
    <Frame
      title="Mirror"
      testId="mirror-panel"
      size={size}
      className={className}
      onApply={onApply}
      onCancel={onCancel}
      applyDisabled={count === 0 || !axisLabel}
    >
      <Segmented
        label="Picking"
        size={size}
        value={phase}
        options={[
          { value: 'entities', label: `Entities (${count})` },
          { value: 'axis', label: axisLabel ? 'Mirror line ✓' : 'Mirror line' },
        ]}
        onChange={onPhase}
      />
      <p className="text-xs text-fg-muted" data-testid="mirror-hint">
        {phase === 'entities'
          ? 'Select the entities to mirror.'
          : axisLabel
            ? `Mirror line: ${axisLabel}`
            : 'Select a line or construction line to mirror across.'}
      </p>
      <p className="text-2xs text-fg-subtle">The copies are constrained symmetric to the line.</p>
    </Frame>
  );
}
