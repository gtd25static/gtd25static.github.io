import { usePomodoroStore } from '../../stores/pomodoro-store';
import { useShallow } from 'zustand/react/shallow';

export function TimerDisplay() {
  const { displaySeconds, timerRunning } = usePomodoroStore(
    useShallow((s) => ({ displaySeconds: s.displaySeconds, timerRunning: s.timerRunning })),
  );

  const minutes = Math.floor(displaySeconds / 60);
  const seconds = displaySeconds % 60;
  const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return (
    <span
      className={`font-mono text-sm tabular-nums ${
        timerRunning
          ? 'text-accent-600 dark:text-accent-400'
          : 'text-zinc-400 dark:text-zinc-500'
      }`}
    >
      {formatted}
    </span>
  );
}
