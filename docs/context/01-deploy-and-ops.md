---
author: mine-project-context (7 агентов, чтение кода и коммитов)
captured_at: 2026-09-22
contributor: Дмитрий
---

# Сборка, конфигурация и деплой

_Область: Сборка, конфигурация, деплой (npm workspaces + Cloudflare Wrangler)_

Монорепозиторий из трёх npm-workspaces (shared, server, web) без отдельного шага компиляции: `shared` публикует TS-исходник напрямую (`main`/`exports` → `./src/index.ts`), а собирают его бандлеры потребителей — Vite для фронта и esbuild внутри wrangler для воркера. Прод — один Cloudflare Worker: он же API (Hono), он же вебхук бота (grammY), он же cron, он же раздача статики из `../web/dist` через `[assets]`; dev — два процесса (wrangler на 8787 и Vite на 5173 с прокси `/api`). Конфигурация разделена на три слоя: `server/wrangler.toml` (биндинги D1/R2/ASSETS, cron, публичная переменная `WEBAPP_URL`), секреты `BOT_TOKEN` и `WEBHOOK_SECRET` через `wrangler secret put`, и локальный `server/.dev.vars` с `DEV_USER_ID`, который отключает проверку подписи Telegram и в коде дополнительно ограничен localhost-хостами. Тестами покрыты только чистые функции: парсер быстрого ввода в `shared` (18 тестов) и голосовые хелперы в `server` (9 тестов); sync, auth, cron, бот и весь фронт не покрыты, CI нет, `npm run deploy` не запускает ни typecheck, ни тесты. Коммит 372f59c не менял поведение приложения — он чинил инструкции первого запуска (порядок создания ресурсов и получения адреса воркера) и ужесточал `setup-bot.mjs`.

## Решения (16)

### shared не собирается, а отдаётся как TS-исходник

**Что сделано.** Пакет `@dnevnik/shared` экспортирует `./src/index.ts` как main/types/exports; его скрипт `build` — это `tsc --noEmit`, то есть типопроверка, а не сборка. Server и web импортируют его через symlink workspaces и компилируют сами.

**Почему.** не задокументировано, вывод из кода: оба потребителя — бандлеры (Vite и esbuild внутри wrangler), они принимают TS напрямую, поэтому промежуточный dist был бы лишним звеном и требовал бы порядка сборки; `allowImportingTsExtensions` и явные `.ts` в импортах (server/src/index.ts:7) подтверждают, что резолв идёт по исходникам.

**Основание:** `shared/package.json:6-8,13-14; package.json:5; server/src/index.ts:7-14` · достоверность: INFERRED

### Node ≥ 22.6 ради --experimental-strip-types

**Что сделано.** Все четыре package.json объявляют `engines.node >= 22.6`; тесты запускаются `node --experimental-strip-types --test src/*.test.ts` без транспиляции и без тест-раннера.

**Почему.** записано в README: «Нужен Node 22.6 или новее: тесты запускаются через --experimental-strip-types». Решение убирает из зависимостей vitest/jest и шаг сборки тестов ценой жёсткого требования к версии Node.

**Основание:** `README.md:18; package.json:6-8; server/package.json:15; shared/package.json:15` · достоверность: EXTRACTED

### web/dist обязателен до старта wrangler

**Что сделано.** `[assets] directory = "../web/dist"`; в локальном запуске перед `dev:server` стоит `npm run build --workspace web`, в README отдельный абзац объясняет, что без папки wrangler падает с `assets.directory ... does not exist`.

**Почему.** записано в README и в сообщении коммита 372f59c («a missing assets directory aborts the worker before it binds a port»). Повседневная разработка идёт через Vite, сборка нужна исключительно чтобы воркер стартовал.

**Основание:** `server/wrangler.toml:7-11; README.md:25,32-34; 372f59c` · достоверность: EXTRACTED

### Порядок деплоя продиктован зависимостями Cloudflare

