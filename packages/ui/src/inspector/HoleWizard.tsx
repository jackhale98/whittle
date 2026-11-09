import type { DimensionVector, HoleFeature, HoleStandard, HoleTable } from '@wren-cad/contracts';
import { Field, Section, Segmented, Switch } from '../components/controls';
import { defaultFormatValue } from '../format';
import { type Ctx, type Edit, ExprField, Pick } from './fieldKit';
import { resolveHole, rowOf, tableDiameter } from './holeResolve';
import { emptyRef, KindSelect, Note } from './m3Fields';

const LENGTH: DimensionVector = [1, 0, 0, 0];
const ANGLE: DimensionVector = [0, 0, 1, 0];

const kindOptions = [
  { value: 'simple', label: 'Simple (clearance)' },
  { value: 'counterbore', label: 'Counterbore' },
  { value: 'countersink', label: 'Countersink' },
  { value: 'tapped', label: 'Tapped (thread)' },
] as const satisfies readonly { value: HoleFeature['kind']; label: string }[];

const mm = (n: number) => `${Number(n.toFixed(4))}mm`;
/** A table value to start an override from ('' when the standard has no value for the size). */
const seed = (n: number, unit: 'mm' | 'deg') =>
  Number.isFinite(n) ? `${Number(n.toFixed(4))} ${unit}` : '';

/**
 * Hole wizard fields (PLAN 12 M3): an inspector section, not a dialog. Standard, kind, size from
 * the table, fit, end condition, depth and tip angle; the resolved dimensions are shown read-only
 * from the table row, with an override toggle for the diameter. Placement points are picked on a
 * face through the usual pick path. Presentational: tables arrive through `c.holeTables`.
 */
