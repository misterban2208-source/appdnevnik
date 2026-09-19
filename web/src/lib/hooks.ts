import { useEffect, useMemo, useState } from 'react';
import type { TaskInstance } from '@dnevnik/shared';
import { instancesForDate, nowMinutes, toISODate } from '@dnevnik/shared';
import { useStore } from '../store/index.ts';

/** Concrete task instances for a date, recomputed when data changes. */
export function useInstances(date: string): TaskInstance[] {
  const tasks = useStore((s) => s.tasks);
  const occurrences = useStore((s) => s.occurrences);
  return useMemo(() => instancesForDate(Object.values(tasks), Object.values(occurrences), date), [tasks, occurrences, date]);
}

/** Instances for a range of dates (inclusive), keyed by date. */
export function useInstancesRange(dates: string[]): Record<string, TaskInstance[]> {
  const tasks = useStore((s) => s.tasks);
  const occurrences = useStore((s) => s.occurrences);
  return useMemo(() => {
    const t = Object.values(tasks);
    const o = Object.values(occurrences);
    return Object.fromEntries(dates.map((d) => [d, instancesForDate(t, o, d)]));
  }, [tasks, occurrences, dates.join('|')]);
}

/** Ticks every 30s; returns current minutes from midnight and today's ISO date. */
export function useClock(): { minutes: number; today: string } {
  const [state, setState] = useState(() => ({ minutes: nowMinutes(), today: toISODate(new Date()) }));
  useEffect(() => {
    const id = setInterval(() => setState({ minutes: nowMinutes(), today: toISODate(new Date()) }), 30_000);
    return () => clearInterval(id);
  }, []);
  return state;
}
