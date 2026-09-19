import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { formatDuration, minutesToHHMM, nowMinutes, quickParse } from '@dnevnik/shared';
import { useLiveCategories, useStore, useT } from '../store/index.ts';
import { formatShortDate } from '../i18n/index.ts';
import { haptic } from '../lib/telegram.ts';

export default function QuickAdd() {
  const t = useT();
  const open = useStore((s) => s.quickAddOpen);
  const setOpen = useStore((s) => s.setQuickAdd);
  const createTask = useStore((s) => s.createTask);
  const currentDate = useStore((s) => s.currentDate);
  const today = useStore((s) => s.today);
  const view = useStore((s) => s.view);
  const lang = useStore((s) => s.settings.lang);
  const categories = useLiveCategories();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  // Date words ("завтра", "пн") are absolute, so they resolve from the real today;
  // a task with no date lands on the day currently being viewed.
  const baseDate = view === 'day' ? currentDate : today;
  const parsed = useMemo(() => quickParse(text, today), [text, today]);
  const cat = parsed.categoryName ? categories.find((c) => c.name.toLowerCase() === parsed.categoryName!.toLowerCase()) ?? null : null;
  const date = parsed.date ?? baseDate;
  // A duration without a start time gets the next free half hour (today) or 09:00, so it is not silently dropped.
  const defaultedStart = parsed.startMin === null && parsed.durationMin !== null ? (date === today ? Math.min(1380, Math.ceil((nowMinutes() + 1) / 30) * 30) : 9 * 60) : null;
  const startMin = parsed.startMin ?? defaultedStart;
  const endMin = startMin !== null ? (parsed.endMin ?? Math.min(1440, startMin + (parsed.durationMin ?? 60))) : null;

  const submit = async () => {
    if (!parsed.title.trim()) return;
    haptic.success();
    await createTask({
      title: parsed.title.trim(),
      date,
      startMin,
      endMin,
      categoryId: cat?.id ?? null,
      priority: parsed.priority ?? 0,
    });
    setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
          <motion.div
            className="sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 260, damping: 32, mass: 0.9 }}
          >
            <div className="grabber" />
            <div className="section-title" style={{ padding: '0 0 10px' }}>
              {t.quickAdd}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <input
                ref={inputRef}
                className="input"
                value={text}
                placeholder={t.quickPlaceholder}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Some WebViews deliver Enter without a keypress, which skips implicit form submission.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                enterKeyHint="done"
              />
            </form>
            <div className="chip-row scroll" style={{ marginTop: 12, minHeight: 34 }}>
              <span className="chip active">{date === today ? t.today : formatShortDate(date, lang)}</span>
              {startMin !== null && (
                <span className="chip active">
                  {minutesToHHMM(startMin)}
                  {endMin !== null && ` – ${minutesToHHMM(endMin)}`}
                </span>
              )}
              {startMin !== null && endMin !== null && (
                <span className="chip">
                  {formatDuration(endMin - startMin, lang)}
                  {parsed.clamped && ` · ${t.clampedNote}`}
                </span>
              )}
              {defaultedStart !== null && <span className="chip">{t.durationDefaulted}</span>}
              {cat && (
                <span className="chip active" style={{ borderColor: cat.color, color: cat.color }}>
                  {cat.name}
                </span>
              )}
              {parsed.priority && <span className="chip active">{'!'.repeat(parsed.priority)}</span>}
            </div>
            <button className="btn primary" style={{ marginTop: 14 }} disabled={!parsed.title.trim()} onClick={() => void submit()}>
              {t.add}
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
