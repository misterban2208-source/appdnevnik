# Voice notes — implementation contract

Voice notes attach to a day's **morning** or **evening** section (next to the text notes in `DayNotes.tsx`).
Decision (design panel + judges): **local-first**. Bytes live on the device (Dexie) and play instantly and offline;
a copy goes to Cloudflare **R2** through the Worker so other devices can fetch it; metadata is a fifth synced entity
that rides the existing `/api/sync` last-write-wins protocol. Voice messages sent to the bot chat are saved immediately
into the day notes with correction buttons. No transcoding anywhere.

Shared types and i18n keys are already in the repo (`shared/src/types.ts`, `web/src/i18n/index.ts`). Do not rename them.

## 1. Data model

`shared/src/types.ts` (already added):

```ts
export type NoteSection = 'morning' | 'evening';
export type VoiceSource = 'app' | 'bot';
export interface VoiceNote {
  id: string;            // uuid v4 (client) or crypto.randomUUID() (Worker, bot import)
  userId: number;
  date: string;          // YYYY-MM-DD, same local-date semantics as DayNote
  section: NoteSection;
  mime: string;          // exact MediaRecorder.mimeType or Telegram mime_type, <= 64 chars
  duration: number;      // milliseconds (timer-measured)
  size: number;          // bytes (server overwrites with the real length on upload)
  peaks: string;         // 48 chars [0-9a-z] loudness buckets, '' when unknown
  source: VoiceSource;
  createdAt: number;
  updatedAt: number;     // LWW clock, client-owned
  deletedAt: number | null;
  uploadedAt: number | null; // SERVER-OWNED: set by PUT blob / bot import; null after purge. Clients send it but the server ignores it.
}
export const VOICE_MAX_MS = 600_000;   // 10 minutes hard cap
export const VOICE_MIN_MS = 700;
export const VOICE_MAX_BYTES = 25 * 1024 * 1024;
SyncPayload gains `voiceNotes: VoiceNote[]` (server treats a missing array as []).
```

`server/migrations/0002_voice.sql` (0001 already exists):

```sql
CREATE TABLE IF NOT EXISTS voice_notes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  section TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  peaks TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'app',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL DEFAULT 0,   -- server receive stamp, the pull cursor (same as other tables)
  deleted_at INTEGER,
  r2_key TEXT,                            -- server-owned
  uploaded_at INTEGER,                    -- server-owned
  tg_file_id TEXT,                        -- server-owned
  tg_file_unique_id TEXT                  -- server-owned
);
CREATE INDEX IF NOT EXISTS idx_voice_user_synced ON voice_notes(user_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_voice_user_date ON voice_notes(user_id, date);
CREATE INDEX IF NOT EXISTS idx_voice_purge ON voice_notes(deleted_at) WHERE deleted_at IS NOT NULL AND r2_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_tg_unique ON voice_notes(user_id, tg_file_unique_id) WHERE tg_file_unique_id IS NOT NULL;
```

Drizzle: `voiceNotes` table in `db/schema.ts`; `voiceFromRow` (never exposes r2_key / tg ids; exposes `uploadedAt`);
`voiceToRow(v, userId)` returns only client-owned columns (id, userId, date, section, mime, duration, size, peaks, source,
createdAt, updatedAt, deletedAt) so `upsertLWW` can never clear `r2_key`, `uploaded_at` or the tg ids.

## 2. Sync (metadata)

- `validate.ts`: `validateVoiceNote(v, now)` (uuid regex `^[0-9a-f-]{36}$` case-insensitive, ISO date, section enum,
  mime `/^audio\/[\w.+-]+(;[\w=.\s"-]+)?$/` and length <= 64, duration integer 0..3_600_000, size integer >= 0,
  peaks string <= 48 chars, source 'app'|'bot', createdAt/updatedAt/deletedAt via the existing `timestamp()` clamp).
  `validateSyncRequest` gains `voiceNotes: list(o.voiceNotes, 'voiceNotes', validateVoiceNote)`.
- `sync.ts`: `upsertLWW(db, voiceNotes, userId, rows, syncedAt)` exactly like the other tables (the generic function
  already stamps `syncedAt`). `loadChangedSince` adds `voiceNotes` filtered by `synced_at > since`. `SyncResponse.voiceNotes`.
- Every server-side change to server-owned columns (upload, bot import, purge, 404 self-heal) sets `synced_at = Date.now()`
  and **never touches `updated_at`** (otherwise a concurrent client delete could be out-ranked).
