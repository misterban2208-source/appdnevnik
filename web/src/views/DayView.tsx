import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Reveal, { EASE } from '../components/Reveal.tsx';
import { addDays, layoutColumns, minutesToHHMM } from '@dnevnik/shared';
import { useStore, useT } from '../store/index.ts';
import { useClock, useInstances } from '../lib/hooks.ts';
import { formatDateTitle } from '../i18n/index.ts';
import Header from '../components/Header.tsx';
import TaskBlock from '../components/TaskBlock.tsx';
import TaskRow from '../components/TaskRow.tsx';
import DayNotes from '../components/DayNotes.tsx';
import { IconToday } from '../components/Icons.tsx';
import { haptic } from '../lib/telegram.ts';

const HOUR_H = 64;
const COLLAPSED_H = 40;
const SWIPE = 70;

type Segment = { from: number; to: number; collapsed: boolean; px: number };

export default function DayView() {
  const t = useT();
  const date = useStore((s) => s.currentDate);
  const setDate = useStore((s) => s.setDate);
  const settings = useStore((s) => s.settings);
  const categories = useStore((s) => s.categories);
  const openEditor = useStore((s) => s.openEditor);
  const selectedBlockId = useStore((s) => s.selectedBlockId);
  const selectBlock = useStore((s) => s.selectBlock);
  const setInstanceTime = useStore((s) => s.setInstanceTime);
  const { minutes: nowMin, today } = useClock();
  const items = useInstances(date);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dir, setDir] = useState(0);
  const [expandBefore, setExpandBefore] = useState(false);
  const [expandAfter, setExpandAfter] = useState(false);
  // Gesture bookkeeping: a click that follows a deselect or a swipe must not create a task.
  const justDeselected = useRef(false);
  const swiping = useRef(false);
  const lockedAxis = useRef<'x' | 'y' | null>(null);

  const timed = items.filter((i) => i.startMin !== null && i.endMin !== null && i.status !== 'moved');
  const untimed = items.filter((i) => i.startMin === null && i.status !== 'moved');
  const columns = useMemo(() => layoutColumns(timed), [timed]);

  const vs = Math.min(settings.visibleStart, settings.visibleEnd - 1);
  const ve = Math.max(settings.visibleEnd, vs + 1);
  const hasBefore = timed.some((i) => i.startMin! < vs * 60) || (date === today && nowMin < vs * 60);
  const hasAfter = timed.some((i) => i.endMin! > ve * 60) || (date === today && nowMin >= ve * 60);
  const showBefore = expandBefore || hasBefore || vs === 0;
  const showAfter = expandAfter || hasAfter || ve === 24;

  const segments: Segment[] = useMemo(() => {
    const segs: Segment[] = [];
    if (vs > 0) segs.push({ from: 0, to: vs, collapsed: !showBefore, px: showBefore ? vs * HOUR_H : COLLAPSED_H });
    segs.push({ from: vs, to: ve, collapsed: false, px: (ve - vs) * HOUR_H });
    if (ve < 24) segs.push({ from: ve, to: 24, collapsed: !showAfter, px: showAfter ? (24 - ve) * HOUR_H : COLLAPSED_H });
    return segs;
  }, [vs, ve, showBefore, showAfter]);

  const totalPx = segments.reduce((a, s) => a + s.px, 0);

  const minToPx = (min: number) => {
    let y = 0;
    for (const s of segments) {
      const segStart = s.from * 60;
      const segEnd = s.to * 60;
      if (min <= segStart) return y;
      if (min < segEnd || (min === 1440 && s.to === 24)) {
        if (s.collapsed) return y + (s.px * (min - segStart)) / (segEnd - segStart);
        return y + ((min - segStart) / 60) * HOUR_H;
      }
      y += s.px;
    }
    return y;
  };

  // Minute range the blocks may be dragged within (never into a collapsed strip).
  const dragBounds = { min: showBefore ? 0 : vs * 60, max: showAfter ? 1440 : ve * 60 };

  // Auto-scroll to now (today) or to the first task.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = date === today ? minToPx(nowMin) : timed.length ? minToPx(timed[0].startMin!) : minToPx(vs * 60);
    const tl = el.querySelector<HTMLElement>('.timeline');
    // Measure relative to the scroller itself; offsetTop would include the header above it.
    const headerOffset = tl ? tl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
    el.scrollTo({ top: Math.max(0, headerOffset + target - 180), behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, segments.length]);

  const go = (n: number) => {
    haptic.selection();
    setDir(n);
    setDate(addDays(date, n));
  };

  const { eyebrow, title } = formatDateTitle(date, settings.lang);
  const rel = date === today ? t.today : date === addDays(today, 1) ? t.tomorrow : date === addDays(today, -1) ? t.yesterday : null;
  const activeCount = items.filter((i) => i.status !== 'cancelled' && i.status !== 'moved').length;
  const doneCount = items.filter((i) => i.status === 'done').length;
  const sub = `${rel ? `${rel} · ` : ''}${doneCount} ${t.of} ${activeCount}`;

  const onTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.task-block')) return;
    if (swiping.current) return;
    if (justDeselected.current) {
      justDeselected.current = false;
      return;
    }
    if (selectedBlockId) {
      selectBlock(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    // Inverse of minToPx across segments.
    let acc = 0;
    let min: number | null = null;
    for (const s of segments) {
      if (y < acc + s.px) {
        if (s.collapsed) {
          if (s.from === 0) setExpandBefore(true);
          else setExpandAfter(true);
          return;
        }
        min = s.from * 60 + ((y - acc) / HOUR_H) * 60;
        break;
      }
      acc += s.px;
    }
    if (min === null) return;
    const start = Math.floor(min / 30) * 30;
    haptic.light();
    openEditor({ taskId: null, instanceDate: date, prefill: { date, startMin: start, endMin: Math.min(1440, start + 60) } });
  };

  return (
    <div className="day-wrap">
      <Header
        eyebrow={eyebrow}
        title={title}
        sub={sub}
        right={
          date !== today ? (
            <button
              className="icon-btn gold"
              onClick={() => {
                setDir(date < today ? 1 : -1);
                setDate(today);
              }}
            >
              <IconToday />
            </button>
          ) : null
        }
      />
      <motion.div
        key={date}
        className="day-scroll"
        ref={scrollRef}
        initial={{ x: dir * 28, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.45, ease: EASE }}
        drag={selectedBlockId ? false : 'x'}
        dragDirectionLock
        onDirectionLock={(axis) => {
          lockedAxis.current = axis;
        }}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.12}
        onDragStart={() => {
          swiping.current = true;
          lockedAxis.current = null;
        }}
        onDragEnd={(_, info) => {
          // Only a horizontal gesture changes the day; a vertical mouse drag never does.
          if (lockedAxis.current === 'x' && Math.abs(info.offset.x) > Math.abs(info.offset.y)) {
            if (info.offset.x < -SWIPE) go(1);
            else if (info.offset.x > SWIPE) go(-1);
          }
          setTimeout(() => {
            swiping.current = false;
          }, 250);
        }}
        onPointerDown={(e) => {
          if (selectedBlockId && !(e.target as HTMLElement).closest('.task-block')) {
            selectBlock(null);
            justDeselected.current = true;
            setTimeout(() => {
              justDeselected.current = false;
            }, 400);
          }
        }}
      >
        {untimed.length > 0 && (
          <>
            <Reveal i={3} className="section-title">
              {t.untimed}
            </Reveal>
            <div className="untimed">
              <AnimatePresence initial={false}>
                {untimed.map((inst, i) => (
                  <TaskRow key={inst.id} inst={inst} index={i + 3} onOpen={() => openEditor({ taskId: inst.id, instanceDate: date })} />
                ))}
              </AnimatePresence>
            </div>
          </>
        )}

        <Reveal i={3 + untimed.length} className="section-title">
          {t.timeline}
        </Reveal>
        <div className="timeline" style={{ height: totalPx }} onClick={onTimelineClick}>
          {segments.map((s) =>
            s.collapsed ? (
              <div key={s.from} className="collapsed-hours" style={{ height: s.px }}>
                {t.hiddenHours(minutesToHHMM(s.from * 60), minutesToHHMM(s.to * 60 === 1440 ? 1439 : s.to * 60).replace('23:59', '24:00'))}
              </div>
            ) : (
              Array.from({ length: s.to - s.from }, (_, i) => s.from + i).map((h, i) => (
                <motion.div
                  key={h}
                  className="hour-row"
                  style={{ height: HOUR_H }}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: EASE, delay: 0.15 + i * 0.022 }}
                >
                  <span className="hour-label" style={{ opacity: date === today && Math.abs(nowMin - h * 60) < 12 ? 0 : 1 }}>
                    {minutesToHHMM(h * 60)}
                  </span>
                  <div className="half" />
                </motion.div>
              ))
            ),
          )}

          {(vs > 0 && showBefore && !hasBefore && vs !== 0) && (
            <button
              className="collapsed-hours"
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 22, background: 'transparent', border: 0, fontSize: 11, zIndex: 11 }}
              onClick={(e) => {
                e.stopPropagation();
                setExpandBefore(false);
              }}
            >
              {t.collapseHours}
            </button>
          )}

          <div className="blocks-layer">
            {timed.map((inst, i) => {
              const col = columns.get(inst.id) ?? { col: 0, cols: 1 };
              const color = inst.categoryId ? categories[inst.categoryId]?.color ?? 'var(--graphite)' : '#6c7a89';
              return (
                <TaskBlock
                  key={inst.id}
                  index={i}
                  inst={inst}
                  color={color}
                  hourHeight={HOUR_H}
                  minToPx={minToPx}
                  dragBounds={dragBounds}
                  leftPct={(100 / col.cols) * col.col}
                  widthPct={100 / col.cols}
                  selected={selectedBlockId === inst.id}
                  onSelect={() => selectBlock(inst.id)}
                  onOpen={() => openEditor({ taskId: inst.id, instanceDate: date })}
                  onCommit={(s, e) => void setInstanceTime(inst, s, e)}
                />
              );
            })}
          </div>

          {date === today && (
            <motion.div
              className="now-line"
              style={{ top: minToPx(nowMin) }}
              initial={{ opacity: 0, scaleX: 0.6 }}
              animate={{ opacity: 1, scaleX: 1 }}
              transition={{ duration: 0.7, ease: EASE, delay: 0.5 }}
            >
              <span className="now-label">{minutesToHHMM(nowMin)}</span>
            </motion.div>
          )}
        </div>

        {ve < 24 && showAfter && !hasAfter && (
          <button className="collapsed-hours" style={{ width: '100%', border: 0, background: 'transparent' }} onClick={() => setExpandAfter(false)}>
            {t.collapseHours}
          </button>
        )}

        <DayNotes date={date} />
      </motion.div>
    </div>
  );
}
