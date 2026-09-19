import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Lang, TaskInstance } from '@dnevnik/shared';
import { hhmmToMinutes, minutesToHHMM, nowInTz } from '@dnevnik/shared';
import type { Env } from './env.ts';
import { createBot, dayMessage, esc, loadDayInstances, T, webAppKeyboard } from './bot.ts';
import { getDb, type DB } from './sync.ts';
import { sentNotifications, settingsFromRow, taskFromRow, tasks, users } from './db/schema.ts';

/** Tolerance window so a missed cron tick still fires (minutes). */
const WINDOW = 3;

function inWindow(fireAt: number, nowMin: number): boolean {
  return fireAt <= nowMin && fireAt > nowMin - WINDOW;
}

async function claim(db: DB, key: string): Promise<boolean> {
  const existing = await db.select({ key: sentNotifications.key }).from(sentNotifications).where(eq(sentNotifications.key, key)).get();
  if (existing) return false;
  await db.insert(sentNotifications).values({ key, sentAt: Date.now() }).onConflictDoNothing();
  return true;
}

async function carryOver(db: DB, userId: number, today: string): Promise<void> {
  const stale = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        isNull(tasks.deletedAt),
        isNull(tasks.repeat),
        lt(tasks.date, today),
        inArray(tasks.status, ['todo', 'in_progress']),
      ),
    )
    .all();
  if (!stale.length) return;
  const now = Date.now();
  for (const row of stale) {
    const t = taskFromRow(row);
    // Deterministic id so an offline client doing the same carry-over merges instead of duplicating.
    await db
      .insert(tasks)
      .values({
        ...row,
        id: `${row.id}:carry:${today}`,
        date: today,
        carriedFrom: t.carriedFrom ?? t.date,
        status: 'todo',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db.update(tasks).set({ status: 'moved', updatedAt: now }).where(eq(tasks.id, row.id));
  }
}

export async function runCron(env: Env, at = new Date()): Promise<void> {
  const db = getDb(env.DB);
  // Carry-over must run even when the bot is not configured; only messaging needs the token.
  const bot = env.BOT_TOKEN ? createBot(env) : null;
  const allUsers = await db.select().from(users).all();

  for (const u of allUsers) {
    try {
      const s = settingsFromRow(u.settings);
      const lang: Lang = s.lang;
      const { date: today, minutes: nowMin } = nowInTz(s.tz, at);

      // 1. Carry over unfinished tasks once per day, shortly after midnight.
      if (s.carryover && nowMin >= 5 && (await claim(db, `carry:${u.id}:${today}`))) {
        await carryOver(db, u.id, today);
      }

      if (!bot) continue;
      const items: TaskInstance[] = await loadDayInstances(env, u.id, today);

      // 2. Per-task reminders.
      for (const t of items) {
        if (t.startMin === null || !t.reminders?.length) continue;
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'moved') continue;
        for (const r of t.reminders) {
          const fireAt = t.startMin - r;
          if (!inWindow(fireAt, nowMin)) continue;
          if (!(await claim(db, `rem:${u.id}:${t.id}:${today}:${r}`))) continue;
          const at = `${minutesToHHMM(t.startMin)}${t.endMin !== null ? `–${minutesToHHMM(t.endMin)}` : ''}`;
          await bot.api.sendMessage(u.id, T[lang].reminder(esc(t.title), t.startMin - nowMin, at), {
            parse_mode: 'HTML',
            reply_markup: webAppKeyboard(env, lang),
          });
        }
      }

      // 3. Morning digest.
      const dm = hhmmToMinutes(s.digestMorning);
      if (s.digestEnabled && dm !== null && inWindow(dm, nowMin) && (await claim(db, `digest:${u.id}:${today}`))) {
        const active = items.filter((t) => t.status !== 'cancelled' && t.status !== 'moved');
        const body = dayMessage(active, lang, T[lang].digestTitle(active.length));
        await bot.api.sendMessage(u.id, body, { parse_mode: 'HTML', reply_markup: webAppKeyboard(env, lang) });
      }

      // 4. Evening report.
      const de = hhmmToMinutes(s.digestEvening);
      if (s.reportEnabled && de !== null && inWindow(de, nowMin) && (await claim(db, `report:${u.id}:${today}`))) {
        const active = items.filter((t) => t.status !== 'cancelled' && t.status !== 'moved');
        const done = active.filter((t) => t.status === 'done');
        const undone = active.filter((t) => t.status !== 'done');
        let body = `<b>${T[lang].reportTitle(done.length, active.length)}</b>`;
        if (undone.length) body += `\n\n${T[lang].reportUndone}\n${undone.map((t) => `• ${esc(t.title)}`).join('\n')}`;
        else if (active.length) body += `\n\n${T[lang].reportAllDone}`;
        await bot.api.sendMessage(u.id, body, { parse_mode: 'HTML', reply_markup: webAppKeyboard(env, lang) });
      }
    } catch (err) {
      console.error('cron user failed', u.id, err);
    }
  }
}
