import type { EvalResult, Expr, Material, Vec3 } from '@wren-cad/contracts';
import { ChevronDown, Scale } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { Field, Section } from '../components/controls';
import { Button, cn } from '../components/primitives';
import { ConfigStatusLabel } from '../config/ConfigurationPill';
import { OverrideMarker, ScopeChip, useOneShotScope } from '../config/markers';
import type { ConfigStatus, EditScope } from '../config/model';
import { type FormatValue, fmtNumber, prettyUnits } from '../format';
import type { MaterialLibraryItem } from './materials';

const MaterialPicker = lazy(() => import('./MaterialPicker'));

export interface MassSummary {
  /** mm³ */
  volume: number;
  /** mm² */
  area?: number;
  /** kg; absent without a material. */
  mass?: number;
  /** mm */
  centroid: Vec3;
}

/** Display formatters for the readout; defaults are metric (cm³, g/kg, mm). */
export interface MassFormat {
  volume(mm3: number): string;
  area(mm2: number): string;
  mass(kg: number): string;
  length(mm: number): string;
}

export const defaultMassFormat: MassFormat = {
  volume: (v) => (v >= 1000 ? `${fmtNumber(v / 1000)} cm³` : `${fmtNumber(v)} mm³`),
  area: (a) => (a >= 100 ? `${fmtNumber(a / 100)} cm²` : `${fmtNumber(a)} mm²`),
  mass: (kg) => (kg >= 1 ? `${fmtNumber(kg)} kg` : `${fmtNumber(kg * 1000)} g`),
  length: (mm) => `${fmtNumber(mm)} mm`,
};

/** Part properties (M3.7): what exports, title blocks (M4) and the BOM (M6) read. */
export interface PartPropertiesProps {
  /** The values as the active configuration sees them (its own, else Default's). */
  partNumber: string;
  description: string;
  /** Shown while the part number is empty: the generated one ("Bracket-Long"). */
  generatedPartNumber: string;
  /** Which of the two the active configuration overrides (markers with Reset). */
  overridden?: { partNumber?: boolean; description?: boolean };
  /** `scope` is given while a configuration is active. */
  onChange(patch: { partNumber?: string; description?: string }, scope?: EditScope): void;
  onReset?(key: 'partNumber' | 'description'): void;
}

/** One row of "Mass per configuration". */
export interface ConfigMassRow {
  id: string | null;
  name: string;
  active: boolean;
  status: ConfigStatus;
  /** Formatted ("1.24 kg"), or empty while not built / without a material. */
  mass?: string;
}

/** Configuration awareness of the part inspector (M3.7). */
export interface PartConfigurationProps {
  /** The active configuration's name; `null` = Default is active. */
  activeName: string | null;
  /** The active configuration overrides the material (marker with Reset). */
  materialOverridden: boolean;
  onResetMaterial(): void;
  /** Mass of every configuration, from the background builds. */
  masses: readonly ConfigMassRow[];
  properties: PartPropertiesProps;
}

export interface PartInspectorProps {
  part: { name: string; material?: Material; color?: string };
  /** M3.7: part properties and the active configuration. */
  configuration?: PartConfigurationProps;
  /** Built-in library (passed in so the UI package ships no data). */
  library: readonly MaterialLibraryItem[];
  mass?: MassSummary;
  format?: MassFormat;
  /** Density/other expression evaluation for the custom-material form. */
  evaluate(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  /** `scope` (M3.7) is given while a configuration is active. */
  onSetMaterial(material: Material | null, scope?: EditScope): void;
  density?: 'compact' | 'touch';
  className?: string;
}

function Swatch({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.18)]', className)}
      style={{ background: color ?? '#9aa4b2' }}
    />
  );
}