**Что сделано.** Шаги: D1 → R2-бакет → миграции → первый деплой → вписать полученный `WEBAPP_URL` → секреты → повторный деплой → регистрация вебхука. R2-бакет создаётся до деплоя, `WEBAPP_URL` заполняется после первого деплоя, деплой делается дважды.

**Почему.** записано во вводном абзаце раздела: «адрес воркера становится известен только после первого деплоя, а биндинги должны указывать на уже существующие ресурсы»; деплой с биндингом на несуществующий бакет отклоняется.

**Основание:** `README.md:38-39,44-48,50-53,59` · достоверность: EXTRACTED

### Что именно чинил коммит 372f59c

**Что сделано.** Пять дефектов инструкции: (1) в локальном запуске не было сборки web, поэтому `wrangler dev` падал до открытия порта; (2) `WEBAPP_URL` просили задать до первого деплоя, хотя адрес workers.dev тогда ещё неизвестен, а в репозитории лежит заглушка `dnevnik.example.workers.dev`; (3) создание R2-бакета было вынесено в раздел ниже и выполнялось после деплоя, хотя деплой с биндингом на несуществующий бакет отклоняется; (4) не было повторного деплоя после правки `WEBAPP_URL`; (5) `setup-bot` вызывался как `node server/scripts/setup-bot.mjs` без npm-скрипта и без PowerShell-варианта. Дополнительно добавлены `engines.node >= 22.6` в четыре манифеста и переформулирован пункт про `DEV_USER_ID`: было «в продакшене должен быть пустым», стало «должен существовать только в server/.dev.vars».

**Почему.** записано в сообщении коммита: «Verified against wrangler … the deploy list is reordered … the committed value is a placeholder that would point every bot button at someone else's domain». Коммит не трогает ни одного файла в server/src или web/src — это правка документации и обвязки, а не поведения.

**Основание:** `372f59c (README.md, package.json ×4, server/scripts/setup-bot.mjs; 0 файлов в src)` · достоверность: EXTRACTED

### setup-bot.mjs отказывается смешивать dev-значения с боевым адресом

**Что сделано.** Скрипт запоминает происхождение каждого из BOT_TOKEN/WEBAPP_URL/WEBHOOK_SECRET («окружение» или «.dev.vars»), печатает его с маскировкой токена и секрета, и завершает работу с ошибкой, если хотя бы одно значение взято из `.dev.vars`, а WEBAPP_URL не localhost. Обход — флаг `--allow-dev-vars`. Также отвергается не-https адрес и WEBHOOK_SECRET вне `[A-Za-z0-9_-]{1,256}`.

**Почему.** записано в шапке скрипта: подстановка локальных значений зарегистрировала бы вебхук, до которого Telegram никогда не достучится, а скрипт всё равно напечатал бы «ok». Ограничение на charset — требование Telegram к secret_token.

**Основание:** `server/scripts/setup-bot.mjs:6-8,18-28,37-40,49-53,62-69` · достоверность: EXTRACTED

### Один WEBHOOK_SECRET закрывает два канала

**Что сделано.** Секрет одновременно является сегментом пути вебхука (`/bot/<secret>`) и значением Telegram `secret_token`; воркер сверяет оба constant-time-сравнением, причём заголовок проверяется только если он прислан.

**Почему.** не задокументировано явно, вывод из кода: путь отсекает случайный трафик на URL, заголовок — подделку пути; `headerToken !== undefined` допускает вызов без заголовка, что нужно для ручного curl-теста и для старых регистраций вебхука.

**Основание:** `server/src/index.ts:100-103; server/scripts/setup-bot.mjs:84,87` · достоверность: INFERRED

### DEV_USER_ID ограничен не только документацией, но и кодом

**Что сделано.** Обход авторизации срабатывает только если переменная задана И hostname запроса входит в `LOCAL_HOSTS` (localhost, 127.0.0.1, [::1]). В `wrangler.toml` переменной нет — только комментарий-предупреждение, значение живёт в `.dev.vars`, который в .gitignore.

