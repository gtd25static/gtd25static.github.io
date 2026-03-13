import { useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { useReviewData, setLastReviewedAt } from '../../hooks/use-review-data';
import { InboxStep } from './steps/InboxStep';
import { ListReviewStep } from './steps/ListReviewStep';
import { FollowUpsStep } from './steps/FollowUpsStep';
import { BlockedStep } from './steps/BlockedStep';
import { OverdueStep } from './steps/OverdueStep';
import { ReflectionStep } from './steps/ReflectionStep';

type ReviewPhase = 'inbox' | 'lists' | 'follow-ups' | 'blocked' | 'overdue' | 'reflection';
const PHASES: ReviewPhase[] = ['inbox', 'lists', 'follow-ups', 'blocked', 'overdue', 'reflection'];

export function WeeklyReviewModal() {
  const { open, setOpen } = useAppState(useShallow((s) => ({ open: s.weeklyReviewOpen, setOpen: s.setWeeklyReviewOpen })));
  const data = useReviewData();
  const [phase, setPhase] = useState<ReviewPhase>('inbox');
  const [listIndex, setListIndex] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setPhase('inbox');
      setListIndex(0);
    }
  }, [open]);

  // Manage dialog
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  if (!open || !data) return null;

  const phaseIdx = PHASES.indexOf(phase);

  function nextPhase() {
    if (phaseIdx < PHASES.length - 1) {
      setPhase(PHASES[phaseIdx + 1]);
      setListIndex(0);
    }
  }

  function prevPhase() {
    if (phaseIdx > 0) {
      setPhase(PHASES[phaseIdx - 1]);
      // When going back to 'lists', go to last list
      if (PHASES[phaseIdx - 1] === 'lists' && data && data.listsWithTasks.length > 0) {
        setListIndex(data.listsWithTasks.length - 1);
      }
    }
  }

  function skip() {
    nextPhase();
  }

  async function finish() {
    await setLastReviewedAt();
    setOpen(false);
  }

  const phaseLabels: Record<ReviewPhase, string> = {
    inbox: 'Inbox',
    lists: 'Lists',
    'follow-ups': 'Follow-ups',
    blocked: 'Blocked',
    overdue: 'Overdue',
    reflection: 'Reflection',
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={() => setOpen(false)}
      onClick={(e) => { if (e.target === dialogRef.current) setOpen(false); }}
      className="m-auto w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-0 shadow-2xl backdrop:bg-black/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <h2 className="text-lg font-normal text-zinc-800 dark:text-zinc-200">Weekly Review</h2>
          {/* Step indicators */}
          <div className="mt-1 flex items-center gap-1">
            {PHASES.map((p, i) => (
              <button
                key={p}
                onClick={() => { setPhase(p); if (p === 'lists') setListIndex(0); }}
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  p === phase
                    ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300'
                    : i < phaseIdx
                      ? 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400'
                      : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500'
                }`}
              >
                {phaseLabels[p]}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          aria-label="Close"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l8 8M13 5l-8 8" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="px-6 pb-6">
        {phase === 'inbox' && (
          <InboxStep tasks={data.inboxTasks} onNext={nextPhase} onSkip={skip} />
        )}
        {phase === 'lists' && (
          <ListReviewStep
            lists={data.listsWithTasks}
            listIndex={listIndex}
            onNextList={() => setListIndex((i) => Math.min(i + 1, data.listsWithTasks.length - 1))}
            onPrevList={() => setListIndex((i) => Math.max(i - 1, 0))}
            onNext={nextPhase}
            onPrev={prevPhase}
            onSkip={skip}
          />
        )}
        {phase === 'follow-ups' && (
          <FollowUpsStep followUpLists={data.followUpLists} onNext={nextPhase} onPrev={prevPhase} onSkip={skip} />
        )}
        {phase === 'blocked' && (
          <BlockedStep items={data.blockedItems} onNext={nextPhase} onPrev={prevPhase} onSkip={skip} />
        )}
        {phase === 'overdue' && (
          <OverdueStep items={data.overdueItems} onNext={nextPhase} onPrev={prevPhase} onSkip={skip} />
        )}
        {phase === 'reflection' && (
          <ReflectionStep stats={data.stats} onFinish={finish} onPrev={prevPhase} />
        )}
      </div>
    </dialog>
  );
}
