// Registers the Telegram webhook, menu button and command list.
// Usage: BOT_TOKEN=... WEBAPP_URL=https://... WEBHOOK_SECRET=... node scripts/setup-bot.mjs
// Values are also read from server/.dev.vars if present.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const devVars = join(here, '..', '.dev.vars');
if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { BOT_TOKEN, WEBAPP_URL, WEBHOOK_SECRET } = process.env;
if (!BOT_TOKEN || !WEBAPP_URL || !WEBHOOK_SECRET) {
  console.error('Need BOT_TOKEN, WEBAPP_URL and WEBHOOK_SECRET (env or server/.dev.vars).');
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  console.log(`${method}: ok`);
  return json.result;
}

await call('setWebhook', {
  url: `${WEBAPP_URL.replace(/\/$/, '')}/bot/${WEBHOOK_SECRET}`,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});
await call('setChatMenuButton', {
  menu_button: { type: 'web_app', text: 'Ежедневник', web_app: { url: WEBAPP_URL } },
});
await call('setMyCommands', {
  commands: [
    { command: 'app', description: 'Открыть ежедневник' },
    { command: 'today', description: 'Задачи на сегодня' },
    { command: 'tomorrow', description: 'Задачи на завтра' },
    { command: 'help', description: 'Помощь' },
  ],
  language_code: 'ru',
});
await call('setMyCommands', {
  commands: [
    { command: 'app', description: 'Open planner' },
    { command: 'today', description: 'Tasks for today' },
    { command: 'tomorrow', description: 'Tasks for tomorrow' },
    { command: 'help', description: 'Help' },
  ],
});
console.log('Done.');
