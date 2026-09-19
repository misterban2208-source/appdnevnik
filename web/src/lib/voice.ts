import type { VoiceNote } from '@dnevnik/shared';
import { ApiError, api } from './api.ts';
import { db, type VoiceQueueRow } from './db.ts';
import { requestWriteAccess, tg } from './telegram.ts';

/*
 * Voice notes outside React: byte cache, upload queue, downloads and the single audio player.
 * The store mirrors what the UI needs through `setVoiceSink`; IndexedDB stays the source of truth.
 */

export type VoiceState = 'local' | 'uploading' | 'synced' | 'remote' | 'downloading' | 'pending_elsewhere' | 'error';

export interface VoiceLocal {
  hasBlob: boolean;
  inFlight: boolean;
  progress: number;
  downloading: boolean;
  error: string | null;
}

export const EMPTY_LOCAL: VoiceLocal = { hasBlob: false, inFlight: false, progress: 0, downloading: false, error: null };

export interface VoiceSink {
  setLocal(id: string, patch: Partial<VoiceLocal>): void;
  /** A local-only change (uploadedAt/size after upload, uploadedAt cleared after a 404). */
  noteUpdated(note: VoiceNote): void;
}

let sink: VoiceSink = { setLocal() {}, noteUpdated() {} };
export function setVoiceSink(s: VoiceSink): void {
  sink = s;
}

export function voiceState(note: VoiceNote, local: VoiceLocal | undefined): VoiceState {
  const l = local ?? EMPTY_LOCAL;
  if (l.downloading) return 'downloading';
  if (l.hasBlob) {
    if (note.uploadedAt) return 'synced';
    if (l.inFlight) return 'uploading';
    if (l.error) return 'error';
    return 'local';
  }
  return note.uploadedAt ? 'remote' : 'pending_elsewhere';
}

/* ---------- Bytes ---------- */

interface Bytes {
  bytes: ArrayBuffer;
  mime: string;
}

/** Blobs that could not be persisted (quota) live here for the session. */
const memBlobs = new Map<string, Bytes>();

export function rememberBytes(id: string, b: Bytes): void {
  memBlobs.set(id, b);
}

async function localBytes(id: string): Promise<Bytes | null> {
  const mem = memBlobs.get(id);
  if (mem) return mem;
  try {
    const row = await db.voiceBlobs.get(id);
    if (!row) return null;
    // touchedAt is the eviction order; a failed touch must not block playback.
    void db.voiceBlobs.update(id, { touchedAt: Date.now() }).catch(() => {});
    return { bytes: row.bytes, mime: row.mime };
  } catch {
    return null;
  }
}

const URL_MAX = 30;
const urls = new Map<string, string>();

/** Object URL for a note's bytes (LRU of 30); null when the bytes are not on this device. */
export async function urlFor(id: string): Promise<string | null> {
  const hit = urls.get(id);
  if (hit) {
    // Re-insert so the most recently used entry sits last.
    urls.delete(id);
    urls.set(id, hit);
    return hit;
  }
  const b = await localBytes(id);
  if (!b) return null;
  const url = URL.createObjectURL(new Blob([b.bytes], { type: b.mime }));
  urls.set(id, url);
  while (urls.size > URL_MAX) {
    const [oldest, oldUrl] = urls.entries().next().value as [string, string];
    if (oldest === player.getState().id) break;
    urls.delete(oldest);
    URL.revokeObjectURL(oldUrl);
  }
  return url;
}

export function revokeUrl(id: string): void {
  const url = urls.get(id);
  if (!url) return;
  urls.delete(id);
  URL.revokeObjectURL(url);
}

/* ---------- Downloads ---------- */

const downloads = new Map<string, Promise<Bytes | null>>();

