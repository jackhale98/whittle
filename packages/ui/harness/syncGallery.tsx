import type {
  Branch,
  DiffChange,
  GeometricDiff,
  MergeResolution,
  MergeResult,
  SyncStatus,
  Version,
  WrenDoc,
} from '@wren-cad/contracts';
import { type ReactNode, useState } from 'react';
import {
  type CompareOverlay,
  ComparePanel,
  type ConnectionItem,
  ConnectionsPanel,
  type FolderBrowse,
  MergePanel,
  type ProviderOption,
  SyncStatusChip,
  VersionsPanel,
} from '../src';
import { makeEvaluator } from './fixtures';

type Tier = 'desktop' | 'tablet' | 'phone';

/** A fixed "now" so relative times are deterministic in screenshots. */
export const NOW = Date.parse('2026-06-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

const card = 'w-card overflow-hidden';

/** Desktop: a 296 px side panel. Tablet and phone: the bottom sheet's width. */
function Frame({ tier, children, label }: { tier: Tier; children: ReactNode; label?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label ? (
        <span className="px-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
          {label}
        </span>
      ) : null}
      <div
        className={card}
        style={{ width: tier === 'desktop' ? 296 : 'min(100vw - 32px, 460px)' }}
      >
        {children}
      </div>
    </div>
  );
}

const grid = (tier: Tier) =>
  `flex gap-4 p-4 ${tier === 'desktop' ? 'flex-row flex-wrap items-start' : 'flex-col items-start'}`;

/* ------------------------------------------------------------------------- fixtures */

export const providers: ProviderOption[] = [
  { kind: 'folder', available: true },
  { kind: 'dropbox', available: true },
  { kind: 'onedrive', available: false, reason: 'OneDrive isn’t set up in this build.' },
  { kind: 'gdrive', available: true },
  { kind: 'webdav', available: true },
  { kind: 'github', available: true },
  { kind: 'gitlab', available: true },
  { kind: 'forgejo', available: true },
];

export const connections: ConnectionItem[] = [
  {
    connection: { id: 'C1', kind: 'folder', label: 'Workshop folder', handleKey: 'h1' },
    health: 'connected',
    projects: 2,
  },
  {
    connection: { id: 'C2', kind: 'dropbox', label: 'Dropbox', account: 'ann@example.org' },
    health: 'connected',
    projects: 1,
  },
  {
    connection: {
      id: 'C3',
      kind: 'webdav',
      label: 'Nextcloud',
      url: 'https://cloud.example.org/remote.php/dav/files/ann',
      username: 'ann',
      relay: true,
    },
    health: 'signedOut',
    detail: 'The server refused the app password.',
  },
  {
    connection: { id: 'C4', kind: 'github', label: 'GitHub', host: 'github.com', account: 'ann' },
    health: 'offline',
  },
];

export const folders: FolderBrowse = {
  connectionLabel: 'Dropbox',
  path: '/CAD',
  folders: [
    { name: 'bracket', path: '/CAD/bracket', isProject: true },
    { name: 'enclosure', path: '/CAD/enclosure', isProject: true },
    { name: 'drawings', path: '/CAD/drawings', isProject: false },
    { name: 'old', path: '/CAD/old', isProject: false },
  ],
};

export const merge = (n: number, autoMerged = 0): MergeResult => ({
  doc: {} as WrenDoc,
  autoMerged,
  conflicts: Array.from({ length: n }, (_, i) => conflicts[i]).filter(
    (c): c is NonNullable<typeof c> => !!c,
  ),
});

const conflicts: MergeResult['conflicts'] = [
  {
    id: 'k1',
    kind: 'bothModified',
    path: '/params/P1/expr',
    subject: { kind: 'param', id: 'P1', label: 'Parameter width' },
    base: '60mm',
    ours: '64mm',
    theirs: 'height * 2',
  },
  {
    id: 'k2',
    kind: 'modifiedDeleted',
    path: '/parts/PT1/features/F3',
    subject: { kind: 'feature', id: 'F3', label: 'Fillet 3' },
    base: 'Fillet 3, radius 2 mm',
    ours: 'Fillet 3, radius 3 mm',
  },
  {
    id: 'k3',
    kind: 'bothModified',
    path: '/parts/PT1/name',
    subject: { kind: 'part', id: 'PT1', label: 'Part name' },
    base: 'Bracket',
    ours: 'Bracket A',
    theirs: 'Mount bracket',
  },
];

