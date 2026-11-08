import type { EvalResult, Expr, Material, Vec3 } from '@whittle/contracts';
import { ChevronDown, Scale } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Section } from '../components/controls';
import { Button, cn } from '../components/primitives';
import { type FormatValue, fmtNumber } from '../format';
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

export interface PartInspectorProps {
  part: { name: string; material?: Material; color?: string };
  /** Built-in library (passed in so the UI package ships no data). */
  library: readonly MaterialLibraryItem[];
  mass?: MassSummary;
  format?: MassFormat;
  /** Density/other expression evaluation for the custom-material form. */
  evaluate(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  onSetMaterial(material: Material | null): void;
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
export function PartInspector({
  part,
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

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="part-inspector">
      <header className="px-4 pt-3.5 pb-1">
        <h2 className="truncate text-sm leading-5 font-semibold">{part.name}</h2>
        <p className="text-2xs text-fg-muted">Part</p>
      </header>
      <Section title="Material">
        {mat ? (
          <div className="flex items-center gap-2.5">
            <Swatch color={part.color ?? mat.appearance} className="size-7" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui font-medium">{mat.name}</p>
              <p className="tnum text-2xs text-fg-muted">{mat.density}</p>
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
                className={cn('size-4 transition-transform duration-150', picking && 'rotate-180')}
              />
            }
            onClick={() => setPicking((p) => !p)}
            className="flex-1"
          >
            {mat ? 'Change material' : 'Assign material'}
          </Button>
          {mat ? (
            <Button
              variant="ghost"
              size={touch ? 'touch' : 'md'}
              onClick={() => onSetMaterial(null)}
            >
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
                onSetMaterial(m);
                setPicking(false);
              }}
              onClose={() => setPicking(false)}
            />
          </Suspense>
        ) : null}
      </Section>
      <Section title="Mass properties">
        <MassReadout mass={mass} format={format} hasMaterial={!!mat} />
      </Section>
    </div>
  );
}
