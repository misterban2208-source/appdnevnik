import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Category, DayNote, Occurrence, Task, UserSettings, VoiceNote } from '@dnevnik/shared';
import { DEFAULT_SETTINGS } from '@dnevnik/shared';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  firstName: text('first_name').notNull().default(''),
  username: text('username'),
  settings: text('settings').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastSeen: integer('last_seen').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  title: text('title').notNull().default(''),
  description: text('description').notNull().default(''),
  date: text('date').notNull(),
  startMin: integer('start_min'),
  endMin: integer('end_min'),
  categoryId: text('category_id'),
  priority: integer('priority').notNull().default(0),
  status: text('status').notNull().default('todo'),
  checklist: text('checklist').notNull().default('[]'),
  reminders: text('reminders').notNull().default('[]'),
  repeat: text('repeat'),
  carriedFrom: text('carried_from'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  syncedAt: integer('synced_at').notNull().default(0),
  deletedAt: integer('deleted_at'),
});

export const occurrences = sqliteTable('occurrences', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  userId: integer('user_id').notNull(),
  date: text('date').notNull(),
  status: text('status'),
  startMin: integer('start_min'),
  endMin: integer('end_min'),
  checklist: text('checklist'),
  deleted: integer('deleted').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
  syncedAt: integer('synced_at').notNull().default(0),
});

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
  syncedAt: integer('synced_at').notNull().default(0),
  deletedAt: integer('deleted_at'),
});

export const dayNotes = sqliteTable('day_notes', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  date: text('date').notNull(),
  morning: text('morning').notNull().default(''),
  evening: text('evening').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
  syncedAt: integer('synced_at').notNull().default(0),
});

export const voiceNotes = sqliteTable('voice_notes', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  date: text('date').notNull(),
  section: text('section').notNull(),
  mime: text('mime').notNull(),
  duration: integer('duration').notNull().default(0),
  size: integer('size').notNull().default(0),
  peaks: text('peaks').notNull().default(''),
  source: text('source').notNull().default('app'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  syncedAt: integer('synced_at').notNull().default(0),
  deletedAt: integer('deleted_at'),
  // Server-owned columns: never written by the sync upsert, never exposed to clients except uploadedAt.
  r2Key: text('r2_key'),
  uploadedAt: integer('uploaded_at'),
  tgFileId: text('tg_file_id'),
  tgFileUniqueId: text('tg_file_unique_id'),
});

export const sentNotifications = sqliteTable('sent_notifications', {
  key: text('key').primaryKey(),
  sentAt: integer('sent_at').notNull(),
});

// ---- Row <-> domain converters ----

function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function taskFromRow(r: typeof tasks.$inferSelect): Task {
  return {
    id: r.id,
    userId: r.userId,
    title: r.title,
    description: r.description,
    date: r.date,
    startMin: r.startMin,
    endMin: r.endMin,
    categoryId: r.categoryId,
    priority: r.priority as Task['priority'],
    status: r.status as Task['status'],
    checklist: parseJSON(r.checklist, []),
    reminders: parseJSON(r.reminders, []),
    repeat: parseJSON(r.repeat, null),
    carriedFrom: r.carriedFrom,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

export function taskToRow(t: Task, userId: number): typeof tasks.$inferInsert {
  return {
    id: t.id,
    userId,
    title: t.title ?? '',
    description: t.description ?? '',
    date: t.date,
    startMin: t.startMin ?? null,
    endMin: t.endMin ?? null,
    categoryId: t.categoryId ?? null,
    priority: t.priority ?? 0,
    status: t.status ?? 'todo',
    checklist: JSON.stringify(t.checklist ?? []),
    reminders: JSON.stringify(t.reminders ?? []),
    repeat: t.repeat ? JSON.stringify(t.repeat) : null,
    carriedFrom: t.carriedFrom ?? null,
    sortOrder: t.sortOrder ?? 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    deletedAt: t.deletedAt ?? null,
  };
}

export function occurrenceFromRow(r: typeof occurrences.$inferSelect): Occurrence {
  return {
    id: r.id,
    taskId: r.taskId,
    userId: r.userId,
    date: r.date,
    status: r.status as Occurrence['status'],
    startMin: r.startMin,
    endMin: r.endMin,
    checklist: r.checklist ? parseJSON(r.checklist, null) : null,
    deleted: !!r.deleted,
    updatedAt: r.updatedAt,
  };
}

export function occurrenceToRow(o: Occurrence, userId: number): typeof occurrences.$inferInsert {
  return {
    id: o.id,
    taskId: o.taskId,
    userId,
    date: o.date,
    status: o.status ?? null,
    startMin: o.startMin ?? null,
    endMin: o.endMin ?? null,
    checklist: o.checklist ? JSON.stringify(o.checklist) : null,
    deleted: o.deleted ? 1 : 0,
    updatedAt: o.updatedAt,
  };
}

export function categoryFromRow(r: typeof categories.$inferSelect): Category {
  return { id: r.id, userId: r.userId, name: r.name, color: r.color, sortOrder: r.sortOrder, updatedAt: r.updatedAt, deletedAt: r.deletedAt };
}

export function categoryToRow(c: Category, userId: number): typeof categories.$inferInsert {
  return {
    id: c.id,
    userId,
    name: c.name,
    color: c.color,
    sortOrder: c.sortOrder ?? 0,
    updatedAt: c.updatedAt,
    deletedAt: c.deletedAt ?? null,
  };
}

export function noteFromRow(r: typeof dayNotes.$inferSelect): DayNote {
  return { id: r.date, userId: r.userId, date: r.date, morning: r.morning, evening: r.evening, updatedAt: r.updatedAt };
}

export function noteToRow(n: DayNote, userId: number): typeof dayNotes.$inferInsert {
  return {
    id: `${userId}:${n.date}`,
    userId,
    date: n.date,
    morning: n.morning ?? '',
    evening: n.evening ?? '',
    updatedAt: n.updatedAt,
  };
}

export function voiceFromRow(r: typeof voiceNotes.$inferSelect): VoiceNote {
  return {
    id: r.id,
    userId: r.userId,
    date: r.date,
    section: r.section as VoiceNote['section'],
    mime: r.mime,
    duration: r.duration,
    size: r.size,
    peaks: r.peaks,
    source: r.source as VoiceNote['source'],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
    uploadedAt: r.uploadedAt,
  };
}

/** Client-owned columns only, so a sync upsert can never clear r2_key, uploaded_at or the Telegram ids. */
export function voiceToRow(v: VoiceNote, userId: number): typeof voiceNotes.$inferInsert {
  return {
    id: v.id,
    userId,
    date: v.date,
    section: v.section,
    mime: v.mime,
    duration: v.duration ?? 0,
    size: v.size ?? 0,
    peaks: v.peaks ?? '',
    source: v.source ?? 'app',
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    deletedAt: v.deletedAt ?? null,
  };
}

export function settingsFromRow(s: string | null | undefined): UserSettings {
  return { ...DEFAULT_SETTINGS, ...parseJSON<Partial<UserSettings>>(s, {}) };
}