/** Bytes for playback: the local copy, else a download when the server has them and we are online. */
export function ensureVoiceBytes(id: string): Promise<Bytes | null> {
  const running = downloads.get(id);
  if (running) return running;
  const p = (async () => {
    const local = await localBytes(id);
    if (local) return local;
    const note = await db.voiceNotes.get(id);
    if (!note || note.deletedAt || !note.uploadedAt || navigator.onLine === false) return null;
    sink.setLocal(id, { downloading: true });
    try {
      const bytes = await api.downloadVoice(id);
      const b = { bytes, mime: note.mime };
      try {
        await db.voiceBlobs.put({ id, mime: note.mime, bytes, touchedAt: Date.now() });
      } catch {
        memBlobs.set(id, b);
      }
      sink.setLocal(id, { downloading: false, hasBlob: true });
      return b;
    } catch (err) {
      sink.setLocal(id, { downloading: false });
      if (err instanceof ApiError && err.status === 404) {
        // The server lost the bytes (purge / self-heal): reflect it locally, no outbox entry.
        const cur = await db.voiceNotes.get(id);
        if (cur && cur.uploadedAt) {
          const next = { ...cur, uploadedAt: null };
          await db.voiceNotes.put(next);
          sink.noteUpdated(next);
        }
      }
      throw err;
    }
  })().finally(() => downloads.delete(id));
  downloads.set(id, p);
  return p;
}

const PREFETCH_MAX = 3;
const PREFETCH_BYTES = 10 * 1024 * 1024;

/** Warm the cache for the days on screen so remote notes play without a tap-and-wait. */
export async function prefetchVoice(dates: string[]): Promise<void> {
  if (navigator.onLine === false) return;
  const wanted = new Set(dates);
  let notes: VoiceNote[];
  try {
    notes = await db.voiceNotes.filter((n) => wanted.has(n.date) && !n.deletedAt && !!n.uploadedAt).toArray();
  } catch {
    return;
  }
  let count = 0;
  let total = 0;
  for (const n of notes.sort((a, b) => b.createdAt - a.createdAt)) {
    if (count >= PREFETCH_MAX || total + n.size > PREFETCH_BYTES) break;
    if (memBlobs.has(n.id) || (await db.voiceBlobs.get(n.id))) continue;
    count++;
    total += n.size;
    await ensureVoiceBytes(n.id).catch(() => null);
  }
}

/* ---------- Upload queue ---------- */

const BACKOFF_BASE = 30_000;
const BACKOFF_MAX = 30 * 60_000;
const NOT_FOUND_RETRY = 5_000;

let pumping = false;
let pumpAgain = false;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTimer(at: number) {
  const delay = Math.max(1_000, at - Date.now());
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    void pumpVoiceUploads();
  }, delay);
}

function backoff(attempts: number): number {
  const base = Math.min(BACKOFF_BASE * 2 ** attempts, BACKOFF_MAX);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Upload pending voice notes one after another. Concurrent calls collapse into one run plus one re-run. */
export async function pumpVoiceUploads(): Promise<void> {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    for (;;) {
      const now = Date.now();
      let rows: VoiceQueueRow[];
      try {
        rows = (await db.voiceQueue.where('nextAt').belowOrEqual(now).toArray()).filter((r) => !r.permanent);
      } catch {
        break;
      }
      if (!rows.length) {
        const upcoming = await db.voiceQueue.filter((r) => !r.permanent && r.nextAt > now).toArray().catch(() => [] as VoiceQueueRow[]);
        if (upcoming.length) scheduleTimer(Math.min(...upcoming.map((r) => r.nextAt)));
        break;
      }
      rows.sort((a, b) => a.nextAt - b.nextAt);
      const stop = await uploadOne(rows[0]);
      if (stop) break;
    }
  } finally {
    pumping = false;
    if (pumpAgain) {
      pumpAgain = false;
      void pumpVoiceUploads();
    }
  }
}

