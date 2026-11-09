import type {
  AxisFeature,
  CircularPatternFeature,
  CopySource,
  DraftFeature,
  EntityKind,
  EntityRef,
  Expr,
  Feature,
  LinearPatternFeature,
  LoftFeature,
  MirrorFeature,
  NamedDimension,
  PlaneFeature,
  PointFeature,
  ShellFeature,
  SweepFeature,
  ThreadFeature,
} from '@whittle/contracts';
import { Crosshair, Info, Plus, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Field, fieldClass, Section, Segmented, Switch } from '../components/controls';
import { cn } from '../components/primitives';
import { type Ctx, type Edit, ExprField, Pick, ScopeFields, without } from './fieldKit';

/* ------------------------------------------------------------------------- shared bits */

export const emptyRef = (kind: EntityKind): EntityRef => ({ name: '', kind });
const one = (r: EntityRef): EntityRef[] => (r.name ? [r] : []);

/** Value in canonical units (mm, rad), or undefined while the expression is invalid. */
function num(c: Ctx, expr: Expr | undefined, dim: NamedDimension): number | undefined {
  if (expr === undefined || !expr.trim()) return undefined;
  const r = c.evaluate(expr, dim);
  return r.ok ? r.value : undefined;
}

const outside01 = (t: number | undefined) => t !== undefined && (t < 0 || t > 1);

