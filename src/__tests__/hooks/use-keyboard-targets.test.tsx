// @vitest-environment jsdom
//
// Where a key lands decides who owns it. Regressions pinned here:
//  - the global handler used to preventDefault Enter/Space on ANY non-input
//    target, so a focused button (a confirm dialog's Delete, "Add a task", the
//    Settings cog) could never be pressed from the keyboard;
//  - bare-key shortcuts fired behind open modals (`d` resolved a hidden
//    follow-up while a History dialog was up), and Escape's preventDefault
//    stopped every <dialog> from closing natively.
import { act, render } from '@testing-library/react';
import '../setup-component';

type NavItem = { id: string; type: 'task' | 'subtask' | 'banner-blocked' | 'create' | 'add-subtask'; taskId?: string };

let listType: 'tasks' | 'follow-ups' | null = 'tasks';
let mainItems: NavItem[] = [];
const mockSetTaskStatus = vi.fn();
const mockUpdateTask = vi.fn();

// use-keyboard runs four liveQueries; tell them apart by default value / deps.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_fn: unknown, deps?: unknown[], def?: unknown) => {
    if (def && typeof def === 'object' && 'lock' in (def as object)) return { lock: false, redact: false };
    if (def === null) return listType; // selected list type
    if (Array.isArray(deps) && deps.length === 2) return mainItems; // main-area nav items
    return []; // sidebar lists
  },
}));
vi.mock('../../db', () => ({
  db: {
    tasks: { get: async (id: string) => ({ id, listId: 'L1', status: 'todo', archived: false }) },
    subtasks: { get: async () => undefined },
  },
}));
vi.mock('../../hooks/use-tasks', () => ({
  setTaskStatus: (...a: unknown[]) => mockSetTaskStatus(...a),
  updateTask: (...a: unknown[]) => mockUpdateTask(...a),
  restoreTask: vi.fn(),
}));
vi.mock('../../hooks/use-subtasks', () => ({ setSubtaskStatus: vi.fn() }));
vi.mock('../../hooks/use-follow-ups', () => ({ isInCooldown: vi.fn(() => false) }));
vi.mock('../../hooks/use-bulk-operations', () => ({ deleteTasksBatch: vi.fn() }));
vi.mock('../../lib/task-sort', () => ({ sortTasksForDisplay: () => [], sortFollowUpsForDisplay: () => [] }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => false) }));

import { useKeyboard } from '../../hooks/use-keyboard';
import { useAppState } from '../../stores/app-state';

function Harness() {
  useKeyboard();
  return null;
}

function press(key: string, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(e); });
  return e;
}

// The handler is async (db reads before a write) — let it run to completion.
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount<T extends HTMLElement>(el: T): T {
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  listType = 'tasks';
  mainItems = [{ id: 'create-task', type: 'create' }, { id: 't1', type: 'task' }];
  useAppState.setState({
    selectedListId: 'L1',
    focusZone: 'main',
    focusedItemId: 't1',
    editingItemId: null,
    creatingTask: false,
    addingSubtaskToTaskId: null,
    helpOpen: false,
    bulkMode: false,
    selectedTaskIds: new Set(),
    expandedTaskIds: new Set(),
    searchQuery: '',
    quickCaptureOpen: false,
    settingsOpen: false,
    trashOpen: false,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useKeyboard — a focused control owns Enter/Space', () => {
  const controls: [string, () => HTMLElement][] = [
    ['button', () => document.createElement('button')],
    ['link', () => Object.assign(document.createElement('a'), { href: 'https://example.com/' })],
    ['[role=button]', () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'button');
      d.tabIndex = 0;
      return d;
    }],
    ['summary', () => document.createElement('summary')],
  ];

  it.each(controls)('Enter on a focused %s is left to it (no shortcut, no preventDefault)', (_name, make) => {
    useAppState.setState({ focusZone: 'sidebar', focusedItemId: 'L2' });
    render(<Harness />);
    const el = mount(make());
    el.focus();
    const e = press('Enter', el);
    expect(e.defaultPrevented).toBe(false);
    expect(useAppState.getState().selectedListId).toBe('L1'); // sidebar Enter would have selected L2
  });

  it.each(controls)('Space on a focused %s is left to it', (_name, make) => {
    render(<Harness />);
    const el = mount(make());
    el.focus();
    const e = press(' ', el);
    expect(e.defaultPrevented).toBe(false);
    expect(useAppState.getState().editingItemId).toBeNull(); // Space would have started a title edit
  });

  it('Enter/Space on the page body still drive the keyboard ring', () => {
    render(<Harness />);
    const space = press(' ');
    expect(space.defaultPrevented).toBe(true);
    expect(useAppState.getState().editingItemId).toBe('t1');

    useAppState.setState({ editingItemId: null, focusZone: 'sidebar', focusedItemId: 'L2' });
    const enter = press('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(useAppState.getState().selectedListId).toBe('L2');
  });

  it('other shortcuts still work while a button holds focus (e.g. j after clicking a list)', () => {
    render(<Harness />);
    const btn = mount(document.createElement('button'));
    btn.focus();
    press('v', btn);
    expect(useAppState.getState().bulkMode).toBe(true);
  });

  it('moving the ring releases a focused control, so the next Enter acts on the ring', () => {
    useAppState.setState({ focusedItemId: 'create-task' });
    render(<Harness />);
    const btn = mount(document.createElement('button'));
    btn.focus();
    press('j', btn);
    expect(useAppState.getState().focusedItemId).toBe('t1');
    expect(document.activeElement).not.toBe(btn);

    const enter = press('Enter', document.activeElement ?? document.body);
    expect(enter.defaultPrevented).toBe(true);
    expect(useAppState.getState().expandedTaskIds.has('t1')).toBe(true);
  });
});

