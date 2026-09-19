import type { Occurrence, RepeatRule, Task, TaskInstance } from './types.ts';
import { compareISO, daysInMonth, parseISODate, weekdayOf } from './time.ts';

export function occursOn(task: Pick<Task, 'date' | 'repeat'>, date: string): boolean {
  if (!task.repeat) return task.date === date;
  // The start date always shows, so a rule that never matches cannot make the task unreachable.
  if (task.date === date) return true;
  if (compareISO(date, task.date) < 0) return false;
  const r: RepeatRule = task.repeat;
  if (r.until && compareISO(date, r.until) > 0) return false;
  const wd = weekdayOf(date);
  switch (r.type) {
    case 'daily':
      return true;
    case 'weekdays':
      return wd >= 1 && wd <= 5;
    case 'weekly': {
      const days = r.days && r.days.length ? r.days : [weekdayOf(task.date)];
      return days.includes(wd);
    }
    case 'custom':
      return (r.days ?? []).includes(wd);
    case 'monthly': {
      // Clamp to the last day of short months so a task on the 31st still occurs in February.
      const d = parseISODate(date);
      const target = Math.min(parseISODate(task.date).getDate(), daysInMonth(d.getFullYear(), d.getMonth()));
      return d.getDate() === target;
    }
    default:
      return false;
  }
}

export function occurrenceId(taskId: string, date: string): string {
  return `${taskId}:${date}`;
}

/** Build the concrete list of task instances for a given date. */
export function instancesForDate(
  tasks: Task[],
  occurrences: Occurrence[],
  date: string,
): TaskInstance[] {
  const occByTask = new Map<string, Occurrence>();
  for (const o of occurrences) if (o.date === date) occByTask.set(o.taskId, o);

  const out: TaskInstance[] = [];
  for (const t of tasks) {
    if (t.deletedAt) continue;
    if (!t.repeat) {
      if (t.date !== date) continue;
      out.push({ ...t, instanceDate: date, isRecurringInstance: false, occurrenceId: null });
      continue;
    }
    if (!occursOn(t, date)) continue;
    const o = occByTask.get(t.id);
    if (o?.deleted) continue;
    out.push({
      ...t,
      // The series template's own status is meaningless per day; only the override counts.
      status: o?.status ?? 'todo',
      startMin: o?.startMin !== undefined && o?.startMin !== null ? o.startMin : t.startMin,
      endMin: o?.endMin !== undefined && o?.endMin !== null ? o.endMin : t.endMin,
      // Checklist ticks are per day: without an override every item starts unticked.
      checklist: o?.checklist ?? t.checklist.map((c) => ({ ...c, done: false })),
      instanceDate: date,
      isRecurringInstance: true,
      occurrenceId: o?.id ?? null,
    });
  }
  return out.sort(sortInstances);
}

export function sortInstances(a: TaskInstance, b: TaskInstance): number {
  const as = a.startMin ?? -1;
  const bs = b.startMin ?? -1;
  if (as !== bs) return as - bs;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.createdAt - b.createdAt;
}

/**
 * Lay out overlapping timed tasks side by side.
 * Returns column index and total columns for each task id.
 */
export function layoutColumns(items: TaskInstance[]): Map<string, { col: number; cols: number }> {
  const timed = items
    .filter((t) => t.startMin !== null && t.endMin !== null)
    .sort((a, b) => a.startMin! - b.startMin! || b.endMin! - a.endMin!);
  const result = new Map<string, { col: number; cols: number }>();
  let cluster: TaskInstance[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const colEnds: number[] = [];
    const assigned = new Map<string, number>();
    for (const t of cluster) {
      let col = colEnds.findIndex((end) => end <= t.startMin!);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(t.endMin!);
      } else colEnds[col] = t.endMin!;
      assigned.set(t.id, col);
    }
    for (const t of cluster) result.set(t.id, { col: assigned.get(t.id)!, cols: colEnds.length });
    cluster = [];
    clusterEnd = -1;
  };

  for (const t of timed) {
    if (cluster.length && t.startMin! >= clusterEnd) flush();
    cluster.push(t);
    clusterEnd = Math.max(clusterEnd, t.endMin!);
  }
  flush();
  return result;
}
