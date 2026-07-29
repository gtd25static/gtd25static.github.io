import { useEffect, useRef } from 'react';
import { useAppState } from '../stores/app-state';

/**
 * Swipe right/left anywhere on the page to open/close the sidebar (mobile).
 *
 * A surface that owns its own horizontal gestures — the mindmap canvas pans
 * with one finger — marks its root with `data-no-sidebar-swipe`, and a gesture
 * that starts inside it never moves the sidebar.
 */
export function useSidebarSwipe() {
  const setSidebarOpen = useAppState((s) => s.setSidebarOpen);
  const touchRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      if (e.target instanceof Element && e.target.closest('[data-no-sidebar-swipe]')) {
        touchRef.current = null;
        return;
      }
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
}
