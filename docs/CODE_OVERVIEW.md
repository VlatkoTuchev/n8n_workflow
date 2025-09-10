# Code Overview – Full System 

## 1) Realtime “Intelligence Injection” (where the brain enters)

1.1 Purpose
- Token minting (server): [../server.js#L276](../server.js#L276)
  - Builds `instructions` from: language policy and onboarding gate; Working Memory Pack (top‑K memory + rolling digest); recent summaries/snippets; optional recency/reload cues; user display name; preferred voice/name/style.
  - Calls OpenAI Realtime sessions API with { model, modalities: [`audio`,`text`], voice, instructions } and returns ephemeral `{ token, hasHistory, preferredVoice }` to the browser.
- Why server‑side: keeps API keys off the client and safely injects per‑user context.

1.2 Realtime token (definition)
- Short‑lived credential (`client_secret.value`) used by the client to authenticate the SDP exchange with OpenAI Realtime. Minted by the server for every new session.

1.3 How `instructions` are composed (inputs)
- Inputs fetched
  - Profile and mirrors: `composeUserContextSummary(email, pgUserId)` builds a short, human‑readable context digest (favorites, attended, categories, upcoming, recent webinar Qs) from Postgres mirror tables.
  - Language: `readPreferredLanguagePg({ userId })` → `preferredLanguage` guardrail.
  - Agent personalization: `readAgentSettingsPg({ userId })` → `preferredVoice`, `agentName`, `agentStyle`.
  - Working memory: `selectTopKUserMemory(userId)` → grouped top‑K items (facts, preferences, goals, progress, open questions) assembled into `workingPack`.
  - Recent session memory: `getRecentSummaries(userId, n)` → deduplicated/recency‑filtered short `recentSummariesBlock`.
  - Conversation excerpts: query on `chat_message` builds `recentConvosBlock` and a strict `anchorText` for continuation; computes `lastConversationUpdatedAt`.

1.4 Instruction sections (variables in server code)
  - Identity & tone: baseline persona text (friendly, concise, voice‑first) + `agentName`/`agentStyle` overrides if present.
  - Continuity policy: `continuityBlock` changes depending on `hasHistory` (first contact vs continuation). Adds a “Continuation anchor” with `anchorText` only for follow‑up turns.
  - Language policy: switches between “confirm or offer switch” vs “ask for language” based on `preferredLanguage`.
  - Onboarding gate: hard ordering of onboarding questions (language → 5 short items) and the rule to persist answers via `add_user_memory`.
  - Tooling etiquette: call tools silently; keep spoken output short; summarize results; don’t read raw JSON.
  - Data sourcing rules: when to call `list_courses`, `recommend_courses`, `get_event_details`, and how to speak localized fields (e.g., `start_date_local`, `start_time_local`, `starts_in_human`).
  - Safety/guardrails: avoid off‑scope claims (no camera/surveillance), ask one question at a time, be transparent on uncertainty.
  - Recency/reload heuristics: lines derived from `sinceLastMs`, `refreshCount`, and `post_settings_reload` flags to tune the first turn; injects voice/style change notice when applicable.
  - Context blocks: appends `contextSummary` (from mirrors), `recentSummariesBlock`, `workingPack`, and `recentConvosBlock` when available.

1.5 Assembly & output
  - The parts above are concatenated into `instructionsFull`, optionally trimmed to `instructions` (current implementation keeps it full).
  - OpenAI Session request payload includes `model`, `modalities`, `voice` (from `preferredVoice` defaulting to alloy), and `instructions`.
  - Response fields used downstream: `token` (ephemeral), `hasHistory` (boolean), `preferredVoice` (echoed for the client to align voice).

1.6 Client contract (`/realtime/token` response)
  - `token`: passed back via `openAiSessionToken`; forwarded later as `X-OpenAI-Session-Token` to `/realtime/sdp` so the offer/answer is authenticated with per‑user `instructions`.
  - `hasHistory`: toggles the client’s first‑turn pacing (defers VAD until the greeting completes, etc.).
  - `preferredVoice`: optional client‑side voice alignment after DataChannel opens.

1.7 Failure/edge behavior
  - If mirrors are empty, `contextSummary` becomes empty and the onboarding gate dominates the first turn.
  - If no `preferredLanguage`, instructions force a one‑line language choice question; the model must call `set_preferred_language` before continuing in a new language.
  - If recent summaries contain off‑topic drift, they’re filtered before inclusion; if `sinceLastMs` is very recent, recency guidance nudges a shorter greeting.

1.8 Extending `instructions` safely (checklist)
  - Add inputs: prefer server‑side readers (e.g., expand `composeUserContextSummary` or create new `read…Pg` helpers) and keep them summarized, not raw data.
  - Add policies: introduce a new named block and reference explicit variables (avoid implicit behavior). Keep turn limits and tool etiquette consistent.
  - Add tools: document when to call and how to speak their outputs (fields and constraints). Update both `instructions` guidance and the server tools.
  - Keep first‑turn rules strict: language choice first; onboarding before general chat unless answers exist.

---

## 2) Transport Handshake (SDP offer/answer)

2.1 Purpose
- Establish a WebRTC connection between the browser and OpenAI Realtime while keeping secrets server‑side and negotiation same‑origin.

2.2 Actors & endpoints
- Client (browser): builds the local session description and sends the offer to your server.
- Server: `/realtime/sdp` proxy → forwards offer to OpenAI Realtime and relays back the answer.
- OpenAI Realtime: returns an SDP answer that finalizes codecs, ICE candidates, DTLS keys.

2.3 Sequence (happy path)
1) Client prepares the peer connection: `RTCPeerConnection` with STUN, audio transceiver, DataChannel `oai-events`.
2) Client creates the offer: `createOffer()` → `setLocalDescription(offer)`; waits until `iceGatheringState === 'complete'` so ICE candidates are included.
3) Client calls your proxy: POST `ALL /realtime/sdp` with headers `Content-Type: application/sdp`, `Accept: application/sdp`, `X-OpenAI-Session-Token: <ephemeral>`, and body = raw SDP offer.
4) Server proxies to OpenAI Realtime: URL `https://api.openai.com/v1/realtime?model=<MODEL>`; headers `Authorization: Bearer <ephemeral or API key>`, `Content-Type: application/sdp`, `Accept: application/sdp`, `OpenAI-Beta: realtime=v1`; returns upstream SDP answer and echoes `X-Session-Token-Used`.
5) Client completes the handshake: `setRemoteDescription(answer)`; `ontrack` streams assistant audio; `DataChannel.onopen` resolves the command channel.

