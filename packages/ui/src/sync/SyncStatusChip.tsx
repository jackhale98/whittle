import type { SyncStatus } from '@wren-cad/contracts';
import {
  CircleAlert,
  CloudCheck,
  GitMerge,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import { cn } from '../components/primitives';
import { plural, relativeTime, relativeTimeShort } from './shared';

export type SyncTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
export type SyncAction = 'resolve' | 'signIn' | 'retry';

export interface SyncDescription {
  tone: SyncTone;
  /** Full label ("Synced 5 min ago"). */
  label: string;
  /** Phone top-bar label ("Synced"). */
  short: string;
  /** Extra line for the tooltip / screen readers (error messages). */
  detail?: string;
  /** Actionable button, when the state has one. */
  action?: { id: SyncAction; label: string };
  /** 0..1 determinate progress; `null` indeterminate; undefined n/a. */
  progress?: number | null;
}

const PHASES = {
  listing: 'Checking',
  pulling: 'Downloading',
  merging: 'Merging',
  pushing: 'Uploading',
} as const;

/** Pure mapping from `SyncStatus` to presentation. Exported for tests and other surfaces. */
export function describeSyncStatus(status: SyncStatus, now: number = Date.now()): SyncDescription {
  switch (status.state) {
    case 'local':
      return { tone: 'neutral', label: 'Local only', short: 'Local' };
    case 'idle': {
      if (status.pending > 0) {
        return {
          tone: 'progress',
          label: `${plural(status.pending, 'change')} to upload`,
          short: `${status.pending} to upload`,
        };
      }
      return {
        tone: 'success',
        label: status.lastSyncAt ? `Synced ${relativeTime(status.lastSyncAt, now)}` : 'Synced',
        short: relativeTimeShort(status.lastSyncAt, now)
          ? `Synced ${relativeTimeShort(status.lastSyncAt, now)}`
          : 'Synced',
      };
    }
    case 'syncing': {
      const verb = PHASES[status.phase];
      const pct = status.ratio === null ? null : Math.round(Math.min(1, status.ratio) * 100);
      return {
        tone: 'progress',
        label: pct === null ? `${verb}…` : `${verb} ${pct}%`,
        short: pct === null ? 'Syncing' : `${pct}%`,
        progress: status.ratio === null ? null : Math.min(1, Math.max(0, status.ratio)),
      };
    }
    case 'offline':
      return {
        tone: 'warning',
        label:
          status.pending > 0 ? `Offline · ${plural(status.pending, 'change')} waiting` : 'Offline',
        short: status.pending > 0 ? `Offline · ${status.pending}` : 'Offline',
        detail: 'Your changes are saved here and will upload when you are back online.',
      };
    case 'conflicts': {
      const n = status.merge.conflicts.length;
      return {
        tone: 'warning',
        label: plural(n, 'conflict'),
        short: plural(n, 'conflict'),
        detail: 'The same thing was changed in two places. Nothing is uploaded until you choose.',
        action: { id: 'resolve', label: 'Resolve' },
      };
    }
    case 'error': {
      const auth = status.error.code === 'AUTH';
      return {
        tone: 'danger',
        label: auth ? 'Signed out' : 'Sync problem',
        short: auth ? 'Signed out' : 'Sync error',
        detail: status.error.message,
        action: auth
          ? { id: 'signIn', label: 'Sign in again' }
          : { id: 'retry', label: 'Try again' },
      };
    }
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

function StateIcon({ status, progress }: { status: SyncStatus; progress?: number | null }) {
  const cls = 'size-4 shrink-0';
  switch (status.state) {
    case 'local':
      return <HardDrive className={cn(cls, 'text-fg-muted')} aria-hidden="true" />;
    case 'idle':
      return status.pending > 0 ? (
        <RefreshCw className={cn(cls, 'text-accent')} aria-hidden="true" />
      ) : (
        <CloudCheck className={cn(cls, 'text-success')} aria-hidden="true" />
      );
    case 'syncing':
      return progress === null || progress === undefined ? (
        <LoaderCircle className={cn(cls, 'w-spinner text-accent')} aria-hidden="true" />
      ) : (
        <Ring progress={progress} />
      );
    case 'offline':
      return <WifiOff className={cn(cls, 'text-warning-text')} aria-hidden="true" />;
    case 'conflicts':
      return <GitMerge className={cn(cls, 'text-warning-text')} aria-hidden="true" />;
    case 'error':
      return <CircleAlert className={cn(cls, 'text-danger-text')} aria-hidden="true" />;
  }
}

export interface SyncStatusChipProps {
  status: SyncStatus;
  /** Short label for the phone top bar. */
  compact?: boolean;
  /** 44 px actions on touch devices. */
  density?: 'compact' | 'touch';
  /** "Now" for relative times (tests, and hosts that tick a clock). */
  now?: number;
  /** Conflicts: open the merge panel. */
  onResolve?(): void;
  /** AUTH errors: re-run the sign-in for the project's connection. */
  onSignIn?(): void;
  /** Other errors. */
  onRetry?(): void;
  className?: string;
}

/**
 * Background sync state (PLAN 8A). A polite live region announces every change; the actionable
 * states (conflicts, errors) carry a real button. Colour is never the only signal: each state
 * has its own icon and words.
 */
export function SyncStatusChip({
  status,
  compact,
  density = 'compact',
  now,
  onResolve,
  onSignIn,
  onRetry,
  className,
}: SyncStatusChipProps) {
  const d = describeSyncStatus(status, now);
  const handler =
    d.action?.id === 'resolve' ? onResolve : d.action?.id === 'signIn' ? onSignIn : onRetry;
  const touch = density === 'touch';
  const tone = d.tone;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sync-status"
      data-state={status.state}
      title={d.detail ? `${d.label}. ${d.detail}` : d.label}
      className={cn(
        'tnum inline-flex max-w-full items-center gap-1.5 rounded-full text-xs font-medium',
        touch ? 'min-h-11' : 'h-8',
        'pl-2.5',
        d.action ? 'pr-1' : 'pr-3',
        tone === 'danger' && 'bg-danger-soft text-danger-text shadow-inset',
        tone === 'warning' && 'bg-warning-soft text-warning-text shadow-inset',
        (tone === 'neutral' || tone === 'progress' || tone === 'success') && 'w-panel text-fg',
        className,
      )}
    >
      <StateIcon status={status} progress={d.progress} />
      {/* The full text stays available to assistive tech when the visible label is shortened. */}
      <span
        className="shrink-0 whitespace-nowrap in-data-[narrow]:sr-only"
        aria-hidden={compact && d.short !== d.label ? true : undefined}
      >
        {compact ? d.short : d.label}
      </span>
      {compact && d.short !== d.label ? <span className="sr-only">{d.label}</span> : null}
      {!compact && d.detail && status.state === 'error' ? (
        <span className="max-w-60 truncate font-normal">{d.detail}</span>
      ) : null}
      {compact && status.state === 'error' ? <span className="sr-only">{d.detail}</span> : null}
      {d.action ? (
        <button
          type="button"
          onClick={handler}
          disabled={!handler}
          className={cn(
            'shrink-0 rounded-full bg-fg px-2.5 text-xs font-semibold text-bg transition-opacity duration-fast hover:opacity-90 disabled:opacity-45',
            touch ? 'min-h-11 min-w-11' : 'h-6',
          )}
        >
          {d.action.label}
        </button>
      ) : null}
    </div>
  );
}
