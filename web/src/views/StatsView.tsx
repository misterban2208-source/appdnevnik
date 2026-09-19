import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { addDays, formatDuration, startOfWeek } from '@dnevnik/shared';
import { useLiveCategories, useStore, useT } from '../store/index.ts';
import { useInstancesRange } from '../lib/hooks.ts';
import Header from '../components/Header.tsx';
import { IconChevronLeft, IconChevronRight } from '../components/Icons.tsx';
import { formatRange } from '../i18n/index.ts';
import { haptic } from '../lib/telegram.ts';
import Reveal, { EASE } from '../components/Reveal.tsx';

export default function StatsView() {
  const t = useT();
  const lang = useStore((s) => s.settings.lang);
  const today = useStore((s) => s.today);
  const categories = useLiveCategories();
  const [anchor, setAnchor] = useState(startOfWeek(today));
  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const byDate = useInstancesRange(dates);

  const stats = useMemo(() => {
    let total = 0;
    let done = 0;
    let minutes = 0;
    const byCat = new Map<string, { minutes: number; count: number; done: number }>();
    const perDay = dates.map((d) => {
      let m = 0;
      for (const i of byDate[d]) {
        if (i.status === 'cancelled' || i.status === 'moved') continue;
        total++;
        if (i.status === 'done') done++;
        const dur = i.startMin !== null && i.endMin !== null ? i.endMin - i.startMin : 0;
        m += dur;
        const key = i.categoryId ?? '';
        const c = byCat.get(key) ?? { minutes: 0, count: 0, done: 0 };
        c.minutes += dur;
        c.count++;
        if (i.status === 'done') c.done++;
        byCat.set(key, c);
      }
      minutes += m;
      return m;
    });
    return { total, done, minutes, byCat, perDay };
  }, [byDate, dates]);

  const maxDay = Math.max(1, ...stats.perDay);
  const maxCat = Math.max(1, ...Array.from(stats.byCat.values()).map((c) => c.minutes));
  const catRows = [...categories.map((c) => ({ id: c.id, name: c.name, color: c.color })), { id: '', name: t.none, color: '#6c7a89' }]
    .map((c) => ({ ...c, s: stats.byCat.get(c.id) }))
    .filter((c) => c.s && c.s.count > 0)
    .sort((a, b) => (b.s!.minutes || 0) - (a.s!.minutes || 0));

  const go = (n: number) => {
    haptic.selection();
    setAnchor(addDays(anchor, n * 7));
  };

  return (
    <div className="screen">
      <Header
        eyebrow={t.weekOf}
        title={formatRange(dates[0], dates[6], lang)}
        right={
          <>
            <button className="icon-btn" onClick={() => go(-1)}>
              <IconChevronLeft />
            </button>
            <button className="icon-btn" onClick={() => go(1)}>
              <IconChevronRight />
            </button>
          </>
        }
      />
      <motion.div key={anchor} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE }}>
        <div className="stat-tiles" style={{ marginTop: 8 }}>
          {[
            { v: Math.round(stats.minutes / 60), k: t.hours },
            { v: stats.total, k: t.tasksCount },
            { v: `${stats.total ? Math.round((stats.done / stats.total) * 100) : 0}%`, k: t.completion },
          ].map((tile, i) => (
            <Reveal key={tile.k} i={3 + i} className="stat-tile">
              <div className="v">{tile.v}</div>
              <div className="k">{tile.k}</div>
            </Reveal>
          ))}
        </div>

        <Reveal i={6} className="section-title">
          {t.byDay}
        </Reveal>
        <div className="day-bars">
          {stats.perDay.map((m, i) => (
            <div key={i} className="col">
              <motion.div
                className="b"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: `${Math.max(2, (m / maxDay) * 100)}%`, opacity: dates[i] === today ? 1 : 0.7 }}
                transition={{ duration: 0.7, ease: EASE, delay: 0.35 + i * 0.05 }}
              />
              <div className="l" style={{ color: dates[i] === today ? 'var(--gold)' : undefined }}>
                {t.weekdaysShort[new Date(dates[i] + 'T00:00').getDay()]}
              </div>
            </div>
          ))}
        </div>

        <Reveal i={8} className="section-title">
          {t.byCategory}
        </Reveal>
        <div style={{ padding: '0 var(--gutter)' }}>
          {catRows.length === 0 && (
            <Reveal i={9} className="empty">
              {t.noTasks}
            </Reveal>
          )}
          {catRows.map((c, i) => (
            <Reveal key={c.id} i={9 + i} className="bar-row">
              <span className="dot" style={{ background: c.color }} />
              <span className="name">{c.name}</span>
              <div className="bar">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${(c.s!.minutes / maxCat) * 100}%` }}
                  transition={{ duration: 0.8, ease: EASE, delay: 0.5 + i * 0.06 }}
                  style={{ background: c.color }}
                />
              </div>
              <span className="val">{c.s!.minutes ? formatDuration(c.s!.minutes, lang) : `${c.s!.done}/${c.s!.count}`}</span>
            </Reveal>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