/** A live, polite validation message under a field group. `warn` blocks a rebuild, `info` guides. */
export function Note({ tone = 'warn', children }: { tone?: 'warn' | 'info'; children: ReactNode }) {
  const Icon = tone === 'warn' ? TriangleAlert : Info;
  return (
    <p
      role="status"
      data-testid="validation"
      data-tone={tone}
      className={cn(
        'flex gap-1.5 rounded-control p-2 text-xs',
        tone === 'warn' ? 'bg-warning-soft text-warning-text' : 'bg-surface-2 text-fg-muted',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Native select with a visible label (many options: plane / axis / point kinds). */
export function KindSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  size,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(v: T): void;
  size: Ctx['size'];
}) {
  return (
    <Field label={label}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(fieldClass, size === 'touch' && 'h-11')}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Instance toggles for patterns: the original (0) is fixed, every other instance can be skipped. */
export function SkipGrid({
  total,
  skip,
  onChange,
  size,
}: {
  total: number;
  skip: readonly number[];
  onChange(next: number[]): void;
  size: Ctx['size'];
}) {
  const shown = Math.min(total, 64);
  if (shown < 2) return null;
  return (
    <Field
      label="Instances"
      hint={
        skip.length
          ? `${skip.length} skipped. Skipped instances keep their numbers.`
          : 'Tap an instance to leave it out.'
      }
    >
      <ul
        aria-label="Pattern instances"
        data-testid="skip-grid"
        className="m-0 flex list-none flex-wrap gap-1 p-0"
      >
        {Array.from({ length: shown }, (_, i) => {
          const skipped = skip.includes(i);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the instance identity
            <li key={`inst${i}`} className="list-none">
              <button
                type="button"
                aria-pressed={!skipped}
                aria-label={
                  i === 0
                    ? 'Instance 1 (original)'
                    : `Instance ${i + 1}: ${skipped ? 'skipped' : 'included'}`
                }
                disabled={i === 0}
                data-skipped={skipped || undefined}
                onClick={() =>
                  onChange(
                    skipped ? skip.filter((s) => s !== i) : [...skip, i].sort((a, b) => a - b),
                  )
                }
                className={cn(
                  'tnum flex items-center justify-center rounded-control text-xs font-medium transition-colors duration-fast disabled:opacity-60',
                  size === 'touch' ? 'size-11' : 'size-7',
                  skipped
                    ? 'text-fg-subtle line-through shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                    : 'bg-accent-soft text-accent-text',
                )}
              >
                {i + 1}
              </button>
            </li>
          );
        })}
      </ul>
      {total > shown ? <p className="text-2xs text-fg-subtle">Showing the first {shown}.</p> : null}
    </Field>
  );
}

/* ------------------------------------------------------------------------- copy source */

function FeatureIds({
  ids,
  c,
  onRemove,
}: {
  ids: readonly string[];
  c: Ctx;
  onRemove(i: number): void;
}) {
  const path = '/source/features';
  const picking = c.pickingPath === path;
  return (
    <Field label="Features to copy">
      <ul aria-label="Features to copy" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {ids.map((id, i) => {
          const text = c.describeFeature?.(id) ?? id;
          return (
            <li key={id} className="list-none">
              <span className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-xs font-medium text-accent-text">
                <span className="max-w-[16ch] truncate" title={text}>
                  {text}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${text}`}
                  onClick={() => onRemove(i)}
                  className="flex size-5 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            </li>
          );
        })}
        <li className="list-none">
          <button
            type="button"
            aria-pressed={picking}
            onClick={() => c.onPick?.(path)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-fast',
              picking
                ? 'bg-accent text-accent-fg'
                : 'text-fg-muted shadow-[inset_0_0_0_1px_var(--color-border-strong)] hover:bg-surface-2 hover:text-fg',
            )}
          >
            {picking ? (
              <Crosshair className="w-pulse size-3.5" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            {picking ? 'Select a feature' : ids.length ? 'Add' : 'Pick features…'}
          </button>
        </li>
      </ul>
    </Field>
  );
}

function CopySourceFields<F extends Feature & { source: CopySource }>({
  f,
  c,
  edit,
}: {
  f: F;
  c: Ctx;
  edit: Edit<F>;
}) {
  const s = f.source;
  return (
    <>
      <Field label="Copy">
        <Segmented
          label="Copy source"
          size={c.size}
          value={s.kind}
          options={[
            { value: 'features', label: 'Features' },
            { value: 'bodies', label: 'Bodies' },
          ]}
          onChange={(k) =>
            edit.commit({
              ...f,
              source:
                k === 'features'
                  ? { kind: 'features', features: [] }
                  : { kind: 'bodies', bodies: [], merge: true },
            })
          }
        />
      </Field>
      {s.kind === 'features' ? (
        <FeatureIds
          ids={s.features}
          c={c}
          onRemove={(i) =>
            edit.commit({ ...f, source: { kind: 'features', features: without(s.features, i) } })
          }
        />
      ) : (
        <>
          <Pick
            label="Bodies to copy"
            path="/source/bodies"
            refs={s.bodies}
            accepts="body"
            multi
            c={c}
            onRemove={(i) => edit.commit({ ...f, source: { ...s, bodies: without(s.bodies, i) } })}
          />
          <Switch
            label="Merge copies into the body"
            checked={s.merge}
            onChange={(merge) => edit.commit({ ...f, source: { ...s, merge } })}
          />
        </>
      )}
    </>
  );
}

const sourceEmpty = (s: CopySource) =>
  s.kind === 'features' ? s.features.length === 0 : s.bodies.length === 0;

/* ------------------------------------------------------------------------- shell / draft */

export function ShellFields({ f, c, edit }: { f: ShellFeature; c: Ctx; edit: Edit<ShellFeature> }) {
  const t = num(c, f.thickness, 'length');
  return (
    <Section title="Shell">
      <Pick
        label="Faces to remove"
        path="/openFaces"
        refs={f.openFaces}
        accepts="face"
        multi
        c={c}
        onRemove={(i) => edit.commit({ ...f, openFaces: without(f.openFaces, i) })}
      />
      {f.openFaces.length === 0 ? (
        <Pick label="Body" path="/body" refs={f.body ? one(f.body) : []} accepts="body" c={c} />
      ) : null}
      <ExprField
        label="Thickness"
        value={f.thickness}
        expected="length"
        c={c}
        edit={edit}
        build={(thickness) => ({ ...f, thickness })}
      />
      <Field label="Direction">
        <Segmented
          label="Shell direction"
          size={c.size}
          value={f.direction}
          options={[
            { value: 'inward', label: 'Inward' },
            { value: 'outward', label: 'Outward' },
          ]}
          onChange={(direction) => edit.commit({ ...f, direction })}
        />
      </Field>
      {t !== undefined && t <= 0 ? <Note>Thickness must be greater than zero.</Note> : null}
      {f.openFaces.length === 0 && !f.body?.name ? (
        <Note tone="info">Pick faces to open, or a body for a closed hollow solid.</Note>
      ) : null}
    </Section>
  );
}

export function DraftFields({ f, c, edit }: { f: DraftFeature; c: Ctx; edit: Edit<DraftFeature> }) {
  const a = num(c, f.angle, 'angle');
  return (
    <Section title="Draft">
      <Pick
        label="Faces to taper"
        path="/faces"
        refs={f.faces}
        accepts="face"
        multi
        c={c}
        onRemove={(i) => edit.commit({ ...f, faces: without(f.faces, i) })}
      />
      <Pick
        label="Neutral plane"
        path="/neutral"
        refs={one(f.neutral)}
        accepts="face or plane"
        c={c}
      />
      <ExprField
        label="Angle"
        value={f.angle}
        expected="angle"
        c={c}
        edit={edit}
        build={(angle) => ({ ...f, angle })}
      />
      <Switch
        label="Reverse direction"
        checked={f.reverse}
        onChange={(reverse) => edit.commit({ ...f, reverse })}
      />
      {a !== undefined && Math.abs(a) >= Math.PI / 2 ? (
        <Note>Draft angle must be less than 90°.</Note>
      ) : null}
      {a === 0 ? <Note tone="info">A draft angle of 0° changes nothing.</Note> : null}
      {f.faces.length === 0 || !f.neutral.name ? (
        <Note tone="info">Pick the faces to taper and a neutral plane.</Note>
      ) : null}
    </Section>
  );
}

/* ------------------------------------------------------------------------- sweep / loft */

export function SweepFields({ f, c, edit }: { f: SweepFeature; c: Ctx; edit: Edit<SweepFeature> }) {
  return (
    <>
      <Section title="Sweep">
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
          label="Path"
          path="/path"
          refs={f.path}
          accepts="curve or edge"
          multi
          c={c}
          onRemove={(i) => edit.commit({ ...f, path: without(f.path, i) })}
        />
        <Field label="Orientation">
          <Segmented
            label="Profile orientation"
            size={c.size}
            value={f.orientation}
            options={[
              { value: 'followPath', label: 'Follow path' },
              { value: 'fixed', label: 'Fixed' },
            ]}
            onChange={(orientation) => edit.commit({ ...f, orientation })}
          />
        </Field>
        {f.profile.length === 0 || f.path.length === 0 ? (
          <Note tone="info">A sweep needs a profile and a path.</Note>
        ) : null}
      </Section>
      <Section title="Result">
        <ScopeFields f={f} c={c} edit={edit} />
      </Section>
    </>
  );
}

export function LoftFields({ f, c, edit }: { f: LoftFeature; c: Ctx; edit: Edit<LoftFeature> }) {
  const n = f.sections.length;
  return (
    <>
      <Section title="Loft">
        <Pick
          label="Sections"
          path="/sections"
          refs={f.sections}
          accepts="sketch region"
          multi
          c={c}
          onRemove={(i) => edit.commit({ ...f, sections: without(f.sections, i) })}
        />
        <Pick
          label="Guide curves"
          path="/guides"
          refs={f.guides ?? []}
          accepts="curve"
          multi
          c={c}
          onRemove={(i) => edit.commit({ ...f, guides: without(f.guides ?? [], i) })}
        />
        <Switch
          label="Ruled (straight between sections)"
          checked={f.ruled}
          onChange={(ruled) => edit.commit({ ...f, ruled })}
        />
        <Switch
          label="Closed (join last to first)"
          checked={f.closed}
          onChange={(closed) => edit.commit({ ...f, closed })}
        />
        {n < 2 ? <Note>A loft needs at least two sections ({n} picked).</Note> : null}
        {f.closed && n >= 2 && n < 3 ? (
          <Note>Closing a loft needs three or more sections.</Note>
        ) : null}
        {(f.guides?.length ?? 0) > 0 ? (
          <Note tone="info">Guide curves are best effort: the kernel may ignore them.</Note>
        ) : null}
      </Section>
      <Section title="Result">
        <ScopeFields f={f} c={c} edit={edit} />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------------- mirror / patterns */

export function MirrorFields({
  f,
  c,
  edit,
}: {
  f: MirrorFeature;
  c: Ctx;
  edit: Edit<MirrorFeature>;
}) {
  return (
    <Section title="Mirror">
      <CopySourceFields f={f} c={c} edit={edit} />
      <Pick label="Mirror plane" path="/plane" refs={one(f.plane)} accepts="plane or face" c={c} />
      {sourceEmpty(f.source) || !f.plane.name ? (
        <Note tone="info">Pick what to mirror and the plane to mirror across.</Note>
      ) : null}
    </Section>
  );
}

function countNote(c: Ctx, count: Expr, label = 'Count') {
  const n = num(c, count, 'scalar');
  if (n === undefined) return null;
  if (!Number.isInteger(n) || n < 1) return <Note>{label} must be a whole number, 1 or more.</Note>;
  return null;
}

export function LinearPatternFields({
  f,
  c,
  edit,
}: {
  f: LinearPatternFeature;
  c: Ctx;
  edit: Edit<LinearPatternFeature>;
}) {
  const n1 = num(c, f.count, 'scalar');
  const n2 = f.second ? num(c, f.second.count, 'scalar') : 1;
  const total = n1 !== undefined && n2 !== undefined && n1 >= 1 && n2 >= 1 ? n1 * n2 : 0;
  const sp = num(c, f.spacing, 'length');
  const s2 = f.second;
  return (
    <>
      <Section title="Source">
        <CopySourceFields f={f} c={c} edit={edit} />
      </Section>
      <Section title="Direction 1">
        <Pick
          label="Direction"
          path="/direction"
          refs={one(f.direction)}
          accepts="edge, axis or plane"
          c={c}
        />
        <Switch
          label="Flip direction"
          checked={f.reverse}
          onChange={(reverse) => edit.commit({ ...f, reverse })}
        />
        <ExprField
          label="Count"
          value={f.count}
          expected="scalar"
          c={c}
          edit={edit}
          build={(count) => ({ ...f, count })}
        />
        <ExprField
          label="Spacing"
          value={f.spacing}
          expected="length"
          c={c}
          edit={edit}
          build={(spacing) => ({ ...f, spacing })}
        />
        {countNote(c, f.count)}
        {sp === 0 ? <Note>Spacing of zero stacks every copy on the original.</Note> : null}
      </Section>
      <Section
        title="Direction 2"
        actions={
          <button
            type="button"
            onClick={() => {
              if (s2) {
                const { second: _drop, ...rest } = f;
                edit.commit(rest);
              } else {
                edit.commit({
                  ...f,
                  second: {
                    direction: emptyRef('edge'),
                    reverse: false,
                    count: '2',
                    spacing: '10mm',
                  },
                });
              }
            }}
            className="rounded-control px-1.5 py-0.5 text-2xs font-semibold text-accent-text hover:bg-accent-soft"
          >
            {s2 ? 'Remove' : 'Add direction 2'}
          </button>
        }
      >
        {s2 ? (
          <>
            <Pick
              label="Second direction"
              path="/second/direction"
              refs={one(s2.direction)}
              accepts="edge, axis or plane"
              c={c}
            />
            <Switch
              label="Flip second direction"
              checked={s2.reverse}
              onChange={(reverse) => edit.commit({ ...f, second: { ...s2, reverse } })}
            />
            <ExprField
              label="Second count"
              value={s2.count}
              expected="scalar"
              c={c}
              edit={edit}
              build={(count) => ({ ...f, second: { ...s2, count } })}
            />
            <ExprField
              label="Second spacing"
              value={s2.spacing}
              expected="length"
              c={c}
              edit={edit}
              build={(spacing) => ({ ...f, second: { ...s2, spacing } })}
            />
            {countNote(c, s2.count, 'Second count')}
          </>
        ) : (
          <p className="text-ui text-fg-muted">One direction only.</p>
        )}
      </Section>
      <Section title="Instances">
        <SkipGrid
          total={total}
          skip={f.skip ?? []}
          size={c.size}
          onChange={(skip) => {
            const { skip: _drop, ...rest } = f;
            edit.commit(skip.length ? { ...rest, skip } : rest);
          }}
        />
        {total < 2 ? <p className="text-ui text-fg-muted">Set a count of 2 or more.</p> : null}
      </Section>
    </>
  );
}

export function CircularPatternFields({
  f,
  c,
  edit,
}: {
  f: CircularPatternFeature;
  c: Ctx;
  edit: Edit<CircularPatternFeature>;
}) {
  const n = num(c, f.count, 'scalar');
  const total = n !== undefined && n >= 1 && Number.isInteger(n) ? n : 0;
  return (
    <>
      <Section title="Source">
        <CopySourceFields f={f} c={c} edit={edit} />
      </Section>
      <Section title="Circular">
        <Pick label="Axis" path="/axis" refs={one(f.axis)} accepts="axis or edge" c={c} />
        <ExprField
          label="Count"
          value={f.count}
          expected="scalar"
          c={c}
          edit={edit}
          build={(count) => ({ ...f, count })}
        />
        <ExprField
          label="Angle"
          value={f.angle}
          expected="angle"
          c={c}
          edit={edit}
          build={(angle) => ({ ...f, angle })}
        />
        <Switch
          label="Equal spacing across the angle"
          checked={f.equalSpacing}
          onChange={(equalSpacing) => edit.commit({ ...f, equalSpacing })}
        />
        {countNote(c, f.count)}
      </Section>
      <Section title="Instances">
        <SkipGrid
          total={total}
          skip={f.skip ?? []}
          size={c.size}
          onChange={(skip) => {
            const { skip: _drop, ...rest } = f;
            edit.commit(skip.length ? { ...rest, skip } : rest);
          }}
        />
        {total < 2 ? <p className="text-ui text-fg-muted">Set a count of 2 or more.</p> : null}
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------------- thread */

export function ThreadFields({
  f,
  c,
  edit,
}: {
  f: ThreadFeature;
  c: Ctx;
  edit: Edit<ThreadFeature>;
}) {
  const rows = c.holeTables?.[f.standard]?.rows ?? [];
  const len = f.length ? num(c, f.length, 'length') : undefined;
  return (
    <Section title="Cosmetic thread">
      <Pick
        label="Cylindrical face"
        path="/face"
        refs={one(f.face)}
        accepts="cylindrical face"
        c={c}
      />
      <Field label="Standard">
        <Segmented
          label="Thread standard"
          size={c.size}
          value={f.standard}
          options={[
            { value: 'ISO', label: 'ISO' },
            { value: 'ANSI', label: 'ANSI' },
          ]}
          onChange={(standard) => {
            const first = c.holeTables?.[standard]?.rows[0]?.size;
            edit.commit({ ...f, standard, size: first ?? f.size });
          }}
        />
      </Field>
      {rows.length ? (
        <KindSelect
          label="Size"
          size={c.size}
          value={f.size}
          options={rows.map((r) => ({ value: r.size, label: r.size }))}
          onChange={(size) => edit.commit({ ...f, size })}
        />
      ) : (
        <p className="text-ui text-fg-muted">Size {f.size}</p>
      )}
      <ExprField
        label="Length"
        value={f.length ?? ''}
        expected="length"
        allowEmpty
        placeholder="Full length"
        c={c}
        edit={edit}
        build={(length) => {
          const { length: _drop, ...rest } = f;
          return length.trim() ? { ...rest, length } : rest;
        }}
      />
      {len !== undefined && len <= 0 ? <Note>Thread length must be greater than zero.</Note> : null}
      <p className="text-2xs text-fg-subtle">
        Cosmetic: recorded for drawings, no geometry change.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------------- plane / axis / point */

type PlaneDef = PlaneFeature['definition'];
const planeKinds: readonly { value: PlaneDef['kind']; label: string }[] = [
  { value: 'offset', label: 'Offset from a plane or face' },
  { value: 'threePoints', label: 'Through three points' },
  { value: 'angle', label: 'At an angle to a plane' },
  { value: 'normalToCurve', label: 'Normal to a curve' },
  { value: 'midplane', label: 'Midway between two planes' },
  { value: 'throughPoint', label: 'Parallel, through a point' },
];

function defaultPlane(kind: PlaneDef['kind']): PlaneDef | undefined {
  switch (kind) {
    case 'offset':
      return { kind, from: emptyRef('face'), distance: '10mm' };
    case 'threePoints':
      return {
        kind,
        points: [emptyRef('vertex'), emptyRef('vertex'), emptyRef('vertex')],
      };
    case 'angle':
      return { kind, from: emptyRef('face'), axis: emptyRef('edge'), angle: '45deg' };
    case 'normalToCurve':
      return { kind, curve: emptyRef('edge'), at: { t: '0.5' } };
    case 'midplane':
      return { kind, a: emptyRef('face'), b: emptyRef('face') };
    case 'throughPoint':
      return { kind, from: emptyRef('face'), point: emptyRef('vertex') };
    default:
      return undefined;
  }
}

export function PlaneFields({ f, c, edit }: { f: PlaneFeature; c: Ctx; edit: Edit<PlaneFeature> }) {
  const d = f.definition;
  const setDef = (definition: PlaneDef) => edit.commit({ ...f, definition });
  const kinds =
    d.kind === 'frame'
      ? [...planeKinds, { value: 'frame' as const, label: 'Custom frame' }]
      : planeKinds;
  let body: ReactNode;
  switch (d.kind) {
    case 'offset':
      body = (
        <>
          <Pick
            label="Offset from"
            path="/definition/from"
            refs={one(d.from)}
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
      );
      break;
    case 'frame':
      body = (
        <p className="text-ui text-fg-muted">Custom frame: positioned by origin and normal.</p>
      );
      break;
    case 'threePoints':
      body = [0, 1, 2].map((i) => (
        <Pick
          key={`p${i}`}
          label={`Point ${i + 1}`}
          path={`/definition/points/${i}`}
          refs={one(d.points[i] as EntityRef)}
          accepts="point or vertex"
          c={c}
        />
      ));
      break;
    case 'angle':
      body = (
        <>
          <Pick
            label="From plane"
            path="/definition/from"
            refs={one(d.from)}
            accepts="face or plane"
            c={c}
          />
          <Pick
            label="Through line"
            path="/definition/axis"
            refs={one(d.axis)}
            accepts="edge or axis"
            c={c}
          />
          <ExprField
            label="Angle"
            value={d.angle}
            expected="angle"
            c={c}
            edit={edit}
            build={(angle) => ({ ...f, definition: { ...d, angle } })}
          />
        </>
      );
      break;
    case 'normalToCurve': {
      const byParam = !('name' in d.at);
      body = (
        <>
          <Pick
            label="Curve"
            path="/definition/curve"
            refs={one(d.curve)}
            accepts="edge or curve"
            c={c}
          />
          <Field label="Position on curve">
            <Segmented
              label="Position on curve"
              size={c.size}
              value={byParam ? 'param' : 'vertex'}
              options={[
                { value: 'param', label: 'Along (0–1)' },
                { value: 'vertex', label: 'At a point' },
              ]}
              onChange={(k) =>
                setDef({ ...d, at: k === 'param' ? { t: '0.5' } : emptyRef('vertex') })
              }
            />
          </Field>
          {'t' in d.at ? (
            <ExprField
              label="Position"
              value={d.at.t}
              expected="scalar"
              c={c}
              edit={edit}
              build={(t) => ({ ...f, definition: { ...d, at: { t } } })}
            />
          ) : (
            <Pick
              label="Point"
              path="/definition/at"
              refs={one(d.at)}
              accepts="point or vertex"
              c={c}
            />
          )}
          {'t' in d.at && outside01(num(c, d.at.t, 'scalar')) ? (
            <Note>Position runs from 0 (start) to 1 (end) along the curve.</Note>
          ) : null}
        </>
      );
      break;
    }
    case 'midplane':
      body = (
        <>
          <Pick
            label="First plane"
            path="/definition/a"
            refs={one(d.a)}
            accepts="face or plane"
            c={c}
          />
          <Pick
            label="Second plane"
            path="/definition/b"
            refs={one(d.b)}
            accepts="face or plane"
            c={c}
          />
        </>
      );
      break;
    case 'throughPoint':
      body = (
        <>
          <Pick
            label="Parallel to"
            path="/definition/from"
            refs={one(d.from)}
            accepts="face or plane"
            c={c}
          />
          <Pick
            label="Through point"
            path="/definition/point"
            refs={one(d.point)}
            accepts="point or vertex"
            c={c}
          />
        </>
      );
      break;
  }
  return (
    <Section title="Plane">
      <KindSelect
        label="Definition"
        size={c.size}
        value={d.kind}
        options={kinds}
        onChange={(k) => {
          const next = defaultPlane(k);
          if (next) setDef(next);
        }}
      />
      {body}
      <Switch
        label="Flip normal"
        checked={!!f.flip}
        onChange={(flip) => {
          const { flip: _drop, ...rest } = f;
          edit.commit(flip ? { ...rest, flip } : rest);
        }}
      />
    </Section>
  );
}

type AxisDef = AxisFeature['definition'];
const axisKinds: readonly { value: AxisDef['kind']; label: string }[] = [
  { value: 'twoPoints', label: 'Through two points' },
  { value: 'edge', label: 'Along a straight edge' },
  { value: 'cylinder', label: 'Axis of a cylinder' },
  { value: 'twoPlanes', label: 'Where two planes meet' },
  { value: 'pointNormal', label: 'Normal to a plane at a point' },
];

function defaultAxis(kind: AxisDef['kind']): AxisDef {
  switch (kind) {
    case 'twoPoints':
      return { kind, a: emptyRef('vertex'), b: emptyRef('vertex') };
    case 'edge':
      return { kind, edge: emptyRef('edge') };
    case 'cylinder':
      return { kind, face: emptyRef('face') };
    case 'twoPlanes':
      return { kind, a: emptyRef('face'), b: emptyRef('face') };
    case 'pointNormal':
      return { kind, point: emptyRef('vertex'), plane: emptyRef('face') };
  }
}

export function AxisFields({ f, c, edit }: { f: AxisFeature; c: Ctx; edit: Edit<AxisFeature> }) {
  const d = f.definition;
  let body: ReactNode;
  switch (d.kind) {
    case 'twoPoints':
      body = (
        <>
          <Pick
            label="First point"
            path="/definition/a"
            refs={one(d.a)}
            accepts="point or vertex"
            c={c}
          />
          <Pick
            label="Second point"
            path="/definition/b"
            refs={one(d.b)}
            accepts="point or vertex"
            c={c}
          />
        </>
      );
      break;
    case 'edge':
      body = (
        <Pick
          label="Edge"
          path="/definition/edge"
          refs={one(d.edge)}
          accepts="straight edge"
          c={c}
        />
      );
      break;
    case 'cylinder':
      body = (
        <Pick
          label="Cylindrical face"
          path="/definition/face"
          refs={one(d.face)}
          accepts="cylindrical face"
          c={c}
        />
      );
      break;
    case 'twoPlanes':
      body = (
        <>
          <Pick
            label="First plane"
            path="/definition/a"
            refs={one(d.a)}
            accepts="face or plane"
            c={c}
          />
          <Pick
            label="Second plane"
            path="/definition/b"
            refs={one(d.b)}
            accepts="face or plane"
            c={c}
          />
        </>
      );
      break;
    case 'pointNormal':
      body = (
        <>
          <Pick
            label="Point"
            path="/definition/point"
            refs={one(d.point)}
            accepts="point or vertex"
            c={c}
          />
          <Pick
            label="Plane"
            path="/definition/plane"
            refs={one(d.plane)}
            accepts="face or plane"
            c={c}
          />
        </>
      );
      break;
  }
  return (
    <Section title="Axis">
      <KindSelect
        label="Definition"
        size={c.size}
        value={d.kind}
        options={axisKinds}
        onChange={(k) => edit.commit({ ...f, definition: defaultAxis(k) })}
      />
      {body}
    </Section>
  );
}

type PointDef = PointFeature['definition'];
const pointKinds: readonly { value: PointDef['kind']; label: string }[] = [
  { value: 'coordinates', label: 'Coordinates' },
  { value: 'vertex', label: 'At a vertex' },
  { value: 'center', label: 'Centre of a circle or sphere' },
  { value: 'alongEdge', label: 'Along an edge' },
  { value: 'intersection', label: 'Where two things cross' },
];

function defaultPoint(kind: PointDef['kind']): PointDef {
  switch (kind) {
    case 'coordinates':
      return { kind, x: '0mm', y: '0mm', z: '0mm' };
    case 'vertex':
      return { kind, vertex: emptyRef('vertex') };
    case 'center':
      return { kind, of: emptyRef('edge') };
    case 'alongEdge':
      return { kind, edge: emptyRef('edge'), t: '0.5' };
    case 'intersection':
      return { kind, a: emptyRef('edge'), b: emptyRef('face') };
  }
}

export function PointFields({ f, c, edit }: { f: PointFeature; c: Ctx; edit: Edit<PointFeature> }) {
  const d = f.definition;
  let body: ReactNode;
  switch (d.kind) {
    case 'coordinates':
      body = (['x', 'y', 'z'] as const).map((k) => (
        <ExprField
          key={k}
          label={k.toUpperCase()}
          value={d[k]}
          expected="length"
          c={c}
          edit={edit}
          build={(v) => ({ ...f, definition: { ...d, [k]: v } })}
        />
      ));
      break;
    case 'vertex':
      body = (
        <Pick
          label="Vertex"
          path="/definition/vertex"
          refs={one(d.vertex)}
          accepts="vertex"
          c={c}
        />
      );
      break;
    case 'center':
      body = (
        <Pick
          label="Circle or sphere"
          path="/definition/of"
          refs={one(d.of)}
          accepts="circular edge or sphere"
          c={c}
        />
      );
      break;
    case 'alongEdge': {
      const t = num(c, d.t, 'scalar');
      body = (
        <>
          <Pick label="Edge" path="/definition/edge" refs={one(d.edge)} accepts="edge" c={c} />
          <ExprField
            label="Position"
            value={d.t}
            expected="scalar"
            c={c}
            edit={edit}
            build={(v) => ({ ...f, definition: { ...d, t: v } })}
          />
          {outside01(t) ? (
            <Note>Position runs from 0 (start) to 1 (end) along the edge.</Note>
          ) : null}
        </>
      );
      break;
    }
    case 'intersection':
      body = (
        <>
          <Pick
            label="First"
            path="/definition/a"
            refs={one(d.a)}
            accepts="edge, face or axis"
            c={c}
          />
          <Pick
            label="Second"
            path="/definition/b"
            refs={one(d.b)}
            accepts="edge, face or axis"
            c={c}
          />
        </>
      );
      break;
  }
  return (
    <Section title="Point">
      <KindSelect
        label="Definition"
        size={c.size}
        value={d.kind}
        options={pointKinds}
        onChange={(k) => edit.commit({ ...f, definition: defaultPoint(k) })}
      />
      {body}
    </Section>
  );
}
