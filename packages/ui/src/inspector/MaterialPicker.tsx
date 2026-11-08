import type { EvalResult, Expr, Material } from '@whittle/contracts';
import { Check, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Segmented } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn } from '../components/primitives';
import type { FormatValue } from '../format';
import { type MaterialLibraryItem, SWATCHES, toMaterial } from './materials';

export interface MaterialPickerProps {
  library: readonly MaterialLibraryItem[];
  current?: Material;
  evaluate(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  onSelect(material: Material): void;
  onClose?(): void;
  size?: 'md' | 'touch';
}

/**
 * Material search + custom material form. Lazy-loaded by `PartInspector` the first time it opens.
 * Library entries are matched on name and category; the custom tab takes a name, a density
 * expression with units (`2.70 g/cm^3`, `0.0975 lb/in^3`) and a swatch colour.
 */
export default function MaterialPicker({
  library,
  current,
  evaluate,
  formatValue,
  onSelect,
  onClose,
  size = 'md',
}: MaterialPickerProps) {
  const [mode, setMode] = useState<'library' | 'custom'>(
    current && !current.libraryId ? 'custom' : 'library',
  );
  const [query, setQuery] = useState('');
  const [name, setName] = useState(current && !current.libraryId ? current.name : '');
  const [density, setDensity] = useState(current && !current.libraryId ? current.density : '');
  const [color, setColor] = useState<string>(current?.appearance ?? SWATCHES[0]);
  const listId = useId();

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = library.filter(
      (m) => !q || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q),
    );
    const map = new Map<string, MaterialLibraryItem[]>();
    for (const m of hits) map.set(m.category, [...(map.get(m.category) ?? []), m]);
    return [...map.entries()];
  }, [library, query]);
  const count = groups.reduce((n, [, xs]) => n + xs.length, 0);

  const densityResult = density.trim() ? evaluate(density) : undefined;
  const densityOk = densityResult?.ok === true;
  const canApply = name.trim().length > 0 && densityOk;

  return (
    <div className="flex flex-col gap-2.5" data-testid="material-picker">
      <Segmented
        label="Material source"
        size={size}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'library', label: 'Library' },
          { value: 'custom', label: 'Custom' },
        ]}
      />
      {mode === 'library' ? (
        <>
          <label className="relative block">
            <span className="sr-only">Search materials</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden
            />
            <input
              type="search"
              aria-controls={listId}
              placeholder="Search materials"
              value={query}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  document.getElementById(listId)?.querySelector<HTMLElement>('button')?.focus();
                }
              }}
              className={cn(
                'w-full rounded-control bg-surface-2 pr-2.5 pl-8 text-ui text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none placeholder:text-fg-subtle focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
                size === 'touch' ? 'h-11' : 'h-8',
              )}
            />
          </label>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: roving arrow-key navigation across the option buttons */}
          <div
            id={listId}
            className="max-h-64 overflow-y-auto rounded-control"
            onKeyDown={(e) => {
              const items = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>('button[data-material]'),
              );
              const i = items.indexOf(document.activeElement as HTMLElement);
              if (e.key === 'ArrowDown') items[Math.min(i + 1, items.length - 1)]?.focus();
              else if (e.key === 'ArrowUp') {
                if (i <= 0)
                  (
                    e.currentTarget.parentElement?.querySelector('input') as HTMLElement | null
                  )?.focus();
                else items[i - 1]?.focus();
              } else return;
              e.preventDefault();
            }}
          >
            {groups.map(([cat, items]) => (
              <section key={cat} aria-label={cat}>
                <h4 className="sticky top-0 bg-surface px-1 py-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
                  {cat}
                </h4>
                <ul className="m-0 list-none p-0">
                  {items.map((m) => {
                    const on = current?.libraryId === m.libraryId;
                    return (
                      <li key={m.libraryId} className="list-none">
                        <button
                          type="button"
                          data-material={m.libraryId}
                          aria-pressed={on}
                          onClick={() => onSelect(toMaterial(m))}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-[8px] px-1.5 text-left transition-colors duration-150 hover:bg-surface-2 focus-visible:bg-surface-2',
                            size === 'touch' ? 'h-12' : 'h-9',
                            on && 'bg-accent-soft hover:bg-accent-soft',
                          )}
                        >
                          <span
                            aria-hidden
                            className="size-5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.18)]"
                            style={{ background: m.appearance ?? '#9aa4b2' }}
                          />
                          <span className="min-w-0 flex-1 truncate text-ui">{m.name}</span>
                          <span className="tnum shrink-0 text-2xs text-fg-muted">{m.density}</span>
                          {on ? (
                            <Check className="size-4 shrink-0 text-accent-text" aria-hidden />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {count === 0 ? (
              <p className="px-2 py-6 text-center text-ui text-fg-muted" role="status">
                No materials match “{query}”.{' '}
                <button
                  type="button"
                  className="font-medium text-accent-text underline"
                  onClick={() => {
                    setName(query);
                    setMode('custom');
                  }}
                >
                  Create a custom material
                </button>
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-muted">Name</span>
            <input
              value={name}
              placeholder="e.g. Cast iron"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              className={cn(
                'w-full rounded-control bg-surface-2 px-2.5 text-ui text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none placeholder:text-fg-subtle focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
                size === 'touch' ? 'h-11' : 'h-8',
              )}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-muted" id={`${listId}-d`}>
              Density
            </span>
            <ExpressionInput
              label="Density"
              value={density}
              placeholder="7.2 g/cm^3"
              evaluate={evaluate}
              formatValue={formatValue}
              onCommit={setDensity}
              onPreview={setDensity}
              size={size}
              keypad="auto"
            />
          </div>
          <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
            <legend className="sr-only">Colour</legend>
            {SWATCHES.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`Colour ${s}`}
                aria-pressed={color === s}
                onClick={() => setColor(s)}
                style={{ background: s }}
                className={cn(
                  'rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.2)] transition-shadow duration-150',
                  size === 'touch' ? 'size-9' : 'size-6',
                  color === s && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                )}
              />
            ))}
          </fieldset>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size={size}
              disabled={!canApply}
              className="flex-1"
              onClick={() =>
                onSelect({ name: name.trim(), density: density.trim(), appearance: color })
              }
            >
              Apply material
            </Button>
            {onClose ? (
              <Button variant="ghost" size={size} onClick={onClose}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
