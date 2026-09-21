import type {
  Category,
  ChecklistItem,
  DayNote,
  NoteSection,
  Occurrence,
  RepeatRule,
  SyncRequest,
  Task,
  TaskStatus,
  UserSettings,
  VoiceNote,
  VoiceSource,
} from '@dnevnik/shared';

export class ValidationError extends Error {
  status = 400;
}

export const LIMITS = {
  rowsPerTable: 500,
  id: 160,
  title: 500,
  description: 20_000,
  note: 20_000,
  categoryName: 100,
  checklistItems: 100,
  checklistText: 500,
  reminders: 10,
  mime: 64,
  peaks: 48,
  /** Above the recorder's 10-minute cap on purpose: bot audio files may be longer. */
  voiceMs: 3_600_000,
};

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled', 'moved'];
const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly', 'custom'];
const SECTIONS: NoteSection[] = ['morning', 'evening'];
const VOICE_SOURCES: VoiceSource[] = ['app', 'bot'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
export const MIME_RE = /^audio\/[\w.+-]+(;[\w=.\s"-]+)?$/;

function fail(msg: string): never {
  throw new ValidationError(msg);
}

function str(v: unknown, max: number, field: string, allowEmpty = true): string {
  if (typeof v !== 'string') fail(`${field}: expected string`);
  if (!allowEmpty && !v) fail(`${field}: empty`);
  return v.length > max ? v.slice(0, max) : v;
}

function num(v: unknown, field: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${field}: expected number`);
  if (v < min || v > max) fail(`${field}: out of range`);
  return v;
}

/** Out-of-range minutes are clamped, not rejected: a single odd value must never block a device's sync forever. */
/** Rounds into [min, max]; unlike `num` it never throws for an out-of-range value. */
function clamp(v: unknown, field: string, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, num(v, field))));
}

function optNum(v: unknown, field: string, min: number, max: number): number | null {
  if (v === null || v === undefined) return null;
  const n = num(v, field);
  return Math.round(Math.max(min, Math.min(max, n)));
}

function isoDate(v: unknown, field: string): string {
  const s = str(v, 10, field, false);
  if (!DATE_RE.test(s)) fail(`${field}: bad date`);
  return s;
}

function timestamp(v: unknown, field: string, now: number): number {
  const n = Math.round(num(v, field, 0, 4_102_444_800_000));
  // Clamp fast clocks so a skewed device cannot lock a row for hours.
  return Math.min(n, now + 5 * 60_000);
}

function checklist(v: unknown): ChecklistItem[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) fail('checklist: expected array');
  return v.slice(0, LIMITS.checklistItems).map((it, i) => {
    if (!it || typeof it !== 'object') fail(`checklist[${i}]`);
    const o = it as Record<string, unknown>;
    return { id: str(o.id, LIMITS.id, 'checklist.id', false), text: str(o.text, LIMITS.checklistText, 'checklist.text'), done: !!o.done };
  });
}

function repeat(v: unknown): RepeatRule | null {
  if (v === null || v === undefined) return null;
  if (!v || typeof v !== 'object') fail('repeat');
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string' || !REPEATS.includes(o.type)) fail('repeat.type');
  const days = Array.isArray(o.days) ? o.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).slice(0, 7) : undefined;
  const until = o.until === null || o.until === undefined ? null : isoDate(o.until, 'repeat.until');
  return { type: o.type as RepeatRule['type'], days, until };
}

export function validateTask(v: unknown, now: number): Task {
  if (!v || typeof v !== 'object') fail('task');
  const o = v as Record<string, unknown>;
  const startMin = optNum(o.startMin, 'startMin', 0, 1439);
  let endMin = optNum(o.endMin, 'endMin', 1, 1440);
  if (startMin === null) endMin = null;
  else if (endMin === null || endMin <= startMin) endMin = Math.min(1440, startMin + 60);
  const status = typeof o.status === 'string' && STATUSES.includes(o.status as TaskStatus) ? (o.status as TaskStatus) : 'todo';
  const priority = [0, 1, 2, 3].includes(o.priority as number) ? (o.priority as Task['priority']) : 0;
  const reminders = Array.isArray(o.reminders)
    ? Array.from(new Set(o.reminders.filter((r) => Number.isInteger(r) && r >= 0 && r <= 1440))).slice(0, LIMITS.reminders)
    : [];
  return {
    id: str(o.id, LIMITS.id, 'id', false),
    userId: 0,
    title: str(o.title, LIMITS.title, 'title'),
    description: str(o.description ?? '', LIMITS.description, 'description'),
    date: isoDate(o.date, 'date'),
    startMin,
    endMin,
    categoryId: o.categoryId === null || o.categoryId === undefined ? null : str(o.categoryId, LIMITS.id, 'categoryId'),
    priority,
    status,
    checklist: checklist(o.checklist),
    reminders,
    repeat: repeat(o.repeat),
    carriedFrom: o.carriedFrom === null || o.carriedFrom === undefined ? null : isoDate(o.carriedFrom, 'carriedFrom'),
    sortOrder: typeof o.sortOrder === 'number' && Number.isFinite(o.sortOrder) ? o.sortOrder : 0,
    createdAt: timestamp(o.createdAt ?? now, 'createdAt', now),
    updatedAt: timestamp(o.updatedAt, 'updatedAt', now),
    deletedAt: o.deletedAt === null || o.deletedAt === undefined ? null : timestamp(o.deletedAt, 'deletedAt', now),
  };
}

export function validateOccurrence(v: unknown, now: number): Occurrence {
  if (!v || typeof v !== 'object') fail('occurrence');
  const o = v as Record<string, unknown>;
  const taskId = str(o.taskId, LIMITS.id, 'taskId', false);
  const date = isoDate(o.date, 'date');
  return {
    id: `${taskId}:${date}`,
    taskId,
    userId: 0,
    date,
    status: typeof o.status === 'string' && STATUSES.includes(o.status as TaskStatus) ? (o.status as TaskStatus) : null,
    startMin: optNum(o.startMin, 'startMin', 0, 1439),
    endMin: optNum(o.endMin, 'endMin', 1, 1440),
    checklist: o.checklist === null || o.checklist === undefined ? null : checklist(o.checklist),
    deleted: !!o.deleted,
    updatedAt: timestamp(o.updatedAt, 'updatedAt', now),
  };
}

export function validateCategory(v: unknown, now: number): Category {
  if (!v || typeof v !== 'object') fail('category');
  const o = v as Record<string, unknown>;
  const color = str(o.color, 9, 'color');
  return {
    id: str(o.id, LIMITS.id, 'id', false),
    userId: 0,
    name: str(o.name, LIMITS.categoryName, 'name'),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#6c7a89',
    sortOrder: typeof o.sortOrder === 'number' && Number.isFinite(o.sortOrder) ? o.sortOrder : 0,
    updatedAt: timestamp(o.updatedAt, 'updatedAt', now),
    deletedAt: o.deletedAt === null || o.deletedAt === undefined ? null : timestamp(o.deletedAt, 'deletedAt', now),
  };
}

export function validateNote(v: unknown, now: number): DayNote {
  if (!v || typeof v !== 'object') fail('note');
  const o = v as Record<string, unknown>;
  const date = isoDate(o.date, 'date');
  return {
    id: date,
    userId: 0,
    date,
    morning: str(o.morning ?? '', LIMITS.note, 'morning'),
    evening: str(o.evening ?? '', LIMITS.note, 'evening'),
    updatedAt: timestamp(o.updatedAt, 'updatedAt', now),
  };
}

export function validateVoiceNote(v: unknown, now: number): VoiceNote {
  if (!v || typeof v !== 'object') fail('voiceNote');
  const o = v as Record<string, unknown>;
  const id = str(o.id, 36, 'id', false);
  if (!UUID_RE.test(id)) fail('id: bad uuid');
  if (typeof o.section !== 'string' || !SECTIONS.includes(o.section as NoteSection)) fail('section');
  const mime = str(o.mime, LIMITS.mime + 1, 'mime', false);
  if (mime.length > LIMITS.mime || !MIME_RE.test(mime)) fail('mime');
  const source = o.source === undefined ? 'app' : o.source;
  if (typeof source !== 'string' || !VOICE_SOURCES.includes(source as VoiceSource)) fail('source');
  const createdAt = timestamp(o.createdAt ?? now, 'createdAt', now);
  return {
    id,
    userId: 0,
    date: isoDate(o.date, 'date'),
    section: o.section as NoteSection,
    mime,
    // Clamped, never rejected: one odd row (e.g. an hour-long audio imported from the bot) must not
    // make every later /api/sync call fail and freeze the whole device.
    duration: clamp(o.duration ?? 0, 'duration', 0, LIMITS.voiceMs),
    size: clamp(o.size ?? 0, 'size', 0, Number.MAX_SAFE_INTEGER),
    peaks: str(o.peaks ?? '', LIMITS.peaks, 'peaks'),
    source: source as VoiceSource,
    createdAt,
    updatedAt: timestamp(o.updatedAt ?? createdAt, 'updatedAt', now),
    deletedAt: o.deletedAt === null || o.deletedAt === undefined ? null : timestamp(o.deletedAt, 'deletedAt', now),
    // Server-owned: whatever the client sent is ignored.
    uploadedAt: null,
  };
}

function list<T>(v: unknown, field: string, fn: (x: unknown) => T): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`${field}: expected array`);
  if (v.length > LIMITS.rowsPerTable) fail(`${field}: too many rows (max ${LIMITS.rowsPerTable})`);
  return v.map(fn);
}

export function validateSyncRequest(body: unknown, now: number): SyncRequest {
  if (!body || typeof body !== 'object') fail('body');
  const o = body as Record<string, unknown>;
  const since = typeof o.since === 'number' && Number.isFinite(o.since) ? Math.max(0, o.since) : 0;
  const settings = o.settings && typeof o.settings === 'object' ? (o.settings as UserSettings) : undefined;
  return {
    since,
    settings,
    tasks: list(o.tasks, 'tasks', (x) => validateTask(x, now)),
    occurrences: list(o.occurrences, 'occurrences', (x) => validateOccurrence(x, now)),
    categories: list(o.categories, 'categories', (x) => validateCategory(x, now)),
    notes: list(o.notes, 'notes', (x) => validateNote(x, now)),
    voiceNotes: list(o.voiceNotes, 'voiceNotes', (x) => validateVoiceNote(x, now)),
  };
}
