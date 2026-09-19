import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { InputFile, webhookCallback } from 'grammy';
import { asc, eq } from 'drizzle-orm';
import type { Env } from './env.ts';
import { validateInitData, type TelegramUser } from './auth.ts';
import { applySync, ensureUser, getDb } from './sync.ts';
import { getBot, setWaitUntil } from './bot.ts';
import { claim, runCron } from './cron.ts';
import { voiceRoutes } from './voice.ts';
import { dayNotes, settingsFromRow, users } from './db/schema.ts';
import { validateSyncRequest, ValidationError } from './validate.ts';

type Variables = { user: typeof users.$inferSelect };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  if (err instanceof HTTPException) return err.getResponse();
  console.error('unhandled', err);
  return c.json({ error: 'internal' }, 500);
});

app.use('/api/*', cors({ origin: (origin) => origin || '*', allowHeaders: ['Authorization', 'Content-Type'] }));
// JSON routes only: voice blobs carry their own limit under /api/voice/*.
app.use('/api/sync', bodyLimit({ maxSize: 1024 * 1024 }));
app.use('/api/export/*', bodyLimit({ maxSize: 1024 * 1024 }));

app.get('/api/health', (c) => c.json({ ok: true, now: Date.now() }));

// ---- Auth: `Authorization: tma <initData>` ----
app.use('/api/*', async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  let tg: TelegramUser | null = null;
  if (header.startsWith('tma ')) {
    tg = await validateInitData(header.slice(4), c.env.BOT_TOKEN);
  } else if (c.env.DEV_USER_ID && LOCAL_HOSTS.has(new URL(c.req.url).hostname)) {
    // Dev bypass only ever works against a local wrangler dev server.
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
  const body = await c.req.json().catch(() => null);
  const req = validateSyncRequest(body, Date.now());
  const res = await applySync(getDb(c.env.DB), c.get('user'), req);
  return c.json(res);
});

/** Sends all day notes to the user's chat as a Markdown document (at most once per minute). */
app.post('/api/export/notes', async (c) => {
  const u = c.get('user');
  const db = getDb(c.env.DB);
  if (!(await claim(db, `export:${u.id}:${Math.floor(Date.now() / 60_000)}`))) return c.json({ error: 'rate_limited' }, 429);
  if (!c.env.BOT_TOKEN) return c.json({ error: 'bot_not_configured' }, 503);
  const s = settingsFromRow(u.settings);
  const rows = await db.select().from(dayNotes).where(eq(dayNotes.userId, u.id)).orderBy(asc(dayNotes.date)).all();
  const ru = s.lang === 'ru';
  const lines: string[] = [`# ${ru ? 'Заметки' : 'Notes'}`, ''];
  let count = 0;
  for (const n of rows) {
    if (!n.morning.trim() && !n.evening.trim()) continue;
    count++;
    lines.push(`## ${n.date}`, '');
    if (n.morning.trim()) lines.push(`### ${ru ? 'Утро' : 'Morning'}`, '', n.morning.trim(), '');
    if (n.evening.trim()) lines.push(`### ${ru ? 'Вечер' : 'Evening'}`, '', n.evening.trim(), '');
  }
  if (!count) return c.json({ ok: true, count: 0 });
  const md = lines.join('\n');
  await getBot(c.env).api.sendDocument(u.id, new InputFile(new TextEncoder().encode(md), `notes-${new Date().toISOString().slice(0, 10)}.md`), {
    caption: ru ? 'Экспорт заметок' : 'Notes export',
  });
  return c.json({ ok: true, count });
});

app.route('/api/voice', voiceRoutes);

// ---- Telegram webhook: secret both in the path and in Telegram's secret-token header ----
app.post('/bot/:secret', async (c) => {
  if (!c.env.WEBHOOK_SECRET || !constantTimeEqual(c.req.param('secret'), c.env.WEBHOOK_SECRET)) return c.text('forbidden', 403);
  const headerToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (headerToken !== undefined && !constantTimeEqual(headerToken, c.env.WEBHOOK_SECRET)) return c.text('forbidden', 403);
  // Long jobs (voice import) must outlive the webhook response so Telegram does not redeliver the update.
  let waitUntil: ((p: Promise<unknown>) => void) | null = null;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    /* no execution context (e.g. tests): handlers await instead */
  }
  setWaitUntil(waitUntil);
  try {
    return await webhookCallback(getBot(c.env), 'hono')(c);
  } catch (err) {
    // grammY routes errors to bot.catch only for long polling. A webhook error would otherwise answer
    // 500 and Telegram would redeliver the same update for hours, repeating every side effect with it.
    console.error('webhook handler failed', err);
    return c.text('ok');
  }
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};
