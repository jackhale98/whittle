import type {
  BodyOp,
  BodyScope,
  EntityRef,
  EvalResult,
  Expr,
  Feature,
  HoleStandard,
  HoleTable,
  NamedDimension,
  UnresolvedRef,
} from '@wren-cad/contracts';
import { Field, Segmented } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { OverrideMarker } from '../config/markers';
import type { FormatValue } from '../format';
import { PickField } from './PickField';

/**
 * Configuration awareness of the field groups (M3.7). `overridden` and `reset` are keyed by the
 * JSON pointer inside the feature (`/end/depth`, `/radius`), which `ExprField` derives from its own
 * `build`, so no call site names a pointer.
 */
export interface FieldConfigCtx {
  activeName: string;
  overridden(pointer: string): boolean;
  reset(pointer: string): void;
}

const PROBE = '\u2063wren-probe';

/** The pointer of the leaf a `build(expr)` function writes its argument to, or null. */
export function probePointer(build: (expr: string) => unknown): string | null {
  const walk = (v: unknown, at: string): string | null => {
    if (v === PROBE) return at;
    if (v === null || typeof v !== 'object') return null;
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    for (const [k, x] of entries) {
      const r = walk(x, `${at}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (r !== null) return r;
    }
    return null;
  };
  try {
    return walk(build(PROBE), '');
  } catch {
    return null;
  }
}

/** Everything the per-type field groups share. */
export interface Ctx {
  evaluate(expr: Expr, expected: NamedDimension): EvalResult;
  formatValue?: FormatValue;
  units: { length: string; angle: string };
  size: 'md' | 'touch';
  pickingPath: string | null;
  unresolved: readonly UnresolvedRef[];
  describeRef?(ref: EntityRef): string;
  /** Display name of a feature id (mirror / pattern sources). */
  describeFeature?(id: string): string;
  /** Standards tables for the hole wizard and thread size lists. */
  holeTables?: Partial<Record<HoleStandard, HoleTable>>;
  onPick?(path: string): void;
  /** M3.7: the active configuration's overrides of this feature's fields (markers with Reset). */
  config?: FieldConfigCtx;
}

export const opOptions = [
  { value: 'new', label: 'New' },
  { value: 'add', label: 'Add' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
] as const satisfies readonly { value: BodyOp; label: string }[];

export const dirOptions = [
  { value: 'normal', label: 'Normal' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'symmetric', label: 'Symmetric' },
] as const;

export interface Edit<F extends Feature> {
  commit(next: F): void;
  preview(next: F): void;
}

export function ExprField<F extends Feature>({
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
  const pointer = probePointer(build);
  const overridden = pointer !== null && !!c.config?.overridden(pointer);
  return (
    <Field
      label={label}
      {...(pointer !== null ? { pointer } : {})}
      adornment={
        c.config && pointer !== null ? (
          <OverrideMarker
            overridden={overridden}
            configurationName={c.config.activeName}
            fieldLabel={label}
            onReset={() => c.config?.reset(pointer)}
            size={c.size}
          />
        ) : undefined
      }
    >
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

export function Pick({
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

export function ScopeFields<F extends Feature & { op: BodyOp; scope?: BodyScope }>({
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

export const without = <T,>(xs: readonly T[], i: number): T[] => xs.filter((_, j) => j !== i);
