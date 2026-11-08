import { Download } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { FloatingLayer } from '../components/floating';
import { Button, type ButtonProps } from '../components/primitives';
import type { ExportFormProps } from './ExportForm';

const ExportForm = lazy(() => import('./ExportForm'));

export type { ExportFormProps };

export interface ExportMenuProps extends Omit<ExportFormProps, 'size' | 'className'> {
  /** Trigger look; defaults match the desktop top bar. */
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}

/**
 * Non-modal Export popover anchored to a top-bar button. The form is code-split and only fetched
 * the first time the menu opens.
 */
export function ExportMenu({
  variant = 'secondary',
  size = 'md',
  className,
  onExport,
  ...form
}: ExportMenuProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={setAnchor}
        variant={variant}
        size={size}
        aria-haspopup="dialog"
        data-testid="export-trigger"
        aria-expanded={open}
        icon={<Download className={size === 'touch' ? 'size-[18px]' : 'size-4'} />}
        onClick={() => setOpen((o) => !o)}
        className={className}
      >
        Export
      </Button>
      {open && anchor ? (
        <FloatingLayer
          anchor={anchor}
          placement="bottom-end"
          label="Export"
          testId="export-popover"
          onDismiss={() => setOpen(false)}
          className="w-[min(320px,calc(100vw-16px))] p-3"
        >
          <Suspense fallback={<p className="p-4 text-center text-ui text-fg-muted">Loading…</p>}>
            <ExportForm
              {...form}
              size={size}
              onExport={(r) => {
                onExport(r);
                setOpen(false);
              }}
            />
          </Suspense>
        </FloatingLayer>
      ) : null}
    </>
  );
}

/** The same form inline (phone sheet). Lazy. */
export function ExportPanel(props: ExportFormProps) {
  return (
    <Suspense fallback={<p className="p-6 text-center text-ui text-fg-muted">Loading…</p>}>
      <ExportForm {...props} />
    </Suspense>
  );
}
