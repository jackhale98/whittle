import '@whittle/ui/styles.css';
import './index.css';
import { initTheme } from '@whittle/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { firstBodyRendered } from './app/timing';
import { installTestHooks } from './platform/diagnostics';
import { initServiceWorker } from './platform/sw-register';

// Theme before first paint (no flash), then platform: test hooks and the service worker (settles
// cross-origin isolation, may reload once on the very first visit).
initTheme();
installTestHooks({ firstBodyRendered });
void initServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
