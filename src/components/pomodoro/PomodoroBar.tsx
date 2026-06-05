import { TimerDisplay } from './TimerDisplay';
import { TimerButtons } from './TimerButtons';

export function PomodoroBar({ hideSettings }: { hideSettings?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <TimerDisplay />
      <TimerButtons hideSettings={hideSettings} />
    </div>
  );
}
