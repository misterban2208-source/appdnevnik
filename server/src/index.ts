import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { InputFile, webhookCallback } from 'grammy';
import { asc, eq } from 'drizzle-orm';
import type { SyncRequest } from '@dnevnik/shared';
import type { Env } from './env.ts';
import { validateInitData, type TelegramUser } from './auth.ts';
import { applySync, ensureUser, getDb } from './sync.ts';
import { createBot } from './bot.ts';
import { runCron } from './cron.ts';
import { dayNotes, settingsFromRow, users } from './db/schema.ts';

type Variables = { user: typeof users.$inferSelect };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('/api/*', cors({ origin: (origin) => origin || '*', allowHeaders: ['Authorization', 'Content-Type'] }));

app.get('/api/health', (c) => c.json({ ok: true, now: Date.now() }));

// ---- Auth: `Authorization: tma <initData>` ----
app.use('/api/*', async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  let tg: TelegramUser | null = null;
  if (header.startsWith('tma ')) {
    tg = await validateInitData(header.slice(4), c.env.BOT_TOKEN);
  } else if (c.env.DEV_USER_ID) {
    tg = { id: Number(c.env.DEV_USER_ID), first_name: 'Dev', language_code: 'ru' };
  }
  if (!tg) return c.json({ error: 'unauthorized' }, 401);
  const user = await ensureUser(getDb(c.env.DB), tg);
  c.set('user', user);
  await next();
});

app.get('/api/me', (c) => {
  const u = c.get('user');
  return c.json({ id: u.id, firstName: u.firstName, username: u.username, settings: settingsFromRow(u.settings) });
});

app.post('/api/sync', async (c) => {
  const body = (await c.req.json().catch(() => null)) as SyncRequest | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'bad request' }, 400);
  const res = await applySync(getDb(c.env.DB), c.get('user'), body);
  return c.json(res);
});

/** Sends all day notes to the user's chat as a Markdown document. */
app.post('/api/export/notes', async (c) => {
  const u = c.get('user');
  const s = settingsFromRow(u.settings);
  const rows = await getDb(c.env.DB).select().from(dayNotes).where(eq(dayNotes.userId, u.id)).orderBy(asc(dayNotes.date)).all();
  const ru = s.lang === 'ru';
  const lines: string[] = [`# ${ru ? 'Заметки' : 'Notes'}`, ''];
  for (const n of rows) {
    if (!n.morning.trim() && !n.evening.trim()) continue;
    lines.push(`## ${n.date}`, '');
    if (n.morning.trim()) lines.push(`### ${ru ? 'Утро' : 'Morning'}`, '', n.morning.trim(), '');
    if (n.evening.trim()) lines.push(`### ${ru ? 'Вечер' : 'Evening'}`, '', n.evening.trim(), '');
  }
  const md = lines.join('\n');
  const bot = createBot(c.env);
  await bot.api.sendDocument(u.id, new InputFile(new TextEncoder().encode(md), `notes-${new Date().toISOString().slice(0, 10)}.md`), {
    caption: ru ? 'Экспорт заметок' : 'Notes export',
  });
  return c.json({ ok: true, count: rows.length });
});

// ---- Telegram webhook ----
app.post('/bot/:secret', async (c) => {
  if (!c.env.WEBHOOK_SECRET || c.req.param('secret') !== c.env.WEBHOOK_SECRET) return c.text('forbidden', 403);
  const bot = createBot(c.env);
  return webhookCallback(bot, 'hono')(c);
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};
