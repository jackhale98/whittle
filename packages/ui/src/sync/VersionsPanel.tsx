import type { Branch, Version } from '@wren-cad/contracts';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCompare,
  GitMerge,
  Lock,
  RotateCcw,
  Save,
  Sparkles,
  Tag,
} from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { Switch } from '../components/controls';
import { Button, cn, Kbd } from '../components/primitives';
import { modKey } from '../shells/shared';
import {
  Badge,
  inputClass,
  PanelShell,
  plural,
  relativeTime,
  rowBtn,
  type SyncDensity,
  TextField,
} from './shared';

export interface DivergedNotice {
  /** The other head, passed back to `onMerge`. */
  theirs: string;
  /** "Another device saved changes to main." */
  message?: string;
}

export interface VersionsPanelProps {
  /** Newest first, as `HistoryStore.log` returns them. Includes automatic snapshots. */
  versions: readonly Version[];
  branches: readonly Branch[];
  /** The version the working copy is based on; marked "Current". */
  currentId?: string;
  /** Showing a released or older version read-only: it is named in a banner with a way back. */
  viewingId?: string | null;
  onReturnToCurrent?(): void;
  /** Saves a named version. The panel clears the field after a successful call. */
  onSave?(message: string): void | Promise<void>;
  saving?: boolean;
  /** Error from the last save (shown under the field). */
  saveError?: string | null;
  onOpen?(versionId: string): void;
  onRestore?(versionId: string): void;
  onCompare?(versionId: string): void;
  onRelease?(versionId: string, name: string): void;
  onSwitchBranch?(name: string): void;
  /** "Try an idea": a branch from the current head. */
  onCreateBranch?(name: string): void;
  diverged?: DivergedNotice | null;
  onMerge?(theirs: string): void;
  /** Controlled "show automatic snapshots"; omit to let the panel keep it. */
  showAuto?: boolean;
  onShowAutoChange?(show: boolean): void;
  /** Handle ⌘S / Ctrl+S inside the panel: focus the message field, or save from it. Default true. */
  saveShortcut?: boolean;
  /** "Now" for relative times. */
  now?: number;
  density?: SyncDensity;
  className?: string;
}

/** Names already used by releases, for the inline uniqueness check. */
function releaseNames(versions: readonly Version[]): Set<string> {
  return new Set(versions.flatMap((v) => v.releases ?? []).map((n) => n.toLowerCase()));
}

/** First free "Rev A", "Rev B", … for the placeholder. */
export function suggestReleaseName(versions: readonly Version[]): string {
  const used = releaseNames(versions);
  for (let i = 0; i < 26; i++) {
    const n = `Rev ${String.fromCharCode(65 + i)}`;
    if (!used.has(n.toLowerCase())) return n;
  }
  return `Rev ${used.size + 1}`;
}

/**
 * Versions timeline (PLAN 8A.3): save a named version, try an idea on a branch, restore, open
 * or compare any version, mark a release. Presentational: every action is a callback.
 */
