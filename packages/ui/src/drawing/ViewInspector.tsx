import type { EvalResult, Expr, Id, ViewDisplay } from '@wren-cad/contracts';
import { Layers, Trash2 } from 'lucide-react';
import { Field, Section, Segmented, Switch } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn } from '../components/primitives';
import { SheetValueField } from './SheetValueField';

export interface ConfigChoice {
  id: Id | null;
  name: string;
}

/**
 * The badge of a view or drawing that is not in Default: which configuration it shows. A view
 * with its own configuration (`own`) is badged more strongly; a missing one reads as needs
 * attention, never as a fall-back to Default (trap T13).
 */
export function ConfigBadge({
  name,
  own,
  missing,
  className,
}: {
  name: string;
  own?: boolean;
  missing?: boolean;
  className?: string;
}) {
  return (
    <span
      data-testid="config-badge"
      data-own={own || undefined}
      data-missing={missing || undefined}
      className={cn(
        'inline-flex max-w-[16ch] items-center gap-1 truncate rounded-full px-2 py-0.5 text-2xs font-medium',
        missing
          ? 'bg-danger-soft text-danger-text'
          : own
            ? 'bg-accent-soft text-accent-text'
            : 'bg-surface-3 text-fg-muted',
        className,
      )}
      title={missing ? `Configuration “${name}” no longer exists` : `Configuration: ${name}`}
    >
      <Layers className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{missing ? 'Missing configuration' : name}</span>
    </span>
  );
}

export interface ViewInspectorProps {
  kind: 'base' | 'projected' | 'iso' | 'section' | 'detail';
  title: string;
  /** What the view is derived from, for the subtitle. */
  parentName?: string;
  /** The view's own scale text, or `''` when it inherits. */
  scale: string;
  /** What an inheriting view shows (`1:2`). */
  inheritedScale: string;
  evaluateScale(text: string): EvalResult;
  onScale(text: string | null): void;
  label: string;
  /** The derived label placeholder (`A–A`). */
  derivedLabel: string;
  showLabel: boolean;
  onLabel(text: string | null): void;
  onShowLabel(show: boolean): void;
  display: ViewDisplay;
  onDisplay(patch: Partial<ViewDisplay>): void;
  configuration: {
    /** `undefined` = the drawing's, `null` = Default, else an id. */
    value: Id | null | undefined;
    options: readonly ConfigChoice[];
    drawingName: string;
    missing?: boolean;
  };
  onConfiguration(value: Id | null | undefined): void;
  /**
   * The sheet the view is on. Moving it takes the views aligned to it along (ADR-094); `note`
   * says what moves with it, or why it cannot move on its own.
   */
  sheet?: {
    value: Id;
    options: readonly { id: Id; name: string }[];
    onChange(id: Id): void;
    note?: string;
    /** Set when the view cannot move by itself (an aligned view follows its parent). */
    blocked?: string;
  };
  /** Free views: the position of the view's centre (sheet mm). */
  position?: { x: number; y: number };
  onPosition?(x: number, y: number): void;
  /** Aligned views: the centre distance from the parent (sheet mm). */
  distance?: number;
  onDistance?(mm: number): void;
  /** A section's reading side and depth. */
  section?: {
    letter: string;
    look: 'left' | 'right';
    depth: 'full' | 'slice';
    onLetter(l: string): void;
    onFlip(): void;
    onDepth(d: 'full' | 'slice'): void;
    aligned: boolean;
    /** The cut line's vertices (parent view plane, mm): editable inline, the alternative to dragging. */
    cut?: {
      kind: 'full' | 'half' | 'offset' | 'stepped';
      points: { x: number; y: number; editable: boolean }[];
      /** One coordinate of one vertex (the other is read where the edit lands, never from here). */
      onMove(index: number, axis: 'x' | 'y', value: number): void;
      onAdd(): void;
      onRemove(index: number): void;
      /** Only offered on a straight cut. */
      onHalf?(): void;
      onOffset?(): void;
    };
  };
  /** A base view's in-plane rotation (an angle expression: `90`, `90deg`, `a/2`); empty: none. */
  rotation?: { value: Expr; evaluate(expr: Expr): EvalResult; onChange(expr: Expr | null): void };
  detail?: {
    letter: string;
    radius: number;
    onRadius(r: number): void;
    onLetter(l: string): void;
    /**
     * The circle's centre on the parent view's plane (part mm), when it is a free point: the typed
     * alternative to dragging the circle's handles (ADR-094).
     */
    center?: { x: number; y: number };
    onCenter?(x: number, y: number): void;
  };
  /** Views derived from this one (deleting removes them too). */
  dependents: number;
  onDelete(): void;
  onDetachAndDelete?(): void;
  evaluate(expr: Expr): EvalResult;
  size?: 'md' | 'touch';
}