/** Returns true when pumping must stop (the network is gone). */
async function uploadOne(row: VoiceQueueRow): Promise<boolean> {
  const { id } = row;
  const note = await db.voiceNotes.get(id);
  if (!note || note.deletedAt || note.uploadedAt) {
    await db.voiceQueue.delete(id);
    sink.setLocal(id, { inFlight: false, error: null });
    return false;
  }
  const b = await localBytes(id);
  if (!b) {
    await db.voiceQueue.delete(id);
    sink.setLocal(id, { inFlight: false, hasBlob: false });
    return false;
  }
  if (navigator.onLine === false) return true;
  sink.setLocal(id, { inFlight: true, progress: 0, error: null });
  try {
    const { note: server } = await api.uploadVoice(note, b.bytes, (p) => sink.setLocal(id, { progress: p }));
    const cur = await db.voiceNotes.get(id);
    if (cur) {
      const next: VoiceNote = { ...cur, uploadedAt: server?.uploadedAt ?? Date.now(), size: server?.size || cur.size };
      await db.voiceNotes.put(next);
      sink.noteUpdated(next);
    }
    await db.voiceQueue.delete(id);
    sink.setLocal(id, { inFlight: false, progress: 1 });
    return false;
  } catch (err) {
    const status = err instanceof ApiError ? err.status : -1;
    const code = err instanceof ApiError ? err.code || String(status) : 'error';
    if (status === 0) {
      // Offline: leave the row untouched and wait for the next trigger (online / visible / sync).
      sink.setLocal(id, { inFlight: false });
      return true;
    }
    const attempts = row.attempts + 1;
    let nextAt: number;
    let permanent = false;
    if (status === 404 && attempts <= 6) nextAt = Date.now() + NOT_FOUND_RETRY;
    else if (status === 410 || status === 413 || status === 415) {
      permanent = true;
      nextAt = Number.MAX_SAFE_INTEGER;
    } else if (status === 429 && err instanceof ApiError && err.retryAfter !== null) nextAt = Date.now() + Math.max(1_000, err.retryAfter);
    else nextAt = Date.now() + backoff(attempts);
    await db.voiceQueue.put({ id, attempts, nextAt, lastError: code, permanent });
    sink.setLocal(id, { inFlight: false, error: permanent ? code : null });
    return false;
  }
}

/** Clear a permanent failure and try again now. */
export async function retryVoiceUpload(id: string): Promise<void> {
  await db.voiceQueue.put({ id, attempts: 0, nextAt: Date.now(), lastError: null, permanent: false });
  sink.setLocal(id, { error: null });
  void pumpVoiceUploads();
}

/* ---------- Reconcile ---------- */

const TOMBSTONE_GRACE = 60_000;
const CACHE_HIGH = 60 * 1024 * 1024;
const CACHE_LOW = 40 * 1024 * 1024;

/** Bring queue, blobs and per-note UI flags in line with the metadata after init and every sync. */
export async function reconcileVoice(): Promise<void> {
  const now = Date.now();
  const [notes, queue, blobKeys] = await Promise.all([
    db.voiceNotes.toArray(),
    db.voiceQueue.toArray(),
    db.voiceBlobs.toCollection().primaryKeys(),
  ]);
  const hasBlob = new Set<string>([...blobKeys, ...memBlobs.keys()]);
  const queued = new Map(queue.map((q) => [q.id, q]));
  const byId = new Map(notes.map((n) => [n.id, n]));

  for (const n of notes) {
    const blob = hasBlob.has(n.id);
    if (n.deletedAt) {
      if (blob && now - n.deletedAt > TOMBSTONE_GRACE) {
        await db.voiceBlobs.delete(n.id).catch(() => {});
        memBlobs.delete(n.id);
        revokeUrl(n.id);
        hasBlob.delete(n.id);
      }
      continue;
    }
    if (!n.uploadedAt && blob && !queued.has(n.id)) {
      const row: VoiceQueueRow = { id: n.id, attempts: 0, nextAt: now, lastError: null, permanent: false };
      await db.voiceQueue.put(row);
      queued.set(n.id, row);
    }
    const q = queued.get(n.id);
    sink.setLocal(n.id, { hasBlob: blob, downloading: false, error: q?.permanent ? q.lastError ?? 'error' : null });
  }

  for (const q of queue) {
    const n = byId.get(q.id);
    if (!n || n.deletedAt || n.uploadedAt || !hasBlob.has(q.id)) await db.voiceQueue.delete(q.id);
  }

  // Cache budget: sizes come from the metadata so the blobs themselves never have to be read.
  let total = 0;
  const persisted: VoiceNote[] = [];
  for (const id of blobKeys) {
    const n = byId.get(id);
    if (!n) {
      await db.voiceBlobs.delete(id).catch(() => {});
      continue;
    }
    total += n.size;
    persisted.push(n);
  }
  if (total > CACHE_HIGH) {
    const rows = await db.voiceBlobs.toArray().catch(() => []);
    const touched = new Map(rows.map((r) => [r.id, r.touchedAt]));
    const evictable = persisted.filter((n) => n.uploadedAt).sort((a, b) => (touched.get(a.id) ?? 0) - (touched.get(b.id) ?? 0));
    for (const n of evictable) {
      if (total <= CACHE_LOW) break;
      if (n.id === player.getState().id) continue;
      await db.voiceBlobs.delete(n.id).catch(() => {});
      revokeUrl(n.id);
      total -= n.size;
      sink.setLocal(n.id, { hasBlob: false });
    }
  }
}