export const statuses: Array<[string, SyncStatus]> = [
  ['local', { state: 'local' }],
  ['idle', { state: 'idle', lastSyncAt: ago(5 * MIN), pending: 0 }],
  ['idle-pending', { state: 'idle', lastSyncAt: ago(2 * H), pending: 3 }],
  ['syncing', { state: 'syncing', phase: 'pulling', ratio: 0.42 }],
  ['syncing-indeterminate', { state: 'syncing', phase: 'listing', ratio: null }],
  ['offline', { state: 'offline', pending: 3 }],
  ['conflicts', { state: 'conflicts', merge: merge(2, 5) }],
  [
    'error-auth',
    { state: 'error', error: { code: 'AUTH', message: 'Dropbox: the token was refused.' } },
  ],
  [
    'error-other',
    { state: 'error', error: { code: 'REMOTE', message: 'The server returned 503.', status: 503 } },
  ],
];

const author = { name: 'Ann' };
export const versions: Version[] = [
  { id: 'V6', parents: ['V5'], message: 'Wider flange', author, at: ago(20 * MIN), hash: 'h6' },
  { id: 'V5', parents: ['V4'], message: '', author, at: ago(3 * H), hash: 'h5', auto: true },
  {
    id: 'V4',
    parents: ['V3'],
    message: 'Fillet the inner corners',
    author: { name: 'Ben' },
    at: ago(1.5 * D),
    hash: 'h4',
  },
  {
    id: 'V3',
    parents: ['V2'],
    message: 'First release',
    author,
    at: ago(6 * D),
    hash: 'h3',
    releases: ['Rev A'],
  },
  { id: 'V2', parents: ['V1'], message: '', author, at: ago(7 * D), hash: 'h2', auto: true },
  { id: 'V1', parents: [], message: 'Start', author, at: ago(30 * D), hash: 'h1' },
];

export const branches: Branch[] = [
  { name: 'main', head: 'V6', current: true },
  { name: 'thinner-wall', head: 'V4', current: false, ahead: 2 },
];

export const changes: DiffChange[] = [
  {
    kind: 'added',
    subject: { kind: 'feature', id: 'F4', label: 'Fillet 3' },
    summary: 'Fillet 3 added',
  },
  {
    kind: 'added',
    subject: { kind: 'param', id: 'P3', label: 'wall' },
    summary: 'Parameter wall = 3 mm added',
  },
  {
    kind: 'removed',
    subject: { kind: 'feature', id: 'F9', label: 'Chamfer 1' },
    summary: 'Chamfer 1 removed',
  },
  {
    kind: 'modified',
    subject: { kind: 'feature', id: 'F2', label: 'Extrude 1' },
    summary: 'Extrude 1: distance 40 mm → 48 mm',
  },
  {
    kind: 'modified',
    subject: { kind: 'sketchEntity', id: 'E2', featureId: 'F1', label: 'Line 2 in Sketch 1' },
    summary: 'Line 2 in Sketch 1: moved to (60, 0)',
  },
  {
    kind: 'moved',
    subject: { kind: 'feature', id: 'F5', label: 'Hole 1' },
    summary: 'Hole 1 moved below Extrude 1',
  },
  {
    kind: 'renamed',
    subject: { kind: 'part', id: 'PT1', label: 'Bracket' },
    summary: 'Part renamed Bracket → Mount bracket',
  },
];

