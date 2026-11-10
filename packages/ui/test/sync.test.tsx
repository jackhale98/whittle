import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MergeResolution } from '@wren-cad/contracts';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  branches,
  changes,
  merge as conflictsForTest,
  connections,
  folders,
  geometry,
  NOW,
  providers,
  statuses,
  versions,
} from '../harness/syncGallery';
import {
  ComparePanel,
  ConnectionsPanel,
  describeSyncStatus,
  MergePanel,
  relativeTime,
  SyncStatusChip,
  suggestReleaseName,
  VersionsPanel,
} from '../src';
import { makeEvaluator, renderUI } from './helpers';

/* ------------------------------------------------------------------------- relative time */

describe('relativeTime', () => {
  it('formats minutes, hours, days', () => {
    expect(relativeTime(new Date(NOW - 20_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 h ago');
    expect(relativeTime(new Date(NOW - 30 * 3_600_000).toISOString(), NOW)).toBe('yesterday');
    expect(relativeTime(undefined, NOW)).toBe('never');
  });
});

/* ------------------------------------------------------------------------- SyncStatusChip */

describe('SyncStatusChip', () => {
  const byKey = Object.fromEntries(statuses);

  it.each([
    ['local', 'Local only'],
    ['idle', 'Synced 5 min ago'],
    ['idle-pending', '3 changes to upload'],
    ['syncing', 'Downloading 42%'],
    ['syncing-indeterminate', 'Checking…'],
    ['offline', 'Offline · 3 changes waiting'],
    ['conflicts', '2 conflicts'],
    ['error-auth', 'Signed out'],
    ['error-other', 'Sync problem'],
  ])('%s shows "%s" in a polite status region', (key, text) => {
    const status = byKey[key];
    if (!status) throw new Error(key);
    render(<SyncStatusChip status={status} now={NOW} />);
    const chip = screen.getByRole('status');
    expect(chip).toHaveAttribute('aria-live', 'polite');
    expect(chip).toHaveTextContent(text);
  });

  it('compact keeps the full text for screen readers and a short visible label', () => {
    const status = byKey.offline;
    if (!status) throw new Error('offline');
    render(<SyncStatusChip status={status} now={NOW} compact />);
    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent('Offline · 3');
    expect(within(chip).getByText('Offline · 3 changes waiting')).toHaveClass('sr-only');
  });

  it('conflicts offers Resolve, which calls back', async () => {
    const onResolve = vi.fn();
    const status = byKey.conflicts;
    if (!status) throw new Error('conflicts');
    render(<SyncStatusChip status={status} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledOnce();
  });

  it('an AUTH error offers "Sign in again"; other errors offer a retry', async () => {
    const onSignIn = vi.fn();
    const onRetry = vi.fn();
    const auth = byKey['error-auth'];
    const other = byKey['error-other'];
    if (!auth || !other) throw new Error('errors');
    const { rerender } = render(
      <SyncStatusChip status={auth} onSignIn={onSignIn} onRetry={onRetry} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Dropbox: the token was refused.');
    rerender(<SyncStatusChip status={other} onSignIn={onSignIn} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('non-actionable states have no button', () => {
    for (const k of ['local', 'idle', 'syncing', 'offline']) {
      const status = byKey[k];
      if (!status) throw new Error(k);
      const { unmount } = render(<SyncStatusChip status={status} now={NOW} />);
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });

  it('touch density gives the action a 44 px minimum', () => {
    const status = byKey.conflicts;
    if (!status) throw new Error('conflicts');
    render(<SyncStatusChip status={status} density="touch" onResolve={() => {}} />);
    expect(screen.getByRole('button', { name: 'Resolve' })).toHaveClass('min-h-11');
  });

  it('describeSyncStatus clamps progress', () => {
    expect(describeSyncStatus({ state: 'syncing', phase: 'pushing', ratio: 1.4 }).progress).toBe(1);
  });
});

/* ------------------------------------------------------------------------- ConnectionsPanel */

describe('ConnectionsPanel', () => {
  it('lists connections with account and status, and generic icons only', () => {
    const { container } = render(
      <ConnectionsPanel connections={connections} providers={providers} />,
    );
    const list = screen.getByRole('list', { name: 'Connections' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[1]).toHaveTextContent('ann@example.org');
    expect(items[1]).toHaveTextContent('Connected');
    expect(items[2]).toHaveTextContent('Signed out');
    expect(items[3]).toHaveTextContent('Offline');
    // No images: icons are inline SVG from lucide, never brand logos.
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('shows an empty explanation', () => {
    render(<ConnectionsPanel connections={[]} providers={providers} />);
    expect(screen.getByText(/Projects live on this device/)).toBeInTheDocument();
  });

  it('re-sign-in and removal with an inline confirmation (no dialog)', async () => {
    const onReauth = vi.fn();
    const onRemove = vi.fn();
    render(
      <ConnectionsPanel
        connections={connections}
        providers={providers}
        onReauth={onReauth}
        onRemove={onRemove}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onReauth).toHaveBeenCalledWith('C3');
    await userEvent.click(screen.getByRole('button', { name: 'Remove connection Dropbox' }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith('C2');
  });

  it('keeping a connection cancels the removal', async () => {
    const onRemove = vi.fn();
    render(
      <ConnectionsPanel connections={connections} providers={providers} onRemove={onRemove} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove connection Dropbox' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove connection Dropbox' })).toBeInTheDocument();
  });

  it('unavailable providers are disabled with their reason and cannot be chosen', async () => {
    const onSignIn = vi.fn();
    render(<ConnectionsPanel connections={[]} providers={providers} onSignIn={onSignIn} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    const one = screen.getByRole('button', { name: /OneDrive/ });
    expect(one).toHaveAttribute('aria-disabled', 'true');
    expect(one).toHaveAccessibleDescription(/isn’t set up in this build/);
    await userEvent.click(one);
    expect(onSignIn).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { name: 'Where should this project live?' }),
    ).toBeInTheDocument();
  });

  it('OAuth flow: choose, sign in callback, then folders and pick a project', async () => {
    const onSignIn = vi.fn();
    const onBrowse = vi.fn();
    const onPickFolder = vi.fn();
    const props = { connections: [], providers, onSignIn, onBrowse, onPickFolder };
    const { rerender } = render(<ConnectionsPanel {...props} signingIn="dropbox" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    await userEvent.click(screen.getByRole('button', { name: /Dropbox/ }));
    expect(onSignIn).toHaveBeenCalledWith('dropbox');
    expect(screen.getByRole('heading', { name: 'Sign in to Dropbox' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Waiting for sign-in…' })).toBeDisabled();
    // The callback arrives: the host lists the folders.
    rerender(<ConnectionsPanel {...props} browse={folders} />);
    const list = screen.getByRole('list', { name: 'Folders' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0] as HTMLElement).getByText('Wren project')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).queryByText('Wren project')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^drawings/ }));
    expect(onBrowse).toHaveBeenCalledWith('/CAD/drawings');
    await userEvent.click(screen.getByRole('button', { name: 'Up one folder' }));
    expect(onBrowse).toHaveBeenCalledWith('');
    await userEvent.click(screen.getByRole('button', { name: 'Open project bracket' }));
    expect(onPickFolder).toHaveBeenCalledWith({
      path: '/CAD/bracket',
      name: 'bracket',
      isProject: true,
    });
  });

  it('local folder goes straight to the browser picker', async () => {
    const onAddLocalFolder = vi.fn();
    render(
      <ConnectionsPanel
        connections={[]}
        providers={providers}
        onAddLocalFolder={onAddLocalFolder}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    await userEvent.click(screen.getByRole('button', { name: /Folder on this device/ }));
    expect(onAddLocalFolder).toHaveBeenCalledOnce();
  });

  it('WebDAV: inline fields, validation, relay toggle with the CORS explanation', async () => {
    const onAddWebDav = vi.fn();
    render(
      <ConnectionsPanel
        connections={[]}
        providers={providers}
        defaultAdding="webdav"
        onAddWebDav={onAddWebDav}
      />,
    );
    expect(screen.getByText(/\(CORS\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onAddWebDav).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(3);
    await userEvent.type(screen.getByLabelText('Server URL'), 'https://dav.example.org/files');
    await userEvent.type(screen.getByLabelText('Username'), 'ann');
    await userEvent.type(screen.getByLabelText('App password'), 'abcd-efgh');
    const relay = screen.getByRole('switch', { name: 'Use relay' });
    expect(relay).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(relay);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onAddWebDav).toHaveBeenCalledWith({
      url: 'https://dav.example.org/files',
      username: 'ann',
      password: 'abcd-efgh',
      relay: true,
    });
  });

  it('GitHub: explains the fine-grained scopes, then submits the token', async () => {
    const onAddToken = vi.fn();
    render(
      <ConnectionsPanel
        connections={[]}
        providers={providers}
        defaultAdding="github"
        addError="GitHub refused the token."
        onAddToken={onAddToken}
      />,
    );
    expect(screen.getByText(/Contents = Read and write/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub refused the token.');
    await userEvent.type(screen.getByLabelText('Fine-grained token'), 'github_pat_x');
    // The repository is required: nothing is submitted without it.
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onAddToken).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter owner\/repository/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Repository'), 'ann/bracket');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onAddToken).toHaveBeenCalledWith({
      kind: 'github',
      host: 'github.com',
      token: 'github_pat_x',
      username: '',
      repo: 'ann/bracket',
    });
  });

  it('cancel closes the flow and notifies the host', async () => {
    const onCancelAdd = vi.fn();
    render(<ConnectionsPanel connections={[]} providers={providers} onCancelAdd={onCancelAdd} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelAdd).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeInTheDocument();
  });

  it('touch density: 44 px controls and 16 px inputs', () => {
    render(
      <ConnectionsPanel
        connections={[]}
        providers={providers}
        defaultAdding="webdav"
        density="touch"
      />,
    );
    expect(screen.getByLabelText('Server URL')).toHaveClass('h-11', 'text-base');
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveClass('h-11');
  });
});

/* ------------------------------------------------------------------------- VersionsPanel */

describe('VersionsPanel', () => {
  const base = { versions, branches, currentId: 'V6', now: NOW };

  it('hides automatic snapshots behind a toggle and shows release badges, author and time', async () => {
    render(<VersionsPanel {...base} />);
    const list = screen.getByRole('list', { name: 'Version history' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getByText('Rev A')).toBeInTheDocument();
    expect(within(list).getByText('Ben', { exact: false })).toBeInTheDocument();
    expect(within(list).getByText('20 min ago')).toBeInTheDocument();
    expect(within(list).getByText('Current')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Automatic snapshots (2)' });
    await userEvent.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });

  it('showAuto can be controlled', async () => {
    const onShowAutoChange = vi.fn();
    render(<VersionsPanel {...base} showAuto={false} onShowAutoChange={onShowAutoChange} />);
    await userEvent.click(screen.getByRole('switch', { name: /Automatic snapshots/ }));
    expect(onShowAutoChange).toHaveBeenCalledWith(true);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('saves a version from the inline field, then clears it', async () => {
    const onSave = vi.fn();
    render(<VersionsPanel {...base} onSave={onSave} />);
    const save = screen.getByRole('button', { name: 'Save version…' });
    expect(save).toBeDisabled();
    const field = screen.getByLabelText('Save version');
    await userEvent.type(field, 'Wider flange{Enter}');
    expect(onSave).toHaveBeenCalledWith('Wider flange');
    expect(field).toHaveValue('');
  });

  it('⌘S / Ctrl+S inside the panel focuses the field, then saves from it', async () => {
    const onSave = vi.fn();
    render(<VersionsPanel {...base} onSave={onSave} />);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const keys = mac ? '{Meta>}s{/Meta}' : '{Control>}s{/Control}';
    screen.getByRole('list', { name: 'Version history' }).focus();
    const first = screen.getAllByRole('button', { name: /Wider flange/ })[0];
    first?.focus();
    await userEvent.keyboard(keys);
    const field = screen.getByLabelText('Save version');
    expect(field).toHaveFocus();
    await userEvent.type(field, 'Quick save');
    await userEvent.keyboard(keys);
    expect(onSave).toHaveBeenCalledWith('Quick save');
  });

  it('the shortcut can be switched off', async () => {
    render(<VersionsPanel {...base} saveShortcut={false} />);
    expect(screen.queryByText(/jumps here/)).toBeNull();
  });

  it('switches branches and creates one inline ("Try an idea")', async () => {
    const onSwitchBranch = vi.fn();
    const onCreateBranch = vi.fn();
    render(
      <VersionsPanel {...base} onSwitchBranch={onSwitchBranch} onCreateBranch={onCreateBranch} />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Branch'), 'thinner-wall');
    expect(onSwitchBranch).toHaveBeenCalledWith('thinner-wall');
    await userEvent.click(screen.getByRole('button', { name: 'Try an idea' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give your idea a name');
    const name = screen.getByLabelText('Name your idea');
    await userEvent.type(name, 'main');
    await userEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(screen.getByRole('alert')).toHaveTextContent('already a branch');
    await userEvent.clear(name);
    await userEvent.type(name, 'thicker{Enter}');
    expect(onCreateBranch).toHaveBeenCalledWith('thicker');
  });

  it('open, restore and compare per version; compare is off for the current one', async () => {
    const onOpen = vi.fn();
    const onRestore = vi.fn();
    const onCompare = vi.fn();
    render(<VersionsPanel {...base} onOpen={onOpen} onRestore={onRestore} onCompare={onCompare} />);
    const row = screen.getByRole('button', { name: /Fillet the inner corners/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await userEvent.click(screen.getByRole('button', { name: 'Compare with current' }));
    expect(onOpen).toHaveBeenCalledWith('V4');
    expect(onRestore).toHaveBeenCalledWith('V4');
    expect(onCompare).toHaveBeenCalledWith('V4');
    await userEvent.click(screen.getByRole('button', { name: /Wider flange/ }));
    expect(screen.getAllByRole('button', { name: 'Compare with current' })[0]).toBeDisabled();
  });

  it('marks a release with an inline, unique name; released versions open read-only', async () => {
    const onRelease = vi.fn();
    render(<VersionsPanel {...base} onRelease={onRelease} />);
    await userEvent.click(screen.getByRole('button', { name: /Fillet the inner corners/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark as release…' }));
    const name = screen.getByLabelText('Release name');
    expect(name).toHaveAttribute('placeholder', 'Rev B');
    await userEvent.type(name, 'rev a');
    await userEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(screen.getByRole('alert')).toHaveTextContent('already a release');
    await userEvent.clear(name);
    await userEvent.type(name, 'Rev B{Enter}');
    expect(onRelease).toHaveBeenCalledWith('V4', 'Rev B');
    // Already released: no second release, and the open action says read-only.
    await userEvent.click(screen.getByRole('button', { name: /First release/ }));
    expect(screen.getByRole('button', { name: 'Open read-only' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as release…' })).toBeNull();
  });

  it('Escape cancels the inline forms', async () => {
    render(<VersionsPanel {...base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try an idea' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByLabelText('Name your idea')).toBeNull();
  });

  it('shows the diverged notice with Merge, and the read-only banner with a way back', async () => {
    const onMerge = vi.fn();
    const onReturnToCurrent = vi.fn();
    render(
      <VersionsPanel
        {...base}
        viewingId="V3"
        diverged={{ theirs: 'V9' }}
        onMerge={onMerge}
        onReturnToCurrent={onReturnToCurrent}
      />,
    );
    expect(screen.getByTestId('diverged-notice')).toHaveTextContent('changes from another device');
    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(onMerge).toHaveBeenCalledWith('V9');
    expect(screen.getByText(/Viewing Rev A, read-only/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to current' }));
    expect(onReturnToCurrent).toHaveBeenCalledOnce();
  });

  it('empty state', () => {
    render(<VersionsPanel versions={[]} branches={[]} />);
    expect(screen.getByText(/No saved versions yet/)).toBeInTheDocument();
  });

  it('suggests the next free release name', () => {
    expect(suggestReleaseName(versions)).toBe('Rev B');
    expect(suggestReleaseName([])).toBe('Rev A');
  });

  it('touch density: 44 px, 16 px text', () => {
    render(<VersionsPanel {...base} density="touch" />);
    expect(screen.getByLabelText('Save version')).toHaveClass('h-11', 'text-base');
    expect(screen.getByLabelText('Branch')).toHaveClass('h-11', 'text-base');
    expect(screen.getByRole('button', { name: 'Try an idea' })).toHaveClass('h-11');
  });
});

/* ------------------------------------------------------------------------- ComparePanel */

describe('ComparePanel', () => {
  const props = {
    changes,
    geometry,
    beforeLabel: 'Rev A',
    afterLabel: 'Current',
    overlay: 'both' as const,
    onOverlayChange: () => {},
  };

  it('groups changes: added, removed, changed, moved', () => {
    render(<ComparePanel {...props} />);
    const added = screen.getByRole('region', { name: /Added/ });
    expect(within(added).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('region', { name: /Removed/ })).toHaveTextContent('Chamfer 1 removed');
    // Modified and renamed share a group.
    expect(
      within(screen.getByRole('region', { name: /Changed/ })).getAllByRole('listitem'),
    ).toHaveLength(3);
    expect(screen.getByRole('region', { name: /Moved/ })).toHaveTextContent('Hole 1 moved');
  });

  it('feature subjects get their featureMeta icon (label-inferred or provided)', () => {
    const { rerender } = render(<ComparePanel {...props} />);
    const row = screen.getByRole('button', { name: /Fillet 3 added/ });
    expect(row.querySelector('svg')).not.toBeNull();
    const featureType = vi.fn(() => 'extrude' as const);
    rerender(<ComparePanel {...props} featureType={featureType} />);
    expect(featureType).toHaveBeenCalled();
  });

  it('shows mass and bbox deltas with units and signs', () => {
    render(<ComparePanel {...props} />);
    const geo = screen.getByTestId('compare-geometry');
    expect(geo).toHaveTextContent('+4,200 mm³');
    expect(within(geo).getByRole('row', { name: /Mass/ })).toHaveTextContent('+0.0114 kg');
    expect(within(geo).getByRole('row', { name: /Size Z/ })).toHaveTextContent('+8 mm');
    expect(within(geo).getByRole('row', { name: /Size X/ })).toHaveTextContent('0 mm');
    expect(geo).toHaveTextContent('5,400 mm³ added');
    expect(geo).toHaveTextContent('1,200 mm³ removed');
  });

  it('uses the host formatter when given', () => {
    render(<ComparePanel {...props} formatValue={(v) => `${v.toFixed(1)}!`} />);
    expect(screen.getByTestId('compare-geometry')).toHaveTextContent('5400.0! added');
  });

  it('overlay toggles are a radio group that calls back; glyphs pair the colours', async () => {
    const onOverlayChange = vi.fn();
    render(<ComparePanel {...props} onOverlayChange={onOverlayChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Overlay' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'Show both versions' })).toBeChecked();
    await userEvent.click(within(group).getByRole('radio', { name: 'Show added material' }));
    expect(onOverlayChange).toHaveBeenCalledWith('added');
    await userEvent.click(within(group).getByRole('radio', { name: 'Show removed material' }));
    expect(onOverlayChange).toHaveBeenCalledWith('removed');
    // + and − glyphs accompany the colours in the legend too.
    expect(
      screen.getByTestId('compare-geometry').querySelectorAll('svg').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('loading, unavailable and empty states', () => {
    const { rerender } = render(
      <ComparePanel {...props} geometry={null} geometryState="loading" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Comparing shapes');
    rerender(<ComparePanel {...props} geometry={null} />);
    expect(screen.getByText(/3D comparison isn't available/)).toBeInTheDocument();
    rerender(<ComparePanel {...props} changes={[]} />);
    expect(screen.getByText('No feature changes between these versions.')).toBeInTheDocument();
  });

  it('selecting a change and closing call back', async () => {
    const onSelectChange = vi.fn();
    const onClose = vi.fn();
    render(
      <ComparePanel
        {...props}
        onSelectChange={onSelectChange}
        onClose={onClose}
        selectedIndex={0}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Chamfer 1 removed/ }));
    expect(onSelectChange).toHaveBeenCalledWith(changes[2]);
    expect(screen.getByRole('button', { name: /Fillet 3 added/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------------- MergePanel */

function MergeHost({
  initial = [],
  onFinish = () => {},
  onPreview,
  onResolveSpy,
}: {
  initial?: MergeResolution[];
  onFinish?(): void;
  onPreview?(id: string, c: unknown): void;
  onResolveSpy?(r: MergeResolution): void;
}) {
  const [res, setRes] = useState<MergeResolution[]>(initial);
  const ev = makeEvaluator([{ name: 'height', expr: '32mm' }]);
  return (
    <MergePanel
      result={conflictsForTest(3, 12)}
      resolutions={res}
      evaluate={(e) => ev(e, 'length')}
      onResolve={(r) => {
        onResolveSpy?.(r);
        setRes((p) => [...p.filter((x) => x.conflictId !== r.conflictId), r]);
      }}
      onUnresolve={(id) => setRes((p) => p.filter((x) => x.conflictId !== id))}
      onPreview={onPreview}
      onFinish={onFinish}
    />
  );
}

describe('MergePanel', () => {
  it('lists conflicts side by side with human values, expressions as typed', () => {
    renderUI(<MergeHost />);
    const list = screen.getByRole('list', { name: 'Conflicts' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const first = items[0] as HTMLElement;
    expect(first).toHaveAccessibleName(/Conflict 1 of 3: Parameter width/);
    expect(within(first).getByText('60mm')).toBeInTheDocument();
    expect(within(first).getByText('64mm')).toBeInTheDocument();
    expect(within(first).getByText('height * 2')).toBeInTheDocument();
    const second = items[1] as HTMLElement;
    expect(within(second).getByText('Not there')).toBeInTheDocument();
  });

  it('shows the merge notes as plain lines, even with no conflicts', () => {
    renderUI(
      <MergePanel
        result={{ doc: conflictsForTest(0, 0).doc, conflicts: [], autoMerged: 2 }}
        resolutions={[]}
        onResolve={() => {}}
        onFinish={() => {}}
        notes={['Fillet 3 left folder Mounting to keep the folder in one piece.']}
      />,
    );
    const notes = screen.getByRole('list', { name: 'Notes about this merge' });
    expect(within(notes).getAllByRole('listitem')).toHaveLength(1);
    expect(notes).toHaveTextContent('Fillet 3 left folder Mounting');
  });

  it('names a conflict by its subject and field when the app supplies them', () => {
    renderUI(
      <MergePanel
        result={conflictsForTest(1, 0)}
        resolutions={[]}
        onResolve={() => {}}
        onFinish={() => {}}
        conflictTitle={(c) => `${c.subject.label} visibility`}
        conflictSummary={(c) => `${c.subject.label} visibility: shown vs hidden`}
      />,
    );
    const card = screen.getAllByRole('listitem')[0] as HTMLElement;
    expect(card).toHaveAccessibleName(/Conflict 1 of 1: .* visibility: shown vs hidden/);
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(/ visibility$/);
  });

  it('shows the auto-merged count and progress', () => {
    renderUI(<MergeHost />);
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('0 of 3 conflicts decided');
    expect(screen.getByTestId('merge-summary')).toHaveTextContent(
      '12 changes merged automatically',
    );
  });

  it('Finish merge stays disabled until every conflict is decided', async () => {
    const onFinish = vi.fn();
    renderUI(<MergeHost onFinish={onFinish} />);
    const finish = screen.getByRole('button', { name: 'Finish merge' });
    expect(finish).toBeDisabled();
    expect(finish).toHaveAccessibleDescription('Decide 3 more conflicts to finish the merge.');
    const keep = screen.getAllByRole('button', { name: 'Keep mine' });
    await userEvent.click(keep[0] as HTMLElement);
    await userEvent.click(screen.getAllByRole('button', { name: 'Take theirs' })[1] as HTMLElement);
    expect(finish).toBeDisabled();
    await userEvent.click(keep[2] as HTMLElement);
    expect(finish).toBeEnabled();
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('3 of 3 conflicts decided');
    await userEvent.click(finish);
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('reports resolutions and reflects them with aria-pressed, then Undo', async () => {
    const spy = vi.fn();
    renderUI(<MergeHost onResolveSpy={spy} />);
    const mine = screen.getAllByRole('button', { name: 'Keep mine' })[0] as HTMLElement;
    await userEvent.click(mine);
    expect(spy).toHaveBeenCalledWith({ conflictId: 'k1', take: 'ours' });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    const card = screen.getByRole('listitem', { name: /Parameter width/ });
    expect(card).toHaveAttribute('data-resolved', 'true');
    await userEvent.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(card).toHaveAttribute('data-resolved', 'false');
  });

  it('edits an expression inline with the ExpressionInput (live value)', async () => {
    const spy = vi.fn();
    renderUI(<MergeHost onResolveSpy={spy} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit value' })[0] as HTMLElement);
    const input = screen.getByRole('textbox', { name: 'New value for Parameter width' });
    expect(input).toHaveValue('64mm');
    await userEvent.clear(input);
    await userEvent.type(input, 'height + 20mm{Enter}');
    expect(spy).toHaveBeenCalledWith({ conflictId: 'k1', value: 'height + 20mm' });
    expect(screen.getByText('Entered a new value')).toBeInTheDocument();
  });

  it('plain text leaves get a plain field, not an expression field', async () => {
    const spy = vi.fn();
    renderUI(<MergeHost onResolveSpy={spy} />);
    const card = screen.getByRole('listitem', { name: /Part name/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit value' }));
    const input = within(card).getByRole('textbox', { name: 'New value for Part name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Bracket B{Enter}');
    expect(spy).toHaveBeenCalledWith({ conflictId: 'k3', value: 'Bracket B' });
  });

  it('previews each side through the callback', async () => {
    const onPreview = vi.fn();
    renderUI(<MergeHost onPreview={onPreview} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Preview theirs for Parameter width' }),
    );
    expect(onPreview).toHaveBeenCalledWith('k1', 'theirs');
    await userEvent.click(screen.getByRole('button', { name: 'Preview mine for Parameter width' }));
    expect(onPreview).toHaveBeenCalledWith('k1', 'ours');
  });

  it('preview buttons are hidden without a callback', () => {
    renderUI(<MergeHost />);
    expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();
  });

  it('"Next unresolved" moves focus to the next undecided conflict card', async () => {
    renderUI(<MergeHost initial={[{ conflictId: 'k1', take: 'ours' }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next unresolved' }));
    expect(screen.getByRole('listitem', { name: /Fillet 3/ })).toHaveFocus();
  });

  it('every control is reachable by Tab in reading order', async () => {
    renderUI(<MergeHost />);
    const first = screen.getAllByRole('button', { name: 'Keep mine' })[0] as HTMLElement;
    first.focus();
    await userEvent.tab();
    expect(screen.getAllByRole('button', { name: 'Take theirs' })[0]).toHaveFocus();
    await userEvent.tab();
    expect(screen.getAllByRole('button', { name: 'Edit value' })[0]).toHaveFocus();
  });

  it('no conflicts: finish is available straight away', () => {
    renderUI(
      <MergePanel
        result={conflictsForTest(0, 0)}
        resolutions={[]}
        onResolve={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Finish merge' })).toBeEnabled();
    expect(screen.getByText('No conflicts')).toBeInTheDocument();
  });
});