**Почему.** записано комментарием в коде («Dev bypass only ever works against a local wrangler dev server») и в wrangler.toml («must never be deployed»). То есть случайный деплой переменной не открывает дыру — прод-домен не проходит проверку хоста.

**Основание:** `server/src/index.ts:18,44-52; server/wrangler.toml:30; server/.dev.vars.example:4; .gitignore:4` · достоверность: EXTRACTED

### R2-биндинг объявлен опциональным на уровне типов

**Что сделано.** `VOICE?: R2Bucket` в Env; при отсутствии биндинга PUT блоба отвечает 503 `{error:'storage'}`, GET — 404, импорт из чата бота — `{ok:false, reason:'storage'}`, cron-очистка просто выходит. README разрешает удалить блок `[[r2_buckets]]`, если голосовые не нужны.

**Почему.** записано в комментарии env.ts и в контракте docs/voice-notes-contract.md:128-130: приложение обязано работать без биндинга, потому что включение R2 может потребовать привязки карты даже на бесплатном тарифе. Это делает R2 отключаемой частью деплоя, а не обязательной.

**Основание:** `server/src/env.ts:4-5; server/src/voice.ts:121,155,283,343; README.md:47-48,83-85; docs/voice-notes-contract.md:128-130` · достоверность: EXTRACTED

### Cron раз в минуту с окном допуска и claim-таблицей

**Что сделано.** `crons = ["* * * * *"]`; каждый тик выбирает всех пользователей, активных за 180 дней, и отправляет то, что попало в окно `WINDOW = 3` минуты; повторы отсекаются атомарным claim через `INSERT … ON CONFLICT DO NOTHING` в `sent_notifications`, ключи чистятся раз в сутки, очистка R2 удалённых голосовых — раз в час по claim-ключу `voicepurge:<час>`.

**Почему.** частично задокументировано: комментарий «Tolerance window so a missed cron tick still fires» объясняет WINDOW. Минутный шаг — вывод из кода: напоминания задаются в минутах (`startMin - r`), любая более редкая сетка промахивалась бы мимо пользовательского времени.

**Основание:** `server/wrangler.toml:24-25; server/src/cron.ts:11-13,20-23,83,86-88,110-118,151-157` · достоверность: INFERRED

### Двухпроходный typecheck на сервере

**Что сделано.** `tsc --noEmit` по `tsconfig.json` (types: только `@cloudflare/workers-types`, тесты исключены) и второй проход по `tsconfig.test.json` (types: node + workers-types, exclude пустой).

**Почему.** не задокументировано, вывод из кода: рантайм-код воркера не должен видеть типы node, иначе в него незаметно просочатся node-only API, недоступные в Workers; тесты же исполняются в node и нуждаются в `node:test` и `node:assert`. Разделение конфигов — единственный способ проверить и то и другое одним компилятором.

**Основание:** `server/package.json:16; server/tsconfig.json:9-11,21-23; server/tsconfig.test.json:3-12` · достоверность: INFERRED

### deploy включает сборку, но не проверки

**Что сделано.** `npm run deploy` = `npm run build` (shared typecheck + vite build) + `wrangler deploy`. `typecheck` и `test` — отдельные корневые скрипты, в цепочку деплоя не входят; `npm test` покрывает только shared и server, web в нём нет.

**Почему.** не задокументировано, вывод из кода: в `build` попало ровно то, без чего деплой физически не соберётся (web/dist для `[assets]`), а `tsc --noEmit` в web/build даёт частичную проверку фронта. Тесты и typecheck сервера остаются ручным шагом.

**Основание:** `package.json:12-15; web/package.json:11` · достоверность: INFERRED

### Плейсхолдеры в трекаемом wrangler.toml вместо внешней конфигурации

**Что сделано.** `database_id = "REPLACE_WITH_D1_ID"` и `WEBAPP_URL = "https://dnevnik.example.workers.dev"` закоммичены как заглушки; окружений (`[env.*]`) нет — dev и прод отличаются только наличием `.dev.vars` и флагами `--local`/`--remote` у миграций.

