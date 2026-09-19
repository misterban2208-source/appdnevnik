import { and, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import type { Lang, TaskInstance } from '@dnevnik/shared';
import { hhmmToMinutes, minutesToHHMM, nowInTz } from '@dnevnik/shared';
import type { Env } from './env.ts';
import { dayMessage, esc, getBot, loadDayInstances, T, truncateMessage, webAppKeyboard } from './bot.ts';
import { carryRootId, getDb, type DB } from './sync.ts';
import { purgeDeletedVoice } from './voice.ts';
import { sentNotifications, settingsFromRow, taskFromRow, tasks, users } from './db/schema.ts';

/** Tolerance window so a missed cron tick still fires (minutes). */
const WINDOW = 3;
/** Users who have not opened the app or the bot for this long are skipped. */
const INACTIVE_MS = 60 * 24 * 3600 * 1000;
const PRUNE_AFTER_MS = 3 * 24 * 3600 * 1000;

function inWindow(fireAt: number, nowMin: number): boolean {
  return fireAt <= nowMin && fireAt > nowMin - WINDOW;
}

/** Atomic one-shot claim: exactly one caller gets `true` for a given key. */
export async function claim(db: DB, key: string): Promise<boolean> {
  const res = await db.insert(sentNotifications).values({ key, sentAt: Date.now() }).onConflictDoNothing().run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseClaim(db: DB, key: string): Promise<void> {
  await db.delete(sentNotifications).where(eq(sentNotifications.key, key));
}

/** Runs `send` under a claim; on failure the claim is released so the next tick retries. */
async function once(db: DB, key: string, send: () => Promise<void>): Promise<void> {
  if (!(await claim(db, key))) return;
  try {
    await send();
  } catch (err) {
    await releaseClaim(db, key).catch(() => {});
    throw err;
  }
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
    // Deterministic id from the root task so client and server converge even when the client skips days.
    await db
      .insert(tasks)
      .values({
        ...row,
        id: `${carryRootId(row.id)}:carry:${today}`,
        date: today,
        carriedFrom: t.carriedFrom ?? t.date,
        status: 'todo',
        createdAt: now,
        updatedAt: now,
        syncedAt: now,
      })
      .onConflictDoNothing();
    // Bump by one millisecond only: any real user edit made later must win last-write-wins.
    await db.update(tasks).set({ status: 'moved', updatedAt: row.updatedAt + 1, syncedAt: now }).where(eq(tasks.id, row.id));
  }
}

export async function runCron(env: Env, at = new Date()): Promise<void> {
  const db = getDb(env.DB);
  // Carry-over must run even when the bot is not configured; only messaging needs the token.
  const bot = env.BOT_TOKEN ? getBot(env) : null;
  const nowMs = at.getTime();
  const allUsers = await db.select().from(users).where(gt(users.lastSeen, nowMs - INACTIVE_MS)).all();

  const utcDay = at.toISOString().slice(0, 10);
  if (await claim(db, `prune:${utcDay}`)) {
    await db.delete(sentNotifications).where(lt(sentNotifications.sentAt, nowMs - PRUNE_AFTER_MS));
  }

  for (const u of allUsers) {
    try {
      const s = settingsFromRow(u.settings);
      const lang: Lang = s.lang;
      const { date: today, minutes: nowMin } = nowInTz(s.tz, at);

      // 1. Carry over unfinished tasks once per day, shortly after midnight.
      if (s.carryover && nowMin >= 5) {
        await once(db, `carry:${u.id}:${today}`, () => carryOver(db, u.id, today));
      }

      if (!bot) continue;
      const dm = s.digestEnabled ? hhmmToMinutes(s.digestMorning) : null;
      const de = s.reportEnabled ? hhmmToMinutes(s.digestEvening) : null;
      const digestDue = dm !== null && inWindow(dm, nowMin);
      const reportDue = de !== null && inWindow(de, nowMin);
      const items: TaskInstance[] = await loadDayInstances(env, u.id, today);
      const kb = webAppKeyboard(env, lang);

      // 2. Per-task reminders.
      for (const t of items) {
        if (t.startMin === null || !t.reminders?.length) continue;
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'moved') continue;
        for (const r of t.reminders) {
          const fireAt = Math.max(0, t.startMin - r);
          if (!inWindow(fireAt, nowMin)) continue;
          const at = `${minutesToHHMM(t.startMin)}${t.endMin !== null ? `–${minutesToHHMM(t.endMin)}` : ''}`;
          await once(db, `rem:${u.id}:${t.id}:${today}:${t.startMin}:${r}`, () =>
            bot.api
              .sendMessage(u.id, truncateMessage(T[lang].reminder(esc(t.title), t.startMin! - nowMin, at)), { parse_mode: 'HTML', reply_markup: kb })
              .then(() => undefined),
          );
        }
      }

      // 3. Morning digest.
      if (digestDue) {
        await once(db, `digest:${u.id}:${today}`, async () => {
          const active = items.filter((t) => t.status !== 'cancelled' && t.status !== 'moved');
          const body = dayMessage(active, lang, T[lang].digestTitle(active.length));
          await bot.api.sendMessage(u.id, truncateMessage(body), { parse_mode: 'HTML', reply_markup: kb });
        });
      }

      // 4. Evening report.
      if (reportDue) {
        await once(db, `report:${u.id}:${today}`, async () => {
          const active = items.filter((t) => t.status !== 'cancelled' && t.status !== 'moved');
          const done = active.filter((t) => t.status === 'done');
          const undone = active.filter((t) => t.status !== 'done');
          let body = `<b>${T[lang].reportTitle(done.length, active.length)}</b>`;
          if (undone.length) body += `\n\n${T[lang].reportUndone}\n${undone.map((t) => `• ${esc(t.title)}`).join('\n')}`;
          else if (active.length) body += `\n\n${T[lang].reportAllDone}`;
          await bot.api.sendMessage(u.id, truncateMessage(body), { parse_mode: 'HTML', reply_markup: kb });
        });
      }
    } catch (err) {
      console.error('cron user failed', u.id, err);
    }
  }

  // 5. Hourly: free R2 objects of voice notes deleted more than a day ago (the undo window is long gone).
  if (await claim(db, `voicepurge:${Math.floor(nowMs / 3_600_000)}`)) {
    try {
      await purgeDeletedVoice(env, db, nowMs - 24 * 3_600_000);
    } catch (err) {
      console.error('voice purge failed', err);
    }
  }
}
