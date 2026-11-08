import type { DiffChange, DiffSubject, FeatureType, GeometricDiff, Vec3 } from '@whittle/contracts';
import {
  Box,
  Boxes,
  File,
  FileText,
  LoaderCircle,
  Minus,
  Palette,
  PenLine,
  Plus,
  Ruler,
  Variable,
} from 'lucide-react';
import { type ComponentType, useId } from 'react';
import { Segmented } from '../components/controls';
import { Button, cn } from '../components/primitives';
import { featureMeta } from '../features/featureMeta';
import { defaultFormatValue, type FormatValue } from '../format';
import { PanelShell, type SyncDensity } from './shared';

export type CompareOverlay = 'both' | 'added' | 'removed';

type Icon = ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;

const SUBJECT_ICONS: Record<Exclude<DiffSubject['kind'], 'feature'>, Icon> = {
  doc: File,
  param: Variable,
  part: Box,
  material: Palette,
  sketchEntity: PenLine,
  sketchConstraint: Ruler,
  drawing: FileText,
  assembly: Boxes,
};

const featureTypeByLabel = new Map(
  (Object.entries(featureMeta) as Array<[FeatureType, (typeof featureMeta)[FeatureType]]>).map(
    ([type, m]) => [m.label.toLowerCase(), type],
  ),
);

/**
 * Best-effort feature type of a diff subject, from its display name ("Fillet 3" is a fillet).
 * `DiffSubject.featureType` wins when the differ sets it; hosts may also pass `featureType`.
 */
export function inferFeatureType(subject: DiffSubject): FeatureType | undefined {
  if (subject.kind !== 'feature') return undefined;
  const first = subject.label.trim().split(/\s+/)[0]?.toLowerCase();
  return first ? featureTypeByLabel.get(first) : undefined;
}

function SubjectIcon({
  subject,
  featureType,
}: {
  subject: DiffSubject;
  featureType?: (s: DiffSubject) => FeatureType | undefined;
}) {
  const t =
    subject.kind === 'feature'
      ? (subject.featureType ?? featureType?.(subject) ?? inferFeatureType(subject))
      : undefined;
  const Ic: Icon = t
    ? featureMeta[t].Icon
    : subject.kind === 'feature'
      ? Box
      : SUBJECT_ICONS[subject.kind];
  return <Ic className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />;
}

const GROUPS: Array<{
  id: 'added' | 'removed' | 'modified' | 'moved';
  title: string;
  kinds: DiffChange['kind'][];
  glyph: string;
}> = [
  { id: 'added', title: 'Added', kinds: ['added'], glyph: '+' },
  { id: 'removed', title: 'Removed', kinds: ['removed'], glyph: '−' },
  { id: 'modified', title: 'Changed', kinds: ['modified', 'renamed'], glyph: '±' },
  { id: 'moved', title: 'Moved', kinds: ['moved'], glyph: '↕' },
];

export interface ComparePanelProps {
  /** Feature-level changes from `DocDiffer.diff(before, after)`. */
  changes: readonly DiffChange[];
  /** Geometric difference of the selected part; `null` while it is unavailable. */
  geometry?: GeometricDiff | null;
  /** `loading`: the kernel is computing it; `unavailable`: no 3D compare for this pair. */
  geometryState?: 'ready' | 'loading' | 'unavailable';
  /** Names of the two sides: "Rev A" and "Current". */
  beforeLabel: string;
  afterLabel: string;
  overlay: CompareOverlay;
  onOverlayChange(overlay: CompareOverlay): void;
  /** Select a change (e.g. to highlight the feature in the tree). */
  onSelectChange?(change: DiffChange): void;
  selectedIndex?: number | null;
  /** Leave compare mode. */
  onClose?(): void;
  formatValue?: FormatValue;
  featureType?(subject: DiffSubject): FeatureType | undefined;
  density?: SyncDensity;
  className?: string;
}

const MINUS = '−';

/**
 * The exact colour the viewport fills added or removed material with (`compare-*-swatch` tokens
 * mirror packages/viewport `COMPARE_COLORS`), so the legend matches what is drawn.
 */
function Swatch({ side }: { side: 'added' | 'removed' }) {
  return (
    <span
      aria-hidden
      data-swatch={side}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-[3px]',
        side === 'added' ? 'bg-compare-added-swatch' : 'bg-compare-removed-swatch',
      )}
    />
  );
}
const signed = (n: number, fmt: (n: number) => string) =>
  n === 0 ? fmt(0) : `${n > 0 ? '+' : MINUS}${fmt(Math.abs(n))}`;

