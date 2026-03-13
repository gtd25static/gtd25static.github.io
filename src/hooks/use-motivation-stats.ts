import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export interface MotivationStats {
  completedToday: number;
  completedThisWeek: number;
  completedThisMonth: number;
  streakDays: number;
  overdueCount: number;
  blockedCount: number;
  totalActive: number;
  isCurrentlyWorking: boolean;
  timeOfDay: TimeOfDay;
}

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

function startOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + 1); // Monday
  return d.getTime();
}

function startOfMonth(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

function computeStreak(completionDates: number[]): number {
  if (completionDates.length === 0) return 0;

  // Get unique days with completions (as start-of-day timestamps)
  const daySet = new Set<number>();
  for (const ts of completionDates) {
    daySet.add(startOfDay(new Date(ts)));
  }

  const today = startOfDay(new Date());
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Start counting from today or yesterday
  let current = today;
  if (!daySet.has(current)) {
    current = today - oneDayMs;
    if (!daySet.has(current)) return 0;
  }

  let streak = 0;
  while (daySet.has(current)) {
    streak++;
    current -= oneDayMs;
  }
  return streak;
}

export function useMotivationStats(): MotivationStats | undefined {
  const [timeOfDay, setTimeOfDay] = useState(getTimeOfDay);
  const [, setRefreshKey] = useState(0);

  // Midnight refresh
  useEffect(() => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    const timeout = setTimeout(() => {
      setRefreshKey((k) => k + 1);
    }, msUntilMidnight);
    return () => clearTimeout(timeout);
  }, []);

  // Hourly re-evaluation for timeOfDay
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeOfDay(getTimeOfDay());
    }, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return useLiveQuery(async () => {
    const now = new Date();
    const todayStart = startOfDay(now);
    const weekStart = startOfWeek(now);
    const monthStart = startOfMonth(now);
    const nowMs = now.getTime();

    const tasks = await db.tasks.toArray();
    const subtasks = await db.subtasks.toArray();

    const liveTasks = tasks.filter((t) => !t.deletedAt);
    const liveSubtasks = subtasks.filter((s) => !s.deletedAt);

    // Collect all completion timestamps (tasks + subtasks)
    const allCompletionDates: number[] = [];
    let completedToday = 0;
    let completedThisWeek = 0;
    let completedThisMonth = 0;

    for (const t of liveTasks) {
      if (t.status !== 'done') continue;
      const completedAt = t.completedAt ?? t.updatedAt;
      allCompletionDates.push(completedAt);
      if (completedAt >= todayStart) completedToday++;
      if (completedAt >= weekStart) completedThisWeek++;
      if (completedAt >= monthStart) completedThisMonth++;
    }

    for (const s of liveSubtasks) {
      if (s.status !== 'done') continue;
      const completedAt = s.completedAt ?? s.updatedAt;
      allCompletionDates.push(completedAt);
      if (completedAt >= todayStart) completedToday++;
      if (completedAt >= weekStart) completedThisWeek++;
      if (completedAt >= monthStart) completedThisMonth++;
    }

    const overdueCount = liveTasks.filter(
      (t) => t.status !== 'done' && t.dueDate && t.dueDate < nowMs,
    ).length + liveSubtasks.filter(
      (s) => s.status !== 'done' && s.dueDate && s.dueDate < nowMs,
    ).length;

    const blockedCount = liveTasks.filter((t) => t.status === 'blocked').length +
      liveSubtasks.filter((s) => s.status === 'blocked').length;

    const totalActive = liveTasks.filter((t) => t.status !== 'done').length;

    const isCurrentlyWorking =
      liveTasks.some((t) => t.status === 'working') ||
      liveSubtasks.some((s) => s.status === 'working');

    return {
      completedToday,
      completedThisWeek,
      completedThisMonth,
      streakDays: computeStreak(allCompletionDates),
      overdueCount,
      blockedCount,
      totalActive,
      isCurrentlyWorking,
      timeOfDay,
    };
  }, [timeOfDay]);
}
