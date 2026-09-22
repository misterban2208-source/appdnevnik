---
author: mine-project-context (7 агентов, чтение кода и коммитов)
captured_at: 2026-09-22
contributor: Дмитрий
---

# Клиент: React mini-app

_Область: Клиент Telegram mini-app: web/ (React + Vite + zustand + Dexie, голосовые заметки, жесты, офлайн)_

web/ — это одностраничное React-приложение без роутера: экран выбирается полем `view` в zustand-сторе, а модалки (редактор задачи, настройки) живут в `AnimatePresence` поверх. Архитектурно это local-first клиент: источник истины — IndexedDB через Dexie (`web/src/lib/db.ts`), zustand-стор держит прогретую в память проекцию тех же строк, а каждое изменение атомарно пишет и сущность, и запись в `outbox`. Синхронизация — один эндпоинт `/api/sync` по протоколу last-write-wins: push страницами по 200 строк на таблицу, pull по курсору `lastSync`, слияние по `updatedAt` (`web/src/lib/sync.ts`). Голосовые заметки сделаны отдельным контуром вне React: синглтон-рекордер на MediaRecorder, байты в `voiceBlobs`, собственная очередь загрузки в R2 с экспоненциальным бэкоффом, кеш-бюджет 60/40 МБ, один общий `<audio>`-плеер; синхронизируются только метаданные, а `uploadedAt` — серверное поле с монотонным слиянием. Жесты умышленно разделены: горизонтальные свайпы (удаление строк, перелистывание дня) сделаны на framer-motion `drag` с ручной фиксацией оси, а перетаскивание и ресайз блоков на таймлайне — на сырых Pointer Events, потому что там нужен long-press, снап по 5 минут и клампинг в видимый диапазон часов. Офлайн приложение полностью работоспособно в уже открытой сессии (создание, правка, удаление, запись и воспроизведение голоса), но service worker и manifest отсутствуют, поэтому «холодный» запуск без сети невозможен.

## Решения (48)

### Dexie — источник истины, zustand — проекция

**Что сделано.** Весь набор данных (tasks, occurrences, categories, notes, voiceNotes) читается из IndexedDB в `init()` целиком в Record<string, T> и дальше живёт в памяти; zustand подключён без persist-middleware, запись в Dexie делают сами экшены.

**Почему.** не задокументировано, вывод из кода: persist-middleware не дал бы транзакции «сущность + outbox» (store/index.ts:101-106) и не пережил бы слияние с сервером, поэтому стор сознательно оставлен «глупым» кешем, а долговечность вынесена в Dexie.

**Основание:** `web/src/store/index.ts:129-149, web/src/store/index.ts:180-200, web/src/lib/db.ts:34-64` · достоверность: INFERRED

### Запись сущности и outbox одной транзакцией

**Что сделано.** `persist(table, entity)` кладёт строку в свою таблицу и запись `{key: 'table:id'}` в `outbox` внутри одной `db.transaction('rw', ...)`.

**Почему.** не задокументировано, вывод из кода: иначе возможна строка, сохранённая локально, но никогда не отправленная на сервер (или наоборот). Тот же приём явно откомментирован для голосовых: «Metadata, bytes and the upload intent land together or not at all».

**Основание:** `web/src/store/index.ts:101-106, web/src/store/index.ts:552-558` · достоверность: EXTRACTED

### Outbox — множество ключей, а не журнал операций

**Что сделано.** Запись outbox — `{key: `${table}:${id}`, table, id, updatedAt}`; повторные правки одной сущности схлопываются в один ключ, отправляется текущее состояние строки целиком.

**Почему.** не задокументировано, вывод из кода: протокол синхронизации принимает целые строки и разрешает конфликты по updatedAt, поэтому история операций бессмысленна — достаточно намерения «эту строку надо отправить».

**Основание:** `web/src/lib/db.ts:4-9, web/src/lib/sync.ts:38-52` · достоверность: INFERRED

### Outbox чистится только для неизменённых строк

**Что сделано.** После успешного ответа сервера запись outbox удаляется лишь если её `updatedAt` совпал с отправленным значением.

**Почему.** Документировано комментарием: «Clear outbox entries that were sent and not modified meanwhile» — правка, сделанная пока запрос был в полёте, не должна потеряться.

**Основание:** `web/src/lib/sync.ts:56-62` · достоверность: EXTRACTED

### Push пагинирован по 200 строк на таблицу

**Что сделано.** PAGE = 200 при серверном лимите 500; остаток отражается счётчиком `pending`, при котором стор ставит статус 'pending' и планирует повторный sync через 1500 мс.

**Почему.** Документировано комментарием: «The server accepts at most 500 rows per table per request; keep well under it».

**Основание:** `web/src/lib/sync.ts:13-14, web/src/lib/sync.ts:27-36, web/src/store/index.ts:512-515` · достоверность: EXTRACTED

### Single-flight синхронизация на двух уровнях

**Что сделано.** `syncOnce` держит общий `inFlight`-промис, а стор дополнительно выходит из `sync()`, если статус уже 'syncing'.

**Почему.** Документировано комментарием «Safe to call concurrently» — синк дёргается из таймера раз в минуту, из visibilitychange, из online и из дебаунса после каждой правки, и все эти триггеры могут совпасть.

