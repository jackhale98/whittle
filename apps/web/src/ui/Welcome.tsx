/**
 * In-app welcome (first launch, the library's empty state, ⌘K "Welcome / samples"): a calm,
 * non-modal card — the one-line pitch, Open the demo bracket, New part, Install app, and links to
 * the source and the licence. The app keeps working behind it.
 */

import { Button, cn, IconButton } from '@whittle/ui';
import { Download, ExternalLink, FolderOpen, Plus, Share, Sparkles, X } from 'lucide-react';
import type { Workbench } from '../app/workbench';
import { promptInstall, useInstallState } from '../platform/install';

export const REPO_URL = 'https://github.com/jackhale98/whittle';
export const LICENSE_URL = 'https://github.com/jackhale98/whittle/blob/main/LICENSE';

export function WelcomeContent({ wb, compact }: { wb: Workbench; compact?: boolean }) {
  const install = useInstallState();
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'gap-3' : 'gap-4')}>
      <svg viewBox="0 0 24 24" className="size-11" aria-hidden="true">
        <rect width="24" height="24" rx="7" className="fill-accent" />
        <path d="M7 7h6.2L17 10.8V17H7z" className="fill-accent-fg" fillOpacity="0.96" />
        <path d="M13.2 7v3.8H17" fill="none" strokeWidth="1.2" className="stroke-accent" />
      </svg>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Welcome to Whittle</h2>
        <p className="mt-1 max-w-[34ch] text-ui text-fg-muted">
          Free, open-source parametric CAD that runs on your device — works offline.
        </p>
      </div>
      <div className="flex w-full max-w-72 flex-col gap-2">
        <Button
          variant="primary"
          icon={<Sparkles className="size-4" />}
          onClick={() => void wb.openDemo()}
          data-testid="open-demo"
        >
          Open the demo bracket
        </Button>
        <Button
          variant="secondary"
          icon={<Plus className="size-4" />}
          onClick={() => void wb.newDocument()}
        >
          New part
        </Button>
        <Button
          variant="secondary"
          icon={<FolderOpen className="size-4" />}
          onClick={() => void wb.openFromDisk('new')}
          data-testid="welcome-open-file"
        >
          Open or import a file…
        </Button>
        {install.kind === 'prompt' ? (
          <Button
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
        icon={<X className="size-4" />}
        onClick={() => wb.patchUi({ welcome: false })}
        className="absolute top-2.5 right-2.5"
      />
      <WelcomeContent wb={wb} />
    </section>
  );
}
