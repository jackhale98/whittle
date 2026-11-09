import type { Id } from '@wren-cad/contracts';
import { cn } from '../components/primitives';
import type { AttentionSentence } from './attentionMessage';

export interface CauseSentenceProps {
  sentence: AttentionSentence;
  /** Called with the cause feature's id; the app selects it (and may scroll the tree to it). */
  onSelectFeature?(id: Id): void;
  /** Inside a tree row the button is not a tab stop (the inspector has the real one). */
  inTree?: boolean;
  className?: string;
}

/**
 * "Fillet 2 lost its edge because [Extrude 1] changed." The cause's name is a button that selects
 * that feature. It is plain text when the feature is gone (deleted) or no handler is given.
 */
export function CauseSentence({
  sentence,
  onSelectFeature,
  inTree,
  className,
}: CauseSentenceProps) {
  const { cause } = sentence;
  const canSelect = cause.selectable && !!onSelectFeature;
  return (
    <span data-testid="attention-cause" className={className}>
      {sentence.before}
      {canSelect ? (
        <button
          type="button"
          data-cause-feature={cause.featureId}
          // In a tree row (role treeitem) a second tab stop would nest interactive controls.
          {...(inTree ? { tabIndex: -1 } : {})}
          aria-label={`Select ${cause.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onSelectFeature?.(cause.featureId);
          }}
          className={cn(
            'inline rounded-[4px] px-0.5 font-semibold underline decoration-current/50 underline-offset-2 outline-none',
            'hover:bg-black/5 hover:decoration-current focus-visible:outline-2 focus-visible:outline-accent dark:hover:bg-white/10',
          )}
        >
          {cause.name}
        </button>
      ) : (
        <span className="font-semibold">{cause.name}</span>
      )}
      {sentence.after}
    </span>
  );
}
