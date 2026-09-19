# Ежедневник — Telegram Mini App

Личный планировщик с почасовой лентой, повторами, напоминаниями от бота, заметками дня и статистикой.
Тёмный минималистичный дизайн, русский и английский интерфейс, офлайн-режим.

## Структура

| Папка     | Что внутри                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| `shared/` | Типы, парсер быстрого ввода (`14:30 звонок Ивану 45м #работа !!`), логика повторов          |
| `server/` | Cloudflare Worker: API синхронизации, Telegram-бот (grammY), cron напоминаний, статика     |
| `web/`    | React + Vite мини-приложение: экраны День / Неделя / Месяц / Список / Итоги, редактор       |

Данные хранятся в Cloudflare D1 и локально в IndexedDB (last-write-wins синхронизация через `/api/sync`).

## Локальный запуск

```bash
npm install
cp server/.dev.vars.example server/.dev.vars   # DEV_USER_ID=1 позволяет открыть приложение без Telegram
npm run db:migrate:local --workspace server
npm run dev:server                              # http://127.0.0.1:8787  (API + бот)
npm run dev                                     # http://localhost:5173 (Vite, проксирует /api на 8787)
npm test                                        # тесты парсера
```

## Деплой на Cloudflare (бесплатный тариф)

1. Создайте бота в [@BotFather](https://t.me/BotFather), сохраните токен.
2. Войдите в Cloudflare: `npx wrangler login`.
3. Создайте базу: `npx wrangler d1 create dnevnik` и подставьте `database_id` в `server/wrangler.toml`.
4. Примените миграции: `npm run db:migrate --workspace server`.
5. Секреты (в папке `server`):
   ```bash
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET      # любая длинная случайная строка
   ```
6. В `server/wrangler.toml` укажите `WEBAPP_URL` — адрес воркера, например `https://dnevnik.<account>.workers.dev`.
7. Соберите и задеплойте: `npm run deploy` (из корня).
8. Зарегистрируйте вебхук и кнопку меню бота:
   ```bash
   BOT_TOKEN=... WEBAPP_URL=https://... WEBHOOK_SECRET=... node server/scripts/setup-bot.mjs
   ```
9. Откройте бота, нажмите `/start` — кнопка меню откроет приложение.

`DEV_USER_ID` в продакшене должен быть пустым: он отключает проверку подписи Telegram.

## Бот

- `/start`, `/app` — открыть приложение
- `/today`, `/tomorrow` — список задач
- Любой текст — быстрое добавление задачи (`завтра в 9 спорт 1ч #здоровье`)
- Напоминания за N минут до задачи, утренний дайджест и вечерний отчёт в выбранное время (настройки в приложении)
- Экспорт заметок: кнопка в настройках отправляет Markdown-файл в чат
