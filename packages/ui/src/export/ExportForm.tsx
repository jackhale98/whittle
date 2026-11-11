import { Download, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Field, Segmented } from '../components/controls';
import { Button, cn } from '../components/primitives';
import {
  buildExportRequest,
  EXPORT_TARGETS,
  type ExportBody,
  type ExportConfigurations,
  type ExportRequest,
  type ExportTarget,
  QUALITY_PRESETS,
  type TessellationQuality,
} from './types';

export interface ExportFormProps {
  onExport(request: ExportRequest): void;
  /** Bodies of the active part; with more than one, a body picker appears. */
  bodies?: readonly ExportBody[];
  /** M3.7: the part has configurations: choose the active one or all, one file each. */
  configurations?: ExportConfigurations;
  defaultTarget?: ExportTarget;
  /** Targets the host cannot produce yet; shown disabled with a reason. */
  unavailable?: Partial<Record<ExportTarget, string>>;
  /** Status lines shown in place of a target's blurb (e.g. the kernel loading); not disabled. */
  notes?: Partial<Record<ExportTarget, string>>;
  /** The chosen target, on mount and on every change (the host may start what it needs). */
  onTargetChange?(target: ExportTarget): void;
  busy?: boolean;
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * Export options (PLAN 12 M1): STEP AP214, STL (binary/ASCII, merged/per body, quality presets),
 * 3MF, GLB and `.wrencad`. Emits one `ExportRequest`; the host runs it. Lazy-loaded.
 */
export default function ExportForm({
  onExport,
  bodies = [],
  configurations,
  defaultTarget = 'step',
  unavailable = {},
  notes = {},
  onTargetChange,
  busy,
  size = 'md',
  className,
}: ExportFormProps) {
  const [chosen, setTarget] = useState<ExportTarget>(defaultTarget);
  // A target that became unavailable is never shown checked-but-disabled: the first available
  // one is used instead (and choosing again is always possible).
  const target = unavailable[chosen]
    ? (EXPORT_TARGETS.find((t) => !unavailable[t.id])?.id ?? chosen)
    : chosen;
  const targetChange = useRef(onTargetChange);
  targetChange.current = onTargetChange;
  useEffect(() => {
    targetChange.current?.(target);
  }, [target]);
  const [binary, setBinary] = useState(true);
  const [perBody, setPerBody] = useState(false);
  const [quality, setQuality] = useState<TessellationQuality>('standard');
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [which, setWhich] = useState<'active' | 'all'>('active');
  const gid = useId();
  const meta = EXPORT_TARGETS.find((t) => t.id === target);
  const selected = bodies.filter((b) => !off.has(b.id)).map((b) => b.id);
  const tess = target === 'stl' || target === '3mf' || target === 'glb';
  const bodyScoped = target !== 'wren';
  const none = bodyScoped && bodies.length > 0 && selected.length === 0;

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="export-form">
      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1.5 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
          Format
        </legend>
        {EXPORT_TARGETS.map((t) => {
          const reason = unavailable[t.id];
          const on = target === t.id;
          return (
            <label
              key={t.id}
              className={cn(
                'flex cursor-default items-center gap-3 rounded-control px-2.5 transition-colors duration-fast has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
                size === 'touch' ? 'min-h-12' : 'min-h-10',
                on ? 'bg-accent-soft' : 'hover:bg-surface-2',
                reason && 'opacity-50',
              )}
            >
              <input
                type="radio"
                name={`${gid}-fmt`}
                value={t.id}
                checked={on}
                disabled={!!reason}
                onChange={() => setTarget(t.id)}
                className="size-4 accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-ui font-medium">{t.label}</span>
                  <span className="tnum text-2xs text-fg-muted">{t.ext}</span>
                </span>
                <span
                  className="block truncate text-2xs text-fg-muted"
                  data-testid={notes[t.id] && !reason ? `export-note-${t.id}` : undefined}
                >
                  {reason ?? notes[t.id] ?? t.blurb}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {target === 'stl' ? (
        <div className="flex flex-col gap-2.5">
          <Field label="File type">
            <Segmented
              label="STL file type"
              size={size}
              value={binary ? 'binary' : 'ascii'}
              onChange={(v) => setBinary(v === 'binary')}
              options={[
                { value: 'binary', label: 'Binary' },
                { value: 'ascii', label: 'ASCII' },
              ]}
            />
          </Field>
          <Field label="Bodies">
            <Segmented
              label="STL body layout"
              size={size}
              value={perBody ? 'per' : 'merged'}
              onChange={(v) => setPerBody(v === 'per')}
              options={[
                { value: 'merged', label: 'One merged file' },
                { value: 'per', label: 'File per body' },
              ]}
            />
          </Field>
        </div>
      ) : null}

      {tess ? (
        <Field
          label="Quality"
          hint={`Chord deviation ${QUALITY_PRESETS[quality].hint}, angle ${QUALITY_PRESETS[quality].angularDeflection} rad`}
        >
          <Segmented
            label="Tessellation quality"
            size={size}
            value={quality}
            onChange={setQuality}
            options={(Object.keys(QUALITY_PRESETS) as TessellationQuality[]).map((k) => ({
              value: k,
              label: QUALITY_PRESETS[k].label,
            }))}
          />
        </Field>
      ) : null}

      {configurations && bodyScoped ? (
        <Field
          label="Configurations"
          hint={
            which === 'all'
              ? `${configurations.count} files, one per configuration, named by part number.`
              : undefined
          }
        >
          <Segmented
            label="Configurations to export"
            size={size}
            value={which}
            onChange={setWhich}
            options={[
              { value: 'active', label: `Active (${configurations.activeName})` },
              { value: 'all', label: `All (${configurations.count})` },
            ]}
          />
          {which === 'all' && configurations.warnings?.length ? (
            <ul
              role="alert"
              data-testid="export-collisions"
              className="m-0 mt-1 flex list-none flex-col gap-0.5 rounded-control bg-warning-soft p-2 text-2xs text-warning-text"
            >
              {configurations.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </Field>
      ) : null}

      {bodyScoped && bodies.length > 1 ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
          <legend className="mb-1 text-xs font-medium text-fg-muted">Bodies to export</legend>
          {bodies.map((b) => (
            <label
              key={b.id}
              className={cn(
                'flex items-center gap-2.5 rounded-control px-2.5 hover:bg-surface-2',
                size === 'touch' ? 'min-h-11' : 'min-h-8',
              )}
            >
              <input
                type="checkbox"
                checked={!off.has(b.id)}
                onChange={(e) =>
                  setOff((prev) => {
                    const n = new Set(prev);
                    if (e.target.checked) n.delete(b.id);
                    else n.add(b.id);
                    return n;
                  })
                }
                className="size-4 accent-[var(--color-accent)]"
              />
              <span className="truncate text-ui">{b.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <Button
        variant="primary"
        size={size}
        disabled={busy || none}
        data-autofocus
        icon={
          busy ? (
            <Loader2 className="w-spinner size-4" aria-hidden />
          ) : (
            <Download className="size-4" aria-hidden />
          )
        }
        onClick={() =>
          onExport(
            buildExportRequest({
              target,
              stlBinary: binary,
              stlPerBody: perBody,
              quality,
              bodies: bodies.length ? selected : undefined,
              allBodies: bodies.length,
              ...(configurations ? { configurations: which } : {}),
            }),
          )
        }
      >
        {busy ? 'Exporting…' : `Export ${meta?.label ?? ''}`}
      </Button>
      {none ? <p className="text-2xs text-danger-text">Select at least one body.</p> : null}
    </div>
  );
}
