// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetDb } from '../helpers/db-helpers';
import { ThemeSettings, useTheme } from '../../components/settings/ThemeSettings';
import { importData } from '../../sync/sync-engine';

const isDark = () => document.documentElement.classList.contains('dark');

// Stands in for App's own useTheme(), which applies the theme at boot.
function AppTheme() {
  const { theme } = useTheme();
  return <span data-testid="app-theme">{theme}</span>;
}

beforeEach(async () => {
  await resetDb();
  localStorage.removeItem('gtd25-theme');
  document.documentElement.classList.remove('dark');
});

describe('theme', { timeout: 15_000 }, () => {
  // An imported backup's theme was written to storage but only applied after a
  // reload (the same for a sync that brought one).
  it('an import applies its theme at once, and the settings show it', async () => {
    render(<><AppTheme /><ThemeSettings /></>);
    await importData({ taskLists: [], tasks: [], subtasks: [], settings: { theme: 'dark' } });

    expect(localStorage.getItem('gtd25-theme')).toBe('dark');
    expect(isDark()).toBe(true);
    await waitFor(() => expect(screen.getByTestId('app-theme')).toHaveTextContent('dark'));
    expect(screen.getByRole('button', { name: 'Dark' }).className).toContain('bg-accent-100');
  });

  // Each useTheme() kept its own copy: App's stayed on "system" after a pick in
  // Settings, and re-applied the OS scheme over it when that changed.
  it('a pick in Settings reaches every user of the theme', async () => {
    const user = userEvent.setup();
    render(<><AppTheme /><ThemeSettings /></>);
    await user.click(screen.getByRole('button', { name: 'Dark' }));

    expect(isDark()).toBe(true);
    expect(screen.getByTestId('app-theme')).toHaveTextContent('dark');
  });

  it('ignores a theme value it does not know', async () => {
    await importData({ taskLists: [], tasks: [], subtasks: [], settings: { theme: 'neon' as 'dark' } });
    expect(localStorage.getItem('gtd25-theme')).toBeNull();
    expect(isDark()).toBe(false);
  });
});