describe('useKeyboard — an open modal owns the keyboard', () => {
  function openNativeDialog() {
    const d = mount(document.createElement('dialog'));
    d.setAttribute('open', '');
    return d;
  }
  function openAriaModal() {
    const d = mount(document.createElement('div'));
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    return d;
  }

  for (const [kind, open] of [['<dialog open>', openNativeDialog], ['aria-modal overlay', openAriaModal]] as const) {
    it(`no bare-key shortcut acts behind a ${kind}, and none is preventDefault-ed`, async () => {
      render(<Harness />);
      open();
      for (const key of ['d', 's', 'b', 'j', 'k', 'h', 'n', 'v', 'Enter', ' ', 'Tab', 'Escape']) {
        const e = press(key);
        expect(e.defaultPrevented, `${JSON.stringify(key)} was preventDefault-ed`).toBe(false);
      }
      await settle();
      const s = useAppState.getState();
      expect(mockSetTaskStatus).not.toHaveBeenCalled();
      expect(mockUpdateTask).not.toHaveBeenCalled();
      expect(s.focusedItemId).toBe('t1');
      expect(s.focusZone).toBe('main');
      expect(s.bulkMode).toBe(false);
      expect(s.creatingTask).toBe(false);
      expect(s.editingItemId).toBeNull();
      expect(s.addingSubtaskToTaskId).toBeNull();
      expect(s.expandedTaskIds.size).toBe(0);
    });
  }

  it('Escape is left to the open dialog (keydown not cancelled, so it can close natively)', () => {
    render(<Harness />);
    const dialog = openNativeDialog();
    const btn = dialog.appendChild(document.createElement('button'));
    btn.focus();
    expect(press('Escape', btn).defaultPrevented).toBe(false);
    expect(press('Enter', btn).defaultPrevented).toBe(false);
    expect(press(' ', btn).defaultPrevented).toBe(false);
  });

  it.each(['settingsOpen', 'trashOpen'] as const)(
    'Escape with %s leaves closing to the topmost <dialog> (a confirm over Settings must not take Settings down too)',
    (flag) => {
      useAppState.setState({ [flag]: true });
      render(<Harness />);
      openNativeDialog(); // Settings/Trash itself
      const e = press('Escape');
      expect(e.defaultPrevented).toBe(false);
      expect(useAppState.getState()[flag]).toBe(true); // the native cancel → Modal onClose closes it
    },
  );

  it('`?` still closes the help overlay', () => {
    useAppState.setState({ helpOpen: true });
    render(<Harness />);
    openNativeDialog(); // the help overlay is itself a modal <dialog>
    press('?');
    expect(useAppState.getState().helpOpen).toBe(false);
  });

  it('shortcuts resume once the dialog is gone', async () => {
    render(<Harness />);
    const dialog = openNativeDialog();
    press('d');
    dialog.remove();
    press('d');
    await settle();
    expect(mockSetTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockSetTaskStatus).toHaveBeenCalledWith('t1', 'done');
  });
});

// Enter on a follow-up used to silently snooze it with the legacy 12h cooldown
// (not a current preset), hiding the card; the help overlay promises "Expand /
// select", and a follow-up has nothing to expand.
describe('useKeyboard — Enter on a follow-up', () => {
  it('does not snooze it (no silent write)', async () => {
    listType = 'follow-ups';
    render(<Harness />);
    const e = press('Enter');
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(mockUpdateTask).not.toHaveBeenCalled();
    expect(useAppState.getState().expandedTaskIds.size).toBe(0);
  });

  it('still toggles expansion on a task in a task list', () => {
    render(<Harness />);
    press('Enter');
    expect(useAppState.getState().expandedTaskIds.has('t1')).toBe(true);
  });
});