**Основание:** `web/src/lib/sync.ts:16-25, web/src/store/index.ts:469-472, web/src/App.tsx:26-51` · достоверность: EXTRACTED

### Дебаунс синка 1200 мс, для текстовых заметок 2500 мс

**Что сделано.** `scheduleSync(get, delay = 1200)` сбрасывает предыдущий таймер; `setNote` вызывает его с 2500 мс.

**Почему.** не задокументировано, вывод из кода: заметки правятся набором текста (сохранение идёт по onBlur в DayNotes.tsx:18-20), более длинный дебаунс уменьшает число запросов при последовательных правках утра/вечера.

**Основание:** `web/src/store/index.ts:93-99, web/src/store/index.ts:439-445, web/src/components/DayNotes.tsx:18-21` · достоверность: INFERRED

### Слияние pull делается дважды: в Dexie и в памяти

**Что сделано.** `doSync` мержит входящие строки в Dexie по `updatedAt`, а стор затем перечитывает таблицы целиком и мержит их в state своей функцией `mergeInto`, не перезаписывая более свежие записи в памяти.

**Почему.** Документировано комментарием: «Merge by updatedAt so a mutation made during the IndexedDB reads is never reverted» — между запросом и перечитыванием пользователь мог что-то изменить.

**Основание:** `web/src/store/index.ts:477-499, web/src/lib/sync.ts:65-103` · достоверность: EXTRACTED

### Настройки: флаг dirty и защита от гонки

**Что сделано.** Локальные настройки пушатся только при `dirty`; после ответа стор сравнивает `get().settings !== sentSettings` по ссылке и при расхождении оставляет локальную версию dirty, планируя новый push.

**Почему.** Документировано комментарием: «A settings change made while the request was in flight must stay dirty and be pushed next time».

**Основание:** `web/src/store/index.ts:473-487, web/src/store/index.ts:503-515, web/src/lib/sync.ts:51` · достоверность: EXTRACTED

### Часовой пояс пушится только поверх подтянутых настроек

**Что сделано.** Если браузерная TZ отличается от серверной и настройки не менялись во время запроса, `updateSettings({tz})` вызывается отложенно через setTimeout(0).

**Почему.** Документировано комментарием и коммитом b23c6da: «timezone is pushed only on top of a pulled settings object» — устройство определяет TZ для напоминаний, но не должно затирать серверные настройки собственным дефолтом.

**Основание:** `web/src/store/index.ts:500-502, коммит b23c6da` · достоверность: EXTRACTED

### Свежая установка без сети сеет категории «древними» метками

**Что сделано.** Если сеть недоступна, категорий нет и lastSync = 0, локально создаются DEFAULT_CATEGORIES с серверными id (`${uid}:cat:${i}`) и updatedAt = 1+i.

**Почему.** Документировано комментарием: id совпадают с серверными, а древний updatedAt гарантирует, что при первом успешном pull пользовательские категории с сервера выиграют LWW и дублей не возникнет.

**Основание:** `web/src/store/index.ts:205-214, коммит b23c6da` · достоверность: EXTRACTED

### Перенос незавершённых задач (carryover) — целиком на клиенте

**Что сделано.** `runCarryover` ищет неповторяющиеся задачи прошлых дат со статусом todo/in_progress, создаёт копию с детерминированным id `${carryRootId(t.id)}:carry:${today}` и помечает оригинал статусом 'moved' с `updatedAt + 1`.

**Почему.** Документировано двумя комментариями: детерминированный id нужен чтобы «client and server converge» (одинаковые копии на разных устройствах не размножались), а инкремент ровно на 1 мс — чтобы «any real user edit still wins last-write-wins», то есть ручное завершение задачи не проигрывало автопереносу.

**Основание:** `web/src/store/index.ts:13-16, web/src/store/index.ts:447-467` · достоверность: EXTRACTED

### Триггеры синхронизации: видимость, online, минутный тик

**Что сделано.** App монтирует visibilitychange (carryover + sync), online (sync + pumpVoiceUploads) и setInterval 60 000 мс, который заодно ловит переход через полночь сравнением `new Date().toDateString()` с сохранённым today.

**Почему.** Документировано комментарием про полночь: «Crossing midnight while the app stays open: carry over and move today». Остальные триггеры не откомментированы; вывод из кода: mini-app чаще всего сворачивают, а не закрывают, поэтому возврат к видимости — основной момент догона.

**Основание:** `web/src/App.tsx:26-51` · достоверность: EXTRACTED

### Ошибки сети молчаливы, вслух говорит только 401

**Что сделано.** В catch синка ApiError 401 переводит статус в 'expired' и один раз показывает тост sessionExpired; любая другая ошибка просто ставит syncStatus = 'error', который виден только в Settings (точка + подпись).

**Почему.** не задокументировано, вывод из кода: приложение local-first, отсутствие сети — нормальный режим, а не сбой, поэтому шум подавляется; протухший initData Telegram чинится только перезапуском мини-аппа, и об этом сказать надо (текст ключа: «закройте и откройте приложение заново»).

**Основание:** `web/src/store/index.ts:520-527, web/src/views/Settings.tsx:65-66, web/src/views/Settings.tsx:218-221, web/src/i18n/index.ts:116` · достоверность: INFERRED

