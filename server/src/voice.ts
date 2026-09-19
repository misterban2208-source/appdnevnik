import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { GrammyError, InputFile } from 'grammy';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Lang, NoteSection, VoiceNote } from '@dnevnik/shared';
import { VOICE_MAX_BYTES } from '@dnevnik/shared';
import type { Env } from './env.ts';
import { getDb, type DB } from './sync.ts';
import { claim } from './cron.ts';
import { getBot } from './bot.ts';
import { settingsFromRow, users, voiceFromRow, voiceNotes, voiceToRow } from './db/schema.ts';
import { MIME_RE, validateVoiceNote } from './validate.ts';

type Variables = { user: typeof users.$inferSelect };
type VoiceRow = typeof voiceNotes.$inferSelect;

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_MIME = new Set(['audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/opus']);
/** Telegram's Bot API refuses to download files above 20 MB. */
const TG_DOWNLOAD_MAX = 20 * 1024 * 1024;
/** D1 allows at most 100 bound parameters per statement. */
const ID_CHUNK = 50;

export const voiceKey = (userId: number, id: string) => `voice/${userId}/${id}`;

export function extFor(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'audio/x-m4a' || base === 'audio/aac') return 'm4a';
  if (base === 'audio/webm') return 'webm';
  if (base === 'audio/ogg' || base === 'audio/oga' || base === 'audio/opus') return 'ogg';
  if (base === 'audio/mpeg' || base === 'audio/mp3') return 'mp3';
  return 'bin';
}

function mimeBase(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase();
}

function sectionLabel(section: string, lang: Lang): string {
  if (lang === 'ru') return section === 'morning' ? 'Утро' : 'Вечер';
  return section === 'morning' ? 'Morning' : 'Evening';
}

async function findRow(db: DB, userId: number, id: string): Promise<VoiceRow | undefined> {
  return db
    .select()
    .from(voiceNotes)
    .where(and(eq(voiceNotes.id, id), eq(voiceNotes.userId, userId)))
    .get();
}

/** The object is gone from R2 (purged or never landed): forget it so clients stop asking. */
async function forgetBlob(db: DB, userId: number, id: string): Promise<void> {
  await db
    .update(voiceNotes)
    .set({ r2Key: null, uploadedAt: null, syncedAt: Date.now() })
    .where(and(eq(voiceNotes.id, id), eq(voiceNotes.userId, userId)));
}

function contentRange(range: R2Range, size: number): { start: number; end: number } {
  if ('suffix' in range) {
    const suffix = Math.min(range.suffix, size);
    return { start: size - suffix, end: size - 1 };
  }
  const start = range.offset ?? 0;
  const end = range.length !== undefined ? start + range.length - 1 : size - 1;
  return { start, end: Math.min(end, size - 1) };
}

export const voiceRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---- PUT /:id/blob — upload bytes; creates the metadata row when the debounced sync has not landed yet ----
voiceRoutes.put(
  '/:id/blob',
  bodyLimit({ maxSize: VOICE_MAX_BYTES, onError: (c) => c.json({ error: 'too_large' }, 413) }),
  async (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'not found' }, 404);
    const mime = (c.req.header('content-type') ?? '').trim();
    if (!ALLOWED_MIME.has(mimeBase(mime)) || mime.length > 64) return c.json({ error: 'unsupported_media' }, 415);
    const lengthHeader = c.req.header('content-length');
    const length = lengthHeader === undefined ? null : Number(lengthHeader);
    if (length !== null && (!Number.isFinite(length) || length > VOICE_MAX_BYTES)) return c.json({ error: 'too_large' }, 413);
    if (length === 0) return c.json({ error: 'empty' }, 400);

    const user = c.get('user');
    const db = getDb(c.env.DB);
    const now = Date.now();
    let row = await findRow(db, user.id, id);
    if (!row) {
      const q = c.req.query();
      const createdAt = Number(q.createdAt);
      const note = validateVoiceNote(
        {
          id,
          date: q.date,
          section: q.section,
          mime,
          duration: Number(q.duration ?? 0),
          size: 0,
          peaks: q.peaks ?? '',
          source: 'app',
          createdAt,
          updatedAt: createdAt,
          deletedAt: null,
        },
        now,
      );
      await db
        .insert(voiceNotes)
        .values({ ...voiceToRow(note, user.id), syncedAt: now })
        .onConflictDoNothing();
      // Re-read instead of trusting our insert: a concurrent /api/sync may have created the row first.
      row = await findRow(db, user.id, id);
      if (!row) return c.json({ error: 'internal' }, 500);
    }
    if (row.deletedAt !== null) return c.json({ error: 'deleted' }, 410);
    if (row.uploadedAt !== null) return c.json({ note: voiceFromRow(row) });
    if (!c.env.VOICE) return c.json({ error: 'storage' }, 503);

    const key = voiceKey(user.id, id);
    let size: number;
    try {
      // R2 needs a known length: a Content-Length request body streams, anything else is buffered first.
      const body = length !== null && c.req.raw.body ? c.req.raw.body : await c.req.arrayBuffer();
      const obj = await c.env.VOICE.put(key, body, {
        httpMetadata: { contentType: mime },
        customMetadata: { userId: String(user.id), noteId: id, date: row.date, section: row.section },
      });
      size = obj.size;
    } catch (err) {
      console.error('voice put failed', id, err);
      return c.json({ error: 'storage' }, 503);
    }
    const stamp = Date.now();
    const patch = { r2Key: key, uploadedAt: stamp, size, mime, syncedAt: stamp };
    await db
      .update(voiceNotes)
      .set(patch)
      .where(and(eq(voiceNotes.id, id), eq(voiceNotes.userId, user.id)));
    return c.json({ note: voiceFromRow({ ...row, ...patch }) });
  },
);

