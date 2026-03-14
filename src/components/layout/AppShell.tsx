import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { useTaskLists } from '../../hooks/use-task-lists';
import { Sidebar } from './Sidebar';
import { UpdateBanner } from '../banners/UpdateBanner';
import { TopBanner } from '../banners/TopBanner';
import { TaskListView } from '../tasks/TaskListView';
import { SpecialListView } from '../tasks/SpecialListView';
import { SearchResults } from '../tasks/SearchResults';
import { SettingsModal } from '../settings/SettingsModal';
import { EncryptionPasswordModal } from '../settings/EncryptionPasswordModal';
import { TrashModal } from '../trash/TrashModal';
import { HelpOverlay } from './HelpOverlay';
import { SyncIndicator } from './SyncIndicator';
import { ToastContainer } from '../ui/Toast';
import { QuickCapture } from '../tasks/QuickCapture';
import { WeeklyReviewModal } from '../review/WeeklyReviewModal';
import { useSpecialListContext } from '../../hooks/use-special-list';
import { PomodoroSettingsModal } from '../pomodoro/PomodoroSettingsModal';
import { MobileTimerWidget } from '../pomodoro/MobileTimerWidget';

export function AppShell() {
  const { sidebarOpen, setSidebarOpen, setSettingsOpen, searchQuery, selectedListId, selectList, quickCaptureOpen, setQuickCaptureOpen } = useAppState(useShallow(s => ({ sidebarOpen: s.sidebarOpen, setSidebarOpen: s.setSidebarOpen, setSettingsOpen: s.setSettingsOpen, searchQuery: s.searchQuery, selectedListId: s.selectedListId, selectList: s.selectList, quickCaptureOpen: s.quickCaptureOpen, setQuickCaptureOpen: s.setQuickCaptureOpen })));
  const lists = useTaskLists();
  const { warningCount, blockedCount } = useSpecialListContext();

  // Swipe to open/close sidebar on mobile
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      touchRef.current = { x: t.clientX, y: t.clientY };
    }
    function onTouchEnd(e: TouchEvent) {
      if (!touchRef.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchRef.current.x;
      const dy = t.clientY - touchRef.current.y;
      // Require horizontal swipe (dx > dy) of at least 50px
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        const { sidebarOpen: isOpen } = useAppState.getState();
        if (dx > 0 && !isOpen) setSidebarOpen(true);
        if (dx < 0 && isOpen) setSidebarOpen(false);
      }
      touchRef.current = null;
    }
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [setSidebarOpen]);

  // Auto-select first list on initial load
  useEffect(() => {
    if (!selectedListId && lists.length > 0) {
      selectList(lists[0].id);
    }
  }, [selectedListId, lists]);

  return (
    <div className="flex h-screen overflow-hidden bg-white dark:bg-zinc-900">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 border-r border-zinc-200 transition-transform dark:border-zinc-800 md:relative md:z-0 md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar />
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-900">
        {/* Mobile header */}
        <div className="flex items-center gap-2 px-4 py-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            aria-label="Open sidebar"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
          </button>
          <svg width="24" height="24" viewBox="0 0 32 32" className="shrink-0">
            <rect width="32" height="32" rx="6" fill="#4285f4"/>
            <path d="M8 16l5 5L24 10" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
          <span className="text-lg text-zinc-700 dark:text-zinc-200">GTD25</span>
          <MobileTimerWidget />
          {(warningCount > 0 || blockedCount > 0) && (
            <span className="flex items-center gap-1.5 text-xs">
              {warningCount > 0 && (
                <span className="flex items-center gap-0.5 text-amber-500">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l7 13H1L8 1z" /><rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" /><circle cx="8" cy="12" r="0.9" fill="white" /></svg>
                  {warningCount}
                </span>
              )}
              {blockedCount > 0 && (
                <span className="flex items-center gap-0.5 text-red-500">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l7 13H1L8 1z" /><rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" /><circle cx="8" cy="12" r="0.9" fill="white" /></svg>
                  {blockedCount}
                </span>
              )}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <SyncIndicator />
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded-full p-2 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              aria-label="Settings"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        <UpdateBanner />
        <TopBanner />
        {searchQuery ? <SearchResults /> : selectedListId === '__special__' ? <SpecialListView /> : <TaskListView />}
      </div>

      <SettingsModal />
      <EncryptionPasswordModal />
      <TrashModal />
      <WeeklyReviewModal />
      <PomodoroSettingsModal />
      <HelpOverlay />

      {/* Mobile quick capture FAB */}
      <button
        onClick={() => setQuickCaptureOpen(!quickCaptureOpen)}
        className="fixed bottom-6 right-6 z-[92] flex h-14 w-14 md:h-12 md:w-12 items-center justify-center rounded-full bg-accent-600 text-white shadow-lg hover:bg-accent-700 active:scale-95 transition-transform"
        aria-label="Quick capture"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      <QuickCapture />
      <ToastContainer />
    </div>
  );
}