export function HoleFields({ f, c, edit }: { f: HoleFeature; c: Ctx; edit: Edit<HoleFeature> }) {
  const table: HoleTable | undefined = c.holeTables?.[f.standard];
  const row = rowOf(table, f.size);
  const fmt = c.formatValue ?? defaultFormatValue;
  const overrideOn = f.diameter !== undefined;
  const ov = f.diameter ? c.evaluate(f.diameter, 'length') : undefined;
  const override = ov?.ok ? ov.value : undefined;
  // Counterbore / countersink overrides replace their table rows in the read-out.
  const own: Record<string, { expr: string | undefined; dim: 'length' | 'angle' }> = {
    cbDiameter: { expr: f.counterbore?.diameter, dim: 'length' },
    cbDepth: { expr: f.counterbore?.depth, dim: 'length' },
    csDiameter: { expr: f.countersink?.diameter, dim: 'length' },
    csAngle: { expr: f.countersink?.angle, dim: 'angle' },
  };
  const resolved = (row ? resolveHole(f, row, override) : []).map((d) => {
    const o = own[d.key];
    const r = o?.expr ? c.evaluate(o.expr, o.dim) : undefined;
    if (!r?.ok) return d;
    return {
      ...d,
      value: o?.dim === 'angle' ? (r.value * 180) / Math.PI : r.value,
      overridden: true,
    };
  });
  const depth = f.end.kind === 'blind' ? c.evaluate(f.end.depth, 'length') : undefined;
  const cbDepth = row && f.kind === 'counterbore' ? row.counterbore.depth : undefined;

  const setStandard = (standard: HoleStandard) => {
    const t = c.holeTables?.[standard];
    const size = t?.rows.find((r) => r.size === f.size)?.size ?? t?.rows[0]?.size ?? f.size;
    edit.commit({ ...f, standard, size });
  };

  return (
    <>
      <Section title="Placement">
        <Pick
          label="Face"
          path="/face"
          refs={f.face.name ? [f.face] : []}
          accepts="planar face"
          c={c}
        />
        <Pick
          label="Hole centres"
          path="/points"
          refs={f.points}
          accepts="sketch point or vertex"
          multi
          c={c}
          onRemove={(i) => edit.commit({ ...f, points: f.points.filter((_, j) => j !== i) })}
        />
        {f.points.length === 0 ? (
          <Note tone="info">Pick points on the face. Each point becomes one hole.</Note>
        ) : null}
      </Section>
      <Section title="Hole">
        <Field label="Standard">
          <Segmented
            label="Hole standard"
            size={c.size}
            value={f.standard}
            options={[
              { value: 'ISO', label: 'ISO (metric)' },
              { value: 'ANSI', label: 'ANSI (inch)' },
            ]}
            onChange={setStandard}
          />
        </Field>
        <KindSelect
          label="Hole type"
          size={c.size}
          value={f.kind}
          options={kindOptions}
          onChange={(kind) => {
            const { diameter: _d, ...rest } = f;
            edit.commit({ ...rest, kind });
          }}
        />
        {table ? (
          <KindSelect
            label="Size"
            size={c.size}
            value={f.size}
            options={
              row
                ? table.rows.map((r) => ({ value: r.size, label: r.size }))
                : [
                    { value: f.size, label: `${f.size} (not in table)` },
                    ...table.rows.map((r) => ({ value: r.size, label: r.size })),
                  ]
            }
            onChange={(size) => edit.commit({ ...f, size })}
          />
        ) : (
          <Note>The {f.standard} hole table is not loaded.</Note>
        )}
        {table && !row ? (
          <Note>
            Size {f.size} is not in the {f.standard} table. Pick a size from the list.
          </Note>
        ) : null}
        {f.kind !== 'tapped' ? (
          <Field label="Fit">
            <Segmented
              label="Clearance fit"
              size={c.size}
              value={f.fit}
              options={[
                { value: 'close', label: 'Close' },
                { value: 'normal', label: 'Normal' },
                { value: 'loose', label: 'Loose' },
              ]}
              onChange={(fit) => edit.commit({ ...f, fit })}
            />
          </Field>
        ) : null}
      </Section>
      <Section title="Resolved from table">
        {row ? (
          <dl
            data-testid="hole-resolved"
            className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui"
          >
            {resolved.map((d) => (
              <div key={d.key} className="contents" data-dim={d.key}>
                <dt className="text-fg-muted">{d.label}</dt>
                <dd className="text-right font-medium">
                  {d.unit === 'deg' ? fmt((d.value * Math.PI) / 180, ANGLE) : fmt(d.value, LENGTH)}
                  {d.overridden ? (
                    <span className="ml-1 text-2xs text-accent-text">override</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-ui text-fg-muted">Choose a size to see its dimensions.</p>
        )}
        {row ? (
          <>
            <Switch
              label="Override diameter"
              checked={overrideOn}
              onChange={(on) => {
                const { diameter: _d, ...rest } = f;
                edit.commit(on ? { ...rest, diameter: mm(tableDiameter(f, row)) } : rest);
              }}
            />
            {overrideOn ? (
              <ExprField
                label={f.kind === 'tapped' ? 'Drill diameter' : 'Diameter'}
                value={f.diameter ?? ''}
                expected="length"
                c={c}
                edit={edit}
                build={(diameter) => ({ ...f, diameter })}
              />
            ) : null}
            {f.kind === 'counterbore' ? (
              <>
                <Switch
                  label="Override counterbore"
                  checked={f.counterbore !== undefined}
                  onChange={(on) => {
                    const { counterbore: _cb, ...rest } = f;
                    edit.commit(
                      on
                        ? {
                            ...rest,
                            counterbore: {
                              diameter: seed(row.counterbore.diameter, 'mm'),
                              depth: seed(row.counterbore.depth, 'mm'),
                            },
                          }
                        : rest,
                    );
                  }}
                />
                {f.counterbore ? (
                  <>
                    <ExprField
                      label="Counterbore diameter"
                      value={f.counterbore.diameter ?? ''}
                      expected="length"
                      c={c}
                      edit={edit}
                      build={(diameter) => ({ ...f, counterbore: { ...f.counterbore, diameter } })}
                    />
                    <ExprField
                      label="Counterbore depth"
                      value={f.counterbore.depth ?? ''}
                      expected="length"
                      c={c}
                      edit={edit}
                      build={(depth) => ({ ...f, counterbore: { ...f.counterbore, depth } })}
                    />
                  </>
                ) : null}
              </>
            ) : null}
            {f.kind === 'countersink' ? (
              <>
                <Switch
                  label="Override countersink"
                  checked={f.countersink !== undefined}
                  onChange={(on) => {
                    const { countersink: _cs, ...rest } = f;
                    edit.commit(
                      on
                        ? {
                            ...rest,
                            countersink: {
                              diameter: seed(row.countersink.diameter, 'mm'),
                              angle: seed(row.countersink.angle, 'deg'),
                            },
                          }
                        : rest,
                    );
                  }}
                />
                {f.countersink ? (
                  <>
                    <ExprField
                      label="Countersink diameter"
                      value={f.countersink.diameter ?? ''}
                      expected="length"
                      c={c}
                      edit={edit}
                      build={(diameter) => ({ ...f, countersink: { ...f.countersink, diameter } })}
                    />
                    <ExprField
                      label="Countersink angle"
                      value={f.countersink.angle ?? ''}
                      expected="angle"
                      c={c}
                      edit={edit}
                      build={(angle) => ({ ...f, countersink: { ...f.countersink, angle } })}
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </Section>
      <Section title="Depth">
        <Field label="End condition">
          <Segmented
            label="End condition"
            size={c.size}
            value={f.end.kind}
            options={[
              { value: 'blind', label: 'Blind' },
              { value: 'throughAll', label: 'Through all' },
              { value: 'upTo', label: 'Up to' },
            ]}
            onChange={(k) => {
              const { tipAngle: _t, ...rest } = f;
              edit.commit({
                ...(k === 'blind' ? f : rest),
                end:
                  k === 'blind'
                    ? { kind: 'blind', depth: f.end.kind === 'blind' ? f.end.depth : '10mm' }
                    : k === 'throughAll'
                      ? { kind: 'throughAll' }
                      : {
                          kind: 'upTo',
                          target: f.end.kind === 'upTo' ? f.end.target : emptyRef('face'),
                        },
              });
            }}
          />
        </Field>
        {f.end.kind === 'blind' ? (
          <>
            <ExprField
              label="Depth"
              value={f.end.depth}
              expected="length"
              c={c}
              edit={edit}
              build={(d) => ({ ...f, end: { kind: 'blind', depth: d } })}
            />
            {depth?.ok && depth.value <= 0 ? <Note>Depth must be greater than zero.</Note> : null}
            {depth?.ok && cbDepth !== undefined && depth.value <= cbDepth ? (
              <Note>The hole must be deeper than its counterbore ({fmt(cbDepth, LENGTH)}).</Note>
            ) : null}
            <Switch
              label="Drill point (conical bottom)"
              checked={f.tipAngle !== undefined}
              onChange={(on) => {
                const { tipAngle: _t, ...rest } = f;
                edit.commit(on ? { ...rest, tipAngle: '118deg' } : rest);
              }}
            />
            {f.tipAngle !== undefined ? (
              <ExprField
                label="Tip angle"
                value={f.tipAngle}
                expected="angle"
                c={c}
                edit={edit}
                build={(tipAngle) => ({ ...f, tipAngle })}
              />
            ) : null}
            {f.tipAngle !== undefined ? <TipNote c={c} expr={f.tipAngle} /> : null}
          </>
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
      </Section>
    </>
  );
}

function TipNote({ c, expr }: { c: Ctx; expr: string }) {
  const r = c.evaluate(expr, 'angle');
  if (!r.ok) return null;
  const deg = (r.value * 180) / Math.PI;
  return deg <= 0 || deg >= 180 ? <Note>Tip angle must be between 0° and 180°.</Note> : null;
}
