import { Bot, InlineKeyboard, type CommandContext, type Context } from 'grammy';
import type { Lang, TaskInstance, UserSettings } from '@dnevnik/shared';
import { formatDuration, instancesForDate, minutesToHHMM, nowInTz, quickParse } from '@dnevnik/shared';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { Env } from './env.ts';
import { ensureUser, getDb } from './sync.ts';
import { occurrenceFromRow, occurrences, settingsFromRow, taskFromRow, tasks } from './db/schema.ts';

export const T = {
  ru: {
    open: 'Открыть ежедневник',
    start: (name: string) =>
      `Здравствуйте, ${name}.\n\nЭто ваш ежедневник. Откройте его кнопкой ниже или через меню слева от поля ввода.\n\nМожно писать задачи прямо сюда, например:\n<code>14:30 звонок Ивану 45м</code>\n<code>завтра в 9 спорт 1ч #здоровье</code>`,
    added: (t: string, when: string) => `Добавил: <b>${t}</b>\n${when}`,
    noTitle: 'Не понял название задачи. Напишите, например: <code>15:00 встреча 1ч</code>',
    today: 'Сегодня',
    tomorrow: 'Завтра',
    noTime: 'без времени',
    emptyDay: 'На сегодня задач нет.',
    digestTitle: (n: number) => `Доброе утро. Сегодня ${n} ${plural(n, ['задача', 'задачи', 'задач'])}.`,
    reportTitle: (done: number, total: number) => `Итог дня: сделано ${done} из ${total}.`,
    reportUndone: 'Не сделано:',
    reportAllDone: 'Все задачи закрыты. Отличный день.',
    reminder: (t: string, inMin: number, at: string) =>
      inMin <= 0 ? `Сейчас: <b>${t}</b> (${at})` : `Через ${inMin} мин: <b>${t}</b> (${at})`,
    help: 'Команды:\n/today — задачи на сегодня\n/tomorrow — задачи на завтра\n/app — открыть приложение\n\nЛюбой другой текст превращается в задачу.',
  },
  en: {
    open: 'Open planner',
    start: (name: string) =>
      `Hello, ${name}.\n\nThis is your planner. Open it with the button below or from the menu next to the input field.\n\nYou can also type tasks right here, for example:\n<code>2:30pm call with Ivan 45m</code>\n<code>tomorrow at 9 gym 1h #health</code>`,
    added: (t: string, when: string) => `Added: <b>${t}</b>\n${when}`,
    noTitle: 'Could not find a task title. Try: <code>15:00 meeting 1h</code>',
    today: 'Today',
    tomorrow: 'Tomorrow',
    noTime: 'no time',
    emptyDay: 'No tasks for today.',
    digestTitle: (n: number) => `Good morning. You have ${n} task${n === 1 ? '' : 's'} today.`,
    reportTitle: (done: number, total: number) => `Day recap: ${done} of ${total} done.`,
    reportUndone: 'Not done:',
    reportAllDone: 'Everything is done. Great day.',
    reminder: (t: string, inMin: number, at: string) =>
      inMin <= 0 ? `Now: <b>${t}</b> (${at})` : `In ${inMin} min: <b>${t}</b> (${at})`,
    help: 'Commands:\n/today — tasks for today\n/tomorrow — tasks for tomorrow\n/app — open the app\n\nAny other text becomes a task.',
  },
} as const;

function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  return `<b>${title}</b>\n\n${items.map((t) => formatTaskLine(t, lang)).join('\n')}`;
}

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  const withUser = async (ctx: { from?: { id: number; first_name: string; username?: string; language_code?: string } }) => {
    if (!ctx.from) return null;
    const db = getDb(env.DB);
    const user = await ensureUser(db, ctx.from);
    const settings: UserSettings = settingsFromRow(user.settings);
    return { db, user, settings };
  };

  bot.command('start', async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    await ctx.api.setChatMenuButton({
      chat_id: ctx.chat.id,
      menu_button: { type: 'web_app', text: T[lang].open, web_app: { url: env.WEBAPP_URL } },
    });
    await ctx.reply(T[lang].start(esc(ctx.from!.first_name)), { parse_mode: 'HTML', reply_markup: webAppKeyboard(env, lang) });
  });

  bot.command('help', async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    await ctx.reply(T[u.settings.lang].help);
  });

  bot.command('app', async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    await ctx.reply(T[u.settings.lang].open, { reply_markup: webAppKeyboard(env, u.settings.lang) });
  });

  const sendDay = async (ctx: CommandContext<Context>, offset: number) => {
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    const { date } = nowInTz(u.settings.tz);
    const target = offset === 0 ? date : addDaysISO(date, offset);
    const items = await loadDayInstances(env, u.user.id, target);
    const title = `${offset === 0 ? T[lang].today : T[lang].tomorrow}, ${target}`;
    await ctx.reply(dayMessage(items, lang, title), { parse_mode: 'HTML', reply_markup: webAppKeyboard(env, lang) });
  };
  bot.command('today', (ctx) => sendDay(ctx, 0));
  bot.command('tomorrow', (ctx) => sendDay(ctx, 1));

  // Any plain text becomes a task via quick parse.
  bot.on('message:text', async (ctx) => {
    const u = await withUser(ctx);
    if (!u) return;
    const lang = u.settings.lang;
    const { date: today } = nowInTz(u.settings.tz);
    const p = quickParse(ctx.message.text, today);
    if (!p.title) {
      await ctx.reply(T[lang].noTitle, { parse_mode: 'HTML' });
      return;
    }
    const now = Date.now();
    const startMin = p.startMin;
    const endMin = startMin !== null ? (p.endMin ?? Math.min(1440, startMin + 60)) : null;
    await u.db.insert(tasks).values({
      id: crypto.randomUUID(),
      userId: u.user.id,
      title: p.title,
      description: '',
      date: p.date ?? today,
      startMin,
      endMin,
      categoryId: null,
      priority: p.priority ?? 0,
      status: 'todo',
      checklist: '[]',
      reminders: JSON.stringify(startMin !== null ? u.settings.defaultReminders : []),
      repeat: null,
      carriedFrom: null,
      sortOrder: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const when =
      startMin !== null
        ? `${p.date ?? today}, ${minutesToHHMM(startMin)}–${minutesToHHMM(endMin!)} (${formatDuration(endMin! - startMin, lang)})`
        : `${p.date ?? today}, ${T[lang].noTime}`;
    await ctx.reply(T[lang].added(esc(p.title), when), { parse_mode: 'HTML', reply_markup: webAppKeyboard(env, lang) });
  });

  return bot;
}

function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