### Голосовые: метаданные синхронизируются, байты — нет

**Что сделано.** Dexie v2 добавляет три таблицы: `voiceNotes` (синхронизируемые метаданные, пятая сущность LWW-протокола), `voiceBlobs` (ArrayBuffer + touchedAt для вытеснения) и `voiceQueue` (очередь заливки в R2).

**Почему.** Документировано в комментарии схемы и в docs/voice-notes-contract.md:4-7: решение принято как «local-first» — байты играют мгновенно и офлайн, копия в R2 нужна только чтобы другое устройство могло их достать.

**Основание:** `web/src/lib/db.ts:55-60, web/src/lib/db.ts:16-32, docs/voice-notes-contract.md:4-7` · достоверность: EXTRACTED

### uploadedAt сливается монотонно, отдельно от LWW

**Что сделано.** Для голосовых обычное правило `updatedAt` побеждает выбором базовой записи, но `uploadedAt` берётся как `incoming.uploadedAt ?? base.uploadedAt ?? null` и не теряется.

**Почему.** Документировано комментарием: поле серверное «and only ever gains a value», поэтому клиентский tombstone не должен обнулить факт загрузки, и наоборот.

**Основание:** `web/src/lib/sync.ts:78-95, web/src/store/index.ts:112-122, docs/voice-notes-contract.md:79-83` · достоверность: EXTRACTED

### Очередь заливки: последовательная, с бэкоффом и «вечными» ошибками

**Что сделано.** `pumpVoiceUploads` — single-flight с одним отложенным повтором, берёт строки с `nextAt <= now`, грузит по одной. 404 → повтор через 5 с (до 6 попыток), 410/413/415 → permanent (без автоповторов, красная точка и ручной retry), 429 → Retry-After, остальное → min(30с·2^attempts, 30 мин) с джиттером ±20 %.

**Почему.** не задокументировано в коде целиком, но соответствует контракту (docs/voice-notes-contract.md:184-189). Вывод из кода: 404 — это гонка с дебаунсированным /api/sync (строка ещё не доехала), поэтому короткий повтор; 410/413/415 — окончательный отказ сервера, повторы бессмысленны.

**Основание:** `web/src/lib/voice.ts:174-228, web/src/lib/voice.ts:258-286, docs/voice-notes-contract.md:184-189` · достоверность: EXTRACTED

### Оффлайн распознаётся по navigator.onLine и по status 0

**Что сделано.** `uploadOne` возвращает «стоп» при `navigator.onLine === false` и при ApiError со статусом 0 (XHR onerror/onabort/ontimeout), не увеличивая attempts и не трогая nextAt; закачка возобновится по триггеру online/visible/sync.

**Почему.** Документировано комментарием: «Offline: leave the row untouched and wait for the next trigger» — иначе серия неудач офлайн раздула бы бэкофф до получаса и заливка не пошла бы сразу после возврата сети.

**Основание:** `web/src/lib/voice.ts:245, web/src/lib/voice.ts:258-265, web/src/lib/api.ts:85-87` · достоверность: EXTRACTED

### XHR вместо fetch для загрузки байтов

**Что сделано.** `uploadVoice` — XMLHttpRequest PUT с метаданными в query и `upload.onprogress`, отдающим ratio в UI-полоску прогресса пилюли.

**Почему.** Документировано комментарием: «XHR instead of fetch because only XHR reports upload progress».

**Основание:** `web/src/lib/api.ts:52-90, web/src/components/VoiceSection.tsx:283-285` · достоверность: EXTRACTED

### reconcileVoice — единая точка пересчёта состояния голосовых

**Что сделано.** После init и после каждого синка проходом по метаданным восстанавливаются: флаги hasBlob/error, недостающие строки очереди, удаление осиротевших записей, стирание байтов удалённых заметок старше 60 с и вытеснение кеша с 60 МБ до 40 МБ по touchedAt (текущая играющая заметка не вытесняется).

**Почему.** Документировано комментариями: «Bring queue, blobs and per-note UI flags in line with the metadata» и «sizes come from the metadata so the blobs themselves never have to be read» — размеры берутся из метаданных, чтобы не читать многомегабайтные ArrayBuffer ради подсчёта бюджета.

**Основание:** `web/src/lib/voice.ts:290-356, web/src/store/index.ts:201-203, web/src/store/index.ts:516-519` · достоверность: EXTRACTED

### 404 при скачивании — локальный self-heal без outbox

**Что сделано.** Если сервер отвечает 404 на GET байтов, клиент ставит `uploadedAt = null` в Dexie и в сторе, но outbox-запись не создаёт.

**Почему.** Документировано комментарием: «The server lost the bytes (purge / self-heal): reflect it locally, no outbox entry» — поле серверное, пушить его обратно нельзя, иначе клиент начал бы диктовать серверу состояние хранилища.

**Основание:** `web/src/lib/voice.ts:130-140` · достоверность: EXTRACTED

### Прогрев кеша ограничен 3 файлами и 10 МБ

**Что сделано.** `prefetchVoice` скачивает максимум 3 незакешированных заметки суммарно до 10 МБ, начиная с самых новых, и только для текущей и сегодняшней даты; вызывается из sync().

