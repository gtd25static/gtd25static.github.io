import { usePomodoroStore } from '../../stores/pomodoro-store';
import { useShallow } from 'zustand/react/shallow';

export function TimerButtons() {
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

  const pillClass =
    'rounded-full px-2 py-0.5 text-xs font-medium transition-colors border';
  const defaultPill =
    'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800';

  return (
    <div className="flex items-center gap-1">
      <button onClick={startPlus25} className={`${pillClass} ${defaultPill}`} title="Add 25 minutes">
        +25
      </button>
      <button onClick={startColon25} className={`${pillClass} ${defaultPill}`} title="Timer until :25">
        :25
      </button>
      <button onClick={startColon55} className={`${pillClass} ${defaultPill}`} title="Timer until :55">
        :55
      </button>

      {/* Play/Stop toggle */}
      {isActive ? (
        <button
          onClick={stopAll}
          className={`${pillClass} border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30`}
          title="Stop all"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="2" y="2" width="8" height="8" rx="1" />
          </svg>
        </button>
      ) : (
        <button
          onClick={toggleAmbient}
          className={`${pillClass} ${defaultPill}`}
          title="Play ambient sounds"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M3 2l7 4-7 4V2z" />
          </svg>
        </button>
      )}

      {/* Settings gear */}
      <button
        onClick={() => setPomodoroSettingsOpen(true)}
        className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        title="Pomodoro settings"
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}
