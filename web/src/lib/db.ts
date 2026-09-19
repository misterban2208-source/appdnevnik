import Dexie, { type Table } from 'dexie';
import type { Category, DayNote, Occurrence, Task, UserSettings, VoiceNote } from '@dnevnik/shared';

export interface OutboxEntry {
  key: string; // `${table}:${id}`
  table: 'tasks' | 'occurrences' | 'categories' | 'notes' | 'voiceNotes';
  id: string;
  updatedAt: number;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

/** Raw audio bytes of a voice note; `touchedAt` drives the cache-budget eviction. */
export interface VoiceBlobRow {
  id: string;
  mime: string;
  bytes: ArrayBuffer;
  touchedAt: number;
}

/** One row per voice note whose bytes still have to reach R2. */
export interface VoiceQueueRow {
  id: string;
  attempts: number;
  nextAt: number;
  lastError: string | null;
  /** The server rejected the bytes for good (deleted / too big / unsupported); no automatic retries. */
  permanent: boolean;
}

class PlannerDB extends Dexie {
  tasks!: Table<Task, string>;
  occurrences!: Table<Occurrence, string>;
  categories!: Table<Category, string>;
  notes!: Table<DayNote, string>;
  voiceNotes!: Table<VoiceNote, string>;
  voiceBlobs!: Table<VoiceBlobRow, string>;
  voiceQueue!: Table<VoiceQueueRow, string>;
  outbox!: Table<OutboxEntry, string>;
  meta!: Table<MetaEntry, string>;

  constructor() {
    super('dnevnik');
    this.version(1).stores({
      tasks: 'id, date, updatedAt, deletedAt',
      occurrences: 'id, taskId, date, updatedAt',
      categories: 'id, updatedAt',
      notes: 'id, updatedAt',
      outbox: 'key, table',
      meta: 'key',
    });
    // Voice notes: metadata is synced, bytes stay local (and reach R2 through the upload queue).
    this.version(2).stores({
      voiceNotes: 'id, date, updatedAt, [date+section]',
      voiceBlobs: 'id',
      voiceQueue: 'id, nextAt',
    });
  }
}

export const db = new PlannerDB();

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

export type SettingsMeta = { settings: UserSettings; dirty: boolean };
