import type {
  BodyOp,
  BodyScope,
  BooleanFeature,
  ChamferFeature,
  EntityRef,
  EvalResult,
  Expr,
  ExtrudeFeature,
  Feature,
  FeatureStatus,
  FilletFeature,
  ImportFeature,
  NamedDimension,
  PlaneFeature,
  PrimitiveFeature,
  PushPullFeature,
  RevolveFeature,
  SketchFeature,
  UnresolvedRef,
} from '@wren-cad/contracts';
import { CircleAlert, PenLine, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Field, Section, Segmented, Switch } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn } from '../components/primitives';
import { featureMeta } from '../features/featureMeta';
import type { FormatValue } from '../format';
import { PickField } from './PickField';

export interface FeatureInspectorProps {
  feature: Feature;
  status?: FeatureStatus;
  /** Evaluates `expr` and checks it has the `expected` dimension. */
  evaluate(expr: Expr, expected: NamedDimension): EvalResult;
  formatValue?: FormatValue;
  /** A committed edit (Enter / blur / segmented change). Receives the whole updated feature. */
  onChange(feature: Feature): void;
  /** Live preview while typing or nudging a valid value (no undo entry). */
  onPreview?(feature: Feature): void;
  /** Start picking for a ref field: `/edges` to add, `/edges/2` to replace entry 2. */
  onPick?(path: string): void;
  /** The ref path currently being picked in the viewport, if any. */
  pickingPath?: string | null;
  /** One-click re-pick of the first unresolved reference (needs-attention banner). */
  onRepick?(): void;
  describeRef?(ref: EntityRef): string;
  onEditSketch?(): void;
  /** Closes the inspector back to selection state. */
  onDone?(): void;
  units?: { length: string; angle: string };
  density?: 'compact' | 'touch';
  className?: string;
}

/** Everything the per-type field groups share. */
interface Ctx {
  evaluate: FeatureInspectorProps['evaluate'];
  formatValue?: FormatValue;
  units: { length: string; angle: string };
  size: 'md' | 'touch';
  pickingPath: string | null;
  unresolved: readonly UnresolvedRef[];
  describeRef?: FeatureInspectorProps['describeRef'];
  onPick?(path: string): void;
}

