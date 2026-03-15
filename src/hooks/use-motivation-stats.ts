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
  isWeekend: boolean;
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
  const day = d.getDay() || 7; // treat Sunday (0) as 7
  d.setDate(d.getDate() - day + 1); // Monday
  return d.getTime();
}

function startOfMonth(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function prevWeekday(ts: number): number {
  const oneDayMs = 24 * 60 * 60 * 1000;
  let cur = ts - oneDayMs;
  while (isWeekend(new Date(cur))) {
    cur -= oneDayMs;
  }
  return cur;
}

export function computeStreak(completionDates: number[]): number {
  if (completionDates.length === 0) return 0;

  // Get unique days with completions (as start-of-day timestamps)
  const daySet = new Set<number>();
  for (const ts of completionDates) {
    daySet.add(startOfDay(new Date(ts)));
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  let today = startOfDay(new Date());

  // If today is a weekend, start from the most recent Friday
  while (isWeekend(new Date(today))) {
    today -= oneDayMs;
  }

  // Start counting from today (or most recent weekday) or the previous weekday
  let current = today;
  if (!daySet.has(current)) {
    current = prevWeekday(current);
    if (!daySet.has(current)) return 0;
  }

  let streak = 0;
  while (daySet.has(current)) {
    streak++;
    current = prevWeekday(current);
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

    // Use indexed queries where possible to avoid full table scans
    const [doneTasks, doneSubtasks, blockedTasks, blockedSubs, workingTasks, workingSubs] =
      await Promise.all([
        db.tasks.where('status').equals('done').filter((t) => !t.deletedAt && !t.archived).toArray(),
        db.subtasks.where('status').equals('done').filter((s) => !s.deletedAt).toArray(),
        db.tasks.where('status').equals('blocked').filter((t) => !t.deletedAt && !t.archived).count(),
        db.subtasks.where('status').equals('blocked').filter((s) => !s.deletedAt).count(),
        db.tasks.where('status').equals('working').filter((t) => !t.deletedAt && !t.archived).count(),
        db.subtasks.where('status').equals('working').filter((s) => !s.deletedAt).count(),
      ]);

    // Overdue: use dueDate index to narrow the scan
    const [overdueTasks, overdueSubs] = await Promise.all([
      db.tasks.where('dueDate').below(nowMs).filter((t) => !t.deletedAt && !t.archived && t.status !== 'done').count(),
      db.subtasks.filter((s) => !s.deletedAt && s.status !== 'done' && !!s.dueDate && s.dueDate < nowMs).count(),
    ]);

    // Total active (non-done, non-deleted tasks)
    const totalTaskCount = await db.tasks.filter((t) => !t.deletedAt && !t.archived && t.status !== 'done').count();

    // Collect all completion timestamps from done tasks/subtasks
    const allCompletionDates: number[] = [];
    let completedToday = 0;
    let completedThisWeek = 0;
    let completedThisMonth = 0;

    for (const t of doneTasks) {
      const completedAt = t.completedAt ?? t.updatedAt;
      allCompletionDates.push(completedAt);
      if (completedAt >= todayStart) completedToday++;
      if (completedAt >= weekStart) completedThisWeek++;
      if (completedAt >= monthStart) completedThisMonth++;
    }

    for (const s of doneSubtasks) {
      const completedAt = s.completedAt ?? s.updatedAt;
      allCompletionDates.push(completedAt);
      if (completedAt >= todayStart) completedToday++;
      if (completedAt >= weekStart) completedThisWeek++;
      if (completedAt >= monthStart) completedThisMonth++;
    }

    const overdueCount = overdueTasks + overdueSubs;
    const blockedCount = blockedTasks + blockedSubs;
    const totalActive = totalTaskCount;
    const isCurrentlyWorking = workingTasks > 0 || workingSubs > 0;

    return {
      completedToday,
      completedThisWeek,
      completedThisMonth,
      streakDays: computeStreak(allCompletionDates),
      overdueCount,
      blockedCount,
      totalActive,
      isCurrentlyWorking,
      isWeekend: isWeekend(now),
      timeOfDay,
    };
  }, [timeOfDay]);
}
