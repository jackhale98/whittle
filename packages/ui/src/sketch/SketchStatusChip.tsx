import { CircleAlert, CircleCheck, CircleDashed } from 'lucide-react';
import { cn } from '../components/primitives';

export interface SketchStatusChipProps {
  status: 'solved' | 'conflicting' | 'failed';
  /** Remaining degrees of freedom (`SketchSolveResult.dof`). */
  dof: number;
  /** Count of redundant (consistent, unnecessary) constraints. */
  redundant?: number;
  /** When provided and the sketch is conflicting, the chip is a button that opens the conflict list. */
  onClick?(): void;
  className?: string;
}

export function describeSketchStatus(
  status: SketchStatusChipProps['status'],
  dof: number,
): { label: string; tone: 'under' | 'full' | 'over' | 'failed' } {
  if (status === 'conflicting') return { label: 'Over-constrained', tone: 'over' };
  if (status === 'failed') return { label: 'Solver failed', tone: 'failed' };
  if (dof <= 0) return { label: 'Fully constrained', tone: 'full' };
  return { label: `${dof} ${dof === 1 ? 'degree' : 'degrees'} of freedom`, tone: 'under' };
}

const toneClass = {
  under: 'text-under-constrained',
  full: 'text-fully-constrained',
  over: 'text-danger',
  failed: 'text-warning',
} as const;

/** Sketch solve state: blue = free, near-black = fixed, red = over-constrained (PLAN 9.5). */
export function SketchStatusChip({
  status,
  dof,
  redundant = 0,
  onClick,
  className,
}: SketchStatusChipProps) {
  const { label, tone } = describeSketchStatus(status, dof);
  const Icon = tone === 'full' ? CircleCheck : tone === 'under' ? CircleDashed : CircleAlert;
  const body = (
    <>
      <Icon className={cn('size-4 shrink-0', toneClass[tone])} aria-hidden />
      <span className="tnum font-medium">{label}</span>
      {redundant > 0 ? (
        <>
          {' '}
          <span className="tnum text-fg-muted">· {redundant} redundant</span>
        </>
      ) : null}
    </>
  );
  const cls = cn(
    'w-panel pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-fg',
    className,
  );
  if (onClick && tone === 'over') {
    return (
      <button
        type="button"
        onClick={onClick}
        data-state={tone}
        className={cn(cls, 'hover:brightness-95')}
      >
        {body}
      </button>
    );
  }
  return (
    <div role="status" data-state={tone} data-testid="sketch-status" className={cls}>
      {body}
    </div>
  );
}
