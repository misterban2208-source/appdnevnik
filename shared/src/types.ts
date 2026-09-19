export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled' | 'moved';
export type Priority = 0 | 1 | 2 | 3;

export type RepeatType = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
export interface RepeatRule {
  type: RepeatType;
  /** 0 = Sunday … 6 = Saturday. Used by weekly/custom. */
  days?: number[];
  /** ISO date YYYY-MM-DD, inclusive. */
  until?: string | null;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  userId: number;
  title: string;
  description: string;
  /** Local date YYYY-MM-DD the task belongs to (start date for recurring). */
  date: string;
  /** Minutes from midnight. null = untimed task for the day. */
  startMin: number | null;
  endMin: number | null;
  categoryId: string | null;
  priority: Priority;
  status: TaskStatus;
  checklist: ChecklistItem[];
  /** Minutes before start to notify. */
  reminders: number[];
  repeat: RepeatRule | null;
  carriedFrom: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** Per-date override of a recurring task instance. */
export interface Occurrence {
  id: string; // `${taskId}:${date}`
  taskId: string;
  userId: number;
  date: string;
  status: TaskStatus | null;
  startMin: number | null;
  endMin: number | null;
  checklist: ChecklistItem[] | null;
  deleted: boolean;
  updatedAt: number;
}

export interface Category {
  id: string;
  userId: number;
  name: string;
  color: string;
  sortOrder: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface DayNote {
  id: string; // date
  userId: number;
  date: string;
  morning: string;
  evening: string;
  updatedAt: number;
}

export type NoteSection = 'morning' | 'evening';
export type VoiceSource = 'app' | 'bot';

/** Metadata of a voice note. Bytes live on the device (Dexie) and, once backed up, in R2. */
export interface VoiceNote {
  id: string;
  userId: number;
  date: string;
  section: NoteSection;
  /** Exact container/codec string the bytes were produced with, e.g. 'audio/mp4', 'audio/webm;codecs=opus'. */
  mime: string;
  /** Milliseconds, timer-measured (fragmented MP4 carries no duration). */
  duration: number;
  size: number;
  /** 48 chars [0-9a-z] loudness buckets; '' when unknown. */
  peaks: string;
  source: VoiceSource;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Server-owned: when the bytes became downloadable. Ignored when sent by clients; merged monotonically. */
  uploadedAt: number | null;
}

export const VOICE_MAX_MS = 600_000;
export const VOICE_MIN_MS = 700;
export const VOICE_MAX_BYTES = 25 * 1024 * 1024;

export type FontVariant = 'serif' | 'sans';
export type Lang = 'ru' | 'en';

export interface UserSettings {
  lang: Lang;
  font: FontVariant;
  carryover: boolean;
  haptics: boolean;
  visibleStart: number; // hour
  visibleEnd: number; // hour
  digestMorning: string; // HH:MM
  digestEvening: string; // HH:MM
  digestEnabled: boolean;
  reportEnabled: boolean;
  defaultReminders: number[];
  tz: string; // IANA
}

export const DEFAULT_SETTINGS: UserSettings = {
  lang: 'ru',
  font: 'sans',
  carryover: true,
  haptics: true,
  visibleStart: 7,
  visibleEnd: 23,
  digestMorning: '08:00',
  digestEvening: '21:00',
  digestEnabled: true,
  reportEnabled: true,
  defaultReminders: [10],
  tz: 'Europe/Moscow',
};

/** A concrete task shown on a given day (base task or recurring instance with overrides applied). */
export interface TaskInstance extends Task {
  instanceDate: string;
  isRecurringInstance: boolean;
  occurrenceId: string | null;
}

export interface SyncPayload {
  tasks: Task[];
  occurrences: Occurrence[];
  categories: Category[];
  notes: DayNote[];
  voiceNotes: VoiceNote[];
}

export interface SyncRequest extends SyncPayload {
  since: number;
  settings?: UserSettings;
}

export interface SyncResponse extends SyncPayload {
  now: number;
  settings: UserSettings;
  user: { id: number; firstName: string; username: string | null };
}

export const DEFAULT_CATEGORIES: Array<{ name: { ru: string; en: string }; color: string }> = [
  { name: { ru: 'Работа', en: 'Work' }, color: '#C9A961' },
  { name: { ru: 'Личное', en: 'Personal' }, color: '#3D5A99' },
  { name: { ru: 'Здоровье', en: 'Health' }, color: '#5E8C61' },
  { name: { ru: 'Встречи', en: 'Meetings' }, color: '#8C5E7A' },
];
