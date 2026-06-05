import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { installGlobalErrorHandlers, requestPersistentStorage } from './lib/diagnostics';

// Capture uncaught errors for the in-app diagnostics log, and ask the browser to
// persist storage so IndexedDB isn't silently evicted (data-loss prevention).
installGlobalErrorHandlers();
void requestPersistentStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
