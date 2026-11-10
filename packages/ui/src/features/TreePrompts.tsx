import { cn } from '../components/primitives';

const btn = (touch: boolean) =>
  cn(
    'rounded-control px-2.5 text-2xs font-medium whitespace-nowrap select-none transition-colors duration-fast',
    touch ? 'h-11' : 'h-7',
  );

/**
 * The inline, non-modal question under a feature row when it has nested sketches. Escape cancels;
 * the first button is focused so a keyboard user can answer straight away.
 */
export function DeletePrompt({
  name,
  sketches,
  touch,
  onAnswer,
  onCancel,
}: {
  name: string;
  sketches: number;
  touch: boolean;
  onAnswer(alsoSketches: boolean): void;
  onCancel(): void;
}) {
  const plural = sketches > 1;
  const b = btn(touch);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not a fieldset
    <div
      role="group"
      aria-label={`Delete ${name}?`}
      data-testid="delete-prompt"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="mt-0.5 mb-1 ml-7 flex flex-wrap items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 p-2"
    >
      <p className="w-full text-2xs leading-4 text-fg">
        {plural ? `“${name}” has ${sketches} sketches.` : `“${name}” has a sketch.`} Delete it too?
      </p>
      <button
        type="button"
        // biome-ignore lint/a11y/noAutofocus: the prompt appears on the user's own delete action
        autoFocus
        onClick={() => onAnswer(true)}
        className={cn(b, 'bg-danger-soft text-danger-text hover:brightness-95')}
      >
        {plural ? 'Delete sketches too' : 'Delete sketch too'}
      </button>
      <button
        type="button"
        onClick={() => onAnswer(false)}
        className={cn(b, 'bg-surface-3 text-fg hover:bg-border')}
      >
        {plural ? 'Keep sketches' : 'Keep sketch'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className={cn(b, 'text-fg-muted hover:bg-surface-3 hover:text-fg')}
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * "Take Fillet 3 out of Mounting?" asked before a drop that removes a feature from a folder.
 * Inline and non-modal (CLAUDE.md); Escape or "Keep it in" leaves everything as it was.
 */
export function LeavePrompt({
  feature,
  folder,
  touch,
  onConfirm,
  onCancel,
}: {
  feature: string;
  folder: string;
  touch: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const b = btn(touch);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not a fieldset
    <div
      role="group"
      aria-label={`Take ${feature} out of ${folder}?`}
      data-testid="leave-prompt"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="mx-2 mb-2 flex flex-wrap items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 p-2"
    >
      <p className="w-full text-2xs leading-4 text-fg">
        Take {feature} out of {folder}?
      </p>
      <button
        type="button"
        // biome-ignore lint/a11y/noAutofocus: the prompt appears on the user's own drop
        autoFocus
        onClick={onConfirm}
        className={cn(b, 'bg-accent text-accent-fg hover:brightness-95')}
      >
        Take it out
      </button>
      <button
        type="button"
        onClick={onCancel}
        className={cn(b, 'bg-surface-3 text-fg hover:bg-border')}
      >
        Keep it in
      </button>
    </div>
  );
}

/** A one-line result with an Undo, shown after a drop changed folder membership. */
export function UndoLine({
  text,
  touch,
  onUndo,
  onDismiss,
}: {
  text: string;
  touch: boolean;
  onUndo?: (() => void) | undefined;
  onDismiss(): void;
}) {
  const b = btn(touch);
  return (
    <div
      role="status"
      data-testid="undo-line"
      className="mx-2 mb-2 flex flex-wrap items-center gap-1.5 rounded-[9px] bg-surface-2 px-2.5 py-1.5"
    >
      <p className="min-w-0 flex-1 text-2xs leading-4 text-fg">{text}</p>
      {onUndo ? (
        <button
          type="button"
          onClick={() => {
            onUndo();
            onDismiss();
          }}
          className={cn(b, 'bg-surface-3 text-fg hover:bg-border')}
        >
          Undo
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className={cn(b, 'text-fg-muted hover:bg-surface-3 hover:text-fg')}
      >
        Dismiss
      </button>
    </div>
  );
}
