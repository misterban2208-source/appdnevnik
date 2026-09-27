# Мини ап-дневник: правила для агентов

Telegram Mini App ежедневник. Монорепо npm workspaces: `shared/` (типы, парсер быстрого ввода, повторы), `server/` (Cloudflare Worker: Hono + Drizzle/D1 + grammY + R2 для голосовых), `web/` (React 18 + Vite + zustand + Dexie, local-first с очередью исходящих и синком last-write-wins через `/api/sync`). Почему устроено именно так: `docs/context/00-index.md`. Есть `graphify-out/`: вопросы про архитектуру сначала через `/graphify`.

Работа идёт по конвейеру из глобального `~/.claude/CLAUDE.md` (scout → ТЗ → fixer → reviewer → коммит). Ниже только то, что в этом проекте особенное.

## Команды проверки

| Что | Команда | Примечание |
|---|---|---|
| typecheck | `npm run typecheck` | все воркспейсы; в `server` также тестовый tsconfig |
| тесты | `npm test` | `shared` и `server`, встроенный `node --test`; в `web` тестов нет |
| сборка | `npm run build` | `shared` + `web` |
| preview | серверы `api` (wrangler dev, порт 8787) и `web` (vite, порт 5173) из `.claude/launch.json` | для UI открывать `web`; авторизация без Telegram через `DEV_USER_ID` в `server/.dev.vars`, работает только на localhost |

Браузер общий: UI-проверки ревьюеров по очереди, не параллельно.

## Критичные зоны (проверяет `reviewer-critical`)

- **Синхронизация и данные:** `server/src/sync.ts`, `web/src/lib/sync.ts`, `web/src/lib/db.ts`, `web/src/store/index.ts`, `server/src/db/schema.ts`, `server/migrations/*`, `shared/src/types.ts`, `server/src/validate.ts`.
- **Авторизация и секреты:** `server/src/auth.ts`, `server/src/env.ts`, `server/src/index.ts` (middleware авторизации и dev-обход), `server/.dev.vars*`, секция `[vars]` в `server/wrangler.toml`.
- **Бот и внешние API:** `server/src/bot.ts`, `server/src/cron.ts`, `server/src/voice.ts`, `web/src/lib/telegram.ts`, `web/src/lib/api.ts`.
- **Деплой и деньги:** `server/wrangler.toml`, скрипты `deploy` в `package.json`, раздел деплоя в `README.md`, всё, что может вывести за бесплатные лимиты Workers / D1 / R2.

Правка одного из этих файлов — критичная зона целиком, даже если строка одна.

## Дизайн и язык интерфейса

- Только тёмная тема: графит + золото + глубокий синий. Токены и базовые стили в `web/src/styles/global.css`; новые цвета не вводить, брать токены.
- Шрифт Nunito; заголовки с лёгким наклоном; каскадные анимации сверху вниз через `web/src/components/Reveal.tsx` и framer-motion. Новый экран без каскада — замечание.
- Интерфейс по-русски, строки в `web/src/i18n/index.ts`, не в компонентах. Ревьюер проверяет опечатки и склонения.
- Хаптика через `web/src/lib/telegram.ts` на значимых действиях (создание, удаление, завершение).
- Офлайн работает всегда: любая правка данных сначала в Dexie, потом в очередь исходящих. Правка, которая ждёт сеть, не принимается.
- Состояния пусто / загрузка / ошибка обязательны для нового списка или экрана.

## Коммиты

- Заголовок по-английски в повелительном наклонении, как в истории (`git log --format=%s -10`); тело «зачем», если из диффа не видно.
- Файлы добавлять по именам. Никогда: `server/.dev.vars`, `.env*`, `*.db`, `graphify-out/`.
- Remote: `origin` → github.com/misterban2208-source/appdnevnik (публичный). Пуш — только после ЧИСТО от `auditor`, через `/ship`; учётка GitHub хранится в Windows Credential Manager, запрашивать её не нужно.

## Среда

- Windows, PowerShell 5.1, кириллица в пути проекта. Большие правки и файлы с кириллицей писать через Write/Edit, не через bash heredoc; JSON без BOM.
- Не проверено вживую: реальный Telegram на iOS/Android, бот с настоящим токеном, деплой. Правки в этих зонах ревьюер помечает «не проверено в реальной среде» и пишет, как владельцу проверить руками.
