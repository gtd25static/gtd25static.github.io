import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { installGlobalErrorHandlers, requestPersistentStorage } from './lib/diagnostics';
import { retryPendingWipe } from './lib/panic-wipe';
import { startCrossTabLock } from './db/vault';
import { onTabSignal } from './lib/tab-channel';

// Capture uncaught errors for the in-app diagnostics log, and ask the browser to
// persist storage so IndexedDB isn't silently evicted (data-loss prevention).
installGlobalErrorHandlers();
void requestPersistentStorage();

// Lock this tab when any other tab locks or wipes — the idle timer, the hotkey
// and lock-when-hidden are all per tab, so app-wide locking has to be told.
startCrossTabLock();
// A wipe additionally reloads us: it drops this tab's open IndexedDB connection,
// which is what would otherwise block the deletion, and the boot-time
// retryPendingWipe below finishes the job if it is still pending.
onTabSignal((signal) => {
  if (signal.type === 'wipe') {
    try { window.location.reload(); } catch { /* environment without a real location */ }
  }
});

// Finish any wipe whose IndexedDB deletion was blocked (e.g. by a second tab)
// BEFORE the app opens the database again; renders immediately when none is pending.
void retryPendingWipe().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