- Client merge rule (`web/src/lib/sync.ts`, replaces the generic merge for this table):
  `base = incoming.updatedAt > local.updatedAt ? incoming : local; uploadedAt = incoming.uploadedAt ?? base.uploadedAt ?? null;`
  put `{...base, uploadedAt}` when anything changed.

## 3. Server endpoints (`server/src/voice.ts`, mounted in `index.ts` AFTER the auth middleware)

The global `bodyLimit({ maxSize: 1 MB })` must be scoped to `/api/sync` and `/api/export/*` (or registered after the
voice routes). Voice blob route gets its own `bodyLimit({ maxSize: VOICE_MAX_BYTES })`.

Helpers: `voiceKey = (userId, id) => `voice/${userId}/${id}``; `ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`;
`extFor(mime)`: mp4/m4a → m4a, webm → webm, ogg/oga/opus → ogg, mpeg/mp3 → mp3, else bin.
Allowed mime base types: audio/mp4, audio/webm, audio/ogg, audio/mpeg, audio/aac, audio/x-m4a, audio/opus.

### PUT `/api/voice/:id/blob?date=YYYY-MM-DD&section=morning|evening&duration=<ms>&createdAt=<ms>&peaks=<48 chars>`
Body: raw bytes. Headers: `Content-Type: <mime>` (may include codecs), `Content-Length`.
1. `:id` must match ID_RE else 404. Mime base type must be allowed else 415. `Content-Length` > VOICE_MAX_BYTES → 413.
2. Row lookup by (id, user.id). Missing → **create it** from the query params (validated with the same rules as
   validateVoiceNote; missing/invalid params → 400) with `source='app'`, `updatedAt = createdAt`, `synced_at = now`.
   The upload therefore never depends on the debounced /api/sync push having landed first.
3. `deleted_at` set → 410 `{error:'deleted'}`. `uploaded_at` already set → 200 `{note}` without writing (idempotent).
4. `env.VOICE.put(key, body, { httpMetadata: { contentType: mime }, customMetadata: { userId, noteId, date, section } })`.
   Use `c.req.raw.body` when `Content-Length` is present, else `await c.req.arrayBuffer()` (R2 needs a known length).
5. `UPDATE voice_notes SET r2_key, uploaded_at = now, size = <bytes>, mime = <header mime>, synced_at = now WHERE id AND user_id`
   (updated_at untouched). Return 200 `{ note: voiceFromRow(row) }`. R2 failure → 503 `{error:'storage'}`.

### GET `/api/voice/:id/blob`
Row must exist for (id, user.id), not deleted, `r2_key` set → else 404.
`const obj = await env.VOICE.get(row.r2Key, { range: c.req.raw.headers })` inside try/catch; R2 range error → 416 with
`Content-Range: bytes */<size>`. `obj === null` → set `r2_key = NULL, uploaded_at = NULL, synced_at = now` (self-heal) and 404.
Headers: `Content-Type: row.mime`, `Content-Length`, `Accept-Ranges: bytes`, `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="voice-<date>-<section>.<ext>"`, `ETag: obj.httpEtag`;
when `obj.range` is set answer 206 with `Content-Range` built from the offset/length/suffix shapes. Stream `obj.body`.

### POST `/api/voice/:id/send`
Sends a copy to the user's own chat. Bot-sourced (tg_file_id set) → `sendVoice(user.id, tgFileId, { caption })`.
Else r2_key set → fetch bytes (<= 25 MB) → `sendVoice(new InputFile(bytes, filename), { duration: round(ms/1000), caption })`
for m4a/ogg/mp3, on a Telegram 400 fall back to `sendDocument(..., { disable_content_type_detection: true })`;
webm goes straight to sendDocument. No bytes anywhere → 409 `{error:'not_uploaded'}`. GrammyError 403 → 409 `{error:'write_access'}`;
429 → 429 `{error:'rate', retryAfter}`; other → 502. Caption: `${date} · ${lang==='ru' ? (section==='morning'?'Утро':'Вечер') : (section==='morning'?'Morning':'Evening')}`.
Rate limit: reuse `claim(db, `voicesend:${user.id}:${Math.floor(Date.now()/10_000)}`)` → 429 when busy.

### Cron purge (in `cron.ts`, after the per-user loop)
`if (await claim(db, `voicepurge:${Math.floor(at.getTime()/3_600_000)}`)) await purgeDeletedVoice(env, db, at.getTime() - 24*3_600_000)`
→ select up to 500 rows with `deleted_at < cutoff AND r2_key IS NOT NULL`, `env.VOICE.delete(keys)`, then
`UPDATE ... SET r2_key = NULL, uploaded_at = NULL, synced_at = now WHERE id IN (...)`. Skip silently when `env.VOICE` is undefined.

