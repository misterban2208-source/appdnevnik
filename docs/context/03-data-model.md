---
author: mine-project-context (7 агентов, чтение кода и коммитов)
captured_at: 2026-09-22
contributor: Дмитрий
---

# Модель данных и общий код

_Область: Модель данных и общий код: shared/ + миграции D1 (server/migrations/*.sql)_

Слой данных — это пять синхронизируемых сущностей (tasks, occurrences, categories, day_notes, voice_notes) плюс два служебных стола: users с настройками в JSON-блобе и sent_notifications как таблица атомарных claim'ов для крона. Схема плоская: ни одного FOREIGN KEY, все структурные поля (checklist, reminders, repeat, settings) лежат TEXT-ом с JSON внутри, связи держатся на детерминированных id (`taskId:date` для occurrence, `userId:date` для заметки дня, `root:carry:date` для перенесённой задачи). Синхронизация — last-write-wins по клиентскому `updated_at`, но курсор пулла строится на серверном `synced_at`, добавленном миграцией 0001 именно потому, что клиентским часам верить нельзя; миграция 0002 добавила voice_notes как пятую сущность с разделением колонок на клиентские и серверные. Повторяемость не материализуется в строки: правило живёт в JSON-поле `repeat`, а конкретные экземпляры дня собирает чистая функция `instancesForDate` из shared, накладывая на шаблон override-строку occurrences. Даты везде — локальная ISO-строка `YYYY-MM-DD` без смещения, время — минуты от полуночи, моменты — epoch ms; «сегодня» сервер вычисляет per-user через `nowInTz(settings.tz)`, а не через часы воркера. shared/ отдаётся как TypeScript-исходник без сборки и содержит четыре модуля: типы (единственный контракт сервер↔клиент), календарная арифметика, правила повторяемости и парсер быстрого ввода, общий для мини-аппа и бота.

## Решения (29)

### Даты как локальная ISO-строка, время как минуты

**Что сделано.** date TEXT 'YYYY-MM-DD' без смещения и таймзоны; start_min/end_min — INTEGER минут от полуночи (0..1440); created_at/updated_at/deleted_at — epoch ms INTEGER.

**Почему.** не задокументировано, вывод из кода: у ежедневника нет абсолютного момента, есть «клетка дня», поэтому день не зависит от того, в какой таймзоне его открыли; сравнение дат сводится к лексикографическому (compareISO), а раскладка таймлайна — к целочисленной арифметике без Date

**Основание:** `server/migrations/0000_init.sql:16-18; shared/src/types.ts:24-28; shared/src/time.ts:51-53` · достоверность: INFERRED

### synced_at как серверный курсор пулла

**Что сделано.** Миграция 0001 добавила synced_at во все четыре тогдашние синкуемые таблицы, забэкфиллила его значением updated_at и завела индексы (user_id, synced_at). Пулл фильтрует `synced_at > since`, а не `updated_at > since`.

**Почему.** записано в самой миграции: «Server-assigned receive timestamp: the pull cursor must not depend on client clocks». Устройство с убежавшими вперёд часами иначе выставляло бы курсор в будущее и теряло чужие изменения

**Основание:** `server/migrations/0001_sync_rev.sql:1-15; server/src/sync.ts:125-140` · достоверность: EXTRACTED

### Курсор отдаётся с перекрытием 60 секунд

**Что сделано.** В ответе `now` = Date.now() - 60_000, снятый ДО собственных записей запроса, а не время окончания обработки.

**Почему.** записано в комментарии: параллельный запрос или тик крона мог проштамповать строки чуть более ранним временем, но закоммититься позже; перекрытие гарантирует их доставку в следующий раз, а LWW делает повторную доставку безвредной

**Основание:** `server/src/sync.ts:30-31,184-186,206` · достоверность: EXTRACTED

### LWW по updated_at с чанками по 50 id

**Что сделано.** upsertLWW сначала одним SELECT ... IN (чанками по 50) читает существующие updated_at в пределах user_id, потом построчно решает insert/update/skip.

**Почему.** записано: «D1 allows at most 100 bound parameters per statement» — отсюда 50 id на выборку. Предварительное чтение нужно, чтобы LWW-сравнение не зависело от несуществующего в SQLite ON CONFLICT ... WHERE excluded.updated_at > updated_at в комбинации с user-скоупом

**Основание:** `server/src/sync.ts:28-29,84-123` · достоверность: EXTRACTED

### Клиентские таймстемпы клампятся, а не отвергаются

**Что сделано.** timestamp() ограничивает любое присланное время значением now + 5 минут; duration и size клампятся в диапазон, out-of-range минуты округляются в [min,max].

**Почему.** записано: устройство с убежавшими часами иначе «залочило» бы строку на часы, а одна кривая строка (час аудио из бота) заставляла /api/sync отвечать 400 навсегда — коммит a323b66 описывает именно этот сценарий: свайп по такой пилюле клал строку в outbox и устройство переставало синхронизироваться до вайпа хранилища

**Основание:** `server/src/validate.ts:60-64,78-82,203-206; commit a323b66` · достоверность: EXTRACTED

### Три разных стиля мягкого удаления

**Что сделано.** tasks/categories/voice_notes — deleted_at INTEGER NULL (тумбстоун с временем); occurrences — deleted INTEGER NOT NULL DEFAULT 0 (булев флаг); day_notes — удаления нет вообще, поля morning/evening просто пустеют.

**Почему.** не задокументировано, вывод из кода: у occurrence нет своей жизни вне серии — флаг означает «этот день серии пропущен», а не «сущность удалена», поэтому время удаления не нужно; у заметки дня id детерминирован из даты, пустая строка и есть её отсутствие, тумбстоун был бы лишней сущностью

**Основание:** `server/migrations/0000_init.sql:29,43,56,60-67; server/migrations/0002_voice.sql:15` · достоверность: INFERRED

### Тумбстоуны вечны, чистятся только байты в R2

**Что сделано.** purgeDeletedVoice удаляет объекты R2 для заметок, помеченных deleted_at раньше cutoff (сутки), и обнуляет r2_key/uploaded_at, но сама строка остаётся. Удалённых tasks/categories/occurrences не чистит никто.

**Почему.** записано в комментарии: «the tombstones themselves stay for sync» — строка нужна, чтобы другие устройства узнали об удалении; сутки отсрочки дают окну на отмену/долив с медленного устройства

**Основание:** `server/src/voice.ts:339-360; server/src/cron.ts:152-154` · достоверность: EXTRACTED

### Колонки voice_notes разделены на клиентские и серверные

**Что сделано.** r2_key, uploaded_at, tg_file_id, tg_file_unique_id объявлены server-owned; voiceToRow формирует строку только из клиентских полей, validateVoiceNote принудительно кладёт uploadedAt = null, voiceFromRow наружу отдаёт uploadedAt и никогда r2_key и tg-идентификаторы.

**Почему.** записано: «Client-owned columns only, so a sync upsert can never clear r2_key, uploaded_at or the Telegram ids» — иначе обычный LWW-апдейт от устройства, не знающего про загрузку, стёр бы ссылку на уже лежащие в R2 байты

**Основание:** `server/src/db/schema.ts:86-91,234-250; server/src/validate.ts:212-213; server/migrations/0002_voice.sql:16-19` · достоверность: EXTRACTED

### uploadedAt мержится монотонно, мимо LWW

**Что сделано.** На клиенте voiceNotes мержатся отдельной функцией: берётся более свежая по updatedAt запись как база, а uploadedAt подставляется из входящей либо из базы — то есть однажды появившись, он не исчезает из-за проигрыша в LWW.

**Почему.** записано: uploadedAt серверный и только растёт, «a client tombstone must not lose it and vice versa» — локальная правка (например, смена секции) иначе откатила бы факт загрузки и клиент снова полез бы заливать байты

**Основание:** `web/src/lib/sync.ts:77-93; shared/src/types.ts:96-97` · достоверность: EXTRACTED

### Частичные индексы вместо полных

**Что сделано.** 0001 добавил idx_tasks_user_repeat ON tasks(user_id) WHERE repeat IS NOT NULL; 0002 — idx_voice_purge ON voice_notes(deleted_at) WHERE deleted_at IS NOT NULL AND r2_key IS NOT NULL и UNIQUE idx_voice_tg_unique ON (user_id, tg_file_unique_id) WHERE tg_file_unique_id IS NOT NULL.

**Почему.** не задокументировано, вывод из кода: каждый индекс обслуживает ровно один горячий запрос — выборку дня в боте `date = ? OR repeat IS NOT NULL`, перебор кандидатов на purge и идемпотентность импорта голосового из Telegram; условие WHERE держит индекс маленьким, потому что повторяемых и удалённых строк единицы

**Основание:** `server/migrations/0001_sync_rev.sql:16; server/migrations/0002_voice.sql:23-24; server/src/bot.ts:174-181; server/src/voice.ts:344-348` · достоверность: INFERRED

### Структурные поля как JSON в TEXT

**Что сделано.** checklist, reminders, repeat, users.settings хранятся сериализованным JSON в TEXT; parseJSON при битом значении молча возвращает фолбэк, settingsFromRow разливает распарсенное поверх DEFAULT_SETTINGS.

**Почему.** не задокументировано, вывод из кода: новая настройка или новое поле правила повторения не требуют миграции D1 — старая строка просто получит дефолт при чтении; ценой отказа от запросов по этим полям, которых в коде и нет

**Основание:** `server/migrations/0000_init.sql:5,22-24; server/src/db/schema.ts:100-107,252-254` · достоверность: INFERRED

### Ни одного внешнего ключа

**Что сделано.** occurrences.task_id, tasks.category_id, все user_id — обычные колонки без FOREIGN KEY и без ON DELETE.

**Почему.** не задокументировано, вывод из кода: оффлайн-клиент шлёт таблицы независимыми массивами в одном запросе, и occurrence вполне может приехать раньше своей задачи (или вместо неё, если задача попала в следующую страницу outbox); FK отверг бы такую вставку и заблокировал синхронизацию устройства

**Основание:** `server/migrations/0000_init.sql:34-45; web/src/lib/sync.ts:13-14,44-51` · достоверность: INFERRED

### Детерминированные id вместо суррогатных

**Что сделано.** occurrence.id = `${taskId}:${date}`, заметка дня на сервере = `${userId}:${date}`, перенесённая задача = `${carryRootId(id)}:carry:${today}`, дефолтная категория = `${tgId}:cat:${i}`.

**Почему.** записано для carry-over («Deterministic id from the root task so client and server converge even when the client skips days») и для дефолтных категорий («deterministic ids + do-nothing conflicts keep it idempotent»); по той же схеме id occurrence пересобирается на сервере из taskId+date, так что клиент не может подсунуть рассогласованный ключ

**Основание:** `shared/src/recurrence.ts:34-36; server/src/validate.ts:141-145; server/src/cron.ts:62-64; server/src/sync.ts:37-39,62-78` · достоверность: EXTRACTED

### id заметки дня разный снаружи и внутри

**Что сделано.** На проводе и в Dexie DayNote.id = дата; в D1 первичный ключ = `${userId}:${date}`. noteToRow подменяет id при записи, noteFromRow возвращает r.date при чтении.

**Почему.** не задокументировано, вывод из кода: у клиента одна учётка и дата уже уникальна, а в общей таблице D1 голая дата столкнулась бы между пользователями; подмена в конвертерах оставляет клиентский код простым (notes — это Record<date, DayNote>)

**Основание:** `server/src/db/schema.ts:201-214; web/src/store/index.ts:440-441; server/src/validate.ts:174-177` · достоверность: INFERRED

### userId в доменных типах — заглушка

**Что сделано.** Поле userId есть во всех интерфейсах, но валидатор жёстко ставит 0, клиент тоже пишет 0, а реальный id берётся из авторизации и подставляется в *ToRow(obj, userId).

**Почему.** не задокументировано, вывод из кода: присланному userId нельзя верить, а удалять поле из общего типа — ломать симметрию со строкой БД; единая точка подстановки (конвертеры) делает подделку user_id структурно невозможной

**Основание:** `server/src/validate.ts:118,146,163; web/src/store/index.ts:441; server/src/sync.ts:189-195` · достоверность: INFERRED

### Повторяемость не материализуется

**Что сделано.** Повторяющаяся задача — одна строка tasks с JSON-правилом repeat; экземпляры дня считает occursOn/instancesForDate на лету, а отклонения от шаблона живут в occurrences (status, start_min, end_min, checklist, deleted).

**Почему.** не задокументировано, вывод из кода: ежедневное правило без конца иначе породило бы бесконечное число строк; строка в occurrences создаётся только там, где пользователь реально что-то поменял в конкретном дне

**Основание:** `shared/src/recurrence.ts:4-32,39-72; shared/src/types.ts:43-55; server/migrations/0000_init.sql:34-45` · достоверность: EXTRACTED

### Стартовая дата серии всегда видима

**Что сделано.** occursOn возвращает true для task.date до проверки правила; даты раньше старта и позже until отсекаются; weekly без days подставляет день недели стартовой даты; monthly клампится до последнего дня короткого месяца.

**Почему.** записано в комментариях: «a rule that never matches cannot make the task unreachable» и «Clamp to the last day of short months so a task on the 31st still occurs in February» — то есть правило никогда не может сделать задачу недостижимой для редактирования

**Основание:** `shared/src/recurrence.ts:5-8,17-20,23-28` · достоверность: EXTRACTED

### Статус и чеклист повторяемой задачи — посуточные

**Что сделано.** В instancesForDate статус экземпляра берётся из override, иначе всегда 'todo'; чеклист без override отдаётся с done: false у всех пунктов; startMin/endMin наследуются от шаблона только при null в override.

**Почему.** записано: «The series template's own status is meaningless per day; only the override counts» и «Checklist ticks are per day» — иначе вчерашняя галочка показывалась бы выполненной сегодня

**Основание:** `shared/src/recurrence.ts:58-69` · достоверность: EXTRACTED

### Перенос задач копией, оригинал в 'moved'

**Что сделано.** Крон раз в сутки копирует незакрытые непериодические задачи прошлых дней на сегодня с id `root:carry:today` и carried_from = исходная дата, а оригинал переводит в статус 'moved' с updated_at = старый + 1 мс.

**Почему.** записано: «Bump by one millisecond only: any real user edit made later must win last-write-wins» — синтетическая правка сервера не должна выигрывать у настоящего редактирования; carried_from сохраняет исходную дату сквозь цепочку переносов (t.carriedFrom ?? t.date)

**Основание:** `server/src/cron.ts:41-76; server/migrations/0000_init.sql:25` · достоверность: EXTRACTED

### Завершение задачи побеждает авто-перенос

**Что сделано.** Хук completionBeatsCarryOver: если на сервере статус 'moved', а клиент прислал 'done'/'cancelled', запись применяется принудительно, её updated_at поднимается до серверного syncedAt, а все копии `root:carry:%` со статусом todo помечаются deleted_at.

**Почему.** записано: «A client's explicit completion of a task that the server auto-carried must win over the synthetic 'moved' status (whatever the clocks say), and the carried copy must disappear» — иначе пользователь, закрывший задачу оффлайн, получал бы её дубль на сегодня

**Основание:** `server/src/sync.ts:168-180,189-191,110-114` · достоверность: EXTRACTED

### quickParse — чистая функция, «сегодня» передаётся снаружи

**Что сделано.** Сигнатура quickParse(input, today = toISODate(new Date())); и бот, и мини-апп передают today явно — бот из nowInTz(settings.tz).

**Почему.** записано: «`today` must be the real current date (date words are absolute references)». Вывод из кода: дефолт по локальным часам на воркере дал бы UTC-дату, поэтому серверный вызов обязан подставлять пользовательскую таймзону

**Основание:** `shared/src/quickParse.ts:84-88; server/src/bot.ts:300-301; web/src/components/QuickAdd.tsx:31` · достоверность: EXTRACTED

### Парсер построен на защите от ложных срабатываний

**Что сделано.** Диапазон «2-3» считается временем только при наличии минут, предлога или правдоподобных часов; «400 м» выше 240 не длительность, а метры; «9.30» без года и с днём ≤12 — время, «12.05» с ведущим нулём месяца — дата; короткие дни недели (сб/sat) принимаются только в начале строки или после предлога; календарно невалидные даты (31.04) игнорируются.

**Почему.** записано прямо в комментариях («A bare "2-3" is a quantity», «Bare "м"/"m" above four hours is a distance», «Short forms are only accepted after a preposition») и закреплено тестами: «сделать 2-3 звонка», «плавание 500 м», «buy sun cream» не должны превращаться во время/дату

**Основание:** `shared/src/quickParse.ts:25-28,38,147-148,165-166,210-213; shared/src/quickParse.test.ts:86-92,103-107,118-122` · достоверность: EXTRACTED

### Длительность через полночь обрезается с флагом clamped

**Что сделано.** Если start + duration > 1440, endMin = 1440, durationMin пересчитывается, выставляется clamped: true. Тот же приём в диапазонах: end <= start → start + 60, не больше 1440.

**Почему.** записано полем «Set when the requested duration was cut at midnight» и тестом «23:30 сон 1ч» → end 1440, duration 30. Вывод из кода: интерфейс строится на минутах одного дня, переносить блок на следующие сутки нечем — поэтому обрезаем и сообщаем, а не отказываем

**Основание:** `shared/src/quickParse.ts:12-13,169-171,216-223; shared/src/quickParse.test.ts:124-129` · достоверность: EXTRACTED

### Таймзона у пользователя, «сегодня» вычисляется через Intl

**Что сделано.** settings.tz (IANA, по умолчанию Europe/Moscow) валидируется через конструктор Intl.DateTimeFormat; nowInTz разбирает formatToParts в {date, minutes, weekday} и при исключении падает на локальные часы. Крон гоняет всех пользователей одним тиком, но день и минуты берёт per-user.

**Почему.** не задокументировано, вывод из кода: один UTC-воркер обслуживает пользователей в разных поясах, а вся модель оперирует локальной датой — значит «сегодня» обязано быть функцией от настроек пользователя, а не от часов сервера; try/catch нужен, потому что неизвестный tz в Intl бросает

**Основание:** `shared/src/time.ts:66-87; shared/src/types.ts:119,134; server/src/sync.ts:157-164; server/src/cron.ts:94-98` · достоверность: INFERRED

### Лимит длительности голосовой намеренно разный у клиента и сервера

**Что сделано.** shared: VOICE_MAX_MS = 600_000 (жёсткий стоп записи в браузере); сервер: LIMITS.voiceMs = 3_600_000 при валидации.

**Почему.** записано: «Above the recorder's 10-minute cap on purpose: bot audio files may be longer» — аудио, присланное в чат бота, не проходило через рекордер и не обязано укладываться в его лимит

**Основание:** `shared/src/types.ts:100-102; server/src/validate.ts:31-33; web/src/lib/recorder.ts:292,354` · достоверность: EXTRACTED

### shared подключается как TS-исходник без сборки

**Что сделано.** package.json shared указывает main/types/exports на ./src/index.ts, build — это tsc --noEmit; импорты внутри shared идут с расширением .ts (allowImportingTsExtensions, verbatimModuleSyntax). Воркспейсы npm: shared/server/web.

**Почему.** не задокументировано, вывод из кода: и Vite, и сборщик Wrangler жуют TS напрямую, поэтому промежуточный артефакт dist был бы лишним шагом и источником рассинхрона; ценой этого — обязательное расширение .ts в импортах и Node >= 22.6 с --experimental-strip-types для тестов

**Основание:** `shared/package.json:6-8,12-16; shared/tsconfig.json:6-9; package.json:4-5` · достоверность: INFERRED

### Пуш страницами по 200 при серверном лимите 500

**Что сделано.** Сервер отвергает больше 500 строк на таблицу в запросе; клиент берёт из outbox не более 200 записей на таблицу и возвращает pending для следующего прохода.

**Почему.** записано: «The server accepts at most 500 rows per table per request; keep well under it» — запас на рост и на то, что параллельная правка добавит строки между выборкой и отправкой

**Основание:** `server/src/validate.ts:21,217-222; web/src/lib/sync.ts:9-14,28-35` · достоверность: EXTRACTED

### sent_notifications — таблица claim'ов, а не журнал

**Что сделано.** Вставка ключа с onConflictDoNothing даёт ровно одному вызывающему true; при ошибке отправки claim удаляется, чтобы следующий тик повторил. 0001 добавил индекс по sent_at, строки старше 3 суток удаляются раз в UTC-сутки.

**Почему.** записано: «Atomic one-shot claim: exactly one caller gets true for a given key» и «on failure the claim is released so the next tick retries». Вывод из кода: индекс idx_sent_at (0001) существует ровно ради этого DELETE ... WHERE sent_at < cutoff, иначе он был бы full scan

**Основание:** `server/migrations/0000_init.sql:70-73; server/migrations/0001_sync_rev.sql:17; server/src/cron.ts:14,19-39,85-88` · достоверность: EXTRACTED

### Миграции применяются через wrangler d1 migrations

**Что сделано.** Три файла с числовыми префиксами в server/migrations, migrations_dir в wrangler.toml, скрипты db:migrate / db:migrate:local. 0001 использует голый ALTER TABLE ADD COLUMN без IF NOT EXISTS.

**Почему.** не задокументировано, вывод из кода: учёт применённых файлов ведёт сам wrangler, поэтому идемпотентность на уровне ALTER не нужна; CREATE TABLE/INDEX всё же написаны с IF NOT EXISTS — вероятно, ради ручного прогона 0000 на уже существующей базе

**Основание:** `server/wrangler.toml:17; server/package.json:12-13; server/migrations/0001_sync_rev.sql:2-5` · достоверность: INFERRED

## Сущности (16)

- **tasks** (table) — Задача или шаблон повторяющейся серии: дата, интервал в минутах, категория, приоритет, статус, JSON-чеклист и напоминания, JSON-правило repeat, carried_from для цепочки переносов, deleted_at для мягкого удаления. · `server/migrations/0000_init.sql:11-32`
- **occurrences** (table) — Override конкретного дня повторяющейся серии: id = taskId:date, перекрывает статус, время и чеклист, флаг deleted пропускает день. Создаётся только при реальной правке. · `server/migrations/0000_init.sql:34-47`
- **categories** (table) — Пользовательские категории с цветом и порядком; при создании юзера засеиваются четыре дефолтные с детерминированными id userId:cat:i. · `server/migrations/0000_init.sql:49-58`
- **day_notes** (table) — Текстовые заметки дня (morning/evening), одна строка на дату, PK = userId:date, удаления нет — только опустошение полей. · `server/migrations/0000_init.sql:60-68`
- **voice_notes** (table) — Метаданные голосовой заметки (mime, длительность, размер, peaks, источник app/bot), пятая синхронизируемая сущность; байты лежат в R2 по server-owned r2_key. · `server/migrations/0002_voice.sql:2-24`
- **users** (table) — Пользователь Telegram; все настройки (язык, шрифт, таймзона, часы дайджестов, carryover, напоминания) лежат одним JSON-блобом в settings, last_seen отсекает неактивных в кроне. · `server/migrations/0000_init.sql:1-9`
- **sent_notifications** (table) — Таблица атомарных claim'ов крона: ключ вида carry:uid:date / rem:uid:task:date:min:offset / digest:uid:date обеспечивает ровно одну отправку; строки старше трёх суток удаляются. · `server/migrations/0000_init.sql:70-73`
- **synced_at** (concept) — Серверная отметка приёма строки, единственное основание курсора пулла (since); отделена от клиентского updated_at, на котором работает разрешение конфликтов LWW. · `server/migrations/0001_sync_rev.sql:1-15`
- **shared/src/types.ts** (module) — Единственный контракт сервер↔клиент: доменные интерфейсы, SyncPayload/SyncRequest/SyncResponse, UserSettings с дефолтами, лимиты голосовых, дефолтные категории. · `shared/src/types.ts:1-168`
- **shared/src/time.ts** (module) — Календарная арифметика над ISO-строками и минутами: toISODate/addDays/startOfWeek/compareISO, форматирование HH:MM и длительностей, nowInTz для вычисления дня в таймзоне пользователя. · `shared/src/time.ts:1-87`
- **shared/src/recurrence.ts** (module) — Правила повторяемости и сборка дня: occursOn, occurrenceId, instancesForDate с наложением override, sortInstances и layoutColumns для раскладки пересекающихся блоков. · `shared/src/recurrence.ts:1-118`
- **shared/src/quickParse.ts** (module) — Парсер строки быстрого ввода: вытаскивает дату, время, диапазон, длительность, #категорию и !приоритет, возвращая очищенный заголовок; используется и мини-аппом, и ботом. · `shared/src/quickParse.ts:1-227`
- **RepeatRule** (concept) — JSON-правило повторения в колонке repeat: тип daily/weekdays/weekly/monthly/custom, массив дней недели 0..6 и включительная граница until. · `shared/src/types.ts:4-11`
- **upsertLWW** (module) — Обобщённый серверный upsert для всех пяти таблиц: чтение существующих updated_at чанками по 50, сравнение last-write-wins, проштамповка synced_at, опциональный хук принудительной записи. · `server/src/sync.ts:84-123`
- **validate.ts / LIMITS** (module) — Граница доверия к клиенту: размеры строк, 500 строк на таблицу, клампинг таймстемпов и минут, принудительное обнуление server-owned полей, подстановка userId. · `server/src/validate.ts:20-34,104-238`
- **carry-over** (ui-flow) — Ночной перенос незакрытых задач: копия с id root:carry:today и carried_from, оригинал в статус moved; конфликт с явным завершением разруливается хуком completionBeatsCarryOver. · `server/src/cron.ts:41-76`

## Открытые вопросы (7)

- Индексы (user_id, updated_at) из 0000 — idx_tasks_user_updated, idx_occ_user_updated, idx_cat_user_updated, idx_notes_user_updated — после миграции 0001 не обслуживают ни одного запроса: во всём server/src нет ни одного WHERE/ORDER BY по updated_at (грепом находятся только SET updated_at и SELECT-проекция в upsertLWW). Это четыре индекса, за которые платится на каждой записи. 0001 их не удалил.
- Пулл не ограничен по размеру: loadChangedSince при since=0 отдаёт всю историю пользователя во всех пяти таблицах одним ответом, включая все тумбстоуны. Пуш паджинирован (200/500), пулл — нет (server/src/sync.ts:125-140).
- Тумбстоуны никогда не удаляются из D1: удалённые tasks и categories, а также occurrences с deleted = 1 не чистит ни крон, ни что-либо ещё. Чистится только содержимое R2 (voice.ts:342), сама строка voice_notes тоже остаётся навсегда.
- tasks.id — клиентский uuid без скоупа по пользователю, а upsertLWW ищет существующую строку только в пределах user_id. При совпадении id у двух пользователей вторая строка молча теряется: prev === undefined → insert().onConflictDoNothing() конфликтует по глобальному PK и не пишет ничего, ошибки клиент не увидит (server/src/sync.ts:103-107). Для voice_notes id валидируется как uuid v4 (validate.ts:189-190), для tasks — нет.
- В server/src/bot.ts:461-465 объявлена своя addDaysISO на Date.UTC, хотя в shared есть addDays на локальном Date (shared/src/time.ts:12-16). Почему бот не использует общую функцию — из кода не следует; результаты для чистой ISO-арифметики совпадают, но дублирование живёт.
- Схема occurrences асимметрична остальным: есть updated_at, нет created_at и нет deleted_at (только булев deleted). Неясно, как отличить occurrence, созданный давно, от только что присланного, если это когда-нибудь понадобится для конфликтов.
- Текст миграции 0002_voice.sql дословно совпадает с блоком в docs/voice-notes-contract.md:41-63. Какой из файлов считается источником истины при следующем изменении схемы голосовых — не зафиксировано.

