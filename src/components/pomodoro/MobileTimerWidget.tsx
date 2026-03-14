import { useState, useRef, useEffect } from 'react';
import { usePomodoroStore } from '../../stores/pomodoro-store';
import { useShallow } from 'zustand/react/shallow';
import { TimerDisplay } from './TimerDisplay';

export function MobileTimerWidget() {
  const [expanded, setExpanded] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const { timerRunning, ambientPlaying, startPlus25, startColon25, startColon55, stopAll, toggleAmbient, setPomodoroSettingsOpen } =
    usePomodoroStore(
      useShallow((s) => ({
        timerRunning: s.timerRunning,
        ambientPlaying: s.ambientPlaying,
        startPlus25: s.startPlus25,
        startColon25: s.startColon25,
        startColon55: s.startColon55,
        stopAll: s.stopAll,
        toggleAmbient: s.toggleAmbient,
        setPomodoroSettingsOpen: s.setPomodoroSettingsOpen,
      })),
    );

  const isActive = timerRunning || ambientPlaying;

  // Close popover on outside click
  useEffect(() => {
    if (!expanded) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [expanded]);

  const btnClass = 'min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-sm font-medium transition-colors';
  const defaultBtn = 'bg-zinc-100 text-zinc-700 active:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300';

  return (
    <div className="relative" ref={popoverRef}>
      {/* Timer display + toggle button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        aria-label="Pomodoro timer"
      >
        <TimerDisplay />
        {/* Clock icon */}
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className={isActive ? 'text-accent-500' : 'text-zinc-400'}>
          <circle cx="10" cy="10" r="8" />
          <path d="M10 6v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Expanded popover */}
      {expanded && (
        <div className="absolute right-0 top-full z-50 mt-1 flex gap-2 rounded-2xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <button onClick={() => { startPlus25(); setExpanded(false); }} className={`${btnClass} ${defaultBtn}`}>
            +25
          </button>
          <button onClick={() => { startColon25(); setExpanded(false); }} className={`${btnClass} ${defaultBtn}`}>
            :25
          </button>
          <button onClick={() => { startColon55(); setExpanded(false); }} className={`${btnClass} ${defaultBtn}`}>
            :55
          </button>
          {isActive ? (
            <button
              onClick={() => { stopAll(); setExpanded(false); }}
              className={`${btnClass} bg-red-100 text-red-600 active:bg-red-200 dark:bg-red-900/30 dark:text-red-400`}
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="2" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
            <button onClick={() => { toggleAmbient(); setExpanded(false); }} className={`${btnClass} ${defaultBtn}`}>
              <svg width="14" height="14" viewBox="0 0 12 12" fill="currentColor">
                <path d="M3 2l7 4-7 4V2z" />
              </svg>
            </button>
          )}
          <button
            onClick={() => { setPomodoroSettingsOpen(true); setExpanded(false); }}
            className={`${btnClass} text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300`}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
