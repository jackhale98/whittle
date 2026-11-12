import type {
  Annotation,
  AnnotationPlacement,
  DimensionAnnotation,
  DimensionText,
  EvalResult,
  Expr,
  GeometricCharacteristic,
  GeometricToleranceAnnotation,
  HoleCalloutAnnotation,
  Id,
  MaterialCondition,
  PlacementLayout,
  SurfaceFinishAnnotation,
  Tolerance,
} from '@wren-cad/contracts';
import { Link2Off, Trash2, TriangleAlert } from 'lucide-react';
import { Field, Section, Segmented, Switch } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn } from '../components/primitives';
import { SheetValueField } from './SheetValueField';
import { ToleranceField } from './ToleranceField';

export const CHARACTERISTIC_LABELS: Record<GeometricCharacteristic, string> = {
  straightness: 'Straightness',
  flatness: 'Flatness',
  circularity: 'Circularity',
  cylindricity: 'Cylindricity',
  lineProfile: 'Profile of a line',
  surfaceProfile: 'Profile of a surface',
  parallelism: 'Parallelism',
  perpendicularity: 'Perpendicularity',
  angularity: 'Angularity',
  position: 'Position',
  concentricity: 'Concentricity',
  coaxiality: 'Coaxiality',
  symmetry: 'Symmetry',
  circularRunout: 'Circular runout',
  totalRunout: 'Total runout',
};

export interface CharacteristicChoice {
  value: GeometricCharacteristic;
  /** Why the drawing's standard refuses it (shown, never silently converted). */
  refusal?: string;
}

export interface AnnotationInspectorProps {
  annotation: Annotation;
  placement: AnnotationPlacement | undefined;
  /** The value the sheet shows, formatted; undefined when the annotation needs attention (T1). */
  valueText: string | undefined;
  state: 'ok' | 'needsAttention' | 'suppressed';
  /** Plain-language problems (unresolved references, mismatches, illegal symbols). */
  problems: readonly string[];
  /** "Driven by Plate sketch: width": a bound value is edited at its source (D6). */
  sourceText?: string;
  /** A promoted driving dimension: read-only here. */
  readOnlyReason?: string;
  evaluate(expr: Expr): EvalResult;
  /** The part's datum features, for frames. */
  datums: readonly { id: Id; label: string }[];
  characteristics: readonly CharacteristicChoice[];
  /** `undefined` when the letter is fine. */
  datumLabelProblem(label: string, own: Id): string | undefined;
  /** The dimension's value in mm or degrees, for the limits form. */
  measured?: number;
  onChange(next: Annotation): void;
  onPlacement(next: AnnotationPlacement): void;
  onRemoveFromView(): void;
  onDelete(): void;
  /** Needs attention: pick the geometry again. */
  onReattach?(): void;
  /** Leader placements: what the leader is attached to, as laid out (ADR-094). */
  leader?: LeaderInfo;
  /**
   * A datum or frame bound to a size dimension (`appliesTo`, ADR-094): that dimension in words
   * (`Ø6 diameter`, `80 width`), and what it makes the datum (`median plane`, `axis`).
   */
  appliesTo?: { dimension: string; feature?: string; missing?: boolean };
  size?: 'md' | 'touch';
}

const KIND_TITLE: Record<Annotation['kind'], string> = {
  linear: 'Linear dimension',
  aligned: 'Aligned dimension',
  ordinate: 'Ordinate dimension',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  chamfer: 'Chamfer',
  datumFeature: 'Datum feature',
  geometricTolerance: 'Tolerance frame',
  note: 'Note',
  surfaceFinish: 'Surface finish',
  holeCallout: 'Hole callout',
};

const DIMENSION_KINDS: readonly Annotation['kind'][] = [
  'linear',
  'aligned',
  'ordinate',
  'radius',
  'diameter',
  'angle',
  'chamfer',
];
const isDimension = (a: Annotation): a is DimensionAnnotation => DIMENSION_KINDS.includes(a.kind);

/**
 * Where a dimension's text sits (ADR-094): above, inline or below its line, and shifted along it.
 * The same two values dragging the text on the sheet sets, or the arrow keys with the dimension
 * selected: the typed alternative to a drag (WCAG 2.5.7).
 */