**Почему.** Документировано комментарием: «Warm the cache for the days on screen so remote notes play without a tap-and-wait». Лимиты не объяснены; вывод из кода: мини-апп открывают на мобильном трафике, безлимитный прогрев съел бы и трафик, и квоту IndexedDB.

**Основание:** `web/src/lib/voice.ts:148-170, web/src/store/index.ts:519` · достоверность: EXTRACTED

### LRU из 30 object URL, плеер вне React

**Что сделано.** `urlFor` держит Map не более 30 blob-URL с пере-вставкой при попадании и не вытесняет URL текущей заметки; плеер — один `<audio>` c собственным subscribe/getState и подпиской через useSyncExternalStore.

**Почему.** Документировано комментариями («Re-insert so the most recently used entry sits last», «Voice notes outside React ... IndexedDB stays the source of truth»); вывод из кода: неотозванные object URL держат байты в памяти, а один элемент audio гарантирует «одна заметка за раз».

**Основание:** `web/src/lib/voice.ts:74-104, web/src/lib/voice.ts:360-480, web/src/components/VoiceSection.tsx:21-24` · достоверность: EXTRACTED

### Прогресс и перемотка считаются по сохранённой длительности

**Что сделано.** `player.seek` переводит ratio в секунды через `durationMs` из метаданных, а не через `audio.duration`, и глотает исключение при попытке выставить currentTime.

**Почему.** Документировано комментарием: «fMP4/WebM from MediaRecorder may not be seekable before it is fully buffered»; в контракте добавлено, что `audio.duration` для таких контейнеров равен Infinity.

**Основание:** `web/src/lib/voice.ts:464-473, docs/voice-notes-contract.md:194-195` · достоверность: EXTRACTED

### Рекордер — синглтон вне React, старт строго из тапа

**Что сделано.** Весь MediaRecorder-контур (состояние, метр, таймер, peaks) живёт в модуле; `start()` вызывает getUserMedia синхронно из обработчика нажатия, а результат дубля доставляется в стор через `setRecorderHandlers`.

**Почему.** Документировано комментариями: «One MediaRecorder for the whole app, driven outside React so a take survives view changes» и «Must be called straight from the tap handler ... so WebViews still count it as a user gesture».

**Основание:** `web/src/lib/recorder.ts:6-10, web/src/lib/recorder.ts:212-250, web/src/components/VoiceSection.tsx:68-79, web/src/store/index.ts:157-169` · достоверность: EXTRACTED

### Выбор контейнера: сначала AAC/MP4, потом Opus, плюс защита от битого энкодера

**Что сделано.** `pickMimeType` пробует `audio/mp4;codecs=mp4a.40.2`, затем `audio/mp4` только на ios/macos, затем webm/opus; если дубль длиннее 1 с весит меньше 1 КБ и mime содержит mp4, в localStorage пишется принудительный `audio/webm;codecs=opus`, а дубль отбраковывается как 'encoder'.

**Почему.** Документировано комментарием: «Some WebViews advertise AAC and then produce empty fragments; switch to Opus for the next take». Приоритет MP4 объяснён в plaйбек-части: Safari не умеет WebM/Opus (canPlayMime).

**Основание:** `web/src/lib/recorder.ts:111-129, web/src/lib/recorder.ts:349-366, web/src/lib/voice.ts:411-426` · достоверность: EXTRACTED

### Watchdog на остановку записи

**Что сделано.** `drain()` ждёт onstop, но через 3 с финализирует дубль из уже полученных чанков (`recorder.start(1000)` даёт чанк раз в секунду).

**Почему.** Документировано комментарием: «a WebView that never fires onstop is finalised from the chunks seen so far».

**Основание:** `web/src/lib/recorder.ts:317-336, web/src/lib/recorder.ts:271` · достоверность: EXTRACTED

### Сворачивание приложения сохраняет запись, а не отменяет её

**Что сделано.** На visibilitychange→hidden и pagehide активная запись завершается с reason='hidden' (дубль сохраняется), а в idle просто освобождается стрим; на время записи включается tg.enableClosingConfirmation().

**Почему.** Документировано комментарием: «A take must not be lost when Telegram minimises the app: save it, and let the parked stream go».

**Основание:** `web/src/lib/recorder.ts:409-420, web/src/lib/recorder.ts:276, web/src/lib/recorder.ts:348` · достоверность: EXTRACTED

### На Android микрофонный стрим держится 90 с между дублями

**Что сделано.** `parkStream()` на ios/macos/desktop останавливает треки сразу, на android/android_x откладывает освобождение на 90 с.

**Почему.** Документировано комментарием: «Android's Telegram shows the mic dialog per getUserMedia call; keep the stream warm between takes».

**Основание:** `web/src/lib/recorder.ts:154-163, web/src/lib/recorder.ts:101-109` · достоверность: EXTRACTED

### Метр уровня не подключён к destination; peaks в 48 base36-символов

**Что сделано.** AnalyserNode (fftSize 512) считает RMS каждые 50 мс, растягивая его в ×3.5 для видимости; на финале выборки сжимаются в 48 бакетов максимума, нормированных на дубль, по одному символу 0-9a-z.

