import { and, eq, gt, inArray, like } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { Category, DayNote, Occurrence, SyncRequest, SyncResponse, Task, UserSettings, VoiceNote } from '@dnevnik/shared';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS, hhmmToMinutes } from '@dnevnik/shared';
import {
  categories,
  categoryFromRow,
  categoryToRow,
  dayNotes,
  noteFromRow,
  noteToRow,
  occurrenceFromRow,
  occurrences,
  occurrenceToRow,
  settingsFromRow,
  taskFromRow,
  tasks,
  taskToRow,
  users,
  voiceFromRow,
  voiceNotes,
  voiceToRow,
} from './db/schema.ts';
import type { TelegramUser } from './auth.ts';

export type DB = DrizzleD1Database;

/** D1 allows at most 100 bound parameters per statement. */
const ID_CHUNK = 50;
/** How far behind "now" the pull cursor is set; must exceed the longest concurrent write. */
const CURSOR_OVERLAP_MS = 60_000;

export function getDb(d1: D1Database): DB {
  return drizzle(d1);
}

export function carryRootId(id: string): string {
  return id.split(':carry:')[0];
}

export async function ensureUser(db: DB, tg: TelegramUser): Promise<typeof users.$inferSelect> {
  const now = Date.now();
  const existing = await db.select().from(users).where(eq(users.id, tg.id)).get();
  if (existing) {
    await db
      .update(users)
      .set({ firstName: tg.first_name ?? existing.firstName, username: tg.username ?? existing.username, lastSeen: now })
      .where(eq(users.id, tg.id));
    return { ...existing, lastSeen: now };
  }
  const lang = tg.language_code?.startsWith('ru') ? 'ru' : 'en';
  const settings: UserSettings = { ...DEFAULT_SETTINGS, lang };
  const row = {
    id: tg.id,
    firstName: tg.first_name ?? '',
    username: tg.username ?? null,
    settings: JSON.stringify(settings),
    createdAt: now,
    updatedAt: now,
    lastSeen: now,
  };
  // Concurrent first requests may race here; deterministic ids + do-nothing conflicts keep it idempotent.
  await db.insert(users).values(row).onConflictDoNothing();
  await db
    .insert(categories)
    .values(
      DEFAULT_CATEGORIES.map((c, i) => ({
        id: `${tg.id}:cat:${i}`,
        userId: tg.id,
        name: c.name[lang],
        color: c.color,
        sortOrder: i,
        updatedAt: now,
        syncedAt: now,
        deletedAt: null,
      })),
    )
    .onConflictDoNothing();
  return row;
}

type AnyTable = typeof tasks | typeof occurrences | typeof categories | typeof dayNotes | typeof voiceNotes;

async function upsertLWW<TRow extends { id: string; updatedAt: number }>(
  db: DB,
  table: AnyTable,
  userId: number,
  rows: TRow[],
  syncedAt: number,
  onConflictHook?: (incoming: TRow, existing: { id: string; updatedAt: number; status?: string | null }) => Promise<boolean | void>,
): Promise<void> {
  if (!rows.length) return;
  const existingMap = new Map<string, { id: string; updatedAt: number; status?: string | null }>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const found =
      table === tasks
        ? await db.select({ id: tasks.id, updatedAt: tasks.updatedAt, status: tasks.status }).from(tasks).where(and(eq(tasks.userId, userId), inArray(tasks.id, chunk))).all()
        : await db.select({ id: table.id, updatedAt: table.updatedAt }).from(table).where(and(eq(table.userId, userId), inArray(table.id, chunk))).all();
    for (const e of found) existingMap.set(e.id, e);
  }
  for (const row of rows) {
    const prev = existingMap.get(row.id);
    const withStamp = { ...row, syncedAt } as TRow & { syncedAt: number };
    if (prev === undefined) {
      await db.insert(table).values(withStamp as never).onConflictDoNothing();
    } else {
      let apply = row.updatedAt > prev.updatedAt;
      // The hook may force the write and must then make it win on every device (server clock).
      if (onConflictHook && (await onConflictHook(row, prev)) === true) {
        apply = true;
        (withStamp as { updatedAt: number }).updatedAt = Math.max(row.updatedAt, syncedAt);
      }
      if (apply) {
        await db
          .update(table)
          .set(withStamp as never)
          .where(and(eq(table.id, row.id), eq(table.userId, userId)));
      }
    }
  }
}

export async function loadChangedSince(db: DB, userId: number, since: number) {
  const [t, o, c, n, v] = await Promise.all([
    db.select().from(tasks).where(and(eq(tasks.userId, userId), gt(tasks.syncedAt, since))).all(),
    db.select().from(occurrences).where(and(eq(occurrences.userId, userId), gt(occurrences.syncedAt, since))).all(),
    db.select().from(categories).where(and(eq(categories.userId, userId), gt(categories.syncedAt, since))).all(),
    db.select().from(dayNotes).where(and(eq(dayNotes.userId, userId), gt(dayNotes.syncedAt, since))).all(),
    db.select().from(voiceNotes).where(and(eq(voiceNotes.userId, userId), gt(voiceNotes.syncedAt, since))).all(),
  ]);
  return {
    tasks: t.map(taskFromRow),
    occurrences: o.map(occurrenceFromRow),
    categories: c.map(categoryFromRow),
    notes: n.map(noteFromRow),
    voiceNotes: v.map(voiceFromRow),
  };
}