function TextPlacement({
  p,
  placement,
  sz,
}: {
  p: AnnotationInspectorProps;
  placement: AnnotationPlacement;
  sz: 'md' | 'touch';
}) {
  const kind = placement.layout.kind;
  const linear = kind === 'lane' || kind === 'offset';
  if (!linear && kind !== 'arc') return null;
  const text = placement.text ?? {};
  const put = (next: NonNullable<AnnotationPlacement['text']>) => {
    const { text: _t, ...rest } = placement;
    p.onPlacement(Object.keys(next).length > 0 ? { ...rest, text: next } : rest);
  };
  return (
    <Section title="Text position">
      {linear ? (
        <Segmented
          label="Dimension text position"
          size={sz}
          value={text.side ?? 'auto'}
          onChange={(side) => {
            const { side: _s, ...rest } = text;
            put(side === 'auto' ? rest : { ...rest, side });
          }}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'above', label: 'Above' },
            { value: 'inline', label: 'Inline' },
            { value: 'below', label: 'Below' },
          ]}
        />
      ) : null}
      <SheetValueField
        label={kind === 'arc' ? 'Text shift along the arc (mm)' : 'Text shift along the line (mm)'}
        value={text.shift ?? 0}
        unit="mm"
        step={1}
        evaluate={p.evaluate}
        onCommit={(shift) => {
          const { shift: _s, ...rest } = text;
          put(Math.abs(shift) < 1e-9 ? rest : { ...rest, shift });
        }}
        size={sz}
      />
      <p className="text-2xs text-fg-subtle">
        Or drag the text on the sheet, or move it with the arrow keys while the dimension is
        selected (Shift for 5 mm). Past an extension line the text goes outside the dimension.
      </p>
    </Section>
  );
}

/** A leader's attachment as the sheet shows it, for its inline fields. */
export interface LeaderInfo {
  /** `The surface's line`, `Ø6 (feature of size)`: what the leader is attached to. */
  target?: string;
  /** Length of the line the attach point sits on (sheet mm), for the along-the-line field. */
  lineLength?: number;
}

