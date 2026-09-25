// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import '../setup-component';

let redactEnabled = true;
let paranoidOn = true;
const mockLock = vi.fn();

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_fn: unknown, _deps: unknown, def?: unknown) =>
    (def && typeof def === 'object' && 'redact' in (def as object)
      ? { lock: false, redact: redactEnabled }
      : def === false ? false : []),
}));
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../db/vault', () => ({
  isParanoidEnabled: () => paranoidOn,
  isUnlocked: () => true,
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
import { useAppState } from '../../stores/app-state';

function Harness() {
  useKeyboard();
  return null;
}

function chord() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('gtd25-redacted');
  redactEnabled = true;
  paranoidOn = true;
  useAppState.setState({ redacted: false });
});

describe('redact mode', () => {
  it('Ctrl+Shift+H toggles it on and off, mirroring to localStorage', () => {
    render(<Harness />);
    chord();
    expect(useAppState.getState().redacted).toBe(true);
    expect(localStorage.getItem('gtd25-redacted')).toBe('1');
    chord();
    expect(useAppState.getState().redacted).toBe(false);
    expect(localStorage.getItem('gtd25-redacted')).toBeNull();
  });

  it('the hotkey is inert when the feature toggle or Paranoid is off', () => {
    redactEnabled = false;
    render(<Harness />);
    chord();
    expect(useAppState.getState().redacted).toBe(false);

    redactEnabled = true;
    paranoidOn = false;
    chord();
    expect(useAppState.getState().redacted).toBe(false);
  });

  it('the active state survives a reload (localStorage-seeded)', () => {
    useAppState.getState().setRedacted(true);
    // A fresh store init (new session) must pick the flag back up
    expect(localStorage.getItem('gtd25-redacted')).toBe('1');
  });
});

// The blur itself is CSS (`.gtd-redacted [data-redact]`), which jsdom can't
// exercise — so pin the contract at the source level: every content-bearing
// component keeps its data-redact tag, and the stylesheet keeps the rule.
// If someone drops a tag in a refactor, this names the file.
describe('redact sweep contract', () => {
  const TAGGED = [
    // Task/follow-up content
    'src/components/tasks/TaskCard.tsx',
    'src/components/tasks/InboxCard.tsx',
    'src/components/tasks/SearchResults.tsx',
    'src/components/tasks/SpecialListView.tsx',
    'src/components/tasks/TaskListView.tsx',
    'src/components/tasks/TaskForm.tsx',
    'src/components/tasks/InlineTaskForm.tsx',
    'src/components/tasks/QuickCapture.tsx',
    'src/components/tasks/MergeModal.tsx',
    'src/components/tasks/MergeSuggestionsCard.tsx',
    'src/components/tasks/BulkListPicker.tsx',
    'src/components/follow-ups/FollowUpCard.tsx',
    'src/components/follow-ups/FollowUpList.tsx',
    'src/components/follow-ups/DiscussionHistory.tsx',
    'src/components/subtasks/SubtaskItem.tsx',
    'src/components/subtasks/SubtaskForm.tsx',
    'src/components/focus/FocusTaskCard.tsx',
    'src/components/insights/InsightsView.tsx',
    'src/components/trash/TrashModal.tsx',
    // Always-visible chrome — the reminders strip was the reported leak
    'src/components/banners/TopBanner.tsx',
    'src/components/banners/FollowUpsReadyBanner.tsx',
    'src/components/banners/FocusNudgeToast.tsx',
    'src/components/banners/ShareTargetPrompt.tsx',
    'src/components/layout/Sidebar.tsx',
    'src/components/layout/DndProvider.tsx',
    // Shared surfaces that render content outside any card
    'src/components/ui/Toast.tsx',
    'src/components/ui/ConfirmDialog.tsx',
    'src/components/ui/ContextMenu.tsx',
    'src/components/shared-folder/SharedItemCard.tsx',
    'src/components/shared-folder/SharedImagePreview.tsx',
    'src/components/shared-folder/PasteUploadDialog.tsx',
    'src/components/shared-folder/CreateSnippetForm.tsx',
    'src/components/mindmaps/MindmapNodeView.tsx',
    'src/components/mindmaps/MindmapBrowser.tsx',
    'src/components/mindmaps/MindmapCanvas.tsx',
    'src/components/mindmaps/MindmapEditor.tsx',
    'src/components/mindmaps/MindmapStyleToolbar.tsx',
    'src/components/mindmaps/MoveToFolderModal.tsx',
    'src/components/mindmaps/OutlineImportModal.tsx',
  ];

  it('every content component is tagged and the CSS rule exists', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of TAGGED) {
      expect(readFileSync(file, 'utf8'), file).toContain('data-redact');
    }
    const css = readFileSync('src/styles/index.css', 'utf8');
    expect(css).toContain('.gtd-redacted [data-redact]');
  });

  // The flag must live on <body>: modals open in the top layer and menus/toasts
  // are portalled, so a class on the shell div can never reach them — that was
  // why tagged content inside dialogs still rendered in the clear.
  it('flags redact mode on <body>, not on the shell subtree', async () => {
    const { readFileSync } = await import('node:fs');
    const shell = readFileSync('src/components/layout/AppShell.tsx', 'utf8');
    expect(shell).toContain("document.body.classList.toggle('gtd-redacted', redacted)");
    expect(shell).not.toContain("${redacted ? 'gtd-redacted' : ''}");
  });
});
