import { Bot, InlineKeyboard, type CommandContext, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Lang, NoteSection, TaskInstance, UserSettings } from '@dnevnik/shared';
import { formatDuration, instancesForDate, minutesToHHMM, nowInTz, quickParse } from '@dnevnik/shared';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { Env } from './env.ts';
import { ensureUser, getDb } from './sync.ts';
import { importVoice } from './voice.ts';
import { categories, occurrenceFromRow, occurrences, settingsFromRow, taskFromRow, tasks, voiceNotes } from './db/schema.ts';

export const T = {
  ru: {
    open: 'Открыть ежедневник',
    start: (name: string) =>
      `Здравствуйте, ${name}.\n\nЭто ваш ежедневник. Откройте его кнопкой ниже или через меню слева от поля ввода.\n\nМожно писать задачи прямо сюда, например:\n<code>14:30 звонок Ивану 45м</code>\n<code>завтра в 9 спорт 1ч #здоровье</code>`,
    added: (t: string, when: string) => `Добавил: <b>${t}</b>\n${when}`,
    noCategory: (name: string) => `Категории «${name}» нет, задача добавлена без категории.`,
    noTitle: 'Не понял название задачи. Напишите, например: <code>15:00 встреча 1ч</code>',
    today: 'Сегодня',
    tomorrow: 'Завтра',
    noTime: 'без времени',
    emptyDay: 'На сегодня задач нет.',
    more: (n: number) => `…и ещё ${n}`,
    digestTitle: (n: number) => `Доброе утро. Сегодня ${n} ${plural(n, ['задача', 'задачи', 'задач'])}.`,
    reportTitle: (done: number, total: number) => `Итог дня: сделано ${done} из ${total}.`,
    reportUndone: 'Не сделано:',
    reportAllDone: 'Все задачи закрыты. Отличный день.',
    reminder: (t: string, inMin: number, at: string) =>
      inMin <= 0 ? `Сейчас: <b>${t}</b> (${at})` : `Через ${inMin} мин: <b>${t}</b> (${at})`,
    help: 'Команды:\n/today — задачи на сегодня\n/tomorrow — задачи на завтра\n/app — открыть приложение\n\nЛюбой другой текст превращается в задачу.\nГолосовое сообщение сохраняется в заметки дня (утро до 15:00, потом вечер; подпись «утро», «вечер» или «вчера» уточняет).',
    privateOnly: 'Ежедневник работает в личном чате с ботом.',
    voiceSaving: 'Сохраняю голосовое…',
    voiceSaved: (section: NoteSection, date: string) => `Голосовое сохранено: ${date}, ${section === 'morning' ? 'утро' : 'вечер'}.`,
    voiceFailed: 'Не удалось сохранить голосовое. Попробуйте ещё раз.',
    voiceTooBig: 'Файл больше 20 МБ — такой сохранить не могу.',
    voiceDeleted: 'Голосовое удалено.',
    voiceMorningBtn: '☀️ Утро',
    voiceEveningBtn: '🌙 Вечер',
    voiceYesterdayBtn: '← Вчера',
    voiceTodayBtn: 'Сегодня →',
    voiceDeleteBtn: 'Удалить',
  },
  en: {
    open: 'Open planner',
    start: (name: string) =>
      `Hello, ${name}.\n\nThis is your planner. Open it with the button below or from the menu next to the input field.\n\nYou can also type tasks right here, for example:\n<code>2:30pm call with Ivan 45m</code>\n<code>tomorrow at 9 gym 1h #health</code>`,
    added: (t: string, when: string) => `Added: <b>${t}</b>\n${when}`,
    noCategory: (name: string) => `No category "${name}", the task was added without one.`,
    noTitle: 'Could not find a task title. Try: <code>15:00 meeting 1h</code>',
    today: 'Today',
    tomorrow: 'Tomorrow',
    noTime: 'no time',
    emptyDay: 'No tasks for today.',
    more: (n: number) => `…and ${n} more`,
    digestTitle: (n: number) => `Good morning. You have ${n} task${n === 1 ? '' : 's'} today.`,
    reportTitle: (done: number, total: number) => `Day recap: ${done} of ${total} done.`,
    reportUndone: 'Not done:',
    reportAllDone: 'Everything is done. Great day.',
    reminder: (t: string, inMin: number, at: string) =>
      inMin <= 0 ? `Now: <b>${t}</b> (${at})` : `In ${inMin} min: <b>${t}</b> (${at})`,
    help: 'Commands:\n/today — tasks for today\n/tomorrow — tasks for tomorrow\n/app — open the app\n\nAny other text becomes a task.\nA voice message is saved into the day notes (morning before 15:00, evening after; a caption "morning", "evening" or "yesterday" overrides).',
    privateOnly: 'The planner works in a private chat with the bot.',
    voiceSaving: 'Saving the voice note…',
    voiceSaved: (section: NoteSection, date: string) => `Voice note saved: ${date}, ${section === 'morning' ? 'morning' : 'evening'}.`,
    voiceFailed: 'Could not save the voice note. Please try again.',
    voiceTooBig: 'The file is over 20 MB — I cannot save it.',
    voiceDeleted: 'Voice note deleted.',
    voiceMorningBtn: '☀️ Morning',
    voiceEveningBtn: '🌙 Evening',
    voiceYesterdayBtn: '← Yesterday',
    voiceTodayBtn: 'Today →',
    voiceDeleteBtn: 'Delete',
  },
} as const;