const zeroMass = {
  area: 0,
  centroid: [0, 0, 0] as [number, number, number],
  faceCount: 0,
  edgeCount: 0,
  vertexCount: 0,
};
export const geometry: GeometricDiff = {
  added: [],
  removed: [],
  addedVolume: 5400,
  removedVolume: 1200,
  a: {
    mass: {
      ...zeroMass,
      volume: 31_250,
      mass: 0.0843,
      bbox: { min: [0, 0, 0], max: [60, 30, 40] },
    },
    bbox: { min: [0, 0, 0], max: [60, 30, 40] },
  },
  b: {
    mass: {
      ...zeroMass,
      volume: 35_450,
      mass: 0.0957,
      bbox: { min: [0, 0, 0], max: [60, 30, 48] },
    },
    bbox: { min: [0, 0, 0], max: [60, 30, 48] },
  },
};

/* ------------------------------------------------------------------------- sections */

function SyncSection({ tier }: { tier: Tier }) {
  const touch = tier !== 'desktop';
  return (
    <div className={grid(tier)} data-testid="g-sync">
      <div className="grid grid-cols-1 gap-2.5">
        {statuses.map(([k, s]) => (
          <div key={k} className="flex flex-wrap items-center gap-3" data-status={k}>
            <span className="w-40 text-2xs text-fg-muted">{k}</span>
            <SyncStatusChip
              status={s}
              now={NOW}
              density={touch ? 'touch' : 'compact'}
              onResolve={() => {}}
              onSignIn={() => {}}
              onRetry={() => {}}
            />
          </div>
        ))}
      </div>
      <div
        className="flex w-[390px] max-w-full flex-col gap-2 rounded-panel bg-surface p-2.5 shadow-card"
        data-testid="g-sync-compact"
      >
        <span className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">
          Phone top bar (compact)
        </span>
        {statuses.map(([k, s]) => (
          <div key={k} className="flex">
            <SyncStatusChip
              status={s}
              now={NOW}
              compact
              density={touch ? 'touch' : 'compact'}
              onResolve={() => {}}
              onSignIn={() => {}}
              onRetry={() => {}}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionsSection({ tier }: { tier: Tier }) {
  const density = tier === 'desktop' ? 'compact' : 'touch';
  return (
    <div className={grid(tier)} data-testid="g-connections">
      <Frame tier={tier} label="List">
        <ConnectionsPanel
          connections={connections}
          providers={providers}
          density={density}
          onRemove={() => {}}
        />
      </Frame>
      <Frame tier={tier} label="Empty">
        <ConnectionsPanel connections={[]} providers={providers} density={density} />
      </Frame>
      <Frame tier={tier} label="Choose a service">
        <ConnectionsPanel
          connections={[]}
          providers={providers}
          density={density}
          defaultAdding="choose"
        />
      </Frame>
      <Frame tier={tier} label="Sign in (waiting)">
        <ConnectionsPanel
          connections={[]}
          providers={providers}
          density={density}
          defaultAdding="dropbox"
          signingIn="dropbox"
        />
      </Frame>
      <Frame tier={tier} label="WebDAV">
        <ConnectionsPanel
          connections={[]}
          providers={providers}
          density={density}
          defaultAdding="webdav"
        />
      </Frame>
      <Frame tier={tier} label="GitHub token">
        <ConnectionsPanel
          connections={[]}
          providers={providers}
          density={density}
          defaultAdding="github"
          addError="GitHub refused the token. Check that it has access to the repository."
        />
      </Frame>
      <Frame tier={tier} label="Pick a folder">
        <ConnectionsPanel
          connections={[]}
          providers={providers}
          density={density}
          browse={folders}
        />
      </Frame>
      <Frame tier={tier} label="Loading folders">
        <ConnectionsPanel
          connections={[]}
          providers={providers}
          density={density}
          browse={{ connectionLabel: 'Dropbox', path: '', folders: null }}
        />
      </Frame>
    </div>
  );
}

function VersionsSection({ tier }: { tier: Tier }) {
  const density = tier === 'desktop' ? 'compact' : 'touch';
  return (
    <div className={grid(tier)} data-testid="g-versions">
      <Frame tier={tier} label="Timeline">
        <VersionsPanel
          versions={versions}
          branches={branches}
          currentId="V6"
          now={NOW}
          density={density}
        />
      </Frame>
      <Frame tier={tier} label="Auto shown, diverged, viewing a release">
        <VersionsPanel
          versions={versions}
          branches={branches}
          currentId="V6"
          viewingId="V3"
          showAuto
          diverged={{ theirs: 'V9', message: 'Another device saved changes to main.' }}
          now={NOW}
          density={density}
        />
      </Frame>
      <Frame tier={tier} label="Empty">
        <VersionsPanel
          versions={[]}
          branches={[{ name: 'main', head: '', current: true }]}
          density={density}
        />
      </Frame>
    </div>
  );
}

function CompareSection({ tier }: { tier: Tier }) {
  const density = tier === 'desktop' ? 'compact' : 'touch';
  const [overlay, setOverlay] = useState<CompareOverlay>('both');
  return (
    <div className={grid(tier)} data-testid="g-compare">
      <Frame tier={tier} label="Compare">
        <ComparePanel
          changes={changes}
          geometry={geometry}
          beforeLabel="Rev A"
          afterLabel="Current"
          overlay={overlay}
          onOverlayChange={setOverlay}
          selectedIndex={3}
          onClose={() => {}}
          density={density}
        />
      </Frame>
      <Frame tier={tier} label="Added overlay, shape loading">
        <ComparePanel
          changes={changes.slice(0, 3)}
          geometryState="loading"
          beforeLabel="Rev A"
          afterLabel="Current"
          overlay="added"
          onOverlayChange={() => {}}
          density={density}
        />
      </Frame>
      <Frame tier={tier} label="Removed overlay, no changes">
        <ComparePanel
          changes={[]}
          geometry={geometry}
          beforeLabel="Rev A"
          afterLabel="Current"
          overlay="removed"
          onOverlayChange={() => {}}
          density={density}
        />
      </Frame>
    </div>
  );
}

function StatefulMerge({
  density,
  initial = [],
  result,
}: {
  density: 'compact' | 'touch';
  initial?: MergeResolution[];
  result: MergeResult;
}) {
  const [res, setRes] = useState<MergeResolution[]>(initial);
  const evaluate = makeEvaluator([{ name: 'height', expr: '32mm' }]);
  return (
    <MergePanel
      result={result}
      resolutions={res}
      density={density}
      oursLabel="This device"
      theirsLabel="Ben’s laptop"
      evaluate={(e) => evaluate(e, 'length')}
      onResolve={(r) => setRes((p) => [...p.filter((x) => x.conflictId !== r.conflictId), r])}
      onUnresolve={(id) => setRes((p) => p.filter((x) => x.conflictId !== id))}
      onPreview={() => {}}
      onFinish={() => {}}
      onCancel={() => {}}
    />
  );
}

function MergeSection({ tier }: { tier: Tier }) {
  const density = tier === 'desktop' ? 'compact' : 'touch';
  return (
    <div className={grid(tier)} data-testid="g-merge">
      <Frame tier={tier} label="Undecided">
        <StatefulMerge density={density} result={merge(3, 12)} />
      </Frame>
      <Frame tier={tier} label="Partly decided">
        <StatefulMerge
          density={density}
          result={merge(3, 12)}
          initial={[
            { conflictId: 'k1', take: 'ours' },
            { conflictId: 'k2', value: 'Fillet 3, radius 2.5 mm' },
          ]}
        />
      </Frame>
      <Frame tier={tier} label="All decided">
        <StatefulMerge
          density={density}
          result={merge(2, 12)}
          initial={[
            { conflictId: 'k1', take: 'theirs' },
            { conflictId: 'k2', take: 'ours' },
          ]}
        />
      </Frame>
    </div>
  );
}

export function SyncGallery({ section, tier }: { section: string; tier: Tier }) {
  switch (section) {
    case 'sync':
      return <SyncSection tier={tier} />;
    case 'connections':
      return <ConnectionsSection tier={tier} />;
    case 'versions':
      return <VersionsSection tier={tier} />;
    case 'compare':
      return <CompareSection tier={tier} />;
    case 'merge':
      return <MergeSection tier={tier} />;
    default:
      return null;
  }
}

export const syncSections = ['sync', 'connections', 'versions', 'compare', 'merge'] as const;