2.4 Security & rationale
- Ephemeral token from `/realtime/token` authenticates the SDP exchange with per‑user `instructions`; fallback to API key loses per‑user context.
- Same‑origin proxy keeps the API key off the client and avoids browser CORS/header pitfalls.

2.5 Failure modes & handling
- Missing/expired token → `X-Session-Token-Used: false`; connection may still establish without user context.
- Invalid SDP (not starting with `v=0`) → likely upstream error; client aborts and logs.
- ICE/timeouts → wait for ICE complete before posting; retry with the same offer if needed.

2.6 Client call site (navigation)
- Orchestrator: `startOpenAIRealtime()` → offer creation, ICE wait, POST `/realtime/sdp`, then `setRemoteDescription`.
- See: [../compenion_ai.html#L627](../compenion_ai.html#L627) (entry) and [../server.js#L221](../server.js#L221) (proxy).

2.7 Term definitions
- WebRTC: browser‑native real‑time media/data stack that creates encrypted peer connections (audio/video/data).
- SDP (Session Description Protocol): plain‑text description of codecs, directions, ICE candidates, DTLS keys; browser sends Offer; OpenAI returns Answer.
- ICE (Interactive Connectivity Establishment): discovers viable network paths; includes STUN (public IP discovery) and optional TURN (relay).
- DTLS/SRTP: transport/security layers; DTLS protects SRTP media.
- DataChannel: bidirectional, low‑latency channel over WebRTC for tool messages (`oai-events`).
- Ephemeral token: short‑lived credential from `/realtime/token` (`client_secret.value`) that binds the session to server‑built `instructions`.

---

## 3) Client (compenion_ai.html) – Orchestrator, tools, and panels

3.1 Orchestrator (runtime hub)
- Entrypoint `startOpenAIRealtime()` [../compenion_ai.html#L627](../compenion_ai.html#L627): creates `RTCPeerConnection`, opens DataChannel `oai-events`, routes remote audio to `<audio id="remoteAudio">`, captures microphone (AEC/NS), fetches ephemeral token, performs SDP offer/answer via the proxy, registers tools, and installs message handling.
- Caches user id with `getUserId()` [../compenion_ai.html#L1056](../compenion_ai.html#L1056) so client panels can be namespaced per user (e.g., code‑assist storage).

3.2 Remote audio & envelope bubble (UX)
- Mood color setter `setMood(mood)` and an envelope‑driven `animateBubble()` [../compenion_ai.html#L661](../compenion_ai.html#L661), [../compenion_ai.html#L670](../compenion_ai.html#L670).
- `setupEnvelopeProcessing(stream)` [../compenion_ai.html#L681](../compenion_ai.html#L681) uses AudioWorklet when available; falls back to an analyser RMS loop otherwise.

3.3 Microphone capture & mute
- `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation, noiseSuppression } })` adds tracks to the peer connection.
- Mute wiring disables both local track `enabled` and any `RTCRtpSender.track.enabled`; see toggle logic [../compenion_ai.html#L2270](../compenion_ai.html#L2270).

3.4 Token mint + SDP handshake (ties to section 2)
- Mint: client calls `/realtime/token` → receives `{ token, hasHistory, preferredVoice }`.
- Handshake: creates offer, waits until ICE complete, POSTs `/realtime/sdp` with header `X-OpenAI-Session-Token: token`, then `setRemoteDescription(answer)` [../compenion_ai.html#L627](../compenion_ai.html#L627).

3.5 Tools contract & handler
- Registry: name + JSON schema for each tool [../compenion_ai.html#L861](../compenion_ai.html#L861).
- Handler: deduplicates by `call_id` (using `processedToolCallIds`), accumulates streamed arguments in `pendingArgs`, executes UI/server logic, emits `function_call_output` back over the DataChannel, and triggers a brief spoken follow‑up when appropriate.

3.6 Panels (tool‑driven surfaces)
- Quiz modal: ensure UI, render question, open for event, submit and score [../compenion_ai.html#L1122](../compenion_ai.html#L1122), [../compenion_ai.html#L1134](../compenion_ai.html#L1134), [../compenion_ai.html#L1188](../compenion_ai.html#L1188).
- Summary overlay: ensure, set title/body HTML, open [../compenion_ai.html#L1208](../compenion_ai.html#L1208), [../compenion_ai.html#L1225](../compenion_ai.html#L1225), [../compenion_ai.html#L1231](../compenion_ai.html#L1231).
- Code‑assist panel: launcher + renderer; block composition (language, title, code, explanation, next actions) [../compenion_ai.html#L1366](../compenion_ai.html#L1366), [../compenion_ai.html#L1385](../compenion_ai.html#L1385).

3.7 Events list & actions
- Lists courses from server and renders cards with Enter/Quiz/Summary actions [../compenion_ai.html#L1249](../compenion_ai.html#L1249).

3.8 Pacing & lifecycle (keep voice first sane)
- Response pacing: `requestResponseSafe`, `waitForSessionUpdated`, `beginNoToolFollowup` [../compenion_ai.html#L1328](../compenion_ai.html#L1328), [../compenion_ai.html#L1342](../compenion_ai.html#L1342), [../compenion_ai.html#L1351](../compenion_ai.html#L1351).
- Idle finalize + pagehide/visibility finalize [../compenion_ai.html#L1309](../compenion_ai.html#L1309), [../compenion_ai.html#L2340](../compenion_ai.html#L2340).
- Mute toggle (tracks and senders) [../compenion_ai.html#L2270](../compenion_ai.html#L2270).

3.9 3D Avatar (tool‑controlled, independent)
- Scene/camera/lights; GLB loading; cross‑fades; simple autonomy; drag; small public API `window.AvatarController` [../compenion_ai.html#L345](../compenion_ai.html#L345), [../compenion_ai.html#L411](../compenion_ai.html#L411), [../compenion_ai.html#L476](../compenion_ai.html#L476), [../compenion_ai.html#L498](../compenion_ai.html#L498), [../compenion_ai.html#L594](../compenion_ai.html#L594).
- Internals to know by name: `AnimationMixer`, `nameToAction`, `crossFadeTo`, `pendingMode`, `updateAutonomy`, `bounds`.

3.10 Client‑side resilience
- Graceful fallbacks: AudioWorklet → analyser RMS; token/SDP answer validation; retry‑safe ICE wait before posting offer; UI remains responsive even if remote audio or quiz/summary fetches fail.

3.11 Extending the client safely
- New tool: add JSON schema in the registry → handle in the message loop → render/update a small panel; keep spoken lines short.
- New panel: keep it visually isolated (like quiz/summary/code‑assist) and return concise JSON from the server tool.
- New data: fetch via server only; avoid direct DB calls from the client; keep the client stateless and contract‑driven.

---

## 4) Server (server.js) – APIs, tools, summarization

4.1 Setup & static routing
- Static routes (dev‑friendly, exposes workspace) and HTTP listen: [../server.js#L1952](../server.js#L1952), [../server.js#L2240](../server.js#L2240).
- Note: In production narrow static mounts; keep GLB/worklets explicit.

4.2 Auth & identity bridging
- Register/Login/Logout over MySQL `users` with bcrypt hashing: [../server.js#L778](../server.js#L778), [../server.js#L829](../server.js#L829), [../server.js#L873](../server.js#L873).
- Issues JWT cookie `{ email, pgUserId }`; `ensureMysqlUserForEmail(email)` keeps a MySQL row present for CDC mirrors; `createUser({ email })` (Postgres) bridges identities.

4.3 User information APIs
- `/me` returns the JWT payload: [../server.js#L911](../server.js#L911).
- `/user/profile` reads MySQL basic profile (plus optional extras): [../server.js#L916](../server.js#L916).
- `/user/context` pulls a rich context from Postgres mirrors (upcoming/attended, materials, transcripts, quizzes, favorites, categories): [../server.js#L942](../server.js#L942).

4.4 Realtime endpoints (tie to sections 1 & 2)
- `/realtime/token` builds `instructions` and mints an ephemeral token: [../server.js#L276](../server.js#L276).
  - Inputs by name: `composeUserContextSummary`, `readPreferredLanguagePg`, `readAgentSettingsPg`, `selectTopKUserMemory`, `getRecentSummaries`, conversation excerpts from `chat_message`.
  - Variables assembled: `preferredLanguage`, `preferredVoice`, `agentName`, `agentStyle`, `workingPack`, `recentSummariesBlock`, `recentConvosBlock`, `continuityBlock`, `instructionsFull`.
- `/realtime/sdp` proxies the SDP offer to OpenAI Realtime and returns the SDP answer (same‑origin handshake): [../server.js#L221](../server.js#L221).

4.5 Tools hub (contract‑first switchboard)
- Entry: `POST /tools/execute` [../server.js#L1108](../server.js#L1108).
- Call shape: `{ name, arguments }`; server logs the tool name and guards with `authRequired`.
- Categories and notable behaviors:
  - Chat/session: `create_chat_session`, `add_chat_turn`, `get_recent_chat`, `fetch_chat_history` (writes both Redis and Postgres aggregated JSON rows).
  - Preferences/agent: `read_preferred_language`, `set_preferred_language`, `read_agent_name`, `set_agent_name`, `read_agent_settings`, `set_agent_settings` (self‑only; voice/style changes ask for reload).
  - Memory: `add_user_memory` (single or batch) and `get_user_memory` (filter by type/limit). Uses `ensureMemoryTables`, `upsertUserMemoryItems`.
  - Courses/catalog: `list_courses` dynamically detects mirror columns, merges with MySQL if needed, computes `start_local`, `start_date_local`, `start_time_local`, `start_weekday_local`, and `starts_in_human` via `computeRelative`; sorts by status.
  - Recommendations: `recommend_courses` applies a days‑ahead window and returns localized fields + relative starts.
  - Details/content: `get_event_details` normalizes timestamps across schemas; `get_event_summary` serves stored HTML or a graceful generated blurb.
  - Participation/favorites: `enter_event` and `user_favourite` are idempotent MySQL writes; CDC mirrors back to Postgres for reads.
  - Quizzes: `get_event_quiz` reads mirror tables; `submit_event_quiz` writes attempt headers and responses, returns `score`/`passed`.

4.6 Summarization pipeline (session finalization)
- Function: `summarizeAndSaveSession(sessionId, userId)` [../server.js#L1994](../server.js#L1994).
- Steps by name:
  1) Transcript assembly: prefer `chat_message` aggregated JSON → Redis buffer → fallback row logs.
  2) Model summary: prompts using `OPENAI_SUMMARY_MODEL`; saves via `saveSessionSummary`.
  3) Atomic memory extraction: parses model JSON; filters by content‑word overlap; `upsertUserMemoryItems` for durable items.
  4) Rolling digest: `getRecentSummaries` → `setUserDigest`.

4.7 Sessions endpoints
- `/sessions/heartbeat` updates Redis `chat:last_activity:<sessionId>` and associates `chat:session_user:<sessionId>` [../server.js#L2124](../server.js#L2124).
- `/sessions/finalize` runs summarization now or queues a background finalize [../server.js#L2147](../server.js#L2147).

4.8 Idle summarizer loop
- Periodically scans Redis idle keys; runs summarization with backoff on repeated failures: [../server.js#L2183](../server.js#L2183).

4.9 Security & permissions
- `authRequired` on `/realtime/*`, `/tools/execute`, `/sessions/*`.
- Admin route `/tools/admin/delete_memories` requires `X-Admin-Token` [../server.js#L1923](../server.js#L1923).
- Agent settings endpoints enforce self‑only updates/reads.

4.10 Operational knobs (env)
- OpenAI: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_SUMMARY_MODEL`.
- Timezone & dates: `APP_TIMEZONE`.
- Redis chat buffers: `CHAT_BUFFER_MAX`, `CHAT_BUFFER_TTL_SECONDS`.
- Idle summarizer: `ENABLE_IDLE_SUMMARIZER`, `SESSION_IDLE_MS`, `IDLE_SUMMARIZER_INTERVAL_MS`.

---

## 5) Persistence Layer – Postgres & Redis

5.1 Postgres helpers (retrieval.js)
- Sessions/messages
  - `createChatSession` [../retrieval.js#L13](../retrieval.js#L13): inserts a new session header (returns id) to associate future turns.
  - `addChatMessage` [../retrieval.js#L29](../retrieval.js#L29): appends to a single aggregated JSON array per (session_id,user_id); stores UTC (`at`) and pre‑formatted local time (`at_local`) plus turn info.
  - `getRecentMessages` [../retrieval.js#L90](../retrieval.js#L90): convenience read for debugging/inspection.
- Summaries & preferences
  - `saveSessionSummary` [../retrieval.js#L110](../retrieval.js#L110): UPSERTs the latest summary per (session_id,user_id).
  - `readLatestSummary` [../retrieval.js#L115](../retrieval.js#L115): reads last saved summary for a user.
  - `readPreferredLanguagePg` [../retrieval.js#L136](../retrieval.js#L136) / `setPreferredLanguagePg` [../retrieval.js#L144](../retrieval.js#L144): stores per‑user language preference.
- Identity & agent personalization
  - `createUser` [../retrieval.js#L161](../retrieval.js#L161): creates/ensures the Postgres identity.
  - `readAgentNamePg` [../retrieval.js#L287](../retrieval.js#L287) / `setAgentNamePg` [../retrieval.js#L295](../retrieval.js#L295): preferred assistant name.
  - `readAgentSettingsPg` [../retrieval.js#L307](../retrieval.js#L307) / `setAgentSettingsPg` [../retrieval.js#L320](../retrieval.js#L320): voice/style/name with partial update semantics.
- Memory & digest
  - `ensureMemoryTables` [../retrieval.js#L188](../retrieval.js#L188): guarantees `user_memory`, `user_digest`, and `user_agent_settings` exist (with indexes/constraints).
  - `upsertUserMemoryItems` [../retrieval.js#L211](../retrieval.js#L211): inserts or refreshes atomic items; merges pinning/stability.
  - `selectTopKUserMemory` [../retrieval.js#L233](../retrieval.js#L233): picks top‑K items per type (facts/preferences/goals/progress/open questions) using pin/stability/recency order.
  - `setUserDigest` [../retrieval.js#L260](../retrieval.js#L260) / `getUserDigest` [../retrieval.js#L271](../retrieval.js#L271): manages a concise rolling digest per user.
  - `getRecentSummaries` [../retrieval.js#L276](../retrieval.js#L276): pulls recent summaries (used by the summarizer to build the digest).

Design notes (Postgres)
- Conversation storage favors a single JSON blob per session/user for fast summarization and continuity reads; Redis covers hot tails.
- Memory tables prioritize durability and de‑duplication (unique `(user_id, statement)`), with ranking fields that tune retrieval without complex vector infra.

5.2 Redis helpers (redis.js)
- Chat buffers
  - `addChatTurn` [../redis.js#L31](../redis.js#L31): pushes `{ role, content, ts }` to `chat:<sessionId>` with TTL and trim to `CHAT_BUFFER_MAX`.
  - `getRecentChat` / `getFullChat`: read back recent/full tails to reconstruct transcripts if Postgres aggregation is missing.
- Session activity
  - `setSessionActivity` [../redis.js#L63](../redis.js#L63): refreshes `chat:last_activity:<sessionId>` and maps the session to a user (`chat:session_user:<sessionId>`) for the idle summarizer.
  - `getSessionActivity`: reads last activity timestamp.

Design notes (Redis)
- Redis acts as a fast, lossy buffer and heartbeat store; Postgres remains the durable source of session truth.
- Idle summarizer only deletes the idle marker after a successful save (with backoff keys for repeated failures).

5.3 Schemas (where to look)
- Postgres app tables + mirror indexes: [../db/init.sql#L1](../db/init.sql#L1)
- MySQL app schema (source of truth): [../db/mysql-init.sql#L1](../db/mysql-init.sql#L1)

---

## 6) Security, Ops, Extensibility

6.1 Security model
- Authentication & session: JWT cookie `auth`; middleware `authRequired` protects `/realtime/*`, `/tools/execute`, `/sessions/*` [../server.js#L206](../server.js#L206).
- Authorization: agent settings endpoints (`read_agent_settings`, `set_agent_settings`) are self‑only; server validates `userId` matches cookie.
- Secrets: client never sees `OPENAI_API_KEY`. Realtime uses an ephemeral token from `/realtime/token`; SDP proxy runs on the server.
- Admin: `/tools/admin/delete_memories` requires `X-Admin-Token` [../server.js#L1923](../server.js#L1923).
- Scope & safety: instructions include explicit guardrails (no camera/surveillance claims, short turns, single question at a time).

6.2 Operations & tunables
- Idle summarizer: `ENABLE_IDLE_SUMMARIZER`, `SESSION_IDLE_MS`, `IDLE_SUMMARIZER_INTERVAL_MS` control whether/when sessions finalize in the background [../server.js#L2176](../server.js#L2176).
- Timezone & formatting: `APP_TIMEZONE` drives server‑side localization of dates/times and relative fields.
- Redis chat buffers: `CHAT_BUFFER_MAX`, `CHAT_BUFFER_TTL_SECONDS` (see redis.js; defaults provide 24h retention with trimming).
- OpenAI models: `OPENAI_REALTIME_MODEL` (realtime) and `OPENAI_SUMMARY_MODEL` (summaries/memory extraction).

6.3 Extensibility patterns
- New tool (most common):
  1) Define its JSON schema in the client tools registry (name, description, parameters).
  2) Implement its case inside `POST /tools/execute` (server) with clear outputs tailored for speech + UI.
  3) Update instructions (when necessary) with when/how to call the tool.
- New UI panel:
  - Mirror “summary/quiz/code‑assist”: self‑contained surface; spoken output stays concise; the panel carries details.
- New data field or table:
  - Add Postgres readers/writers in `retrieval.js`; extend `/user/context` or the tool case in `server.js`; keep the client stateless and contract‑driven.
- New avatar behavior:
  - Extend `window.AvatarController` and add an animation clip/action; keep the mixer/crossfade pattern.

6.4 Deployment notes (quick)
- Narrow static mounts in production; avoid serving the repo root broadly.
- Ensure TLS so DTLS/SRTP can negotiate cleanly in WebRTC (most browsers require https).
- Monitor `/realtime/*` and `/tools/execute` latency; idle summarizer logs can surface summarization failures/backoffs.