/** Telegram voice messages above this cannot be fetched through the Bot API. */
const VOICE_TG_MAX = 20 * 1024 * 1024;
/** Local hour before which an unlabelled voice message lands in the morning section. */
const MORNING_UNTIL_MIN = 15 * 60;
const VOICE_CB_RE = /^v:([0-9a-f-]{36}):([metyd])$/i;

type WaitUntil = (p: Promise<unknown>) => void;
let currentWaitUntil: WaitUntil | null = null;

/**
 * `getBot` is cached per isolate, so handlers cannot close over a request's ExecutionContext.
 * The webhook route sets the current one before dispatching the update.
 */
export function setWaitUntil(fn: WaitUntil | null): void {
  currentWaitUntil = fn;
}

/** Runs `job` past the webhook response when an ExecutionContext is known, otherwise awaits it. */
async function inBackground(waitUntil: WaitUntil | null, job: Promise<void>): Promise<void> {
  if (waitUntil) {
    try {
      waitUntil(job);
      return;
    } catch {
      /* context already closed: fall through to awaiting */
    }
  }
  await job;
}

export function voiceKeyboard(note: { id: string; section: string; date: string }, today: string, lang: Lang): InlineKeyboard {
  const t = T[lang];
  const kb = new InlineKeyboard();
  if (note.section === 'morning') kb.text(t.voiceEveningBtn, `v:${note.id}:e`);
  else kb.text(t.voiceMorningBtn, `v:${note.id}:m`);
  if (note.date === today) kb.text(t.voiceYesterdayBtn, `v:${note.id}:y`);
  else if (note.date === addDaysISO(today, -1)) kb.text(t.voiceTodayBtn, `v:${note.id}:t`);
  kb.row().text(t.voiceDeleteBtn, `v:${note.id}:d`);
  return kb;
}

/** Caption keywords win over the time-of-day default. */
export function pickVoiceTarget(caption: string | undefined, today: string, nowMin: number): { date: string; section: NoteSection } {
  const c = (caption ?? '').toLowerCase();
  let date = today;
  let section: NoteSection = nowMin < MORNING_UNTIL_MIN ? 'morning' : 'evening';
  if (/утр|morning/.test(c)) section = 'morning';
  else if (/вечер|evening/.test(c)) section = 'evening';
  if (/вчера|yesterday/.test(c)) {
    date = addDaysISO(today, -1);
    if (!/утр|morning/.test(c)) section = 'evening';
  }
  return { date, section };
}

const MAX_MESSAGE = 4000;
const MAX_TITLE = 200;
const MAX_LINES = 60;