**Почему.** Документировано комментариями: «Never connected to the destination: the meter must not echo the mic to the speaker» и «Speech RMS sits around 0.05–0.3; stretch it so the meter moves visibly». Формат peaks — компактная строка, которая едет в метаданных синка и рисует волну без чтения байтов.

**Основание:** `web/src/lib/recorder.ts:173-208, web/src/lib/recorder.ts:300-315, web/src/components/VoiceSection.tsx:154-161` · достоверность: EXTRACTED

### Переполнение квоты IndexedDB не теряет запись

**Что сделано.** Если транзакция с байтами падает с QuotaExceededError, метаданные и строка очереди пишутся отдельной транзакцией, а байты кладутся в память процесса (`memBlobs`) — дубль всё ещё можно проиграть и залить; пользователю показывается тост storageFull.

**Почему.** Документировано комментарием: «No room for the bytes on disk: keep them for this session so the take can still upload and play».

**Основание:** `web/src/store/index.ts:530-590, web/src/lib/voice.ts:53-58` · достоверность: EXTRACTED

### Свайп-удаление: залоченная ось хранится до конца жеста

**Что сделано.** В TaskRow и VoicePill удаление срабатывает только если `axis.current === 'x'`, |offset.x| > 90 и |offset.x| > |offset.y|; флаг `dragged` глушит следующий click ещё 250 мс. Ось сбрасывается в onDragEnd, а не в onDragStart.

**Почему.** Документировано комментарием и коммитом 5dbf8d4: framer-motion откладывает onDragStart на следующий кадр, поэтому сброс оси там затирал значение, только что выставленное onDirectionLock, и свайпы не срабатывали вовсе.

**Основание:** `web/src/components/TaskRow.tsx:60-76, web/src/components/VoiceSection.tsx:230-243, коммит 5dbf8d4` · достоверность: EXTRACTED

### Перелистывание дня — drag на самом скролл-контейнере

**Что сделано.** `.day-scroll` одновременно вертикальный скролл и framer `drag='x'` с dragDirectionLock и нулевыми констрейнтами; drag отключается, когда блок выбран (`drag={selectedBlockId ? false : 'x'}`), порог 70 px.

**Почему.** не задокументировано, вывод из кода: отдельного слоя-свайпера нет, поэтому единственный способ совместить вертикальный скролл расписания с листанием дней — lock оси на том же элементе; выключение drag при выбранном блоке нужно, чтобы перетаскивание блока не листало день.

**Основание:** `web/src/views/DayView.tsx:159-197, web/src/styles/global.css:251-258` · достоверность: INFERRED

### Перетаскивание блоков — сырые Pointer Events, не framer drag

**Что сделано.** TaskBlock сам обрабатывает pointerdown/move/up: long-press 380 мс выделяет блок (с порогом дрожания 8 px), выделенный блок таскается и ресайзится, дельта снапится по 5 минут, минимальная длительность 10 минут, движение клампится в `dragBounds`; тап по невыделенному открывает редактор.

**Почему.** Документировано комментариями: «Snap the delta only: a block at 09:07 keeps its minutes unless it is actually dragged», «Real movement before the long press fires means the user is scrolling», «Long press selects the block; a normal tap opens it». Вывод из кода: framer drag не дал бы такой связки long-press → выделение → drag поверх вертикального скролла.

**Основание:** `web/src/components/TaskBlock.tsx:26-31, web/src/components/TaskBlock.tsx:52-116, web/src/views/DayView.tsx:78-79` · достоверность: EXTRACTED

### Таймлайн со сворачиваемыми диапазонами и нелинейной шкалой

**Что сделано.** Сутки режутся на 3 сегмента (до visibleStart, видимый, после visibleEnd); невидимые сегменты схлопываются в полоску 40 px, `minToPx` проходит по сегментам и внутри свёрнутого масштабирует линейно; клик по свёрнутой полосе раскрывает её, а не создаёт задачу; перетаскивание клампится так, чтобы блок не уехал в свёрнутую зону. Сегмент раскрывается автоматически, если в нём есть задача или сейчас там now-линия.

**Почему.** не задокументировано, вывод из кода: полные 24 часа по 64 px — это 1536 px скролла ради пустой ночи; сворачивание сохраняет обзор дня, а автораскрытие при наличии задач не даёт спрятать данные.

**Основание:** `web/src/views/DayView.tsx:15-19, web/src/views/DayView.tsx:44-79, web/src/views/DayView.tsx:105-137` · достоверность: INFERRED

### Единая анимационная грамматика: EASE + reveal-стаггер

**Что сделано.** Кривая `[0.22, 1, 0.36, 1]` и шаг стаггера 0.045 с вынесены в Reveal.tsx и переиспользуются всеми экранами; элементы въезжают сверху (y: -14 → 0), модалки — через `modalMotion` (spring 320/34), удаление строки — коллапс высоты; в TaskEditor поля анимируются variants со staggerChildren.

**Почему.** не задокументировано, вывод из кода: один экспортируемый EASE/reveal вместо локальных transition в каждом компоненте — способ не расползтись по таймингам; смысловой рисунок «сверху вниз» повторяет порядок чтения экрана.

**Основание:** `web/src/components/Reveal.tsx:4-37, web/src/views/TaskEditor.tsx:181, web/src/views/TaskEditor.tsx:417-420, web/src/App.tsx:55-65` · достоверность: INFERRED

