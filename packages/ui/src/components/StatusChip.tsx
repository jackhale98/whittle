import type { KernelStatus } from '@wren-cad/contracts';
import { CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react';
import { cn } from './primitives';

export type StatusTone = 'neutral' | 'progress' | 'success' | 'danger';

export interface StatusDescription {
  tone: StatusTone;
  /** Short primary text. */
  label: string;
  /** Secondary text (hidden in compact mode). */
  detail?: string;
  /** 0..1 when determinate; `null` when the work is indeterminate; omitted when not applicable. */
  progress?: number | null;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Pure mapping from kernel lifecycle to presentation. Exported for tests and other surfaces. */
export function describeKernelStatus(status: KernelStatus): StatusDescription {
  switch (status.state) {
    case 'idle':
      return { tone: 'neutral', label: 'Kernel idle' };
    case 'downloading': {
      const { loaded, total } = status;
      if (total && total > 0) {
        const p = Math.min(1, Math.max(0, loaded / total));
        return {
          tone: 'progress',
          label: `Downloading kernel ${Math.round(p * 100)}%`,
          detail: `${mb(loaded)} / ${mb(total)} MB`,
          progress: p,
        };
      }
      return {
        tone: 'progress',
        label: 'Downloading kernel',
        detail: `${mb(loaded)} MB`,
        progress: null,
      };
    }
    case 'compiling':
      return { tone: 'progress', label: 'Compiling kernel', progress: null };
    case 'ready':
      return {
        tone: 'success',
        label: 'Kernel ready',
        detail: `${status.info.variant} · OCCT ${status.info.occtVersion}`,
      };
    case 'error':
      return {
        tone: 'danger',
        label: 'Kernel error',
        detail: status.error.hint
          ? `${status.error.message} ${status.error.hint}`
          : status.error.message,
      };
  }
}

function Ring({ progress }: { progress: number | null | undefined }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const determinate = typeof progress === 'number';
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('size-4 shrink-0 -rotate-90', !determinate && 'w-spinner')}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-surface-3" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-accent"
        strokeDasharray={determinate ? c : `${c * 0.28} ${c}`}
        strokeDashoffset={determinate ? c * (1 - progress) : 0}
      />
    </svg>
  );
}

export interface StatusChipProps {
  status: KernelStatus;
  /** Label only, no secondary detail (phone). */
  compact?: boolean;
  className?: string;
}

/** Kernel status chip (PLAN 9.1). Announces changes politely; errors are announced assertively. */
export function StatusChip({ status, compact, className }: StatusChipProps) {
  const d = describeKernelStatus(status);
  const error = d.tone === 'danger';
  const title = d.detail ? `${d.label}. ${d.detail}` : d.label;
  return (
    <div
      role={error ? 'alert' : 'status'}
      data-testid="kernel-status"
      data-state={status.state}
      title={title}
      className={cn(
        'tnum inline-flex h-8 max-w-full items-center gap-2 rounded-full pr-3 pl-2.5 text-xs font-medium',
        error ? 'bg-danger-soft text-danger-text shadow-inset' : 'w-panel text-fg',
        className,
      )}
    >
      {status.state === 'idle' ? (
        <span className="mx-0.5 size-2 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />
      ) : status.state === 'downloading' ? (
        <Ring progress={d.progress} />
      ) : status.state === 'compiling' ? (
        <LoaderCircle className="w-spinner size-4 shrink-0 text-accent" aria-hidden="true" />
      ) : status.state === 'ready' ? (
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="whitespace-nowrap">{d.label}</span>
      {!compact && d.detail ? (
        <span
          className={cn(
            'truncate font-normal',
            error ? 'max-w-72 text-danger-text' : 'text-fg-muted',
          )}
        >
          {d.detail}
        </span>
      ) : null}
    </div>
  );
}