const opOptions = [
  { value: 'new', label: 'New' },
  { value: 'add', label: 'Add' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
] as const satisfies readonly { value: BodyOp; label: string }[];

const dirOptions = [
  { value: 'normal', label: 'Normal' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'symmetric', label: 'Symmetric' },
] as const;

interface Edit<F extends Feature> {
  commit(next: F): void;
  preview(next: F): void;
}

function ExprField<F extends Feature>({
  label,
  value,
  expected,
  c,
  edit,
  build,
  allowEmpty,
  placeholder,
}: {
  label: string;
  value: Expr;
  expected: NamedDimension;
  c: Ctx;
  edit: Edit<F>;
  build(expr: Expr): F;
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const unit =
    expected === 'length' ? c.units.length : expected === 'angle' ? c.units.angle : undefined;
  return (
    <Field label={label}>
      <ExpressionInput
        label={label}
        value={value}
        evaluate={(e) => c.evaluate(e, expected)}
        formatValue={c.formatValue}
        unitHint={unit}
        step={expected === 'angle' ? 5 : 1}
        size={c.size}
        allowEmpty={allowEmpty}
        placeholder={placeholder}
        onPreview={(e) => edit.preview(build(e))}
        onCommit={(e) => edit.commit(build(e))}
      />
    </Field>
  );
}

function Pick({
  label,
  path,
  refs,
  accepts,
  multi,
  c,
  onRemove,
}: {
  label: string;
  path: string;
  refs: readonly EntityRef[];
  accepts: string;
  multi?: boolean;
  c: Ctx;
  onRemove?(i: number): void;
}) {
  const here = (p: string) => p === path || p.startsWith(`${path}/`);
  return (
    <Field label={label}>
      <PickField
        label={label}
        path={path}
        refs={refs}
        accepts={accepts}
        multi={multi}
        picking={c.pickingPath !== null && here(c.pickingPath)}
        unresolved={c.unresolved.filter((u) => here(u.path))}
        describeRef={c.describeRef}
        onPick={c.onPick}
        onRemove={onRemove}
      />
    </Field>
  );
}

function ScopeFields<F extends Feature & { op: BodyOp; scope?: BodyScope }>({
  f,
  c,
  edit,
}: {
  f: F;
  c: Ctx;
  edit: Edit<F>;
}) {
  return (
    <>
      <Field label="Operation">
        <Segmented
          label="Operation"
          size={c.size}
          value={f.op}
          options={opOptions}
          onChange={(op) => edit.commit({ ...f, op })}
        />
      </Field>
      {f.op !== 'new' ? (
        <>
          <Field label="Applies to">
            <Segmented
              label="Applies to"
              size={c.size}
              value={f.scope?.kind === 'bodies' ? 'bodies' : 'all'}
              options={[
                { value: 'all', label: 'All bodies' },
                { value: 'bodies', label: 'Choose bodies' },
              ]}
              onChange={(k) =>
                edit.commit({
                  ...f,
                  scope: k === 'all' ? { kind: 'all' } : { kind: 'bodies', bodies: [] },
                })
              }
            />
          </Field>
          {f.scope?.kind === 'bodies' ? (
            <Pick
              label="Bodies"
              path="/scope/bodies"
              refs={f.scope.bodies}
              accepts="body"
              multi
              c={c}
              onRemove={(i) =>
                edit.commit({
                  ...f,
                  scope: {
                    kind: 'bodies',
                    bodies: (f.scope as { bodies: EntityRef[] }).bodies.filter((_, j) => j !== i),
                  },
                })
              }
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

const without = <T,>(xs: readonly T[], i: number): T[] => xs.filter((_, j) => j !== i);

/* ------------------------------------------------------------------------- per type */

function ExtrudeFields({ f, c, edit }: { f: ExtrudeFeature; c: Ctx; edit: Edit<ExtrudeFeature> }) {
  const endKind = f.end.kind;
  return (
    <>
      <Section title="Profile">
        <Pick
          label="Profile"
          path="/profile"
          refs={f.profile}
          accepts="sketch region"
          multi
          c={c}
          onRemove={(i) => edit.commit({ ...f, profile: without(f.profile, i) })}
        />
      </Section>
      <Section title="Extent">
        <Field label="Direction">
          <Segmented
            label="Direction"
            size={c.size}
            value={f.direction}
            options={dirOptions}
            onChange={(direction) => edit.commit({ ...f, direction })}
          />
        </Field>
        <Field label="End condition">
          <Segmented
            label="End condition"
            size={c.size}
            value={endKind}
            options={[
              { value: 'blind', label: 'Blind' },
              { value: 'upTo', label: 'Up to' },
              { value: 'throughAll', label: 'Through all' },
            ]}
            onChange={(k) =>
              edit.commit({
                ...f,
                end:
                  k === 'blind'
                    ? { kind: 'blind', depth: f.end.kind === 'blind' ? f.end.depth : '10mm' }
                    : k === 'throughAll'
                      ? { kind: 'throughAll' }
                      : {
                          kind: 'upTo',
                          target: f.end.kind === 'upTo' ? f.end.target : { name: '', kind: 'face' },
                        },
              })
            }
          />
        </Field>
        {f.end.kind === 'blind' ? (
          <ExprField
            label="Depth"
            value={f.end.depth}
            expected="length"
            c={c}
            edit={edit}
            build={(depth) => ({ ...f, end: { kind: 'blind', depth } })}
          />
        ) : null}
        {f.end.kind === 'upTo' ? (
          <Pick
            label="Up to"
            path="/end/target"
            refs={f.end.target.name ? [f.end.target] : []}
            accepts="face"
            c={c}
          />
        ) : null}
        <ExprField
          label="Draft angle"
          value={f.draft ?? ''}
          expected="angle"
          allowEmpty
          placeholder="None"
          c={c}
          edit={edit}
          build={(draft) => {
            const { draft: _drop, ...rest } = f;
            return draft.trim() ? { ...rest, draft } : rest;
          }}
        />
      </Section>
      <Section title="Result">
        <ScopeFields f={f} c={c} edit={edit} />
      </Section>
    </>
  );
}

function RevolveFields({ f, c, edit }: { f: RevolveFeature; c: Ctx; edit: Edit<RevolveFeature> }) {
  return (
    <>
      <Section title="Profile">
        <Pick
          label="Profile"
          path="/profile"
          refs={f.profile}
          accepts="sketch region"
          multi
          c={c}
          onRemove={(i) => edit.commit({ ...f, profile: without(f.profile, i) })}
        />
        <Pick
          label="Axis"
          path="/axis"
          refs={f.axis.name ? [f.axis] : []}
          accepts="axis or edge"
          c={c}
        />
      </Section>
      <Section title="Extent">
        <ExprField
          label="Angle"
          value={f.angle}
          expected="angle"
          c={c}
          edit={edit}
          build={(angle) => ({ ...f, angle })}
        />
        <Field label="Direction">
          <Segmented
            label="Direction"
            size={c.size}
            value={f.direction}
            options={dirOptions}
            onChange={(direction) => edit.commit({ ...f, direction })}
          />
        </Field>
      </Section>
      <Section title="Result">
        <ScopeFields f={f} c={c} edit={edit} />
      </Section>
    </>
  );
}

function FilletFields({ f, c, edit }: { f: FilletFeature; c: Ctx; edit: Edit<FilletFeature> }) {
  return (
    <Section title="Fillet">
      <Pick
        label="Edges"
        path="/edges"
        refs={f.edges}
        accepts="edge"
        multi
        c={c}
        onRemove={(i) => edit.commit({ ...f, edges: without(f.edges, i) })}
      />
      <ExprField
        label="Radius"
        value={f.radius}
        expected="length"
        c={c}
        edit={edit}
        build={(radius) => ({ ...f, radius })}
      />
    </Section>
  );
}

function ChamferFields({ f, c, edit }: { f: ChamferFeature; c: Ctx; edit: Edit<ChamferFeature> }) {
  const m = f.mode;
  return (
    <Section title="Chamfer">
      <Pick
        label="Edges"
        path="/edges"
        refs={f.edges}
        accepts="edge"
        multi
        c={c}
        onRemove={(i) => edit.commit({ ...f, edges: without(f.edges, i) })}
      />
      <Field label="Mode">
        <Segmented
          label="Chamfer mode"
          size={c.size}
          value={m.kind}
          options={[
            { value: 'distance', label: 'Distance' },
            { value: 'distanceAngle', label: 'Distance + angle' },
          ]}
          onChange={(k) =>
            edit.commit({
              ...f,
              mode:
                k === 'distance'
                  ? { kind: 'distance', distance: m.distance }
                  : {
                      kind: 'distanceAngle',
                      distance: m.distance,
                      angle: m.kind === 'distanceAngle' ? m.angle : '45deg',
                    },
            })
          }
        />
      </Field>
      <ExprField
        label="Distance"
        value={m.distance}
        expected="length"
        c={c}
        edit={edit}
        build={(distance) => ({ ...f, mode: { ...m, distance } })}
      />
      {m.kind === 'distanceAngle' ? (
        <ExprField
          label="Angle"
          value={m.angle}
          expected="angle"
          c={c}
          edit={edit}
          build={(angle) => ({
            ...f,
            mode: { kind: 'distanceAngle', distance: m.distance, angle },
          })}
        />
      ) : null}
    </Section>
  );
}

function BooleanFields({ f, c, edit }: { f: BooleanFeature; c: Ctx; edit: Edit<BooleanFeature> }) {
  return (
    <Section title="Boolean">
      <Field label="Operation">
        <Segmented
          label="Operation"
          size={c.size}
          value={f.op}
          options={[
            { value: 'add', label: 'Add' },
            { value: 'cut', label: 'Cut' },
            { value: 'intersect', label: 'Intersect' },
          ]}
          onChange={(op) => edit.commit({ ...f, op })}
        />
      </Field>
      <Pick
        label="Target body"
        path="/target"
        refs={f.target.name ? [f.target] : []}
        accepts="body"
        c={c}
      />
      <Pick
        label="Tool bodies"
        path="/tools"
        refs={f.tools}
        accepts="body"
        multi
        c={c}
        onRemove={(i) => edit.commit({ ...f, tools: without(f.tools, i) })}
      />
      <Switch
        label="Keep tool bodies"
        checked={f.keepTools}
        onChange={(keepTools) => edit.commit({ ...f, keepTools })}
      />
    </Section>
  );
}

function PlaneFields({ f, c, edit }: { f: PlaneFeature; c: Ctx; edit: Edit<PlaneFeature> }) {
  const d = f.definition;
  return (
    <Section title="Plane">
      {d.kind === 'offset' ? (
        <>
          <Pick
            label="Offset from"
            path="/definition/from"
            refs={d.from.name ? [d.from] : []}
            accepts="face or plane"
            c={c}
          />
          <ExprField
            label="Distance"
            value={d.distance}
            expected="length"
            c={c}
            edit={edit}
            build={(distance) => ({ ...f, definition: { ...d, distance } })}
          />
        </>
      ) : (
        <p className="text-ui text-fg-muted">Custom frame: positioned by origin and normal.</p>
      )}
    </Section>
  );
}

function PrimitiveFields({
  f,
  c,
  edit,
}: {
  f: PrimitiveFeature;
  c: Ctx;
  edit: Edit<PrimitiveFeature>;
}) {
  const dim = (label: string, key: string) => (
    <ExprField
      key={key}
      label={label}
      value={(f as unknown as Record<string, string>)[key] ?? ''}
      expected="length"
      c={c}
      edit={edit}
      build={(v) => ({ ...f, [key]: v }) as PrimitiveFeature}
    />
  );
  return (
    <>
      <Section title={f.shape[0]?.toUpperCase() + f.shape.slice(1)}>
        {f.shape === 'box'
          ? [dim('Width (X)', 'dx'), dim('Depth (Y)', 'dy'), dim('Height (Z)', 'dz')]
          : null}
        {f.shape === 'cylinder' ? [dim('Radius', 'radius'), dim('Height', 'height')] : null}
        {f.shape === 'sphere' ? dim('Radius', 'radius') : null}
      </Section>
      <Section title="Result">
        <ScopeFields f={f} c={c} edit={edit} />
      </Section>
    </>
  );
}

function SketchFields({ f, c, onEdit }: { f: SketchFeature; c: Ctx; onEdit?: () => void }) {
  const lines = f.entities.filter((e) => e.kind !== 'point').length;
  return (
    <Section title="Sketch">
      <Pick label="Sketch plane" path="/on" refs={[f.on]} accepts="plane or face" c={c} />
      <p className="tnum text-ui text-fg-muted">
        {lines} {lines === 1 ? 'entity' : 'entities'} · {f.constraints.length}{' '}
        {f.constraints.length === 1 ? 'constraint' : 'constraints'}
      </p>
      {onEdit ? (
        <Button
          variant="secondary"
          size={c.size}
          icon={<PenLine className="size-4" />}
          onClick={onEdit}
        >
          Edit sketch
        </Button>
      ) : null}
    </Section>
  );
}

function PushPullFields({
  f,
  c,
  edit,
}: {
  f: PushPullFeature;
  c: Ctx;
  edit: Edit<PushPullFeature>;
}) {
  return (
    <Section title="Push / Pull">
      <Pick
        label="Faces"
        path="/faces"
        refs={f.faces}
        accepts="face"
        multi
        c={c}
        onRemove={(i) => edit.commit({ ...f, faces: without(f.faces, i) })}
      />
      <ExprField
        label="Distance"
        value={f.distance}
        expected="length"
        c={c}
        edit={edit}
        build={(distance) => ({ ...f, distance })}
      />
    </Section>
  );
}

const FORMAT_LABEL: Record<ImportFeature['source']['format'], string> = {
  step: 'STEP',
  iges: 'IGES',
  brep: 'BREP',
  stl: 'STL mesh',
  obj: 'OBJ mesh',
  '3mf': '3MF mesh',
  glb: 'glTF binary mesh',
};

function ImportFields({ f, c, edit }: { f: ImportFeature; c: Ctx; edit: Edit<ImportFeature> }) {
  return (
    <>
      <Section title="Source">
        <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui">
          <dt className="text-fg-muted">File</dt>
          <dd className="truncate text-right font-medium" title={f.source.fileName}>
            {f.source.fileName}
          </dd>
          <dt className="text-fg-muted">Format</dt>
          <dd className="text-right font-medium">{FORMAT_LABEL[f.source.format]}</dd>
          <dt className="text-fg-muted">SHA-256</dt>
          <dd
            className="truncate text-right font-mono text-2xs text-fg-muted"
            title={f.source.sha256}
          >
            {f.source.sha256.slice(0, 12)}…
          </dd>
        </dl>
      </Section>
      <Section title="Result">
        <ScopeFields f={f} c={c} edit={edit} />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------------- component */

function StatusBanner({ status, onRepick }: { status: FeatureStatus; onRepick?: () => void }) {
  if (status.state === 'error') {
    return (
      <div
        role="alert"
        className="mx-4 mt-3 flex gap-2 rounded-control bg-danger-soft p-2.5 text-ui text-danger-text"
      >
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">
            {status.error?.message ?? 'This feature failed to rebuild.'}
          </p>
          {status.error?.hint ? <p className="mt-0.5 text-xs">{status.error.hint}</p> : null}
        </div>
      </div>
    );
  }
  if (status.state === 'needsAttention') {
    const n = Math.max(status.unresolved?.length ?? 1, 1);
    const ambiguous = status.unresolved?.[0]?.reason === 'ambiguous';
    return (
      <div
        role="alert"
        className="mx-4 mt-3 flex gap-2 rounded-control bg-warning-soft p-2.5 text-ui text-warning-text"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {n === 1 ? 'A reference needs your attention.' : `${n} references need your attention.`}
          </p>
          <p className="mt-0.5 text-xs">
            {ambiguous
              ? 'It now matches more than one entity. Wren will not guess: choose which one.'
              : 'Its geometry is gone. Wren will not guess: its old place is ghosted in the view.'}
          </p>
          {onRepick ? (
            <Button
              variant="secondary"
              icon={<RefreshCw className="size-3.5" />}
              onClick={onRepick}
              className="mt-2 h-7"
              data-testid="repick"
            >
              {ambiguous ? 'Choose' : 'Re-pick'}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return null;
}

/**
 * Right-panel editor for one feature (PLAN 9.2: non-modal, inline values with expressions).
 * Presentational: every edit calls `onChange` with the complete updated feature.
 */
export function FeatureInspector({
  feature,
  status,
  evaluate,
  formatValue,
  onChange,
  onPreview,
  onPick,
  pickingPath = null,
  onRepick,
  describeRef,
  onEditSketch,
  onDone,
  units = { length: 'mm', angle: 'deg' },
  density = 'compact',
  className,
}: FeatureInspectorProps) {
  const meta = featureMeta[feature.type];
  const c: Ctx = {
    evaluate,
    formatValue,
    units,
    size: density === 'touch' ? 'touch' : 'md',
    pickingPath,
    unresolved: status?.unresolved ?? [],
    describeRef,
    onPick,
  };
  const edit = {
    commit: (next: Feature) => onChange(next),
    preview: (next: Feature) => onPreview?.(next),
  } as Edit<never>;
  // Per-type edit handles share the same callbacks; the narrowed prop types come from `feature`.
  const e = edit as unknown as Edit<Feature>;

  let body: ReactNode;
  switch (feature.type) {
    case 'extrude':
      body = <ExtrudeFields f={feature} c={c} edit={e as Edit<ExtrudeFeature>} />;
      break;
    case 'revolve':
      body = <RevolveFields f={feature} c={c} edit={e as Edit<RevolveFeature>} />;
      break;
    case 'fillet':
      body = <FilletFields f={feature} c={c} edit={e as Edit<FilletFeature>} />;
      break;
    case 'chamfer':
      body = <ChamferFields f={feature} c={c} edit={e as Edit<ChamferFeature>} />;
      break;
    case 'boolean':
      body = <BooleanFields f={feature} c={c} edit={e as Edit<BooleanFeature>} />;
      break;
    case 'plane':
      body = <PlaneFields f={feature} c={c} edit={e as Edit<PlaneFeature>} />;
      break;
    case 'primitive':
      body = <PrimitiveFields f={feature} c={c} edit={e as Edit<PrimitiveFeature>} />;
      break;
    case 'sketch':
      body = <SketchFields f={feature} c={c} onEdit={onEditSketch} />;
      break;
    case 'pushPull':
      body = <PushPullFields f={feature} c={c} edit={e as Edit<PushPullFeature>} />;
      break;
    case 'import':
      body = <ImportFields f={feature} c={c} edit={e as Edit<ImportFeature>} />;
      break;
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="feature-inspector">
      <header className="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
        <span className="flex size-8 items-center justify-center rounded-control bg-accent-soft text-accent-text">
          <meta.Icon className="size-[18px]" strokeWidth={1.6} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm leading-5 font-semibold">{feature.name}</h2>
          <p className="text-2xs text-fg-muted">
            {meta.label}
            {feature.suppressed ? ' · Suppressed' : ''}
          </p>
        </div>
        {onDone ? (
          <Button variant="primary" size={density === 'touch' ? 'touch' : 'md'} onClick={onDone}>
            Done
          </Button>
        ) : null}
      </header>
      {status ? <StatusBanner status={status} {...(onRepick ? { onRepick } : {})} /> : null}
      {body}
    </div>
  );
}
