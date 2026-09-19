import type { Category, DayNote, Occurrence, SyncRequest, SyncResponse, Task, UserSettings } from '@dnevnik/shared';
import { api } from './api.ts';
import { db, getMeta, setMeta, type OutboxEntry, type SettingsMeta } from './db.ts';

export interface SyncResult {
  settings: UserSettings;
  user: SyncResponse['user'];
  changed: number;
}

let inFlight: Promise<SyncResult> | null = null;

/** Push local outbox, pull remote changes, merge with last-write-wins. Safe to call concurrently. */
export function syncOnce(localSettings: SettingsMeta): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = doSync(localSettings).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync(localSettings: SettingsMeta): Promise<SyncResult> {
  const since = await getMeta<number>('lastSync', 0);
  const outbox = await db.outbox.toArray();

  const pick = async <T>(table: OutboxEntry['table'], store: { bulkGet: (ids: string[]) => Promise<(T | undefined)[]> }) => {
    const ids = outbox.filter((o) => o.table === table).map((o) => o.id);
    if (!ids.length) return [] as T[];
    return (await store.bulkGet(ids)).filter(Boolean) as T[];
  };

  const body: SyncRequest = {
    since,
    tasks: await pick<Task>('tasks', db.tasks),
    occurrences: await pick<Occurrence>('occurrences', db.occurrences),
    categories: await pick<Category>('categories', db.categories),
    notes: await pick<DayNote>('notes', db.notes),
    settings: localSettings.dirty ? localSettings.settings : undefined,
  };

  const res = await api.sync(body);

  // Clear outbox entries that were sent and not modified meanwhile.
  await db.transaction('rw', db.outbox, async () => {
    for (const o of outbox) {
      const cur = await db.outbox.get(o.key);
      if (cur && cur.updatedAt === o.updatedAt) await db.outbox.delete(o.key);
    }
  });

  let changed = 0;
  const merge = async <T extends { id: string; updatedAt: number }>(
    store: { get: (id: string) => Promise<T | undefined>; put: (v: T) => Promise<unknown> },
    incoming: T[],
  ) => {
    for (const item of incoming) {
      const local = await store.get(item.id);
      if (!local || item.updatedAt > local.updatedAt) {
        await store.put(item);
        changed++;
      }
    }
  };

  await db.transaction('rw', db.tasks, db.occurrences, db.categories, db.notes, async () => {
    await merge(db.tasks, res.tasks);
    await merge(db.occurrences, res.occurrences);
    await merge(db.categories, res.categories);
    await merge(db.notes, res.notes);
  });

  await setMeta('lastSync', res.now);
  await setMeta('settings', { settings: res.settings, dirty: false } satisfies SettingsMeta);
  await setMeta('user', res.user);

  return { settings: res.settings, user: res.user, changed };
}
