import { create } from 'zustand';
import type { Category, DayNote, Occurrence, Task, TaskInstance, TaskStatus, UserSettings } from '@dnevnik/shared';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS, addDays, compareISO, occurrenceId, toISODate } from '@dnevnik/shared';
import { db, getMeta, setMeta, type SettingsMeta } from '../lib/db.ts';
import { syncOnce } from '../lib/sync.ts';
import { ApiError } from '../lib/api.ts';
import { haptic, setHapticsEnabled, tgUser } from '../lib/telegram.ts';
import { uuid } from '../lib/util.ts';
import { getDict, type Dict } from '../i18n/index.ts';

/** Carry-over copies derive from the root task id so client and server converge. */
export function carryRootId(id: string): string {
  return id.split(':carry:')[0];
}

export type View = 'day' | 'week' | 'month' | 'list' | 'stats';
export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'pending' | 'error' | 'expired';

export interface EditorState {
  taskId: string | null;
  /** Date of the instance being edited (for recurring tasks). */
  instanceDate: string;
  /** Prefill for new tasks. */
  prefill?: Partial<Task>;
}

export interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}

interface State {
  ready: boolean;
  settings: UserSettings;
  settingsDirty: boolean;
  tasks: Record<string, Task>;
  occurrences: Record<string, Occurrence>;
  categories: Record<string, Category>;
  notes: Record<string, DayNote>;
  currentDate: string;
  today: string;
  view: View;
  syncStatus: SyncStatus;
  lastSync: number;
  editor: EditorState | null;
  quickAddOpen: boolean;
  settingsOpen: boolean;
  toast: Toast | null;
  selectedBlockId: string | null;
  userName: string;

  init(): Promise<void>;
  setDate(d: string): void;
  setView(v: View): void;
  openEditor(e: EditorState | null): void;
  setQuickAdd(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  selectBlock(id: string | null): void;
  showToast(message: string, undo?: () => void): void;
  dismissToast(): void;

  updateSettings(patch: Partial<UserSettings>): Promise<void>;
  saveTask(task: Task): Promise<void>;
  createTask(partial: Partial<Task> & { title: string; date: string }): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  restoreTask(id: string): Promise<void>;
  deleteOccurrence(taskId: string, date: string): Promise<void>;
  detachOccurrence(inst: TaskInstance, edits: Partial<Task>): Promise<Task>;
  setInstanceStatus(inst: TaskInstance, status: TaskStatus): Promise<void>;
  setInstanceTime(inst: TaskInstance, startMin: number | null, endMin: number | null): Promise<void>;
  setInstanceChecklist(inst: TaskInstance, checklist: Task['checklist']): Promise<void>;
  saveCategory(cat: Category): Promise<void>;
  deleteCategory(id: string): Promise<void>;
  setNote(date: string, field: 'morning' | 'evening', text: string): Promise<void>;
  runCarryover(): Promise<void>;
  sync(): Promise<void>;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

function scheduleSync(get: () => State, delay = 1200) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void get().sync();
  }, delay);
}

async function persist(table: 'tasks' | 'occurrences' | 'categories' | 'notes', entity: { id: string; updatedAt: number }) {
  await db.transaction('rw', db[table], db.outbox, async () => {
    await (db[table] as unknown as { put: (v: unknown) => Promise<unknown> }).put(entity);
    await db.outbox.put({ key: `${table}:${entity.id}`, table, id: entity.id, updatedAt: entity.updatedAt });
  });
}