/** Mass properties readout. Without a material only geometry is shown, with a gentle prompt. */
export function MassReadout({
  mass,
  format = defaultMassFormat,
  hasMaterial,
}: {
  mass?: MassSummary;
  format?: MassFormat;
  hasMaterial: boolean;
}) {
  if (!mass) {
    return (
      <p className="text-ui text-fg-muted">Mass properties appear once the part has a solid.</p>
    );
  }
  const rows: Array<[string, string, string]> = [
    ['Volume', format.volume(mass.volume), 'volume'],
    ...(mass.area !== undefined
      ? ([['Surface area', format.area(mass.area), 'area']] as Array<[string, string, string]>)
      : []),
    ['Mass', mass.mass !== undefined ? format.mass(mass.mass) : '—', 'mass'],
    [
      'Centre of mass',
      `${mass.centroid.map((v) => fmtNumber(Number(v.toFixed(3)))).join(', ')} mm`,
      'com',
    ],
  ];
  return (
    <div>
      <dl
        className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui"
        data-testid="mass-readout"
      >
        {rows.map(([k, v, id]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd data-prop={id} className="truncate text-right font-medium text-fg">
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {!hasMaterial ? (
        <p className="mt-2 flex items-center gap-1.5 text-2xs text-fg-muted">
          <Scale className="size-3.5" aria-hidden /> Assign a material to see mass.
        </p>
      ) : null}
    </div>
  );
}

/** Right-panel content for a part: material (assign / change / custom density) and mass. */
function PropertyInput({
  label,
  value,
  placeholder,
  touch,
  testId,
  marker,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  touch: boolean;
  testId: string;
  marker?: ReactNode;
  onCommit(v: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={label} adornment={marker}>
      <input
        aria-label={label}
        data-testid={testId}
        value={draft ?? value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        className={cn(
          'w-full min-w-0 rounded-control bg-surface-2 px-2.5 text-ui text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none placeholder:text-fg-subtle focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
          touch ? 'h-11' : 'h-8',
        )}
      />
    </Field>
  );
}

/** Part number and description (the active configuration's, with the scope rule of every edit). */
function PropertiesSection({ cfg, touch }: { cfg: PartConfigurationProps; touch: boolean }) {
  const p = cfg.properties;
  const activeIsDefault = cfg.activeName === null;
  const oneShot = useOneShotScope(activeIsDefault, cfg.activeName);
  const commit = (key: 'partNumber' | 'description', v: string) => {
    if (activeIsDefault) {
      p.onChange({ [key]: v });
      return;
    }
    const chip = oneShot.consume() === 'configuration';
    p.onChange({ [key]: v }, chip || p.overridden?.[key] ? 'configuration' : 'all');
  };
  const marker = (key: 'partNumber' | 'description') =>
    !activeIsDefault && cfg.activeName !== null ? (
      <OverrideMarker
        overridden={!!p.overridden?.[key]}
        configurationName={cfg.activeName}
        fieldLabel={key === 'partNumber' ? 'Part number' : 'Description'}
        onReset={() => p.onReset?.(key)}
        size={touch ? 'touch' : 'md'}
      />
    ) : undefined;
  return (
    <Section title="Properties">
      {!activeIsDefault && cfg.activeName !== null ? (
        <div>
          <ScopeChip
            configurationName={cfg.activeName}
            activeIsDefault={false}
            scope={oneShot.scope}
            onScopeChange={oneShot.setScope}
            size={touch ? 'touch' : 'md'}
          />
        </div>
      ) : null}
      <PropertyInput
        label="Part number"
        value={p.partNumber}
        placeholder={p.generatedPartNumber}
        touch={touch}
        testId="prop-part-number"
        marker={marker('partNumber')}
        onCommit={(v) => commit('partNumber', v)}
      />
      <PropertyInput
        label="Description"
        value={p.description}
        touch={touch}
        testId="prop-description"
        marker={marker('description')}
        onCommit={(v) => commit('description', v)}
      />
    </Section>
  );
}

export function PartInspector({
  part,
  configuration,
  library,
  mass,
  format,
  evaluate,
  formatValue,
  onSetMaterial,
  density = 'compact',
  className,
}: PartInspectorProps) {
  const [picking, setPicking] = useState(false);
  const mat = part.material;
  const touch = density === 'touch';
  const activeIsDefault = !configuration || configuration.activeName === null;
  const matScope = useOneShotScope(activeIsDefault, configuration?.activeName);
  const setMaterial = (m: Material | null) => {
    if (!configuration || activeIsDefault) {
      onSetMaterial(m);
      return;
    }
    const chip = matScope.consume() === 'configuration';
    onSetMaterial(m, chip || configuration.materialOverridden ? 'configuration' : 'all');
  };

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="part-inspector">
      <header className="px-4 pt-3.5 pb-1">
        <h2 className="truncate text-sm leading-5 font-semibold">{part.name}</h2>
        <p className="text-2xs text-fg-muted">Part</p>
      </header>
      <Section title="Material">
        {configuration && configuration.activeName !== null ? (
          <div className="flex items-center gap-1.5">
            <OverrideMarker
              overridden={configuration.materialOverridden}
              configurationName={configuration.activeName}
              fieldLabel="Material"
              onReset={configuration.onResetMaterial}
              size={touch ? 'touch' : 'md'}
            />
            <ScopeChip
              configurationName={configuration.activeName}
              activeIsDefault={false}
              scope={matScope.scope}
              onScopeChange={matScope.setScope}
              size={touch ? 'touch' : 'md'}
            />
          </div>
        ) : null}
        {mat ? (
          <div className="flex items-center gap-2.5">
            <Swatch color={part.color ?? mat.appearance} className="size-7" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui font-medium">{mat.name}</p>
              <p className="tnum text-2xs text-fg-muted" data-testid="material-density">
                {prettyUnits(mat.density)}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-ui text-fg-muted">No material assigned.</p>
        )}
        <div className="flex gap-2">
          <Button
            variant={mat ? 'secondary' : 'primary'}
            size={touch ? 'touch' : 'md'}
            aria-expanded={picking}
            icon={
              <ChevronDown
                className={cn('size-4 transition-transform duration-fast', picking && 'rotate-180')}
              />
            }
            onClick={() => setPicking((p) => !p)}
            className="flex-1"
          >
            {mat ? 'Change material' : 'Assign material'}
          </Button>
          {mat ? (
            <Button variant="ghost" size={touch ? 'touch' : 'md'} onClick={() => setMaterial(null)}>
              Remove
            </Button>
          ) : null}
        </div>
        {picking ? (
          <Suspense
            fallback={<p className="py-4 text-center text-ui text-fg-muted">Loading materials…</p>}
          >
            <MaterialPicker
              library={library}
              current={mat}
              evaluate={evaluate}
              formatValue={formatValue}
              size={touch ? 'touch' : 'md'}
              onSelect={(m) => {
                setMaterial(m);
                setPicking(false);
              }}
              onClose={() => setPicking(false)}
            />
          </Suspense>
        ) : null}
      </Section>
      {configuration ? <PropertiesSection cfg={configuration} touch={touch} /> : null}
      <Section title="Mass properties">
        <MassReadout mass={mass} format={format} hasMaterial={!!mat} />
        {configuration && configuration.masses.length > 1 ? (
          <div className="mt-3">
            <h4 className="pb-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
              Mass per configuration
            </h4>
            <ul
              className="m-0 flex list-none flex-col gap-0.5 p-0 text-ui"
              data-testid="mass-per-configuration"
            >
              {configuration.masses.map((r) => (
                <li
                  key={r.id ?? 'default'}
                  data-config-id={r.id ?? 'default'}
                  className="flex items-center gap-2"
                >
                  <span className={cn('min-w-0 flex-1 truncate', r.active && 'font-semibold')}>
                    {r.name}
                    {r.active ? <span className="sr-only"> (active)</span> : null}
                  </span>
                  {r.mass ? (
                    <span className="tnum font-medium" data-prop="config-mass">
                      {r.mass}
                    </span>
                  ) : (
                    <ConfigStatusLabel status={r.status} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
