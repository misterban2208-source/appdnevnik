import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { ChecklistItem, Priority, RepeatRule, RepeatType, Task, TaskStatus } from '@dnevnik/shared';
import { formatDuration, hhmmToMinutes, instancesForDate, minutesToHHMM } from '@dnevnik/shared';
import { useLiveCategories, useStore, useT } from '../store/index.ts';
import { IconCheck, IconPlus, IconX } from '../components/Icons.tsx';
import { haptic, useBackButton } from '../lib/telegram.ts';
import { modalMotion, reveal } from '../components/Reveal.tsx';

const DURATIONS = [15, 30, 45, 60, 90, 120];
const REMINDERS = [0, 5, 10, 15, 30, 60];
const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
const REPEATS: Array<RepeatType | 'none'> = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'];

export default function TaskEditor() {
  const t = useT();
  // AnimatePresence keeps this mounted during the exit animation, when the store value is already null.
  const liveEditor = useStore((s) => s.editor);
  const lastEditor = useRef(liveEditor);
  if (liveEditor) lastEditor.current = liveEditor;
  const editor = lastEditor.current!;
  const close = () => useStore.getState().openEditor(null);
  const tasks = useStore((s) => s.tasks);
  const occurrences = useStore((s) => s.occurrences);
  const settings = useStore((s) => s.settings);
  const categories = useLiveCategories();
  const saveTask = useStore((s) => s.saveTask);
  const createTask = useStore((s) => s.createTask);
  const deleteTask = useStore((s) => s.deleteTask);
  const deleteOccurrence = useStore((s) => s.deleteOccurrence);
  const detachOccurrence = useStore((s) => s.detachOccurrence);
  const lang = settings.lang;

  const base = editor.taskId ? tasks[editor.taskId] : null;
  const inst = useMemo(
    () => (base ? instancesForDate([base], Object.values(occurrences), editor.instanceDate).find((i) => i.id === base.id) ?? null : null),
    [base, occurrences, editor.instanceDate],
  );
  const isRecurring = !!base?.repeat;
  const [scope, setScope] = useState<'occurrence' | 'series'>(isRecurring ? 'occurrence' : 'series');

  const initial: Task = useMemo(() => {
    const src = inst ?? base;
    if (src) return { ...src, date: isRecurring && scope === 'occurrence' ? editor.instanceDate : src.date };
    const p = editor.prefill ?? {};
    return {
      id: '',
      userId: 0,
      title: p.title ?? '',
      description: p.description ?? '',
      date: p.date ?? editor.instanceDate,
      startMin: p.startMin ?? null,
      endMin: p.endMin ?? (p.startMin != null ? Math.min(1440, p.startMin + 60) : null),
      categoryId: p.categoryId ?? null,
      priority: p.priority ?? 0,
      status: 'todo',
      checklist: [],
      reminders: p.startMin != null ? settings.defaultReminders : [],
      repeat: null,
      carriedFrom: null,
      sortOrder: Date.now(),
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.taskId, scope]);

  const [form, setForm] = useState<Task>(initial);
  useEffect(() => setForm(initial), [initial]);
  const [newItem, setNewItem] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => useBackButton(close), []);

  const patch = (p: Partial<Task>) => setForm((f) => ({ ...f, ...p }));
  const timed = form.startMin !== null;
  const duration = timed && form.endMin !== null ? form.endMin - form.startMin! : null;

  const setTimed = (on: boolean) => {
    haptic.selection();
    if (on) {
      const s = 9 * 60;
      patch({ startMin: s, endMin: s + 60, reminders: form.reminders.length ? form.reminders : settings.defaultReminders });
    } else patch({ startMin: null, endMin: null, reminders: [] });
  };

  const setStart = (v: string) => {
    const m = hhmmToMinutes(v);
    if (m === null) return;
    const dur = duration ?? 60;
    patch({ startMin: m, endMin: Math.min(1440, m + dur) });
  };
  const setEnd = (v: string) => {
    const m = hhmmToMinutes(v);
    if (m === null || form.startMin === null) return;
    patch({ endMin: m > form.startMin ? m : form.startMin + 15 });
  };

  const canSave = form.title.trim().length > 0;

  const save = async () => {
    if (!canSave) return;
    haptic.success();
    const data = { ...form, title: form.title.trim() };
    if (!base) {
      await createTask(data);
    } else if (isRecurring && scope === 'occurrence' && inst) {
      await detachOccurrence(inst, { ...data, repeat: null });
    } else {
      await saveTask({ ...base, ...data, id: base.id, createdAt: base.createdAt });
    }
    close();
  };

  const remove = async (whole: boolean) => {
    if (!base) return;
    if (isRecurring && !whole) await deleteOccurrence(base.id, editor.instanceDate);
    else await deleteTask(base.id);
    close();
  };

  const toggleReminder = (r: number) => {
    haptic.selection();
    patch({ reminders: form.reminders.includes(r) ? form.reminders.filter((x) => x !== r) : [...form.reminders, r].sort((a, b) => a - b) });
  };

  const setRepeat = (type: RepeatType | 'none') => {
    haptic.selection();
    if (type === 'none') return patch({ repeat: null });
    const wd = new Date(form.date + 'T00:00').getDay();
    const r: RepeatRule = { type, days: type === 'weekly' || type === 'custom' ? [wd] : undefined, until: form.repeat?.until ?? null };
    patch({ repeat: r });
  };

  const toggleDay = (d: number) => {
    if (!form.repeat) return;
    const days = form.repeat.days ?? [];
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
    patch({ repeat: { ...form.repeat, days: next.length ? next : [d] } });
  };

  const addItem = () => {
    const text = newItem.trim();
    if (!text) return;
    const item: ChecklistItem = { id: crypto.randomUUID(), text, done: false };
    patch({ checklist: [...form.checklist, item] });
    setNewItem('');
  };

  return (
    <motion.div className="modal" {...modalMotion}>
      <div className="modal-head">
        <button className="text-btn muted" onClick={close}>
          {t.cancel}
        </button>
        <h2>{base ? t.editTask : t.newTask}</h2>
        <button className="text-btn" disabled={!canSave} style={{ opacity: canSave ? 1 : 0.4 }} onClick={() => void save()}>
          {t.save}
        </button>
      </div>
      <motion.div className="modal-body" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } } }}>
        {isRecurring && base && (
          <motion.div className="field" variants={fieldVariants}>
            <div className="segment">
              <button className={scope === 'occurrence' ? 'active' : ''} onClick={() => setScope('occurrence')}>
                {t.editOccurrence}
              </button>
              <button className={scope === 'series' ? 'active' : ''} onClick={() => setScope('series')}>
                {t.editSeries}
              </button>
            </div>
          </motion.div>
        )}

        <motion.div className="field" variants={fieldVariants}>
          <input className="input title" value={form.title} placeholder={t.titlePlaceholder} onChange={(e) => patch({ title: e.target.value })} autoFocus={!base} />
        </motion.div>

        <motion.div className="field" variants={fieldVariants}>
          <label>{t.date}</label>
          <input type="date" className="input" value={form.date} onChange={(e) => e.target.value && patch({ date: e.target.value })} />
        </motion.div>

        <motion.div className="field" variants={fieldVariants}>
          <label>{t.time}</label>
          <div className="segment" style={{ marginBottom: 10 }}>
            <button className={!timed ? 'active' : ''} onClick={() => setTimed(false)}>
              {t.noTime}
            </button>
            <button className={timed ? 'active' : ''} onClick={() => setTimed(true)}>
              {t.timed}
            </button>
          </div>
          {timed && (
            <>
              <div className="row2">
                <div>
                  <label>{t.start}</label>
                  <input type="time" className="input" value={minutesToHHMM(form.startMin!)} onChange={(e) => setStart(e.target.value)} />
                </div>
                <div>
                  <label>{t.end}</label>
                  <input type="time" className="input" value={minutesToHHMM(form.endMin ?? form.startMin! + 60)} onChange={(e) => setEnd(e.target.value)} />
                </div>
              </div>
              <div className="chip-row scroll" style={{ marginTop: 10 }}>
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    className={`chip${duration === d ? ' active' : ''}`}
                    onClick={() => {
                      haptic.selection();
                      patch({ endMin: Math.min(1440, form.startMin! + d) });
                    }}
                  >
                    {formatDuration(d, lang)}
                  </button>
                ))}
              </div>
            </>
          )}
        </motion.div>

        <motion.div className="field" variants={fieldVariants}>
          <label>{t.category}</label>
          <div className="chip-row scroll">
            <button className={`chip${form.categoryId === null ? ' active' : ''}`} onClick={() => patch({ categoryId: null })}>
              {t.none}
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                className={`chip${form.categoryId === c.id ? ' active' : ''}`}
                style={form.categoryId === c.id ? { borderColor: c.color, color: c.color, background: `color-mix(in srgb, ${c.color} 14%, transparent)` } : undefined}
                onClick={() => {
                  haptic.selection();
                  patch({ categoryId: c.id });
                }}
              >
                <span className="dot" style={{ background: c.color }} />
                {c.name}
              </button>
            ))}
          </div>
        </motion.div>

        <motion.div className="field" variants={fieldVariants}>
          <label>{t.priority}</label>
          <div className="segment">
            {([0, 1, 2, 3] as Priority[]).map((p) => (
              <button
                key={p}
                className={form.priority === p ? 'active' : ''}
                onClick={() => {
                  haptic.selection();
                  patch({ priority: p });
                }}
              >
                {p === 0 ? t.prio[0] : '!'.repeat(p)}
              </button>
            ))}
          </div>
        </motion.div>

        {base && (
          <motion.div className="field" variants={fieldVariants}>
            <label>{t.status}</label>
            <div className="segment">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  className={form.status === s ? 'active' : ''}
                  onClick={() => {
                    haptic.selection();
                    patch({ status: s });
                  }}
                >
                  {t.statuses[s]}
                </button>
              ))}
            </div>
          </motion.div>
        )}

        <motion.div className="field" variants={fieldVariants}>
          <label>{t.description}</label>
          <textarea className="input" value={form.description} placeholder={t.descriptionPlaceholder} onChange={(e) => patch({ description: e.target.value })} />
        </motion.div>

        <motion.div className="field" variants={fieldVariants}>
          <label>{t.checklist}</label>
          {form.checklist.map((item) => (
            <div key={item.id} className={`checklist-item${item.done ? ' done' : ''}`}>
              <button
                className={`check ${item.done ? 'done' : ''}`}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  border: `1.5px solid ${item.done ? 'var(--gold)' : 'var(--text-3)'}`,
                  background: item.done ? 'var(--gold)' : 'transparent',
                  color: '#0b0b0d',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onClick={() => {
                  haptic.light();
                  patch({ checklist: form.checklist.map((c) => (c.id === item.id ? { ...c, done: !c.done } : c)) });
                }}
              >
                {item.done && <IconCheck width={12} height={12} />}
              </button>
              <input type="text" value={item.text} onChange={(e) => patch({ checklist: form.checklist.map((c) => (c.id === item.id ? { ...c, text: e.target.value } : c)) })} />
              <button style={{ color: 'var(--text-3)' }} onClick={() => patch({ checklist: form.checklist.filter((c) => c.id !== item.id) })}>
                <IconX width={16} height={16} />
              </button>
            </div>
          ))}
          <div className="checklist-item" style={{ borderBottom: 0 }}>
            <IconPlus width={18} height={18} style={{ color: 'var(--text-3)' }} />
            <input
              type="text"
              value={newItem}
              placeholder={t.addItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addItem()}
              onBlur={addItem}
            />
          </div>
        </motion.div>

        {timed && (
          <motion.div className="field" variants={fieldVariants}>
            <label>{t.reminders}</label>
            <div className="chip-row">
              {REMINDERS.map((r) => (
                <button key={r} className={`chip${form.reminders.includes(r) ? ' active' : ''}`} onClick={() => toggleReminder(r)}>
                  {r === 0 ? t.reminderAt : r === 60 ? t.hourBefore : t.minBefore(r)}
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {(!isRecurring || scope === 'series') && (
          <motion.div className="field" variants={fieldVariants}>
            <label>{t.repeat}</label>
            <div className="chip-row">
              {REPEATS.map((r) => (
                <button key={r} className={`chip${(form.repeat?.type ?? 'none') === r ? ' active' : ''}`} onClick={() => setRepeat(r)}>
                  {t.repeats[r]}
                </button>
              ))}
            </div>
            {form.repeat && (form.repeat.type === 'weekly' || form.repeat.type === 'custom') && (
              <div className="chip-row" style={{ marginTop: 10 }}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <button key={d} className={`chip${form.repeat!.days?.includes(d) ? ' active' : ''}`} onClick={() => toggleDay(d)}>
                    {t.weekdaysShort[d]}
                  </button>
                ))}
              </div>
            )}
            {form.repeat && (
              <div style={{ marginTop: 10 }}>
                <label>{t.repeatUntil}</label>
                <input type="date" className="input" value={form.repeat.until ?? ''} onChange={(e) => patch({ repeat: { ...form.repeat!, until: e.target.value || null } })} />
              </div>
            )}
          </motion.div>
        )}

        {base && (
          <motion.div className="field" variants={fieldVariants} style={{ marginTop: 30, display: 'grid', gap: 10 }}>
            {isRecurring ? (
              <>
                <button className="btn danger" onClick={() => void remove(false)}>
                  {t.deleteOccurrence}
                </button>
                <button className="btn ghost" onClick={() => (confirmDelete ? void remove(true) : setConfirmDelete(true))}>
                  {confirmDelete ? `${t.deleteSeries}?` : t.deleteSeries}
                </button>
              </>
            ) : (
              <button className="btn danger" onClick={() => void remove(true)}>
                {t.delete}
              </button>
            )}
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}

const fieldVariants = {
  hidden: { opacity: 0, y: -12 },
  show: { opacity: 1, y: 0, transition: reveal(0).transition },
};