function layoutFields(
  layout: PlacementLayout,
  set: (l: PlacementLayout) => void,
  sz: 'md' | 'touch',
  evaluate: (expr: Expr) => EvalResult,
  leader?: LeaderInfo,
  datum?: boolean,
) {
  // Each field commits once, on Enter or blur, so one edit is one undo step (SheetValueField).
  const num = (
    label: string,
    value: number,
    on: (n: number) => void,
    step = 1,
    unit: 'mm' | 'deg' = 'mm',
  ) => (
    <SheetValueField
      key={label}
      label={label}
      value={value}
      unit={unit}
      step={step}
      evaluate={evaluate}
      onCommit={on}
      size={sz}
    />
  );
  switch (layout.kind) {
    case 'lane':
      return (
        <>
          <Field label="Side">
            <select
              aria-label="Dimension side"
              value={layout.side}
              onChange={(e) => set({ ...layout, side: e.target.value as typeof layout.side })}
              className={cn(
                'rounded-control bg-surface-2 px-2 text-ui',
                sz === 'touch' ? 'h-11 text-sm' : 'h-8',
              )}
            >
              {(['top', 'bottom', 'left', 'right'] as const).map((s) => (
                <option key={s} value={s}>
                  {s[0]?.toUpperCase()}
                  {s.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          {num('Lane (0 is nearest the view)', layout.lane, (lane) =>
            set({ ...layout, lane: Math.max(0, Math.round(lane)) }),
          )}
        </>
      );
    case 'offset':
      return num(
        'Offset from the geometry (mm)',
        layout.distance,
        (distance) => set({ ...layout, distance }),
        0.5,
      );
    case 'radial':
      return (
        <>
          {num('Leader angle (°)', layout.angle, (angle) => set({ ...layout, angle }), 5, 'deg')}
          {num(
            'Text distance (mm)',
            layout.distance,
            (distance) => set({ ...layout, distance }),
            0.5,
          )}
        </>
      );
    case 'arc':
      return (
        <>
          {num('Arc radius (mm)', layout.radius, (radius) => set({ ...layout, radius }), 0.5)}
          <Switch
            checked={layout.opposite === true}
            onChange={(on) => {
              const next = { ...layout };
              if (on) next.opposite = true;
              else delete next.opposite;
              set(next);
            }}
            label="Opposite angle (same value)"
          />
        </>
      );
    case 'leader': {
      const at = layout.attach;
      const L = leader?.lineLength;
      return (
        <>
          {leader?.target ? (
            <p className="text-xs text-fg-muted" data-testid="leader-target">
              Attached to {leader.target}
            </p>
          ) : null}
          {at.kind === 'ref' && L !== undefined && L > 1e-6
            ? num(
                datum ? 'Triangle along the line (mm)' : 'Arrow along the line (mm)',
                (at.t ?? 0.5) * L,
                // On the line: a stored `t` is in [0, 1].
                (mm) =>
                  set({
                    ...layout,
                    attach: { ...at, t: Math.round(Math.max(0, Math.min(1, mm / L)) * 1e6) / 1e6 },
                  }),
                0.5,
              )
            : null}
          {at.kind === 'dimensionLine' ? (
            <Segmented
              label="End of the dimension line"
              size={sz}
              value={at.t < 0.5 ? 'start' : 'end'}
              onChange={(v) => set({ ...layout, attach: { ...at, t: v === 'start' ? 0 : 1 } })}
              options={[
                { value: 'start', label: 'Start' },
                { value: 'end', label: 'End' },
              ]}
            />
          ) : null}
          {num(
            'Text offset X (mm)',
            layout.text[0],
            (x) => set({ ...layout, text: [x, layout.text[1]] }),
            0.5,
          )}
          {num(
            'Text offset Y (mm)',
            layout.text[1],
            (y) => set({ ...layout, text: [layout.text[0], y] }),
            0.5,
          )}
          {layout.bends && layout.bends.length > 0 ? (
            <Button
              variant="secondary"
              size={sz}
              data-testid="leader-straighten"
              onClick={() => {
                const { bends: _bends, ...rest } = layout;
                set(rest);
              }}
            >
              Straighten the leader ({layout.bends.length} bend
              {layout.bends.length === 1 ? '' : 's'})
            </Button>
          ) : null}
        </>
      );
    }
  }
}

/** What a datum or a frame on a feature of size is bound to (it follows that dimension). */
function AppliesTo({
  dimension,
  feature,
  missing,
}: NonNullable<AnnotationInspectorProps['appliesTo']>) {
  return (
    <p
      className={cn('text-xs', missing ? 'text-danger-text' : 'text-fg-muted')}
      data-testid="applies-to"
    >
      {missing
        ? 'The size dimension it applies to no longer exists.'
        : `On the feature of size of ${dimension}${feature ? ` (its ${feature})` : ''}. It follows that dimension.`}
    </p>
  );
}

/** Inspector of one annotation: its value (read-only when driven by the model), tolerance, kind-specific fields and where it sits on the view. */
export function AnnotationInspector(p: AnnotationInspectorProps) {
  const a = p.annotation;
  const sz = p.size === 'touch' ? 'touch' : 'md';
  const touch = sz === 'touch';
  const readOnly = p.readOnlyReason !== undefined;
  const input = cn(
    'rounded-control bg-surface-2 px-2.5 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)] disabled:opacity-60',
    touch ? 'h-11 text-sm' : 'h-8',
  );
  const set = <T extends Annotation>(next: T) => p.onChange(next);

  return (
    <div data-testid="annotation-inspector" data-state={p.state} className="flex flex-col">
      <Section title={KIND_TITLE[a.kind]}>
        {p.state === 'needsAttention' ? (
          <div
            role="alert"
            data-testid="annotation-attention"
            className="flex flex-col gap-1.5 rounded-control bg-danger-soft p-2.5 text-xs text-danger-text"
          >
            <span className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert className="size-4 shrink-0" aria-hidden /> Needs attention
            </span>
            {p.problems.map((m) => (
              <span key={m}>{m}</span>
            ))}
            <span>No value is shown until it is attached to geometry again.</span>
            {p.onReattach ? (
              <Button
                variant="secondary"
                size={sz}
                icon={<Link2Off className="size-4" />}
                onClick={p.onReattach}
                data-testid="reattach"
              >
                Reattach…
              </Button>
            ) : null}
          </div>
        ) : p.state === 'suppressed' ? (
          <p className="text-xs text-fg-muted">Not in this configuration.</p>
        ) : (
          <>
            {p.valueText !== undefined ? (
              <p className="tnum text-lg font-semibold" data-testid="annotation-value">
                {p.valueText}
              </p>
            ) : null}
            {p.problems.map((m) => (
              <p key={m} className="text-xs text-warning-text">
                {m}
              </p>
            ))}
          </>
        )}
        {p.sourceText ? (
          <p className="text-xs text-fg-muted" data-testid="annotation-source">
            {p.sourceText}
          </p>
        ) : null}
        {readOnly ? (
          <p className="text-xs text-fg-muted" data-testid="annotation-readonly">
            {p.readOnlyReason}
          </p>
        ) : null}
      </Section>

      {isDimension(a) ? (
        <Section title="Value and tolerance">
          {a.source === undefined ? (
            <Field label="Stated value" hint="Empty: measured from the geometry.">
              <ExpressionInput
                label="Stated value"
                value={a.nominal ?? ''}
                allowEmpty
                evaluate={p.evaluate}
                unitHint={a.kind === 'angle' ? 'deg' : 'mm'}
                onCommit={(t) => {
                  const next: DimensionAnnotation = { ...a };
                  if (t.trim() === '') delete next.nominal;
                  else next.nominal = t;
                  set(next);
                }}
                size={sz}
                paramLinks="complete"
                showValue={false}
              />
            </Field>
          ) : null}
          {a.kind !== 'chamfer' ? (
            <ToleranceField
              value={a.tolerance}
              nominal={a.nominal}
              quantity={a.kind === 'angle' ? 'angle' : 'length'}
              {...(p.measured !== undefined ? { measured: p.measured } : {})}
              size={sz}
              onCommit={({ nominal, tolerance }) => {
                const next = { ...a } as Extract<Annotation, { tolerance?: Tolerance }>;
                if (tolerance === null) delete next.tolerance;
                else next.tolerance = tolerance;
                if (nominal && a.source === undefined)
                  (next as { nominal?: Expr }).nominal = nominal;
                set(next as Annotation);
              }}
            />
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Text before">
              <input
                aria-label="Text before the value"
                value={a.text?.prefix ?? ''}
                placeholder="4×"
                onChange={(e) => {
                  const text: DimensionText = { ...(a.text ?? {}) };
                  if (e.target.value === '') delete text.prefix;
                  else text.prefix = e.target.value;
                  set({ ...a, text });
                }}
                className={input}
              />
            </Field>
            <Field label="Text after">
              <input
                aria-label="Text after the value"
                value={a.text?.suffix ?? ''}
                placeholder="TYP"
                onChange={(e) => {
                  const text: DimensionText = { ...(a.text ?? {}) };
                  if (e.target.value === '') delete text.suffix;
                  else text.suffix = e.target.value;
                  set({ ...a, text });
                }}
                className={input}
              />
            </Field>
          </div>
          <Switch
            checked={a.text?.count === true}
            onChange={(on) => {
              const text: DimensionText = { ...(a.text ?? {}) };
              if (on) text.count = true;
              else delete text.count;
              set({ ...a, text });
            }}
            label="Instance count (N×), from the model"
          />
        </Section>
      ) : null}

      {a.kind === 'datumFeature' ? (
        <Section title="Datum">
          <Field
            label="Letter"
            hint={p.datumLabelProblem(a.label, a.id) ?? 'Never I, O or Q; unique in the part.'}
          >
            <input
              aria-label="Datum letter"
              value={a.label}
              maxLength={3}
              onChange={(e) => set({ ...a, label: e.target.value.toUpperCase() })}
              aria-invalid={p.datumLabelProblem(a.label, a.id) !== undefined || undefined}
              className={cn(input, 'w-24')}
            />
          </Field>
          {p.appliesTo ? <AppliesTo {...p.appliesTo} /> : null}
        </Section>
      ) : null}

      {a.kind === 'geometricTolerance' ? (
        <>
          <FrameFields a={a} p={p} set={set} sz={sz} input={input} />
          {p.appliesTo ? (
            <div className="px-4 pb-2">
              <AppliesTo {...p.appliesTo} />
            </div>
          ) : null}
        </>
      ) : null}

      {a.kind === 'surfaceFinish' ? (
        <FinishFields a={a} set={set} p={p} sz={sz} input={input} />
      ) : null}

      {a.kind === 'note' ? (
        <Section title="Note">
          <Field label="Text">
            <textarea
              aria-label="Note text"
              value={a.text}
              rows={3}
              onChange={(e) => set({ ...a, text: e.target.value })}
              className={cn(input, 'h-auto py-1.5')}
            />
          </Field>
        </Section>
      ) : null}

      {a.kind === 'holeCallout' ? <HoleFields a={a} set={set} p={p} sz={sz} /> : null}

      {p.placement ? (
        <Section title="Placement on this view">
          {layoutFields(
            p.placement.layout,
            (layout) => p.onPlacement({ ...(p.placement as AnnotationPlacement), layout }),
            sz,
            p.evaluate,
            p.leader,
            a.kind === 'datumFeature',
          )}
          <p className="text-2xs text-fg-subtle">
            {p.placement.layout.kind === 'leader'
              ? 'Or drag it on the sheet: the text, the bends, and the attach point along its line.'
              : 'Or drag it on the sheet. The placement keeps its lane or offset when the model changes.'}
          </p>
        </Section>
      ) : null}

      {p.placement && isDimension(a) ? (
        <TextPlacement p={p} placement={p.placement} sz={sz} />
      ) : null}

      <Section title="Annotation">
        {p.placement ? (
          <Button
            variant="secondary"
            size={sz}
            onClick={p.onRemoveFromView}
            data-testid="remove-from-view"
          >
            Remove from this view
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size={sz}
          icon={<Trash2 className="size-4" />}
          onClick={p.onDelete}
          data-testid="delete-annotation"
        >
          Delete annotation from the part
        </Button>
      </Section>
    </div>
  );
}

type FieldProps<T extends Annotation> = {
  a: T;
  p: AnnotationInspectorProps;
  set(next: Annotation): void;
  sz: 'md' | 'touch';
  input: string;
};

function FrameFields({ a, p, set, sz }: FieldProps<GeometricToleranceAnnotation>) {
  const cond: { value: MaterialCondition | 'none'; label: string }[] = [
    { value: 'none', label: 'RFS' },
    { value: 'mmc', label: 'MMC' },
    { value: 'lmc', label: 'LMC' },
  ];
  const refused = p.characteristics.find((c) => c.value === a.characteristic)?.refusal;
  const compartments = a.datums ?? [];
  return (
    <Section title="Tolerance frame">
      <Field label="Characteristic" hint={refused}>
        <select
          aria-label="Geometric characteristic"
          value={a.characteristic}
          onChange={(e) => set({ ...a, characteristic: e.target.value as GeometricCharacteristic })}
          className={cn(
            'rounded-control bg-surface-2 px-2 text-ui',
            sz === 'touch' ? 'h-11 text-sm' : 'h-8',
          )}
        >
          {p.characteristics.map((c) => (
            <option
              key={c.value}
              value={c.value}
              disabled={c.refusal !== undefined && c.value !== a.characteristic}
            >
              {CHARACTERISTIC_LABELS[c.value]}
              {c.refusal ? ' (not in this standard)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Zone size">
        <ExpressionInput
          label="Tolerance zone size"
          value={a.zone.value}
          evaluate={p.evaluate}
          unitHint="mm"
          onCommit={(t) => set({ ...a, zone: { ...a.zone, value: t } })}
          size={sz}
          paramLinks="complete"
          showValue={false}
        />
      </Field>
      <Switch
        checked={a.zone.shape === 'diameter'}
        onChange={(on) => {
          const zone = { ...a.zone };
          if (on) zone.shape = 'diameter';
          else delete zone.shape;
          set({ ...a, zone });
        }}
        label="Diameter zone (Ø)"
      />
      <Segmented
        label="Material condition of the zone"
        size={sz}
        value={a.zone.material ?? 'none'}
        onChange={(v) => {
          const zone = { ...a.zone };
          if (v === 'none') delete zone.material;
          else zone.material = v;
          set({ ...a, zone });
        }}
        options={cond.map((c) => ({ value: c.value, label: c.label }))}
      />
      <Field
        label="Datums"
        hint={p.datums.length === 0 ? 'Add a datum feature to refer to it here.' : undefined}
      >
        <div className="flex flex-col gap-1.5">
          {[0, 1, 2].map((i) => {
            const cur = compartments[i]?.datums[0];
            const v = cur && 'datum' in cur ? cur.datum : cur ? `label:${cur.label}` : '';
            return (
              <select
                key={i}
                aria-label={['Primary datum', 'Secondary datum', 'Tertiary datum'][i]}
                value={v}
                onChange={(e) => {
                  const next = compartments.map((c) => ({ ...c }));
                  const val = e.target.value;
                  if (val === '') next.splice(i);
                  else next[i] = { datums: [{ datum: val }] };
                  const out = { ...a } as GeometricToleranceAnnotation;
                  if (next.length) out.datums = next;
                  else delete out.datums;
                  set(out);
                }}
                className={cn(
                  'rounded-control bg-surface-2 px-2 text-ui',
                  sz === 'touch' ? 'h-11 text-sm' : 'h-8',
                )}
              >
                <option value="">{['Primary', 'Secondary', 'Tertiary'][i]}: none</option>
                {p.datums.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
                {cur && 'label' in cur ? (
                  <option value={`label:${cur.label}`}>{cur.label} (unbound)</option>
                ) : null}
              </select>
            );
          })}
        </div>
      </Field>
    </Section>
  );
}

function FinishFields({ a, p, set, sz, input }: FieldProps<SurfaceFinishAnnotation>) {
  const req = a.requirements[0];
  return (
    <Section title="Surface texture">
      <Field label="Process">
        <Segmented
          label="Machining requirement"
          size={sz}
          value={a.process}
          onChange={(process) => set({ ...a, process })}
          options={[
            { value: 'any', label: 'Any' },
            { value: 'removalRequired', label: 'Machined' },
            { value: 'removalProhibited', label: 'No removal' },
          ]}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Parameter">
          <select
            aria-label="Roughness parameter"
            value={req?.parameter ?? 'Ra'}
            onChange={(e) =>
              set({
                ...a,
                requirements: [{ value: '1.6 um', ...(req ?? {}), parameter: e.target.value }],
              })
            }
            className={cn(
              'rounded-control bg-surface-2 px-2 text-ui',
              sz === 'touch' ? 'h-11 text-sm' : 'h-8',
            )}
          >
            {['Ra', 'Rz', 'Rq', 'Rt'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label="Limit">
          <ExpressionInput
            label="Roughness limit"
            value={req?.value ?? ''}
            evaluate={p.evaluate}
            unitHint="um"
            onCommit={(t) =>
              set({ ...a, requirements: [{ parameter: 'Ra', ...(req ?? {}), value: t }] })
            }
            size={sz}
            paramLinks="off"
            showValue={false}
          />
        </Field>
      </div>
      <Field label="Method">
        <input
          aria-label="Manufacturing method"
          value={a.method ?? ''}
          placeholder="ground"
          onChange={(e) => {
            const next = { ...a };
            if (e.target.value === '') delete next.method;
            else next.method = e.target.value;
            set(next);
          }}
          className={input}
        />
      </Field>
    </Section>
  );
}

function HoleFields({ a, set, p, sz }: Omit<FieldProps<HoleCalloutAnnotation>, 'input'>) {
  const show = a.show ?? {};
  const toggle = (k: keyof NonNullable<HoleCalloutAnnotation['show']>, label: string) => (
    <Switch
      key={k}
      checked={show[k] !== false}
      onChange={(on) => set({ ...a, show: { ...show, [k]: on } })}
      label={label}
    />
  );
  return (
    <Section title="Hole callout">
      {toggle('count', 'Instance count (4×)')}
      {toggle('depth', 'Depth')}
      {toggle('thread', 'Thread')}
      {toggle('counterbore', 'Counterbore')}
      {toggle('countersink', 'Countersink')}
      <ToleranceField
        value={a.tolerance}
        label="Diameter tolerance"
        size={sz}
        onCommit={({ tolerance }) => {
          const next = { ...a };
          if (tolerance === null) delete next.tolerance;
          else next.tolerance = tolerance;
          set(next);
        }}
      />
      <p className="text-2xs text-fg-subtle">
        {p.sourceText ??
          'The numbers come from the hole feature, so editing it updates every view.'}
      </p>
    </Section>
  );
}
