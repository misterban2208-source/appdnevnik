import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { TaskInstance } from '@dnevnik/shared';
import { minutesToHHMM } from '@dnevnik/shared';
import { haptic } from '../lib/telegram.ts';
import { onSurface, tint } from '../lib/util.ts';
import { EASE } from './Reveal.tsx';

interface Props {
  inst: TaskInstance;
  index?: number;
  color: string;
  hourHeight: number;
  /** Converts minutes-from-midnight to pixel offset inside the blocks layer. */
  minToPx: (min: number) => number;
  /** Visible (expanded) minute range; drags are clamped to it so the block never enters a collapsed strip. */
  dragBounds: { min: number; max: number };
  leftPct: number;
  widthPct: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onCommit: (startMin: number, endMin: number) => void;
}

const SNAP = 5;
const LONG_PRESS = 380;
const MIN_DURATION = 10;
/** Finger jitter below this distance does not cancel a long press. */
const SLOP_PX = 8;

export default function TaskBlock({ inst, index = 0, color, hourHeight, minToPx, dragBounds, leftPct, widthPct, selected, onSelect, onOpen, onCommit }: Props) {
  const start = inst.startMin!;
  const end = inst.endMin!;
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const origin = useRef<{ y: number; start: number; end: number; mode: 'move' | 'resize' } | null>(null);
  const moved = useRef(false);

  const cur = drag ?? { start, end };
  const top = minToPx(cur.start);
  const height = Math.max(18, minToPx(cur.end) - minToPx(cur.start));
  const pxToMin = (px: number) => (px / hourHeight) * 60;

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  };

  const onPointerDown = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    moved.current = false;
    if (!selected && mode === 'move') {
      // Long press selects the block; a normal tap opens it.
      pressStart.current = { x: e.clientX, y: e.clientY };
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        pressStart.current = null;
        haptic.medium();
        onSelect();
      }, LONG_PRESS);
      return;
    }
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = { y: e.clientY, start, end, mode };
    setDrag({ start, end });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pressTimer.current && pressStart.current) {
      // Real movement before the long press fires means the user is scrolling.
      if (Math.hypot(e.clientX - pressStart.current.x, e.clientY - pressStart.current.y) > SLOP_PX) clearPress();
      return;
    }
    const o = origin.current;
    if (!o) return;
    // Snap the delta only: a block at 09:07 keeps its minutes unless it is actually dragged.
    const dMin = Math.round(pxToMin(e.clientY - o.y) / SNAP) * SNAP;
    if (dMin !== 0) moved.current = true;
    if (o.mode === 'move') {
      const dur = o.end - o.start;
      const s = Math.max(dragBounds.min, Math.min(dragBounds.max - dur, o.start + dMin));
      setDrag((prev) => {
        if (prev && prev.start !== s) haptic.selection();
        return { start: s, end: s + dur };
      });
    } else {
      const en = Math.min(dragBounds.max, Math.max(o.start + MIN_DURATION, o.end + dMin));
      setDrag((prev) => {
        if (prev && prev.end !== en) haptic.selection();
        return { start: o.start, end: en };
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (pressTimer.current) {
      // Released before the long press: this was a tap.
      clearPress();
      if (!selected) onOpen();
      return;
    }
    const o = origin.current;
    origin.current = null;
    if (!o) return;
    e.stopPropagation();
    if (moved.current && drag && (drag.start !== start || drag.end !== end)) {
      haptic.rigid();
      onCommit(drag.start, drag.end);
    } else if (!moved.current && selected && o.mode === 'move') {
      onOpen();
    }
    setDrag(null);
  };

  const cls = ['task-block', inst.status, height < 34 ? 'small' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');

  return (
    <motion.div
      className={cls}
      initial={{ opacity: 0, y: -12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.55, ease: EASE, delay: 0.25 + index * 0.06 }}
      style={{
        top,
        height,
        left: `${leftPct}%`,
        width: `calc(${widthPct}% - 3px)`,
        background: onSurface(color, 0.26),
        borderColor: tint(color, 0.55),
        borderLeft: `3px solid ${color}`,
      }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        clearPress();
        origin.current = null;
        setDrag(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tb-title">
        {inst.priority > 0 && <span className="prio">{'!'.repeat(inst.priority)} </span>}
        {inst.title}
      </div>
      <div className="tb-time">
        {minutesToHHMM(cur.start)} – {minutesToHHMM(cur.end)}
      </div>
      {drag && (
        <div className="drag-time">
          {minutesToHHMM(cur.start)} – {minutesToHHMM(cur.end)}
        </div>
      )}
      <div
        className="resize-handle"
        onPointerDown={(e) => onPointerDown(e, 'resize')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </motion.div>
  );
}
