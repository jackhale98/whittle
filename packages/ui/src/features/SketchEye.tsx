import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../components/primitives';
import type { SketchVisibilityMode } from '../logic/treeFolders';

export interface SketchEyeProps {
  name: string;
  /** Whether the sketch shows in the viewport right now (explicit setting or the automatic rule). */
  shown: boolean;
  /** `auto` (or absent) = follows the consumed-sketch default: marked with a small dot. */
  visibility?: SketchVisibilityMode | undefined;
  touch: boolean;
  onToggle(): void;
}

/**
 * The per-sketch eye (M3.6). A click writes an explicit shown / hidden (the opposite of the
 * current state); a small dot marks a sketch still on "auto", and the row menu resets to auto.
 * The label names the action: "Show Sketch 2" / "Hide Sketch 2".
 */
export function SketchEye({ name, shown, visibility, touch, onToggle }: SketchEyeProps) {
  const auto = visibility === undefined || visibility === 'auto';
  const Icon = shown ? Eye : EyeOff;
  return (
    <button
      type="button"
      tabIndex={-1}
      data-testid="sketch-eye"
      data-shown={shown}
      data-visibility={auto ? 'auto' : visibility}
      aria-label={`${shown ? 'Hide' : 'Show'} ${name}`}
      title={`${shown ? 'Hide' : 'Show'} ${name}${auto ? ' (automatic)' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-[7px] hover:bg-surface-3 hover:text-fg',
        touch ? 'size-11' : 'mt-0.5 size-7',
        shown ? 'text-accent-text' : 'text-fg-subtle',
      )}
    >
      <Icon className="size-4" strokeWidth={1.7} aria-hidden />
      {auto ? (
        <span
          aria-hidden
          data-testid="auto-marker"
          className="absolute right-1 bottom-1 size-1.5 rounded-full border border-surface bg-fg-subtle"
        />
      ) : null}
    </button>
  );
}
