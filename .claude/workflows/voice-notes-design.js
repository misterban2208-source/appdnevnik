export const meta = {
  name: 'voice-notes-design',
  description: 'Design panel + platform research + judges for voice notes in morning/evening day notes',
  phases: [
    { title: 'Research', detail: 'platform constraints: Telegram WebView audio, Bot API files, Cloudflare' },
    { title: 'Design', detail: 'three independent architectures' },
    { title: 'Judge', detail: 'three judges score every design' },
    { title: 'Synthesize', detail: 'one implementation contract' },
  ],
}

const ROOT = 'C:\\Users\\Дмитрий\\Desktop\\Мини ап-дневник'
const CONTEXT = `Project root: ${ROOT}. Telegram Mini App day planner, Russian-first UI, premium dark design (graphite + gold).
Stack already in place (read the files, do not modify anything):
- server/: Cloudflare Worker (Hono 4, TypeScript), D1 (SQLite) via Drizzle, grammY bot with webhook at /bot/:secret, per-minute cron. Auth: 'Authorization: tma <initData>' validated in server/src/auth.ts; user id = Telegram id. Static frontend served from the same Worker via [assets] in server/wrangler.toml. Secrets: BOT_TOKEN, WEBHOOK_SECRET. Free tier only (Workers, D1; R2 free tier 10 GB is acceptable if justified).
- web/: React 18 + Vite, zustand store (web/src/store/index.ts), Dexie IndexedDB local-first with an outbox and a /api/sync endpoint doing last-write-wins per entity (web/src/lib/sync.ts, server/src/sync.ts). Day notes are DayNote {id=date, morning: string, evening: string, updatedAt} rendered by web/src/components/DayNotes.tsx inside views/DayView.tsx. Telegram SDK wrapper: web/src/lib/telegram.ts (@twa-dev/sdk). Haptics helper exists. Offline mode must keep working.
- shared/: types in shared/src/types.ts, SyncPayload/SyncRequest/SyncResponse define what syncs.
Feature request (from the owner, in Russian): "добавь возможность записывать голосовые в раздел мыслей перед днём и в раздел мыслей в конце дня" = allow recording voice notes into the morning-thoughts and evening-thoughts sections of a day. Users must be able to record, listen back, and delete voice notes per section per day, from inside the Mini App. Recording through the bot chat (sending a voice message to the bot) is a welcome addition but not a replacement for in-app recording unless in-app recording is impossible on a major platform.`