/* ---------- Player ---------- */

export interface PlayerState {
  id: string | null;
  playing: boolean;
  /** Seconds into the current note. */
  t: number;
  rate: number;
}

const RATES = [1, 1.5, 2];

let audio: HTMLAudioElement | null = null;
let playerState: PlayerState = { id: null, playing: false, t: 0, rate: 1 };
const playerListeners = new Set<(s: PlayerState) => void>();
let raf = 0;
let durationMs = 0;

function publishPlayer(patch: Partial<PlayerState>) {
  playerState = { ...playerState, ...patch };
  for (const l of playerListeners) l(playerState);
}

function tick() {
  if (!audio || !playerState.playing) return;
  publishPlayer({ t: audio.currentTime });
  raf = requestAnimationFrame(tick);
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.onplay = () => {
    publishPlayer({ playing: true });
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };
  audio.onpause = () => {
    cancelAnimationFrame(raf);
    publishPlayer({ playing: false, t: audio?.currentTime ?? 0 });
  };
  audio.onended = () => {
    cancelAnimationFrame(raf);
    publishPlayer({ playing: false, t: 0 });
  };
  audio.onerror = () => {
    cancelAnimationFrame(raf);
    publishPlayer({ playing: false });
  };
  return audio;
}

const playable = new Map<string, boolean>();
/** Whether this device can decode the note's container (Safari has no WebM/Opus, Chrome no fMP4 AAC on some Androids). */
export function canPlayMime(mime: string): boolean {
  const hit = playable.get(mime);
  if (hit !== undefined) return hit;
  let ok = true;
  try {
    ok = element().canPlayType(mime) !== '';
    // A generic container is what the server stores for bot notes; probe without codecs too.
    if (!ok && mime.includes(';')) ok = element().canPlayType(mime.split(';')[0]) !== '';
  } catch {
    ok = true;
  }
  playable.set(mime, ok);
  return ok;
}

export const player = {
  subscribe(l: (s: PlayerState) => void): () => void {
    playerListeners.add(l);
    return () => {
      playerListeners.delete(l);
    };
  },
  getState(): PlayerState {
    return playerState;
  },
  /** Loads the bytes when needed (downloading remote notes) and starts playback; resolves false when nothing could play. */
  async play(id: string, startRatio?: number): Promise<boolean> {
    const el = element();
    if (playerState.id !== id) {
      const b = await ensureVoiceBytes(id);
      if (!b) return false;
      const url = await urlFor(id);
      if (!url) return false;
      const note = await db.voiceNotes.get(id);
      durationMs = note?.duration ?? 0;
      el.src = url;
      publishPlayer({ id, t: 0, playing: false });
    }
    el.playbackRate = playerState.rate;
    if (startRatio !== undefined) player.seek(id, startRatio);
    try {
      await el.play();
      return true;
    } catch {
      publishPlayer({ playing: false });
      return false;
    }
  },
  pause(): void {
    if (audio && !audio.paused) audio.pause();
  },
  seek(id: string, ratio: number): void {
    if (!audio || playerState.id !== id || !durationMs) return;
    const t = Math.max(0, Math.min(0.999, ratio)) * (durationMs / 1000);
    try {
      audio.currentTime = t;
      publishPlayer({ t });
    } catch {
      /* fMP4/WebM from MediaRecorder may not be seekable before it is fully buffered */
    }
  },
  cycleRate(): number {
    const rate = RATES[(RATES.indexOf(playerState.rate) + 1) % RATES.length];
    if (audio) audio.playbackRate = rate;
    publishPlayer({ rate });
    return rate;
  },
};

/* ---------- Send to chat ---------- */

export type SendResult = 'sent' | 'write_access' | 'not_uploaded' | 'rate' | 'error';

export async function sendToChat(id: string): Promise<SendResult> {
  if (tg.initDataUnsafe?.user?.allows_write_to_pm === false) {
    const ok = await requestWriteAccess();
    if (!ok) return 'write_access';
  }
  try {
    await api.sendVoice(id);
    return 'sent';
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409 && err.code === 'write_access') return 'write_access';
      if (err.status === 409) return 'not_uploaded';
      if (err.status === 429) return 'rate';
    }
    return 'error';
  }
}
