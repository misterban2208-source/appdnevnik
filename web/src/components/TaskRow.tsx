import { useRef } from 'react';
import { motion, useMotionValue } from 'framer-motion';
import type { TaskInstance, TaskStatus } from '@dnevnik/shared';
import { formatDuration, minutesToHHMM } from '@dnevnik/shared';
import { useStore, useT } from '../store/index.ts';
import { formatShortDate } from '../i18n/index.ts';
import { IconCheck, IconPlay, IconRepeat, IconX } from './Icons.tsx';
import { haptic } from '../lib/telegram.ts';
import { reveal } from './Reveal.tsx';

interface Props {
  inst: TaskInstance;
  showDate?: boolean;
  onOpen: () => void;
  /** Stagger index for the entrance animation. */
  index?: number;
}

const NEXT: Record<TaskStatus, TaskStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: 'todo',
  cancelled: 'todo',
  moved: 'todo',
};

export default function TaskRow({ inst, showDate, onOpen, index = 0 }: Props) {
  const t = useT();
  const lang = useStore((s) => s.settings.lang);
  const categories = useStore((s) => s.categories);
  const setStatus = useStore((s) => s.setInstanceStatus);
  const deleteTask = useStore((s) => s.deleteTask);
  const deleteOccurrence = useStore((s) => s.deleteOccurrence);
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const axis = useRef<'x' | 'y' | null>(null);
  const cat = inst.categoryId ? categories[inst.categoryId] : null;

  const remove = () => {
    if (inst.isRecurringInstance) void deleteOccurrence(inst.id, inst.instanceDate);
    else void deleteTask(inst.id);
  };

  const time =
    inst.startMin !== null
      ? `${minutesToHHMM(inst.startMin)}${inst.endMin !== null ? ` – ${minutesToHHMM(inst.endMin)} · ${formatDuration(inst.endMin - inst.startMin, lang)}` : ''}`
      : null;

  return (
    <motion.div className="row-wrap" layout {...reveal(index, 0.12)} exit={{ opacity: 0, height: 0, marginBottom: 0, transition: { duration: 0.25 } }}>
      <div className="row-bg">{t.delete}</div>
      <motion.div
        className={`task-row ${inst.status}`}
        style={{ x }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -120, right: 0 }}
        dragElastic={{ left: 0.2, right: 0 }}
        dragSnapToOrigin
        onDirectionLock={(a) => {
          axis.current = a;
        }}
        onDragStart={() => {
          // onDragStart is deferred to the next frame, so the axis must not be reset here:
          // onDirectionLock may already have fired for this gesture.
          dragged.current = true;
        }}
        onDragEnd={(_, info) => {
          // Delete only on a genuinely horizontal swipe (a vertical mouse drag also reports an x offset).
          if (axis.current === 'x' && info.offset.x < -90 && Math.abs(info.offset.x) > Math.abs(info.offset.y)) remove();
          axis.current = null;
          // A click event follows the drag; swallow it.
          setTimeout(() => {
            dragged.current = false;
          }, 250);
        }}
        whileTap={{ scale: 0.995 }}
        onClick={() => {
          if (dragged.current) return;
          onOpen();
        }}
      >
        <button
          className={`check ${inst.status}`}
          onClick={(e) => {
            e.stopPropagation();
            void setStatus(inst, NEXT[inst.status]);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {inst.status === 'done' && <IconCheck width={14} height={14} />}
          {inst.status === 'in_progress' && <IconPlay width={12} height={12} />}
          {(inst.status === 'cancelled' || inst.status === 'moved') && <IconX width={12} height={12} />}
        </button>
        <div className="body">
          <div className="title">
            {inst.priority > 0 && <span className="prio">{'!'.repeat(inst.priority)} </span>}
            {inst.title}
          </div>
          <div className="meta">
            {cat && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span className="dot" style={{ background: cat.color }} />
                {cat.name}
              </span>
            )}
            {showDate && <span>{formatShortDate(inst.instanceDate, lang)}</span>}
            {time && <span>{time}</span>}
            {inst.repeat && <IconRepeat width={12} height={12} />}
            {inst.checklist.length > 0 && (
              <span>
                {inst.checklist.filter((c) => c.done).length}/{inst.checklist.length}
              </span>
            )}
            {inst.carriedFrom && <span style={{ color: 'var(--text-3)' }}>{t.carriedFrom(formatShortDate(inst.carriedFrom, lang))}</span>}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function statusHaptic(status: TaskStatus) {
  if (status === 'done') haptic.success();
  else haptic.light();
}
