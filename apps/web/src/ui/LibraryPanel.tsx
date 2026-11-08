/**
 * Local library (PLAN §2.6): recent documents with thumbnails, search, open, rename, delete and
 * new. A non-modal panel over the viewport; the rest of the app keeps working behind it.
 */

import type { LibraryEntry } from '@whittle/contracts';
import { Button, cn, IconButton } from '@whittle/ui';
import { Box, FolderOpen, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import { useDoc } from './Inspector';
import { WelcomeContent } from './Welcome';

function useThumbUrl(bytes: Uint8Array | undefined): string | null {
  const url = useMemo(
    () =>
      bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })) : null,
    [bytes],
  );
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
};

function Card({ wb, entry, current }: { wb: Workbench; entry: LibraryEntry; current: boolean }) {
  const url = useThumbUrl(entry.thumbnail);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <li
      className={cn(
        'group/card flex flex-col overflow-hidden rounded-[14px] bg-surface shadow-[inset_0_0_0_1px_var(--color-border)] transition-shadow hover:shadow-[inset_0_0_0_1.5px_var(--color-accent)]',
        current && 'shadow-[inset_0_0_0_2px_var(--color-accent)]',
      )}
      data-testid="library-item"
      data-current={current || undefined}
    >
      <button
        type="button"
        onClick={() => void wb.openFromLibrary(entry.id)}
        className="relative block aspect-[4/3] w-full bg-gradient-to-b from-viewport-top to-viewport-bottom outline-none focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`Open ${entry.name}`}
      >
        {url ? (
          <img src={url} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <Box
            className="absolute top-1/2 left-1/2 size-8 -translate-1/2 text-fg-subtle"
            strokeWidth={1.25}
            aria-hidden
          />
        )}
      </button>
      <div className="flex items-center gap-1 px-2.5 py-2">
        {renaming !== null ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit Rename press
            autoFocus
            aria-label="New name"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => {
              if (renaming.trim()) void wb.renameInLibrary(entry.id, renaming.trim());
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(null);
            }}
            className="h-7 min-w-0 flex-1 rounded-[7px] bg-surface-2 px-1.5 text-ui font-semibold outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]"
          />
        ) : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui font-semibold" data-testid="library-item-name">
              {entry.name}
            </p>
            <p className="text-2xs text-fg-muted">
              {current ? 'Open now · ' : ''}
              {when(entry.modified)}
            </p>
          </div>
        )}
        {confirm ? (
          <Button
            variant="secondary"
            onClick={() => void wb.deleteFromLibrary(entry.id)}
            className="text-danger-text"
          >
            Delete
          </Button>
        ) : (
          <>
            <IconButton
              label={`Rename ${entry.name}`}
              icon={<Pencil className="size-3.5" />}
              onClick={() => setRenaming(entry.name)}
            />
            <IconButton
              label={`Delete ${entry.name}`}
              icon={<Trash2 className="size-3.5" />}
              onClick={() => setConfirm(true)}
            />
          </>
        )}
      </div>
    </li>
  );
}

export default function LibraryPanel({ wb }: { wb: Workbench }) {
  const entries = useObservable(wb.libraryEntries);
  const doc = useDoc(wb);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => void wb.refreshLibrary(query), 120);
    return () => clearTimeout(t);
  }, [wb, query]);

  return (
    <section
      aria-label="Library"
      data-testid="library-panel"
      className="w-card pointer-events-auto absolute top-14 right-3 bottom-[92px] left-3 flex flex-col overflow-hidden rounded-[18px] shadow-float"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Library</h2>
        <span className="text-2xs text-fg-muted">On this device</span>
        <div className="flex-1" />
        <label className="flex h-8 w-56 items-center gap-1.5 rounded-[9px] bg-surface-2 px-2.5 text-fg-muted focus-within:shadow-[inset_0_0_0_2px_var(--color-accent)]">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            aria-label="Search documents"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none"
          />
        </label>
        <Button
          variant="secondary"
          icon={<FolderOpen className="size-4" />}
          onClick={() => void wb.openFromDisk('new')}
          data-testid="library-open-file"
        >
          Open or import…
        </Button>
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          onClick={() => void wb.newDocument()}
          data-testid="library-new"
        >
          New
        </Button>
        <IconButton
          label="Close library"
          icon={<X className="size-4" />}
          onClick={() => wb.toggleLibrary(false)}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {entries === null ? (
          <p className="p-6 text-center text-ui text-fg-muted">Loading…</p>
        ) : entries.length === 0 && query ? (
          <p className="p-6 text-center text-ui text-fg-muted">Nothing matches “{query}”.</p>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10" data-testid="library-empty">
            <WelcomeContent wb={wb} compact />
            <p className="text-2xs text-fg-muted">
              Documents you edit are saved here automatically.
            </p>
          </div>
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-0">
            {entries.map((e) => (
              <Card key={e.id} wb={wb} entry={e} current={e.id === doc.meta.id} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
