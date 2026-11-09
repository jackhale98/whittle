/**
 * In-app welcome (first launch, the library's empty state, ⌘K "Welcome / samples"): a calm,
 * non-modal card — the one-line pitch, Open the demo bracket, the 60-second tour, New part,
 * Install app, and links to the source and the licence. The app keeps working behind it.
 */

import { BirdMark, Button, cn, IconButton } from '@wren-cad/ui';
import {
  Download,
  ExternalLink,
  FolderOpen,
  GraduationCap,
  Plus,
  Share,
  Sparkles,
  X,
} from 'lucide-react';
import type { Workbench } from '../app/workbench';
import { promptInstall, useInstallState } from '../platform/install';

export const REPO_URL = 'https://github.com/jackhale98/wren-cad';
export const LICENSE_URL = 'https://github.com/jackhale98/wren-cad/blob/main/LICENSE';

export function WelcomeContent({ wb, compact }: { wb: Workbench; compact?: boolean }) {
  const install = useInstallState();
  // 44 px targets on touch tiers (ADR-012 item 6).
  const size = wb.tier === 'desktop' ? 'md' : 'touch';
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'gap-3' : 'gap-4')}>
      <BirdMark className={compact ? 'size-14' : 'size-20'} />
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Welcome to Wren</h2>
        <p className="mt-1 max-w-[34ch] text-ui text-fg-muted">
          Free, open-source parametric CAD that runs on your device — works offline.
        </p>
      </div>
      <div className="flex w-full max-w-72 flex-col gap-2">
        <Button
          size={size}
          variant="primary"
          icon={<Sparkles className="size-4" />}
          onClick={() => void wb.openDemo()}
          data-testid="open-demo"
        >
          Open the demo bracket
        </Button>
        <Button
          size={size}
          variant="secondary"
          icon={<GraduationCap className="size-4" />}
          onClick={() => wb.requestTour()}
          data-testid="take-tour"
        >
          Take the 60-second tour
        </Button>
        <Button
          size={size}
          variant="secondary"
          icon={<Plus className="size-4" />}
          onClick={() => void wb.newDocument()}
        >
          New part
        </Button>
        <Button
          size={size}
          variant="secondary"
          icon={<FolderOpen className="size-4" />}
          onClick={() => void wb.openFromDisk('new')}
          data-testid="welcome-open-file"
        >
          Open or import a file…
        </Button>
        {install.kind === 'prompt' ? (
          <Button
            size={size}
            variant="secondary"
            icon={<Download className="size-4" />}
            onClick={() => void promptInstall()}
            data-testid="install-app"
          >
            Install app
          </Button>
        ) : null}
        {install.kind === 'ios-hint' ? (
          <p className="flex items-center justify-center gap-1.5 text-2xs text-fg-muted">
            Install: tap <Share className="size-3.5" aria-label="Share" /> then “Add to Home
            Screen”.
          </p>
        ) : null}
      </div>
      <p className="flex items-center gap-3 text-2xs text-fg-muted">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-fg"
        >
          Source on GitHub <ExternalLink className="size-3" aria-hidden />
        </a>
        <span aria-hidden>·</span>
        <a href={LICENSE_URL} target="_blank" rel="noreferrer" className="hover:text-fg">
          GPL-3.0 licence
        </a>
      </p>
    </div>
  );
}

export default function Welcome({ wb }: { wb: Workbench }) {
  return (
    <section
      aria-label="Welcome"
      data-testid="welcome"
      className="w-card pointer-events-auto absolute top-1/2 left-1/2 w-[min(400px,calc(100%-24px))] -translate-x-1/2 -translate-y-1/2 rounded-[18px] px-6 pt-7 pb-5 shadow-float"
    >
      <IconButton
        label="Close welcome"
        size={wb.tier === 'desktop' ? 'md' : 'touch'}
        icon={<X className="size-4" />}
        onClick={() => wb.patchUi({ welcome: false })}
        className={wb.tier === 'desktop' ? 'absolute top-2.5 right-2.5' : 'absolute top-1 right-1'}
      />
      <WelcomeContent wb={wb} />
    </section>
  );
}
