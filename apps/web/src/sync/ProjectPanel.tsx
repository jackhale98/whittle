/**
 * The project panel (M2.5): Versions and Connections, with Compare and Merge taking it over while
 * they run. Non-modal and inline (CLAUDE.md): a floating card on desktop, a sheet-like card above
 * the bottom sheet on tablet and phone, with 44 px targets there. Lazy chunk with the controller.
 */

import type { MergeConflict } from '@whittle/contracts';
import {
  Button,
  ComparePanel,
  ConnectionsPanel,
  cn,
  defaultDescribeValue,
  IconButton,
  MergePanel,
  Segmented,
  VersionsPanel,
} from '@whittle/ui';
import { FolderGit2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import type { SyncController } from './controller';

const describe = (value: unknown, c: MergeConflict) =>
  value instanceof Uint8Array
    ? `${c.file ?? 'File'} · ${value.byteLength.toLocaleString()} bytes`
    : defaultDescribeValue(value);

export default function ProjectPanel({ wb }: { wb: Workbench }) {
  const [ctl, setCtl] = useState<SyncController | null>(null);
  useEffect(() => {
    let live = true;
    void wb.syncController().then((c) => {
      if (live) setCtl(c);
    });
    return () => {
      live = false;
    };
  }, [wb]);
  const ui = useObservable(wb.ui);
  const touch = wb.tier !== 'desktop';
  const tab = ui.project ?? 'versions';
  return (
    <section
      aria-label="Project"
      data-testid="project-panel"
      data-tab={tab}
      style={{
        top: 'calc(var(--safe-top, 0px) + var(--chrome-top, 0.75rem))',
        bottom: touch ? 'calc(var(--chrome-bottom, 80px) + 12px)' : '5.75rem',
      }}
      className={cn(
        'w-card pointer-events-auto absolute flex flex-col overflow-hidden shadow-float',
        touch
          ? 'right-[max(var(--safe-right,0px),0.75rem)] left-[max(var(--safe-left,0px),var(--chrome-left,0.75rem))] rounded-[18px] sm:left-auto sm:w-[440px]'
          : 'right-3 w-[min(400px,calc(100%-1.5rem))] rounded-[14px]',
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Segmented
          label="Project panel"
          size={touch ? 'touch' : 'md'}
          value={tab}
          onChange={(t) => wb.openProjectPanel(t)}
          options={[
            { value: 'versions', label: 'Versions' },
            { value: 'connections', label: 'Connections' },
          ]}
        />
        <div className="flex-1" />
        <IconButton
          label="Close project panel"
          icon={<X className="size-4" />}
          size={touch ? 'touch' : 'md'}
          onClick={() => wb.openProjectPanel(null)}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ctl ? (
          <Body wb={wb} ctl={ctl} tab={tab} touch={touch} />
        ) : (
          <p className="p-6 text-center text-ui text-fg-muted">Loading…</p>
        )}
      </div>
    </section>
  );
}

function Body({
  wb,
  ctl,
  tab,
  touch,
}: {
  wb: Workbench;
  ctl: SyncController;
  tab: 'versions' | 'connections';
  touch: boolean;
}) {
  const v = useObservable(ctl.view);
  const density = touch ? 'touch' : 'compact';
  const size = touch ? 'touch' : 'md';
  const m = v.mode;
  if (m?.kind === 'merge') {
    return (
      <>
        {m.error ? (
          <p role="alert" className="mx-4 mt-3 text-xs text-danger-text">
            {m.error}
          </p>
        ) : null}
        <MergePanel
          result={m.result}
          resolutions={m.resolutions}
          onResolve={(r) => ctl.setResolution(r)}
          onUnresolve={(id) => ctl.unresolve(id)}
          onPreview={(id, choice) => void ctl.preview(id, choice)}
          onFinish={() => void ctl.finishMerge()}
          onCancel={() => ctl.closeMode()}
          evaluate={(e) => wb.evaluate(e)}
          oursLabel={m.oursLabel}
          theirsLabel={m.theirsLabel}
          describeValue={describe}
          finishing={m.finishing}
          density={density}
        />
      </>
    );
  }
  if (m?.kind === 'compare') {
    return (
      <ComparePanel
        changes={m.changes}
        geometry={m.geometry}
        geometryState={m.state}
        beforeLabel={m.beforeLabel}
        afterLabel="Current"
        overlay={m.overlay}
        onOverlayChange={(o) => ctl.setCompareOverlay(o)}
        onClose={() => ctl.closeMode()}
        density={density}
      />
    );
  }
  if (tab === 'connections') {
    const browse = v.browse;
    return (
      <>
        <ConnectionsPanel
          connections={v.connections}
          providers={v.providers}
          onSignIn={(k) => void ctl.signIn(k)}
          onAddLocalFolder={() => void ctl.addLocalFolder()}
          onAddWebDav={(f) => void ctl.addWebDav(f)}
          onAddToken={(f) => void ctl.addToken(f)}
          signingIn={v.signingIn}
          addError={v.addError}
          browse={browse}
          onBrowse={(path) => browse && void ctl.browse(browse.connectionId, path)}
          onPickFolder={(f) => void ctl.pickFolder(f)}
          onCancelAdd={() => ctl.cancelAdd()}
          onReauth={(id) => {
            const c = v.connections.find((x) => x.connection.id === id)?.connection;
            if (c) void ctl.signIn(c.kind, id);
          }}
          onRemove={(id) => void ctl.removeConnection(id)}
          density={density}
        />
        <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
          <Button
            size={size}
            icon={<FolderGit2 className="size-4" aria-hidden />}
            data-testid="open-local-git"
            aria-disabled={!v.localGit.available || undefined}
            aria-describedby={v.localGit.available ? undefined : 'local-git-reason'}
            onClick={v.localGit.available ? () => void ctl.addLocalFolder() : undefined}
            className={v.localGit.available ? undefined : 'cursor-not-allowed opacity-60'}
          >
            Open a local git repo…
          </Button>
          <p id="local-git-reason" className="text-2xs text-fg-muted">
            {v.localGit.available
              ? 'Pick the repository’s top folder. Versions become commits you can see with your own git.'
              : v.localGit.reason}
          </p>
        </div>
      </>
    );
  }
  const p = v.project;
  const h = p.history;
  const readOnly =
    h?.repoState && h.repoState !== 'clean'
      ? {
          merging:
            'The repository is in the middle of a merge. Finish it with your git; Whittle won’t commit until then.',
          rebasing:
            'The repository is in the middle of a rebase. Finish it with your git; Whittle won’t commit until then.',
          detached:
            'The repository has a detached HEAD. Check out a branch with your git to save versions.',
        }[h.repoState]
      : null;
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 px-4 pt-3" data-testid="project-summary">
        <p className="text-xs text-fg-muted">
          {p.kind === 'local'
            ? 'On this device. Versions are kept with the project.'
            : p.kind === 'localGit'
              ? `Local git repo · ${p.linkLabel ?? ''}`
              : `Synced with ${p.linkLabel ?? 'a connection'}`}
        </p>
        {p.busy ? (
          <p role="status" className="text-xs text-fg-muted">
            {p.busy}
          </p>
        ) : null}
        {p.notice ? (
          <p
            role="alert"
            data-testid="project-notice"
            className="rounded-control bg-warning-soft p-2.5 text-xs text-warning-text"
          >
            {p.notice}
          </p>
        ) : null}
        {readOnly ? (
          <p
            role="alert"
            data-testid="repo-read-only"
            className="rounded-control bg-warning-soft p-2.5 text-xs text-warning-text"
          >
            {readOnly}
          </p>
        ) : null}
        {p.kind === 'localGit' && h && h.cacheIgnored === false ? (
          <div
            data-testid="gitignore-offer"
            className="flex flex-wrap items-center gap-2 rounded-control bg-surface-2 p-2.5 text-xs"
          >
            <span className="min-w-0 flex-1 text-fg-muted">
              Keep Whittle’s regenerable cache out of git: add <code>.whittle/</code> to .gitignore?
            </span>
            <Button size={size} variant="primary" onClick={() => void ctl.addCacheToGitignore()}>
              Add to .gitignore
            </Button>
          </div>
        ) : null}
        {p.kind === 'localGit' && h?.workingChanges && h.workingChanges.length > 0 ? (
          <details data-testid="uncommitted" className="rounded-control bg-surface-2 p-2.5 text-xs">
            <summary className="cursor-pointer font-medium">
              Uncommitted changes · {h.workingChanges.length}{' '}
              {h.workingChanges.length === 1 ? 'file' : 'files'}
            </summary>
            <ul className="m-0 mt-1.5 list-none p-0 font-mono text-2xs text-fg-muted">
              {h.workingChanges.map((c) => (
                <li key={c.path} data-change={c.status}>
                  {c.status === 'added' ? '+' : c.status === 'deleted' ? '−' : '±'} {c.path}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {(p.kind === 'git' || p.kind === 'localGit') && h ? (
          h.canPushPull ? (
            <div className="flex gap-2">
              <Button size={size} data-testid="git-pull" onClick={() => void ctl.pull()}>
                Pull
              </Button>
              <Button size={size} data-testid="git-push" onClick={() => void ctl.push()}>
                Push
              </Button>
            </div>
          ) : (
            <p className="text-2xs text-fg-muted">{h.remoteNote}</p>
          )
        ) : null}
        {p.kind === 'localGit' ? (
          <p className="text-2xs text-fg-subtle">
            Whittle commits only this project’s files, without running git hooks, and leaves Git LFS
            files alone.
          </p>
        ) : null}
      </div>
      {h ? (
        <VersionsPanel
          versions={h.versions}
          branches={h.branches}
          {...(h.currentId ? { currentId: h.currentId } : {})}
          onSave={(msg) => ctl.saveVersion(msg)}
          saving={p.saving}
          saveError={p.saveError}
          onRestore={(id) => void ctl.restore(id)}
          onCompare={(id) => void ctl.compareWith(id)}
          onRelease={(id, name) => void ctl.release(id, name)}
          onSwitchBranch={(name) => void ctl.switchBranch(name)}
          onCreateBranch={(name) => void ctl.createBranch(name)}
          diverged={h.diverged}
          onMerge={(theirs) => void ctl.mergeDiverged(theirs)}
          density={density}
        />
      ) : (
        <p className="p-6 text-center text-ui text-fg-muted">
          {p.id ? 'Loading versions…' : 'Make a change to start this project’s history.'}
        </p>
      )}
    </div>
  );
}
