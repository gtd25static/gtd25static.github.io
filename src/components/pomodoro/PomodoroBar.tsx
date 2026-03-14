import { TimerDisplay } from './TimerDisplay';
import { TimerButtons } from './TimerButtons';

export function PomodoroBar() {
  return (
    <div className="flex items-center gap-2">
      <TimerDisplay />
      <TimerButtons />
    </div>
  );
}
