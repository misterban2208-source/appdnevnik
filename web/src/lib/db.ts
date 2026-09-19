import Dexie, { type Table } from 'dexie';
import type { Category, DayNote, Occurrence, Task, UserSettings } from '@dnevnik/shared';

export interface OutboxEntry {
  key: string; // `${table}:${id}`
  table: 'tasks' | 'occurrences' | 'categories' | 'notes';
  id: string;
  updatedAt: number;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

class PlannerDB extends Dexie {
  tasks!: Table<Task, string>;
  occurrences!: Table<Occurrence, string>;
  categories!: Table<Category, string>;
  notes!: Table<DayNote, string>;
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
