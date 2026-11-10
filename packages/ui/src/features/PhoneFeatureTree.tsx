import type { Id } from '@wren-cad/contracts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { m } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../components/primitives';
import { buildSteps, type Step, stepAt, stepLabel } from '../logic/treeSteps';
import { useSpring } from '../motion';
import { FeatureTree, type FeatureTreeProps } from './FeatureTree';

/** The tree props a phone passes through; editing handlers are not accepted (review only). */
export type PhoneTreeData = Pick<
  FeatureTreeProps,
  | 'features'
  | 'statuses'
  | 'rollbackIndex'
  | 'selectedId'
  | 'lineage'
  | 'onSelect'
  | 'folders'
  | 'collapsedFolders'
  | 'onCollapsedFoldersChange'
  | 'nestSketches'
  | 'onSketchVisibility'
>;

export interface PhoneFeatureTreeProps {
  tree: PhoneTreeData;
  /**
   * The previewed rollback position (what `setRollback` takes: the model after the first
   * `previewIndex` features), or null / undefined when not previewing. The app regenerates a copy of
   * the document at this position and shows it; the component only drives it.
   */
  previewIndex?: number | null;
  /** The user stepped or scrubbed: preview this rollback position. */
  onPreview(index: number): void;
  /** "Keep this rollback": write the previewed position as the real rollback. */
  onKeep(): void;
  /** Leave the preview and restore the full model. Also called when the tab closes mid-preview. */
  onExit(): void;
  className?: string;
}

/**
 * The phone's feature tree with a step-through bar (M3.6): Previous / Next buttons and a scrubber
 * over the feature positions, with the step named ("3 of 12 · Fillet 2"). The bar sits at the
 * bottom of the sheet, in thumb reach; the tree above is read-only apart from sketch visibility.
 *
 * Folders are shown, and stepping goes through their members. A **collapsed** folder steps as one
 * unit (see `buildSteps`); open it to step inside. A feature and its nested sketch are one step.
 * Leaving the tab while previewing calls `onExit`, so the full model comes back unless the user
 * pressed "Keep this rollback".
 */
export function PhoneFeatureTree({
  tree,
  previewIndex = null,
  onPreview,
  onKeep,
  onExit,
  className,
}: PhoneFeatureTreeProps) {
  const [localCollapsed, setLocalCollapsed] = useState<readonly Id[]>([]);
  const collapsedIds = tree.collapsedFolders ?? localCollapsed;
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const steps = useMemo(
    () => buildSteps(tree.features, tree.folders, collapsed, tree.nestSketches ?? true),
    [tree.features, tree.folders, collapsed, tree.nestSketches],
  );
  const n = tree.features.length;
  const previewing = previewIndex !== null;
  const shown = previewIndex ?? tree.rollbackIndex ?? n;
  const at = stepAt(steps, shown);

  const go = useCallback(
    (to: number) => {
      const s = steps[Math.max(0, Math.min(steps.length - 1, to))];
      if (s) onPreview(s.index);
    },
    [steps, onPreview],
  );

  // Leaving while a preview is open restores the model (the user did not keep it). Deferred one
  // tick so React StrictMode's mount / unmount / mount probe does not end a preview that is only
  // being re-mounted.
  const live = useRef({ previewing, onExit });
  live.current = { previewing, onExit };
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(leaving.current);
    return () => {
      leaving.current = setTimeout(() => {
        if (live.current.previewing) live.current.onExit();
      }, 0);
    };
  }, []);

  return (
    <div className={cn('flex min-h-full flex-col', className)} data-testid="phone-feature-tree">
      <FeatureTree
        features={tree.features}
        {...(tree.statuses ? { statuses: tree.statuses } : {})}
        rollbackIndex={shown}
        selectedId={tree.selectedId ?? null}
        {...(tree.lineage ? { lineage: tree.lineage } : {})}
        {...(tree.onSelect ? { onSelect: tree.onSelect } : {})}
        {...(tree.folders ? { folders: tree.folders } : {})}
        collapsedFolders={collapsedIds}
        onCollapsedFoldersChange={(ids) => {
          setLocalCollapsed(ids);
          tree.onCollapsedFoldersChange?.(ids);
        }}
        {...(tree.nestSketches !== undefined ? { nestSketches: tree.nestSketches } : {})}
        {...(tree.onSketchVisibility ? { onSketchVisibility: tree.onSketchVisibility } : {})}
        onRollback={(i) => onPreview(i)}
        density="touch"
      />
      <FeatureStepper
        steps={steps}
        at={at}
        previewing={previewing}
        onStep={go}
        onKeep={onKeep}
        onExit={onExit}
      />
    </div>
  );
}

export interface FeatureStepperProps {
  steps: readonly Step[];
  /** Current step, 0-based. */
  at: number;
  previewing: boolean;
  onStep(at: number): void;
  onKeep(): void;
  onExit(): void;
}

/** Previous / Next, a scrubber and the step label; "Keep" and "Back to full model" while previewing. */
export function FeatureStepper({
  steps,
  at,
  previewing,
  onStep,
  onKeep,
  onExit,
}: FeatureStepperProps) {
  const standard = useSpring('standard');
  const fast = useSpring('fast');
  const empty = steps.length === 0;
  const label = stepLabel(steps, at);
  const btn =
    'flex h-11 min-w-11 items-center justify-center rounded-control bg-surface-2 text-fg transition-colors duration-fast enabled:active:bg-surface-3 disabled:opacity-40';
  return (
    <section
      aria-label="Step through features"
      data-testid="feature-stepper"
      className="sticky bottom-0 z-[4] mt-auto border-t border-border bg-surface px-3 pt-2 pb-[max(0.5rem,var(--safe-bottom,0px))]"
    >
      <m.p
        key={label}
        initial={{ opacity: 0.4 }}
        animate={{ opacity: 1 }}
        transition={fast}
        aria-live="polite"
        data-testid="step-label"
        className="mb-1 text-ui font-medium text-fg"
      >
        {label}
      </m.p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous feature"
          disabled={empty || at <= 0}
          onClick={() => onStep(at - 1)}
          className={btn}
        >
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <input
          type="range"
          aria-label="Feature position"
          aria-valuetext={label}
          min={0}
          max={Math.max(0, steps.length - 1)}
          step={1}
          value={at}
          disabled={empty}
          onChange={(e) => onStep(Number(e.currentTarget.value))}
          data-testid="step-scrubber"
          className="h-11 min-w-0 flex-1 cursor-pointer touch-none accent-[var(--color-accent)]"
        />
        <button
          type="button"
          aria-label="Next feature"
          disabled={empty || at >= steps.length - 1}
          onClick={() => onStep(at + 1)}
          className={btn}
        >
          <ChevronRight className="size-5" aria-hidden />
        </button>
      </div>
      {previewing ? (
        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={standard}
          className="mt-2 flex flex-wrap gap-2"
          data-testid="step-actions"
        >
          <button
            type="button"
            onClick={onKeep}
            className="h-11 rounded-control bg-accent px-4 text-ui font-medium whitespace-nowrap text-accent-fg active:brightness-95"
          >
            Keep this rollback
          </button>
          <button
            type="button"
            onClick={onExit}
            className="h-11 rounded-control bg-surface-3 px-4 text-ui font-medium whitespace-nowrap text-fg active:bg-border"
          >
            Back to full model
          </button>
        </m.div>
      ) : null}
    </section>
  );
}
