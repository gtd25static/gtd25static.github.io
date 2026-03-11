import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ensureDefaults } from './db';
import { useKeyboard } from './hooks/use-keyboard';
import { useTheme } from './components/settings/ThemeSettings';
import { checkRecurringTasks } from './hooks/use-recurring';
import { SpecialListProvider } from './hooks/use-special-list';
import { SyncProvider } from './sync/use-sync';

export default function App() {
  useEffect(() => {
    ensureDefaults();
  }, []);

  // Check recurring tasks on startup and every 60s
  useEffect(() => {
    checkRecurringTasks();
    const interval = setInterval(checkRecurringTasks, 60_000);
    return () => clearInterval(interval);
  }, []);

  useTheme();
  useKeyboard();

  return (
    <ErrorBoundary>
      <SyncProvider>
        <SpecialListProvider>
          <AppShell />
        </SpecialListProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
