import '@wren-cad/ui/styles.css';
import './index.css';
import { initTheme, preloadShell } from '@wren-cad/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { firstBodyRendered } from './app/timing';
import { Workbench } from './app/workbench';
import { getDiagnostics, installTestHooks } from './platform/diagnostics';
import { watchInstallPrompt } from './platform/install';
import { installPageGuards } from './platform/page-guards';
import { initServiceWorker, keepServiceWorkerFresh } from './platform/sw-register';

// Theme before first paint (no flash), then platform: test hooks and the service worker (settles
// cross-origin isolation, may reload once on the very first visit).
initTheme();
installPageGuards();
watchInstallPrompt();
const workbench = new Workbench();
installTestHooks({ firstBodyRendered });
// The kernel streams and compiles in its worker while the shell paints, and the last document (with
// its mesh cache) is read from the library meanwhile, so it renders before the kernel is ready.
workbench.bootKernelIfEager(); // phones: on the first edit or measurement
workbench.prefetchInitialDocument();
// App-level test hooks (E2E only; not an extension API).
(window as unknown as { __wrenApp?: unknown }).__wrenApp = workbench.testHooks();
void initServiceWorker();
keepServiceWorkerFresh();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
// Phones and tablets load their shell chunk first (one request, precached after the first visit) so
// the first render is the real chrome, not a fallback. Desktop renders at once.
const render = () =>
  createRoot(root).render(
    <StrictMode>
      <App wb={workbench} />
    </StrictMode>,
  );
const tier = getDiagnostics().tier;
if (tier === 'desktop') render();
else void preloadShell(tier).then(render, render);
