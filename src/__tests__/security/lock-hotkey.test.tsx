// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import '../setup-component';

let hotkeyEnabled = true;
let paranoidOn = true;
let unlocked = true;
const mockLock = vi.fn();

// use-keyboard runs several liveQueries; the paranoid-hotkeys one is the only
// one whose default is an object with a `lock` key — key off that to feed it.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_fn: unknown, _deps: unknown, def?: unknown) =>
    (def && typeof def === 'object' && 'lock' in (def as object)
      ? { lock: hotkeyEnabled, redact: false }
      : []),
}));
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../db/vault', () => ({
  isParanoidEnabled: () => paranoidOn,
  isUnlocked: () => unlocked,
  lock: () => mockLock(),
}));
vi.mock('../../hooks/use-tasks', () => ({ setTaskStatus: vi.fn(), updateTask: vi.fn(), restoreTask: vi.fn() }));
vi.mock('../../hooks/use-subtasks', () => ({ setSubtaskStatus: vi.fn() }));
vi.mock('../../hooks/use-follow-ups', () => ({ isInCooldown: vi.fn(() => false) }));
vi.mock('../../hooks/use-bulk-operations', () => ({ deleteTasksBatch: vi.fn() }));
vi.mock('../../lib/task-sort', () => ({ sortTasksForDisplay: () => [], sortFollowUpsForDisplay: () => [] }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => false) }));

import { useKeyboard } from '../../hooks/use-keyboard';

function Harness() {
  useKeyboard();
  return null;
}

function chord(init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'L', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true, ...init });
  act(() => { window.dispatchEvent(e); });
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  hotkeyEnabled = true;
  paranoidOn = true;
  unlocked = true;
});

describe('instant-lock hotkey (Ctrl/Cmd+Shift+L)', () => {
  it('locks the vault, and claims the chord', () => {
    render(<Harness />);
    const e = chord();
    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('works with Cmd on mac and from inside an input', () => {
    render(<Harness />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const e = new KeyboardEvent('keydown', { key: 'l', shiftKey: true, metaKey: true, bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(e); });
    expect(mockLock).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('does nothing — and leaves the chord to the browser — when the toggle is off', () => {
    hotkeyEnabled = false;
    render(<Harness />);
    const e = chord();
    expect(mockLock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('does nothing when Paranoid is off or the vault is already locked', () => {
    paranoidOn = false;
    render(<Harness />);
    chord();
    expect(mockLock).not.toHaveBeenCalled();

    paranoidOn = true;
    unlocked = false;
    chord();
    expect(mockLock).not.toHaveBeenCalled();
  });

  it('plain Ctrl+L (no shift) is never touched — that is the address bar', () => {
    render(<Harness />);
    const e = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(e); });
    expect(mockLock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