### @twa-dev/sdk: каждый вызов в try/catch и за проверкой версии

**Что сделано.** `initTelegram` оборачивает каждый вызов в `safe()`, проверяет `isVersionAtLeast` для setHeaderColor (6.9), setBottomBarColor (7.10), disableVerticalSwipes (7.7), haptics (6.1), closingConfirmation (6.2), requestWriteAccess (6.9); BackButton показывается только внутри Telegram.

**Почему.** Документировано комментарием: «Every call is guarded on its own: one unsupported method must not cancel the rest» — старые клиенты Telegram бросают на неизвестных методах, и один throw убил бы всю инициализацию.

**Основание:** `web/src/lib/telegram.ts:19-50, web/src/lib/telegram.ts:69-144` · достоверность: EXTRACTED

### Высота приложения берётся из viewportStableHeight

**Что сделано.** CSS-переменная `--app-height` выставляется из `tg.viewportStableHeight` и обновляется по событию viewportChanged; `#root` использует её с fallback 100% и переходом 200 мс.

**Почему.** Документировано комментарием: «Keep the layout inside the visible part of the WebView (collapsed sheet on iOS)» — на iOS мини-апп открывается свёрнутым листом, и 100vh уезжает за экран.

**Основание:** `web/src/lib/telegram.ts:43-49, web/src/styles/global.css:62-69` · достоверность: EXTRACTED

### Тема жёстко тёмная, тема Telegram игнорируется

**Что сделано.** `data-theme="dark"` прибит в index.html, палитра задана в :root, Telegram'у передаётся фиксированный цвет фона #0b0b0d; themeParams клиента не читаются нигде.

**Почему.** не задокументировано, вывод из кода: приложение строит собственную «премиальную» тёмную палитру (золото/графит, рукописный акцидентный шрифт), подстройка под светлую тему Telegram сломала бы её; шрифты грузятся неблокирующе через media="print"+onload.

**Основание:** `web/index.html:2-17, web/src/styles/global.css:1-47` · достоверность: INFERRED

### Редактор повторяющейся задачи: occurrence vs series с авто-detach

**Что сделано.** Переключатель scope выбирает, редактируется экземпляр или шаблон. В scope='occurrence' изменения времени/статуса/чеклиста пишутся в Occurrence-override, а правка title/description/category/priority/date/reminders форсирует detach: создаётся отдельная задача без repeat, а день серии скрывается tombstone-овcurrence.

**Почему.** Документировано комментариями: «Only fields an occurrence override can hold changed -> keep the instance in the series» и «Series scope edits the template itself: never seed it from a day's occurrence overrides» — набор полей override ограничен схемой Occurrence, всё остальное физически некуда положить.

**Основание:** `web/src/views/TaskEditor.tsx:44-51, web/src/views/TaskEditor.tsx:110-133, web/src/store/index.ts:329-350` · достоверность: EXTRACTED

### Каждое разрушительное действие даёт undo-тост, а не диалог

**Что сделано.** Удаление задачи, экземпляра серии и голосовой заметки — это tombstone (`deletedAt`) плюс тост с кнопкой «Вернуть»; тост живёт 3 с с прогресс-полоской. Диалог подтверждения оставлен только для удаления всей серии (двойное нажатие).

**Почему.** не задокументировано, вывод из кода: свайп-удаление слишком легко нажать случайно, а модальное подтверждение на каждый свайп убило бы скорость; серия — единственное действие, задевающее много дней, поэтому там подтверждение оставлено.

**Основание:** `web/src/store/index.ts:288-327, web/src/store/index.ts:592-602, web/src/components/Toast.tsx:6-47, web/src/views/TaskEditor.tsx:394-411` · достоверность: INFERRED

### Непроигрываемый формат превращается в отправку в чат

**Что сделано.** `canPlayMime` кеширует результат canPlayType (с повторной пробой без codecs); если формат не поддержан, главная кнопка пилюли становится «отправить» и вызывает POST /api/voice/:id/send, один раз показав пояснительный тост.

**Почему.** Документировано комментариями: «Safari has no WebM/Opus, Chrome no fMP4 AAC on some Androids» и «A generic container is what the server stores for bot notes». Вывод из кода: вместо тупика «не играет» пользователю дают рабочий обходной путь — Telegram-чат сам проиграет файл.

**Основание:** `web/src/lib/voice.ts:411-426, web/src/lib/voice.ts:486-501, web/src/components/VoiceSection.tsx:163-189` · достоверность: EXTRACTED

### Состояние пилюли вычисляется как функция, а не хранится

**Что сделано.** `voiceState(note, local)` выводит одно из семи состояний (local / uploading / synced / remote / downloading / pending_elsewhere / error) из метаданных и device-only флагов `voiceLocal`, которые рекордер и очередь шлют в стор через VoiceSink.

**Почему.** не задокументировано, вывод из кода: часть фактов синхронизируема (uploadedAt), часть строго локальна (есть ли байты, идёт ли заливка), и хранить производное состояние в одной синхронизируемой строке нельзя — на другом устройстве оно было бы ложью (состояние pending_elsewhere ровно об этом).