const size3 = (b: { min: Vec3; max: Vec3 }): Vec3 => [
  b.max[0] - b.min[0],
  b.max[1] - b.min[1],
  b.max[2] - b.min[2],
];

/**
 * Compare two versions (PLAN 8A.3): what changed by feature, how mass and size moved, and an
 * overlay switch for the viewport (both, added in green, removed in red). Added and removed
 * always carry a + or − glyph, so colour is never the only signal.
 */
export function ComparePanel({
  changes,
  geometry,
  geometryState = geometry ? 'ready' : 'unavailable',
  beforeLabel,
  afterLabel,
  overlay,
  onOverlayChange,
  onSelectChange,
  selectedIndex,
  onClose,
  formatValue,
  featureType,
  density = 'compact',
  className,
}: ComparePanelProps) {
  const fmt = formatValue ?? defaultFormatValue;
  const touch = density === 'touch';
  const sizeProp = touch ? 'touch' : 'md';
  const indexed = changes.map((c, i) => ({ c, i }));

  return (
    <PanelShell
      title="Compare"
      density={density}
      testId="compare-panel"
      className={className}
      actions={
        onClose ? (
          <Button size={sizeProp} variant="ghost" onClick={onClose}>
            Done
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        <p className="text-xs text-fg-muted">
          <span className="font-medium text-fg">{beforeLabel}</span> compared with{' '}
          <span className="font-medium text-fg">{afterLabel}</span>
        </p>

        <Segmented<CompareOverlay>
          label="Overlay"
          size={touch ? 'touch' : 'md'}
          value={overlay}
          onChange={onOverlayChange}
          options={[
            { value: 'both', label: 'Both', title: 'Show both versions' },
            {
              value: 'added',
              title: 'Show added material',
              label: (
                <span className="inline-flex items-center gap-1 text-compare-added">
                  <Swatch side="added" />
                  <Plus className="size-3.5" strokeWidth={3} aria-hidden />
                  Added
                </span>
              ),
            },
            {
              value: 'removed',
              title: 'Show removed material',
              label: (
                <span className="inline-flex items-center gap-1 text-compare-removed">
                  <Swatch side="removed" />
                  <Minus className="size-3.5" strokeWidth={3} aria-hidden />
                  Removed
                </span>
              ),
            },
          ]}
        />

        <Geometry
          geometry={geometry}
          state={geometryState}
          fmt={fmt}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
        />

        {changes.length === 0 ? (
          <p className="rounded-control bg-surface-2 p-3 text-ui text-fg-muted">
            No feature changes between these versions.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {GROUPS.map((g) => {
              const items = indexed.filter(({ c }) => g.kinds.includes(c.kind));
              if (items.length === 0) return null;
              return (
                <ChangeGroup
                  key={g.id}
                  group={g}
                  items={items}
                  selectedIndex={selectedIndex}
                  onSelect={onSelectChange}
                  featureType={featureType}
                  touch={touch}
                />
              );
            })}
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function ChangeGroup({
  group,
  items,
  selectedIndex,
  onSelect,
  featureType,
  touch,
}: {
  group: (typeof GROUPS)[number];
  items: Array<{ c: DiffChange; i: number }>;
  selectedIndex?: number | null;
  onSelect?(c: DiffChange): void;
  featureType?(s: DiffSubject): FeatureType | undefined;
  touch: boolean;
}) {
  const id = useId();
  const tone =
    group.id === 'added'
      ? 'text-compare-added'
      : group.id === 'removed'
        ? 'text-compare-removed'
        : 'text-fg-muted';
  return (
    <section aria-labelledby={id} data-group={group.id}>
      <h3 id={id} className={cn('mb-1 flex items-center gap-1.5 text-xs font-semibold', tone)}>
        <span aria-hidden className="tnum w-3 text-center">
          {group.glyph}
        </span>
        {group.title} <span className="font-normal text-fg-muted">({items.length})</span>
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map(({ c, i }) => (
          <li key={`${c.subject.kind}:${c.subject.id ?? c.subject.label}:${i}`}>
            <button
              type="button"
              aria-pressed={selectedIndex === i}
              onClick={() => onSelect?.(c)}
              className={cn(
                'flex w-full items-start gap-2 rounded-control px-2.5 py-1.5 text-left transition-colors duration-fast',
                touch ? 'min-h-11' : 'min-h-8',
                selectedIndex === i ? 'bg-accent-soft' : 'bg-surface-2 hover:bg-surface-3',
                c.kind === 'added' && 'border-l-[3px] border-l-compare-added',
                c.kind === 'removed' && 'border-l-[3px] border-l-compare-removed',
              )}
            >
              <SubjectIcon subject={c.subject} featureType={featureType} />
              <span className="min-w-0 flex-1 text-ui">
                <span className="sr-only">{group.title}: </span>
                {c.summary}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Geometry({
  geometry,
  state,
  fmt,
  beforeLabel,
  afterLabel,
}: {
  geometry?: GeometricDiff | null;
  state: 'ready' | 'loading' | 'unavailable';
  fmt: FormatValue;
  beforeLabel: string;
  afterLabel: string;
}) {
  if (state === 'loading') {
    return (
      <p role="status" className="flex items-center gap-2 text-ui text-fg-muted">
        <LoaderCircle className="w-spinner size-4" aria-hidden /> Comparing shapes…
      </p>
    );
  }
  if (!geometry || state === 'unavailable') {
    return (
      <p className="text-xs text-fg-subtle">
        3D comparison isn't available for this pair. The feature changes below still apply.
      </p>
    );
  }
  const g = geometry;
  const sa = size3(g.a.bbox);
  const sb = size3(g.b.bbox);
  const rows: Array<{ label: string; delta: string; from: string; to: string }> = [];
  const vol = (n: number) => fmt(n, [3, 0, 0, 0]);
  rows.push({
    label: 'Volume',
    delta: signed(g.b.mass.volume - g.a.mass.volume, vol),
    from: vol(g.a.mass.volume),
    to: vol(g.b.mass.volume),
  });
  if (g.a.mass.mass !== undefined && g.b.mass.mass !== undefined) {
    const m = (n: number) => fmt(n, [0, 1, 0, 0]);
    rows.push({
      label: 'Mass',
      delta: signed(g.b.mass.mass - g.a.mass.mass, m),
      from: m(g.a.mass.mass),
      to: m(g.b.mass.mass),
    });
  }
  const len = (n: number) => fmt(n, [1, 0, 0, 0]);
  (['X', 'Y', 'Z'] as const).forEach((axis, k) => {
    rows.push({
      label: `Size ${axis}`,
      delta: signed((sb[k] ?? 0) - (sa[k] ?? 0), len),
      from: len(sa[k] ?? 0),
      to: len(sb[k] ?? 0),
    });
  });
  return (
    <div className="flex flex-col gap-2" data-testid="compare-geometry">
      <ul aria-label="Material changed" className="m-0 flex list-none flex-wrap gap-2 p-0">
        <li
          className={cn(
            'inline-flex items-center gap-1 rounded-full bg-compare-added-soft px-2.5 py-1 text-xs font-medium text-compare-added',
          )}
        >
          <Swatch side="added" />
          <Plus className="size-3.5" strokeWidth={3} aria-hidden />
          <span className="tnum">{vol(g.addedVolume)}</span> added
        </li>
        <li
          className={cn(
            'inline-flex items-center gap-1 rounded-full bg-compare-removed-soft px-2.5 py-1 text-xs font-medium text-compare-removed',
          )}
        >
          <Swatch side="removed" />
          <Minus className="size-3.5" strokeWidth={3} aria-hidden />
          <span className="tnum">{vol(g.removedVolume)}</span> removed
        </li>
      </ul>
      <table className="w-full border-collapse text-ui">
        <caption className="sr-only">
          Change from {beforeLabel} to {afterLabel}
        </caption>
        <thead>
          <tr className="text-left text-2xs text-fg-muted">
            <th scope="col" className="py-1 font-medium">
              Measure
            </th>
            <th scope="col" className="py-1 pl-2 text-right font-medium">
              {beforeLabel}
            </th>
            <th scope="col" className="py-1 pl-2 text-right font-medium">
              {afterLabel}
            </th>
            <th scope="col" className="py-1 pl-2 text-right font-medium">
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border">
              <th scope="row" className="py-1 text-left font-normal text-fg-muted">
                {r.label}
              </th>
              <td className="tnum py-1 pl-2 text-right">{r.from}</td>
              <td className="tnum py-1 pl-2 text-right">{r.to}</td>
              <td
                className={cn(
                  'tnum py-1 pl-2 text-right font-medium',
                  r.delta.startsWith('+') && 'text-compare-added',
                  r.delta.startsWith(MINUS) && 'text-compare-removed',
                )}
              >
                {r.delta}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
