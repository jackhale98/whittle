import type { ComponentType, ReactNode } from 'react';
import { cn } from '../components/primitives';

/** An icon, a title and a line: what a drawing panel says when it has nothing to list. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-8 text-center', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-panel bg-surface-2 text-fg-muted">
        <Icon className="size-5" strokeWidth={1.5} />
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {children ? <div className="mt-1 text-ui text-fg-muted">{children}</div> : null}
    </div>
  );
}