function sanitizeSettings(s: Partial<UserSettings> | undefined, prev: UserSettings): UserSettings {
  if (!s) return prev;
  const out: UserSettings = { ...prev };
  if (s.lang === 'ru' || s.lang === 'en') out.lang = s.lang;
  if (s.font === 'serif' || s.font === 'sans') out.font = s.font;
  if (typeof s.carryover === 'boolean') out.carryover = s.carryover;
  if (typeof s.haptics === 'boolean') out.haptics = s.haptics;
  if (typeof s.digestEnabled === 'boolean') out.digestEnabled = s.digestEnabled;
  if (typeof s.reportEnabled === 'boolean') out.reportEnabled = s.reportEnabled;
  if (Number.isInteger(s.visibleStart) && s.visibleStart! >= 0 && s.visibleStart! <= 23) out.visibleStart = s.visibleStart!;
  if (Number.isInteger(s.visibleEnd) && s.visibleEnd! >= 1 && s.visibleEnd! <= 24) out.visibleEnd = s.visibleEnd!;
  if (out.visibleEnd <= out.visibleStart) out.visibleEnd = Math.min(24, out.visibleStart + 1);
  if (typeof s.digestMorning === 'string' && hhmmToMinutes(s.digestMorning) !== null) out.digestMorning = s.digestMorning;
  if (typeof s.digestEvening === 'string' && hhmmToMinutes(s.digestEvening) !== null) out.digestEvening = s.digestEvening;
  if (Array.isArray(s.defaultReminders)) out.defaultReminders = s.defaultReminders.filter((n) => Number.isInteger(n) && n >= 0 && n <= 1440).slice(0, 5);
  if (typeof s.tz === 'string' && s.tz.length < 64) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s.tz });
      out.tz = s.tz;
    } catch {
      /* ignore invalid tz */
    }
  }
  return out;
}

/**
 * A client's explicit completion of a task that the server auto-carried must win over the
 * synthetic 'moved' status (whatever the clocks say), and the carried copy must disappear.
 */
async function completionBeatsCarryOver(db: DB, userId: number, incoming: Task, existing: { status?: string | null }, syncedAt: number): Promise<boolean> {
  if (existing.status !== 'moved') return false;
  if (incoming.status !== 'done' && incoming.status !== 'cancelled') return false;
  await db
    .update(tasks)
    .set({ deletedAt: syncedAt, updatedAt: syncedAt, syncedAt })
    .where(and(eq(tasks.userId, userId), like(tasks.id, `${carryRootId(incoming.id)}:carry:%`), eq(tasks.status, 'todo')));
  return true;
}

export async function applySync(db: DB, user: typeof users.$inferSelect, req: SyncRequest): Promise<SyncResponse> {
  const userId = user.id;
  // Cursor is taken before our own writes, with an overlap so a concurrent request or cron tick that
  // stamped its rows slightly earlier but committed later is still delivered next time (LWW makes repeats harmless).
  const cursor = Date.now() - CURSOR_OVERLAP_MS;
  const syncedAt = Date.now();

  await upsertLWW(db, tasks, userId, (req.tasks ?? []).map((t: Task) => taskToRow(t, userId)) as never, syncedAt, (inc, ex) =>
    completionBeatsCarryOver(db, userId, taskFromRow(inc as never), ex, syncedAt),
  );
  await upsertLWW(db, occurrences, userId, (req.occurrences ?? []).map((o: Occurrence) => occurrenceToRow(o, userId)) as never, syncedAt);
  await upsertLWW(db, categories, userId, (req.categories ?? []).map((c: Category) => categoryToRow(c, userId)) as never, syncedAt);
  await upsertLWW(db, dayNotes, userId, (req.notes ?? []).map((n: DayNote) => noteToRow(n, userId)) as never, syncedAt);
  await upsertLWW(db, voiceNotes, userId, (req.voiceNotes ?? []).map((v: VoiceNote) => voiceToRow(v, userId)) as never, syncedAt);

  let settings = settingsFromRow(user.settings);
  if (req.settings) {
    settings = sanitizeSettings(req.settings, settings);
    await db.update(users).set({ settings: JSON.stringify(settings), updatedAt: Date.now() }).where(eq(users.id, userId));
  }

  const changed = await loadChangedSince(db, userId, req.since);
  return {
    ...changed,
    now: cursor,
    settings,
    user: { id: userId, firstName: user.firstName, username: user.username },
  };
}
