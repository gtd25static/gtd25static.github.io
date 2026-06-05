// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { DiagnosticsSettings } from '../../components/settings/DiagnosticsSettings';
import { recordError, clearErrorLog } from '../../lib/diagnostics';

beforeEach(() => clearErrorLog());
afterEach(() => clearErrorLog());

describe('DiagnosticsSettings panel', () => {
  it('shows build info, capabilities, and captured errors', async () => {
    recordError('test-context', new Error('a captured failure'));
    render(<DiagnosticsSettings />);

    expect(screen.getByText(/commit/i)).toBeInTheDocument();
    expect(screen.getByText('IndexedDB')).toBeInTheDocument();
    expect(screen.getByText('a captured failure')).toBeInTheDocument();
    expect(screen.getByText('test-context')).toBeInTheDocument();
    expect(screen.getByText(/Recent errors \(1\)/)).toBeInTheDocument();
  });

  it('clears the error log from the panel', async () => {
    const user = userEvent.setup();
    recordError('ctx', new Error('boom'));
    render(<DiagnosticsSettings />);
    expect(screen.getByText('boom')).toBeInTheDocument();

    await act(async () => { await user.click(screen.getByRole('button', { name: /clear/i })); });
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    expect(screen.getByText(/No errors captured/)).toBeInTheDocument();
  });
});