function applyFont(font: UserSettings['font']) {
  document.documentElement.setAttribute('data-font', font);
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  settingsDirty: false,
  tasks: {},
  occurrences: {},
  categories: {},
  notes: {},
  currentDate: toISODate(new Date()),
  today: toISODate(new Date()),
  view: 'day',
  syncStatus: 'idle',
  lastSync: 0,
  editor: null,
  quickAddOpen: false,
  settingsOpen: false,
  toast: null,
  selectedBlockId: null,
  userName: '',

  async init() {
    const settingsMeta = await getMeta<SettingsMeta | null>('settings', null);
    const lastSync = await getMeta<number>('lastSync', 0);
    const user = await getMeta<{ firstName: string } | null>('user', null);
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const browserLang = navigator.language?.startsWith('ru') ? 'ru' : 'en';
    // A fresh install must never push defaults over the user's server settings: pull first.
    const settings: UserSettings = settingsMeta?.settings
      ? { ...DEFAULT_SETTINGS, ...settingsMeta.settings }
      : { ...DEFAULT_SETTINGS, lang: (tgUser()?.language_code?.startsWith('ru') ? 'ru' : browserLang) as UserSettings['lang'], tz: browserTz };
    const dirty = settingsMeta?.dirty ?? false;
    const [tasks, occurrences, categories, notes] = await Promise.all([
      db.tasks.toArray(),
      db.occurrences.toArray(),
      db.categories.toArray(),
      db.notes.toArray(),
    ]);
    applyFont(settings.font);
    setHapticsEnabled(settings.haptics);
    set({
      ready: true,
      settings,
      settingsDirty: dirty,
      lastSync,
      userName: user?.firstName ?? tgUser()?.first_name ?? '',
      tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
      occurrences: Object.fromEntries(occurrences.map((o) => [o.id, o])),
      categories: Object.fromEntries(categories.map((c) => [c.id, c])),
      notes: Object.fromEntries(notes.map((n) => [n.id, n])),
    });
    await get().sync();
    // The device time zone drives reminders; push it as a settings change only after the pull.
    if (browserTz && get().settings.tz !== browserTz) await get().updateSettings({ tz: browserTz });
    // Fresh install that could not reach the server: seed defaults locally with the server's ids.
    const uid = tgUser()?.id;
    if (uid && get().syncStatus !== 'ok' && !Object.keys(get().categories).length && !get().lastSync) {
      const now = Date.now();
      for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
        await get().saveCategory({ id: `${uid}:cat:${i}`, userId: uid, name: c.name[get().settings.lang], color: c.color, sortOrder: i, updatedAt: now + i, deletedAt: null });
      }
    }
    await get().runCarryover();
  },

  setDate(d) {
    set({ currentDate: d, selectedBlockId: null });
  },
  setView(v) {
    haptic.selection();
    set({ view: v, selectedBlockId: null });
  },
  openEditor(e) {
    set({ editor: e, selectedBlockId: null });
  },
  setQuickAdd(open) {
    set({ quickAddOpen: open });
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  selectBlock(id) {
    set({ selectedBlockId: id });
  },
  showToast(message, undo) {
    set({ toast: { id: ++toastSeq, message, undo } });
  },
  dismissToast() {
    set({ toast: null });
  },

  async updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    applyFont(settings.font);
    setHapticsEnabled(settings.haptics);
    set({ settings, settingsDirty: true, syncStatus: 'pending' });
    await setMeta('settings', { settings, dirty: true } satisfies SettingsMeta);
    scheduleSync(get);
  },

  async saveTask(task) {
    const t = { ...task, updatedAt: Date.now() };
    set((s) => ({ tasks: { ...s.tasks, [t.id]: t }, syncStatus: 'pending' }));
    await persist('tasks', t);
    scheduleSync(get);
  },

  async createTask(partial) {
    const now = Date.now();
    const s = get().settings;
    const startMin = partial.startMin ?? null;
    const task: Task = {
      id: uuid(),
      userId: 0,
      title: partial.title,
      description: partial.description ?? '',
      date: partial.date,
      startMin,
      endMin: startMin !== null ? (partial.endMin ?? Math.min(1440, startMin + 60)) : null,
      categoryId: partial.categoryId ?? null,
      priority: partial.priority ?? 0,
      status: partial.status ?? 'todo',
      checklist: partial.checklist ?? [],
      reminders: partial.reminders ?? (startMin !== null ? s.defaultReminders : []),
      repeat: partial.repeat ?? null,
      carriedFrom: partial.carriedFrom ?? null,
      sortOrder: partial.sortOrder ?? now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await get().saveTask(task);
    return task;
  },

  async deleteTask(id) {
    const t = get().tasks[id];
    if (!t) return;
    await get().saveTask({ ...t, deletedAt: Date.now() });
    haptic.medium();
    get().showToast(getDict(get().settings.lang).deleted, () => void get().restoreTask(id));
  },

  async restoreTask(id) {
    const t = get().tasks[id];
    if (!t) return;
    await get().saveTask({ ...t, deletedAt: null });
  },

  async deleteOccurrence(taskId, date) {
    const id = occurrenceId(taskId, date);
    const prev = get().occurrences[id];
    const occ: Occurrence = {
      id,
      taskId,
      userId: 0,
      date,
      status: prev?.status ?? null,
      startMin: prev?.startMin ?? null,
      endMin: prev?.endMin ?? null,
      checklist: prev?.checklist ?? null,
      deleted: true,
      updatedAt: Date.now(),
    };
    set((s) => ({ occurrences: { ...s.occurrences, [id]: occ }, syncStatus: 'pending' }));
    await persist('occurrences', occ);
    scheduleSync(get);
    haptic.medium();
    get().showToast(getDict(get().settings.lang).deleted, async () => {
      const restored = { ...occ, deleted: false, updatedAt: Date.now() };
      set((s) => ({ occurrences: { ...s.occurrences, [id]: restored } }));
      await persist('occurrences', restored);
      scheduleSync(get);
    });
  },

  async detachOccurrence(inst, edits) {
    // Turn one instance of a recurring task into a standalone task and hide the series on that day.
    const base = get().tasks[inst.id];
    const copy = await get().createTask({
      ...base,
      ...edits,
      id: undefined,
      repeat: null,
      date: edits.date ?? inst.instanceDate,
      status: edits.status ?? inst.status,
      startMin: edits.startMin !== undefined ? edits.startMin : inst.startMin,
      endMin: edits.endMin !== undefined ? edits.endMin : inst.endMin,
      checklist: edits.checklist ?? inst.checklist,
      title: edits.title ?? base.title,
    } as Partial<Task> & { title: string; date: string });
    const id = occurrenceId(inst.id, inst.instanceDate);
    const occ: Occurrence = { id, taskId: inst.id, userId: 0, date: inst.instanceDate, status: null, startMin: null, endMin: null, checklist: null, deleted: true, updatedAt: Date.now() };
    set((s) => ({ occurrences: { ...s.occurrences, [id]: occ } }));
    await persist('occurrences', occ);
    scheduleSync(get);
    return copy;
  },

  async setInstanceStatus(inst, status) {
    if (status === 'done') haptic.success();
    else haptic.light();
    if (!inst.isRecurringInstance) {
      await get().saveTask({ ...get().tasks[inst.id], status });
      return;
    }
    const id = occurrenceId(inst.id, inst.instanceDate);
    const prev = get().occurrences[id];
    const occ: Occurrence = {
      id,
      taskId: inst.id,
      userId: 0,
      date: inst.instanceDate,
      status,
      startMin: prev?.startMin ?? null,
      endMin: prev?.endMin ?? null,
      checklist: prev?.checklist ?? null,
      deleted: false,
      updatedAt: Date.now(),
    };
    set((s) => ({ occurrences: { ...s.occurrences, [id]: occ }, syncStatus: 'pending' }));
    await persist('occurrences', occ);
    scheduleSync(get);
  },

  async setInstanceTime(inst, startMin, endMin) {
    if (!inst.isRecurringInstance) {
      await get().saveTask({ ...get().tasks[inst.id], startMin, endMin });
      return;
    }
    const id = occurrenceId(inst.id, inst.instanceDate);
    const prev = get().occurrences[id];
    const occ: Occurrence = {
      id,
      taskId: inst.id,
      userId: 0,
      date: inst.instanceDate,
      status: prev?.status ?? null,
      startMin,
      endMin,
      checklist: prev?.checklist ?? null,
      deleted: false,
      updatedAt: Date.now(),
    };
    set((s) => ({ occurrences: { ...s.occurrences, [id]: occ }, syncStatus: 'pending' }));
    await persist('occurrences', occ);
    scheduleSync(get);
  },

  async setInstanceChecklist(inst, checklist) {
    if (!inst.isRecurringInstance) {
      await get().saveTask({ ...get().tasks[inst.id], checklist });
      return;
    }
    const id = occurrenceId(inst.id, inst.instanceDate);
    const prev = get().occurrences[id];
    const occ: Occurrence = {
      id,
      taskId: inst.id,
      userId: 0,
      date: inst.instanceDate,
      status: prev?.status ?? null,
      startMin: prev?.startMin ?? null,
      endMin: prev?.endMin ?? null,
      checklist,
      deleted: false,
      updatedAt: Date.now(),
    };
    set((s) => ({ occurrences: { ...s.occurrences, [id]: occ }, syncStatus: 'pending' }));
    await persist('occurrences', occ);
    scheduleSync(get);
  },

  async saveCategory(cat) {
    const c = { ...cat, updatedAt: Date.now() };
    set((s) => ({ categories: { ...s.categories, [c.id]: c }, syncStatus: 'pending' }));
    await persist('categories', c);
    scheduleSync(get);
  },

  async deleteCategory(id) {
    const c = get().categories[id];
    if (!c) return;
    await get().saveCategory({ ...c, deletedAt: Date.now() });
  },

  async setNote(date, field, text) {
    const prev = get().notes[date];
    const n: DayNote = { id: date, userId: 0, date, morning: prev?.morning ?? '', evening: prev?.evening ?? '', [field]: text, updatedAt: Date.now() };
    set((s) => ({ notes: { ...s.notes, [date]: n }, syncStatus: 'pending' }));
    await persist('notes', n);
    scheduleSync(get, 2500);
  },

  async runCarryover() {
    const today = toISODate(new Date());
    if (get().today !== today) set({ today, currentDate: get().currentDate === get().today ? today : get().currentDate });
    const { settings, tasks } = get();
    if (!settings.carryover) return;
    const stale = Object.values(tasks).filter(
      (t) => !t.deletedAt && !t.repeat && compareISO(t.date, today) < 0 && (t.status === 'todo' || t.status === 'in_progress'),
    );
    for (const t of stale) {
      const copyId = `${carryRootId(t.id)}:carry:${today}`;
      if (!get().tasks[copyId]) {
        const now = Date.now();
        await get().saveTask({ ...t, id: copyId, date: today, carriedFrom: t.carriedFrom ?? t.date, status: 'todo', createdAt: now, updatedAt: now });
      }
      // Bump by one millisecond only, so any real user edit still wins last-write-wins.
      const moved = { ...t, status: 'moved' as const, updatedAt: t.updatedAt + 1 };
      set((s) => ({ tasks: { ...s.tasks, [moved.id]: moved }, syncStatus: 'pending' }));
      await persist('tasks', moved);
    }
    if (stale.length) scheduleSync(get);
  },

  async sync() {
    if (get().syncStatus === 'syncing') return;
    const prev = get().syncStatus;
    set({ syncStatus: 'syncing' });
    const sentSettings = get().settings;
    const sentDirty = get().settingsDirty;
    try {
      const res = await syncOnce({ settings: sentSettings, dirty: sentDirty });
      const [tasks, occurrences, categories, notes] = await Promise.all([
        db.tasks.toArray(),
        db.occurrences.toArray(),
        db.categories.toArray(),
        db.notes.toArray(),
      ]);
      // A settings change made while the request was in flight must stay dirty and be pushed next time.
      const settingsChangedMeanwhile = get().settings !== sentSettings;
      const settings = settingsChangedMeanwhile ? get().settings : res.settings;
      await setMeta('settings', { settings, dirty: settingsChangedMeanwhile } satisfies SettingsMeta);
      applyFont(settings.font);
      setHapticsEnabled(settings.haptics);
      const pending = res.pending;
      // Merge by updatedAt so a mutation made during the IndexedDB reads is never reverted.
      const mergeInto = <T extends { id: string; updatedAt: number }>(cur: Record<string, T>, rows: T[]) => {
        const out = { ...cur };
        for (const r of rows) {
          const c = out[r.id];
          if (!c || r.updatedAt >= c.updatedAt) out[r.id] = r;
        }
        return out;
      };
      set((s) => ({
        settings,
        settingsDirty: settingsChangedMeanwhile,
        userName: res.user.firstName || s.userName,
        tasks: mergeInto(s.tasks, tasks),
        occurrences: mergeInto(s.occurrences, occurrences),
        categories: mergeInto(s.categories, categories),
        notes: mergeInto(s.notes, notes),
        syncStatus: pending || settingsChangedMeanwhile ? 'pending' : 'ok',
        lastSync: Date.now(),
      }));
      if (pending || settingsChangedMeanwhile) scheduleSync(get, 1500);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        set({ syncStatus: 'expired' });
        if (prev !== 'expired') get().showToast(getDict(get().settings.lang).sessionExpired);
      } else {
        set({ syncStatus: 'error' });
      }
    }
  },
}));

export function useT(): Dict {
  const lang = useStore((s) => s.settings.lang);
  return getDict(lang);
}

export function useLiveCategories(): Category[] {
  const cats = useStore((s) => s.categories);
  return Object.values(cats)
    .filter((c) => !c.deletedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export { addDays };