const RESEARCH = {
  type: 'object',
  properties: {
    facts: { type: 'array', items: { type: 'object', properties: { topic: { type: 'string' }, fact: { type: 'string' }, source: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['topic', 'fact', 'confidence'] } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['facts', 'openQuestions'],
}

const DESIGN = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    summary: { type: 'string' },
    recording: { type: 'string', description: 'how audio is captured in the Mini App and via the bot; mime types per platform; fallbacks' },
    storage: { type: 'string', description: 'where bytes live, size limits, cost, retention' },
    dataModel: { type: 'string', description: 'new tables/columns/types incl. SQL migration and shared TS types' },
    api: { type: 'string', description: 'endpoints with request/response shapes, auth, streaming/playback' },
    sync: { type: 'string', description: 'how metadata syncs with the existing outbox/LWW sync; offline behaviour incl. pending uploads' },
    ui: { type: 'string', description: 'exact UI in DayNotes: controls, states (idle/recording/uploading/error), playback, delete with undo, animations, haptics, i18n keys' },
    bot: { type: 'string', description: 'bot-side behaviour for voice messages sent to the chat' },
    risks: { type: 'array', items: { type: 'string' } },
    effort: { type: 'string', description: 'rough implementation size and files touched' },
  },
  required: ['name', 'summary', 'recording', 'storage', 'dataModel', 'api', 'sync', 'ui', 'bot', 'risks', 'effort'],
}

const SCORE = {
  type: 'object',
  properties: {
    scores: { type: 'array', items: { type: 'object', properties: { design: { type: 'string' }, reliabilityOnIOS: { type: 'number' }, offline: { type: 'number' }, cost: { type: 'number' }, complexity: { type: 'number' }, ux: { type: 'number' }, total: { type: 'number' }, notes: { type: 'string' } }, required: ['design', 'total', 'notes'] } },
    winner: { type: 'string' },
    graft: { type: 'array', items: { type: 'string' }, description: 'ideas from other designs worth merging into the winner' },
  },
  required: ['scores', 'winner', 'graft'],
}

phase('Research')
const RESEARCH_TOPICS = [
  'Telegram Mini App WebView: does navigator.mediaDevices.getUserMedia / MediaRecorder work inside Telegram on iOS (WKWebView) and Android (WebView/Chrome custom tabs) as of 2025-2026? Which Telegram versions? Known issues, permission prompts, whether Telegram Desktop/macOS differ. Which MediaRecorder mime types are supported by iOS Safari (audio/mp4) vs Android Chrome (audio/webm;codecs=opus). Any Telegram-specific API for microphone (web_app_request_... events) in recent Bot API versions.',
  'Telegram Bot API for storing and serving audio: sendVoice accepted formats (OGG/OPUS, MP3, M4A) and behaviour when given WEBM; sendAudio vs sendDocument; file_id stability; getFile 20 MB limit and file_path validity window; whether a Worker can stream https://api.telegram.org/file/bot<token>/<path> to a client; rate limits; whether a bot can send files to a user who has not started the bot; voice message max duration; message:voice update fields (file_id, duration, mime_type, file_size).',
  'Cloudflare free tier options for audio blobs: R2 free tier limits (storage, class A/B ops), binding from Workers, streaming uploads/downloads with Range requests for <audio> playback in iOS Safari (Range support is required by Safari), D1 blob column limits (row size), Workers request body size limits (100 MB) and CPU time for proxying, KV caching. Also browser side: storing audio Blob in IndexedDB via Dexie for offline playback and pending uploads, and autoplay/playback restrictions in iOS WebView (user gesture requirement, playsinline).',
]
const research = await parallel(RESEARCH_TOPICS.map((topic, i) => () =>
  agent(`${CONTEXT}\n\nResearch task ${i + 1}: ${topic}\n\nUse web search/fetch of official documentation (core.telegram.org/bots/api, core.telegram.org/bots/webapps, developers.cloudflare.com, MDN, WebKit release notes) and reputable developer reports. Return concrete facts with sources and confidence. Flag anything you could not confirm as an open question.`, {
    label: `research:${i + 1}`,
    phase: 'Research',
    schema: RESEARCH,
  }),
))
const facts = research.filter(Boolean).flatMap((r) => r.facts.map((f) => `- [${f.confidence}] ${f.topic}: ${f.fact}${f.source ? ` (${f.source})` : ''}`)).join('\n')
const questions = research.filter(Boolean).flatMap((r) => r.openQuestions).map((q) => `- ${q}`).join('\n')
log(`research done: ${research.filter(Boolean).flatMap((r) => r.facts).length} facts`)

phase('Design')
const ANGLES = [
  { key: 'telegram-storage', hint: 'Angle: keep the free tier and zero new infrastructure. Capture in-app with MediaRecorder, upload to the Worker, forward to the user\'s own bot chat with sendVoice/sendAudio/sendDocument and keep only file_id + metadata in D1; play back through a Worker proxy that calls getFile and streams bytes (handle Range). Bot voice messages become notes too.' },
  { key: 'r2-storage', hint: 'Angle: durability and clean playback. Capture in-app with MediaRecorder, upload to Cloudflare R2 through the Worker (or presigned), metadata in D1, playback via Worker route with Range support; bot voice messages are copied from Telegram into R2. Justify the cost and the extra binding.' },
  { key: 'local-first', hint: 'Angle: offline-first and privacy. Audio stays primarily in the device (Dexie Blob) and is uploaded opportunistically (to Telegram chat or R2, your call) as a backup/sync channel; playback prefers the local blob; handle multi-device gracefully; design the pending-upload queue and conflict rules carefully.' },
]
const designs = await parallel(ANGLES.map((a) => () =>
  agent(`${CONTEXT}\n\nResearch facts gathered so far:\n${facts}\n\nOpen questions:\n${questions}\n\n${a.hint}\n\nRead the existing code (DayNotes.tsx, store/index.ts, lib/sync.ts, lib/db.ts, server/src/index.ts, server/src/sync.ts, server/src/bot.ts, db/schema.ts, shared/src/types.ts, styles/global.css) so the design fits the codebase conventions exactly. Produce a complete, implementable design. Be specific: SQL, TypeScript types, endpoint shapes, UI states, i18n keys, error handling, iOS quirks. Name the design "${a.key}".`, {
    label: `design:${a.key}`,
    phase: 'Design',
    schema: DESIGN,
  }),
))
const validDesigns = designs.filter(Boolean)
log(`${validDesigns.length} designs produced`)
if (!validDesigns.length) throw new Error('no designs produced (agents failed) - resume later')

phase('Judge')
const designsText = validDesigns.map((d) => `=== ${d.name} ===\n${d.summary}\nRecording: ${d.recording}\nStorage: ${d.storage}\nData model: ${d.dataModel}\nAPI: ${d.api}\nSync: ${d.sync}\nUI: ${d.ui}\nBot: ${d.bot}\nRisks: ${d.risks.join('; ')}\nEffort: ${d.effort}`).join('\n\n')
const JUDGES = [
  'You are a mobile platform engineer who has shipped audio features inside Telegram Mini Apps on iOS. Weight reliability on iOS WKWebView and Android WebView above everything; a design that silently fails on iOS scores near zero.',
  'You are the owner: a demanding single user who will later invite a small team. Weight premium UX, offline robustness and zero monthly cost; penalize complexity that delays shipping this week.',
  'You are a backend reviewer for Cloudflare Workers. Weight correctness of streaming/Range playback, free-tier limits, data integrity, security (auth on playback URLs, no token leakage), and how cleanly it plugs into the existing sync/LWW model.',
]
const verdicts = await parallel(JUDGES.map((j, i) => () =>
  agent(`${CONTEXT}\n\nResearch facts:\n${facts}\n\nDesigns to judge:\n${designsText}\n\n${j}\nScore each design 0-10 on reliabilityOnIOS, offline, cost, complexity (10 = simplest), ux, and give a weighted total per your priorities. Pick a winner and list concrete ideas from the other designs worth grafting into it.`, {
    label: `judge:${i + 1}`,
    phase: 'Judge',
    schema: SCORE,
  }),
))
const tally = {}
for (const v of verdicts.filter(Boolean)) for (const s of v.scores) tally[s.design] = (tally[s.design] || 0) + (s.total || 0)
const ranking = Object.entries(tally).sort((a, b) => b[1] - a[1])
log(`ranking: ${ranking.map(([k, v]) => `${k}=${v.toFixed(1)}`).join(', ')}`)

phase('Synthesize')
const winnerName = ranking.length ? ranking[0][0] : (validDesigns[0] && validDesigns[0].name)
const winner = validDesigns.find((d) => d.name === winnerName) || validDesigns[0]
const grafts = verdicts.filter(Boolean).flatMap((v) => v.graft).map((g) => `- ${g}`).join('\n')
const judgeNotes = verdicts.filter(Boolean).map((v, i) => `Judge ${i + 1}: winner ${v.winner}; ` + v.scores.map((s) => `${s.design}=${s.total} (${s.notes})`).join(' | ')).join('\n')
const contract = await agent(`${CONTEXT}\n\nResearch facts:\n${facts}\n\nWinning design (${winner.name}):\n${JSON.stringify(winner, null, 2)}\n\nJudge notes:\n${judgeNotes}\n\nIdeas to graft from other designs:\n${grafts}\n\nAll designs for reference:\n${designsText}\n\nWrite the final IMPLEMENTATION CONTRACT as Markdown that two engineers (one on server+shared, one on web) can implement independently and have it integrate on first try. It must contain, in this order: (1) decision summary and why; (2) exact SQL migration file content for server/migrations/0001_voice.sql; (3) exact TypeScript additions to shared/src/types.ts (interfaces, sync payload changes); (4) server endpoints: method, path, auth, request body/multipart fields, response JSON, status codes, error cases, Range/streaming rules, how file_id/keys are stored, size/duration limits; (5) bot behaviour for incoming voice messages incl. exact inline-button flow and i18n strings RU/EN; (6) web: Dexie schema version bump with new tables, store actions and their signatures, upload queue algorithm with retry/backoff and offline semantics, playback source selection (local blob vs remote URL), MediaRecorder mime negotiation per platform, permission error handling, exact UI states and i18n keys (RU and EN values) for DayNotes; (7) sync protocol changes (which entity syncs via /api/sync, which does not); (8) test plan: manual steps on iOS Telegram, Android Telegram, desktop browser dev mode; (9) known limitations. Prefer the smallest design that is reliable on iOS. Be concrete; no hand-waving.`, {
  label: 'synthesize:contract',
  phase: 'Synthesize',
})
return { ranking, winner: winner.name, contract, facts, questions }