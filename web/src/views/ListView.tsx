import { useMemo } from 'react';
import type { TaskInstance } from '@dnevnik/shared';
import { addDays, compareISO, instancesForDate, startOfWeek } from '@dnevnik/shared';
import { useStore, useT } from '../store/index.ts';
import { AnimatePresence } from 'framer-motion';
import Header from '../components/Header.tsx';
import TaskRow from '../components/TaskRow.tsx';
import Reveal from '../components/Reveal.tsx';

const HORIZON = 30;

export default function ListView() {
  const t = useT();
  const tasks = useStore((s) => s.tasks);
  const occurrences = useStore((s) => s.occurrences);
  const today = useStore((s) => s.today);
  const openEditor = useStore((s) => s.openEditor);

  const sections = useMemo(() => {
    const all = Object.values(tasks);
    const occ = Object.values(occurrences);
    const overdue: TaskInstance[] = all
      .filter((x) => !x.deletedAt && !x.repeat && compareISO(x.date, today) < 0 && (x.status === 'todo' || x.status === 'in_progress'))
      .sort((a, b) => compareISO(a.date, b.date) || (a.startMin ?? -1) - (b.startMin ?? -1))
      .map((x) => ({ ...x, instanceDate: x.date, isRecurringInstance: false, occurrenceId: null }));
    const weekEnd = addDays(startOfWeek(today), 6);
    const todayItems: TaskInstance[] = [];
    const tomorrowItems: TaskInstance[] = [];
    const weekItems: TaskInstance[] = [];
    const later: TaskInstance[] = [];
    for (let i = 0; i <= HORIZON; i++) {
      const d = addDays(today, i);
      const items = instancesForDate(all, occ, d).filter((x) => x.status !== 'moved');
      if (i === 0) todayItems.push(...items);
      else if (i === 1) tomorrowItems.push(...items);
      else if (compareISO(d, weekEnd) <= 0) weekItems.push(...items);
      else later.push(...items);
    }
    return [
      { key: 'overdue', title: t.overdue, items: overdue },
      { key: 'today', title: t.today, items: todayItems },
      { key: 'tomorrow', title: t.tomorrow, items: tomorrowItems },
      { key: 'week', title: t.thisWeek, items: weekItems },
      { key: 'later', title: t.later, items: later },
    ].filter((s) => s.items.length);
  }, [tasks, occurrences, today, t]);

  const total = sections.reduce((a, s) => a + s.items.length, 0);

  return (
    <div className="screen">
      <Header eyebrow={t.planned} title={t.list} sub={`${total} ${t.tasksCount.toLowerCase()}`} />
      {sections.length === 0 && (
        <Reveal i={3} className="empty">
          {t.noTasks}
        </Reveal>
      )}
      {(() => {
        let n = 3;
        return sections.map((s) => {
          const headIdx = n++;
          return (
            <div key={s.key}>
              <Reveal i={headIdx} className="section-title" style={{ color: s.key === 'overdue' ? 'var(--danger)' : undefined }}>
                {s.title}
              </Reveal>
              <div style={{ padding: '0 var(--gutter)' }}>
                <AnimatePresence initial={false}>
                  {s.items.map((inst) => (
                    <TaskRow
                      key={`${inst.id}:${inst.instanceDate}`}
                      inst={inst}
                      index={n++}
                      showDate={s.key !== 'today' && s.key !== 'tomorrow'}
                      onOpen={() => openEditor({ taskId: inst.id, instanceDate: inst.instanceDate })}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </div>
          );
        });
      })()}
    </div>
  );
}