**Основание:** `web/src/lib/voice.ts:11-44, web/src/store/index.ts:56-58, web/src/store/index.ts:152-156` · достоверность: INFERRED

### Перемотка голосового — только по клику, не по pointerdown

**Что сделано.** Обработчик seek висит на onClick волны и выходит, если только что был drag; pointerdown на кнопках внутри пилюли останавливается, чтобы не мешать свайпу.

**Почему.** Документировано комментарием: «Seek on tap only: pointer-down must stay free for the horizontal swipe-to-delete gesture» (и коммитом 5dbf8d4).

**Основание:** `web/src/components/VoiceSection.tsx:191-199, web/src/components/VoiceSection.tsx:245, коммит 5dbf8d4` · достоверность: EXTRACTED

### Быстрый ввод разбирает строку и показывает результат чипами

**Что сделано.** QuickAdd прогоняет текст через shared `quickParse` и показывает разобранные дату/время/длительность/категорию/приоритет чипами до отправки; длительность без времени начала получает ближайшие свободные полчаса (сегодня) или 09:00.

**Почему.** Документировано комментариями: даты-слова абсолютны и считаются от настоящего today, а задача без даты попадает на просматриваемый день; длительность без старта дефолтится, «so it is not silently dropped».

**Основание:** `web/src/components/QuickAdd.tsx:28-37, web/src/components/QuickAdd.tsx:91-112` · достоверность: EXTRACTED

### Нет service worker и manifest

**Что сделано.** В web/ нет ни регистрации serviceWorker, ни манифеста, ни Cache API; офлайн обеспечивается исключительно IndexedDB уже загруженной страницы.

**Почему.** не задокументировано, вывод из кода: мини-апп всегда открывается из Telegram WebView по URL воркера, поэтому «холодный» офлайн-старт считается неподдерживаемым сценарием; при этом README обещает «офлайн-режим», что относится к данным, а не к оболочке.

**Основание:** `web/src/ (поиск serviceWorker/manifest/caches — совпадений нет), README.md:5, README.md:15` · достоверность: INFERRED

### i18n — плоский словарь с функциями, без библиотеки

**Что сделано.** Два объекта ru/en, тип Dict выводится из ru, `getDict(lang)` возвращает словарь, плюрализация и падежи решаются функциями-значениями (minBefore, hiddenHours, carriedFrom) и отдельными массивами monthsGen для русского родительного падежа.

**Почему.** не задокументировано, вывод из кода: два языка и фиксированный набор строк не окупают вес i18n-библиотеки; вывод типа из ru-словаря делает пропуск ключа в en ошибкой компиляции.

**Основание:** `web/src/i18n/index.ts:3-4, web/src/i18n/index.ts:290-318` · достоверность: INFERRED

### TaskEditor держит последний editor в ref ради exit-анимации

**Что сделано.** Пока AnimatePresence проигрывает выход, значение `editor` в сторе уже null, поэтому компонент читает последнее непустое значение из useRef.

**Почему.** Документировано комментарием: «AnimatePresence keeps this mounted during the exit animation, when the store value is already null».

**Основание:** `web/src/views/TaskEditor.tsx:18-22` · достоверность: EXTRACTED

## Сущности (20)

