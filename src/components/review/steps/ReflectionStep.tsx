import { ReviewStep } from '../ReviewStep';

interface Props {
  stats: { completedThisWeek: number; addedThisWeek: number; streak: number };
  onFinish: () => void;
  onPrev: () => void;
}

export function ReflectionStep({ stats, onFinish, onPrev }: Props) {
  return (
    <ReviewStep title="Reflection" subtitle="Your weekly summary" count={0} onNext={onFinish} onPrev={onPrev} isLast>
      <div className="space-y-4 py-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-zinc-200 p-4 text-center dark:border-zinc-700">
            <div className="text-2xl font-semibold text-green-600">{stats.completedThisWeek}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Completed</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-4 text-center dark:border-zinc-700">
            <div className="text-2xl font-semibold text-accent-600">{stats.addedThisWeek}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Added</div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-4 text-center dark:border-zinc-700">
            <div className="text-2xl font-semibold text-orange-500">{stats.streak}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Day Streak</div>
          </div>
        </div>
        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          {stats.completedThisWeek > stats.addedThisWeek
            ? 'Great week! You completed more than you added.'
            : stats.completedThisWeek === 0
              ? 'No completions this week. Time to get things done!'
              : 'Keep going! Every task completed counts.'}
        </p>
      </div>
    </ReviewStep>
  );
}
