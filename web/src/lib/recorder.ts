import type { NoteSection } from '@dnevnik/shared';
import { VOICE_MAX_MS, VOICE_MIN_MS } from '@dnevnik/shared';
import { disableClosingConfirmation, enableClosingConfirmation, haptic, platform } from './telegram.ts';
import { player } from './voice.ts';

/*
 * One MediaRecorder for the whole app, driven outside React so a take survives view changes.
 * Every finished take (user stop, 10-minute cap, app going to background) reaches the handler
 * registered by the store; `stop()` additionally resolves for the row that pressed the button.
 */

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'finishing';
export type StopReason = 'user' | 'max' | 'hidden';

export interface RecorderState {
  status: RecorderStatus;
  date: string | null;
  section: NoteSection | null;
  elapsedMs: number;
  /** Last 7 RMS samples, 0..1, for the meter. */
  levels: number[];
}

export interface Take {
  blob: Blob;
  mime: string;
  durationMs: number;
  peaks: string;
}

export interface TakeContext {
  date: string;
  section: NoteSection;
  reason: StopReason;
}

export interface RecorderHandlers {
  onTake(take: Take, ctx: TakeContext): void;
  onError(err: unknown, ctx: TakeContext): void;
}

export type RecorderErrorKey = 'micDenied' | 'micMissing' | 'micBusy' | 'voiceTooShort' | 'voiceError';

const MIME_KEY = 'voice.mime';
const METER_BARS = 7;
const SAMPLE_MS = 50;
const WARN_AT = VOICE_MAX_MS - 30_000;
const STOP_WATCHDOG_MS = 3_000;
const ANDROID_KEEP_MS = 90_000;
const PEAK_BUCKETS = 48;
const PEAK_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

const listeners = new Set<(s: RecorderState) => void>();
let handlers: RecorderHandlers | null = null;

let state: RecorderState = { status: 'idle', date: null, section: null, elapsedMs: 0, levels: new Array(METER_BARS).fill(0) };

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let mime = '';
let t0 = 0;
let samples: number[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;
let warned = false;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let analyserBuf: Uint8Array<ArrayBuffer> | null = null;
let finishing: Promise<Take> | null = null;
let keepTimer: ReturnType<typeof setTimeout> | null = null;

function publish(patch: Partial<RecorderState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function subscribe(l: (s: RecorderState) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getState(): RecorderState {
  return state;
}

export function setRecorderHandlers(h: RecorderHandlers): void {
  handlers = h;
}

export function voiceSupport(): 'ok' | 'unsupported' {
  const ok =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    (typeof isSecureContext === 'undefined' || isSecureContext);
  return ok ? 'ok' : 'unsupported';
}

function isApple(): boolean {
  const p = platform();
  return p === 'ios' || p === 'macos';
}

function isAndroid(): boolean {
  const p = platform();
  return p === 'android' || p === 'android_x';
}

/** Container/codec to record with; an override written by the encoder guard wins. */
export function pickMimeType(): string {
  try {
    const forced = localStorage.getItem(MIME_KEY);
    if (forced) return forced;
  } catch {
    /* storage blocked */
  }
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/mp4;codecs=mp4a.40.2', ...(isApple() ? ['audio/mp4'] : []), 'audio/webm;codecs=opus', 'audio/webm'];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* some WebViews throw on unknown types */
    }
  }
  return '';
}

export function recorderErrorKey(err: unknown): RecorderErrorKey {
  if (err === 'too_short') return 'voiceTooShort';
  if (err === 'encoder') return 'voiceError';
  const name = err instanceof Error ? err.name : typeof err === 'string' ? err : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'micDenied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'micMissing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'micBusy';
  return 'voiceError';
}

/* ---------- Stream lifecycle ---------- */

function releaseStream() {
  if (keepTimer) clearTimeout(keepTimer);
  keepTimer = null;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  void ctx?.close().catch(() => {});
  ctx = null;
  analyser = null;
  analyserBuf = null;
}

/** Android's Telegram shows the mic dialog per getUserMedia call; keep the stream warm between takes. */
function parkStream() {
  if (!stream) return;
  if (!isAndroid()) {
    releaseStream();
    return;
  }
  if (keepTimer) clearTimeout(keepTimer);
  keepTimer = setTimeout(releaseStream, ANDROID_KEEP_MS);
}

function liveStream(): MediaStream | null {
  if (!stream) return null;
  const tracks = stream.getAudioTracks();
  if (tracks.length && tracks.every((t) => t.readyState === 'live')) return stream;
  releaseStream();
  return null;
}

function attachMeter(s: MediaStream) {
  if (analyser && ctx) return;
  try {
    const AC = (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AC) return;
    ctx = ctx ?? new AC();
    void ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(s);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;
    // Never connected to the destination: the meter must not echo the mic to the speaker.
    src.connect(analyser);
    analyserBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  } catch {
    analyser = null;
    analyserBuf = null;
  }
}

function sampleLevel(): number {
  if (!analyser || !analyserBuf) return 0;
  try {
    analyser.getByteTimeDomainData(analyserBuf);
  } catch {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < analyserBuf.length; i++) {
    const v = (analyserBuf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / analyserBuf.length);
  // Speech RMS sits around 0.05–0.3; stretch it so the meter moves visibly.
  return Math.min(1, rms * 3.5);
}

/* ---------- Recording ---------- */

/**
 * Starts a take. Must be called straight from the tap handler: getUserMedia and the AudioContext are
 * requested synchronously so WebViews still count it as a user gesture. Rejects with the raw error.
 */
export function start(date: string, section: NoteSection): Promise<void> {
  if (state.status !== 'idle') return Promise.resolve();
  if (voiceSupport() !== 'ok') return Promise.reject(new Error('unsupported'));
  player.pause();
  publish({ status: 'requesting', date, section, elapsedMs: 0, levels: new Array(METER_BARS).fill(0) });
  const existing = liveStream();
  if (keepTimer) clearTimeout(keepTimer);
  keepTimer = null;
  const request = existing
    ? Promise.resolve(existing)
    : navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
  return request.then(
    (s) => {
      if (state.status !== 'requesting') {
        // Cancelled while the permission dialog was open.
        for (const t of s.getTracks()) t.stop();
        return;
      }
      stream = s;
      try {
        begin(s);
      } catch (err) {
        releaseStream();
        publish({ status: 'idle', date: null, section: null });
        throw err;
      }
    },
    (err) => {
      publish({ status: 'idle', date: null, section: null });
      throw err;
    },
  );
}

function begin(s: MediaStream) {
  const wanted = pickMimeType();
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(s, wanted ? { mimeType: wanted, audioBitsPerSecond: 48_000 } : { audioBitsPerSecond: 48_000 });
  } catch {
    rec = new MediaRecorder(s);
  }
  recorder = rec;
  chunks = [];
  samples = [];
  warned = false;
  finishing = null;
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  rec.onerror = () => {
    if (state.status === 'recording') void finish('user');
  };
  rec.start(1000);
  // The real container may differ from the request (some WebViews ignore mimeType).
  mime = rec.mimeType || wanted || 'audio/webm';
  t0 = performance.now();
  attachMeter(s);
  enableClosingConfirmation();
  publish({ status: 'recording', elapsedMs: 0 });
  tickTimer = setInterval(onTick, SAMPLE_MS);
}

function onTick() {
  if (state.status !== 'recording') return;
  const elapsedMs = performance.now() - t0;
  const level = sampleLevel();
  samples.push(level);
  const levels = state.levels.slice(1).concat(level);
  publish({ elapsedMs, levels });
  if (!warned && elapsedMs >= WARN_AT) {
    warned = true;
    haptic.warning();
  }
  if (elapsedMs >= VOICE_MAX_MS) void finish('max');
}

function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

/** Levels → 48 buckets of the loudest sample each, normalised to the take, one base-36 digit per bucket. */
function encodePeaks(values: number[]): string {
  if (!values.length) return '';
  const max = Math.max(...values);
  if (max <= 0) return '';
  const out: string[] = [];
  const per = values.length / PEAK_BUCKETS;
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    const from = Math.floor(i * per);
    const to = Math.max(from + 1, Math.floor((i + 1) * per));
    let peak = 0;
    for (let j = from; j < to && j < values.length; j++) peak = Math.max(peak, values[j]);
    out.push(PEAK_ALPHABET[Math.min(35, Math.round((peak / max) * 35))]);
  }
  return out.join('');
}

