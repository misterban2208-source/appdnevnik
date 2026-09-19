import { and, eq, gt, inArray } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { Category, DayNote, Occurrence, SyncRequest, SyncResponse, Task, UserSettings } from '@dnevnik/shared';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '@dnevnik/shared';
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
} from './db/schema.ts';
import type { TelegramUser } from './auth.ts';

export type DB = DrizzleD1Database;

export function getDb(d1: D1Database): DB {
  return drizzle(d1);
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
        deletedAt: null,
      })),
    )
    .onConflictDoNothing();
  return row;
}

async function upsertLWW<TRow extends { id: string; updatedAt: number }>(
  db: DB,
  table: typeof tasks | typeof occurrences | typeof categories | typeof dayNotes,
  userId: number,
  rows: TRow[],
): Promise<void> {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const existing = await db
    .select({ id: table.id, updatedAt: table.updatedAt })
    .from(table)
    .where(and(eq(table.userId, userId), inArray(table.id, ids)))
    .all();
  const existingMap = new Map(existing.map((e) => [e.id, e.updatedAt]));
  for (const row of rows) {
    const prev = existingMap.get(row.id);
    if (prev === undefined) {
      await db.insert(table).values(row as never).onConflictDoNothing();
    } else if (row.updatedAt > prev) {
      await db
        .update(table)
        .set(row as never)
        .where(and(eq(table.id, row.id), eq(table.userId, userId)));
    }
  }
}

export async function loadChangedSince(db: DB, userId: number, since: number) {
  const [t, o, c, n] = await Promise.all([
    db.select().from(tasks).where(and(eq(tasks.userId, userId), gt(tasks.updatedAt, since))).all(),
    db.select().from(occurrences).where(and(eq(occurrences.userId, userId), gt(occurrences.updatedAt, since))).all(),
    db.select().from(categories).where(and(eq(categories.userId, userId), gt(categories.updatedAt, since))).all(),
    db.select().from(dayNotes).where(and(eq(dayNotes.userId, userId), gt(dayNotes.updatedAt, since))).all(),
  ]);
  return {
    tasks: t.map(taskFromRow),
    occurrences: o.map(occurrenceFromRow),
    categories: c.map(categoryFromRow),
    notes: n.map(noteFromRow),
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
  if (typeof s.digestMorning === 'string' && /^\d{2}:\d{2}$/.test(s.digestMorning)) out.digestMorning = s.digestMorning;
  if (typeof s.digestEvening === 'string' && /^\d{2}:\d{2}$/.test(s.digestEvening)) out.digestEvening = s.digestEvening;
  if (Array.isArray(s.defaultReminders)) out.defaultReminders = s.defaultReminders.filter((n) => Number.isInteger(n) && n >= 0).slice(0, 5);
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

export async function applySync(db: DB, user: typeof users.$inferSelect, req: SyncRequest): Promise<SyncResponse> {
  const userId = user.id;
  const since = Number.isFinite(req.since) ? Math.max(0, Number(req.since)) : 0;

  await upsertLWW(db, tasks, userId, (req.tasks ?? []).map((t: Task) => taskToRow(t, userId)) as never);
  await upsertLWW(db, occurrences, userId, (req.occurrences ?? []).map((o: Occurrence) => occurrenceToRow(o, userId)) as never);
  await upsertLWW(db, categories, userId, (req.categories ?? []).map((c: Category) => categoryToRow(c, userId)) as never);
  await upsertLWW(db, dayNotes, userId, (req.notes ?? []).map((n: DayNote) => noteToRow(n, userId)) as never);

  let settings = settingsFromRow(user.settings);
  if (req.settings) {
    settings = sanitizeSettings(req.settings, settings);
    await db.update(users).set({ settings: JSON.stringify(settings), updatedAt: Date.now() }).where(eq(users.id, userId));
  }

  const changed = await loadChangedSince(db, userId, since);
  return {
    ...changed,
    now: Date.now(),
    settings,
    user: { id: userId, firstName: user.firstName, username: user.username },
  };
}