const mmFmt = (v: number) => `${Math.round(v * 100) / 100} mm`;

/** Inspector of one view: label, scale, display, configuration, position. */
export function ViewInspector(p: ViewInspectorProps) {
  const touch = p.size === 'touch';
  const sz = touch ? 'touch' : 'md';
  const cfgValue =
    p.configuration.value === undefined ? 'inherit' : (p.configuration.value ?? 'default');
  return (
    <div data-testid="view-inspector" className="flex flex-col">
      <Section title={p.title}>
        {p.parentName ? <p className="text-xs text-fg-muted">From {p.parentName}</p> : null}
        {p.sheet ? (
          <Field
            label="On sheet"
            hint={
              p.sheet.blocked ??
              (p.sheet.options.length < 2 ? 'Add a sheet to move views to it.' : p.sheet.note)
            }
          >
            <select
              aria-label="On sheet"
              data-testid="view-sheet"
              value={p.sheet.value}
              disabled={p.sheet.blocked !== undefined || p.sheet.options.length < 2}
              onChange={(e) => p.sheet?.onChange(e.target.value)}
              className={cn(
                'rounded-control bg-surface-2 px-2 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)] disabled:opacity-60',
                touch ? 'h-11 text-sm' : 'h-8',
              )}
            >
              {p.sheet.options.map((o, i) => (
                <option key={o.id} value={o.id}>
                  {i + 1} {o.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field
          label="Scale"
          hint={p.scale === '' ? `Inherited: ${p.inheritedScale}` : undefined}
          adornment={
            p.scale !== '' ? (
              <button
                type="button"
                className="text-2xs text-accent-text underline"
                onClick={() => p.onScale(null)}
              >
                Inherit
              </button>
            ) : null
          }
        >
          <ExpressionInput
            label="View scale"
            value={p.scale === '' ? p.inheritedScale : p.scale}
            evaluate={p.evaluateScale}
            onCommit={(t) => p.onScale(t)}
            keypad="auto"
            size={sz}
            paramLinks="off"
            showValue={false}
            testId="view-scale"
          />
        </Field>
        <Field
          label="Label"
          hint={p.label === '' ? `Shown as: ${p.derivedLabel || 'none'}` : undefined}
        >
          <input
            aria-label="View label"
            value={p.label}
            placeholder={p.derivedLabel || 'No label'}
            onChange={(e) => p.onLabel(e.target.value === '' ? null : e.target.value)}
            className={cn(
              'rounded-control bg-surface-2 px-2.5 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
              touch ? 'h-11 text-sm' : 'h-8',
            )}
          />
        </Field>
        <Switch checked={p.showLabel} onChange={p.onShowLabel} label="Show the label" />
      </Section>

      {p.section ? (
        <Section title="Section">
          <Field label="Letter">
            <input
              aria-label="Section letter"
              value={p.section.letter}
              maxLength={2}
              onChange={(e) => p.section?.onLetter(e.target.value.toUpperCase())}
              className="h-8 w-16 rounded-control bg-surface-2 px-2.5 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]"
            />
          </Field>
          <Segmented
            label="What the section shows"
            size={sz}
            value={p.section.depth}
            onChange={p.section.onDepth}
            options={[
              { value: 'full', label: 'Everything behind' },
              { value: 'slice', label: 'Cut face only' },
            ]}
          />
          <Button variant="secondary" size={sz} onClick={p.section.onFlip}>
            Flip viewing side
          </Button>
          <p className="text-2xs text-fg-subtle">
            Looking to the {p.section.look} of the cut line.{' '}
            {p.section.aligned ? 'Aligned with its parent.' : 'Placed freely.'}
          </p>
        </Section>
      ) : null}

      {p.section?.cut ? (
        <CutLineSection cut={p.section.cut} evaluate={p.evaluate} size={sz} />
      ) : null}

      {p.rotation ? (
        <Section title="Rotation">
          <Field
            label="Turn the view on the sheet"
            hint="Counter-clockwise, in degrees. Views projected from it follow."
          >
            <ExpressionInput
              label="View rotation"
              value={p.rotation.value}
              allowEmpty
              evaluate={p.rotation.evaluate}
              unitHint="deg"
              step={90}
              onCommit={(t) => p.rotation?.onChange(t.trim() === '' ? null : t)}
              size={sz}
              paramLinks="complete"
              showValue={false}
            />
          </Field>
        </Section>
      ) : null}

      {p.detail ? (
        <Section title="Detail">
          <Field label="Letter">
            <input
              aria-label="Detail letter"
              value={p.detail.letter}
              maxLength={2}
              onChange={(e) => p.detail?.onLetter(e.target.value.toUpperCase())}
              className="h-8 w-16 rounded-control bg-surface-2 px-2.5 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]"
            />
          </Field>
          <Field label="Circle radius">
            <ExpressionInput
              label="Detail circle radius"
              value={mmFmt(p.detail.radius)}
              evaluate={p.evaluate}
              unitHint="mm"
              onCommit={(t) => {
                const r = p.evaluate(t);
                if (r.ok) p.detail?.onRadius(r.value);
              }}
              size={sz}
              paramLinks="off"
              showValue={false}
            />
          </Field>
          {p.detail.center && p.detail.onCenter ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Centre X">
                <ExpressionInput
                  label="Detail circle centre X"
                  value={mmFmt(p.detail.center.x)}
                  evaluate={p.evaluate}
                  unitHint="mm"
                  onCommit={(t) => {
                    const r = p.evaluate(t);
                    if (r.ok && p.detail?.center) p.detail.onCenter?.(r.value, p.detail.center.y);
                  }}
                  size={sz}
                  paramLinks="off"
                  showValue={false}
                />
              </Field>
              <Field label="Centre Y">
                <ExpressionInput
                  label="Detail circle centre Y"
                  value={mmFmt(p.detail.center.y)}
                  evaluate={p.evaluate}
                  unitHint="mm"
                  onCommit={(t) => {
                    const r = p.evaluate(t);
                    if (r.ok && p.detail?.center) p.detail.onCenter?.(p.detail.center.x, r.value);
                  }}
                  size={sz}
                  paramLinks="off"
                  showValue={false}
                />
              </Field>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section title="Display">
        <Segmented
          label="Lines shown"
          size={sz}
          value={p.display.lines}
          onChange={(lines) => p.onDisplay({ lines })}
          options={[
            { value: 'visible', label: 'Visible' },
            { value: 'visibleAndHidden', label: 'With hidden' },
          ]}
        />
        <Segmented
          label="Tangent edges"
          size={sz}
          value={p.display.tangentEdges}
          onChange={(tangentEdges) => p.onDisplay({ tangentEdges })}
          options={[
            { value: 'off', label: 'No tangents' },
            { value: 'thin', label: 'Thin' },
            { value: 'visible', label: 'Full' },
          ]}
        />
        <Switch
          checked={p.display.centerMarks}
          onChange={(centerMarks) => p.onDisplay({ centerMarks })}
          label="Centre marks"
        />
      </Section>

      <Section title="Configuration">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">Shows</span>
          <select
            aria-label="Configuration of this view"
            value={cfgValue}
            onChange={(e) => {
              const v = e.target.value;
              p.onConfiguration(v === 'inherit' ? undefined : v === 'default' ? null : v);
            }}
            className={cn(
              'rounded-control bg-surface-2 px-2 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
              touch ? 'h-11 text-sm' : 'h-8',
            )}
          >
            <option value="inherit">The drawing’s ({p.configuration.drawingName})</option>
            <option value="default">Default</option>
            {p.configuration.options
              .filter((o) => o.id !== null)
              .map((o) => (
                <option key={o.id} value={o.id as string}>
                  {o.name}
                </option>
              ))}
            {p.configuration.missing && typeof p.configuration.value === 'string' ? (
              <option value={p.configuration.value}>Missing configuration</option>
            ) : null}
          </select>
        </label>
        {p.configuration.value !== undefined ? (
          <ConfigBadge
            own
            name={
              p.configuration.value === null
                ? 'Default'
                : (p.configuration.options.find((o) => o.id === p.configuration.value)?.name ??
                  'Missing configuration')
            }
            {...(p.configuration.missing ? { missing: true } : {})}
          />
        ) : null}
      </Section>

      {p.position && p.onPosition ? (
        <Section title="Position">
          <div className="grid grid-cols-2 gap-2">
            <Field label="X">
              <ExpressionInput
                label="View centre X"
                value={mmFmt(p.position.x)}
                evaluate={p.evaluate}
                unitHint="mm"
                onCommit={(t) => {
                  const r = p.evaluate(t);
                  if (r.ok && p.position) p.onPosition?.(r.value, p.position.y);
                }}
                size={sz}
                paramLinks="off"
                showValue={false}
              />
            </Field>
            <Field label="Y">
              <ExpressionInput
                label="View centre Y"
                value={mmFmt(p.position.y)}
                evaluate={p.evaluate}
                unitHint="mm"
                onCommit={(t) => {
                  const r = p.evaluate(t);
                  if (r.ok && p.position) p.onPosition?.(p.position.x, r.value);
                }}
                size={sz}
                paramLinks="off"
                showValue={false}
              />
            </Field>
          </div>
        </Section>
      ) : null}
      {p.distance !== undefined && p.onDistance ? (
        <Section title="Alignment">
          <Field
            label="Distance from its parent"
            hint="It stays on the projection axis; the side follows the projection method."
          >
            <ExpressionInput
              label="Distance from parent view"
              value={mmFmt(p.distance)}
              evaluate={p.evaluate}
              unitHint="mm"
              onCommit={(t) => {
                const r = p.evaluate(t);
                if (r.ok && r.value > 0) p.onDistance?.(r.value);
              }}
              size={sz}
              paramLinks="off"
              showValue={false}
            />
          </Field>
        </Section>
      ) : null}

      <Section title="View">
        <Button
          variant="secondary"
          size={sz}
          icon={<Trash2 className="size-4" />}
          onClick={p.onDelete}
          data-testid="delete-view"
        >
          {p.dependents > 0
            ? `Delete with ${p.dependents} derived view${p.dependents === 1 ? '' : 's'}`
            : 'Delete view'}
        </Button>
        {p.dependents > 0 && p.onDetachAndDelete ? (
          <Button variant="ghost" size={sz} onClick={p.onDetachAndDelete}>
            Delete, keep derived views
          </Button>
        ) : null}
      </Section>
    </div>
  );
}

const CUT_KIND_LABEL = {
  full: 'A straight cut: a full section.',
  half: 'An L-shaped cut: a half section.',
  offset: 'A cut with one jog: an offset section.',
  stepped: 'A stepped cut: an offset section.',
} as const;

type CutProps = NonNullable<NonNullable<ViewInspectorProps['section']>['cut']>;

/**
 * The cut line of a section as typed vertices (and, on the sheet, handles to drag): bend a straight
 * cut into a half or offset section, add or remove a vertex. Inline, no dialog.
 */
function CutLineSection({
  cut,
  evaluate,
  size,
}: {
  cut: CutProps;
  evaluate(expr: Expr): EvalResult;
  size: 'md' | 'touch';
}) {
  return (
    <Section title="Cut line">
      <p className="text-2xs text-fg-muted" data-testid="cut-kind">
        {CUT_KIND_LABEL[cut.kind]}
      </p>
      {cut.onHalf || cut.onOffset ? (
        <div className="flex flex-wrap gap-2">
          {cut.onHalf ? (
            <Button variant="secondary" size={size} onClick={cut.onHalf} data-testid="cut-half">
              Make a half section
            </Button>
          ) : null}
          {cut.onOffset ? (
            <Button variant="secondary" size={size} onClick={cut.onOffset} data-testid="cut-offset">
              Make an offset section
            </Button>
          ) : null}
        </div>
      ) : null}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {cut.points.map((pt, i) => (
          // The vertices are positional: an index is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <li key={i} className="flex flex-col gap-1.5" data-testid="cut-vertex">
            <span className="text-xs font-medium text-fg-muted">Vertex {i + 1}</span>
            {pt.editable ? (
              <div className="grid grid-cols-2 gap-2">
                <SheetValueField
                  label={`Cut vertex ${i + 1} X (mm)`}
                  value={pt.x}
                  evaluate={evaluate}
                  onCommit={(x) => cut.onMove(i, 'x', x)}
                  size={size}
                />
                <SheetValueField
                  label={`Cut vertex ${i + 1} Y (mm)`}
                  value={pt.y}
                  evaluate={evaluate}
                  onCommit={(y) => cut.onMove(i, 'y', y)}
                  size={size}
                />
              </div>
            ) : (
              <p className="text-2xs text-fg-subtle">Follows a model edge.</p>
            )}
            {cut.points.length > 2 ? (
              <Button
                variant="ghost"
                size={size}
                onClick={() => cut.onRemove(i)}
                className="self-start"
              >
                Remove vertex {i + 1}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      <Button variant="secondary" size={size} onClick={cut.onAdd} data-testid="cut-add">
        Add a vertex
      </Button>
    </Section>
  );
}
