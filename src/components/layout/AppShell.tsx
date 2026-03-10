import { useEffect, useRef } from 'react';
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

export function AppShell() {
  const { sidebarOpen, setSidebarOpen, searchQuery, selectedListId, selectList } = useAppState();
  const lists = useTaskLists();

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
          <div className="ml-auto">
            <SyncIndicator />
          </div>
        </div>

        <UpdateBanner />
        <TopBanner />
        {searchQuery ? <SearchResults /> : selectedListId === '__special__' ? <SpecialListView /> : <TaskListView />}
      </div>

      <SettingsModal />
      <EncryptionPasswordModal />
      <TrashModal />
      <HelpOverlay />
      <ToastContainer />
    </div>
  );
}