// ---- GET /:id/blob — stream bytes with native R2 range support ----
voiceRoutes.get('/:id/blob', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const row = await findRow(db, user.id, id);
  if (!row || row.deletedAt !== null || !row.r2Key) return c.json({ error: 'not found' }, 404);
  if (!c.env.VOICE) return c.json({ error: 'not found' }, 404);

  // Only hand the headers to R2 when a Range was actually asked for: some runtimes report a
  // full-body range otherwise, which would turn every plain download into a 206.
  const wantsRange = !!c.req.header('range');
  let obj: R2ObjectBody | null;
  try {
    obj = await c.env.VOICE.get(row.r2Key, wantsRange ? { range: c.req.raw.headers } : undefined);
  } catch (err) {
    // R2 throws on an unsatisfiable Range header.
    console.warn('voice range rejected', id, err instanceof Error ? err.message : err);
    return c.body(null, 416, { 'Content-Range': `bytes */${row.size}` });
  }
  if (obj === null) {
    await forgetBlob(db, user.id, id);
    return c.json({ error: 'not found' }, 404);
  }

  const headers = new Headers({
    'Content-Type': row.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="voice-${row.date}-${row.section}.${extFor(row.mime)}"`,
    ETag: obj.httpEtag,
  });
  let status = 200;
  if (wantsRange && obj.range) {
    const { start, end } = contentRange(obj.range, obj.size);
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('Content-Length', String(end - start + 1));
  } else {
    headers.set('Content-Length', String(obj.size));
  }
  return c.body(obj.body, status as 200 | 206, Object.fromEntries(headers.entries()));
});

// ---- POST /:id/send — a copy to the user's own bot chat ----
voiceRoutes.post('/:id/send', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const row = await findRow(db, user.id, id);
  if (!row || row.deletedAt !== null) return c.json({ error: 'not found' }, 404);
  if (!c.env.BOT_TOKEN) return c.json({ error: 'bot_not_configured' }, 503);
  if (!(await claim(db, `voicesend:${user.id}:${Math.floor(Date.now() / 10_000)}`))) return c.json({ error: 'rate', retryAfter: 10 }, 429);

  const lang = settingsFromRow(user.settings).lang;
  const caption = `${row.date} · ${sectionLabel(row.section, lang)}`;
  const api = getBot(c.env).api;
  const asDocument = { caption, disable_content_type_detection: true } as const;
  try {
    if (row.tgFileId) {
      // A file_id keeps its Telegram type: voice → audio → document until one of them accepts it.
      const fileId = row.tgFileId;
      try {
        await api.sendVoice(user.id, fileId, { caption });
      } catch (err) {
        if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
        try {
          await api.sendAudio(user.id, fileId, { caption });
        } catch (err2) {
          if (!(err2 instanceof GrammyError) || err2.error_code !== 400) throw err2;
          await api.sendDocument(user.id, fileId, asDocument);
        }
      }
    } else if (row.r2Key && c.env.VOICE) {
      const obj = await c.env.VOICE.get(row.r2Key);
      if (!obj) {
        await forgetBlob(db, user.id, id);
        return c.json({ error: 'not_uploaded' }, 409);
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const ext = extFor(row.mime);
      // An InputFile is consumed by one request, so the fallback needs a fresh instance.
      const file = () => new InputFile(bytes, `voice-${row.date}-${row.section}.${ext}`);
      if (ext === 'm4a' || ext === 'ogg' || ext === 'mp3') {
        try {
          await api.sendVoice(user.id, file(), { duration: Math.round(row.duration / 1000), caption });
        } catch (err) {
          if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
          await api.sendDocument(user.id, file(), asDocument);
        }
      } else {
        await api.sendDocument(user.id, file(), asDocument);
      }
    } else {
      return c.json({ error: 'not_uploaded' }, 409);
    }
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.error_code === 403) return c.json({ error: 'write_access' }, 409);
      if (err.error_code === 429) return c.json({ error: 'rate', retryAfter: err.parameters.retry_after ?? 5 }, 429);
      console.error('voice send failed', id, err.description);
      return c.json({ error: 'telegram' }, 502);
    }
    console.error('voice send failed', id, err);
    return c.json({ error: 'storage' }, 503);
  }
  return c.json({ ok: true });
});

// ---- Bot import ----

export interface ImportVoiceParams {
  fileId: string;
  fileUniqueId: string;
  mime: string;
  durationSec: number;
  size: number;
  date: string;
  section: NoteSection;
  /** Telegram message date, seconds. */
  sentAt: number;
}

export type ImportVoiceResult = { ok: true; note: VoiceNote } | { ok: false; reason: 'too_big' | 'storage' | 'fetch' };

/** Copies a Telegram voice/audio file into R2 and creates the note row. Idempotent per Telegram file. */
export async function importVoice(env: Env, db: DB, userId: number, p: ImportVoiceParams): Promise<ImportVoiceResult> {
  const existing = await db
    .select()
    .from(voiceNotes)
    .where(and(eq(voiceNotes.userId, userId), eq(voiceNotes.tgFileUniqueId, p.fileUniqueId)))
    .get();
  if (existing) return { ok: true, note: voiceFromRow(existing) };
  if (!env.VOICE) return { ok: false, reason: 'storage' };
  if (p.size > TG_DOWNLOAD_MAX) return { ok: false, reason: 'too_big' };

  const file = await getBot(env).api.getFile(p.fileId);
  if (!file.file_path) return { ok: false, reason: 'too_big' };
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) {
    console.error('voice download failed', res.status);
    return { ok: false, reason: 'fetch' };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > VOICE_MAX_BYTES) return { ok: false, reason: 'too_big' };

  const id = crypto.randomUUID();
  const key = voiceKey(userId, id);
  const mime = (MIME_RE.test(p.mime) ? p.mime : 'audio/ogg').slice(0, 64);
  const now = Date.now();
  await env.VOICE.put(key, buf, {
    httpMetadata: { contentType: mime },
    customMetadata: { userId: String(userId), noteId: id, date: p.date, section: p.section },
  });
  const row: typeof voiceNotes.$inferInsert = {
    id,
    userId,
    date: p.date,
    section: p.section,
    mime,
    duration: Math.max(0, Math.round(p.durationSec * 1000)),
    size: buf.byteLength,
    peaks: '',
    source: 'bot',
    createdAt: p.sentAt * 1000,
    updatedAt: now,
    syncedAt: now,
    deletedAt: null,
    r2Key: key,
    uploadedAt: now,
    tgFileId: p.fileId,
    tgFileUniqueId: p.fileUniqueId,
  };
  const ins = await db.insert(voiceNotes).values(row).onConflictDoNothing().run();
  if ((ins.meta?.changes ?? 0) === 0) {
    // Lost the race against a redelivered update: keep the winner's row, drop our orphan object.
    await env.VOICE.delete(key).catch(() => {});
    const winner = await db
      .select()
      .from(voiceNotes)
      .where(and(eq(voiceNotes.userId, userId), eq(voiceNotes.tgFileUniqueId, p.fileUniqueId)))
      .get();
    if (winner) return { ok: true, note: voiceFromRow(winner) };
    return { ok: false, reason: 'storage' };
  }
  return { ok: true, note: voiceFromRow({ ...row, syncedAt: now } as VoiceRow) };
}


// ---- Cron purge ----

/** Frees R2 objects of notes tombstoned before `cutoff`; the tombstones themselves stay for sync. */
export async function purgeDeletedVoice(env: Env, db: DB, cutoff: number): Promise<void> {
  if (!env.VOICE) return;
  const rows = await db
    .select({ id: voiceNotes.id, r2Key: voiceNotes.r2Key })
    .from(voiceNotes)
    .where(and(isNotNull(voiceNotes.deletedAt), lt(voiceNotes.deletedAt, cutoff), isNotNull(voiceNotes.r2Key)))
    .limit(500)
    .all();
  if (!rows.length) return;
  await env.VOICE.delete(rows.map((r) => r.r2Key!));
  const now = Date.now();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    await db
      .update(voiceNotes)
      .set({ r2Key: null, uploadedAt: null, syncedAt: now })
      .where(inArray(voiceNotes.id, ids.slice(i, i + ID_CHUNK)));
  }
}
