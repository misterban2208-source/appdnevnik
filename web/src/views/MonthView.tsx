import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { daysInMonth, pad, toISODate } from '@dnevnik/shared';
import { useStore, useT } from '../store/index.ts';
import { useInstancesRange } from '../lib/hooks.ts';
import Header from '../components/Header.tsx';
import { IconChevronLeft, IconChevronRight } from '../components/Icons.tsx';
import { haptic } from '../lib/telegram.ts';
import { EASE } from '../components/Reveal.tsx';

export default function MonthView() {
  const t = useT();
  const currentDate = useStore((s) => s.currentDate);
  const today = useStore((s) => s.today);
  const setDate = useStore((s) => s.setDate);
  const setView = useStore((s) => s.setView);
  const categories = useStore((s) => s.categories);
  const [ym, setYm] = useState({ y: Number(currentDate.slice(0, 4)), m: Number(currentDate.slice(5, 7)) - 1 });

  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1);
    const lead = (first.getDay() + 6) % 7; // Monday first
    const n = daysInMonth(ym.y, ym.m);
    const out: Array<{ iso: string; other: boolean }> = [];
    for (let i = lead - 1; i >= 0; i--) {
      const d = new Date(ym.y, ym.m, -i);
      out.push({ iso: toISODate(d), other: true });
    }
    for (let d = 1; d <= n; d++) out.push({ iso: `${ym.y}-${pad(ym.m + 1)}-${pad(d)}`, other: false });
    while (out.length % 7) {
      const d = new Date(ym.y, ym.m + 1, out.length - lead - n + 1);
      out.push({ iso: toISODate(d), other: true });
    }
    return out;
  }, [ym]);

  const byDate = useInstancesRange(cells.map((c) => c.iso));

  const go = (n: number) => {
    haptic.selection();
    const d = new Date(ym.y, ym.m + n, 1);
    setYm({ y: d.getFullYear(), m: d.getMonth() });
  };

  const monthTotal = cells.filter((c) => !c.other).reduce((a, c) => a + byDate[c.iso].filter((i) => i.status !== 'cancelled' && i.status !== 'moved').length, 0);

  return (
    <div className="screen">
      <Header
        eyebrow={String(ym.y)}
        title={t.months[ym.m]}
        sub={`${monthTotal} ${t.tasksCount.toLowerCase()}`}
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
        key={`${ym.y}-${ym.m}`}
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
        <div className="month-grid">
          {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
            <motion.div key={wd} className="month-wd" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: EASE, delay: 0.12 }}>
              {t.weekdaysShort[wd]}
            </motion.div>
          ))}
          {cells.map((c, ci) => {
            const items = byDate[c.iso].filter((i) => i.status !== 'moved' && i.status !== 'cancelled');
            const colors = Array.from(new Set(items.map((i) => (i.categoryId ? categories[i.categoryId]?.color ?? '#6c7a89' : '#6c7a89')))).slice(0, 3);
            const allDone = items.length > 0 && items.every((i) => i.status === 'done');
            return (
              <motion.button
                key={c.iso}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: EASE, delay: 0.18 + Math.floor(ci / 7) * 0.06 + (ci % 7) * 0.012 }}
                className={`month-cell${c.other ? ' other' : ''}${c.iso === today ? ' today' : ''}${c.iso === currentDate ? ' selected' : ''}`}
                onClick={() => {
                  haptic.light();
                  setDate(c.iso);
                  setView('day');
                }}
              >
                <span className="num">{Number(c.iso.slice(8))}</span>
                <span className="dots" style={{ opacity: allDone ? 0.35 : 1 }}>
                  {colors.map((col) => (
                    <span key={col} className="dot" style={{ background: col }} />
                  ))}
                </span>
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