- **PlannerDB (Dexie)** (module) — Схема IndexedDB: tasks, occurrences, categories, notes (v1) и voiceNotes, voiceBlobs, voiceQueue (v2), плюс outbox и meta; источник истины клиента. · `web/src/lib/db.ts`
- **outbox** (table) — Множество ключей `${table}:${id}` с updatedAt — намерение отправить строку на сервер; пишется в одной транзакции с сущностью. · `web/src/lib/db.ts`
- **useStore (zustand)** (module) — Единственный стор приложения: состояние экранов, данные в виде Record, все мутирующие экшены, carryover, sync и действия над голосовыми. · `web/src/store/index.ts`
- **syncOnce / doSync** (module) — Один цикл синхронизации: страница outbox → POST /api/sync → очистка outbox → LWW-слияние в Dexie → курсор lastSync. · `web/src/lib/sync.ts`
- **api** (module) — HTTP-слой: auth-заголовок `tma <initData>`, ApiError с кодом и Retry-After, sync/exportNotes/health, XHR-загрузка и fetch-скачивание байтов голосовых. · `web/src/lib/api.ts`
- **voice.ts (кеш, очередь, плеер)** (module) — Весь не-React контур голосовых: байтовый кеш и LRU object URL, очередь заливки с бэкоффом, скачивание и prefetch, reconcile с бюджетом кеша, плеер и отправка в чат. · `web/src/lib/voice.ts`
- **recorder.ts** (module) — Синглтон MediaRecorder: конечный автомат idle→requesting→recording→finishing, метр уровня, peaks, лимиты длительности, watchdog, сохранение дубля при сворачивании. · `web/src/lib/recorder.ts`
- **telegram.ts** (module) — Обёртка @twa-dev/sdk: защищённая инициализация, версия клиента, haptics, BackButton, closing confirmation, requestWriteAccess, --app-height. · `web/src/lib/telegram.ts`
- **VoiceSection / VoicePill / RecorderRow** (ui-flow) — UI голосовых заметок под текстовыми заметками дня: список пилюль с волной и прогрессом, свайп-удаление, строка записи с метром и таймером. · `web/src/components/VoiceSection.tsx`
- **DayView** (ui-flow) — Главный экран: сворачиваемый таймлайн с нелинейной шкалой, секция задач без времени, now-линия, свайп между днями, заметки дня. · `web/src/views/DayView.tsx`
- **TaskBlock** (module) — Блок задачи на таймлайне: long-press-выделение, перетаскивание и ресайз на Pointer Events со снапом 5 мин и клампом в видимые часы. · `web/src/components/TaskBlock.tsx`
- **TaskRow** (module) — Строка задачи в списках: свайп-удаление влево с фиксацией оси, цикл статусов по чекбоксу, метаданные (категория, время, повтор, чеклист, перенос). · `web/src/components/TaskRow.tsx`
- **TaskEditor** (ui-flow) — Полноэкранный редактор задачи: scope occurrence/series для повторов, время, категория, приоритет, чеклист, напоминания, правила повтора, удаление. · `web/src/views/TaskEditor.tsx`
- **Settings** (ui-flow) — Настройки: шрифт и язык, перенос задач, haptics, видимые часы, дайджесты и напоминания, редактор категорий, экспорт заметок и ручной sync со статусом. · `web/src/views/Settings.tsx`
- **QuickAdd** (ui-flow) — Нижний лист быстрого ввода: разбор строки через shared quickParse с предпросмотром разобранных полей чипами. · `web/src/components/QuickAdd.tsx`
- **Reveal / EASE / modalMotion** (module) — Общая анимационная грамматика: кривая, стаггер входа сверху вниз, пружина для модалок. · `web/src/components/Reveal.tsx`
- **hooks (useInstances, useInstancesRange, useClock)** (module) — Мемоизированное разворачивание задач и повторов в экземпляры на дату/диапазон и тикающие каждые 30 с текущие минуты. · `web/src/lib/hooks.ts`
- **i18n dict** (module) — Двухязычный словарь ru/en с функциями для падежей и склонений, форматирование дат и диапазонов. · `web/src/i18n/index.ts`
- **VoiceSink** (protocol) — Интерфейс обратной связи из не-React контура голосовых в стор: setLocal(id, patch) и noteUpdated(note). · `web/src/lib/voice.ts`
- **voiceState** (concept) — Функция, выводящая одно из семи состояний пилюли из синхронизируемых метаданных и device-only флагов. · `web/src/lib/voice.ts`

## Открытые вопросы (8)

- WeekView и MonthView перелистывают период по одному лишь `info.offset.x > 70`, без проверки залоченной оси и без сравнения с offset.y — то есть без той защиты, которую коммит 5dbf8d4 добавил в DayView и TaskRow. Вертикальный drag (особенно мышью на desktop-клиенте) может пролистнуть неделю или месяц. Evidence: web/src/views/WeekView.tsx:54-61, web/src/views/MonthView.tsx:69-76 против web/src/views/DayView.tsx:177-187.
- Правило слияния голосовых различается в двух местах: `mergeVoiceInto` в сторе берёт входящую строку при `r.updatedAt >= c.updatedAt`, а `mergeVoice` в sync.ts — только при строгом `>`. При равных updatedAt память и Dexie могут разойтись. Evidence: web/src/store/index.ts:117 против web/src/lib/sync.ts:88.
- `voiceLocal` пополняется по id и никогда не чистится — ни при удалении заметки, ни при вытеснении байтов из кеша запись из Record не удаляется. За долгую сессию это растущая (хоть и маленькая) утечка. Evidence: web/src/store/index.ts:154, web/src/lib/voice.ts:353.
- `prefetchVoice` вызывается только внутри `sync()` для currentDate и today. Переход на произвольную дату (свайп, календарь) прогрев не запускает, поэтому чужие заметки там играют только после тапа-и-ожидания. Неясно, осознанный ли это компромисс или пропуск. Evidence: web/src/store/index.ts:519, web/src/lib/voice.ts:152.
- Нет ни одного теста для web: корневой `npm test` запускает только shared и server, в web/package.json тестового скрипта нет. Гонки рекордера, очереди заливки и LWW-слияния в сторе проверяются только вручную (docs/voice-notes-contract.md:234-239). Evidence: package.json:15, web/package.json:9-14.
- Индикатор состояния синхронизации существует только внутри модалки Settings; на основных экранах нет ни признака офлайна, ни признака непройденного push. Пользователь узнаёт о проблеме, только если откроет настройки (или получит тост об истёкшей сессии). Evidence: web/src/views/Settings.tsx:65-66, web/src/views/Settings.tsx:218-221.
- `useBackButton` названа как React-хук, но это обычная функция, возвращающая cleanup; она вызывается как `useEffect(() => useBackButton(close), [])`. Работает, но нарушает соглашение об именовании и обходит правила линтера хуков. Evidence: web/src/lib/telegram.ts:128, web/src/views/TaskEditor.tsx:82, web/src/views/Settings.tsx:41.
- README обещает «офлайн-режим», но офлайн-способность ограничена уже открытой вкладкой: service worker, manifest и Cache API отсутствуют, поэтому первый запуск без сети невозможен. Расхождение между обещанием и реализацией нигде не оговорено. Evidence: README.md:5, отсутствие serviceWorker/manifest в web/.

