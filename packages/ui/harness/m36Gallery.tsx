import { type ReactNode, useState } from 'react';
import { FeatureTree, type FeatureTreeItem, type FeatureTreeProps, type TreeFolder } from '../src';

/* M3.6 visual states: folders, the sketch eye, the phone review-only tree. Interactive states (rename,
   menus, drop indicators, the take-out prompt) are driven by e2e/m36.spec.ts on the live tree. */

type Tier = 'desktop' | 'tablet' | 'phone';
const card = 'w-card w-[296px] overflow-hidden';

const region = (s: string) => ({ name: `S${s}:region(e1)`, kind: 'region' as const });
export type Item = FeatureTreeItem & { profile?: unknown };
const sk = (id: string, name: string, over: Partial<Item> = {}): Item => ({
  id,
  name,
  type: 'sketch',
  suppressed: false,
  ...over,
});
const fe = (id: string, name: string, type: Item['type'], ...sketches: string[]): Item => ({
  id,
  name,
  type,
  suppressed: false,
  ...(sketches.length ? { profile: sketches.map(region) } : {}),
});

export const m36Features: Item[] = [
  sk('s1', 'Sketch 1'),
  fe('e1', 'Extrude 1', 'extrude', 's1'),
  fe('f1', 'Fillet 1', 'fillet'),
  fe('f2', 'Fillet 2', 'fillet'),
  sk('s2', 'Sketch 2'),
  fe('e2', 'Extrude 2', 'extrude', 's2'),
  fe('h1', 'Hole 1', 'hole'),
  sk('s3', 'Sketch 3'),
];
export const m36Folders: TreeFolder[] = [{ id: 'm', name: 'Mounting', features: ['f1', 'f2'] }];

function Cards({ tier, items, testId }: { tier: Tier; testId: string; items: ReactNode[] }) {
  const cols = tier === 'desktop' ? 'flex-row flex-wrap' : 'flex-col';
  return (
    <div className={`flex gap-4 p-4 ${cols}`} data-testid={testId}>
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list
        <div key={`c${i}`} className={card}>
          {it}
        </div>
      ))}
    </div>
  );
}

/** The tree with every M3.6 handler wired to nothing: states only. */
export function FolderTree(props: Partial<FeatureTreeProps> & { tier: Tier }) {
  const { tier, ...rest } = props;
  return (
    <FeatureTree
      density={tier === 'desktop' ? 'compact' : 'touch'}
      features={m36Features}
      folders={m36Folders}
      onSelect={() => {}}
      onRename={() => {}}
      onRollback={() => {}}
      onMove={() => ({ ok: true })}
      onAddFolder={() => {}}
      onRenameFolder={() => {}}
      onRemoveFolder={() => {}}
      onMoveFolder={() => ({ ok: true })}
      onSuppressMany={() => {}}
      onSketchVisibility={() => {}}
      onSuppress={() => {}}
      onDelete={() => {}}
      {...rest}
    />
  );
}

function Folders({ tier }: { tier: Tier }) {
  const suppressed = m36Features.map((f) =>
    f.id === 'f1' || f.id === 'f2' ? { ...f, suppressed: true } : f,
  );
  return (
    <Cards
      tier={tier}
      testId="g-m36-folders"
      items={[
        <FolderTree key="open" tier={tier} selectedId="f2" />,
        <FolderTree key="closed" tier={tier} collapsedFolders={['m']} />,
        <FolderTree key="supp" tier={tier} features={suppressed} />,
        <FolderTree key="roll" tier={tier} rollbackIndex={3} />,
        <FolderTree key="rolled" tier={tier} rollbackIndex={2} collapsedFolders={['m']} />,
      ]}
    />
  );
}

function Eyes({ tier }: { tier: Tier }) {
  const mixed = m36Features.map((f): Item => {
    if (f.id === 's3') return { ...f, visibility: 'hidden' };
    if (f.id === 's2') return { ...f, visibility: 'shown' };
    return f;
  });
  return (
    <Cards
      tier={tier}
      testId="g-m36-eye"
      items={[
        // flat history: s1 (consumed, auto: hidden), s2 (consumed, shown), s3 (unused, auto: shown)
        <FolderTree key="auto" tier={tier} folders={[]} nestSketches={false} />,
        // explicit: s2 shown although consumed, s3 hidden although unused
        <FolderTree
          key="explicit"
          tier={tier}
          folders={[]}
          nestSketches={false}
          features={mixed}
        />,
        // nested: the sketch under its feature carries its own eye
        <FolderTree key="nested" tier={tier} folders={[]} features={mixed} selectedId="s2" />,
      ]}
    />
  );
}

export function PhoneStates() {
  const [at, setAt] = useState<number>(m36Features.length);
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="g-m36-phone">
      <div className={`${card} relative flex h-[520px] flex-col overflow-auto`}>
        <FeatureTree
          density="touch"
          actions="review"
          features={m36Features}
          folders={m36Folders}
          rollbackIndex={at}
          onRollback={setAt}
          onSelect={() => {}}
          onSuppress={() => {}}
          onSketchVisibility={() => {}}
          // Editing handlers a phone app would not pass: `review` drops them regardless.
          onDelete={() => {}}
          onEdit={() => {}}
          onRename={() => {}}
          onMove={() => ({ ok: true })}
          onMoveFolder={() => ({ ok: true })}
          onAddFolder={() => {}}
          onRenameFolder={() => {}}
          onRemoveFolder={() => {}}
          onSuppressMany={() => {}}
        />
      </div>
      <div className={`${card} relative flex h-[520px] flex-col overflow-auto`}>
        <FeatureTree
          density="touch"
          actions="review"
          features={m36Features}
          folders={m36Folders}
          collapsedFolders={['m']}
          rollbackIndex={4}
          onRollback={() => {}}
          onSelect={() => {}}
          onSuppress={() => {}}
          onSketchVisibility={() => {}}
          // Editing handlers a phone app would not pass: `review` drops them regardless.
          onDelete={() => {}}
          onEdit={() => {}}
          onRename={() => {}}
          onMove={() => ({ ok: true })}
          onMoveFolder={() => ({ ok: true })}
          onAddFolder={() => {}}
          onRenameFolder={() => {}}
          onRemoveFolder={() => {}}
          onSuppressMany={() => {}}
        />
      </div>
    </div>
  );
}

/** One live tree for interaction tests. */
function Live({ tier }: { tier: Tier }) {
  const [folders, setFolders] = useState<TreeFolder[]>(m36Folders);
  const [selection, setSelection] = useState<readonly string[]>([]);
  return (
    <Cards
      tier={tier}
      testId="g-m36-live"
      items={[
        <FolderTree
          key="live"
          tier={tier}
          folders={folders}
          selectedIds={selection}
          onSelectedIdsChange={setSelection}
          onRenameFolder={(id, name) =>
            setFolders((fs) => fs.map((f) => (f.id === id ? { ...f, name } : f)))
          }
        />,
      ]}
    />
  );
}

export function M36Gallery({ section, tier }: { section: string; tier: Tier }) {
  switch (section) {
    case 'm36-folders':
      return <Folders tier={tier} />;
    case 'm36-eye':
      return <Eyes tier={tier} />;
    case 'm36-phone':
      return <PhoneStates />;
    case 'm36-live':
      return <Live tier={tier} />;
    default:
      return null;
  }
}