function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function esc(s: string): string {
  const t = s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE)}…` : s;
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Telegram rejects messages above 4096 characters; the cut must not leave HTML half-open. */
export function truncateMessage(s: string): string {
  if (s.length <= MAX_MESSAGE) return s;
  let out = s.slice(0, MAX_MESSAGE).replace(/<[^>]*$/, '');
  for (const tag of ['code', 'b', 'i']) {
    const opens = (out.match(new RegExp(`<${tag}>`, 'g')) ?? []).length;
    const closes = (out.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (opens > closes) out += `</${tag}>`;
  }
  return `${out}…`;
}

export function webAppKeyboard(env: Env, lang: Lang): InlineKeyboard {
  return new InlineKeyboard().webApp(T[lang].open, env.WEBAPP_URL);
}

export function formatTaskLine(t: TaskInstance, lang: Lang): string {
  const mark = t.status === 'done' ? '✓' : t.status === 'cancelled' ? '✕' : t.status === 'in_progress' ? '▶' : '•';
  const time =
    t.startMin !== null
      ? `${minutesToHHMM(t.startMin)}${t.endMin !== null ? `–${minutesToHHMM(t.endMin)}` : ''}`
      : T[lang].noTime;
  return `${mark} <code>${time}</code> ${esc(t.title)}`;
}

export async function loadDayInstances(env: Env, userId: number, date: string): Promise<TaskInstance[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt), or(eq(tasks.date, date), isNotNull(tasks.repeat))))
    .all();
  const occ = await db.select().from(occurrences).where(and(eq(occurrences.userId, userId), eq(occurrences.date, date))).all();
  return instancesForDate(rows.map(taskFromRow), occ.map(occurrenceFromRow), date);
}

export function dayMessage(items: TaskInstance[], lang: Lang, title: string): string {
  if (!items.length) return `<b>${title}</b>\n${T[lang].emptyDay}`;
  const lines = items.slice(0, MAX_LINES).map((t) => formatTaskLine(t, lang));
  if (items.length > MAX_LINES) lines.push(T[lang].more(items.length - MAX_LINES));
  return `<b>${title}</b>\n\n${lines.join('\n')}`;
}

let cached: { token: string; bot: Bot } | null = null;
let realInfo: UserFromGetMe | null = null;

/**
 * Identity used until getMe answers. Without it grammY calls getMe before the first update of every
 * isolate and a failure there (network blip, 429) turns the whole webhook into a 500 that Telegram
 * keeps redelivering. Only command matching with an explicit @username depends on the real values.
 */
function placeholderInfo(token: string): UserFromGetMe {
  return {
    id: Number(token.split(':')[0]) || 0,
    is_bot: true,
    first_name: 'bot',
    username: 'bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as UserFromGetMe;
}

/** One Bot per isolate, created without a round trip to Telegram. */
export function getBot(env: Env): Bot {
  if (cached && cached.token === env.BOT_TOKEN) return cached.bot;
  const bot = createBot(env, realInfo ?? placeholderInfo(env.BOT_TOKEN));
  cached = { token: env.BOT_TOKEN, bot };
  if (!realInfo) {
    // Learn the real identity in the background; failing must never fail an update.
    void bot.api
      .getMe()
      .then((me) => {
        realInfo = me;
        bot.botInfo = me;
      })
      .catch((err) => console.warn('getMe failed, using the placeholder identity', err instanceof Error ? err.message : err));
  }
  return bot;
}

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(env.BOT_TOKEN, botInfo ? { botInfo } : undefined);

  // Never let a handler error bubble up: Telegram would redeliver the update and duplicate side effects.
  bot.catch((err) => {
    console.error('bot error', err.ctx?.update?.update_id, err.error);
  });

  const withUser = async (ctx: Context) => {
    if (!ctx.from) return null;
    const db = getDb(env.DB);
    const user = await ensureUser(db, ctx.from);
    const settings: UserSettings = settingsFromRow(user.settings);
    return { db, user, settings };
  };

  const isPrivate = (ctx: Context) => ctx.chat?.type === 'private';
  const markup = (ctx: Context, lang: Lang) => (isPrivate(ctx) ? { reply_markup: webAppKeyboard(env, lang) } : {});

  bot.command('start', async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    if (!isPrivate(ctx)) {
      await ctx.reply(T[lang].privateOnly);
      return;
    }
    await ctx.api.setChatMenuButton({
      chat_id: ctx.chat.id,
      menu_button: { type: 'web_app', text: T[lang].open, web_app: { url: env.WEBAPP_URL } },
    });
    await ctx.reply(T[lang].start(esc(ctx.from!.first_name)), { parse_mode: 'HTML', ...markup(ctx, lang) });
  });

  bot.command('help', async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    await ctx.reply(T[u.settings.lang].help);
  });

  bot.command('app', async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    await ctx.reply(T[u.settings.lang].open, markup(ctx, u.settings.lang));
  });

  const sendDay = async (ctx: CommandContext<Context>, offset: number) => {
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    const { date } = nowInTz(u.settings.tz);
    const target = offset === 0 ? date : addDaysISO(date, offset);
    const items = await loadDayInstances(env, u.user.id, target);
    const title = `${offset === 0 ? T[lang].today : T[lang].tomorrow}, ${target}`;
    await ctx.reply(truncateMessage(dayMessage(items, lang, title)), { parse_mode: 'HTML', ...markup(ctx, lang) });
  };
  bot.command('today', (ctx) => sendDay(ctx, 0));
  bot.command('tomorrow', (ctx) => sendDay(ctx, 1));

  // Any plain text becomes a task via quick parse. Unknown commands get the help text.
  bot.on('message:text', async (ctx) => {
    // Quick-add is a private-chat feature: group chats would create tasks and collide on message ids.
    if (!isPrivate(ctx)) return;
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    if (ctx.message.text.startsWith('/')) {
      await ctx.reply(T[lang].help);
      return;
    }
    const { date: today } = nowInTz(u.settings.tz);
    const p = quickParse(ctx.message.text, today);
    if (!p.title) {
      await ctx.reply(T[lang].noTitle, { parse_mode: 'HTML' });
      return;
    }
    let categoryId: string | null = null;
    let missingCategory: string | null = null;
    if (p.categoryName) {
      // Matched in JS, not in SQL: SQLite's lower() is ASCII-only, so "#здоровье" would never
      // match the category "Здоровье".
      const rows = await u.db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(eq(categories.userId, u.user.id), isNull(categories.deletedAt)))
        .all();
      const wanted = p.categoryName.toLowerCase();
      const cat = rows.find((r) => r.name.toLowerCase() === wanted);
      if (cat) categoryId = cat.id;
      else missingCategory = p.categoryName;
    }
    const now = Date.now();
    const startMin = p.startMin;
    const endMin = startMin !== null ? (p.endMin ?? Math.min(1440, startMin + 60)) : null;
    // Id derived from the update so a redelivered update cannot create a duplicate.
    await u.db
      .insert(tasks)
      .values({
        id: `${u.user.id}:tg:${ctx.message.message_id}`,
        userId: u.user.id,
        title: p.title.slice(0, 500),
        description: '',
        date: p.date ?? today,
        startMin,
        endMin,
        categoryId,
        priority: p.priority ?? 0,
        status: 'todo',
        checklist: '[]',
        reminders: JSON.stringify(startMin !== null ? u.settings.defaultReminders : []),
        repeat: null,
        carriedFrom: null,
        sortOrder: now,
        createdAt: now,
        updatedAt: now,
        syncedAt: now,
        deletedAt: null,
      })
      .onConflictDoNothing();
    const when =
      startMin !== null
        ? `${p.date ?? today}, ${minutesToHHMM(startMin)}–${minutesToHHMM(endMin!)} (${formatDuration(endMin! - startMin, lang)})`
        : `${p.date ?? today}, ${T[lang].noTime}`;
    let reply = T[lang].added(esc(p.title), when);
    if (missingCategory) reply += `\n${T[lang].noCategory(esc(missingCategory))}`;
    await ctx.reply(truncateMessage(reply), { parse_mode: 'HTML', ...markup(ctx, lang) });
  });

  // Voice and audio messages become voice notes of the day. The reply goes out first and is edited
  // once the import finishes, so a slow download never makes Telegram redeliver the update.
  const onVoice = async (ctx: Context) => {
    // Read before the first await: another request may replace the module-level context meanwhile.
    const waitUntil = currentWaitUntil;
    const msg = ctx.msg;
    const media = msg?.voice ?? msg?.audio;
    if (!msg || !media || !isPrivate(ctx)) return;
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    const chatId = msg.chat.id;
    const replyTo = { reply_parameters: { message_id: msg.message_id } };
    if ((media.file_size ?? 0) > VOICE_TG_MAX) {
      await ctx.reply(T[lang].voiceTooBig, replyTo);
      return;
    }
    const { date: today, minutes } = nowInTz(u.settings.tz);
    const target = pickVoiceTarget(msg.caption, today, minutes);
    const sent = await ctx.reply(T[lang].voiceSaving, replyTo);
    const edit = (text: string, reply_markup?: InlineKeyboard) =>
      ctx.api.editMessageText(chatId, sent.message_id, text, { reply_markup }).then(() => undefined);
    const job = (async () => {
      try {
        const r = await importVoice(env, u.db, u.user.id, {
          fileId: media.file_id,
          fileUniqueId: media.file_unique_id,
          mime: media.mime_type ?? (msg.voice ? 'audio/ogg' : 'audio/mpeg'),
          durationSec: media.duration,
          size: media.file_size ?? 0,
          date: target.date,
          section: target.section,
          sentAt: msg.date,
        });
        if (!r.ok) {
          await edit(r.reason === 'too_big' ? T[lang].voiceTooBig : T[lang].voiceFailed);
          return;
        }
        await edit(T[lang].voiceSaved(r.note.section, r.note.date), voiceKeyboard(r.note, today, lang));
      } catch (err) {
        console.error('voice import failed', err);
        await edit(T[lang].voiceFailed).catch(() => {});
      }
    })();
    await inBackground(waitUntil, job);
  };
  bot.on('message:voice', onVoice);
  bot.on('message:audio', onVoice);

  // Correction buttons under the "saved" reply: section, day, delete.
  bot.callbackQuery(VOICE_CB_RE, async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    const [, id, op] = ctx.match;
    const row = await u.db
      .select()
      .from(voiceNotes)
      .where(and(eq(voiceNotes.id, id), eq(voiceNotes.userId, u.user.id)))
      .get();
    const editText = (text: string, reply_markup?: InlineKeyboard) => ctx.editMessageText(text, { reply_markup }).catch(() => {});
    if (!row || row.deletedAt !== null) {
      await ctx.answerCallbackQuery({ text: T[lang].voiceDeleted });
      await editText(T[lang].voiceDeleted);
      return;
    }
    const now = Date.now();
    const patch: Partial<typeof voiceNotes.$inferInsert> = { updatedAt: now, syncedAt: now };
    switch (op.toLowerCase()) {
      case 'm':
        patch.section = 'morning';
        break;
      case 'e':
        patch.section = 'evening';
        break;
      case 'y':
        patch.date = addDaysISO(row.date, -1);
        break;
      case 't':
        patch.date = addDaysISO(row.date, 1);
        break;
      case 'd':
        patch.deletedAt = now;
        break;
    }
    await u.db
      .update(voiceNotes)
      .set(patch)
      .where(and(eq(voiceNotes.id, id), eq(voiceNotes.userId, u.user.id)));
    if (patch.deletedAt) {
      await ctx.answerCallbackQuery({ text: T[lang].voiceDeleted });
      await editText(T[lang].voiceDeleted);
      return;
    }
    const next = { ...row, ...patch };
    const { date: today } = nowInTz(u.settings.tz);
    await ctx.answerCallbackQuery();
    await editText(T[lang].voiceSaved(next.section as NoteSection, next.date), voiceKeyboard(next, today, lang));
  });

  return bot;
}

function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
