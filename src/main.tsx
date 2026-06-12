import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { installGlobalErrorHandlers, requestPersistentStorage } from './lib/diagnostics';
import { retryPendingWipe } from './lib/panic-wipe';

// Capture uncaught errors for the in-app diagnostics log, and ask the browser to
// persist storage so IndexedDB isn't silently evicted (data-loss prevention).
installGlobalErrorHandlers();
void requestPersistentStorage();

// Finish any wipe whose IndexedDB deletion was blocked (e.g. by a second tab)
// BEFORE the app opens the database again; renders immediately when none is pending.
void retryPendingWipe().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
