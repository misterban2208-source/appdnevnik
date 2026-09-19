import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { addDays, startOfWeek } from '@dnevnik/shared';
import { useStore, useT } from '../store/index.ts';
import { useInstancesRange } from '../lib/hooks.ts';
import Header from '../components/Header.tsx';
import { IconChevronLeft, IconChevronRight } from '../components/Icons.tsx';
import { haptic } from '../lib/telegram.ts';
import { formatRange, formatShortDate } from '../i18n/index.ts';
import Reveal, { EASE, reveal } from '../components/Reveal.tsx';

export default function WeekView() {
  const t = useT();
  const lang = useStore((s) => s.settings.lang);
  const currentDate = useStore((s) => s.currentDate);
  const today = useStore((s) => s.today);
  const setDate = useStore((s) => s.setDate);
  const setView = useStore((s) => s.setView);
  const categories = useStore((s) => s.categories);
  const [anchor, setAnchor] = useState(startOfWeek(currentDate));
  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const byDate = useInstancesRange(dates);

  const total = dates.reduce((a, d) => a + byDate[d].filter((i) => i.status !== 'cancelled' && i.status !== 'moved').length, 0);
  const done = dates.reduce((a, d) => a + byDate[d].filter((i) => i.status === 'done').length, 0);

  const go = (n: number) => {
    haptic.selection();
    setAnchor(addDays(anchor, n * 7));
  };

  return (
    <div className="screen">
      <Header
        eyebrow={t.week}
        title={formatRange(dates[0], dates[6], lang)}
        sub={`${done} ${t.of} ${total}`}
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
      <motion.div
        key={anchor}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: EASE }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.12}
        onDragEnd={(_, info) => {
          if (info.offset.x < -70) go(1);
          else if (info.offset.x > 70) go(-1);
        }}
      >
        <div className="week-grid" style={{ marginTop: 8 }}>
          {dates.map((d, di) => {
            const items = byDate[d].filter((i) => i.status !== 'moved');
            const visible = items.slice(0, 8);
            return (
              <motion.button
                key={d}
                {...reveal(3 + di, 0.04, -16)}
                className={`week-day${d === today ? ' today' : ''}`}
                onClick={() => {
                  haptic.light();
                  setDate(d);
                  setView('day');
                }}
              >
                <div className="wd">{t.weekdaysShort[new Date(d + 'T00:00').getDay()]}</div>
                <div className="d">{Number(d.slice(8))}</div>
                <div style={{ height: 6 }} />
                {visible.map((i) => (
                  <div
                    key={i.id}
                    className="mini"
                    style={{
                      background: i.categoryId ? categories[i.categoryId]?.color ?? '#6c7a89' : '#6c7a89',
                      opacity: i.status === 'done' || i.status === 'cancelled' ? 0.3 : 0.9,
                      height: i.startMin !== null && i.endMin !== null ? Math.max(4, Math.min(22, ((i.endMin - i.startMin) / 60) * 6)) : 4,
                    }}
                  />
                ))}
                {items.length > visible.length && <div className="more">+{items.length - visible.length}</div>}
              </motion.button>
            );
          })}
        </div>

        <Reveal i={10} className="section-title">
          {t.planned}
        </Reveal>
        <div style={{ padding: '0 var(--gutter)', display: 'grid', gap: 8 }}>
          {dates.map((d, di) => {
            const items = byDate[d].filter((i) => i.status !== 'moved');
            if (!items.length) return null;
            return (
              <motion.button
                key={d}
                {...reveal(11 + di)}
                className="card"
                style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onClick={() => {
                  setDate(d);
                  setView('day');
                }}
              >
                <span style={{ color: d === today ? 'var(--gold)' : 'var(--text)' }}>
                  {t.weekdaysShort[new Date(d + 'T00:00').getDay()]}, {formatShortDate(d, lang)}
                </span>
                <span style={{ color: 'var(--text-2)', fontSize: 13 }}>
                  {items.filter((i) => i.status === 'done').length} {t.of} {items.filter((i) => i.status !== 'cancelled').length}
                </span>
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
