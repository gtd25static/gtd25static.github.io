import type { MotivationStats } from '../hooks/use-motivation-stats';

interface MessageCategory {
  id: string;
  match: (stats: MotivationStats) => boolean;
  templates: string[];
}

const categories: MessageCategory[] = [
  {
    id: 'currently_working',
    match: (s) => s.isCurrentlyWorking,
    templates: [
      'Locked in. You got this.',
      'Focus mode: active.',
      'One thing at a time. You\'re doing it right.',
      'Heads down, making progress.',
      'Deep in it. Keep going.',
      'You\'re in the zone.',
      'Focused work is the best kind of work.',
      'Ship it.',
    ],
  },
  {
    id: 'weekend',
    match: (s) => s.isWeekend && s.completedToday === 0,
    templates: [
      'It\'s the weekend. Enjoy the downtime.',
      'Weekend mode. Recharge for next week.',
      'No pressure today. It\'s the weekend.',
      'Take it easy — you\'ve earned the break.',
      'Weekends are for recovery. Or not. Your call.',
      'Off the clock. Relax.',
      'Nothing to prove on a weekend.',
      'Rest is productive too.',
    ],
  },
  {
    id: 'under_pressure',
    match: (s) => s.overdueCount >= 3,
    templates: [
      '{overdueCount} items overdue. Pick one and knock it out.',
      'A few things slipped. Start with the easiest one.',
      '{overdueCount} overdue — just focus on the next one.',
      'Behind on a few things. One at a time gets you there.',
      'Overdue doesn\'t mean over. Pick one, finish it, repeat.',
      '{overdueCount} items need attention. You\'ve handled worse.',
      'The pile looks big, but each one is just one task.',
      'Triage time. What\'s the smallest overdue item you can close?',
    ],
  },
  {
    id: 'productive_day',
    match: (s) => s.completedToday >= 3,
    templates: [
      '{completedToday} done today. Solid output.',
      'Already {completedToday} tasks down. Productive day.',
      'You\'ve been on fire — {completedToday} completed today.',
      '{completedToday} and counting. Strong day.',
      'That\'s {completedToday} tasks checked off. Keep the momentum.',
      '{completedToday} done. You\'re making real progress.',
      'Crushing it — {completedToday} tasks today.',
      '{completedToday} completions today. Well done.',
      'Look at you go. {completedToday} tasks handled.',
      '{completedToday} down, and the day isn\'t over yet.',
    ],
  },
  {
    id: 'on_a_streak',
    match: (s) => s.streakDays >= 3,
    templates: [
      'Day {streakDays} of getting things done. Respect.',
      '{streakDays}-day streak. Consistency wins.',
      '{streakDays} days in a row. You\'re building a habit.',
      'Streak: {streakDays} days. Don\'t break the chain.',
      '{streakDays} consecutive days of progress. That\'s discipline.',
      'Day {streakDays}. The compound effect is real.',
      '{streakDays}-day streak and counting.',
      'You\'ve shown up {streakDays} days straight. That matters.',
    ],
  },
  {
    id: 'good_start',
    match: (s) => s.completedToday === 2,
    templates: [
      '2 tasks done. Building momentum.',
      'Two down. What\'s next?',
      'Off to a good start — 2 completed.',
      'That\'s 2. You\'re rolling now.',
      '2 done already. Keep it going.',
      'Two in the books. Nice pace.',
      'Got 2 done. The third one is always the easiest.',
      '2 completed. You\'re warmed up.',
    ],
  },
  {
    id: 'first_win',
    match: (s) => s.completedToday === 1,
    templates: [
      'First one done. That\'s the hardest part.',
      'One down. The flywheel is spinning.',
      'Got the first win of the day.',
      '1 task checked off. Good start.',
      'First completion of the day. Momentum started.',
      'And one is done. The rest come easier.',
      'That\'s one. Every journey starts somewhere.',
      'First task knocked out. What\'s next?',
    ],
  },
  {
    id: 'great_week',
    match: (s) => s.completedThisWeek >= 7,
    templates: [
      '{completedThisWeek} tasks this week. Strong performance.',
      'Big week — {completedThisWeek} completions so far.',
      '{completedThisWeek} done this week. You\'re on a roll.',
      'This week: {completedThisWeek} tasks completed. Impressive.',
      '{completedThisWeek} tasks handled this week. Great pace.',
      'Week total: {completedThisWeek}. That\'s real output.',
      '{completedThisWeek} completions this week. Keep it up.',
      'You\'ve done {completedThisWeek} things this week. Solid.',
    ],
  },
  {
    id: 'all_clear',
    match: (s) => s.overdueCount === 0 && s.blockedCount === 0 && s.totalActive > 0,
    templates: [
      'Nothing overdue. Nothing blocked. Clean slate.',
      'All clear — no fires to put out.',
      'Zero overdue, zero blocked. That\'s the dream.',
      'Clean board. Pick something that excites you.',
      'No overdue items. You\'re in good shape.',
      'Everything on track. What do you want to tackle?',
      'No blockers, no fires. Just pick and go.',
      'Smooth sailing. Grab the next thing that matters.',
    ],
  },
  {
    id: 'idle_nudge',
    match: (s) => !s.isWeekend && s.completedToday === 0 && s.timeOfDay !== 'morning',
    templates: [
      'Your task list is waiting. Even one small win counts.',
      'Nothing done yet today. Pick the easiest one.',
      'Just one task. That\'s all it takes to start.',
      'Still at zero for today. What\'s the smallest thing you can close?',
      'Haven\'t started yet? The first one is always the hardest.',
      'Pick something tiny. Movement creates momentum.',
      'Zero completed today. Start anywhere.',
      'One task changes the whole vibe. Give it a shot.',
    ],
  },
  {
    id: 'fresh_start',
    match: (s) => !s.isWeekend && s.completedToday === 0 && s.timeOfDay === 'morning',
    templates: [
      'Fresh day ahead. What\'s first?',
      'Good morning. Your tasks are ready when you are.',
      'New day, clean slate. What do you want to accomplish?',
      'Morning. Pick one thing to start with.',
      'Day\'s just started. What matters most today?',
      'Rise and organize. What\'s on the agenda?',
      'Another day, another chance to make progress.',
      'Morning check-in. What\'s the top priority?',
    ],
  },
];

export interface MotivationMessage {
  text: string;
  category: string;
}

export function pickMotivationMessage(
  stats: MotivationStats,
  rng: () => number,
): MotivationMessage | null {
  for (const category of categories) {
    if (!category.match(stats)) continue;

    const idx = Math.floor(rng() * category.templates.length);
    const template = category.templates[idx];

    const text = template.replace(/\{(\w+)\}/g, (_, key) => {
      const value = stats[key as keyof MotivationStats];
      return value !== undefined ? String(value) : `{${key}}`;
    });

    return { text, category: category.id };
  }
  return null;
}
