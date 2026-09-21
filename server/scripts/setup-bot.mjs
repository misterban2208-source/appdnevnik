// Registers the Telegram webhook, menu button and command list.
//
//   PowerShell: $env:BOT_TOKEN="..."; $env:WEBAPP_URL="https://..."; $env:WEBHOOK_SECRET="..."; npm run setup:bot
//   bash:       BOT_TOKEN=... WEBAPP_URL=https://... WEBHOOK_SECRET=... npm run setup:bot
//
// Missing values fall back to server/.dev.vars, but only for a localhost WEBAPP_URL: pointing a real
// deployment at local dev values would register a webhook Telegram can never reach, and the script
// would still print "ok". Pass --allow-dev-vars to override.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const NAMES = ['BOT_TOKEN', 'WEBAPP_URL', 'WEBHOOK_SECRET'];
const allowDevVars = process.argv.includes('--allow-dev-vars');
const here = dirname(fileURLToPath(import.meta.url));
const devVars = join(here, '..', '.dev.vars');

/** Where each value came from, so the operator can see what is about to be registered. */
const origin = Object.fromEntries(NAMES.map((n) => [n, process.env[n] ? 'окружение' : null]));

if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (m && !process.env[m[1]] && m[2]) {
      process.env[m[1]] = m[2];
      if (NAMES.includes(m[1])) origin[m[1]] = '.dev.vars';
    }
  }
}

const { BOT_TOKEN, WEBAPP_URL, WEBHOOK_SECRET } = process.env;
const missing = NAMES.filter((n) => !process.env[n]);
if (missing.length) {
  console.error(`Не хватает переменных: ${missing.join(', ')} (окружение или server/.dev.vars).`);
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
  console.error('WEBHOOK_SECRET: допустимы только A-Z, a-z, 0-9, _ и - (1-256 символов) — иначе Telegram отвергнет secret_token.');
  process.exit(1);
}

let url;
try {
  url = new URL(WEBAPP_URL);
} catch {
  console.error(`WEBAPP_URL не похож на адрес: ${WEBAPP_URL}`);
  process.exit(1);
}
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (!isLocal && url.protocol !== 'https:') {
  console.error('WEBAPP_URL должен быть https:// — Telegram не принимает другие адреса для Mini App.');
  process.exit(1);
}

console.log('Регистрирую бота со значениями:');
for (const n of NAMES) {
  const raw = process.env[n];
  const shown = n === 'BOT_TOKEN' ? `${raw.slice(0, 6)}…` : n === 'WEBHOOK_SECRET' ? `${raw.slice(0, 3)}… (${raw.length} симв.)` : raw;
  console.log(`  ${n.padEnd(15)} ${shown}   ← ${origin[n] ?? 'окружение'}`);
}

const fromDevVars = NAMES.filter((n) => origin[n] === '.dev.vars');
if (fromDevVars.length && !isLocal && !allowDevVars) {
  console.error(
    `\nОстановился: адрес ${url.origin} выглядит боевым, но ${fromDevVars.join(', ')} взяты из server/.dev.vars (локальные значения).\n` +
      'Задайте их через окружение или запустите с --allow-dev-vars, если это осознанно.',
  );
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
  secret_token: WEBHOOK_SECRET,
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
console.log('Готово. Откройте бота и нажмите /start.');
