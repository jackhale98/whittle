import * as RTabs from '@radix-ui/react-tabs';
import { ArrowLeft, ChevronDown, ChevronUp, Redo2, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn, IconButton } from '../components/primitives';

export interface DrawingPanelDef {
  id: string;
  label: string;
  /** A count or short text on the tab (attention items). */
  badge?: string | number;
  /** `danger` colours the badge. */
  tone?: 'danger';
  content: ReactNode;
}

export interface DrawingShellProps {
  tier: 'desktop' | 'tablet' | 'phone';
  title: string;
  /** Return to the model. */
  onBack(): void;
  backLabel?: string;
  sheets: readonly { id: string; name: string }[];
  sheetId: string | null;
  onSheet(id: string): void;
  onUndo?(): void;
  onRedo?(): void;
  /** Right of the title: configuration badge, kernel notice, export. */
  actions?: ReactNode;
  /** The drawing tools (absent on the phone, which reviews). */
  tools?: ReactNode;
  canvas: ReactNode;
  /** Over the canvas, bottom centre: the prompt chip, the toast. */
  overlay?: ReactNode;
  panels: readonly DrawingPanelDef[];
  panel: string;
  onPanel(id: string): void;
  /** A line under the top bar (the placeholder kernel's "approximate" note). */
  notice?: ReactNode;
}

const trigger =
  'relative flex h-9 shrink-0 items-center gap-1.5 rounded-control px-3 text-ui font-medium text-fg-muted outline-none transition-colors duration-fast hover:text-fg focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)] data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-[0_1px_2px_rgb(15_23_42/0.14)]';

function Tabs({
  panels,
  panel,
  onPanel,
  touch,
}: Pick<DrawingShellProps, 'panels' | 'panel' | 'onPanel'> & { touch?: boolean }) {
  const active = panels.find((p) => p.id === panel) ?? panels[0];
  return (
    <RTabs.Root value={active?.id} onValueChange={onPanel} className="flex min-h-0 flex-1 flex-col">
      <RTabs.List
        aria-label="Drawing panels"
        className="m-2 flex shrink-0 flex-wrap gap-0.5 rounded-[10px] bg-surface-2 p-0.5"
      >
        {panels.map((p) => (
          <RTabs.Trigger
            key={p.id}
            value={p.id}
            data-panel={p.id}
            className={cn(trigger, touch && 'h-11')}
          >
            {p.label}
            {p.badge !== undefined && p.badge !== 0 ? (
              <span
                className={cn(
                  'tnum rounded-full px-1.5 text-2xs',
                  p.tone === 'danger' ? 'bg-danger text-white' : 'bg-surface-3 text-fg-muted',
                )}
              >
                {p.badge}
              </span>
            ) : null}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {panels.map((p) => (
        <RTabs.Content
          key={p.id}
          value={p.id}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
        >
          {p.id === active?.id ? p.content : null}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

/**
 * The drawing route's chrome. Desktop: tool rail, sheet, side panel. Tablet: a full-bleed sheet
 * with a floating tool rail and a bottom panel. Phone: the sheet to review, with a bottom panel
 * and no editing tools. Nothing here is modal: panels dock beside or under the sheet.
 */
export function DrawingShell(p: DrawingShellProps) {
  const [open, setOpen] = useState(p.tier === 'desktop');
  const touch = p.tier !== 'desktop';
  const topBar = (
    <header
      data-testid="drawing-top-bar"
      className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2"
    >
      <IconButton
        label={p.backLabel ?? 'Back to the model'}
        icon={<ArrowLeft className="size-5" />}
        size={touch ? 'touch' : 'md'}
        onClick={p.onBack}
        data-testid="drawing-back"
      />
      <h1
        className="min-w-0 max-w-[26ch] truncate text-[15px] font-semibold tracking-tight"
        data-testid="drawing-title"
      >
        {p.title}
      </h1>
      {p.sheets.length > 1 ? (
        <nav aria-label="Sheets" className="ml-1 flex gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
          {p.sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={s.id === p.sheetId ? 'page' : undefined}
              onClick={() => p.onSheet(s.id)}
              className={cn(
                'h-8 rounded-[8px] px-2.5 text-xs font-medium',
                s.id === p.sheetId
                  ? 'bg-surface text-fg shadow-[0_1px_2px_rgb(15_23_42/0.14)]'
                  : 'text-fg-muted',
              )}
            >
              {s.name}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="flex-1" />
      {p.onUndo ? (
        <IconButton
          label="Undo"
          icon={<Undo2 className="size-5" />}
          size={touch ? 'touch' : 'md'}
          onClick={p.onUndo}
          data-testid="drawing-undo"
        />
      ) : null}
      {p.onRedo ? (
        <IconButton
          label="Redo"
          icon={<Redo2 className="size-5" />}
          size={touch ? 'touch' : 'md'}
          onClick={p.onRedo}
          data-testid="drawing-redo"
        />
      ) : null}
      {p.actions}
    </header>
  );

  if (p.tier === 'desktop') {
    return (
      <div
        className="flex h-full min-h-0 flex-col bg-bg text-fg"
        data-testid="drawing-shell"
        data-tier="desktop"
      >
        {topBar}
        {p.notice}
        <div className="flex min-h-0 flex-1">
          {p.tools ? (
            <div className="w-14 shrink-0 border-r border-border bg-surface">{p.tools}</div>
          ) : null}
          <main className="relative min-w-0 flex-1" data-testid="drawing-canvas">
            {p.canvas}
            {p.overlay}
          </main>
          <aside
            aria-label="Drawing panels"
            className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-surface"
            data-testid="drawing-side"
          >
            <Tabs panels={p.panels} panel={p.panel} onPanel={p.onPanel} />
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg text-fg"
      data-testid="drawing-shell"
      data-tier={p.tier}
    >
      {topBar}
      {p.notice}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <main className="relative min-h-0 flex-1" data-testid="drawing-canvas">
          {p.canvas}
          {p.tools ? (
            <div className="absolute top-3 left-3 max-w-[calc(100%-1.5rem)] overflow-x-auto rounded-panel bg-surface/95 shadow-pop backdrop-blur">
              {p.tools}
            </div>
          ) : null}
          {p.overlay}
        </main>
        <section
          aria-label="Drawing panels"
          data-testid="drawing-sheet-panel"
          data-open={open}
          className={cn(
            'flex shrink-0 flex-col border-t border-border bg-surface transition-[height] duration-fast',
            open ? (p.tier === 'phone' ? 'h-[55%]' : 'h-[45%]') : 'h-12',
          )}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls="drawing-panel-body"
            onClick={() => setOpen((o) => !o)}
            data-testid="drawing-panel-toggle"
            className="flex h-12 shrink-0 items-center justify-center gap-2 text-ui font-medium text-fg-muted"
          >
            {open ? <ChevronDown className="size-5" /> : <ChevronUp className="size-5" />}
            {open ? 'Hide panels' : (p.panels.find((x) => x.id === p.panel)?.label ?? 'Panels')}
          </button>
          <div id="drawing-panel-body" hidden={!open} className="flex min-h-0 flex-1 flex-col">
            {open ? <Tabs panels={p.panels} panel={p.panel} onPanel={p.onPanel} touch /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
