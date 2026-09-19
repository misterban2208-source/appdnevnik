import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useMotionValue } from 'framer-motion';
import type { NoteSection, VoiceNote } from '@dnevnik/shared';
import { VOICE_MAX_MS } from '@dnevnik/shared';
import { useStore, useT } from '../store/index.ts';
import * as recorder from '../lib/recorder.ts';
import { canPlayMime, EMPTY_LOCAL, player, retryVoiceUpload, sendToChat, voiceState, type PlayerState } from '../lib/voice.ts';
import { haptic } from '../lib/telegram.ts';
import { EASE, reveal } from './Reveal.tsx';
import { IconChat, IconDownload, IconMic, IconPause, IconPlay, IconSend, IconStop, IconX } from './Icons.tsx';

const HINT_MS = 6000;
const WAVE_BARS = 48;
const NO_PLAYER: PlayerState = { id: null, playing: false, t: 0, rate: 1 };

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Player snapshot for one note only, so idle pills never re-render on playback ticks. */
function usePlayerFor(id: string): PlayerState {
  return useSyncExternalStore(player.subscribe, () => (player.getState().id === id ? player.getState() : NO_PLAYER));
}

export default function VoiceSection({ date, section }: { date: string; section: NoteSection }) {
  const voiceNotes = useStore((s) => s.voiceNotes);
  const notes = useMemo(
    () =>
      Object.values(voiceNotes)
        .filter((n) => n.date === date && n.section === section && !n.deletedAt)
        .sort((a, b) => a.createdAt - b.createdAt),
    [voiceNotes, date, section],
  );
  return (
    <div className="voice">
      <AnimatePresence initial={false}>
        {notes.map((n, i) => (
          <VoicePill key={n.id} note={n} index={i} />
        ))}
      </AnimatePresence>
      <RecorderRow date={date} section={section} />
    </div>
  );
}

/* ---------------- Recorder row ---------------- */

function RecorderRow({ date, section }: { date: string; section: NoteSection }) {
  const t = useT();
  const showToast = useStore((s) => s.showToast);
  const rec = useSyncExternalStore(recorder.subscribe, recorder.getState);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supported = recorder.voiceSupport() === 'ok';
  const mine = rec.date === date && rec.section === section;
  const busyElsewhere = rec.status !== 'idle' && !mine;

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  };
  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  const onStart = () => {
    setHint(null);
    if (!supported) {
      haptic.warning();
      showToast(t.voiceUnsupported);
      return;
    }
    if (busyElsewhere) return;
    haptic.medium();
    // Must stay synchronous up to getUserMedia: WebViews only grant the mic inside the tap.
    recorder.start(date, section).catch((err: unknown) => showHint(t[recorder.recorderErrorKey(err)]));
  };

  const onStop = () => {
    haptic.rigid();
    // Success and failure are reported by the store's recorder handlers; nothing to do here.
    recorder.stop().catch(() => {});
  };

  const onCancel = () => {
    haptic.light();
    recorder.cancel();
  };

  const elapsed = mmss(rec.elapsedMs / 1000);
  const nearCap = rec.elapsedMs >= VOICE_MAX_MS - 30_000;

  if (mine && (rec.status === 'recording' || rec.status === 'finishing')) {
    const finishing = rec.status === 'finishing';
    return (
      <motion.div className="voice-rec" {...reveal(0, 0, -8)}>
        <div className="rec-bar">
          <button className="rec-cancel" onClick={onCancel} aria-label={t.cancel} disabled={finishing}>
            <IconX width={16} height={16} />
          </button>
          <div className="rec-meter" aria-hidden>
            {rec.levels.map((lvl, i) => (
              <motion.span key={i} animate={{ height: 4 + Math.round(lvl * 18) }} transition={{ duration: 0.08, ease: 'linear' }} />
            ))}
          </div>
          <span className={`rec-time${nearCap ? ' warn' : ''}`}>{elapsed}</span>
        </div>
        <button className={`mic-btn rec${finishing ? ' busy' : ''}`} onClick={onStop} disabled={finishing} aria-label={t.stop}>
          {finishing ? <span className="dots" /> : <IconStop width={18} height={18} />}
        </button>
      </motion.div>
    );
  }

  const requesting = mine && rec.status === 'requesting';
  const cls = ['mic-btn', requesting ? 'wait' : '', !supported || busyElsewhere ? 'off' : ''].filter(Boolean).join(' ');
  return (
    <div className="voice-rec">
      <AnimatePresence>
        {hint && (
          <motion.span className="voice-hint" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {hint}
          </motion.span>
        )}
      </AnimatePresence>
      <button className={cls} onClick={onStart} aria-label={t.record} disabled={requesting}>
        <IconMic width={18} height={18} />
      </button>
    </div>
  );
}

/* ---------------- Pill ---------------- */

