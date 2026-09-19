import type { Category, DayNote, Occurrence, SyncRequest, SyncResponse, Task, UserSettings, VoiceNote } from '@dnevnik/shared';
import { api } from './api.ts';
import { db, getMeta, setMeta, type OutboxEntry, type SettingsMeta } from './db.ts';

export interface SyncResult {
  settings: UserSettings;
  user: SyncResponse['user'];
  changed: number;
  /** Outbox rows still waiting (the push is paged). */
  pending: number;
}

/** The server accepts at most 500 rows per table per request; keep well under it. */
const PAGE = 200;

let inFlight: Promise<SyncResult> | null = null;

/** Push one page of the outbox, pull remote changes, merge with last-write-wins. Safe to call concurrently. */
export function syncOnce(localSettings: SettingsMeta): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = doSync(localSettings).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync(localSettings: SettingsMeta): Promise<SyncResult> {
  const since = await getMeta<number>('lastSync', 0);
  const outboxAll = await db.outbox.toArray();
  const outbox: OutboxEntry[] = [];
  const perTable: Record<string, number> = {};
  for (const o of outboxAll) {
    if ((perTable[o.table] ?? 0) >= PAGE) continue;
    perTable[o.table] = (perTable[o.table] ?? 0) + 1;
    outbox.push(o);
  }

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
    voiceNotes: await pick<VoiceNote>('voiceNotes', db.voiceNotes),
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

  // Voice notes: `uploadedAt` is server-owned and only ever grows, so it is merged on its own
  // instead of riding the last-write-wins comparison (a client tombstone must not lose it and vice versa).
  const mergeVoice = async (incoming: VoiceNote[]) => {
    for (const item of incoming) {
      const local = await db.voiceNotes.get(item.id);
      if (!local) {
        await db.voiceNotes.put(item);
        changed++;
        continue;
      }
      const base = item.updatedAt > local.updatedAt ? item : local;
      const uploadedAt = item.uploadedAt ?? base.uploadedAt ?? null;
      if (base !== local || uploadedAt !== local.uploadedAt) {
        await db.voiceNotes.put({ ...base, uploadedAt });
        changed++;
      }
    }
  };

  await db.transaction('rw', db.tasks, db.occurrences, db.categories, db.notes, db.voiceNotes, async () => {
    await merge(db.tasks, res.tasks);
    await merge(db.occurrences, res.occurrences);
    await merge(db.categories, res.categories);
    await merge(db.notes, res.notes);
    await mergeVoice(res.voiceNotes ?? []);
  });

  await setMeta('lastSync', res.now);
  // Settings meta is only overwritten when the caller's snapshot was pushed (or nothing local was dirty);
  // the store decides whether a newer local edit must stay dirty.
  await setMeta('user', res.user);

  const pending = await db.outbox.count();
  return { settings: res.settings, user: res.user, changed, pending };
}