/** Waits for the recorder to flush; a WebView that never fires onstop is finalised from the chunks seen so far. */
function drain(rec: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      resolve();
    };
    const watchdog = setTimeout(settle, STOP_WATCHDOG_MS);
    rec.onstop = settle;
    try {
      if (rec.state !== 'inactive') rec.stop();
      else settle();
    } catch {
      settle();
    }
  });
}

function finish(reason: StopReason): Promise<Take> {
  if (finishing) return finishing;
  const rec = recorder;
  const date = state.date ?? '';
  const section = state.section ?? 'morning';
  const context: TakeContext = { date, section, reason };
  if (!rec || state.status !== 'recording') return Promise.reject('voiceError');
  stopTicking();
  const durationMs = Math.round(performance.now() - t0);
  publish({ status: 'finishing', elapsedMs: durationMs });
  disableClosingConfirmation();
  finishing = (async () => {
    await drain(rec);
    recorder = null;
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    if (durationMs < VOICE_MIN_MS) throw 'too_short';
    if (durationMs > 1_000 && blob.size < 1024 && mime.includes('mp4')) {
      // Some WebViews advertise AAC and then produce empty fragments; switch to Opus for the next take.
      try {
        localStorage.setItem(MIME_KEY, 'audio/webm;codecs=opus');
      } catch {
        /* storage blocked */
      }
      throw 'encoder';
    }
    if (!blob.size) throw 'encoder';
    return { blob, mime, durationMs, peaks: encodePeaks(samples) };
  })();
  const result = finishing;
  void result.then(
    (take) => handlers?.onTake(take, context),
    (err) => handlers?.onError(err, context),
  );
  void result.finally(() => {
    finishing = null;
    samples = [];
    parkStream();
    publish({ status: 'idle', date: null, section: null, elapsedMs: 0, levels: new Array(METER_BARS).fill(0) });
  });
  return result;
}

/** Ends the take. Resolves with it (also delivered to the handlers); rejects with 'too_short' | 'encoder'. */
export function stop(): Promise<Take> {
  return finish('user');
}

/** Discards the take in progress (or the pending permission request). */
export function cancel(): void {
  if (state.status === 'idle') return;
  if (state.status === 'finishing') return;
  stopTicking();
  disableClosingConfirmation();
  const rec = recorder;
  recorder = null;
  chunks = [];
  samples = [];
  if (rec) {
    rec.ondataavailable = null;
    rec.onstop = null;
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch {
      /* already stopped */
    }
  }
  parkStream();
  publish({ status: 'idle', date: null, section: null, elapsedMs: 0, levels: new Array(METER_BARS).fill(0) });
}

/* A take must not be lost when Telegram minimises the app: save it, and let the parked stream go. */
function onHidden() {
  if (state.status === 'recording') void finish('hidden').catch(() => {});
  else if (state.status === 'idle') releaseStream();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHidden();
  });
  window.addEventListener('pagehide', onHidden);
}