function VoicePill({ note, index }: { note: VoiceNote; index: number }) {
  const t = useT();
  const local = useStore((s) => s.voiceLocal[note.id]) ?? EMPTY_LOCAL;
  const showToast = useStore((s) => s.showToast);
  const deleteVoiceNote = useStore((s) => s.deleteVoiceNote);
  const p = usePlayerFor(note.id);
  const state = voiceState(note, local);
  const playable = useMemo(() => canPlayMime(note.mime), [note.mime]);
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const axis = useRef<'x' | 'y' | null>(null);
  const warnedUnplayable = useRef(false);

  const durationSec = Math.max(0.001, note.duration / 1000);
  const isCurrent = p.id === note.id;
  const progress = isCurrent ? Math.min(1, p.t / durationSec) : 0;

  const bars = useMemo(() => {
    if (!note.peaks) return null;
    return Array.from({ length: WAVE_BARS }, (_, i) => {
      const ch = note.peaks.charCodeAt(i);
      const v = Number.isNaN(ch) ? 0 : ch >= 97 ? ch - 87 : ch - 48; // 0-9a-z → 0..35
      return 0.15 + (Math.max(0, Math.min(35, v)) / 35) * 0.85;
    });
  }, [note.peaks]);

  const onPrimary = async () => {
    if (state === 'pending_elsewhere') {
      haptic.warning();
      showToast(t.voicePendingElsewhere);
      return;
    }
    if (!playable) {
      haptic.selection();
      if (!warnedUnplayable.current) {
        warnedUnplayable.current = true;
        showToast(t.voiceUnplayable);
      }
      const r = await sendToChat(note.id);
      if (r === 'sent') showToast(t.voiceSent);
      else if (r === 'write_access') showToast(t.voiceWriteAccess);
      else if (r === 'not_uploaded') showToast(t.voicePendingElsewhere);
      else showToast(t.voiceError);
      return;
    }
    haptic.selection();
    if (isCurrent && p.playing) {
      player.pause();
      return;
    }
    const ok = await player.play(note.id);
    if (!ok) showToast(state === 'remote' ? t.voiceDownloadFailed : t.voiceError);
  };

  // Seek on tap only: pointer-down must stay free for the horizontal swipe-to-delete gesture.
  const onSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragged.current) return;
    if (!playable || !local.hasBlob) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (isCurrent) player.seek(note.id, ratio);
    else void player.play(note.id, ratio);
  };

  const onError = () => {
    haptic.warning();
    showToast(t.voiceUploadFailed, () => void retryVoiceUpload(note.id), t.retry);
  };

  const primaryIcon =
    !playable && state !== 'pending_elsewhere' ? (
      <IconSend width={15} height={15} />
    ) : state === 'downloading' ? (
      <span className="dots" />
    ) : state === 'remote' ? (
      <IconDownload width={15} height={15} />
    ) : isCurrent && p.playing ? (
      <IconPause width={15} height={15} />
    ) : (
      <IconPlay width={15} height={15} />
    );

  return (
    <motion.div className="row-wrap" layout {...reveal(index, 0.08)} exit={{ opacity: 0, height: 0, marginBottom: 0, transition: { duration: 0.25 } }}>
      <div className="row-bg">{t.delete}</div>
      <motion.div
        className={`voice-pill ${state}${isCurrent && p.playing ? ' playing' : ''}`}
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
          // Deferred by framer-motion; the axis is reset at the end of the gesture instead.
          dragged.current = true;
        }}
        onDragEnd={(_, info) => {
          if (axis.current === 'x' && info.offset.x < -90 && Math.abs(info.offset.x) > Math.abs(info.offset.y)) void deleteVoiceNote(note.id);
          axis.current = null;
          setTimeout(() => {
            dragged.current = false;
          }, 250);
        }}
      >
        <button className="vp-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => !dragged.current && void onPrimary()} aria-label={t.voiceNotes}>
          {primaryIcon}
        </button>
        <div className="vp-wave" onClick={onSeek} role="slider" aria-valuenow={Math.round(progress * 100)}>
          {bars ? (
            <>
              <div className="vp-bars">
                {bars.map((h, i) => (
                  <span key={i} style={{ height: `${Math.round(h * 100)}%` }} />
                ))}
              </div>
              <div className="vp-bars gold" style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}>
                {bars.map((h, i) => (
                  <span key={i} style={{ height: `${Math.round(h * 100)}%` }} />
                ))}
              </div>
            </>
          ) : (
            <div className="vp-flat">
              <div className="vp-flat-fill" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
        <span className="vp-time">{isCurrent && (p.playing || p.t > 0) ? mmss(p.t) : mmss(durationSec)}</span>
        {isCurrent && p.playing && (
          <button
            className="vp-rate"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              haptic.selection();
              player.cycleRate();
            }}
          >
            {p.rate}×
          </button>
        )}
        {note.source === 'bot' && <IconChat className="vp-src" width={13} height={13} />}
        {state === 'error' && <button className="vp-err" onPointerDown={(e) => e.stopPropagation()} onClick={onError} aria-label={t.retry} />}
        {state === 'uploading' && (
          <motion.div className="vp-progress" initial={{ width: 0 }} animate={{ width: `${Math.max(4, local.progress * 100)}%` }} transition={{ duration: 0.2, ease: EASE }} />
        )}
      </motion.div>
    </motion.div>
  );
}
