import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { installGlobalErrorHandlers, requestPersistentStorage } from './lib/diagnostics';
import { retryPendingWipe } from './lib/panic-wipe';
import { startCrossTabLock, reconcileParanoidFlag } from './db/vault';
import { onTabSignal } from './lib/tab-channel';
import { startForgettingSessionOnLock } from './lib/forget-on-lock';
import { flushPendingClipboardClear } from './lib/clipboard-hygiene';

// Capture uncaught errors for the in-app diagnostics log, and ask the browser to
// persist storage so IndexedDB isn't silently evicted (data-loss prevention).
installGlobalErrorHandlers();
void requestPersistentStorage();

// Lock this tab when any other tab locks or wipes — the idle timer, the hotkey
// and lock-when-hidden are all per tab, so app-wide locking has to be told.
startCrossTabLock();
// Locking also forgets what this tab held in memory: the search text, a pending
// nudge, the sync session (see lib/forget-on-lock).
startForgettingSessionOnLock();
// A pending clipboard auto-clear is a timer in this page, so closing the tab
// first left the copied content sitting on the clipboard. `pagehide` catches the
// backgrounded/frozen case; a real close usually kills us first (documented).
window.addEventListener('pagehide', () => flushPendingClipboardClear());
// A wipe additionally reloads us: it drops this tab's open IndexedDB connection,
// which is what would otherwise block the deletion, and the boot-time
// retryPendingWipe below finishes the job if it is still pending. A reload signal
// means the vault was re-keyed underneath this tab (a secondary-passphrase unlock
// in another one): nothing it still holds in memory may outlive that.
onTabSignal((signal) => {
  if (signal.type === 'wipe' || signal.type === 'reload') {
    try { window.location.reload(); } catch { /* environment without a real location */ }
  }
});

// Finish any wipe whose IndexedDB deletion was blocked (e.g. by a second tab)
// BEFORE the app opens the database again; renders immediately when none is pending.
// Then make the Paranoid flag agree with the vault, which a crash in the middle
// of an enable or disable can leave out of step — before the first render, so
// the lock screen (or its absence) is right from the first paint.
void retryPendingWipe().finally(() => reconcileParanoidFlag()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
