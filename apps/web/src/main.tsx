import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { PlaceholderShell } from './PlaceholderShell';
import { installTestHooks } from './platform/diagnostics';
import { initServiceWorker } from './platform/sw-register';

// Platform first: test hooks, then the service worker (settles isolation, may reload once).
installTestHooks();
void initServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <PlaceholderShell />
  </StrictMode>,
);