**Почему.** для WEBAPP_URL обоснование записано (README:52-53: незаменённая заглушка откроет чужой домен). Для остального — вывод из кода: проект рассчитан на одного владельца и одну инсталляцию, поэтому дешевле править toml руками, чем вводить отдельные окружения.

**Основание:** `server/wrangler.toml:16,29; server/package.json:12-13; README.md:43-44,52-53` · достоверность: INFERRED

### Dev — два процесса и прокси, прод — один воркер

**Что сделано.** Vite на 5173 проксирует `/api` на `http://127.0.0.1:8787`; в проде тот же путь обслуживает сам воркер, а `[assets]` с `run_worker_first = ["/api/*", "/bot/*"]` и SPA-фоллбеком отдаёт фронт. `.claude/launch.json` закрепляет те же два порта.

**Почему.** не задокументировано, вывод из кода: прокси даёт одинаковый origin-relative путь `/api` в обоих режимах, поэтому фронту не нужен базовый URL (`VITE_API_BASE` по умолчанию пустая строка).

**Основание:** `web/vite.config.ts:6-11; server/wrangler.toml:7-11; server/src/index.ts:122; .claude/launch.json:3-18; web/src/lib/api.ts:4` · достоверность: INFERRED

### Миграции — отдельный ручной шаг, local и remote раздельно

**Что сделано.** `db:migrate:local` (`--local`) и `db:migrate` (`--remote`) как два скрипта; `migrations_dir = "migrations"`, три SQL-файла применяются последовательно, 0002 ложится поверх 0000/0001. В README миграции стоят до первого деплоя.

**Почему.** не задокументировано, вывод из кода: wrangler не применяет миграции при деплое, а D1 существует независимо от воркера, поэтому схему можно и нужно накатить заранее; разделение local/remote исключает случайный прогон по боевой базе.

**Основание:** `server/package.json:12-13; server/wrangler.toml:13-17; server/migrations/0000_init.sql, 0001_sync_rev.sql, 0002_voice.sql; README.md:26,49; docs/voice-notes-contract.md:236` · достоверность: INFERRED

### Тестами покрыты только чистые функции

**Что сделано.** Два тестовых файла: `shared/src/quickParse.test.ts` (18 тестов парсера — время, длительность, даты, приоритеты, ложные срабатывания вроде «метры» и диапазонов количества) и `server/src/voice.test.ts` (9 тестов: выбор секции по времени суток, ключевые слова подписи, лимит callback_data, HTML-безопасное усечение, расширение по mime, скоупинг ключей R2 по пользователю и валидация id). Тестов на sync, auth, cron, bot, схему D1 и на весь web нет; CI-конфигов в репозитории нет.

**Почему.** не задокументировано, вывод из кода: покрыто ровно то, что не требует ни D1, ни R2, ни fetch — то есть то, что запускается голым `node --test` без моков и без miniflare. Всё, что завязано на биндинги, проверяется вручную по чеклисту в docs/voice-notes-contract.md:235-238.

**Основание:** `server/src/voice.test.ts:10-91; shared/src/quickParse.test.ts:7-131; server/package.json:15; отсутствие .github в `git ls-files`` · достоверность: EXTRACTED

## Сущности (16)

