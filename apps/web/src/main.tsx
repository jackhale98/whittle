import '@whittle/ui/styles.css';
import './index.css';
import { initTheme } from '@whittle/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { firstBodyRendered } from './app/timing';
import { Workbench } from './app/workbench';
import { installTestHooks } from './platform/diagnostics';
import { watchInstallPrompt } from './platform/install';
import { installPageGuards } from './platform/page-guards';
import { initServiceWorker, keepServiceWorkerFresh } from './platform/sw-register';

installPageGuards();

// Theme before first paint (no flash), then platform: test hooks and the service worker (settles
// cross-origin isolation, may reload once on the very first visit).
initTheme();
watchInstallPrompt();
const workbench = new Workbench();
installTestHooks({ firstBodyRendered });
// The kernel streams and compiles in its worker while the shell paints, and the last document (with
// its mesh cache) is read from the library meanwhile, so it renders before the kernel is ready.
workbench.bootKernel();
workbench.prefetchInitialDocument();
// App-level test hooks (E2E only; not an extension API).
(window as unknown as { __whittleApp?: unknown }).__whittleApp = workbench.testHooks();
void initServiceWorker();
keepServiceWorkerFresh();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App wb={workbench} />
  </StrictMode>,
);
