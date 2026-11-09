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
import type { FormatValue } from '../format';
import { PickField } from './PickField';

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