### Env / config
`env.ts`: `VOICE?: R2Bucket` (optional: the app must still work without the binding; PUT → 503 `{error:'storage'}`, GET → 404).
`wrangler.toml`: `[[r2_buckets]] binding = "VOICE" bucket_name = "dnevnik-voice"`. README: `npx wrangler r2 bucket create dnevnik-voice`
and a note that enabling R2 may ask for a payment method even on the free tier.

## 4. Bot (`server/src/bot.ts` + `importVoice` in `voice.ts`)

- `message:voice` and `message:audio` in a private chat: size > 20 MB → reply `voiceTooBig`. Otherwise decide the section:
  caption keywords (`утро|morning` → morning, `вечер|evening` → evening, `вчера|yesterday` → yesterday evening), else
  local time before 15:00 → morning, else evening. Reply immediately with `voiceSaving` (reply to the voice message), then run
  `importVoice` inside `waitUntil` and edit the reply to `voiceSaved(section, date)` with inline buttons:
  `→ Утро` / `→ Вечер` (whichever is not current), `← Вчера` (if date is today) / `Сегодня →` (if yesterday), `Удалить`.
  Callback data `v:<uuid>:<m|e|y|t|d>` (<= 64 bytes). On failure edit to `voiceFailed`.
- `importVoice(env, db, user, { fileId, fileUniqueId, mime, durationSec, size, date, section, sentAt })`:
  dedupe on (user_id, tg_file_unique_id) → return existing; `getFile` → no file_path → 'too_big'; fetch
  `https://api.telegram.org/file/bot<token>/<file_path>` → arrayBuffer; `env.VOICE.put(key, buf, ...)`; insert row with
  `source='bot'`, `peaks=''`, `duration = durationSec*1000`, `createdAt = sentAt*1000`, `updatedAt = now`, `synced_at = now`,
  `r2_key`, `uploaded_at = now`, tg ids, `.onConflictDoNothing()`. Without `env.VOICE` reply `voiceFailed`.
- Callback handler: `m`/`e` → update section (+ `updated_at = now`, `synced_at = now`), `y`/`t` → date ±1 day, `d` → `deleted_at = now`
  (+ updated_at/synced_at); `answerCallbackQuery` and edit the message text/keyboard accordingly.
- Per-request `waitUntil`: `getBot(env)` is cached per isolate, so set the current ExecutionContext through a module-level
  setter called by the webhook route (`setWaitUntil(c.executionCtx.waitUntil.bind(c.executionCtx))`) and read it inside handlers;
  fall back to awaiting when absent.
- Strings to add to `T` (both languages): voiceSaving, voiceSaved(section, date), voiceFailed, voiceTooBig, voiceDeleted,
  voiceMorningBtn ('☀️ Утро'), voiceEveningBtn ('🌙 Вечер'), voiceYesterdayBtn ('← Вчера'), voiceTodayBtn ('Сегодня →'),
  voiceDeleteBtn ('Удалить'). `/help` gains one line about voice messages.

## 5. Web

### Dexie (`lib/db.ts`, version 2)
`voiceNotes: 'id, date, updatedAt, [date+section]'`, `voiceBlobs: 'id'` rows `{ id, mime, bytes: ArrayBuffer, touchedAt }`,
`voiceQueue: 'id, nextAt'` rows `{ id, attempts, nextAt, lastError, permanent }`. `OutboxEntry.table` gains `'voiceNotes'`.

### `lib/recorder.ts` (singleton, outside React)
- `voiceSupport(): 'ok' | 'unsupported'` = `navigator.mediaDevices?.getUserMedia && MediaRecorder && isSecureContext`.
- `pickMimeType()` probe order: `audio/mp4;codecs=mp4a.40.2`, then `audio/mp4` only when `tg.platform` is `ios`/`macos`,
  then `audio/webm;codecs=opus`, `audio/webm`, `''`. A `localStorage['voice.mime']` override (set by the broken-encoder guard)
  wins when present. Store the real `recorder.mimeType` after start.
- State machine `idle → requesting → recording → finishing → idle`, `subscribe(listener)` + `getState()` returning
  `{ status, date, section, elapsedMs, levels: number[] }`.
