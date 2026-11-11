import { CircleAlert, CircleCheck, CircleDashed, TriangleAlert } from 'lucide-react';
import { cn } from '../components/primitives';
import { CONFIG_STATUS_LABEL, type ConfigStatus } from './model';

// Split from ConfigurationPill.tsx: the inspector shows this label on the first paint, while the
// pill itself is its own lazy chunk (ADR-089).

const STATUS_ICON = {
  ok: CircleCheck,
  failed: CircleAlert,
  attention: TriangleAlert,
  unbuilt: CircleDashed,
} as const;

const STATUS_TONE: Record<ConfigStatus, string> = {
  ok: 'text-success-text',
  failed: 'text-danger-text',
  attention: 'text-warning-text',
  unbuilt: 'text-fg-muted',
};

/** Status glyph plus its words (never colour alone). */
export function ConfigStatusLabel({
  status,
  message,
  className,
}: {
  status: ConfigStatus;
  message?: string | undefined;
  className?: string;
}) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      title={message}
      className={cn('inline-flex items-center gap-1 text-2xs', STATUS_TONE[status], className)}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{CONFIG_STATUS_LABEL[status]}</span>
    </span>
  );
}
