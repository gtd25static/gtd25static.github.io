import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ensureDefaults } from './db';
import { useKeyboard } from './hooks/use-keyboard';
import { useTheme } from './components/settings/ThemeSettings';

export default function App() {
  useEffect(() => {
    ensureDefaults();
  }, []);

  useTheme();
  useKeyboard();

  return <AppShell />;
}