- `start(date, section)` synchronous from the tap: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })`,
  `new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 })`, `recorder.start(1000)`, `t0 = performance.now()`.
  Optional `AudioContext` + `AnalyserNode` for a 7-bar meter (guarded; never connected to destination); 50 ms RMS sampling into `levels`.
  Call `tg.enableClosingConfirmation()` (guarded, version >= 6.2) while recording, disable on stop/cancel.
- `stop()` → resolves `{ blob, mime, durationMs, peaks }`; watchdog: if `onstop` has not fired 3 s after `stop()`, finalize from the chunks received.
  Takes < VOICE_MIN_MS → reject with `'too_short'`. Hard cap VOICE_MAX_MS: warning haptic at 9:30, auto-stop at 10:00.
  Broken-encoder guard: blob < 1 KB for a take > 1 s and mime contains 'mp4' → set `localStorage['voice.mime']='audio/webm;codecs=opus'`, reject `'encoder'`.
- `cancel()` discards. `document.visibilitychange → hidden` and `pagehide` while recording → `stop()` (save).
- Stream release: iOS/macOS/desktop stop tracks after every take; Android (`tg.platform` android/android_x) keep the stream for 90 s idle
  (and stop it on visibility hidden) so Telegram's dialog is not shown per take.
- Error mapping `recorderErrorKey(err)`: NotAllowedError|SecurityError → `micDenied`, NotFoundError|OverconstrainedError → `micMissing`,
  NotReadableError|AbortError → `micBusy`, 'too_short' → `voiceTooShort`, 'encoder' → `voiceError`, else `voiceError`.
- Peaks: downsample `levels` to 48 buckets, each mapped to `0-9a-z` (36 levels).

### `lib/voice.ts`
- `voiceState(note, local)` → `'local' | 'uploading' | 'synced' | 'remote' | 'downloading' | 'pending_elsewhere' | 'error'`.
- Blob URL LRU (max 30) `urlFor(id)`; revoke on eviction/delete.
- Upload queue `pumpVoiceUploads()` single-flight sequential: pick `voiceQueue` rows with `nextAt <= now && !permanent`;
  skip/drop when note missing/deleted/uploaded/no blob; `api.uploadVoice(note, bytes, onProgress)` (XHR so `upload.onprogress` works);
  success → update note `uploadedAt`, `size` locally (no outbox entry, no updatedAt change), delete queue row;
  404 → retry in 5 s; 410/413/415 → permanent + error; else backoff `min(30s·2^attempts, 30 min)` with ±20 % jitter, 429 honours Retry-After;
  network error → stop pumping until the next trigger. Triggers: after `addVoiceNote`, `online`, `visibilitychange → visible`,
  after every successful sync, at init.
- `reconcileVoice()` at init and after each sync: enqueue live un-uploaded notes with bytes and no queue row; drop stale rows;
  delete blobs of notes tombstoned > 60 s ago; cache budget: if total blob bytes > 60 MB evict uploaded blobs by `touchedAt` down to 40 MB.
- `ensureVoiceBytes(id)`: local hit → bytes; else if `uploadedAt` and online → download (`api.downloadVoice`), store (QuotaExceeded → memory only).
  404 → local `uploadedAt = null` (no outbox). Prefetch after sync for `currentDate` and `today`: at most 3 blobs, <= 10 MB total.
- Player singleton: one `<audio>` element (`preload='auto'`), `play(id)`, `pause()`, `seek(id, ratio)`, `cycleRate()` 1 → 1.5 → 2 → 1,
  state `{ id, playing, t }` published via subscribe; progress uses the stored duration (audio.duration is Infinity for fMP4/WebM).
  One note at a time; starting a recording pauses playback.
- `sendToChat(id)`: if `tg.initDataUnsafe.user?.allows_write_to_pm === false` call `tg.requestWriteAccess()` first; on 409 write_access show `voiceWriteAccess`.

### `lib/api.ts` additions
`uploadVoice(note, bytes, onProgress)` → XHR PUT `/api/voice/:id/blob?date&section&duration&createdAt&peaks` with `Authorization: tma` header,
`Content-Type: note.mime`, resolves `{ note }`, rejects `ApiError(status)`. `downloadVoice(id)` → `fetch` with the auth header → ArrayBuffer.
`sendVoice(id)` → POST.

### Store (`store/index.ts`)
State: `voiceNotes: Record<string, VoiceNote>`, `voiceLocal: Record<string, { hasBlob: boolean; inFlight: boolean; progress: number; downloading: boolean; error: string | null }>`.
Actions: `addVoiceNote(date, section, take)` (uuid, write note + blob in one Dexie transaction, outbox entry, `pumpVoiceUploads()`),
`deleteVoiceNote(id)` (tombstone + outbox + toast `voiceDeleted` with undo → `restoreVoiceNote`), `restoreVoiceNote(id)`,
`setVoiceLocal(id, patch)`. `init()` loads voiceNotes, calls `reconcileVoice()`, `navigator.storage?.persist?.()`, then `pumpVoiceUploads()`.
`sync()` merges voiceNotes with the monotonic rule and then calls `reconcileVoice()` + `pumpVoiceUploads()` + prefetch.
`persist()` accepts `'voiceNotes'`.

### UI (`components/VoiceSection.tsx`, rendered by `DayNotes.tsx` under each textarea)
- Pills: one per live note sorted by createdAt; `row-wrap` + `row-bg` + `drag="x"` swipe-to-delete exactly like `TaskRow`
  (onDirectionLock + offset check + click suppression). Content: play/pause button (30 px circle, gold on gold-soft), 48-bar waveform
  from `peaks` (flat 2 px line when ''), gold fill by progress (clip-path), `mm:ss` (elapsed while playing, else duration),
  `IconChat` glyph for bot notes, playback-rate chip while playing (`1×/1.5×/2×`), 2 px gold progress line along the bottom while uploading,
  a small `--danger` dot on permanent error (tap → toast `voiceUploadFailed` with `retry`). Nothing when synced.
- Per state: `remote` → download icon (tap: download then auto-play); `downloading` → 3-dot loader; `pending_elsewhere` → greyed pill,
  tap → toast `voicePendingElsewhere`; unplayable mime (`canPlayType(mime) === ''`) → send icon → `sendToChat` (toast `voiceUnplayable` first time).
- Recorder row (min-height 34 px): idle → right-aligned 34 px mic circle (gold outline); unsupported → dimmed mic, tap → toast `voiceUnsupported`;
  requesting → mic pulsing; recording → left `rec-bar` (gold-soft) with cancel X, 7-bar meter (`motion.div` heights), `m:ss` timer
  (gold-2 from 9:30), right filled gold stop button with a pulsing ring (`@keyframes rec-pulse`, disabled under prefers-reduced-motion);
  finishing → stop button disabled with a loader. Errors → `.voice-hint` (12 px danger) for 6 s.
- Haptics: start medium, stop rigid, cancel light, saved success, max warning, delete medium, play/pause/download selection, errors error.
- Animations: `reveal()` entrance, `layout`, pill exit collapse (as TaskRow), meter bars animate height.
- Icons to add: IconMic, IconStop, IconPause, IconDownload, IconSend, IconChat, IconAlert (24-box stroke style as the others).
- CSS in `styles/global.css`: `.voice`, `.voice-rec`, `.mic-btn` (+ `.wait`, `.rec`, `.off`), `.rec-bar`, `.rec-meter`, `.rec-time`,
  `.voice-pill` and children (`.vp-btn`, `.vp-wave`, `.vp-fill`, `.vp-time`, `.vp-rate`, `.vp-progress`, `.vp-err`), `.voice-hint`,
  keyframes `rec-pulse`, reduced-motion rule.
- i18n keys already present in `i18n/index.ts` (voiceNotes, record, recording, stop, voiceSaved, voiceDeleted, voiceTooShort, voiceMaxLength,
  micDenied, micMissing, micBusy, voiceError, voiceUnsupported, voiceLocalOnly, voiceUploading, voiceRemote, voicePendingElsewhere,
  voiceUnplayable, voiceSendToChat, voiceSent, voiceWriteAccess, voiceUploadFailed, voiceDownloadFailed, retry, storageFull, fromChat).

## 6. Test plan (integration agent)
1. `npm run typecheck` in every workspace, `npm test` in shared, `npx vite build` in web, `npx wrangler deploy --dry-run` in server.
2. `npx wrangler d1 migrations apply dnevnik --local` (0002 applies on top of 0000/0001).
3. With `wrangler dev` + `.dev.vars` (DEV_USER_ID=1): `curl -X PUT 'http://127.0.0.1:8787/api/voice/<uuid>/blob?date=2026-09-19&section=morning&duration=1500&createdAt=<ms>' -H 'content-type: audio/mp4' --data-binary @<small file>` → 200 with note;
   repeat → 200 idempotent; `curl -o out.bin http://127.0.0.1:8787/api/voice/<uuid>/blob` → same bytes, `curl -r 0-99` → 206; `POST /api/sync` `{since:0}` returns the note with `uploadedAt`.
4. Browser (Vite dev, DEV_USER_ID): record a note, pill appears with waveform, play/pause, swipe delete + undo, reload → still there, offline (DevTools) → record + play still work.