- **server/wrangler.toml** (config) — Единственное описание продового окружения: биндинги DB (D1), VOICE (R2), ASSETS, минутный cron и публичная переменная WEBAPP_URL. · `server/wrangler.toml`
- **npm workspaces root** (module) — Корневой манифест: три workspace-пакета и скрипты dev/build/deploy/typecheck/test, которыми запускается всё остальное. · `package.json`
- **setup-bot.mjs** (script) — Регистрация вебхука, кнопки меню и списка команд в Telegram; единственное место, где значения конфигурации проверяются перед отправкой наружу. · `server/scripts/setup-bot.mjs`
- **server/.dev.vars.example** (config) — Шаблон локальных переменных: BOT_TOKEN, WEBHOOK_SECRET, WEBAPP_URL=http://localhost:5173 и DEV_USER_ID=1. · `server/.dev.vars.example`
- **Env** (concept) — Контракт биндингов и переменных воркера; VOICE помечен опциональным, DEV_USER_ID — необязательным. · `server/src/env.ts`
- **DEV_USER_ID bypass** (ui-flow) — Обход подписи Telegram для локальной разработки, дополнительно ограниченный списком localhost-хостов внутри middleware. · `server/src/index.ts`
- **/bot/:secret** (endpoint) — Вебхук Telegram: сверяет секрет в пути и в заголовке X-Telegram-Bot-Api-Secret-Token, всегда отвечает 200 чтобы Telegram не переотправлял апдейт. · `server/src/index.ts`
- **scheduled handler** (endpoint) — Точка входа cron: раз в минуту запускает runCron через ctx.waitUntil. · `server/src/index.ts`
- **sent_notifications claim** (table) — Таблица-мьютекс: одноразовые ключи гарантируют, что напоминание, дайджест, перенос задач, экспорт и часовая очистка R2 выполняются один раз. · `server/src/cron.ts`
- **server/migrations** (module) — Три SQL-миграции D1 (init, synced_at для курсора синхронизации, voice_notes), применяются отдельной командой до деплоя. · `server/migrations/0002_voice.sql`
- **vite dev proxy** (config) — Проксирование /api с 5173 на 8787, благодаря чему фронт в обоих режимах ходит по относительному пути. · `web/vite.config.ts`
- **.claude/launch.json** (config) — Конфигурация запуска двух dev-серверов (wrangler 8787, vite 5173) для инструментальной среды. · `.claude/launch.json`
- **voice.test.ts** (module) — Серверные тесты чистых хелперов голосовых заметок: секция по времени суток, callback_data, HTML-усечение, ключи R2. · `server/src/voice.test.ts`
- **quickParse.test.ts** (module) — Тесты парсера быстрого ввода — единственное покрытие shared. · `shared/src/quickParse.test.ts`
- **docs/voice-notes-contract.md** (concept) — Контракт голосовых заметок с ручным тест-планом (typecheck, vite build, wrangler deploy --dry-run, curl-проверки), заменяющим отсутствующий CI. · `docs/voice-notes-contract.md`
- **README deploy checklist** (concept) — Единственное описание первого запуска и деплоя; именно его чинил коммит 372f59c. · `README.md`

## Открытые вопросы (7)

- `VITE_API_BASE` читается фронтом (web/src/lib/api.ts:4), но не упомянут ни в README, ни в .dev.vars.example; отдельного web/.env.example нет — как и когда его задавать, неизвестно.
- Расхождение требований к WEBHOOK_SECRET: README:57 требует 32+ символов, а валидация в setup-bot.mjs:37 пропускает любую строку 1-256 символов из разрешённого алфавита. Односимвольный секрет пройдёт проверку и попадёт в путь вебхука.
- `engines.node >= 22.6` объявлен во всех манифестах, но .npmrc с `engine-strict=true` в репозитории нет — для npm это остаётся рекомендацией, установка на Node 20 не будет заблокирована, а упадут только тесты.
- Нет CI и нет проверок в цепочке деплоя: `npm run deploy` собирает и публикует, не запуская ни `typecheck`, ни `test`; ручной чеклист существует только внутри docs/voice-notes-contract.md:235-238.
- Не покрыты тестами ровно те части, где биндинги: sync (LWW-слияние), валидация initData, cron-окно и claim, обработчики бота, весь web. Регрессия в них обнаруживается только вручную.
- Окружение одно: `[env.production]`/`[env.staging]` в wrangler.toml отсутствуют, а `database_id` и `WEBAPP_URL` правятся прямо в трекаемом файле — значит боевые значения либо коммитятся, либо wrangler.toml постоянно висит изменённым в рабочем дереве.
- Cron бежит каждую минуту и на каждом тике выбирает всех пользователей, активных за 180 дней (cron.ts:83), без пагинации — при росте числа пользователей один тик может не уложиться в лимиты воркера; в коде и документации это нигде не оговорено.