export function VersionsPanel({
  versions,
  branches,
  currentId,
  viewingId,
  onReturnToCurrent,
  onSave,
  saving,
  saveError,
  onOpen,
  onRestore,
  onCompare,
  onRelease,
  onSwitchBranch,
  onCreateBranch,
  diverged,
  onMerge,
  showAuto: showAutoProp,
  onShowAutoChange,
  saveShortcut = true,
  now,
  density = 'compact',
  className,
}: VersionsPanelProps) {
  const touch = density === 'touch';
  const size = touch ? 'touch' : 'md';
  const [autoLocal, setAutoLocal] = useState(false);
  const showAuto = showAutoProp ?? autoLocal;
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const branchId = useId();

  const autoCount = versions.filter((v) => v.auto).length;
  const shown = useMemo(
    () => (showAuto ? versions : versions.filter((v) => !v.auto || v.id === currentId)),
    [versions, showAuto, currentId],
  );
  const current = branches.find((b) => b.current);
  const viewing = viewingId ? versions.find((v) => v.id === viewingId) : undefined;
  const mod = modKey();

  async function save() {
    const text = message.trim();
    if (!text || saving) return;
    await onSave?.(text);
    setMessage('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!saveShortcut || e.altKey || e.shiftKey) return;
    const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
    if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement === field.current && message.trim()) void save();
      else field.current?.focus();
    }
  }

  return (
    <PanelShell
      title="Versions"
      density={density}
      testId="versions-panel"
      className={className}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        {viewing ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-control bg-accent-soft p-2.5 text-xs text-accent-text"
          >
            <Lock className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              Viewing {viewing.releases?.[0] ?? viewing.message}, read-only.
            </span>
            <Button size={size} onClick={onReturnToCurrent}>
              Back to current
            </Button>
          </div>
        ) : null}

        {diverged ? (
          <div
            role="status"
            data-testid="diverged-notice"
            className="flex flex-wrap items-center gap-2 rounded-control bg-warning-soft p-2.5 text-xs text-warning-text"
          >
            <GitMerge className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {diverged.message ??
                `This branch has changes from another device${current ? ` (${current.name})` : ''}.`}
            </span>
            <Button variant="primary" size={size} onClick={() => onMerge?.(diverged.theirs)}>
              Merge
            </Button>
          </div>
        ) : null}

        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField
            label="Save version"
            inputRef={field}
            value={message}
            density={density}
            placeholder="What changed? e.g. Wider flange"
            error={saveError}
            hint={
              saveShortcut ? (
                <>
                  <Kbd>{mod === 'Ctrl' ? 'Ctrl+S' : '⌘S'}</Kbd> in this panel jumps here. Named
                  versions are never pruned.
                </>
              ) : undefined
            }
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              size={size}
              disabled={!message.trim() || saving}
              icon={<Save className="size-4" aria-hidden />}
            >
              {saving ? 'Saving…' : 'Save version…'}
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={branchId} className="text-xs font-medium text-fg-muted">
                Branch
              </label>
              <select
                id={branchId}
                value={current?.name ?? ''}
                disabled={branches.length === 0}
                onChange={(e) => onSwitchBranch?.(e.target.value)}
                className={cn(inputClass(density), 'pr-7')}
              >
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.ahead || b.behind
                      ? ` (${b.ahead ? `↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''})`
                      : ''}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size={size}
              aria-expanded={ideaOpen}
              icon={<Sparkles className="size-4" aria-hidden />}
              onClick={() => setIdeaOpen((o) => !o)}
            >
              Try an idea
            </Button>
          </div>
          {ideaOpen ? (
            <IdeaForm
              density={density}
              branches={branches}
              onCancel={() => setIdeaOpen(false)}
              onCreate={(name) => {
                setIdeaOpen(false);
                onCreateBranch?.(name);
              }}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-fg-muted">{plural(shown.length, 'version')}</h3>
          {autoCount > 0 || showAuto ? (
            <Switch
              checked={showAuto}
              onChange={(v) => {
                setAutoLocal(v);
                onShowAutoChange?.(v);
              }}
              label={`Automatic snapshots (${autoCount})`}
              className={cn('text-xs', touch && 'min-h-11')}
            />
          ) : null}
        </div>

        {shown.length === 0 ? (
          <p className="rounded-control bg-surface-2 p-3 text-ui text-fg-muted">
            No saved versions yet. Save one above to mark a point you can come back to.
          </p>
        ) : (
          <ol aria-label="Version history" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {shown.map((v) => (
              <VersionRow
                key={v.id}
                version={v}
                versions={versions}
                isCurrent={v.id === currentId}
                isViewing={v.id === viewingId}
                expanded={expanded === v.id}
                releasing={releasing === v.id}
                now={now}
                density={density}
                onToggle={() => {
                  setExpanded((e) => (e === v.id ? null : v.id));
                  setReleasing(null);
                }}
                onOpen={() => onOpen?.(v.id)}
                onRestore={() => onRestore?.(v.id)}
                onCompare={() => onCompare?.(v.id)}
                onStartRelease={() => setReleasing(v.id)}
                onCancelRelease={() => setReleasing(null)}
                onRelease={(name) => {
                  setReleasing(null);
                  onRelease?.(v.id, name);
                }}
              />
            ))}
          </ol>
        )}
      </div>
    </PanelShell>
  );
}

function IdeaForm({
  density,
  branches,
  onCancel,
  onCreate,
}: {
  density: SyncDensity;
  branches: readonly Branch[];
  onCancel(): void;
  onCreate(name: string): void;
}) {
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const trimmed = name.trim();
  const clash = branches.some((b) => b.name.toLowerCase() === trimmed.toLowerCase());
  const error = !tried
    ? null
    : !trimmed
      ? 'Give your idea a name'
      : clash
        ? `There is already a branch called “${trimmed}”`
        : null;
  const size = density === 'touch' ? 'touch' : 'md';
  return (
    <form
      aria-label="Try an idea"
      className="flex flex-col gap-2 rounded-control bg-surface-2 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (trimmed && !clash) onCreate(trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <TextField
        label="Name your idea"
        autoFocus
        value={name}
        density={density}
        error={error}
        placeholder="e.g. Thinner wall"
        hint="Starts a copy from the current version. Your main line is untouched."
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size={size} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size={size}
          icon={<GitBranch className="size-4" aria-hidden />}
        >
          Create branch
        </Button>
      </div>
    </form>
  );
}

function VersionRow({
  version: v,
  versions,
  isCurrent,
  isViewing,
  expanded,
  releasing,
  now,
  density,
  onToggle,
  onOpen,
  onRestore,
  onCompare,
  onStartRelease,
  onCancelRelease,
  onRelease,
}: {
  version: Version;
  versions: readonly Version[];
  isCurrent: boolean;
  isViewing: boolean;
  expanded: boolean;
  releasing: boolean;
  now?: number;
  density: SyncDensity;
  onToggle(): void;
  onOpen(): void;
  onRestore(): void;
  onCompare(): void;
  onStartRelease(): void;
  onCancelRelease(): void;
  onRelease(name: string): void;
}) {
  const touch = density === 'touch';
  const size = touch ? 'touch' : 'md';
  const detailsId = useId();
  const released = (v.releases?.length ?? 0) > 0;
  const when = relativeTime(v.at, now);
  return (
    <li
      data-version-id={v.id}
      data-auto={v.auto || undefined}
      className={cn(
        'flex flex-col rounded-control',
        isViewing || isCurrent ? 'bg-accent-soft' : 'bg-surface-2',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={onToggle}
        className={cn(
          'flex w-full items-start gap-2 rounded-control px-3 py-2 text-left hover:bg-surface-3/60',
          touch ? 'min-h-14' : 'min-h-10',
        )}
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={cn('text-sm font-medium', v.auto && 'font-normal text-fg-muted')}>
              {v.message || (v.auto ? 'Automatic snapshot' : 'Untitled version')}
            </span>
            {isCurrent ? <Badge tone="accent">Current</Badge> : null}
            {v.auto ? <Badge>Auto</Badge> : null}
            {v.releases?.map((r) => (
              <Badge key={r} tone="success">
                <Tag className="size-3" aria-hidden />
                {r}
              </Badge>
            ))}
          </span>
          <span className="block text-2xs text-fg-muted">
            {v.author.name} · <time dateTime={v.at}>{when}</time>
          </span>
        </span>
      </button>
      <div id={detailsId} hidden={!expanded} className="flex flex-col gap-2 px-3 pb-3">
        {expanded ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                size={size}
                onClick={onOpen}
                icon={released ? <Lock className="size-4" aria-hidden /> : undefined}
              >
                {released ? 'Open read-only' : 'Open'}
              </Button>
              <Button
                size={size}
                onClick={onRestore}
                icon={<RotateCcw className="size-4" aria-hidden />}
              >
                Restore
              </Button>
              <Button
                size={size}
                onClick={onCompare}
                disabled={isCurrent}
                icon={<GitCompare className="size-4" aria-hidden />}
              >
                Compare with current
              </Button>
              {!released && !v.auto ? (
                <Button
                  size={size}
                  aria-expanded={releasing}
                  onClick={onStartRelease}
                  icon={<Tag className="size-4" aria-hidden />}
                >
                  Mark as release…
                </Button>
              ) : null}
            </div>
            {releasing ? (
              <ReleaseForm
                density={density}
                versions={versions}
                onCancel={onCancelRelease}
                onRelease={onRelease}
              />
            ) : null}
            {released ? (
              <p className="text-2xs text-fg-muted">
                Released versions are read-only. Restore copies one into your working copy.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

function ReleaseForm({
  density,
  versions,
  onCancel,
  onRelease,
}: {
  density: SyncDensity;
  versions: readonly Version[];
  onCancel(): void;
  onRelease(name: string): void;
}) {
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const suggestion = suggestReleaseName(versions);
  const trimmed = name.trim();
  const clash = releaseNames(versions).has(trimmed.toLowerCase());
  const error = !tried
    ? null
    : !trimmed
      ? `Name the release, for example ${suggestion}`
      : clash
        ? `“${trimmed}” is already a release`
        : null;
  const size = density === 'touch' ? 'touch' : 'md';
  return (
    <form
      aria-label="Mark as release"
      className="flex flex-col gap-2 rounded-control bg-surface p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (trimmed && !clash) onRelease(trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <TextField
        label="Release name"
        autoFocus
        value={name}
        density={density}
        error={error}
        placeholder={suggestion}
        hint="Freezes this version read-only, with its STEP and PDF exports."
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(rowBtn(density), 'text-fg-muted hover:bg-surface-2')}
        >
          Cancel
        </button>
        <Button type="submit" variant="primary" size={size}>
          Release
        </Button>
      </div>
    </form>
  );
}
