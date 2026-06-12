// @vitest-environment jsdom
//
// Pins that single-letter bindings are BARE-key only: Ctrl/Cmd/Alt chords must
// pass through to the browser untouched. Regression: `case 'v'` used to
// preventDefault Ctrl+V's keydown, which cancels the native paste action — so
// no `paste` event ever fired and the Shared Folder's paste-to-upload was dead.
import { act, render } from '@testing-library/react';
import '../setup-component';
import { useKeyboard } from '../../hooks/use-keyboard';
import { useAppState } from '../../stores/app-state';

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => [] }));
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../hooks/use-tasks', () => ({ setTaskStatus: vi.fn(), updateTask: vi.fn(), restoreTask: vi.fn() }));
vi.mock('../../hooks/use-subtasks', () => ({ setSubtaskStatus: vi.fn() }));
vi.mock('../../hooks/use-follow-ups', () => ({ isInCooldown: vi.fn(() => false) }));
vi.mock('../../hooks/use-bulk-operations', () => ({ deleteTasksBatch: vi.fn() }));
vi.mock('../../lib/task-sort', () => ({ sortTasksForDisplay: () => [], sortFollowUpsForDisplay: () => [] }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => false) }));

function Harness() {
  useKeyboard();
  return null;
}

function fireKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

beforeEach(() => {
  useAppState.setState({
    bulkMode: false,
    focusZone: 'main',
    quickCaptureOpen: false,
    settingsOpen: false,
    trashOpen: false,
    weeklyReviewOpen: false,
  });
});

describe('useKeyboard — modifier chords pass through to the browser', () => {
  it('leaves Ctrl+V alone so the native paste event can fire', () => {
    render(<Harness />);
    const e = fireKey('v', { ctrlKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(useAppState.getState().bulkMode).toBe(false); // no accidental bulk toggle
  });

  it('leaves Cmd+V (macOS) alone too', () => {
    render(<Harness />);
    const e = fireKey('v', { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(useAppState.getState().bulkMode).toBe(false);
  });

  it('leaves other browser chords (Ctrl+R, Ctrl+L, Ctrl+D, Ctrl+S) alone', () => {
    render(<Harness />);
    for (const key of ['r', 'l', 'd', 's']) {
      const e = fireKey(key, { ctrlKey: true });
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it('bare v still toggles bulk-selection mode', () => {
    render(<Harness />);
    const e = fireKey('v');
    expect(e.defaultPrevented).toBe(true);
    expect(useAppState.getState().bulkMode).toBe(true);
  });

  it('Ctrl+N still opens quick capture (the one deliberate chord)', () => {
    render(<Harness />);
    const e = fireKey('n', { ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(useAppState.getState().quickCaptureOpen).toBe(true);
  });
});
